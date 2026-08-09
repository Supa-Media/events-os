/**
 * The receipt CRM surface — the query/mutation API the receipts UI consumes,
 * plus mass upload (the owner's backfill workflow), duplicate detection, and
 * archiving (`archiveReceipt`/`unarchiveReceipt` — the founder's general
 * "hide nonsense receipts, with a way back" ask; `markAsDuplicate` now
 * archives too, so confirming a duplicate is the same act as resolving it).
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
 * always makes on a receipt's first landing — behind a human confirming the
 * link (`linkReceipt` for a bookkeeper, `confirmSuggestedReceipt` for the
 * cardholder on their own coding sheet) or the in-app upload pipeline's own
 * UNIQUE, non-duplicate candidate bar.
 *
 * SUGGESTIONS (owner decision, 2026-08-08): the inbound email/SMS pipelines no
 * longer attach anything on their own (`receiptInbox.ts`'s module doc). What
 * they capture lands here as an unlinked, OCR'd document, and
 * `suggestedForTransaction` + `confirmSuggestedReceipt` are how the person
 * coding a charge sees their own receipts ranked against it and picks one.
 * Those two are the ONLY functions in this file that a non-bookkeeper may
 * call, and they carry their own gate (`lib/receiptSuggestionAccess.ts`).
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
  financeRoleAtLeast,
} from "@events-os/shared";
import { getChapterIdOrNull, requireChapterId } from "./lib/context";
import {
  requireFinanceRole,
  requireCentralFinanceRole,
  getFinanceRole,
  type FinanceAccess,
} from "./lib/finance";
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
  merchantTokens,
  MATCH_WINDOW_MS,
  resolveOcrModel,
  resolveFallbackOcrModel,
  deriveMerchantFromEmail,
  type OcrRoutingResult,
} from "./receiptInbox";
import { requireReceiptSuggestions } from "./lib/receiptSuggestionAccess";
import {
  AUTO_RETRY_FALLBACK_ATTEMPT,
  AUTO_RETRY_MAX_ATTEMPTS,
  scheduleAutoRetryExtraction,
} from "./lib/receiptRetry";
import { isSpend, txnMatchesMode } from "./finances";
import { readSandbox } from "./financeSettings";
import { logFinanceAudit } from "./lib/financeAuditLog";

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

// ── Throttled bulk re-extract (RATE-LIMIT-SAFE) ─────────────────────────────
/**
 * The owner mass-uploaded ~80 receipts; `submitUploadedReceipts` scheduled
 * every one of them at `runAfter(0)` — ~80 concurrent extraction calls hit
 * Ollama's rate limit (HTTP 429) at once, leaving most receipts stuck with
 * `ocrError` set. Two fixes share this one constant:
 *  - `submitUploadedReceipts` STAGGERS its scheduled extractions
 *    `i * THROTTLE_MS` apart instead of firing all at `runAfter(0)` — a small
 *    latency cost (a 25-file batch finishes ~100s later instead of instantly)
 *    for staying under a subscription rate limit.
 *  - `runFailedRetrySweep` (the "re-extract all failed" bulk retry) processes
 *    exactly ONE failed receipt per invocation, then self-reschedules the next
 *    one `THROTTLE_MS` later via `scheduler.runAfter` — SERIAL, never
 *    concurrent, so a bulk retry can never reproduce the original incident.
 * 4s is conservative: comfortably under one call every few seconds, which
 * stays well clear of any sane per-minute subscription cap while still
 * clearing an 80-receipt backlog in a few minutes.
 */
const THROTTLE_MS = 4000;
/** `runFailedRetrySweep`'s backoff schedule after a 429/retryable extraction
 *  failure: exponential starting at `SWEEP_BACKOFF_BASE_MS`, doubling per
 *  consecutive backoff, capped at `SWEEP_BACKOFF_CAP_MS`. A provider-declared
 *  `Retry-After` (threaded through `aiEngine.ts` → `receiptInbox.ts`'s
 *  `ocrRetryAfterSeconds`) is respected as a FLOOR — the exponential delay
 *  only ever lengthens it, never shortens it. 30s→60s→120s→240s→300s(capped)
 *  comfortably outlasts a typical per-minute rate-limit window without
 *  hammering the engine while it's still cooling down. */
const SWEEP_BACKOFF_BASE_MS = 30_000;
const SWEEP_BACKOFF_CAP_MS = 5 * 60_000;
/** Stop the sweep after this many CONSECUTIVE backoffs (429s in a row, with
 *  no successful/permanent-failure receipt in between) — at that point the
 *  engine is very likely down/misconfigured, not just momentarily busy.
 *  Leaves the remaining failed receipts for a later manual re-run instead of
 *  looping (and rescheduling) for hours. Resets to 0 on every receipt that
 *  actually completes (success OR a permanent, non-retryable failure). */
const SWEEP_MAX_CONSECUTIVE_BACKOFFS = 6;
/** Bound one sweep CHAIN's total work — a backfill session (mirrors
 *  `MAX_UPLOAD_BATCH`'s "a batch, not an unbounded bulk import" discipline),
 *  not an unbounded background job. A chapter with more failures than this
 *  needs the button clicked again once the first chain finishes. */
const SWEEP_MAX_RECEIPTS = 300;
/** Bounded scan for "find the next failed receipt after `cursor`" / "count
 *  failed receipts" — mirrors `DUPLICATE_SCAN_LIMIT`'s "generous but bounded"
 *  discipline; a chapter with more receipts than this only sees the count/
 *  next-candidate within its most-recent `SWEEP_SCAN_LIMIT` receipts. */
const SWEEP_SCAN_LIMIT = 500;
/** An `inProgress` sweep marker whose heartbeat (`updatedAt`) is older than
 *  this is treated as an ABANDONED chain (the action crashed past its own
 *  try/catch, or the deployment restarted mid-sweep) — `retryFailedExtractions`
 *  lets a fresh sweep start rather than blocking forever on a marker nothing
 *  will ever clear. Generous vs. the heartbeat cadence (every `THROTTLE_MS` in
 *  the normal case, every backoff step at worst `SWEEP_BACKOFF_CAP_MS` apart
 *  — so 15 minutes is several backoff-steps of slack). */
const SWEEP_STALE_MS = 15 * 60_000;

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
  // The STORED FILE's content type, straight off `_storage`. The viewer needs
  // it to decide how to render: an image gets `<Image>`, a PDF or an EMAIL
  // BODY (`text/html`, `text/plain`) needs a document frame instead — handing
  // either to `<Image>` renders nothing at all. `null` for a legacy row whose
  // storage metadata is gone.
  contentType: v.union(v.string(), v.null()),
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
  // Extraction IN FLIGHT (queued/running, with the automatic retry's attempt
  // number and fire time) — what the UI turns into a live progress strip
  // instead of a button whose spinner stops before the work does. `null` when
  // nothing is pending. See `receipts.extraction` in `schema/finances.ts`,
  // and `isReceiptExtractionActive` for the staleness rule readers apply.
  extraction: v.union(
    v.object({
      status: v.union(v.literal("queued"), v.literal("running")),
      since: v.number(),
      attempt: v.union(v.number(), v.null()),
      maxAttempts: v.union(v.number(), v.null()),
      nextAttemptAt: v.union(v.number(), v.null()),
    }),
    v.null(),
  ),
  linkCount: v.number(),
  duplicateOfReceiptId: v.union(v.id("receipts"), v.null()),
  // Founder feedback PR: whether this receipt is archived (a nonsense
  // receipt hidden by hand, OR a confirmed duplicate — see
  // `markAsDuplicate`'s doc). `false` for every pre-existing row.
  archived: v.boolean(),
  // ── PROVENANCE (founder decision, 2026-07-24) ───────────────────────────────
  // Where this receipt probably belongs and who put it there. Purely
  // informational + ranking fuel — see `schema/finances.ts`'s `chapterId` doc.
  // `chapterName` is null for a chapterless (unknown-sender) row, which the UI
  // labels "Unassigned"; `uploadedByName` is null for an email-sourced row
  // whose sender never resolved to a roster person.
  chapterId: v.union(v.id("chapters"), v.literal(CENTRAL), v.null()),
  chapterName: v.union(v.string(), v.null()),
  uploadedByName: v.union(v.string(), v.null()),
  createdAt: v.number(),
});

/**
 * Every TRANSACTION scope this caller may match receipts against: their own
 * chapter, plus CENTRAL when they hold central reach at bookkeeper rank.
 *
 * Receipts went org-wide (see `schema/finances.ts`'s `chapterId` doc) but
 * TRANSACTIONS did not — a charge is real money owned by exactly one scope,
 * and a Boston bookkeeper still has no business matching against New York's
 * ledger. What was broken is narrower: every receipt→transaction search read
 * the caller's home chapter ONLY, so a CENTRAL-owned charge was invisible to
 * the matcher, the suggestion list, and the free-text search alike. A receipt
 * for a central purchase therefore reported "No candidate transactions found"
 * and could never be matched by hand either (founder bug, 2026-07-24).
 */
async function readableTxnScopes(
  ctx: QueryCtx,
  homeChapterId: Id<"chapters">,
): Promise<(Id<"chapters"> | typeof CENTRAL)[]> {
  const access = await getFinanceRole(ctx, homeChapterId);
  const scopes: (Id<"chapters"> | typeof CENTRAL)[] = [homeChapterId];
  if (access.isCentral && financeRoleAtLeast(access.role, "bookkeeper")) {
    scopes.push(CENTRAL);
  }
  return scopes;
}

/** Read-through caches for a single query's provenance lookups — a library
 *  page is mostly a handful of distinct chapters/uploaders, so this keeps the
 *  per-row `db.get`s to one per DISTINCT id rather than one per row. */
type ProvenanceCache = {
  chapters: Map<string, string | null>;
  people: Map<string, string | null>;
};
function newProvenanceCache(): ProvenanceCache {
  return { chapters: new Map(), people: new Map() };
}

async function resolveProvenance(
  ctx: QueryCtx,
  r: Doc<"receipts">,
  cache: ProvenanceCache,
): Promise<{ chapterName: string | null; uploadedByName: string | null }> {
  let chapterName: string | null = null;
  if (r.chapterId === CENTRAL) {
    chapterName = "Central";
  } else if (r.chapterId) {
    const key = r.chapterId as string;
    if (!cache.chapters.has(key)) {
      const doc = await ctx.db.get(r.chapterId as Id<"chapters">);
      cache.chapters.set(key, doc?.name ?? null);
    }
    chapterName = cache.chapters.get(key) ?? null;
  }
  let uploadedByName: string | null = null;
  if (r.uploadedByPersonId) {
    const key = r.uploadedByPersonId as string;
    if (!cache.people.has(key)) {
      const doc = await ctx.db.get(r.uploadedByPersonId);
      cache.people.set(key, doc?.name ?? null);
    }
    uploadedByName = cache.people.get(key) ?? null;
  }
  return { chapterName, uploadedByName };
}

