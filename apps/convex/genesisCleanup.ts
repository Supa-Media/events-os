/**
 * Genesis-era ledger cleanup runner (2026-08-06) — a ONE-TIME ops module.
 *
 * Applies `lib/seed/historical/genesisCleanup2026.ts`: the second and final pass over
 * the owner-paid "bought personally" rows, after he went through them with fresh
 * evidence. Read that dataset's header for the reasoning behind every judgement call
 * (the $700, the Uber dates, why the lens rentals are a service). This file is only
 * the mechanism.
 *
 * TWO RUNNERS, both DRY-RUN BY DEFAULT (`execute` omitted / false writes NOTHING and
 * returns exactly the counts a real run would produce):
 *
 *   1. `runGenesisCleanup` — deletes, creates, patches, categorises, and files receipt
 *      exceptions, plus the owner's in-kind gift restatement.
 *   2. `attachCleanupDocuments` — takes `{ key, storageId, filename }` triples from
 *      `scripts/upload-cleanup-docs.mjs` (only something outside the deployment can
 *      read the owner's local folders) and attaches each as a receipt, or as
 *      exception EVIDENCE where the dataset says so.
 *
 * ORDERED: cleanup first, documents second — the attach step resolves rows by the
 * `externalId`s the cleanup creates.
 *
 * IT FILES EXCEPTIONS, IT DOES NOT APPROVE THEM. `receiptExceptions.approve` enforces
 * separation of duties above a threshold, and approving a no-receipt claim is a human
 * judgement about someone's spending. The migration attests; a person decides. They
 * land in the pending queue for the owner to clear in the UI.
 *
 * BOTH LEGS MOVE TOGETHER, as in the gear2024 split: deleting the $700 speakers
 * expense and reducing the owner's in-kind gift by $700 are one transaction. The
 * runner REFUSES to start (`GIFT_NOT_FOUND`) rather than do one without the other.
 * The gift goes through `editGiftRow`, never a raw patch, so the donor lifetime and
 * scope rollups move with it.
 *
 * NAMES ARE RESOLVED, NOT ASSUMED. Budget labels and category names are looked up on
 * the live chapter; anything that fails to resolve is returned in `unresolved` and
 * that single row is skipped. A typo costs one row's coding, never a wrong one.
 *
 * IDEMPOTENCY: new rows self-dedup on `externalId` (`genesis-cleanup:<slug>`); a
 * patch whose values already match is counted `alreadyApplied`; a deletion of a
 * missing row is a no-op; an exception is skipped when the transaction already has a
 * receipt or an open exception. A second run writes nothing.
 */
import { internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { NEW_YORK_CHAPTER_SLUG } from "./lib/seed/historical/mapping";
import {
  CLEANUP_DELETIONS,
  CLEANUP_NEW_TXNS,
  CLEANUP_PATCHES,
  CLEANUP_RECEIPTS_ONLY,
  CLEANUP_CATEGORIES,
  CLEANUP_EXCEPTIONS,
  OWNER_GIFT_REF,
  OWNER_GIFT_REDUCTION_CENTS,
} from "./lib/seed/historical/genesisCleanup2026";
import { createReceipt, linkReceiptToTransaction } from "./lib/receiptLinks";
import { attestException } from "./lib/receiptExceptions";
import { editGiftRow } from "./lib/givingDonors";

const CLEANUP_REF_PREFIX = "genesis-cleanup:";
const SCAN_LIMIT = 5000;
const FUNDED_BY = "Oluseyi Olujide";

export function cleanupExternalId(slug: string): string {
  return `${CLEANUP_REF_PREFIX}${slug}`;
}

// ── Lookup ───────────────────────────────────────────────────────────────────

type Ctxs = {
  chapter: Doc<"chapters">;
  byExternalId: Map<string, Doc<"transactions">>;
  budgetByLabel: Map<string, Id<"budgets">>;
  categoryByName: Map<string, Id<"budgetCategories">>;
  fundId: Id<"funds"> | undefined;
};

async function loadContext(ctx: MutationCtx): Promise<Ctxs> {
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
  const txns = await ctx.db
    .query("transactions")
    .withIndex("by_chapter_and_postedAt", (q) => q.eq("chapterId", chapter._id))
    .order("desc")
    .take(SCAN_LIMIT);
  const byExternalId = new Map<string, Doc<"transactions">>();
  for (const t of txns) if (t.externalId) byExternalId.set(t.externalId, t);

  const budgets = await ctx.db
    .query("budgets")
    .withIndex("by_chapter", (q) => q.eq("chapterId", chapter._id))
    .collect();
  // Labels are not unique across years (three budgets are literally named "Worship
  // With Strangers"). Keep the FIRST match by label, which is stable for the six
  // distinct labels this dataset actually names — all of which are unique.
  const budgetByLabel = new Map<string, Id<"budgets">>();
  for (const b of budgets) {
    if (b.label && !budgetByLabel.has(b.label)) budgetByLabel.set(b.label, b._id);
  }

  const cats = await ctx.db
    .query("budgetCategories")
    .withIndex("by_chapter", (q) => q.eq("chapterId", chapter._id))
    .collect();
  const categoryByName = new Map<string, Id<"budgetCategories">>();
  for (const c of cats) if (!categoryByName.has(c.name)) categoryByName.set(c.name, c._id);

  // Every genesis row carries the chapter's single fund; inherit it for new rows.
  const anyGenesis = txns.find((t) => t.externalId?.startsWith("genesis-") && t.fundId);
  return {
    chapter,
    byExternalId,
    budgetByLabel,
    categoryByName,
    fundId: anyGenesis?.fundId,
  };
}

// ── Runner 1: the cleanup ────────────────────────────────────────────────────

const countsValidator = v.object({
  deleted: v.number(),
  created: v.number(),
  patched: v.number(),
  merged: v.number(),
  categorised: v.number(),
  exceptionsFiled: v.number(),
  alreadyApplied: v.number(),
  giftReducedCents: v.number(),
  netChangeCents: v.number(),
});

/**
 * Apply the whole cleanup. `execute` omitted / false = a zero-write dry run.
 * `editedBy` attributes the gift restatement — required, because a migration should
 * not invent an author for a change to someone's giving record.
 */
export const runGenesisCleanup = internalMutation({
  args: { editedBy: v.id("users"), execute: v.optional(v.boolean()) },
  returns: v.object({
    dryRun: v.boolean(),
    counts: countsValidator,
    unresolved: v.array(v.string()),
  }),
  handler: async (ctx, { editedBy, execute }) => {
    const write = execute ?? false;
    const c = await loadContext(ctx);
    const unresolved: string[] = [];
    let deleted = 0, created = 0, patched = 0, merged = 0;
    let categorised = 0, exceptionsFiled = 0, alreadyApplied = 0;
    let netChangeCents = 0;

    // The gift must exist before anything is written — both legs move or neither.
    const gift = await ctx.db
      .query("gifts")
      .withIndex("by_externalRef", (q) => q.eq("externalRef", OWNER_GIFT_REF))
      .first();
    if (!gift) {
      throw new ConvexError({
        code: "GIFT_NOT_FOUND",
        message:
          `Owner in-kind gift "${OWNER_GIFT_REF}" not found — refusing to delete the ` +
          `$700 expense without reducing the gift it double-counts.`,
      });
    }

    // ── 1. Deletions ──────────────────────────────────────────────────────────
    for (const del of CLEANUP_DELETIONS) {
      const txn = c.byExternalId.get(del.externalId);
      if (!txn) { alreadyApplied++; continue; }
      if (write) await ctx.db.delete(txn._id);
      netChangeCents -= txn.amountCents;
      deleted++;
    }

    // ── 2. The owner's in-kind restatement ───────────────────────────────────
    const targetGiftCents = Math.max(0, gift.amountCents - OWNER_GIFT_REDUCTION_CENTS);
    const giftNeedsReduction =
      deleted > 0 && gift.amountCents !== targetGiftCents;
    if (write && giftNeedsReduction) {
      await editGiftRow(ctx, {
        giftId: gift._id,
        amountCents: targetGiftCents,
        note:
          `${gift.note ?? ""} Reduced 2026-08-06 by $${(OWNER_GIFT_REDUCTION_CENTS / 100).toFixed(2)}: ` +
          `Layomi's Nov-2024 $700 toward speakers reimbursed part of this gear, so that ` +
          `$700 is her giving, not the owner's — it was previously counted as both.`.trim(),
        editedBy,
      });
    }

    // ── 3. New transactions ──────────────────────────────────────────────────
    for (const row of CLEANUP_NEW_TXNS) {
      const externalId = cleanupExternalId(row.slug);
      if (c.byExternalId.has(externalId)) { alreadyApplied++; continue; }
      const budgetId = c.budgetByLabel.get(row.budgetLabel);
      const categoryId = c.categoryByName.get(row.categoryName);
      if (!budgetId || !categoryId) {
        unresolved.push(
          `${row.slug}: ${!budgetId ? `budget "${row.budgetLabel}"` : `category "${row.categoryName}"`}`,
        );
        continue;
      }
      if (write) {
        await ctx.db.insert("transactions", {
          chapterId: c.chapter._id,
          source: "manual",
          flow: "outflow",
          amountCents: row.amountCents,
          currency: "usd",
          postedAt: row.dateMs,
          description: row.description,
          merchantName: row.merchant,
          note:
            `Paid personally by ${FUNDED_BY}; mirrors in-kind gift ${OWNER_GIFT_REF}. ` +
            `Recovered 2026-08-06 from the original ${row.merchant} record — this purchase ` +
            `never reached the Notion table or the ledger.`,
          status: "categorized",
          budgetId,
          categoryId,
          ...(c.fundId ? { fundId: c.fundId } : {}),
          externalId,
          createdAt: Date.now(),
        });
      }
      netChangeCents += row.amountCents;
      created++;
    }

    // ── 4. Patches ───────────────────────────────────────────────────────────
    for (const p of CLEANUP_PATCHES) {
      const txn = c.byExternalId.get(p.externalId);
      if (!txn) { unresolved.push(`${p.externalId}: row not found`); continue; }

      const budgetId = p.budgetLabel ? c.budgetByLabel.get(p.budgetLabel) : undefined;
      if (p.budgetLabel && !budgetId) {
        unresolved.push(`${p.externalId}: budget "${p.budgetLabel}"`);
        continue;
      }

      // Absorbed rows are removed whether or not the patch itself is a no-op, so a
      // resumed run still finishes the merge.
      let absorbed = 0;
      for (const mergeId of p.mergeExternalIds ?? []) {
        const victim = c.byExternalId.get(mergeId);
        if (!victim) continue;
        if (write) await ctx.db.delete(victim._id);
        netChangeCents -= victim.amountCents;
        absorbed++;
      }
      merged += absorbed;

      const changing =
        (p.amountCents != null && p.amountCents !== txn.amountCents) ||
        (p.dateMs != null && p.dateMs !== txn.postedAt) ||
        (budgetId != null && budgetId !== txn.budgetId) ||
        (p.description != null && p.description !== txn.description);
      if (!changing) { if (!absorbed) alreadyApplied++; continue; }

      if (p.amountCents != null) netChangeCents += p.amountCents - txn.amountCents;
      if (write) {
        await ctx.db.patch(txn._id, {
          ...(p.amountCents != null ? { amountCents: p.amountCents } : {}),
          ...(p.dateMs != null ? { postedAt: p.dateMs } : {}),
          ...(budgetId != null ? { budgetId } : {}),
          ...(p.description != null ? { description: p.description } : {}),
          note: `${txn.note ?? ""} — corrected 2026-08-06: ${p.reason}`.trim(),
        });
      }
      patched++;
    }

    // ── 5. Categories ────────────────────────────────────────────────────────
    for (const cat of CLEANUP_CATEGORIES) {
      const txn = c.byExternalId.get(cat.externalId);
      if (!txn) { unresolved.push(`${cat.externalId}: row not found`); continue; }
      const categoryId = c.categoryByName.get(cat.categoryName);
      if (!categoryId) {
        unresolved.push(`${cat.externalId}: category "${cat.categoryName}"`);
        continue;
      }
      if (txn.categoryId === categoryId) { alreadyApplied++; continue; }
      if (write) await ctx.db.patch(txn._id, { categoryId });
      categorised++;
    }

    // ── 6. Receipt exceptions (FILED, not approved — see this file's header) ──
    for (const ex of CLEANUP_EXCEPTIONS) {
      const txn = c.byExternalId.get(ex.externalId);
      if (!txn) { unresolved.push(`${ex.externalId}: row not found`); continue; }
      // `attestException` throws on a row that already has a receipt or an open
      // exception; both mean the work is done, so check first rather than catch.
      if (txn.receiptStorageId != null) { alreadyApplied++; continue; }
      const open = await ctx.db
        .query("receiptExceptions")
        .withIndex("by_transaction", (q) => q.eq("transactionId", txn._id))
        .collect();
      if (open.some((e) => e.status === "pending" || e.status === "approved")) {
        alreadyApplied++;
        continue;
      }
      // Evidence files are attached by `attachCleanupDocuments`, which runs after the
      // uploads exist; the exception is filed here with its note alone.
      if (write) {
        await attestException(ctx, {
          txn,
          scope: c.chapter._id,
          reason: ex.reason,
          note: ex.note,
          attestedByPersonId: null,
          attestedByUserId: editedBy,
        });
      }
      exceptionsFiled++;
    }

    return {
      dryRun: !write,
      counts: {
        deleted, created, patched, merged, categorised, exceptionsFiled,
        alreadyApplied,
        giftReducedCents: giftNeedsReduction ? OWNER_GIFT_REDUCTION_CENTS : 0,
        netChangeCents,
      },
      unresolved,
    };
  },
});

// ── Runner 2: documents ──────────────────────────────────────────────────────

/** Upload URL for the document script — `storage.generateUploadUrl` is auth-gated and
 *  this runs from the CLI with the deployment admin key and no user session. */
export const generateCleanupUploadUrl = internalMutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => await ctx.storage.generateUploadUrl(),
});

