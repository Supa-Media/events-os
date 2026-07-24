/**
 * The receipt CRM surface — the query/mutation API the receipts UI consumes,
 * plus mass upload (the owner's backfill workflow) and duplicate detection.
 *
 * Builds entirely on the receipts foundation that already merged:
 *  - `receipts` documents + `receiptLinks` many-to-many links, written ONLY
 *    through `lib/receiptLinks.ts` (`createReceipt` / `linkReceiptToTransaction`
 *    / `unlinkReceiptFromTransaction`), which keeps `receipts.linkCount` and
 *    `transactions.receiptStorageId` (the legacy denorm cache) consistent.
 *  - the inbound-email OCR→match pipeline in `receiptInbox.ts`, whose matcher
 *    (`matchReceiptCandidates`) and image-OCR call (`ocrReceiptImage`) this
 *    module REUSES rather than re-implements (see their export comments there).
 *
 * TENANCY: every function here is CHAPTER-ONLY (a real `chapters` id) — a
 * `central`-owned receipt/transaction is out of scope for this PR (unlike
 * `finances.ts#requireReconcileTxn`, which is central-aware). Central receipt
 * review is a small, deliberate follow-up once the central desk needs it; a
 * chapter caller's `receipts.chapterId`/`transactions.chapterId` must equal
 * their own resolved chapter id for every read/write below.
 *
 * MONEY SAFETY: the only transaction-status change anything here makes is the
 * SAME behavior-preserving `categorized → reconciled` flip `linkReceiptToTransaction`
 * always makes on a receipt's first landing — a human confirms every link (a
 * manual `linkReceipt` call) or the upload pipeline auto-attaches only a
 * UNIQUE, non-duplicate candidate (mirroring the email pipeline's own bar).
 */
import {
  query,
  mutation,
  internalQuery,
  internalMutation,
  internalAction,
} from "./_generated/server";
import type { ActionCtx, QueryCtx } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import {
  RECEIPT_SOURCES,
  RECEIPT_SENDER_CLASSES,
  INBOUND_RECEIPT_STATUSES,
  CENTRAL,
} from "@events-os/shared";
import { getChapterIdOrNull, requireChapterId } from "./lib/context";
import { requireFinanceRole } from "./lib/finance";
import {
  createReceipt,
  linkReceiptToTransaction,
  unlinkReceiptFromTransaction,
  findDuplicateReceiptBySha256,
} from "./lib/receiptLinks";
import {
  matchReceiptCandidates,
  candidateValidator,
  extractReceiptFields,
  resolveOcrModel,
  deriveMerchantFromEmail,
  type OcrRoutingResult,
} from "./receiptInbox";

// ── Validators ───────────────────────────────────────────────────────────────
const receiptSourceValidator = v.union(
  ...RECEIPT_SOURCES.map((s) => v.literal(s)),
);
const receiptSenderClassValidator = v.union(
  ...RECEIPT_SENDER_CLASSES.map((c) => v.literal(c)),
);
const inboundStatusValidator = v.union(
  ...INBOUND_RECEIPT_STATUSES.map((s) => v.literal(s)),
);

// ── Bounds ───────────────────────────────────────────────────────────────────
/** `listReceipts`' default/hard-cap bound (bookkeeper library view). */
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;
/** How many of a chapter's receipts we scan (newest-first) to compute the
 *  `softDuplicate` flag — bounded, not exhaustive (mirrors `ROLLUP_SCAN_LIMIT`'s
 *  "generous but bounded" discipline at a scale that fits a receipts table). */
const DUPLICATE_SCAN_LIMIT = 500;
/** `submitUploadedReceipts`' per-call cap — a mass-upload backfill batch, not
 *  an unbounded bulk import. */
const MAX_UPLOAD_BATCH = 25;
/** `findSoftDuplicateMatches`' cap — the "why is this flagged" list is a
 *  quick-scan callout, not an exhaustive report. */
const MAX_DUPLICATE_MATCHES = 5;

// ── Small shared projections ─────────────────────────────────────────────────
/** A linked/candidate/duplicate-of transaction, resolved to display fields. */
const txnRef = v.object({
  id: v.id("transactions"),
  postedAt: v.number(),
  amountCents: v.number(),
  merchantName: v.union(v.string(), v.null()),
  description: v.union(v.string(), v.null()),
  status: v.string(),
});
function toTxnRef(tr: Doc<"transactions">) {
  return {
    id: tr._id,
    postedAt: tr.postedAt,
    amountCents: tr.amountCents,
    merchantName: tr.merchantName ?? null,
    description: tr.description ?? null,
    status: tr.status,
  };
}

/** A receipt row's shared display fields (the library list + inbound queue's
 *  per-email receipt list both want this exact shape). */
const receiptSummary = v.object({
  _id: v.id("receipts"),
  url: v.union(v.string(), v.null()),
  source: receiptSourceValidator,
  senderClass: v.union(receiptSenderClassValidator, v.null()),
  // The original attachment filename (or a synthetic "email body"/"text
  // message" label) — see `schema/finances.ts`'s doc comment on
  // `receipts.filename`.
  filename: v.union(v.string(), v.null()),
  amountCents: v.union(v.number(), v.null()),
  receiptDate: v.union(v.number(), v.null()),
  merchant: v.union(v.string(), v.null()),
  note: v.union(v.string(), v.null()),
  ocrAmountCents: v.union(v.number(), v.null()),
  ocrDate: v.union(v.number(), v.null()),
  ocrMerchant: v.union(v.string(), v.null()),
  ocrConfidence: v.union(v.number(), v.null()),
  // A human-readable reason extraction produced NOTHING — see
  // `schema/finances.ts`'s doc comment on `receipts.ocrError`.
  ocrError: v.union(v.string(), v.null()),
  linkCount: v.number(),
  duplicateOfReceiptId: v.union(v.id("receipts"), v.null()),
  createdAt: v.number(),
});
async function toReceiptSummary(ctx: QueryCtx, r: Doc<"receipts">) {
  return {
    _id: r._id,
    url: await ctx.storage.getUrl(r.storageId),
    source: r.source,
    senderClass: r.senderClass ?? null,
    filename: r.filename ?? null,
    amountCents: r.amountCents ?? null,
    receiptDate: r.receiptDate ?? null,
    merchant: r.merchant ?? null,
    note: r.note ?? null,
    ocrAmountCents: r.ocrAmountCents ?? null,
    ocrDate: r.ocrDate ?? null,
    ocrMerchant: r.ocrMerchant ?? null,
    ocrConfidence: r.ocrConfidence ?? null,
    ocrError: r.ocrError ?? null,
    linkCount: r.linkCount,
    duplicateOfReceiptId: r.duplicateOfReceiptId ?? null,
    createdAt: r.createdAt,
  };
}

/**
 * A bounded, newest-first scan of a chapter's receipts, keyed by
 * `amountCents:receiptDate` — every receipt whose key collides with another
 * receipt's in the scanned window is a SOFT duplicate (same reported total on
 * the same day; unlike `fileSha256`'s EXACT-bytes match, this catches two
 * different photos of what's probably the same purchase). Bounded to
 * `DUPLICATE_SCAN_LIMIT`, so a very old collision outside the window is missed
 * — acceptable for a soft, review-only signal (never a hard block).
 *
 * A receipt with `duplicateDismissed` set ("I checked, not a duplicate") is
 * EXCLUDED from the returned set — its own `softDuplicate` output goes false
 * — but STILL counts toward the collision group for everyone else: an
 * undismissed sibling sharing the same amount+date keeps flagging. Dismissal
 * is a per-receipt human assertion, not a group-wide mute.
 */
