/**
 * 2024 gear split (2026-08-05) — a ONE-TIME ops module that replaces the single
 * lumped `genesis-inkind-exp:gear2024` transaction with the 18 receipt-backed
 * orders it was really made of, and attaches the source receipt documents.
 *
 * WHY: the lump was transcribed from a Notion table — one $3,729.40 outflow dated
 * year-end 2024, no receipt, no per-item dates, note "33 items bought personally".
 * The owner has since located the original Amazon/Sweetwater order confirmations, so
 * the books can now say what actually happened: 18 purchases across Aug–Oct 2024,
 * each a real card charge with a real document behind it. See
 * `lib/seed/historical/gear2024Orders.ts` for the dataset, the per-order granularity
 * decision, and the line-by-line account of the +$717.51 restatement.
 *
 * TWO RUNNERS, both DRY-RUN BY DEFAULT (`execute` omitted / false = a full
 * simulation that writes NOTHING and returns exactly the counts a real run would
 * produce). Pass `execute: true` to commit. They are ORDERED — split first, attach
 * second — because the attach step resolves transactions by the `externalId`s the
 * split creates.
 *
 *   1. `runGear2024Split` — inserts the 18 order transactions, deletes the lump, and
 *      restates the mirrored in-kind gift `genesis:gear2024` to the new total.
 *   2. `attachGear2024Receipts` — takes `{ orderRef, storageId, filename }` triples
 *      (the files are uploaded to Convex storage from outside the deployment by
 *      `scripts/upload-gear2024-receipts.mjs`, which is the only thing that can read
 *      the owner's local screenshots) and creates + links a `receipts` row per order.
 *
 * BOTH LEGS MOVE TOGETHER. The lump was mirrored by an in-kind gift from the owner
 * for the identical amount — that is the whole point of the in-kind pattern (see
 * `genesisInkindExpenses.ts`), so restating one leg without the other would leave the
 * giving ledger claiming a $3,729.40 gift against $4,446.91 of documented expense.
 * `runGear2024Split` patches the gift in the same transaction as the txn writes; it
 * REFUSES to run (`GIFT_NOT_FOUND`) rather than split the expense leg alone.
 *
 * ATTRIBUTION IS INHERITED, NOT RE-DERIVED. The lump had been coded to a fund and a
 * budget after the original backfill. Every split row copies the lump's `fundId`,
 * `budgetId` and `status` verbatim, so budget actuals and the reconcile grid land
 * exactly where they did before — the split changes the GRAIN of the record and its
 * total, never where the money was attributed. (A re-code is a human's call, not a
 * migration's.)
 *
 * IDEMPOTENCY: the split self-dedups on each row's `externalId`
 * (`genesis-inkind-exp:gear2024:<orderRef>`) and treats an already-deleted lump and
 * an already-restated gift as satisfied, so a second run writes nothing. The attach
 * runner no-ops on a receipt whose `storageId` is already linked to its transaction.
 * Re-running either after a partial failure resumes rather than duplicates.
 *
 * SCOPE: the NY chapter, same as every other genesis-era row.
 */
import { internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { NEW_YORK_CHAPTER_SLUG } from "./lib/seed/historical/mapping";
import {
  GEAR_2024_ORDER_ROWS,
  GEAR_2024_TOTAL_CENTS,
} from "./lib/seed/historical/gear2024Orders";
import type { Gear2024OrderRow } from "./lib/seed/historical/types";
import { createReceipt, linkReceiptToTransaction } from "./lib/receiptLinks";
import { editGiftRow } from "./lib/givingDonors";

// ── Constants ────────────────────────────────────────────────────────────────

/** The lump this module replaces, and the giving-side gift that mirrored it. */
const LUMP_EXTERNAL_ID = "genesis-inkind-exp:gear2024";
const GIFT_EXTERNAL_REF = "genesis:gear2024";

/** Every split row's `externalId` is this + the row's `orderRef`. Also the prefix
 *  that identifies our own inserts when scanning the chapter's transactions. */
const SPLIT_REF_PREFIX = `${LUMP_EXTERNAL_ID}:`;

/** Bounded scan of the chapter's transactions — `transactions` has no
 *  `by_externalId` index, so resolving rows by external id means loading the
 *  chapter's rows once through `by_chapter_and_postedAt`. Same ceiling the genesis
 *  backfill and the reconcile grid use. */
const SCAN_LIMIT = 5000;

/** Who personally paid for all 18 orders (every receipt bills the owner). */
const FUNDED_BY = "Oluseyi Olujide";

/** Cap on `items` rendered into the description before it is elided — keeps the
 *  reconcile grid's description column readable on the two 10-item orders. The full
 *  item list always survives in the dataset and on the receipt image itself. */
const MAX_ITEMS_IN_DESCRIPTION = 4;

// ── Helpers ──────────────────────────────────────────────────────────────────

async function resolveNyChapter(ctx: MutationCtx): Promise<Doc<"chapters">> {
  const chapter = await ctx.db
    .query("chapters")
    .withIndex("by_slug", (q) => q.eq("slug", NEW_YORK_CHAPTER_SLUG))
    .first();
  if (!chapter) {
    throw new ConvexError({
      code: "NO_CHAPTER",
      message: `NY chapter (slug "${NEW_YORK_CHAPTER_SLUG}") not found.`,
    });
  }
  return chapter;
}

/** Load the chapter's transactions once, indexed by `externalId`. Rows without one
 *  (hand-entered charges) can't be addressed by this module and are skipped. */
async function loadByExternalId(
  ctx: MutationCtx,
  chapterId: Id<"chapters">,
): Promise<Map<string, Doc<"transactions">>> {
  const rows = await ctx.db
    .query("transactions")
    .withIndex("by_chapter_and_postedAt", (q) => q.eq("chapterId", chapterId))
    .order("desc")
    .take(SCAN_LIMIT);
  const byExternalId = new Map<string, Doc<"transactions">>();
  for (const tr of rows) {
    if (tr.externalId) byExternalId.set(tr.externalId, tr);
  }
  return byExternalId;
}

export function gear2024ExternalId(orderRef: string): string {
  return `${SPLIT_REF_PREFIX}${orderRef}`;
}

/**
 * The transaction description for an order: merchant, order number, and the line
 * items — elided past `MAX_ITEMS_IN_DESCRIPTION` so a 10-item order stays legible in
 * the grid. Exported for the tests, which assert the elision boundary.
 */
export function gear2024Description(row: Gear2024OrderRow): string {
  const shown = row.items.slice(0, MAX_ITEMS_IN_DESCRIPTION);
  const rest = row.items.length - shown.length;
  const itemText = shown.join(", ") + (rest > 0 ? `, +${rest} more` : "");
  return `${row.merchant} order ${row.orderRef} — ${itemText}`;
}

/** The bookkeeper's note: who paid, which gift it mirrors, that it is a split of the
 *  retired lump, plus any per-row caveat from the dataset. */
export function gear2024Note(row: Gear2024OrderRow): string {
  const base =
    `Paid personally by ${FUNDED_BY}; mirrors in-kind gift ${GIFT_EXTERNAL_REF}. ` +
    `Split from the lumped "${LUMP_EXTERNAL_ID}" record (2026-08-05) against the ` +
    `original ${row.merchant} order confirmation. Full items: ${row.items.join(", ")}.`;
  return row.note ? `${base} ${row.note}` : base;
}

// ── Runner 1: the split ──────────────────────────────────────────────────────

const splitCountsValidator = v.object({
  inserted: v.number(),
  alreadyPresent: v.number(),
  lumpDeleted: v.boolean(),
  giftRestated: v.boolean(),
  totalCents: v.number(),
  previousTotalCents: v.number(),
});

/**
 * Replace the lumped 2024 gear transaction with its 18 receipt-backed orders and
 * restate the mirrored in-kind gift to match.
 *
 * `execute` omitted / false = a zero-write dry run reporting the exact counts a real
 * run would produce; `true` commits. Idempotent: re-running after a complete run
 * reports 18 `alreadyPresent`, `lumpDeleted: false`, `giftRestated: false` and
 * writes nothing.
 *
 * `editedBy` is the user the gift restatement is attributed to — `editGiftRow` stamps
 * it as the audit trail for a manual money correction, which is exactly what this is.
 * Required rather than defaulted: a migration should not invent an author for a
 * change to someone's giving record.
 *
 * Throws rather than half-applying when the ledger isn't in the shape this migration
 * was written against: `GIFT_NOT_FOUND` if the mirrored gift is missing (the two legs
 * must move together), and `NO_ATTRIBUTION_SOURCE` if neither the lump nor a prior
 * split row is present to inherit fund/budget coding from.
 */
export const runGear2024Split = internalMutation({
  args: { editedBy: v.id("users"), execute: v.optional(v.boolean()) },
  returns: v.object({
    dryRun: v.boolean(),
    chapterId: v.id("chapters"),
    counts: splitCountsValidator,
  }),
  handler: async (ctx, { editedBy, execute }) => {
    const write = execute ?? false;
    const chapter = await resolveNyChapter(ctx);
    const byExternalId = await loadByExternalId(ctx, chapter._id);

    const lump = byExternalId.get(LUMP_EXTERNAL_ID) ?? null;

    // Attribution to inherit. Normally the lump's; on a resumed run the lump is gone,
    // so fall back to an already-inserted split row (they all carry identical coding).
    const attributionSource =
      lump ??
      GEAR_2024_ORDER_ROWS.map((r) =>
        byExternalId.get(gear2024ExternalId(r.orderRef)),
      ).find((tr): tr is Doc<"transactions"> => tr != null) ??
      null;
    if (!attributionSource) {
      throw new ConvexError({
        code: "NO_ATTRIBUTION_SOURCE",
        message:
          `Neither "${LUMP_EXTERNAL_ID}" nor any split row exists on the NY chapter — ` +
          `nothing to inherit fund/budget coding from. Was the genesis backfill run?`,
      });
    }

    // The gift must exist BEFORE anything is written: the expense and giving legs
    // move together or not at all.
    const gift = await ctx.db
      .query("gifts")
      .withIndex("by_externalRef", (q) => q.eq("externalRef", GIFT_EXTERNAL_REF))
      .first();
    if (!gift) {
      throw new ConvexError({
        code: "GIFT_NOT_FOUND",
        message:
          `Mirrored in-kind gift "${GIFT_EXTERNAL_REF}" not found — refusing to split ` +
          `the expense leg alone (the giving ledger would disagree with finances).`,
      });
    }

    let inserted = 0;
    let alreadyPresent = 0;
    for (const row of GEAR_2024_ORDER_ROWS) {
      const externalId = gear2024ExternalId(row.orderRef);
      if (byExternalId.has(externalId)) {
        alreadyPresent++;
        continue;
      }
      if (write) {
        await ctx.db.insert("transactions", {
          chapterId: chapter._id,
          source: "manual",
          flow: "outflow",
          amountCents: row.amountCents,
          currency: "usd",
          postedAt: row.dateMs,
          description: gear2024Description(row),
          merchantName: row.merchant,
          note: gear2024Note(row),
          status: attributionSource.status,
          ...(attributionSource.fundId ? { fundId: attributionSource.fundId } : {}),
          ...(attributionSource.budgetId
            ? { budgetId: attributionSource.budgetId }
            : {}),
          externalId,
          createdAt: Date.now(),
        });
      }
      inserted++;
    }

    // Retire the lump only once its replacements exist, so no window has the expense
    // recorded nowhere. A dry run reports what it would do without touching it.
    const lumpDeleted = lump != null;
    if (write && lump) await ctx.db.delete(lump._id);

    // Restate the gift through `editGiftRow`, NOT a raw patch: a gift's amount is
    // the head of a chain of derived aggregates — the donor's `lifetimeCents`, the
    // scope rollup, the territory launch-fund pot, an event's `externalGiftsCents`.
    // Only that helper moves all of them by the same delta exactly once; patching
    // `gifts.amountCents` directly would leave every rollup reading the old $3,729.40.
    const giftRestated = gift.amountCents !== GEAR_2024_TOTAL_CENTS;
    if (write && giftRestated) {
      await editGiftRow(ctx, {
        giftId: gift._id,
        amountCents: GEAR_2024_TOTAL_CENTS,
        note:
          `In-kind: 2024 music-ministry gear across ${GEAR_2024_ORDER_ROWS.length} ` +
          `Amazon/Sweetwater orders, Aug–Oct 2024, bought personally. Restated ` +
          `2026-08-05 from $${(gift.amountCents / 100).toFixed(2)} against the original ` +
          `order confirmations (the prior figure came from a Notion transcription that ` +
          `overstated the mixer and omitted several purchases). Each order is recorded ` +
          `and receipted separately on the finance side as "${SPLIT_REF_PREFIX}<order>".`,
        editedBy,
      });
    }

    return {
      dryRun: !write,
      chapterId: chapter._id,
      counts: {
        inserted,
        alreadyPresent,
        lumpDeleted,
        giftRestated,
        totalCents: GEAR_2024_TOTAL_CENTS,
        previousTotalCents: gift.amountCents,
      },
    };
  },
});

// ── Runner 2: receipt attachment ─────────────────────────────────────────────

/**
 * Mint a short-lived storage upload URL for the receipt-upload script.
 *
 * `storage.generateUploadUrl` is auth-gated (a logged-in client's path), and this
 * one-time backfill runs from the CLI with the deployment admin key and no user
 * session — so it needs its own internal door. Internal-only and used by nothing but
 * `scripts/upload-gear2024-receipts.mjs`; delete both once the backfill has run.
 */
export const generateGear2024UploadUrl = internalMutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => await ctx.storage.generateUploadUrl(),
});