async function toReceiptSummary(ctx: QueryCtx, r: Doc<"receipts">, cache?: ProvenanceCache) {
  const { chapterName, uploadedByName } = await resolveProvenance(
    ctx,
    r,
    cache ?? newProvenanceCache(),
  );
  return {
    _id: r._id,
    url: await ctx.storage.getUrl(r.storageId),
    contentType:
      (await ctx.db.system.get("_storage", r.storageId))?.contentType ?? null,
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
    extraction: r.extraction
      ? {
          status: r.extraction.status,
          since: r.extraction.since,
          attempt: r.extraction.attempt ?? null,
          maxAttempts: r.extraction.maxAttempts ?? null,
          nextAttemptAt: r.extraction.nextAttemptAt ?? null,
        }
      : null,
    linkCount: r.linkCount,
    duplicateOfReceiptId: r.duplicateOfReceiptId ?? null,
    archived: r.archived === true,
    chapterId: r.chapterId ?? null,
    chapterName,
    uploadedByName,
    createdAt: r.createdAt,
  };
}

/**
 * A bounded, newest-first scan of ALL receipts org-wide, keyed by
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
 *
 * FOUNDER BUG FIX (2026-07-24): a row that's ARCHIVED or already a confirmed/
 * derived duplicate (`duplicateOfReceiptId` set) is dropped BEFORE grouping —
 * not just from the output, unlike `duplicateDismissed` above. Previously
 * only `duplicateDismissed` was excluded, so once B was marked a duplicate of
 * A, {A, B} still collided and kept flagging A's "possible duplicate" warning
 * even though B was already resolved and hidden — exactly the owner's
 * complaint: "when you mark something as duplicate the original still shows
 * the duplicate warning." A resolved sibling shouldn't count toward anyone
 * else's collision group either.
 */
async function computeSoftDuplicates(ctx: QueryCtx): Promise<Set<Id<"receipts">>> {
  // ORG-WIDE (founder decision, 2026-07-24): receipts are no longer
  // chapter-scoped, so neither is duplicate detection — the same photo
  // emailed by two people who happen to sit in different chapters is exactly
  // the collision this is for, and the old per-chapter scan couldn't see it.
  const scan = await ctx.db.query("receipts").order("desc").take(DUPLICATE_SCAN_LIMIT);
  const byKey = new Map<string, Doc<"receipts">[]>();
  for (const r of scan) {
    if (r.amountCents == null || r.receiptDate == null) continue;
    if (r.archived === true || r.duplicateOfReceiptId != null) continue;
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
 * The OTHER receipt(s) org-wide that share `receipt`'s canonical
 * amount+date — EXACTLY the `computeSoftDuplicates` collision criteria,
 * surfaced so a flagged receipt's "why" is answerable (and actionable — the
 * mobile detail view links straight to each one). Excludes itself and its
 * own EXACT-file group (any receipt sharing `fileSha256`, which already has
 * its own dedicated `duplicateOf`/"jump to original" callout — repeating it
 * here would be noise, not a second signal). Bounded to
 * `MAX_DUPLICATE_MATCHES`, newest first.
 *
 * Also excludes any candidate that's already ARCHIVED or already a confirmed/
 * derived duplicate of something else (same discipline as
 * `computeSoftDuplicates`) — a resolved receipt shouldn't be offered back up
 * as a live "This is a duplicate" target.
 */
async function findSoftDuplicateMatches(
  ctx: QueryCtx,
  receipt: Doc<"receipts">,
): Promise<Doc<"receipts">[]> {
  if (receipt.amountCents == null || receipt.receiptDate == null) return [];
  // Org-wide, matching `computeSoftDuplicates` — see its own doc.
  const scan = await ctx.db.query("receipts").order("desc").take(DUPLICATE_SCAN_LIMIT);
  return scan
    .filter(
      (r) =>
        r._id !== receipt._id &&
        r.amountCents === receipt.amountCents &&
        r.receiptDate === receipt.receiptDate &&
        r.archived !== true &&
        r.duplicateOfReceiptId == null &&
        !(receipt.fileSha256 && r.fileSha256 === receipt.fileSha256),
    )
    .slice(0, MAX_DUPLICATE_MATCHES);
}

/**
 * The OTHER receipt(s) org-wide whose `duplicateOfReceiptId` points at
 * `receiptId` — i.e. `receiptId` is the kept PRIMARY of one or more hidden
 * duplicates (derived sha256 matches AND human-confirmed ones alike; see
 * `getReceipt`'s doc on `duplicates`). Bounded scan (same discipline as
 * `findSoftDuplicateMatches`), newest first, capped at `MAX_DUPLICATE_MATCHES`.
 */
async function findDuplicatesOfReceipt(
  ctx: QueryCtx,
  receiptId: Id<"receipts">,
): Promise<Doc<"receipts">[]> {
  // Org-wide, matching `computeSoftDuplicates` — see its own doc.
  const scan = await ctx.db.query("receipts").order("desc").take(DUPLICATE_SCAN_LIMIT);
  return scan.filter((r) => r.duplicateOfReceiptId === receiptId).slice(0, MAX_DUPLICATE_MATCHES);
}

// ── listReceipts (the library view) ──────────────────────────────────────────
/** `"duplicates"` is the ONLY filter that surfaces a receipt with
 *  `duplicateOfReceiptId` set — every other filter EXCLUDES them by default
 *  (see the handler doc: hiding is never deleting, and this filter is how a
 *  confirmed/exact duplicate stays reachable). `"archived"` is the mirror for
 *  `archived` — the founder's general "archive the nonsense ones" ask. */
const listFilterValidator = v.union(
  v.literal("all"),
  v.literal("unlinked"),
  v.literal("linked"),
  v.literal("duplicates"),
  v.literal("archived"),
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
 *
 * ARCHIVE HIDING (founder ask, 2026-07-24): an `archived` receipt (a hand-
 * archived nonsense receipt, OR a confirmed duplicate — `markAsDuplicate` now
 * archives too) is likewise EXCLUDED from `"all"`/`"unlinked"`/`"linked"`, but
 * `"duplicates"` deliberately does NOT exclude it — a confirmed duplicate
 * should keep showing up there whether or not it's also archived, so "jump to
 * the primary" stays reachable from one place. `"archived"` is the dedicated
 * filter for browsing (and un-archiving) everything hidden this way.
 */
export const listReceipts = query({
  args: {
    filter: v.optional(listFilterValidator),
    limit: v.optional(v.number()),
    // PROVENANCE RANKING (founder ask, 2026-07-24): when the caller is picking
    // a receipt to attach to a specific transaction, sort the page so the
    // likeliest candidates lead — receipts whose provenance chapter matches
    // that transaction's scope first, then chapterless/unknown-sender ones,
    // then everything else. Purely an ORDERING hint: nothing is filtered out,
    // because "a Boston member uploaded it" makes a Boston purchase LIKELY,
    // not certain, and the whole point of de-scoping was to keep the odd case
    // reachable. Absent → plain newest-first.
    rankForTransactionId: v.optional(v.id("transactions")),
  },
  returns: v.array(listReceiptRow),
  handler: async (ctx, args) => {
    // Receipts are ORG-WIDE (founder decision, 2026-07-24 — see
    // `schema/finances.ts`'s `chapterId` doc): any finance-seat holder in any
    // chapter sees every receipt. The caller's home chapter is still where we
    // resolve their finance role from, but it no longer filters the results.
    const homeChapterId = (await getChapterIdOrNull(ctx)) as Id<"chapters"> | null;
    if (!homeChapterId) return [];
    await requireFinanceRole(ctx, homeChapterId, "bookkeeper");

    const filter = args.filter ?? "all";
    const limit = Math.min(Math.max(Math.trunc(args.limit ?? DEFAULT_LIST_LIMIT), 1), MAX_LIST_LIMIT);

    let rows: Doc<"receipts">[];
    if (filter === "unlinked") {
      const page = await ctx.db
        .query("receipts")
        .withIndex("by_linkCount", (q) => q.eq("linkCount", 0))
        .order("desc")
        .take(limit);
      rows = page.filter((r) => r.duplicateOfReceiptId == null && r.archived !== true);
    } else if (filter === "duplicates") {
      const page = await ctx.db.query("receipts").order("desc").take(limit);
      rows = page.filter((r) => r.duplicateOfReceiptId != null);
    } else if (filter === "archived") {
      const page = await ctx.db.query("receipts").order("desc").take(limit);
      rows = page.filter((r) => r.archived === true);
    } else {
      const page = await ctx.db.query("receipts").order("desc").take(limit);
      const undupedPage = page.filter(
        (r) => r.duplicateOfReceiptId == null && r.archived !== true,
      );
      rows = filter === "linked" ? undupedPage.filter((r) => r.linkCount > 0) : undupedPage;
    }

    // Provenance ranking (stable — equal ranks keep the newest-first order the
    // index already produced). The target txn is read only for its scope; the
    // caller's right to SEE receipts was already settled above.
    if (args.rankForTransactionId) {
      const txn = await ctx.db.get(args.rankForTransactionId);
      if (txn) {
        const rank = (r: Doc<"receipts">) =>
          r.chapterId === txn.chapterId ? 0 : r.chapterId == null ? 1 : 2;
        rows = rows.map((r, i) => ({ r, i })).sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i)
          .map(({ r }) => r);
      }
    }

    const dupSet = await computeSoftDuplicates(ctx);
    const cache = newProvenanceCache();
    const out = [];
    for (const r of rows) {
      out.push({
        ...(await toReceiptSummary(ctx, r, cache)),
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
  // `archived` itself rides along on `receiptSummary.fields` above — these
  // are the "who/when" stamps, so the UI can render "Archived by X on Y".
  archivedAt: v.union(v.number(), v.null()),
  archivedByPersonId: v.union(v.id("people"), v.null()),
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
    if (!r) return null;

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

    const dupSet = await computeSoftDuplicates(ctx);
    const softDuplicate = dupSet.has(r._id);

    const duplicateMatches = [];
    if (softDuplicate) {
      for (const d of await findSoftDuplicateMatches(ctx, r)) {
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
      for (const d of await findDuplicatesOfReceipt(ctx, r._id)) {
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
      archivedAt: r.archivedAt ?? null,
      archivedByPersonId: r.archivedByPersonId ?? null,
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
    if (!receipt) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Receipt not found.",
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
 * FOUNDER FIX (2026-07-24): also ARCHIVES `receiptId` (the same three fields
 * `archiveReceipt` sets) — "mark duplicate" and "archive the known duplicate"
 * are now the same act, per the founder's ask that confirming a duplicate
 * should be the way you resolve it. `listReceipts`'s `"archived"` filter and
 * its `"duplicates"` filter both still reach the row (archiving doesn't
 * change `duplicates` visibility — see that query's doc); `unmarkDuplicate`
 * undoes both halves together.
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
    if (!receipt) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Receipt not found.",
      });
    }
    const primary = await ctx.db.get(args.primaryReceiptId);
    if (!primary) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Primary receipt not found in your chapter.",
      });
    }

    const now = Date.now();
    await ctx.db.patch(args.receiptId, {
      duplicateOfReceiptId: args.primaryReceiptId,
      duplicateConfirmedByPersonId: access.personId ?? undefined,
      duplicateConfirmedAt: now,
      archived: true,
      archivedAt: now,
      archivedByPersonId: access.personId ?? undefined,
      updatedAt: now,
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
 *
 * FOUNDER FIX (2026-07-24): also clears the archive fields `markAsDuplicate`
 * set alongside the duplicate stamps — one coherent undo, symmetric with that
 * mutation now doing both halves together.
 */
export const unmarkDuplicate = mutation({
  args: { receiptId: v.id("receipts") },
  returns: v.null(),
  handler: async (ctx, { receiptId }) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceRole(ctx, chapterId, "bookkeeper");

    const receipt = await ctx.db.get(receiptId);
    if (!receipt) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Receipt not found.",
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
      archived: undefined,
      archivedAt: undefined,
      archivedByPersonId: undefined,
      updatedAt: Date.now(),
    });
    return null;
  },
});

// ── archiveReceipt / unarchiveReceipt ─────────────────────────────────────────
/**
 * Archive a receipt — the founder's general "nonsense receipts" ask: a blank
 * photo, a stray screenshot, anything worth clearing out of the everyday
 * library view that ISN'T (necessarily) a duplicate. Same philosophy as
 * `duplicateOfReceiptId`: this HIDES the row from `listReceipts`'s default
 * filters (see that query's doc), it never DELETES it — the row, its stored
 * file, and any existing `receiptLinks` all survive untouched. A linked-and-
 * archived receipt stays linked; unlinking it is a separate, explicit choice
 * (`unlinkReceipt`), never an automatic side effect of archiving. Bookkeeper+,
 * chapter-only.
 */
export const archiveReceipt = mutation({
  args: { receiptId: v.id("receipts") },
  returns: v.null(),
  handler: async (ctx, { receiptId }) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    const access = await requireFinanceRole(ctx, chapterId, "bookkeeper");

    const receipt = await ctx.db.get(receiptId);
    if (!receipt) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Receipt not found.",
      });
    }

    await ctx.db.patch(receiptId, {
      archived: true,
      archivedAt: Date.now(),
      archivedByPersonId: access.personId ?? undefined,
      updatedAt: Date.now(),
    });
    return null;
  },
});