async function computeSoftDuplicates(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<Set<Id<"receipts">>> {
  const scan = await ctx.db
    .query("receipts")
    .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
    .order("desc")
    .take(DUPLICATE_SCAN_LIMIT);
  const byKey = new Map<string, Doc<"receipts">[]>();
  for (const r of scan) {
    if (r.amountCents == null || r.receiptDate == null) continue;
    const key = `${r.amountCents}:${r.receiptDate}`;
    const arr = byKey.get(key);
    if (arr) arr.push(r);
    else byKey.set(key, [r]);
  }
  const dupes = new Set<Id<"receipts">>();
  for (const rows of byKey.values()) {
    if (rows.length > 1) {
      for (const r of rows) if (!r.duplicateDismissed) dupes.add(r._id);
    }
  }
  return dupes;
}

/**
 * The OTHER receipt(s) in this chapter that share `receipt`'s canonical
 * amount+date — EXACTLY the `computeSoftDuplicates` collision criteria,
 * surfaced so a flagged receipt's "why" is answerable (and actionable — the
 * mobile detail view links straight to each one). Excludes itself and its
 * own EXACT-file group (any receipt sharing `fileSha256`, which already has
 * its own dedicated `duplicateOf`/"jump to original" callout — repeating it
 * here would be noise, not a second signal). Bounded to
 * `MAX_DUPLICATE_MATCHES`, newest first.
 */
async function findSoftDuplicateMatches(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
  receipt: Doc<"receipts">,
): Promise<Doc<"receipts">[]> {
  if (receipt.amountCents == null || receipt.receiptDate == null) return [];
  const scan = await ctx.db
    .query("receipts")
    .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
    .order("desc")
    .take(DUPLICATE_SCAN_LIMIT);
  return scan
    .filter(
      (r) =>
        r._id !== receipt._id &&
        r.amountCents === receipt.amountCents &&
        r.receiptDate === receipt.receiptDate &&
        !(receipt.fileSha256 && r.fileSha256 === receipt.fileSha256),
    )
    .slice(0, MAX_DUPLICATE_MATCHES);
}

/**
 * The OTHER receipt(s) in this chapter whose `duplicateOfReceiptId` points at
 * `receiptId` — i.e. `receiptId` is the kept PRIMARY of one or more hidden
 * duplicates (derived sha256 matches AND human-confirmed ones alike; see
 * `getReceipt`'s doc on `duplicates`). Bounded scan (same discipline as
 * `findSoftDuplicateMatches`), newest first, capped at `MAX_DUPLICATE_MATCHES`.
 */
async function findDuplicatesOfReceipt(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
  receiptId: Id<"receipts">,
): Promise<Doc<"receipts">[]> {
  const scan = await ctx.db
    .query("receipts")
    .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
    .order("desc")
    .take(DUPLICATE_SCAN_LIMIT);
  return scan.filter((r) => r.duplicateOfReceiptId === receiptId).slice(0, MAX_DUPLICATE_MATCHES);
}

// ── listReceipts (the library view) ──────────────────────────────────────────
/** `"duplicates"` is the ONLY filter that surfaces a receipt with
 *  `duplicateOfReceiptId` set — every other filter EXCLUDES them by default
 *  (see the handler doc: hiding is never deleting, and this filter is how a
 *  confirmed/exact duplicate stays reachable). */
const listFilterValidator = v.union(
  v.literal("all"),
  v.literal("unlinked"),
  v.literal("linked"),
  v.literal("duplicates"),
);

const listReceiptRow = v.object({
  ...receiptSummary.fields,
  softDuplicate: v.boolean(),
});

/**
 * The receipts library: a chapter's receipts newest-first, bounded (default
 * `DEFAULT_LIST_LIMIT`). `unlinked` reads `by_chapter_and_linkCount` (a receipt
 * nobody's attached yet — the bookkeeper's real worklist); `all`/`linked`/
 * `duplicates` read `by_chapter` and filter the SAME bounded page in memory —
 * a chapter with hundreds of already-linked (or duplicate) receipts may see
 * fewer than `limit` rows back (bounded-read tradeoff, not a full scan+filter
 * like `finances.listReconcile`'s admin grid).
 *
 * DUPLICATE HIDING (owner ask, 2026-07-24): a receipt with `duplicateOfReceiptId`
 * set — whether derived (exact-file sha256 match) or human-confirmed (see
 * `markAsDuplicate`) — is EXCLUDED from `"all"`/`"unlinked"`/`"linked"` by
 * default. This is HIDING, not deleting: the row, its file, and any
 * `receiptLinks` all still exist; pass `filter: "duplicates"` to see them.
 * There's no other way to "merge" a duplicate today (owner ask), so hiding it
 * from the everyday library view — while keeping it one filter-tap away — is
 * the whole fix.
 */
export const listReceipts = query({
  args: {
    filter: v.optional(listFilterValidator),
    limit: v.optional(v.number()),
  },
  returns: v.array(listReceiptRow),
  handler: async (ctx, args) => {
    const chapterId = (await getChapterIdOrNull(ctx)) as Id<"chapters"> | null;
    if (!chapterId) return [];
    await requireFinanceRole(ctx, chapterId, "bookkeeper");

    const filter = args.filter ?? "all";
    const limit = Math.min(Math.max(Math.trunc(args.limit ?? DEFAULT_LIST_LIMIT), 1), MAX_LIST_LIMIT);

    let rows: Doc<"receipts">[];
    if (filter === "unlinked") {
      const page = await ctx.db
        .query("receipts")
        .withIndex("by_chapter_and_linkCount", (q) =>
          q.eq("chapterId", chapterId).eq("linkCount", 0),
        )
        .order("desc")
        .take(limit);
      rows = page.filter((r) => r.duplicateOfReceiptId == null);
    } else if (filter === "duplicates") {
      const page = await ctx.db
        .query("receipts")
        .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
        .order("desc")
        .take(limit);
      rows = page.filter((r) => r.duplicateOfReceiptId != null);
    } else {
      const page = await ctx.db
        .query("receipts")
        .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
        .order("desc")
        .take(limit);
      const undupedPage = page.filter((r) => r.duplicateOfReceiptId == null);
      rows = filter === "linked" ? undupedPage.filter((r) => r.linkCount > 0) : undupedPage;
    }

    const dupSet = await computeSoftDuplicates(ctx, chapterId);
    const out = [];
    for (const r of rows) {
      out.push({
        ...(await toReceiptSummary(ctx, r)),
        softDuplicate: dupSet.has(r._id),
      });
    }
    return out;
  },
});

// ── getReceipt (full detail) ─────────────────────────────────────────────────
const duplicateOfSummary = v.object({
  _id: v.id("receipts"),
  url: v.union(v.string(), v.null()),
  amountCents: v.union(v.number(), v.null()),
  receiptDate: v.union(v.number(), v.null()),
  merchant: v.union(v.string(), v.null()),
  linkCount: v.number(),
});

/** A soft-duplicate MATCH — the other receipt(s) sharing this one's amount+
 *  date (see `findSoftDuplicateMatches`), the "why is this flagged" list the
 *  mobile detail view renders as tappable rows. */
const duplicateMatchSummary = v.object({
  _id: v.id("receipts"),
  url: v.union(v.string(), v.null()),
  amountCents: v.union(v.number(), v.null()),
  receiptDate: v.union(v.number(), v.null()),
  merchant: v.union(v.string(), v.null()),
  linkCount: v.number(),
});

const receiptDetail = v.object({
  ...receiptSummary.fields,
  ocrModel: v.union(v.string(), v.null()),
  correctedByPersonId: v.union(v.id("people"), v.null()),
  correctedAt: v.union(v.number(), v.null()),
  // Set only on a HUMAN-confirmed duplicate (`markAsDuplicate`) — `null` for
  // a derived exact-file (sha256) match. The mobile UI uses this to decide
  // whether `unmarkDuplicate` is even offered (see that mutation's doc).
  duplicateConfirmedByPersonId: v.union(v.id("people"), v.null()),
  duplicateConfirmedAt: v.union(v.number(), v.null()),
  softDuplicate: v.boolean(),
  linkedTransactions: v.array(txnRef),
  candidateTransactions: v.array(txnRef),
  duplicateOf: v.union(duplicateOfSummary, v.null()),
  // Populated only when `softDuplicate` is true — every OTHER receipt this
  // one collides with on amount+date (see `findSoftDuplicateMatches`), so
  // "possible duplicate" is actionable instead of a dead-end badge.
  duplicateMatches: v.array(duplicateMatchSummary),
  // The OTHER receipt(s), if any, whose `duplicateOfReceiptId` points at
  // THIS one — i.e. this receipt is the kept PRIMARY of one or more hidden
  // duplicates (see `findDuplicatesOfReceipt`). Only ever populated when
  // this receipt isn't itself somebody else's duplicate.
  duplicates: v.array(duplicateOfSummary),
  // True iff THIS receipt is itself a duplicate (`duplicateOfReceiptId` set —
  // derived OR human-confirmed) AND still carries `receiptLinks` to a
  // transaction (`linkCount > 0`). `markAsDuplicate` deliberately never
  // touches existing links (money records don't change silently — see its
  // doc), so a confirmed duplicate can end up still attached to a charge; the
  // mobile UI uses this to surface an explicit "still attached — unlink it?"
  // warning instead of leaving that money-adjacent loose end invisible.
  duplicateStillLinked: v.boolean(),
});

/**
 * Full receipt detail: the document itself, every transaction it's LINKED to
 * (via `by_receipt`), its match shortlist hydrated to txn summaries, and (when
 * flagged) the earlier receipt it duplicates. Bookkeeper+, chapter-only.
 */
export const getReceipt = query({
  args: { receiptId: v.id("receipts") },
  returns: v.union(receiptDetail, v.null()),
  handler: async (ctx, { receiptId }) => {
    const chapterId = (await getChapterIdOrNull(ctx)) as Id<"chapters"> | null;
    if (!chapterId) return null;
    await requireFinanceRole(ctx, chapterId, "bookkeeper");

    const r = await ctx.db.get(receiptId);
    if (!r || r.chapterId !== chapterId) return null;

    const links = await ctx.db
      .query("receiptLinks")
      .withIndex("by_receipt", (q) => q.eq("receiptId", receiptId))
      .take(200);
    const linkedTransactions = [];
    for (const l of links) {
      const txn = await ctx.db.get(l.transactionId);
      if (txn) linkedTransactions.push(toTxnRef(txn));
    }

    const candidateTransactions = [];
    for (const cid of r.candidateTransactionIds ?? []) {
      const txn = await ctx.db.get(cid);
      if (txn) candidateTransactions.push(toTxnRef(txn));
    }

    let duplicateOf: (typeof duplicateOfSummary.type) | null = null;
    if (r.duplicateOfReceiptId) {
      const dup = await ctx.db.get(r.duplicateOfReceiptId);
      if (dup) {
        duplicateOf = {
          _id: dup._id,
          url: await ctx.storage.getUrl(dup.storageId),
          amountCents: dup.amountCents ?? null,
          receiptDate: dup.receiptDate ?? null,
          merchant: dup.merchant ?? null,
          linkCount: dup.linkCount,
        };
      }
    }

    const dupSet = await computeSoftDuplicates(ctx, chapterId);
    const softDuplicate = dupSet.has(r._id);

    const duplicateMatches = [];
    if (softDuplicate) {
      for (const d of await findSoftDuplicateMatches(ctx, chapterId, r)) {
        duplicateMatches.push({
          _id: d._id,
          url: await ctx.storage.getUrl(d.storageId),
          amountCents: d.amountCents ?? null,
          receiptDate: d.receiptDate ?? null,
          merchant: d.merchant ?? null,
          linkCount: d.linkCount,
        });
      }
    }

    // Only worth chasing when this receipt ISN'T itself a duplicate — a
    // duplicate-of-a-duplicate chain isn't a case this surfaces.
    const duplicates = [];
    if (!r.duplicateOfReceiptId) {
      for (const d of await findDuplicatesOfReceipt(ctx, chapterId, r._id)) {
        duplicates.push({
          _id: d._id,
          url: await ctx.storage.getUrl(d.storageId),
          amountCents: d.amountCents ?? null,
          receiptDate: d.receiptDate ?? null,
          merchant: d.merchant ?? null,
          linkCount: d.linkCount,
        });
      }
    }

    return {
      ...(await toReceiptSummary(ctx, r)),
      ocrModel: r.ocrModel ?? null,
      correctedByPersonId: r.correctedByPersonId ?? null,
      correctedAt: r.correctedAt ?? null,
      duplicateConfirmedByPersonId: r.duplicateConfirmedByPersonId ?? null,
      duplicateConfirmedAt: r.duplicateConfirmedAt ?? null,
      softDuplicate,
      linkedTransactions,
      candidateTransactions,
      duplicateOf,
      duplicateMatches,
      duplicates,
      duplicateStillLinked: r.duplicateOfReceiptId != null && r.linkCount > 0,
    };
  },
});

/**
 * Dismiss the SOFT-duplicate flag on one receipt — a bookkeeper's "I
 * checked, this isn't a duplicate." Additive + per-receipt (see
 * `receipts.duplicateDismissed`'s schema doc and `computeSoftDuplicates`):
 * only ever silences THIS receipt's own `softDuplicate` output; an
 * undismissed sibling colliding on the same amount+date keeps flagging on
 * its own. Never touches the EXACT-file `duplicateOfReceiptId` relationship
 * — that's a stronger, different signal with its own "jump to original" UI,
 * not dismissible here. Bookkeeper+, chapter-only.
 */
export const dismissDuplicateFlag = mutation({
  args: { receiptId: v.id("receipts") },
  returns: v.null(),
  handler: async (ctx, { receiptId }) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceRole(ctx, chapterId, "bookkeeper");

    const receipt = await ctx.db.get(receiptId);
    if (!receipt || receipt.chapterId !== chapterId) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Receipt not found in your chapter.",
      });
    }

    await ctx.db.patch(receiptId, { duplicateDismissed: true, updatedAt: Date.now() });
    return null;
  },
});

