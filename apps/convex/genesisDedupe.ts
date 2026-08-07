/**
 * Genesis duplicate removal runner (2026-08-06) — a ONE-TIME ops module.
 *
 * Applies `lib/seed/historical/genesisDedupe2026.ts`. Read that file's header for the
 * diagnosis (a one-time import racing a live bank feed) and the evidence. This file is
 * only the mechanism.
 *
 * DRY-RUN BY DEFAULT. `execute` omitted / false writes NOTHING and returns exactly the
 * counts a real run would produce.
 *
 * IT VERIFIES BEFORE IT DELETES. Every pair is re-checked against the live rows at run
 * time — both must exist, carry the asserted amount, share a flow, and post within two
 * days of each other. Any pair failing that lands in `skipped` and is left alone. The
 * dataset is a plan, not an authority; a ledger that has moved since the plan was
 * written must not be deleted from on stale facts.
 *
 * RECEIPTS MOVE FIRST. A document attached to a duplicate is re-linked to the surviving
 * twin BEFORE the duplicate is deleted, so no receipt is ever orphaned — and if the run
 * fails midway, the worst state is a receipt on both rows, never on neither.
 *
 * BOTH LEGS TOGETHER. A deletion or amount change that has a mirrored gift moves the
 * gift in the same transaction, through `editGiftRow`/`removeGiftRow` so donor lifetime
 * and scope rollups follow. A missing gift aborts that row rather than half-applying.
 *
 * IDEMPOTENT: an already-deleted duplicate, an already-moved receipt and an
 * already-corrected amount are each counted `alreadyApplied`. A second run writes
 * nothing.
 */
import { internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { NEW_YORK_CHAPTER_SLUG } from "./lib/seed/historical/mapping";
import {
  DEDUPE_PAIRS,
  DEDUPE_DELETIONS,
  DEDUPE_PATCHES,
} from "./lib/seed/historical/genesisDedupe2026";
import { linkReceiptToTransaction, unlinkReceiptFromTransaction } from "./lib/receiptLinks";
import { editGiftRow, removeGiftRow } from "./lib/givingDonors";

const SCAN_LIMIT = 6000;
const DAY = 24 * 60 * 60 * 1000;

/** Load every transaction in the org (both books) indexed by `externalId`. Dedupe
 *  crosses books by design — an import copy on New York shadows a Central charge. */
async function loadAll(ctx: MutationCtx): Promise<Map<string, Doc<"transactions">>> {
  const chapter = await ctx.db
    .query("chapters")
    .withIndex("by_slug", (q) => q.eq("slug", NEW_YORK_CHAPTER_SLUG))
    .first();
  if (!chapter) {
    throw new ConvexError({ code: "NO_CHAPTER", message: "NY chapter not found." });
  }
  const rows = [
    ...(await ctx.db
      .query("transactions")
      .withIndex("by_chapter_and_postedAt", (q) => q.eq("chapterId", chapter._id))
      .take(SCAN_LIMIT)),
    ...(await ctx.db
      .query("transactions")
      .withIndex("by_chapter_and_postedAt", (q) => q.eq("chapterId", "central"))
      .take(SCAN_LIMIT)),
  ];
  const byExternalId = new Map<string, Doc<"transactions">>();
  for (const t of rows) if (t.externalId) byExternalId.set(t.externalId, t);
  return byExternalId;
}

/** Move every receipt on `from` onto `to`. Link first, then unlink, so a failure
 *  between the two leaves the document on both rows rather than on neither. */
async function moveReceipts(
  ctx: MutationCtx,
  from: Doc<"transactions">,
  to: Doc<"transactions">,
  write: boolean,
): Promise<number> {
  const links = await ctx.db
    .query("receiptLinks")
    .withIndex("by_transaction", (q) => q.eq("transactionId", from._id))
    .collect();
  if (!write) return links.length;
  let moved = 0;
  for (const l of links) {
    await linkReceiptToTransaction(ctx, {
      receiptId: l.receiptId,
      transactionId: to._id,
      source: "backfill",
      // The surviving row's status is the bank's own; a receipt arriving via cleanup
      // should not silently promote it to reconciled.
      reconcileIfCategorized: false,
    });
    await unlinkReceiptFromTransaction(ctx, {
      receiptId: l.receiptId,
      transactionId: from._id,
    });
    moved++;
  }
  return moved;
}

const countsValidator = v.object({
  duplicatesDeleted: v.number(),
  receiptsMoved: v.number(),
  rowsRemoved: v.number(),
  giftsRemoved: v.number(),
  amountsCorrected: v.number(),
  alreadyApplied: v.number(),
  centsRecovered: v.number(),
});

/**
 * Remove the duplicated import rows, the two rows the owner retired, and correct the
 * lens rental amount — each with its giving-side leg.
 *
 * `editedBy` attributes the gift edits; required, because a migration should not invent
 * an author for a change to someone's giving record.
 */
export const runGenesisDedupe = internalMutation({
  args: { editedBy: v.id("users"), execute: v.optional(v.boolean()) },
  returns: v.object({
    dryRun: v.boolean(),
    counts: countsValidator,
    skipped: v.array(v.string()),
  }),
  handler: async (ctx, { editedBy, execute }) => {
    const write = execute ?? false;
    const byExternalId = await loadAll(ctx);
    const skipped: string[] = [];
    let duplicatesDeleted = 0, receiptsMoved = 0, rowsRemoved = 0;
    let giftsRemoved = 0, amountsCorrected = 0, alreadyApplied = 0, centsRecovered = 0;

    const giftByRef = async (ref: string) =>
      await ctx.db
        .query("gifts")
        .withIndex("by_externalRef", (q) => q.eq("externalRef", ref))
        .first();

    // ── 1. Duplicate pairs ───────────────────────────────────────────────────
    for (const p of DEDUPE_PAIRS) {
      const dupe = byExternalId.get(p.deleteExternalId);
      const keep = byExternalId.get(p.keepExternalId);
      if (!dupe) { alreadyApplied++; continue; }
      if (!keep) {
        skipped.push(`${p.deleteExternalId}: twin ${p.keepExternalId} not found`);
        continue;
      }
      // Re-verify against the LIVE rows — the dataset is a plan, not an authority.
      if (dupe.amountCents !== p.amountCents || keep.amountCents !== p.amountCents) {
        skipped.push(
          `${p.deleteExternalId}: amount moved (dupe ${dupe.amountCents}, twin ${keep.amountCents}, expected ${p.amountCents})`,
        );
        continue;
      }
      if (dupe.flow !== keep.flow) {
        skipped.push(`${p.deleteExternalId}: flow mismatch (${dupe.flow} vs ${keep.flow})`);
        continue;
      }
      if (Math.abs(dupe.postedAt - keep.postedAt) > 2 * DAY) {
        skipped.push(`${p.deleteExternalId}: twin is more than 2 days away`);
        continue;
      }
      receiptsMoved += await moveReceipts(ctx, dupe, keep, write);
      if (write) await ctx.db.delete(dupe._id);
      duplicatesDeleted++;
      centsRecovered += dupe.flow === "outflow" ? dupe.amountCents : -dupe.amountCents;
    }

    // ── 2. Rows the owner retired, with their gifts ──────────────────────────
    for (const del of DEDUPE_DELETIONS) {
      const txn = byExternalId.get(del.externalId);
      const gift = await giftByRef(del.giftRef);
      if (!txn && !gift) { alreadyApplied++; continue; }
      if (txn && txn.amountCents !== del.amountCents) {
        skipped.push(`${del.externalId}: amount moved (${txn.amountCents} vs ${del.amountCents})`);
        continue;
      }
      if (txn) {
        if (write) await ctx.db.delete(txn._id);
        rowsRemoved++;
        centsRecovered += txn.amountCents;
      }
      if (gift) {
        // Through `removeGiftRow` so donor lifetime, gift count, the scope rollup and
        // any launch-fund pot all reverse — a raw delete would strand every one.
        if (write) await removeGiftRow(ctx, gift._id);
        giftsRemoved++;
      }
    }

    // ── 3. Amount corrections, expense and gift together ─────────────────────
    for (const patch of DEDUPE_PATCHES) {
      const txn = byExternalId.get(patch.externalId);
      if (!txn) { skipped.push(`${patch.externalId}: row not found`); continue; }
      const gift = patch.giftRef ? await giftByRef(patch.giftRef) : null;
      if (patch.giftRef && !gift) {
        skipped.push(`${patch.externalId}: gift ${patch.giftRef} not found — refusing to move one leg alone`);
        continue;
      }
      const txnChanging =
        txn.amountCents !== patch.amountCents ||
        (patch.description != null && txn.description !== patch.description);
      const giftChanging = gift != null && gift.amountCents !== patch.amountCents;
      if (!txnChanging && !giftChanging) { alreadyApplied++; continue; }

      if (write && txnChanging) {
        await ctx.db.patch(txn._id, {
          amountCents: patch.amountCents,
          ...(patch.description != null ? { description: patch.description } : {}),
          note: `${txn.note ?? ""} — corrected 2026-08-06: ${patch.reason}`.trim(),
        });
      }
      if (write && giftChanging && gift) {
        await editGiftRow(ctx, {
          giftId: gift._id,
          amountCents: patch.amountCents,
          editedBy,
        });
      }
      centsRecovered += txn.amountCents - patch.amountCents;
      amountsCorrected++;
    }

    return {
      dryRun: !write,
      counts: {
        duplicatesDeleted, receiptsMoved, rowsRemoved, giftsRemoved,
        amountsCorrected, alreadyApplied, centsRecovered,
      },
      skipped,
    };
  },
});

/** Upload URL for the lens-rental documents. Internal-only; delete with this module. */
export const generateDedupeUploadUrl = internalMutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => await ctx.storage.generateUploadUrl(),
});