/**
 * Restore an archived receipt back into the everyday library view. If the
 * row was a HUMAN-confirmed duplicate (`duplicateConfirmedByPersonId` set —
 * i.e. it got here via `markAsDuplicate`, not a direct `archiveReceipt`
 * call), this ALSO clears the three duplicate fields — one coherent undo,
 * matching `unmarkDuplicate`'s own archive-clearing symmetry, so a bookkeeper
 * never ends up with a receipt that's back in the library but still silently
 * pointing at a "primary" it no longer resembles being hidden for. A DERIVED
 * sha256 pointer is untouched either way — the bytes are still identical,
 * that was never a human assertion to retract (same rule `unmarkDuplicate`
 * enforces). Bookkeeper+, chapter-only.
 */
export const unarchiveReceipt = mutation({
  args: { receiptId: v.id("receipts") },
  returns: v.null(),
  handler: async (ctx, { receiptId }) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceRole(ctx, chapterId, "bookkeeper");

    const receipt = await ctx.db.get(receiptId);
    if (!receipt) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Receipt not found.",
      });
    }

    const wasHumanConfirmedDuplicate = receipt.duplicateConfirmedByPersonId != null;
    await ctx.db.patch(receiptId, {
      archived: undefined,
      archivedAt: undefined,
      archivedByPersonId: undefined,
      ...(wasHumanConfirmedDuplicate
        ? {
            duplicateOfReceiptId: undefined,
            duplicateConfirmedByPersonId: undefined,
            duplicateConfirmedAt: undefined,
          }
        : {}),
      updatedAt: Date.now(),
    });
    return null;
  },
});

// ── listForTransaction ───────────────────────────────────────────────────────
/** Every receipt linked to one transaction (a txn detail panel's receipt
 *  strip). Bookkeeper+ in any scope the caller can read — a CENTRAL-owned
 *  transaction's receipts used to come back empty for everyone, since this
 *  compared the txn against the caller's home chapter alone. */