/**
 * Confirm that one receipt IS a duplicate of another — the owner's ask:
 * "when something is confirmed duplicate I cannot merge it — we shouldn't
 * delete the duplicate, just mark it as such, point to the primary receipt,
 * and hide it in the UI." Points `receiptId.duplicateOfReceiptId` at
 * `primaryReceiptId` (the SAME field the derived sha256 exact-file path
 * uses) and stamps `duplicateConfirmedByPersonId`/`duplicateConfirmedAt` so a
 * human confirmation is distinguishable from a derived one (see the schema
 * doc). The moment this lands, `listReceipts`'s default filters hide
 * `receiptId` — see that query's doc; `filter: "duplicates"` still reaches
 * it, and nothing is deleted.
 *
 * DELIBERATELY does NOT touch `receiptLinks`: if `receiptId` already carries
 * links to transactions, they're left as-is — unlinking money records is a
 * decision for a human to make explicitly (via `unlinkReceipt`), not an
 * automatic side effect of a duplicate confirmation. This mutation is a
 * review/visibility action only; it never edits money state.
 *
 * Rejects marking a receipt a duplicate of itself. Bookkeeper+, both
 * receipts must be in the caller's own chapter.
 */
export const markAsDuplicate = mutation({
  args: {
    receiptId: v.id("receipts"),
    primaryReceiptId: v.id("receipts"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    const access = await requireFinanceRole(ctx, chapterId, "bookkeeper");

    if (args.receiptId === args.primaryReceiptId) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "A receipt can't be marked a duplicate of itself.",
      });
    }

    const receipt = await ctx.db.get(args.receiptId);
    if (!receipt || receipt.chapterId !== chapterId) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Receipt not found in your chapter.",
      });
    }
    const primary = await ctx.db.get(args.primaryReceiptId);
    if (!primary || primary.chapterId !== chapterId) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Primary receipt not found in your chapter.",
      });
    }

    await ctx.db.patch(args.receiptId, {
      duplicateOfReceiptId: args.primaryReceiptId,
      duplicateConfirmedByPersonId: access.personId ?? undefined,
      duplicateConfirmedAt: Date.now(),
      updatedAt: Date.now(),
    });
    return null;
  },
});