/**
 * Attach each uploaded document. `key` is the row's `externalId` for an existing row,
 * or `genesis-cleanup:<slug>` for one this cleanup created.
 *
 * A file whose key matches a `CLEANUP_EXCEPTIONS` entry with an `evidenceFile` is
 * attached as exception EVIDENCE, never as a receipt — an Apple Cash screenshot
 * proves what was paid to whom, not what was bought, and the ledger keeps that
 * distinction visible.
 */
export const attachCleanupDocuments = internalMutation({
  args: {
    uploads: v.array(
      v.object({
        key: v.string(),
        storageId: v.id("_storage"),
        filename: v.string(),
      }),
    ),
    execute: v.optional(v.boolean()),
  },
  returns: v.object({
    dryRun: v.boolean(),
    receiptsAttached: v.number(),
    evidenceAttached: v.number(),
    alreadyPresent: v.number(),
    unmatched: v.array(v.string()),
  }),
  handler: async (ctx, { uploads, execute }) => {
    const write = execute ?? false;
    const c = await loadContext(ctx);
    const evidenceKeys = new Set(
      CLEANUP_EXCEPTIONS.filter((e) => e.evidenceFile).map((e) => e.externalId),
    );

    let receiptsAttached = 0, evidenceAttached = 0, alreadyPresent = 0;
    const unmatched: string[] = [];

    for (const up of uploads) {
      const txn = c.byExternalId.get(up.key);
      if (!txn) { unmatched.push(up.key); continue; }

      if (evidenceKeys.has(up.key)) {
        const ex = await ctx.db
          .query("receiptExceptions")
          .withIndex("by_transaction", (q) => q.eq("transactionId", txn._id))
          .collect();
        const target = ex.find((e) => e.status === "pending" || e.status === "approved");
        if (!target) { unmatched.push(`${up.key} (no exception to attach evidence to)`); continue; }
        if ((target.evidenceStorageIds?.length ?? 0) > 0) { alreadyPresent++; continue; }
        if (write) {
          await ctx.db.patch(target._id, { evidenceStorageIds: [up.storageId] });
        }
        evidenceAttached++;
        continue;
      }

      if (txn.receiptStorageId != null) { alreadyPresent++; continue; }
      if (write) {
        const meta = await ctx.db.system.get(up.storageId);
        const receiptId = await createReceipt(ctx, {
          chapterId: c.chapter._id,
          storageId: up.storageId,
          source: "upload",
          filename: up.filename,
          ocrAmountCents: txn.amountCents,
          ocrDate: txn.postedAt,
          ...(txn.merchantName ? { ocrMerchant: txn.merchantName } : {}),
          ocrModel: "manual-backfill:genesis-cleanup-2026",
          note: `Source document for "${txn.description ?? up.key}" (genesis cleanup).`,
          ...(meta?.sha256 ? { fileSha256: meta.sha256 } : {}),
        });
        await linkReceiptToTransaction(ctx, {
          receiptId,
          transactionId: txn._id,
          source: "backfill",
        });
      }
      receiptsAttached++;
    }

    return { dryRun: !write, receiptsAttached, evidenceAttached, alreadyPresent, unmatched };
  },
});