export const listForTransaction = query({
  args: { transactionId: v.id("transactions") },
  returns: v.array(receiptSummary),
  handler: async (ctx, { transactionId }) => {
    const chapterId = (await getChapterIdOrNull(ctx)) as Id<"chapters"> | null;
    if (!chapterId) return [];
    await requireFinanceRole(ctx, chapterId, "bookkeeper");

    const txn = await ctx.db.get(transactionId);
    if (!txn) return [];
    const scopes = await readableTxnScopes(ctx, chapterId);
    if (!scopes.includes(txn.chapterId as Id<"chapters"> | typeof CENTRAL)) return [];

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
  // See `receiptSummary.contentType` — the viewer branches on this.
  contentType: v.union(v.string(), v.null()),
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
  // The real poster, when a mailing list rewrote `From:` (the Google Group
  // relay — see `receiptInbox.ts#resolveListSender`). `null` on mail sent
  // straight to the inbox. The queue should show this in place of the list.
  originalSenderEmail: v.union(v.string(), v.null()),
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
      // "Duplicates" filter, never deleted. Same treatment for a hand-
      // archived receipt (founder ask) — an archived nonsense receipt is
      // resolved too, nothing left for the inbox to chase.
      const receipts = [];
      for (const rd of receiptDocs) {
        if (rd.duplicateOfReceiptId != null || rd.archived === true) continue;
        receipts.push({
          _id: rd._id,
          url: await ctx.storage.getUrl(rd.storageId),
          contentType:
            (await ctx.db.system.get("_storage", rd.storageId))?.contentType ?? null,
          amountCents: rd.amountCents ?? null,
          receiptDate: rd.receiptDate ?? null,
          merchant: rd.merchant ?? null,
          linkCount: rd.linkCount,
          duplicateOfReceiptId: rd.duplicateOfReceiptId ?? null,
        });
      }
      // If EVERY receipt this email produced turned out to be a duplicate (or
      // got archived), the row itself is resolved — there's nothing left here
      // for a human to act on, so drop the row entirely rather than leaving
      // an empty-handed "needs a human" card in the queue. A row that never
      // had any extracted receipts at all (an OCR/no-file failure) is
      // unaffected — it still needs a human, so it's never dropped by this
      // rule.
      if (receiptDocs.length > 0 && receipts.length === 0) continue;
      out.push({
        _id: r._id,
        status: r.status,
        fromEmail: r.fromEmail,
        originalSenderEmail: r.originalSenderEmail ?? null,
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
    if (!receipt) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Receipt not found.",
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
    if (!receipt) return [];
    if (receipt.amountCents == null) return [];

    // Every scope the caller can match against, not just their home chapter —
    // see `readableTxnScopes`. Central candidates are appended after the
    // chapter's own, preserving each scope's internal ranking.
    const out = [];
    for (const scope of await readableTxnScopes(ctx, chapterId)) {
      out.push(
        ...(await matchReceiptCandidates(ctx, {
          chapterId: scope,
          amountCents: receipt.amountCents,
          // No canonical date → match on amount alone (never `createdAt`, which
          // would wrongly window out older same-amount charges — the auto-match bug).
          receiptDate: receipt.receiptDate ?? undefined,
          ocrMerchant: receipt.merchant ?? receipt.ocrMerchant,
        })),
      );
    }
    return out;
  },
});

// ── searchUnreceiptedTransactions ────────────────────────────────────────────
const TXN_SEARCH_SCAN_LIMIT = 5000; // mirrors the matcher's CANDIDATE_SCAN_LIMIT
const TXN_SEARCH_MAX_RESULTS = 25;

/**
 * Whether an unreceipted transaction matches a free-text search — merchant OR
 * description text, OR the amount in any form a bookkeeper might type ("$16.36",
 * "16.36", or the raw cents "1636"). Empty query matches everything (the panel
 * then shows the most recent unreceipted charges). Pure + exported so it's
 * unit-testable, same convention as the mobile `receiptMatchesSearch`.
 */
export function transactionMatchesSearch(
  tr: { merchantName?: string | null; description?: string | null; amountCents: number },
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const text = `${tr.merchantName ?? ""} ${tr.description ?? ""}`.toLowerCase();
  if (text.includes(q)) return true;
  const qNum = q.replace(/[$,\s]/g, "");
  if (!qNum) return false;
  const cents = Math.abs(tr.amountCents);
  const dollars = (cents / 100).toFixed(2);
  return dollars.includes(qNum) || String(cents).includes(qNum);
}

/**
 * Free-text search over the chapter's spend transactions — the "search up a
 * transaction to match this receipt to" box in the receipt panel, for when
 * the exact-amount `suggestMatches` list doesn't surface the right charge (a
 * mis-read amount, a receipt with none). Same scan the matcher uses
 * (`by_chapter_and_postedAt` newest-first, `isSpend`, sandbox-filtered),
 * filtered by `transactionMatchesSearch` instead of an exact cent. Returns
 * the same `candidateValidator` shape as `suggestMatches` so the panel
 * renders both lists identically (`merchantOverlap` / `isOwnCharge` aren't
 * meaningful for a free search — always false), PLUS `hasReceipt` so a
 * bookkeeper can tell at a glance which results already carry one.
 *
 * FOUNDER FIX (2026-07-24): "right now searching through transactions, it
 * doesn't let me search transactions that already have receipts, but some
 * transactions may need multiple receipts associated." This used to hard-
 * exclude any transaction with `receiptStorageId` set, which made it
 * impossible to search up a charge that legitimately needs a SECOND receipt
 * (a split purchase, a re-sent copy). Receipted transactions are now
 * INCLUDED, tagged `hasReceipt: true` so the UI can badge them instead of
 * hiding them — linking a second receipt onto an already-receipted
 * transaction needs no backend change at all; `linkReceiptToTransaction`
 * (`lib/receiptLinks.ts`) has always been many-to-many, it just never had a
 * search path that could reach an already-receipted transaction to begin
 * with.
 *
 * KEEP THE NAME: `searchUnreceiptedTransactions` reads as a misnomer now that
 * receipted transactions are included too, but this is a PUBLIC query and
 * renaming it would 404 on any mobile client still running an OTA-lagged
 * bundle that calls it by the old name — leave the name alone.
 *
 * SECOND FOUNDER FIX (2026-07-24): this searched the caller's home chapter
 * ONLY, so a CENTRAL-owned charge could never be found here no matter what
 * was typed — the reported "there is a purchase here that I can't link to a
 * receipt". It now spans every scope the caller may read (`readableTxnScopes`).
 *
 * Bookkeeper+, bounded.
 */
export const searchUnreceiptedTransactions = query({
  args: { query: v.optional(v.string()), limit: v.optional(v.number()) },
  returns: v.array(candidateValidator),
  handler: async (ctx, { query, limit }) => {
    const chapterId = (await getChapterIdOrNull(ctx)) as Id<"chapters"> | null;
    if (!chapterId) return [];
    await requireFinanceRole(ctx, chapterId, "bookkeeper");

    const sandboxMode = await readSandbox(ctx);
    const cap = Math.min(Math.max(Math.trunc(limit ?? TXN_SEARCH_MAX_RESULTS), 1), 100);
    const scopes = await readableTxnScopes(ctx, chapterId);

    const results = [];
    for (const scope of scopes) {
      const rows = await ctx.db
        .query("transactions")
        .withIndex("by_chapter_and_postedAt", (qb) => qb.eq("chapterId", scope))
        .order("desc")
        .take(TXN_SEARCH_SCAN_LIMIT);

      for (const tr of rows) {
        if (!isSpend(tr)) continue;
        if (!txnMatchesMode(tr, sandboxMode)) continue;
        if (!transactionMatchesSearch(tr, query ?? "")) continue;
        results.push({
          transactionId: tr._id,
          amountCents: tr.amountCents,
          postedAt: tr.postedAt,
          merchantName: tr.merchantName,
          description: tr.description,
          status: tr.status,
          merchantOverlap: false,
          isOwnCharge: false,
          hasReceipt: tr.receiptStorageId != null,
        });
        if (results.length >= cap) break;
      }
      if (results.length >= cap) break;
    }
    return results;
  },
});

// ── linkReceipt / unlinkReceipt (public mutations over lib/receiptLinks) ─────
const linkResult = v.object({ linked: v.boolean(), reconciled: v.boolean() });
const unlinkResult = v.object({ unlinked: v.boolean() });

/** Load + tenancy-check a receipt and a transaction. A transaction owned by
 *  the caller's own chapter needs bookkeeper reach there; a CENTRAL-owned
 *  transaction (WP-2.1) needs central reach at bookkeeper rank instead —
 *  mirrors `attachReceipt`'s own central branch, and derives scope from the
 *  TRANSACTION itself (never a client-supplied claim) so it can't be spoofed.
 *  Any other chapter (e.g. a central-peek target) is rejected outright: peek
 *  stays read-only everywhere else in the app (see `reconcile.tsx`'s own doc
 *  comment on `viewingPeekedChapter`), and linking doesn't carve out an
 *  exception. The receipt must match the SAME resolved scope as the txn. */
async function requireReceiptAndTxnInChapter(
  ctx: QueryCtx,
  homeChapterId: Id<"chapters">,
  receiptId: Id<"receipts">,
  transactionId: Id<"transactions">,
): Promise<{ receipt: Doc<"receipts">; txn: Doc<"transactions">; access: FinanceAccess }> {
  const txn = await ctx.db.get(transactionId);
  if (!txn) {
    throw new ConvexError({
      code: "NOT_FOUND",
      message: "Transaction not found in your chapter.",
    });
  }
  let access: FinanceAccess;
  if (txn.chapterId === CENTRAL) {
    access = await requireCentralFinanceRole(ctx, homeChapterId, "bookkeeper");
  } else if (txn.chapterId === homeChapterId) {
    access = await requireFinanceRole(ctx, homeChapterId, "bookkeeper");
  } else {
    throw new ConvexError({
      code: "NOT_FOUND",
      message: "Transaction not found in your chapter.",
    });
  }
  // ANY receipt may attach to a transaction the caller can write to — receipts
  // are org-wide provenance-tagged documents, not chapter property (founder
  // decision, 2026-07-24; see `schema/finances.ts`'s `chapterId` doc). The
  // transaction gate above is the real money boundary; requiring the receipt
  // to match it too is what made a shared-inbox receipt unlinkable.
  const receipt = await ctx.db.get(receiptId);
  if (!receipt) {
    throw new ConvexError({ code: "NOT_FOUND", message: "Receipt not found." });
  }
  return { receipt, txn, access };
}

/** Manually attach a receipt to a transaction — the bookkeeper's "pick the
 *  right charge" action (`source: "manual"`). Bookkeeper+; chapter-only or
 *  central, whichever scope the target transaction is actually in. */
export const linkReceipt = mutation({
  args: { receiptId: v.id("receipts"), transactionId: v.id("transactions") },
  returns: linkResult,
  handler: async (ctx, args) => {
    const homeChapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    const { txn, access } = await requireReceiptAndTxnInChapter(
      ctx,
      homeChapterId,
      args.receiptId,
      args.transactionId,
    );

    const hadReceipt = txn.receiptStorageId != null;
    const result = await linkReceiptToTransaction(ctx, {
      receiptId: args.receiptId,
      transactionId: args.transactionId,
      source: "manual",
      linkedByPersonId: access.personId ?? undefined,
      reconcileIfCategorized: true,
    });
    // financeAuditLog (receipt_attach) — `finances.attachReceipt` (the direct
    // upload path) logs the same action independently for its own call site.
    if (result.linked) {
      await logFinanceAudit(ctx, {
        chapterId: txn.chapterId,
        subjectType: "transaction",
        subjectId: args.transactionId,
        action: "receipt_attach",
        actorPersonId: access.personId,
        field: "receipt",
        before: hadReceipt ? "Attached" : "None",
        after: "Attached",
        amountCents: txn.amountCents,
      });
    }
    return result;
  },
});

/** Detach a receipt from a transaction. Never changes the txn's status (a
 *  human unlinked deliberately). Bookkeeper+; chapter-only or central,
 *  whichever scope the target transaction is actually in. */
export const unlinkReceipt = mutation({
  args: { receiptId: v.id("receipts"), transactionId: v.id("transactions") },
  returns: unlinkResult,
  handler: async (ctx, args) => {
    const homeChapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    const { txn, access } = await requireReceiptAndTxnInChapter(
      ctx,
      homeChapterId,
      args.receiptId,
      args.transactionId,
    );

    const result = await unlinkReceiptFromTransaction(ctx, {
      receiptId: args.receiptId,
      transactionId: args.transactionId,
    });
    // financeAuditLog (receipt_detach) — only when a link actually came off
    // (skip a no-op unlink of a receipt that was never attached).
    if (result.unlinked) {
      await logFinanceAudit(ctx, {
        chapterId: txn.chapterId,
        subjectType: "transaction",
        subjectId: args.transactionId,
        action: "receipt_detach",
        actorPersonId: access.personId,
        field: "receipt",
        before: "Attached",
        after: "None",
        amountCents: txn.amountCents,
      });
    }
    return result;
  },
});

// ── Suggestions: the coding sheet's "is one of these it?" ────────────────────
/** How many of the org's UNLINKED receipts one suggestion query scans
 *  (newest-first via `by_linkCount`) before filtering to this person's own.
 *  Bounded, not exhaustive — same "generous but bounded" discipline as
 *  `DUPLICATE_SCAN_LIMIT`, and a receipt older than the window is still
 *  reachable through the library. */
const SUGGESTION_SCAN_LIMIT = 400;
/** How many legacy (pre-capture-and-suggest) receipts we'll chase back to
 *  their inbound row to learn who sent them. Rows created since the pipeline
 *  change carry `uploadedByPersonId` directly and cost nothing; this bounds
 *  the per-row `db.get` fan-out for the ones that don't, and only ever runs on
 *  receipts that already passed the (cheap, in-memory) plausibility filter. */
const SUGGESTION_LEGACY_OWNER_LOOKUPS = 40;
const DEFAULT_SUGGESTION_LIMIT = 8;
const MAX_SUGGESTION_LIMIT = 25;

/** How a suggested receipt lines up with the charge — everything a human needs
 *  to say yes or no without opening both records side by side. */
const suggestionMatch = v.object({
  // The receipt's total equals the charge's, to the cent (the strongest
  // signal, and the bar the inbound matcher itself uses).
  amountExact: v.boolean(),
  // Signed cents: receipt total minus charge total (both absolute values), so
  // a partial receipt reads negative and a receipt covering more than this
  // charge reads positive. `null` when nothing could be read off the receipt.
  amountDeltaCents: v.union(v.number(), v.null()),
  // Whole days between the receipt's date and the charge's `postedAt`. `null`
  // when the receipt has no date — settlement lag means "3 days before the
  // charge posted" is the NORMAL shape, not a discrepancy.
  daysApart: v.union(v.number(), v.null()),
  withinDateWindow: v.boolean(),
  // The receipt's merchant shares a normalized token with the charge's
  // merchant/description (`receiptInbox.ts#merchantTokens` — the same
  // tokenizer the matcher uses). A booster, never a filter.
  merchantOverlap: v.boolean(),
  // THIS transaction was on the receipt's own candidate shortlist when it was
  // captured (`receipts.candidateTransactionIds`) — i.e. the ingest pipeline
  // already thought so at the moment the receipt arrived. Ranked first.
  pipelineSuggested: v.boolean(),
});

const suggestedReceiptRow = v.object({
  receiptId: v.id("receipts"),
  // A servable URL for the stored file, and its content type so the viewer
  // knows whether to render an image, a PDF, or an email body (see
  // `receiptSummary.contentType`).
  url: v.union(v.string(), v.null()),
  contentType: v.union(v.string(), v.null()),
  filename: v.union(v.string(), v.null()),
  source: receiptSourceValidator,
  // CANONICAL (human-correctable) fields — what the row actually claims.
  amountCents: v.union(v.number(), v.null()),
  receiptDate: v.union(v.number(), v.null()),
  merchant: v.union(v.string(), v.null()),
  // IMMUTABLE OCR provenance — kept alongside so the UI can show "we read
  // $42.10" honestly even after someone corrects the canonical value.
  ocrAmountCents: v.union(v.number(), v.null()),
  ocrDate: v.union(v.number(), v.null()),
  ocrMerchant: v.union(v.string(), v.null()),
  // Why a receipt has no amount to compare (an unreadable photo still belongs
  // in this list — it's the thing they texted from the counter).
  ocrError: v.union(v.string(), v.null()),
  createdAt: v.number(),
  match: suggestionMatch,
  // The ranking score behind the ordering (higher = better). Exposed so the UI
  // can badge a standout ("Looks like a match") without re-deriving the rule.
  score: v.number(),
});

/** Rank a suggestion. Additive and deliberately coarse — the human decides;
 *  this only decides who they read first. */
function scoreSuggestion(m: typeof suggestionMatch.type): number {
  return (
    (m.pipelineSuggested ? 8 : 0) +
    (m.amountExact ? 4 : 0) +
    (m.withinDateWindow ? 2 : 0) +
    (m.merchantOverlap ? 1 : 0)
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Describe how one receipt lines up with one charge, plus whether it's worth
 *  offering at all. `plausible` is deliberately generous: this is ONE person's
 *  own small pile of unattached receipts, and the cost of showing a near-miss
 *  is a glance, while the cost of hiding the right one is an unsubstantiated
 *  charge. */
function describeSuggestion(
  receipt: Doc<"receipts">,
  txn: Doc<"transactions">,
): { match: typeof suggestionMatch.type; plausible: boolean } {
  const chargeCents = Math.abs(txn.amountCents);
  const receiptCents =
    receipt.amountCents != null ? Math.abs(receipt.amountCents) : null;
  const amountExact = receiptCents != null && receiptCents === chargeCents;
  const dated = receipt.receiptDate ?? null;
  // A receipt with no date falls back to WHEN IT ARRIVED for the window test
  // only — never for `daysApart`, which must stay honest about what the
  // document itself says (fabricating a date is the bug `matchReceiptCandidates`
  // documents at length).
  const proximityBasis = dated ?? receipt.createdAt;
  const withinDateWindow = Math.abs(txn.postedAt - proximityBasis) <= MATCH_WINDOW_MS;
  const receiptTokens = merchantTokens(receipt.merchant ?? receipt.ocrMerchant);
  const merchantOverlap =
    receiptTokens.size > 0 &&
    [...merchantTokens(txn.merchantName, txn.description)].some((t) =>
      receiptTokens.has(t),
    );
  const pipelineSuggested = (receipt.candidateTransactionIds ?? []).includes(txn._id);

  const match = {
    amountExact,
    amountDeltaCents: receiptCents != null ? receiptCents - chargeCents : null,
    daysApart: dated != null ? Math.round(Math.abs(txn.postedAt - dated) / DAY_MS) : null,
    withinDateWindow,
    merchantOverlap,
    pipelineSuggested,
  };
  const plausible =
    pipelineSuggested ||
    amountExact ||
    (withinDateWindow && merchantOverlap) ||
    // Nothing readable came off it, but it landed around this charge — the
    // "my photo didn't OCR" case, which is exactly when a human's eyes help.
    (receiptCents == null && withinDateWindow);
  return { match, plausible };
}

/**
 * The unlinked receipts that might document ONE charge, best first — the query
 * behind the coding sheet's "is one of these it?".
 *
 * This exists because the inbound pipeline stopped auto-attaching (owner
 * decision, 2026-08-08 — see `receiptInbox.ts`'s module doc). A texted or
 * emailed receipt now waits, unlinked, in its sender's own library until the
 * person coding the charge confirms it — and that person is usually the
 * CARDHOLDER, which every other read in this file (all `requireFinanceRole(…,
 * "bookkeeper")`) locks out by construction. Hence its own gate:
 * `lib/receiptSuggestionAccess.ts#requireReceiptSuggestions` — the row's own
 * person, or bookkeeper+ — mirroring `requireSubmitCoding`'s shape so the
 * coding sheet and its receipt picker can never disagree about who may act.
 *
 * WHOSE receipts: the transaction's own person's, plus the caller's own (a
 * bookkeeper coding on someone's behalf may have just uploaded the document
 * themselves). Not the org's whole library — a cardholder has no business
 * browsing everyone's receipts, and bookkeepers keep `listReceipts` /
 * `suggestMatches` / `searchUnreceiptedTransactions` for the wide view. A
 * receipt whose sender never resolved to a roster person belongs to nobody and
 * stays the bookkeeper review queue's job, unchanged.
 *
 * Bounded: one `by_linkCount` page (`SUGGESTION_SCAN_LIMIT`, newest first),
 * filtered in memory — never a `.collect()`. Archived receipts and known
 * duplicates are excluded (both are already "resolved" everywhere else in this
 * file).
 */
export const suggestedForTransaction = query({
  args: { transactionId: v.id("transactions"), limit: v.optional(v.number()) },
  returns: v.array(suggestedReceiptRow),
  handler: async (ctx, args) => {
    const access = await requireReceiptSuggestions(ctx, args.transactionId);
    const txn = access.txn;
    const limit = Math.min(
      Math.max(Math.trunc(args.limit ?? DEFAULT_SUGGESTION_LIMIT), 1),
      MAX_SUGGESTION_LIMIT,
    );

    // Whose library this reads. Both ids are resolved SERVER-SIDE (the txn's
    // own person; the caller's own person) — never accepted as an argument.
    const ownerIds = new Set<string>();
    if (txn.personId) ownerIds.add(txn.personId as string);
    if (access.actorPersonId) ownerIds.add(access.actorPersonId as string);
    if (ownerIds.size === 0) return [];

    const unlinked = await ctx.db
      .query("receipts")
      .withIndex("by_linkCount", (q) => q.eq("linkCount", 0))
      .order("desc")
      .take(SUGGESTION_SCAN_LIMIT);

    const rows: { receipt: Doc<"receipts">; match: typeof suggestionMatch.type }[] = [];
    let legacyLookups = 0;
    for (const r of unlinked) {
      if (r.archived === true || r.duplicateOfReceiptId != null) continue;
      // Plausibility FIRST (pure, in-memory), ownership second — so the
      // ownership fan-out below only ever runs on the handful of receipts that
      // could actually be offered.
      const { match, plausible } = describeSuggestion(r, txn);
      if (!plausible) continue;
      if (!(await ownsReceipt(ctx, r, ownerIds, () => legacyLookups++ < SUGGESTION_LEGACY_OWNER_LOOKUPS))) {
        continue;
      }
      rows.push({ receipt: r, match });
    }

    rows.sort((a, b) => {
      const byScore = scoreSuggestion(b.match) - scoreSuggestion(a.match);
      if (byScore !== 0) return byScore;
      const aDays = a.match.daysApart ?? Number.MAX_SAFE_INTEGER;
      const bDays = b.match.daysApart ?? Number.MAX_SAFE_INTEGER;
      if (aDays !== bDays) return aDays - bDays;
      return b.receipt.createdAt - a.receipt.createdAt;
    });

    const out: (typeof suggestedReceiptRow.type)[] = [];
    for (const { receipt: r, match } of rows.slice(0, limit)) {
      out.push({
        receiptId: r._id,
        url: await ctx.storage.getUrl(r.storageId),
        contentType:
          (await ctx.db.system.get("_storage", r.storageId))?.contentType ?? null,
        filename: r.filename ?? null,
        source: r.source,
        amountCents: r.amountCents ?? null,
        receiptDate: r.receiptDate ?? null,
        merchant: r.merchant ?? null,
        ocrAmountCents: r.ocrAmountCents ?? null,
        ocrDate: r.ocrDate ?? null,
        ocrMerchant: r.ocrMerchant ?? null,
        ocrError: r.ocrError ?? null,
        createdAt: r.createdAt,
        match,
        score: scoreSuggestion(match),
      });
    }
    return out;
  },
});

/**
 * Whether one receipt belongs to any of `ownerIds`.
 *
 * Receipts captured since the pipeline change carry `uploadedByPersonId`
 * directly (both inbound channels stamp the resolved sender, and the upload
 * path always did). A LEGACY email/SMS receipt predates that, so its only
 * record of who sent it is the `inboundReceipts` row it came from — chased
 * here through `budget()`, which the caller uses to cap how many such lookups
 * one query may do. Exhausting the budget just means an old receipt isn't
 * offered; it stays reachable through the library.
 */
async function ownsReceipt(
  ctx: QueryCtx,
  receipt: Doc<"receipts">,
  ownerIds: Set<string>,
  budget: () => boolean,
): Promise<boolean> {
  if (receipt.uploadedByPersonId) {
    return ownerIds.has(receipt.uploadedByPersonId as string);
  }
  if (!receipt.inboundReceiptId || !budget()) return false;
  const inbound = await ctx.db.get(receipt.inboundReceiptId);
  return inbound?.personId != null && ownerIds.has(inbound.personId as string);
}

/**
 * Attach a suggested receipt to a charge — the MEMBER-SAFE confirm the coding
 * sheet calls, and the only way a non-bookkeeper can create a receipt link.
 *
 * `linkReceipt` (above) stays bookkeeper-gated: it can attach ANY receipt to
 * ANY transaction in scope, which is a bookkeeper's power and shouldn't be
 * loosened just because cardholders now need one narrow slice of it. This is
 * that slice, and it's narrow on purpose:
 *  - the caller must pass `requireReceiptSuggestions` (own charge, or
 *    bookkeeper+ — the same gate the suggestion list uses),
 *  - the receipt must be one this caller could actually have been OFFERED:
 *    unlinked, not archived, not a known duplicate, and either theirs/the
 *    cardholder's or already on this charge's own suggestion shortlist. A
 *    cardholder must not be able to staple a stranger's receipt to their own
 *    charge by guessing an id — the money boundary is the same one
 *    `requireReceiptAndTxnInChapter` defends for bookkeepers.
 * A bookkeeper+ caller skips the ownership half (they can reach the same
 * receipt through `linkReceipt` anyway) but not the unlinked/not-resolved half.
 *
 * The write itself goes through `lib/receiptLinks.ts#linkReceiptToTransaction`
 * — the single writer — so `receipts.linkCount`, the
 * `transactions.receiptStorageId` denorm, the receipt-reminder clear, the card
 * unlock, and the `categorized → reconciled` flip all stay consistent with
 * every other link. Stamped `source: "manual"`, because that is what it is: a
 * human picked it. Audited as `receipt_attach`, exactly like `linkReceipt`.
 */
export const confirmSuggestedReceipt = mutation({
  args: { receiptId: v.id("receipts"), transactionId: v.id("transactions") },
  returns: linkResult,
  handler: async (ctx, args) => {
    const access = await requireReceiptSuggestions(ctx, args.transactionId);
    const txn = access.txn;

    const receipt = await ctx.db.get(args.receiptId);
    if (!receipt) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Receipt not found." });
    }
    const notOffered = () =>
      new ConvexError({
        code: "FORBIDDEN",
        message: "That receipt isn't one of this charge's suggestions.",
      });
    if (receipt.linkCount > 0 || receipt.archived === true || receipt.duplicateOfReceiptId) {
      // Already attached elsewhere, archived, or resolved as a duplicate —
      // re-using one of those is a bookkeeper's judgment call (`linkReceipt`),
      // not a one-tap confirm.
      throw notOffered();
    }
    if (!access.isBookkeeper) {
      const ownerIds = new Set<string>();
      if (txn.personId) ownerIds.add(txn.personId as string);
      if (access.actorPersonId) ownerIds.add(access.actorPersonId as string);
      const onShortlist = (receipt.candidateTransactionIds ?? []).includes(txn._id);
      let lookups = 0;
      if (
        !onShortlist &&
        !(await ownsReceipt(ctx, receipt, ownerIds, () => lookups++ < 1))
      ) {
        throw notOffered();
      }
    }

    const hadReceipt = txn.receiptStorageId != null;
    const result = await linkReceiptToTransaction(ctx, {
      receiptId: args.receiptId,
      transactionId: args.transactionId,
      source: "manual",
      linkedByPersonId: access.actorPersonId ?? undefined,
      reconcileIfCategorized: true,
    });
    if (result.linked) {
      await logFinanceAudit(ctx, {
        chapterId: txn.chapterId,
        subjectType: "transaction",
        subjectId: args.transactionId,
        action: "receipt_attach",
        actorPersonId: access.actorPersonId,
        field: "receipt",
        before: hadReceipt ? "Attached" : "None",
        after: "Attached",
        amountCents: txn.amountCents,
      });
    }
    return result;
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
 * match → maybe auto-attach) — STAGGERED `THROTTLE_MS` apart (the i-th
 * scheduled extraction runs at `i * THROTTLE_MS`) instead of all at once. A
 * mass upload of ~80 receipts once scheduled every extraction at `runAfter(0)`
 * — ~80 concurrent calls tripped Ollama's rate limit (HTTP 429), leaving most
 * receipts stuck with `ocrError` set. Staggering trades a little latency (the
 * last file in a full `MAX_UPLOAD_BATCH` batch starts ~96s after this mutation
 * returns) for never firing more than one extraction call at a time.
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
    // STAGGERED scheduling (the fix for the mass-upload rate-limit incident):
    // only receipts that actually get scheduled (a dupe never does — see
    // below) advance this counter, so the gap between two REAL extraction
    // calls is always exactly `THROTTLE_MS`, never widened by a run of
    // duplicates in the batch. Trades a little latency (a 25-file batch's
    // last extraction starts up to 24 * THROTTLE_MS ≈ 96s after this mutation
    // returns) for never firing more than one extraction call at once.
    let scheduledCount = 0;
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
        const delay = scheduledCount * THROTTLE_MS;
        await ctx.scheduler.runAfter(
          delay,
          internal.receipts.processUploadedReceipt,
          { receiptId },
        );
        // A staggered batch means the last file waits minutes for its turn —
        // say so on the row (`extraction: queued` + when it fires) rather
        // than showing an empty receipt that looks like a failed read.
        await ctx.db.patch(receiptId, {
          extraction: {
            status: "queued",
            since: Date.now(),
            nextAttemptAt: Date.now() + delay,
          },
        });
        scheduledCount++;
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

/**
 * Stamp (or clear) what extraction is doing to this receipt RIGHT NOW, so the
 * UI can show a live state instead of a button whose spinner stops the moment
 * the action is scheduled. See `receipts.extraction` in `schema/finances.ts`.
 *
 * Only ever describes work that is genuinely pending: `queued` is written
 * alongside the `scheduler.runAfter` that will run it, `running` by the
 * action itself as it starts. Clearing is the commit mutations' job
 * (`applyUploadOcrAndAttach` / `applyRetryExtraction`) — this mutation's
 * `null` is for the paths that bail BEFORE a commit (a receipt that turned
 * out to be a duplicate, a sweep that gave up), so nothing spins on work that
 * is no longer coming.
 */
export const setExtractionProgress = internalMutation({
  args: {
    receiptId: v.id("receipts"),
    extraction: v.union(
      v.object({
        status: v.union(v.literal("queued"), v.literal("running")),
        since: v.number(),
        attempt: v.optional(v.number()),
        maxAttempts: v.optional(v.number()),
        nextAttemptAt: v.optional(v.number()),
      }),
      v.null(),
    ),
  },
  returns: v.null(),
  handler: async (ctx, { receiptId, extraction }) => {
    const receipt = await ctx.db.get(receiptId);
    if (!receipt) return null;
    await ctx.db.patch(receiptId, { extraction: extraction ?? undefined });
    return null;
  },
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

    // `extraction` is cleared here (and in `applyRetryExtraction`) because
    // these two mutations are the ONLY terminal points of every extraction
    // path — so no path can leave a receipt spinning.
    const patch: Record<string, unknown> = {
      updatedAt: Date.now(),
      ocrError: args.ocrError,
      extraction: undefined,
    };
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
  if (!receipt || receipt.duplicateOfReceiptId) {
    // Gone, or never scheduled for a dupe — clear the `queued` stamp the
    // submit mutation wrote so nothing spins on work that isn't coming.
    if (receipt) {
      await ctx.runMutation(internal.receipts.setExtractionProgress, {
        receiptId,
        extraction: null,
      });
    }
    return;
  }
  // Reading now — the UI's spinner tracks THIS, not the scheduling call.
  await ctx.runMutation(internal.receipts.setExtractionProgress, {
    receiptId,
    extraction: { status: "running", since: Date.now() },
  });

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
      // No parsed date → match on amount alone (never the upload time).
      receiptDate: result.ocrDate ?? undefined,
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

  // The engine failed on TRANSPORT (5xx/429/timeout) — the receipt is fine,
  // the read simply never happened. Repair it in the background instead of
  // leaving a red card for a human to notice and tap Retry on
  // (`lib/receiptRetry.ts`). The error above stays visible meanwhile.
  if (result.ocrError && result.ocrRetryable) {
    await scheduleAutoRetryExtraction(ctx, receiptId, 1, result.ocrRetryAfterSeconds);
  }
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
    if (!receipt) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Receipt not found.",
      });
    }

    await ctx.scheduler.runAfter(0, internal.receipts.runRetryExtraction, {
      receiptId: args.receiptId,
      model: args.model?.trim() ? args.model.trim() : undefined,
    });
    // Stamped HERE, not in the action, so the UI flips to "reading" on the
    // same round trip the bookkeeper's tap made — the action starts a moment
    // later and re-stamps it `running`.
    await ctx.db.patch(args.receiptId, {
      extraction: { status: "queued", since: Date.now(), nextAttemptAt: Date.now() },
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
      // This attempt is over, whatever it produced — see
      // `applyUploadOcrAndAttach` for why the clear lives on the commits.
      extraction: undefined,
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

/**
 * AUTOMATIC re-extraction after a TRANSPORT failure — scheduled by whichever
 * pipeline first read this receipt (email/upload) and by itself for each
 * further attempt. See `lib/receiptRetry.ts` for the schedule and why this
 * exists; the short version is that an engine 500 is a blip, not a verdict,
 * and the initial run used to record it like one.
 *
 * Three rules keep it from ever fighting a human:
 *  - It STOPS the moment `ocrError` is clear — a manual Retry, the bulk
 *    sweep, or a bookkeeper typing the total in wins, and a slow automatic
 *    read never lands on top of that.
 *  - It only ever re-reads what is ALREADY a failure; `applyRetryExtraction`
 *    fills canonical fields per-field and only where still empty.
 *  - A retryable failure mid-chain leaves the visible `ocrError` UNTOUCHED
 *    (the sweep's rule) — the card keeps saying what actually went wrong
 *    rather than flickering between engine messages.
 *
 * It repairs the READ, never the ATTACH: like every other retry path this
 * commits through `applyRetryExtraction`, which refreshes the candidate
 * shortlist and NEVER links. Auto-attach stays the ingest pipelines' single
 * responsibility (money safety) — so a receipt whose first read was lost to a
 * 500 comes back with its total and a one-tap suggested match, not a silent
 * background link.
 *
 * Errors are swallowed: this is background repair, and a thrown scheduled
 * action would just retry the whole thing outside our own backoff.
 */
export const autoRetryExtraction = internalAction({
  args: { receiptId: v.id("receipts"), attempt: v.number() },
  returns: v.null(),
  handler: async (ctx, { receiptId, attempt }) => {
    try {
      const receipt = (await ctx.runQuery(internal.receipts.getReceiptForProcessing, {
        receiptId,
      })) as Doc<"receipts"> | null;
      // Gone, or already resolved by someone else — nothing left to repair.
      if (!receipt || !receipt.ocrError) return null;

      // This attempt is no longer a wait — it's happening. The UI switches
      // from "in 4 min" to a live read on this write.
      await ctx.runMutation(internal.receipts.setExtractionProgress, {
        receiptId,
        extraction: {
          status: "running",
          since: Date.now(),
          attempt,
          maxAttempts: AUTO_RETRY_MAX_ATTEMPTS,
        },
      });

      const config = await ctx.runQuery(
        internal.integrationSettings.readAiEngineConfig,
        {},
      );
      const primary = resolveOcrModel(config);
      // The last attempt asks a DIFFERENT vision model — see
      // `AUTO_RETRY_FALLBACK_ATTEMPT`. No distinct fallback configured (or it
      // resolves to the same id) → keep asking the primary.
      const model =
        attempt >= AUTO_RETRY_FALLBACK_ATTEMPT
          ? (resolveFallbackOcrModel(config, primary) ?? primary)
          : primary;

      const computed = await computeRetryExtraction(ctx, receipt, model);
      if (computed.missingFile) {
        await ctx.runMutation(internal.receipts.applyRetryExtraction, {
          receiptId,
          candidateTransactionIds: receipt.candidateTransactionIds ?? [],
          ocrError: "The stored file could not be found — it may have been deleted.",
        });
        return null;
      }

      const { result, candidateTransactionIds } = computed;
      if (result.ocrError && result.ocrRetryable && attempt < AUTO_RETRY_MAX_ATTEMPTS) {
        console.log(
          `[receipts] auto-retry ${attempt}/${AUTO_RETRY_MAX_ATTEMPTS} for ${receiptId} still transient (${result.ocrError.slice(0, 120)}) — backing off.`,
        );
        await scheduleAutoRetryExtraction(
          ctx,
          receiptId,
          attempt + 1,
          result.ocrRetryAfterSeconds,
        );
        return null;
      }

      // A read (success), a permanent failure, or the last attempt's verdict
      // — all of them belong on the receipt now.
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
    } catch (err) {
      console.error(
        `[receipts] autoRetryExtraction attempt ${attempt} errored for ${receiptId}: ${String(err)}`,
      );
    }
    return null;
  },
});

/** Either a re-extraction READ (never yet committed to the receipt — the
 *  caller decides whether/how to persist it) or a signal that the stored
 *  file itself is gone. Shared by `runRetryPipeline` (the single-receipt
 *  retry, which always commits) and `runSweepRetryPipeline` (the bulk sweep,
 *  which withholds the commit on a RETRYABLE failure — see that function's
 *  doc) so the two never drift on what "re-run extraction" means. */
type RetryExtractionComputation =
  | { missingFile: true }
  | { missingFile?: false; result: OcrRoutingResult; candidateTransactionIds: Id<"transactions">[] };

/**
 * Re-run extraction on ONE receipt's already-stored file: redo the SAME
 * routing every ingest path uses (`extractReceiptFields`), apply the email
 * merchant fallback, and refresh the candidate shortlist — WITHOUT writing
 * anything. `runRetryPipeline` and `runSweepRetryPipeline` both call this and
 * then decide independently how (or whether) to persist the read.
 */
async function computeRetryExtraction(
  ctx: ActionCtx,
  receipt: Doc<"receipts">,
  model: string | undefined,
): Promise<RetryExtractionComputation> {
  const blob = await ctx.storage.get(receipt.storageId);
  if (!blob) return { missingFile: true };

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
      // No parsed date → match on amount alone (never the upload time).
      receiptDate: result.ocrDate ?? undefined,
      ocrMerchant: result.ocrMerchant ?? undefined,
    });
    candidateTransactionIds = candidates.map((c) => c.transactionId);
  }

  return { result, candidateTransactionIds };
}

async function runRetryPipeline(
  ctx: ActionCtx,
  receiptId: Id<"receipts">,
  model: string | undefined,
): Promise<void> {
  const receipt = (await ctx.runQuery(internal.receipts.getReceiptForProcessing, {
    receiptId,
  })) as Doc<"receipts"> | null;
  if (!receipt) return;
  // A human is watching this one — mark it running so the button's spinner
  // lasts as long as the READ does, not as long as the mutation did.
  await ctx.runMutation(internal.receipts.setExtractionProgress, {
    receiptId,
    extraction: { status: "running", since: Date.now() },
  });

  const computed = await computeRetryExtraction(ctx, receipt, model);
  if (computed.missingFile) {
    await ctx.runMutation(internal.receipts.applyRetryExtraction, {
      receiptId,
      candidateTransactionIds: receipt.candidateTransactionIds ?? [],
      ocrError: "The stored file could not be found — it may have been deleted.",
    });
    return;
  }

  const { result, candidateTransactionIds } = computed;
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

// ── Bulk re-extract of FAILED receipts (rate-limit-safe sweep) ──────────────
/**
 * One receipt's outcome from a sweep attempt:
 *  - `"success"` — extraction found a usable read; `ocrError` is cleared.
 *  - `"permanent_failure"` — extraction failed for a reason a retry can't fix
 *    (no_total, unsupported file type, missing file, a non-retryable engine
 *    error) — `ocrError` IS written (the real reason), and the sweep moves on
 *    to the next receipt.
 *  - `"retryable_failure"` — a 429 or another transient transport error
 *    (`OcrRoutingResult.ocrRetryable`). Deliberately NEVER persisted — see
 *    `runSweepRetryPipeline`'s doc — so the sweep backs off and retries the
 *    SAME receipt rather than recording a transient blip as if it were final.
 */
type SweepAttemptOutcome =
  | { status: "success" }
  | { status: "permanent_failure" }
  | { status: "retryable_failure"; retryAfterSeconds?: number };

/**
 * The bulk sweep's per-receipt worker: reuses `computeRetryExtraction`
 * (the SAME routing + email-merchant fallback + candidate match as the
 * single-receipt retry), but — unlike `runRetryPipeline` — does NOT always
 * commit the read. On a RETRYABLE failure (a rate limit or other transient
 * transport error), the receipt's `ocrError` is left exactly as it was; only
 * a SUCCESS or a PERMANENT failure gets written via `applyRetryExtraction`.
 * This is what "don't clear/overwrite ocrError as a permanent failure" (the
 * rate-limit-handling requirement) means in practice: a 429 never looks like
 * a settled verdict on the receipt, and the sweep's caller (`runFailedRetrySweep`)
 * decides how long to wait before trying this exact receipt again.
 */
async function runSweepRetryPipeline(
  ctx: ActionCtx,
  receiptId: Id<"receipts">,
  model: string | undefined,
): Promise<SweepAttemptOutcome> {
  const receipt = (await ctx.runQuery(internal.receipts.getReceiptForProcessing, {
    receiptId,
  })) as Doc<"receipts"> | null;
  // Gone (deleted mid-sweep) — nothing to retry; the sweep's cursor already
  // advances past it once `findNextFailedReceipt` stops returning it.
  if (!receipt) return { status: "permanent_failure" };

  // The sweep works one receipt at a time — show WHICH one is being read.
  await ctx.runMutation(internal.receipts.setExtractionProgress, {
    receiptId,
    extraction: { status: "running", since: Date.now() },
  });

  const computed = await computeRetryExtraction(ctx, receipt, model);
  if (computed.missingFile) {
    await ctx.runMutation(internal.receipts.applyRetryExtraction, {
      receiptId,
      candidateTransactionIds: receipt.candidateTransactionIds ?? [],
      ocrError: "The stored file could not be found — it may have been deleted.",
    });
    return { status: "permanent_failure" };
  }

  const { result, candidateTransactionIds } = computed;
  if (result.ocrError && result.ocrRetryable) {
    // Withheld commit (see this function's doc) — so clear the progress stamp
    // by hand: the sweep will come back to this receipt, but not at a time
    // this row can honestly name.
    await ctx.runMutation(internal.receipts.setExtractionProgress, {
      receiptId,
      extraction: null,
    });
    return { status: "retryable_failure", retryAfterSeconds: result.ocrRetryAfterSeconds };
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
  return { status: result.ocrError ? "permanent_failure" : "success" };
}

/** Bounded scan for the next failed receipt in a chapter, newest-attempted
 *  LAST — i.e. oldest-`_creationTime`-first among receipts with `ocrError`
 *  set that this sweep chain hasn't already touched (`afterCreationTime`,
 *  the chain's monotonic watermark). Excludes a receipt that's itself a
 *  duplicate (`duplicateOfReceiptId` set) or ARCHIVED — same as every other
 *  receipt read in this file, a duplicate or archived row is hidden, not
 *  something worth spending a rate-limited extraction call on. Mirrors
 *  `computeSoftDuplicates`' bounded-scan discipline (`SWEEP_SCAN_LIMIT`, same
 *  order of magnitude as `DUPLICATE_SCAN_LIMIT`) rather than a dedicated
 *  index — a chapter's receipt count fits comfortably in one bounded page at
 *  this scale. */
export const findNextFailedReceipt = internalQuery({
  args: {
    chapterId: v.id("chapters"),
    afterCreationTime: v.optional(v.number()),
  },
  returns: v.union(v.any(), v.null()),
  handler: async (ctx, { chapterId, afterCreationTime }) => {
    const scan = await ctx.db
      .query("receipts")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .order("asc")
      .take(SWEEP_SCAN_LIMIT);
    const candidate = scan.find(
      (r) =>
        r.ocrError != null &&
        r.duplicateOfReceiptId == null &&
        r.archived !== true &&
        (afterCreationTime == null || r._creationTime > afterCreationTime),
    );
    return candidate ?? null;
  },
});

/** Count of a chapter's currently-failed receipts (`ocrError` set, not a
 *  duplicate or archived) within the same bounded `SWEEP_SCAN_LIMIT` window
 *  `findNextFailedReceipt` scans — powers `failedExtractionStatus`'s "Re-
 *  extract N failed" button label and `retryFailedExtractions`' short-circuit
 *  when there's nothing to do. A chapter with more receipts than the scan
 *  window undercounts (bounded-read tradeoff, same discipline as
 *  `computeSoftDuplicates`) rather than doing an unbounded count. */
async function countFailedExtractions(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<number> {
  const scan = await ctx.db
    .query("receipts")
    .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
    .order("desc")
    .take(SWEEP_SCAN_LIMIT);
  return scan.filter(
    (r) => r.ocrError != null && r.duplicateOfReceiptId == null && r.archived !== true,
  ).length;
}

/** Read this chapter's `receiptSweepState` singleton row, if any. */
async function getSweepState(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<Doc<"receiptSweepState"> | null> {
  return await ctx.db
    .query("receiptSweepState")
    .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
    .unique();
}

/** True iff this chapter's sweep marker says a chain is running AND its
 *  heartbeat is still fresh (see `SWEEP_STALE_MS`'s doc — a stale marker is
 *  treated as an abandoned chain, not a real one). */
function sweepIsActive(state: Doc<"receiptSweepState"> | null): boolean {
  return !!state?.inProgress && Date.now() - state.updatedAt < SWEEP_STALE_MS;
}

/**
 * `{ failedCount, sweepInProgress }` — powers the mobile Receipts screen's
 * "Re-extract N failed" control: shown (enabled) when `failedCount > 0`,
 * disabled/spinning while `sweepInProgress`. Bookkeeper+, chapter-only; a
 * caller with no chapter yet sees the all-zero/false default rather than an
 * error (mirrors every other `getChapterIdOrNull`-based read here).
 */
export const failedExtractionStatus = query({
  args: {},
  returns: v.object({ failedCount: v.number(), sweepInProgress: v.boolean() }),
  handler: async (ctx) => {
    const chapterId = (await getChapterIdOrNull(ctx)) as Id<"chapters"> | null;
    if (!chapterId) return { failedCount: 0, sweepInProgress: false };
    await requireFinanceRole(ctx, chapterId, "bookkeeper");

    const [failedCount, state] = await Promise.all([
      countFailedExtractions(ctx, chapterId),
      getSweepState(ctx, chapterId),
    ]);
    return { failedCount, sweepInProgress: sweepIsActive(state) };
  },
});

/**
 * Kick off (or no-op into) a THROTTLED bulk re-extraction of every currently
 * failed receipt in the caller's chapter — the fix for the mass-upload
 * rate-limit incident: re-extracting ~80 failures at once would just trip
 * the SAME 429s that created them. Instead this schedules exactly ONE
 * self-chaining internal action (`runFailedRetrySweep`) that processes
 * failed receipts ONE AT A TIME, `THROTTLE_MS` apart, backing off
 * exponentially on a rate-limited attempt (see that action's doc).
 *
 * IDEMPOTENT: if a sweep for this chapter is already active
 * (`sweepIsActive`), this is a no-op (`started: false`) — a double-tap on
 * the UI button, or two bookkeepers clicking it seconds apart, can't spin up
 * a second overlapping chain that would double the request rate right back
 * into the rate limit. A STALE marker (a crashed chain — see `SWEEP_STALE_MS`)
 * is treated as not-running, so this can't wedge forever.
 *
 * `model` is the SAME optional per-call override `retryExtraction` (the
 * single-receipt retry) takes — threaded through every extraction in the
 * sweep, not just the first. Bookkeeper+, chapter-only.
 */
export const retryFailedExtractions = mutation({
  args: { model: v.optional(v.string()) },
  returns: v.object({ started: v.boolean(), failedCount: v.number() }),
  handler: async (ctx, args) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceRole(ctx, chapterId, "bookkeeper");

    const failedCount = await countFailedExtractions(ctx, chapterId);
    if (failedCount === 0) return { started: false, failedCount: 0 };

    const state = await getSweepState(ctx, chapterId);
    if (sweepIsActive(state)) {
      // Already running — don't double the request rate against the engine.
      return { started: false, failedCount };
    }

    const now = Date.now();
    if (state) {
      await ctx.db.patch(state._id, { inProgress: true, startedAt: now, updatedAt: now });
    } else {
      await ctx.db.insert("receiptSweepState", {
        chapterId,
        inProgress: true,
        startedAt: now,
        updatedAt: now,
      });
    }

    const model = args.model?.trim() ? args.model.trim() : undefined;
    await ctx.scheduler.runAfter(0, internal.receipts.runFailedRetrySweep, {
      chapterId,
      model,
    });
    return { started: true, failedCount };
  },
});

/** Bump this chapter's sweep-state heartbeat (`updatedAt`) — called on every
 *  `runFailedRetrySweep` self-reschedule (both the normal-pace and backoff
 *  paths) so a long but healthy chain never reads as stale mid-run; only a
 *  chain that stops rescheduling entirely (a crash) goes quiet. */
export const touchFailedRetrySweep = internalMutation({
  args: { chapterId: v.id("chapters") },
  returns: v.null(),
  handler: async (ctx, { chapterId }) => {
    const state = await ctx.db
      .query("receiptSweepState")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .unique();
    if (state) await ctx.db.patch(state._id, { updatedAt: Date.now() });
    return null;
  },
});

/** Clear this chapter's `inProgress` marker — the sweep's terminal step
 *  (no failures left, its scan cap hit, or its consecutive-backoff cap hit).
 *  A no-op if the row is already gone/clear. */
export const finishFailedRetrySweep = internalMutation({
  args: { chapterId: v.id("chapters") },
  returns: v.null(),
  handler: async (ctx, { chapterId }) => {
    const state = await ctx.db
      .query("receiptSweepState")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .unique();
    if (state) await ctx.db.patch(state._id, { inProgress: false, updatedAt: Date.now() });
    return null;
  },
});

/**
 * The SELF-CHAINING sweep: find the next failed receipt after `cursor`
 * (`findNextFailedReceipt`), re-run extraction on exactly ONE of them
 * (`runSweepRetryPipeline`), then reschedule itself for the next — SERIAL,
 * never concurrent, so a bulk retry can't reproduce the rate-limit incident
 * it exists to fix.
 *
 * Three outcomes per receipt:
 *  - `"success"` / `"permanent_failure"` — the receipt is DONE (its `ocrError`
 *    is written, cleared on success); `cursor` advances past it
 *    (`_creationTime`) and `attempt` resets to 0. Reschedules at the normal
 *    `THROTTLE_MS` pace.
 *  - `"retryable_failure"` (a 429/transient transport error) — `cursor`
 *    does NOT advance (the SAME receipt is retried next) and `attempt`
 *    increments. The delay is exponential (`SWEEP_BACKOFF_BASE_MS *
 *    2^attempt`, capped at `SWEEP_BACKOFF_CAP_MS`), or the provider's own
 *    `Retry-After` when longer — never shorter than the exponential floor.
 *    After `SWEEP_MAX_CONSECUTIVE_BACKOFFS` in a row, the sweep STOPS
 *    (logs it) and leaves the rest for a later manual re-run — the engine is
 *    very likely down, not just momentarily busy.
 *
 * Stops (clearing the `inProgress` marker) when `findNextFailedReceipt`
 * finds nothing left, when the chain hits its `SWEEP_MAX_RECEIPTS` total-work
 * cap (logged), or when the consecutive-backoff cap is hit (logged).
 */
export const runFailedRetrySweep = internalAction({
  args: {
    chapterId: v.id("chapters"),
    model: v.optional(v.string()),
    // The watermark: only a failed receipt with `_creationTime` strictly
    // after this has NOT yet been attempted by this chain.
    cursor: v.optional(v.number()),
    // Consecutive-backoff counter — resets to 0 whenever a receipt actually
    // completes (success or permanent failure); stops the chain at
    // `SWEEP_MAX_CONSECUTIVE_BACKOFFS`.
    attempt: v.optional(v.number()),
    // Total receipts this CHAIN has completed so far — bounds one chain's
    // total work at `SWEEP_MAX_RECEIPTS`.
    processed: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { chapterId, model, cursor } = args;
    const attempt = args.attempt ?? 0;
    const processed = args.processed ?? 0;

    await ctx.runMutation(internal.receipts.touchFailedRetrySweep, { chapterId });

    if (processed >= SWEEP_MAX_RECEIPTS) {
      console.log(
        `[receipts] failed-retry sweep for chapter ${chapterId} hit its ${SWEEP_MAX_RECEIPTS}-receipt cap after processing ${processed}; stopping — re-run "Re-extract failed" to continue.`,
      );
      await ctx.runMutation(internal.receipts.finishFailedRetrySweep, { chapterId });
      return null;
    }

    const next = (await ctx.runQuery(internal.receipts.findNextFailedReceipt, {
      chapterId,
      afterCreationTime: cursor,
    })) as Doc<"receipts"> | null;
    if (!next) {
      await ctx.runMutation(internal.receipts.finishFailedRetrySweep, { chapterId });
      return null;
    }

    let outcome: SweepAttemptOutcome;
    try {
      outcome = await runSweepRetryPipeline(ctx, next._id, model);
    } catch (err) {
      // Crash safety: an unexpected throw mid-attempt is treated as a
      // permanent failure for THIS receipt (never stalls the whole chain on
      // one bad row) but is logged loudly since it's unexpected.
      console.error(
        `[receipts] failed-retry sweep errored on receipt ${next._id}: ${String(err)}`,
      );
      try {
        await ctx.runMutation(internal.receipts.applyRetryExtraction, {
          receiptId: next._id,
          candidateTransactionIds: next.candidateTransactionIds ?? [],
          ocrError: `Retry failed: ${String(err).slice(0, 300)}`,
        });
      } catch (patchErr) {
        console.error(
          `[receipts] could not note sweep error on ${next._id}: ${String(patchErr)}`,
        );
      }
      outcome = { status: "permanent_failure" };
    }

    if (outcome.status === "retryable_failure") {
      const nextAttempt = attempt + 1;
      if (nextAttempt >= SWEEP_MAX_CONSECUTIVE_BACKOFFS) {
        console.log(
          `[receipts] failed-retry sweep for chapter ${chapterId} hit ${SWEEP_MAX_CONSECUTIVE_BACKOFFS} consecutive rate-limit backoffs; stopping — the AI engine is likely down or misconfigured. Re-run "Re-extract failed" manually once it's back.`,
        );
        await ctx.runMutation(internal.receipts.finishFailedRetrySweep, { chapterId });
        return null;
      }
      const exponentialMs = Math.min(
        SWEEP_BACKOFF_CAP_MS,
        SWEEP_BACKOFF_BASE_MS * 2 ** attempt,
      );
      // A provider-declared Retry-After is a FLOOR, never a ceiling — take
      // whichever delay is LONGER so a server-declared cooldown is always
      // respected, but a short/zero Retry-After never shortens our own
      // exponential schedule below its normal step.
      const retryAfterMs =
        outcome.retryAfterSeconds != null ? outcome.retryAfterSeconds * 1000 : 0;
      const delay = Math.min(SWEEP_BACKOFF_CAP_MS, Math.max(exponentialMs, retryAfterMs));
      await ctx.scheduler.runAfter(delay, internal.receipts.runFailedRetrySweep, {
        chapterId,
        model,
        cursor, // unchanged — retry the SAME receipt next time
        attempt: nextAttempt,
        processed,
      });
      return null;
    }

    // Success or a permanent failure — this receipt is done. Advance the
    // watermark past it, reset the backoff counter, and move on at the
    // normal throttled pace.
    await ctx.scheduler.runAfter(THROTTLE_MS, internal.receipts.runFailedRetrySweep, {
      chapterId,
      model,
      cursor: next._creationTime,
      attempt: 0,
      processed: processed + 1,
    });
    return null;
  },
});