/**
 * Clear a HUMAN-confirmed duplicate pointer (`markAsDuplicate`) — the
 * "actually, not a duplicate after all" un-mark. ONLY clears a receipt whose
 * `duplicateConfirmedByPersonId` is set (a human assertion, retractable); a
 * DERIVED exact-file (sha256) duplicate — `duplicateOfReceiptId` set with no
 * `duplicateConfirmed*` stamp — is refused, because the bytes really are
 * identical; that isn't a human call to walk back here. A receipt that isn't
 * flagged a duplicate at all is a no-op. Bookkeeper+, chapter-only.
 */
export const unmarkDuplicate = mutation({
  args: { receiptId: v.id("receipts") },
  returns: v.null(),
  handler: async (ctx, { receiptId }) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceRole(ctx, chapterId, "bookkeeper");

    const receipt = await ctx.db.get(receiptId);
    if (!receipt || receipt.chapterId !== chapterId) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Receipt not found in your chapter.",
      });
    }
    if (!receipt.duplicateOfReceiptId) return null;
    if (!receipt.duplicateConfirmedByPersonId) {
      throw new ConvexError({
        code: "FORBIDDEN",
        message:
          "This receipt's file exactly matches an earlier one — that can't be un-marked, only a human-confirmed duplicate can.",
      });
    }

    await ctx.db.patch(receiptId, {
      duplicateOfReceiptId: undefined,
      duplicateConfirmedByPersonId: undefined,
      duplicateConfirmedAt: undefined,
      updatedAt: Date.now(),
    });
    return null;
  },
});

// ── listForTransaction ───────────────────────────────────────────────────────
/** Every receipt linked to one transaction (a txn detail panel's receipt
 *  strip). Bookkeeper+, chapter-only. */
export const listForTransaction = query({
  args: { transactionId: v.id("transactions") },
  returns: v.array(receiptSummary),
  handler: async (ctx, { transactionId }) => {
    const chapterId = (await getChapterIdOrNull(ctx)) as Id<"chapters"> | null;
    if (!chapterId) return [];
    await requireFinanceRole(ctx, chapterId, "bookkeeper");

    const txn = await ctx.db.get(transactionId);
    if (!txn || txn.chapterId !== chapterId) return [];

    const links = await ctx.db
      .query("receiptLinks")
      .withIndex("by_transaction", (q) => q.eq("transactionId", transactionId))
      .take(200);
    const out = [];
    for (const l of links) {
      const r = await ctx.db.get(l.receiptId);
      if (r) out.push(await toReceiptSummary(ctx, r));
    }
    return out;
  },
});

// ── listInboundQueue (upgraded review queue) ─────────────────────────────────
const inboundReceiptSummary = v.object({
  _id: v.id("receipts"),
  url: v.union(v.string(), v.null()),
  amountCents: v.union(v.number(), v.null()),
  receiptDate: v.union(v.number(), v.null()),
  merchant: v.union(v.string(), v.null()),
  linkCount: v.number(),
  duplicateOfReceiptId: v.union(v.id("receipts"), v.null()),
});

const inboundQueueRow = v.object({
  _id: v.id("inboundReceipts"),
  status: inboundStatusValidator,
  fromEmail: v.string(),
  subject: v.union(v.string(), v.null()),
  receivedAt: v.number(),
  senderClass: v.union(receiptSenderClassValidator, v.null()),
  // `null` = an unknown-sender (chapterless) row — visible to every chapter's
  // bookkeeper (see the handler doc), not just the caller's own chapter.
  chapterId: v.union(v.id("chapters"), v.null()),
  detail: v.union(v.string(), v.null()),
  receiptUrl: v.union(v.string(), v.null()),
  candidateTransactionIds: v.array(v.id("transactions")),
  matchedTransactionId: v.union(v.id("transactions"), v.null()),
  // The first-class `receipts` rows this email produced (via `by_inbound`) —
  // usually one, but a multi-attachment email yields several.
  receipts: v.array(inboundReceiptSummary),
});

/** The statuses `listInboundQueue` surfaces with no explicit `status` filter —
 *  everything a bookkeeper still needs to act on, INCLUDING a stranded `error`
 *  row (the old `listInboundReceipts` view never showed these — nothing could
 *  see them). */
const DEFAULT_QUEUE_STATUSES: (typeof INBOUND_RECEIPT_STATUSES)[number][] = [
  "needs_review",
  "no_match",
  "error",
];
const QUEUE_SCAN_LIMIT = 200;

/**
 * The upgraded inbound-email review queue: this chapter's own rows PLUS every
 * CHAPTERLESS (unknown-sender) row — a row with no `chapterId` belongs to no
 * chapter's queue by construction, so without this it would be invisible to
 * every bookkeeper everywhere (see `receiptInbox.ts`'s module doc: "Unknown-
 * sender rows... surface only in the org-wide view the CRM PR adds"). Every
 * bookkeeper in ANY chapter sees the same chapterless rows — there's no better
 * owner for them until a human resolves the sender. Bookkeeper+.
 */
export const listInboundQueue = query({
  args: { status: v.optional(inboundStatusValidator) },
  returns: v.array(inboundQueueRow),
  handler: async (ctx, args) => {
    const chapterId = (await getChapterIdOrNull(ctx)) as Id<"chapters"> | null;
    if (!chapterId) return [];
    await requireFinanceRole(ctx, chapterId, "bookkeeper");

    let rows: Doc<"inboundReceipts">[];
    if (args.status) {
      // One bounded `by_status` scan covers both this chapter's rows in that
      // state and every chapterless row in that state.
      const scan = await ctx.db
        .query("inboundReceipts")
        .withIndex("by_status", (q) => q.eq("status", args.status!))
        .order("desc")
        .take(QUEUE_SCAN_LIMIT);
      rows = scan.filter((r) => r.chapterId == null || r.chapterId === chapterId);
    } else {
      const chapterRows = (
        await ctx.db
          .query("inboundReceipts")
          .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
          .order("desc")
          .take(QUEUE_SCAN_LIMIT)
      ).filter((r) => DEFAULT_QUEUE_STATUSES.includes(r.status));

      const chapterless: Doc<"inboundReceipts">[] = [];
      for (const status of DEFAULT_QUEUE_STATUSES) {
        const scan = await ctx.db
          .query("inboundReceipts")
          .withIndex("by_status", (q) => q.eq("status", status))
          .order("desc")
          .take(QUEUE_SCAN_LIMIT);
        for (const r of scan) if (r.chapterId == null) chapterless.push(r);
      }
      rows = [...chapterRows, ...chapterless];
    }

    // Dedup defensively (a row can only ever match one branch above) + newest
    // first + an overall bound.
    const byId = new Map<Id<"inboundReceipts">, Doc<"inboundReceipts">>();
    for (const r of rows) byId.set(r._id, r);
    const merged = [...byId.values()]
      .sort((a, b) => b.receivedAt - a.receivedAt)
      .slice(0, QUEUE_SCAN_LIMIT);

    const out: (typeof inboundQueueRow.type)[] = [];
    for (const r of merged) {
      const receiptDocs = await ctx.db
        .query("receipts")
        .withIndex("by_inbound", (q) => q.eq("inboundReceiptId", r._id))
        .take(20);
      // BUG FIX: a receipt confirmed (or derived) a DUPLICATE — its
      // `duplicateOfReceiptId` set, whether via a human's `markAsDuplicate` or
      // an exact-file sha256 match — is RESOLVED: it already hides from the
      // library's default views (`listReceipts`'s doc), and it must not keep
      // demanding attention in the inbox either. Exclude it from the per-email
      // `receipts[]` list here; it's still reachable via the library's
      // "Duplicates" filter, never deleted.
      const receipts = [];
      for (const rd of receiptDocs) {
        if (rd.duplicateOfReceiptId != null) continue;
        receipts.push({
          _id: rd._id,
          url: await ctx.storage.getUrl(rd.storageId),
          amountCents: rd.amountCents ?? null,
          receiptDate: rd.receiptDate ?? null,
          merchant: rd.merchant ?? null,
          linkCount: rd.linkCount,
          duplicateOfReceiptId: rd.duplicateOfReceiptId ?? null,
        });
      }
      // If EVERY receipt this email produced turned out to be a duplicate,
      // the row itself is resolved — there's nothing left here for a human to
      // act on, so drop the row entirely rather than leaving an empty-handed
      // "needs a human" card in the queue. A row that never had any extracted
      // receipts at all (an OCR/no-file failure) is unaffected — it still
      // needs a human, so it's never dropped by this rule.
      if (receiptDocs.length > 0 && receipts.length === 0) continue;
      out.push({
        _id: r._id,
        status: r.status,
        fromEmail: r.fromEmail,
        subject: r.subject ?? null,
        receivedAt: r.receivedAt,
        senderClass: r.senderClass ?? null,
        chapterId: r.chapterId ?? null,
        detail: r.detail ?? null,
        receiptUrl: r.receiptStorageId ? await ctx.storage.getUrl(r.receiptStorageId) : null,
        candidateTransactionIds: r.candidateTransactionIds ?? [],
        matchedTransactionId: r.matchedTransactionId ?? null,
        receipts,
      });
    }
    return out;
  },
});