/**
 * Create and link a `receipts` row per uploaded order confirmation.
 *
 * The caller uploads each file to Convex storage first (only something outside the
 * deployment can read the owner's local screenshots) and passes the resulting
 * `storageId` back keyed by `orderRef`. Every receipt is created with the ORDER's
 * known total, date and merchant as its `ocr*` provenance — these were read off the
 * document by a human, not a model, so `ocrModel` is recorded as the manual-backfill
 * marker rather than left to imply an extraction ran.
 *
 * `execute` omitted / false = a zero-write dry run. Idempotent: an order whose
 * transaction already carries a linked receipt is reported `alreadyLinked` and
 * skipped, so a resumed run never double-attaches. An `orderRef` with no matching
 * transaction, or one not in the dataset, is reported in `unmatched` rather than
 * throwing — a partial upload should attach what it can.
 */
export const attachGear2024Receipts = internalMutation({
  args: {
    uploads: v.array(
      v.object({
        orderRef: v.string(),
        storageId: v.id("_storage"),
        filename: v.string(),
      }),
    ),
    execute: v.optional(v.boolean()),
  },
  returns: v.object({
    dryRun: v.boolean(),
    attached: v.number(),
    alreadyLinked: v.number(),
    unmatched: v.array(v.string()),
  }),
  handler: async (ctx, { uploads, execute }) => {
    const write = execute ?? false;
    const chapter = await resolveNyChapter(ctx);
    const byExternalId = await loadByExternalId(ctx, chapter._id);
    const rowsByOrderRef = new Map(
      GEAR_2024_ORDER_ROWS.map((r) => [r.orderRef, r] as const),
    );

    let attached = 0;
    let alreadyLinked = 0;
    const unmatched: string[] = [];

    for (const upload of uploads) {
      const row = rowsByOrderRef.get(upload.orderRef);
      const txn = byExternalId.get(gear2024ExternalId(upload.orderRef));
      if (!row || !txn) {
        unmatched.push(upload.orderRef);
        continue;
      }
      // The denorm cache is the cheap "does this txn already have a receipt" read —
      // these transactions are created bare, so a set value means a prior run
      // attached one.
      if (txn.receiptStorageId != null) {
        alreadyLinked++;
        continue;
      }
      if (write) {
        const meta = await ctx.db.system.get(upload.storageId);
        const receiptId = await createReceipt(ctx, {
          chapterId: chapter._id,
          storageId: upload.storageId,
          source: "upload",
          filename: upload.filename,
          ocrAmountCents: row.amountCents,
          ocrDate: row.dateMs,
          ocrMerchant: row.merchant,
          ocrModel: "manual-backfill:gear2024",
          note: `${row.merchant} order ${row.orderRef} confirmation (2024 gear split).`,
          ...(meta?.sha256 ? { fileSha256: meta.sha256 } : {}),
        });
        await linkReceiptToTransaction(ctx, {
          receiptId,
          transactionId: txn._id,
          source: "backfill",
        });
      }
      attached++;
    }

    return { dryRun: !write, attached, alreadyLinked, unmatched };
  },
});