// ── updateReceiptFields (correction) ─────────────────────────────────────────
function assertPositiveCents(cents: number, label: string): void {
  if (!Number.isInteger(cents) || cents <= 0) {
    throw new ConvexError({
      code: "INVALID_AMOUNT",
      message: `${label} must be a positive whole number of cents.`,
    });
  }
}

/**
 * Correct a receipt's CANONICAL fields (never the immutable `ocr*` provenance
 * — see `schema/finances.ts`'s doc comment on `receipts`). `null` clears a
 * field; `undefined` (an omitted key) leaves it untouched. Stamps
 * `correctedByPersonId`/`correctedAt` whenever anything actually changes.
 * Bookkeeper+, chapter-only.
 */
export const updateReceiptFields = mutation({
  args: {
    receiptId: v.id("receipts"),
    amountCents: v.optional(v.union(v.number(), v.null())),
    receiptDate: v.optional(v.union(v.number(), v.null())),
    merchant: v.optional(v.union(v.string(), v.null())),
    note: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    const access = await requireFinanceRole(ctx, chapterId, "bookkeeper");

    const receipt = await ctx.db.get(args.receiptId);
    if (!receipt || receipt.chapterId !== chapterId) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Receipt not found in your chapter.",
      });
    }

    if (args.amountCents !== undefined && args.amountCents !== null) {
      assertPositiveCents(args.amountCents, "Receipt amount");
    }

    const patch: Record<string, unknown> = {};
    if (args.amountCents !== undefined) {
      patch.amountCents = args.amountCents ?? undefined;
    }
    if (args.receiptDate !== undefined) {
      patch.receiptDate = args.receiptDate ?? undefined;
    }
    if (args.merchant !== undefined) {
      const trimmed = args.merchant?.trim();
      patch.merchant = trimmed ? trimmed : undefined;
    }
    if (args.note !== undefined) {
      const trimmed = args.note?.trim();
      patch.note = trimmed ? trimmed : undefined;
    }
    if (Object.keys(patch).length === 0) return null;

    await ctx.db.patch(args.receiptId, {
      ...patch,
      correctedByPersonId: access.personId ?? undefined,
      correctedAt: Date.now(),
      updatedAt: Date.now(),
    });
    return null;
  },
});

// ── suggestMatches ───────────────────────────────────────────────────────────
/**
 * Ranked candidate transactions for a receipt, off its CANONICAL (human-
 * correctable) amount/date/merchant — reuses `receiptInbox.ts#matchReceiptCandidates`
 * (the exact matcher `findReceiptMatches`/the email pipeline use) rather than
 * duplicating the matching logic. Empty when the receipt has no canonical
 * amount yet (nothing to match on). Bookkeeper+, chapter-only.
 */
export const suggestMatches = query({
  args: { receiptId: v.id("receipts") },
  returns: v.array(candidateValidator),
  handler: async (ctx, { receiptId }) => {
    const chapterId = (await getChapterIdOrNull(ctx)) as Id<"chapters"> | null;
    if (!chapterId) return [];
    await requireFinanceRole(ctx, chapterId, "bookkeeper");

    const receipt = await ctx.db.get(receiptId);
    if (!receipt || receipt.chapterId !== chapterId) return [];
    if (receipt.amountCents == null) return [];

    return await matchReceiptCandidates(ctx, {
      chapterId,
      amountCents: receipt.amountCents,
      receiptDate: receipt.receiptDate ?? receipt.createdAt,
      ocrMerchant: receipt.merchant ?? receipt.ocrMerchant,
    });
  },
});

// ── linkReceipt / unlinkReceipt (public mutations over lib/receiptLinks) ─────
const linkResult = v.object({ linked: v.boolean(), reconciled: v.boolean() });
const unlinkResult = v.object({ unlinked: v.boolean() });

/** Load + tenancy-check a receipt and a transaction, both required to be in
 *  the caller's own chapter (chapter-only — see module doc). */
async function requireReceiptAndTxnInChapter(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
  receiptId: Id<"receipts">,
  transactionId: Id<"transactions">,
): Promise<{ receipt: Doc<"receipts">; txn: Doc<"transactions"> }> {
  const receipt = await ctx.db.get(receiptId);
  if (!receipt || receipt.chapterId !== chapterId) {
    throw new ConvexError({
      code: "NOT_FOUND",
      message: "Receipt not found in your chapter.",
    });
  }
  const txn = await ctx.db.get(transactionId);
  if (!txn || txn.chapterId !== chapterId) {
    throw new ConvexError({
      code: "NOT_FOUND",
      message: "Transaction not found in your chapter.",
    });
  }
  return { receipt, txn };
}

/** Manually attach a receipt to a transaction — the bookkeeper's "pick the
 *  right charge" action (`source: "manual"`). Bookkeeper+, chapter-only. */
export const linkReceipt = mutation({
  args: { receiptId: v.id("receipts"), transactionId: v.id("transactions") },
  returns: linkResult,
  handler: async (ctx, args) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    const access = await requireFinanceRole(ctx, chapterId, "bookkeeper");
    await requireReceiptAndTxnInChapter(ctx, chapterId, args.receiptId, args.transactionId);

    return await linkReceiptToTransaction(ctx, {
      receiptId: args.receiptId,
      transactionId: args.transactionId,
      source: "manual",
      linkedByPersonId: access.personId ?? undefined,
      reconcileIfCategorized: true,
    });
  },
});

/** Detach a receipt from a transaction. Never changes the txn's status (a
 *  human unlinked deliberately). Bookkeeper+, chapter-only. */
export const unlinkReceipt = mutation({
  args: { receiptId: v.id("receipts"), transactionId: v.id("transactions") },
  returns: unlinkResult,
  handler: async (ctx, args) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceRole(ctx, chapterId, "bookkeeper");
    await requireReceiptAndTxnInChapter(ctx, chapterId, args.receiptId, args.transactionId);

    return await unlinkReceiptFromTransaction(ctx, {
      receiptId: args.receiptId,
      transactionId: args.transactionId,
    });
  },
});

// ── Mass upload (the owner's backfill workflow) ──────────────────────────────
const uploadOutcome = v.object({
  storageId: v.id("_storage"),
  receiptId: v.id("receipts"),
  duplicate: v.boolean(),
});

/**
 * Submit a batch of already-uploaded files (client called `storage.generateUploadUrl`
 * + POSTed each file, and now hands back the `storageId`s) as new receipts.
 * Bookkeeper+, bounded to `MAX_UPLOAD_BATCH` per call (a backfill session, not
 * an unbounded bulk import).
 *
 * For each file: read its `_storage` system-table `sha256` (never computed by
 * hand) and check for an EARLIER receipt in this chapter with the same hash
 * (`findDuplicateReceiptBySha256`). An exact dupe is still stored (a human may
 * want to see it) but flagged `duplicateOfReceiptId` and NEVER scheduled for
 * OCR/matching — there's nothing new to learn from re-processing the same
 * bytes. Everything else schedules `processUploadedReceipt` (OCR → candidate
 * match → maybe auto-attach) to run right after this mutation commits.
 */
export const submitUploadedReceipts = mutation({
  args: {
    storageIds: v.array(v.id("_storage")),
    // Parallel to `storageIds` (index-matched) — the ORIGINAL filename each
    // file had client-side, when the picker could read one (web `<input
    // type=file>`'s `file.name`, `expo-image-picker`'s `asset.fileName`).
    // Optional/nullable per slot: a native picker sometimes has none to
    // offer, and an older client may omit the array entirely.
    filenames: v.optional(v.array(v.union(v.string(), v.null()))),
  },
  returns: v.array(uploadOutcome),
  handler: async (ctx, args) => {
    // Gate FIRST — an empty or over-cap call still requires the caller to
    // hold bookkeeper+, so a role check can never be bypassed by shaping args.
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    const access = await requireFinanceRole(ctx, chapterId, "bookkeeper");
    const uploader = access.personId ?? undefined;

    if (args.storageIds.length === 0) return [];
    if (args.storageIds.length > MAX_UPLOAD_BATCH) {
      throw new ConvexError({
        code: "TOO_MANY",
        message: `Upload at most ${MAX_UPLOAD_BATCH} receipts at a time.`,
      });
    }

    const results: (typeof uploadOutcome.type)[] = [];
    for (let i = 0; i < args.storageIds.length; i++) {
      const storageId = args.storageIds[i];
      const filename = args.filenames?.[i] ?? undefined;
      const meta = await ctx.db.system.get("_storage", storageId);
      const fileSha256 = meta?.sha256;
      const duplicateOfReceiptId = fileSha256
        ? ((await findDuplicateReceiptBySha256(ctx, chapterId, fileSha256)) ?? undefined)
        : undefined;

      const receiptId = await createReceipt(ctx, {
        chapterId,
        storageId,
        source: "upload",
        uploadedByPersonId: uploader,
        filename,
        fileSha256,
        duplicateOfReceiptId,
      });

      if (!duplicateOfReceiptId) {
        await ctx.scheduler.runAfter(0, internal.receipts.processUploadedReceipt, {
          receiptId,
        });
      }
      results.push({ storageId, receiptId, duplicate: duplicateOfReceiptId != null });
    }
    return results;
  },
});

// ── processUploadedReceipt (the OCR → match → maybe-attach action) ───────────
/** Load a receipt for the action (internal). */
export const getReceiptForProcessing = internalQuery({
  args: { receiptId: v.id("receipts") },
  returns: v.union(v.any(), v.null()),
  handler: async (ctx, { receiptId }) => await ctx.db.get(receiptId),
});

/** Read a stored file's content-type off the `_storage` system table
 *  (internal — an action can't touch `ctx.db` directly). */
export const getStorageContentType = internalQuery({
  args: { storageId: v.id("_storage") },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, { storageId }) => {
    const meta = await ctx.db.system.get("_storage", storageId);
    return meta?.contentType ?? null;
  },
});

/** Stamp a note on a receipt that crashed processing — crash safety so a row
 *  never strands silently (mirrors `processInboundReceipt`'s own catch-and-
 *  mark pattern). Never overwrites a human-authored note. */
export const noteUploadError = internalMutation({
  args: { receiptId: v.id("receipts"), note: v.string() },
  returns: v.null(),
  handler: async (ctx, { receiptId, note }) => {
    const receipt = await ctx.db.get(receiptId);
    if (!receipt) return null;
    if (!receipt.note) {
      await ctx.db.patch(receiptId, { note, updatedAt: Date.now() });
    }
    return null;
  },
});

/**
 * Write an OCR read onto an uploaded receipt, seed its canonical fields
 * PER-FIELD (only a canonical `amountCents`/`receiptDate`/`merchant` that is
 * still EMPTY gets filled from the fresh read — a field that already holds a
 * value, human-corrected or not, is preserved; see the fix's doc on
 * `applyRetryExtraction`, which shares this rule), store the candidate
 * shortlist the caller already computed, and — for a UNIQUE candidate whose
 * transaction carries NO existing receipt link — auto-attach (in-app
 * authenticated upload is trusted, mirroring the email pipeline's
 * `auto_email` bar: `reconcileIfCategorized: true`).
 *
 * `candidateTransactionIds` is PRECOMPUTED by the caller (`runUploadPipeline`,
 * via a separate `ctx.runQuery`) rather than recomputed here — deliberately,
 * so this mutation can catch the race that matters: another receipt (from the
 * SAME upload batch, processed moments apart) may have already attached to
 * that exact transaction between the candidate query and this write landing.
 * When the passed-in unique candidate's transaction already carries ANY
 * `receiptLinks` row, this is a likely duplicate submission — never
 * auto-attach; store the candidate and leave a review note instead.
 */
export const applyUploadOcrAndAttach = internalMutation({
  args: {
    receiptId: v.id("receipts"),
    ocrAmountCents: v.optional(v.number()),
    ocrDate: v.optional(v.number()),
    ocrMerchant: v.optional(v.string()),
    ocrConfidence: v.optional(v.number()),
    ocrModel: v.optional(v.string()),
    // A human-readable reason extraction produced no total, or `undefined` on
    // a successful read — always written explicitly so a SUCCESS clears any
    // stale failure reason from an earlier attempt (never left to linger next
    // to a fresh, successful read).
    ocrError: v.optional(v.string()),
    candidateTransactionIds: v.array(v.id("transactions")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const receipt = await ctx.db.get(args.receiptId);
    if (!receipt) return null;

    const patch: Record<string, unknown> = { updatedAt: Date.now(), ocrError: args.ocrError };
    if (args.ocrAmountCents != null) patch.ocrAmountCents = args.ocrAmountCents;
    if (args.ocrDate != null) patch.ocrDate = args.ocrDate;
    if (args.ocrMerchant) patch.ocrMerchant = args.ocrMerchant;
    if (args.ocrConfidence != null) patch.ocrConfidence = args.ocrConfidence;
    if (args.ocrModel) patch.ocrModel = args.ocrModel;
    // Seed canonical from OCR PER-FIELD: only a canonical field that is still
    // EMPTY gets filled from the fresh read. A field that already holds a
    // value (whether a human typed it or an earlier OCR pass seeded it) is
    // preserved untouched — never overwritten. See `applyRetryExtraction`'s
    // matching doc for the full rationale (this replaces the old all-or-
    // nothing `correctedAt == null` gate, which wrongly left a BLANK field
    // blank forever once ANY field on the receipt had been corrected).
    if (receipt.amountCents == null && args.ocrAmountCents != null) {
      patch.amountCents = args.ocrAmountCents;
    }
    if (receipt.receiptDate == null && args.ocrDate != null) {
      patch.receiptDate = args.ocrDate;
    }
    if (!receipt.merchant && args.ocrMerchant) {
      patch.merchant = args.ocrMerchant;
    }
    if (args.candidateTransactionIds.length) {
      patch.candidateTransactionIds = args.candidateTransactionIds;
    }

    await ctx.db.patch(args.receiptId, patch);

    if (args.candidateTransactionIds.length === 1) {
      const targetId = args.candidateTransactionIds[0];
      const already = await ctx.db
        .query("receiptLinks")
        .withIndex("by_transaction", (q) => q.eq("transactionId", targetId))
        .first();
      if (!already) {
        await linkReceiptToTransaction(ctx, {
          receiptId: args.receiptId,
          transactionId: targetId,
          source: "upload",
          reconcileIfCategorized: true,
        });
      } else if (!receipt.note) {
        await ctx.db.patch(args.receiptId, {
          note:
            "The matching charge already has a receipt attached — a bookkeeper should confirm this isn't a duplicate submission before attaching.",
          updatedAt: Date.now(),
        });
      }
    }
    return null;
  },
});

/**
 * Process ONE mass-uploaded receipt: OCR the file (image/PDF only — a
 * non-image upload, e.g. a rendered text receipt, skips OCR the same way the
 * email pipeline's body path never calls the LLM for text), match candidates,
 * maybe auto-attach. Scheduled by `submitUploadedReceipts`. Crash-safe: a
 * thrown error is caught and stamped onto the receipt's `note` so the row
 * never strands invisibly (mirrors `receiptInbox.ts#processInboundReceipt`).
 */
export const processUploadedReceipt = internalAction({
  args: {
    receiptId: v.id("receipts"),
    // Per-call model override — the retry-UI hook (a follow-up PR wires the
    // re-extract button to this). When set it wins over the stored global
    // `aiModel` + the per-provider default (see `resolveOcrModel`).
    modelOverride: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { receiptId, modelOverride }) => {
    try {
      await runUploadPipeline(ctx, receiptId, modelOverride);
    } catch (err) {
      console.error(`[receipts] processUploadedReceipt errored for ${receiptId}: ${String(err)}`);
      try {
        await ctx.runMutation(internal.receipts.noteUploadError, {
          receiptId,
          note: `Processing error: ${String(err).slice(0, 500)}`,
        });
      } catch (patchErr) {
        console.error(`[receipts] could not note error on ${receiptId}: ${String(patchErr)}`);
      }
    }
    return null;
  },
});

async function runUploadPipeline(
  ctx: ActionCtx,
  receiptId: Id<"receipts">,
  modelOverride?: string,
): Promise<void> {
  const receipt = (await ctx.runQuery(internal.receipts.getReceiptForProcessing, {
    receiptId,
  })) as Doc<"receipts"> | null;
  if (!receipt || receipt.duplicateOfReceiptId) return; // gone, or never scheduled for a dupe

  const blob = await ctx.storage.get(receipt.storageId);
  if (!blob) {
    const note = "The uploaded file could not be found in storage.";
    await ctx.runMutation(internal.receipts.noteUploadError, { receiptId, note });
    await ctx.runMutation(internal.receipts.applyUploadOcrAndAttach, {
      receiptId,
      ocrError: note,
      candidateTransactionIds: [],
    });
    return;
  }
  const contentType =
    (await ctx.runQuery(internal.receipts.getStorageContentType, {
      storageId: receipt.storageId,
    })) ??
    blob.type ??
    "application/octet-stream";

  // A non-image/PDF upload (e.g. a rendered text receipt) skips extraction
  // the same way the email pipeline's body path never calls the LLM for
  // text — but now says so, instead of silently leaving every OCR field
  // blank. `extractReceiptFields` (`receiptInbox.ts`) is the SAME routing —
  // PDF text layer first (zero LLM), vision OCR fallback — the email and
  // retry pipelines use. The model resolves the engine way: per-call
  // `modelOverride` (the retry UI's hook) > stored global `aiModel` >
  // per-provider default. A missing engine key degrades to a typed no-key
  // error (row stays unlinked, no crash), same as the email pipeline.
  let result: OcrRoutingResult;
  if (contentType.startsWith("image/") || contentType === "application/pdf") {
    const config = await ctx.runQuery(
      internal.integrationSettings.readAiEngineConfig,
      {},
    );
    result = await extractReceiptFields(ctx, {
      storageId: receipt.storageId,
      config,
      blob,
      contentType,
      filename: receipt.filename,
      model: resolveOcrModel(config, modelOverride),
    });
  } else {
    result = { ocrError: "Unsupported file type for extraction." };
  }

  // Candidates are computed in a QUERY here (their own transaction), separate
  // from the attach decision in `applyUploadOcrAndAttach` — reusing the SAME
  // matcher the email pipeline calls (`receiptInbox.ts#findReceiptMatches`)
  // rather than duplicating it. That mutation re-checks freshness before
  // trusting this list (see its own doc comment).
  let candidateTransactionIds: Id<"transactions">[] = [];
  if (
    receipt.chapterId != null &&
    receipt.chapterId !== CENTRAL &&
    result.ocrAmountCents != null
  ) {
    const candidates = await ctx.runQuery(internal.receiptInbox.findReceiptMatches, {
      chapterId: receipt.chapterId,
      amountCents: result.ocrAmountCents,
      receiptDate: result.ocrDate ?? receipt.createdAt,
      ocrMerchant: result.ocrMerchant ?? undefined,
    });
    candidateTransactionIds = candidates.map((c) => c.transactionId);
  }

  await ctx.runMutation(internal.receipts.applyUploadOcrAndAttach, {
    receiptId,
    ocrAmountCents: result.ocrAmountCents,
    ocrDate: result.ocrDate,
    ocrMerchant: result.ocrMerchant,
    ocrConfidence: result.ocrConfidence,
    ocrModel: result.ocrModel,
    ocrError: result.ocrError,
    candidateTransactionIds,
  });
}

// ── retryExtraction (bookkeeper-triggered reprocessing) ──────────────────────
/**
 * Re-run extraction on ONE receipt: reload its stored file, redo the SAME
 * routing every ingest path uses (PDF text layer → parse; else vision OCR —
 * `extractReceiptFields`), refresh its candidate shortlist, and clear/set
 * `ocrError`. The fix for "no way to retry a failed extraction from the UI" —
 * a bookkeeper who fixes the OpenRouter key, or just wants another attempt,
 * no longer has to re-upload the file to get a second try.
 *
 * NEVER auto-attaches (unlike the upload/email pipelines) — a human is
 * ALREADY looking at this receipt (that's why they clicked retry); the
 * refreshed candidates are surfaced for them to pick, not silently linked
 * behind their back. Canonical fields fill in PER-FIELD (see
 * `applyRetryExtraction`'s doc): a still-EMPTY amount/date/merchant gets
 * filled from the fresh read even on a receipt with `correctedAt` set (that
 * flag no longer blanket-blocks every field); a field that already holds a
 * value — human-corrected or not — is never overwritten.
 *
 * `model` is an OPTIONAL override threaded straight through to
 * `ocrReceiptImage`'s existing `model` parameter (untouched — see that
 * function's own doc) for a one-off "try a different model" without
 * changing the chapter's configured default. Bookkeeper+, chapter-only.
 */
export const retryExtraction = mutation({
  args: { receiptId: v.id("receipts"), model: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceRole(ctx, chapterId, "bookkeeper");

    const receipt = await ctx.db.get(args.receiptId);
    if (!receipt || receipt.chapterId !== chapterId) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Receipt not found in your chapter.",
      });
    }

    await ctx.scheduler.runAfter(0, internal.receipts.runRetryExtraction, {
      receiptId: args.receiptId,
      model: args.model?.trim() ? args.model.trim() : undefined,
    });
    return null;
  },
});

/**
 * Write a retry's fresh OCR read: always refreshes `ocr*` + the candidate
 * shortlist, and always writes `ocrError` explicitly (a string on failure, or
 * `undefined` to clear a stale one on success).
 *
 * Canonical fields (amount/date/merchant) are seeded from the fresh read
 * PER-FIELD, not all-or-nothing: a canonical field that is still EMPTY (null/
 * unset) gets filled from the fresh read regardless of `correctedAt`; a
 * canonical field that already holds a value is preserved untouched — a real
 * human correction is never clobbered. This fixes the bug where a receipt
 * with `correctedAt` set (from an EARLIER correction to some OTHER field, or
 * a since-cleared field) would refuse to fill in a still-blank amount/date/
 * merchant even on a successful retry — the old rule gated ALL three
 * canonical fields on the single `correctedAt` flag, so "nobody has corrected
 * THIS field" and "nobody has corrected the receipt AT ALL" got conflated.
 * `applyUploadOcrAndAttach` uses the identical per-field rule. NEVER
 * auto-attaches — see `retryExtraction`'s doc.
 */
export const applyRetryExtraction = internalMutation({
  args: {
    receiptId: v.id("receipts"),
    ocrAmountCents: v.optional(v.number()),
    ocrDate: v.optional(v.number()),
    ocrMerchant: v.optional(v.string()),
    ocrConfidence: v.optional(v.number()),
    ocrModel: v.optional(v.string()),
    ocrError: v.optional(v.string()),
    candidateTransactionIds: v.array(v.id("transactions")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const receipt = await ctx.db.get(args.receiptId);
    if (!receipt) return null;

    const patch: Record<string, unknown> = {
      updatedAt: Date.now(),
      ocrError: args.ocrError,
      // Always refresh the shortlist (even to empty) — a retry is a human
      // actively looking at this receipt, so a fresher read should surface
      // fresher matches even when canonical fields stay untouched.
      candidateTransactionIds: args.candidateTransactionIds,
    };
    if (args.ocrAmountCents != null) patch.ocrAmountCents = args.ocrAmountCents;
    if (args.ocrDate != null) patch.ocrDate = args.ocrDate;
    if (args.ocrMerchant) patch.ocrMerchant = args.ocrMerchant;
    if (args.ocrConfidence != null) patch.ocrConfidence = args.ocrConfidence;
    if (args.ocrModel) patch.ocrModel = args.ocrModel;
    // Per-field fill: only a canonical field that is STILL EMPTY gets set
    // from the fresh read. A field that already holds a value — a human's
    // correction, or an earlier successful OCR seed — is left alone.
    if (receipt.amountCents == null && args.ocrAmountCents != null) {
      patch.amountCents = args.ocrAmountCents;
    }
    if (receipt.receiptDate == null && args.ocrDate != null) {
      patch.receiptDate = args.ocrDate;
    }
    if (!receipt.merchant && args.ocrMerchant) {
      patch.merchant = args.ocrMerchant;
    }

    await ctx.db.patch(args.receiptId, patch);
    return null;
  },
});

/** Scheduled by `retryExtraction`. Crash-safe like every other pipeline
 *  action here: a thrown error is caught and turned into a visible
 *  `ocrError` rather than stranding the receipt mid-retry with no signal. */
export const runRetryExtraction = internalAction({
  args: { receiptId: v.id("receipts"), model: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    try {
      await runRetryPipeline(ctx, args.receiptId, args.model);
    } catch (err) {
      console.error(`[receipts] retryExtraction errored for ${args.receiptId}: ${String(err)}`);
      try {
        await ctx.runMutation(internal.receipts.applyRetryExtraction, {
          receiptId: args.receiptId,
          candidateTransactionIds: [],
          ocrError: `Retry failed: ${String(err).slice(0, 300)}`,
        });
      } catch (patchErr) {
        console.error(`[receipts] could not note retry error on ${args.receiptId}: ${String(patchErr)}`);
      }
    }
    return null;
  },
});

async function runRetryPipeline(
  ctx: ActionCtx,
  receiptId: Id<"receipts">,
  model: string | undefined,
): Promise<void> {
  const receipt = (await ctx.runQuery(internal.receipts.getReceiptForProcessing, {
    receiptId,
  })) as Doc<"receipts"> | null;
  if (!receipt) return;

  const blob = await ctx.storage.get(receipt.storageId);
  if (!blob) {
    await ctx.runMutation(internal.receipts.applyRetryExtraction, {
      receiptId,
      candidateTransactionIds: receipt.candidateTransactionIds ?? [],
      ocrError: "The stored file could not be found — it may have been deleted.",
    });
    return;
  }
  const contentType =
    (await ctx.runQuery(internal.receipts.getStorageContentType, {
      storageId: receipt.storageId,
    })) ??
    blob.type ??
    "application/octet-stream";

  let result: OcrRoutingResult;
  if (contentType.startsWith("image/") || contentType === "application/pdf") {
    // Retry resolves the model the engine way, with the optional per-retry
    // `model` as the override (the "try a different model inline" hook) >
    // stored global `aiModel` > per-provider default.
    const config = await ctx.runQuery(
      internal.integrationSettings.readAiEngineConfig,
      {},
    );
    result = await extractReceiptFields(ctx, {
      storageId: receipt.storageId,
      config,
      blob,
      contentType,
      filename: receipt.filename,
      model: resolveOcrModel(config, model),
    });
  } else {
    result = { ocrError: "Unsupported file type for extraction." };
  }

  // BUG FIX: the email pipeline's merchant FALLBACK (`deriveMerchantFromEmail`
  // — display name > sending domain > "receipt from X" subject fragment) only
  // ever ran once, during INITIAL processing (`receiptInbox.ts#runPipeline`).
  // A retry re-runs the SAME `extractReceiptFields` routing with no email
  // context at all, so an email-sourced receipt whose fresh OCR/PDF-text read
  // still comes back with no merchant used to stay blank FOREVER, even after
  // a successful retry — there was simply no path left to try. Mirror the
  // same fallback here: an email-sourced receipt (has an `inboundReceiptId`)
  // whose fresh extraction found no merchant loads its originating
  // `inboundReceipts` row and derives one from the envelope, exactly like the
  // initial pipeline does. Never overwrites a real extracted merchant — only
  // fills a gap left by this retry's own read.
  if (!result.ocrMerchant && receipt.source === "email" && receipt.inboundReceiptId) {
    const inbound = (await ctx.runQuery(internal.receiptInbox.getInboundReceipt, {
      receiptId: receipt.inboundReceiptId,
    })) as Doc<"inboundReceipts"> | null;
    if (inbound) {
      const fallback = deriveMerchantFromEmail(inbound.fromEmail, inbound.subject);
      if (fallback) result = { ...result, ocrMerchant: fallback };
    }
  }

  let candidateTransactionIds: Id<"transactions">[] = [];
  if (
    receipt.chapterId != null &&
    receipt.chapterId !== CENTRAL &&
    result.ocrAmountCents != null
  ) {
    const candidates = await ctx.runQuery(internal.receiptInbox.findReceiptMatches, {
      chapterId: receipt.chapterId,
      amountCents: result.ocrAmountCents,
      receiptDate: result.ocrDate ?? receipt.createdAt,
      ocrMerchant: result.ocrMerchant ?? undefined,
    });
    candidateTransactionIds = candidates.map((c) => c.transactionId);
  }

  await ctx.runMutation(internal.receipts.applyRetryExtraction, {
    receiptId,
    ocrAmountCents: result.ocrAmountCents,
    ocrDate: result.ocrDate,
    ocrMerchant: result.ocrMerchant,
    ocrConfidence: result.ocrConfidence,
    ocrModel: result.ocrModel,
    ocrError: result.ocrError,
    candidateTransactionIds,
  });
}
