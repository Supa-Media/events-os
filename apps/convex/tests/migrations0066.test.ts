/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { runRenameReimbursementPayoutRows } from "../migrations/0066_rename_reimbursement_payout_rows";
import type { Id } from "../_generated/dataModel";

/**
 * Migration 0066 — retitle reimbursement payout rows that are still named after
 * the payee instead of what was bought. See the migration's module doc.
 */

async function seedPayout(
  s: ChapterSetup,
  opts: {
    payeeName: string;
    lineDescriptions: string[];
    /** Overrides the auto-generated payee label, i.e. simulates a human edit. */
    merchantName?: string;
  },
): Promise<{ txnId: Id<"transactions">; payeeLabel: string }> {
  const payeeLabel = `Reimbursement to ${opts.payeeName}`;
  return await run(s.t, async (ctx) => {
    const reimbursementId = await ctx.db.insert("reimbursementRequests", {
      chapterId: s.chapterId,
      token: `tok-${opts.payeeName}-${opts.lineDescriptions.length}-${Math.random()}`,
      payeeName: opts.payeeName,
      status: "paid",
      totalCents: 1000 * opts.lineDescriptions.length,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    let order = 0;
    for (const description of opts.lineDescriptions) {
      await ctx.db.insert("reimbursementLineItems", {
        chapterId: s.chapterId,
        reimbursementId,
        description,
        amountCents: 1000,
        transactionDate: Date.now(),
        order,
        createdAt: Date.now(),
      });
      order++;
    }
    const txnId = await ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: "reimbursement",
      reimbursementId,
      flow: "outflow",
      amountCents: 1000 * opts.lineDescriptions.length,
      postedAt: Date.now(),
      status: "categorized",
      merchantName: opts.merchantName ?? payeeLabel,
      description: payeeLabel,
      createdAt: Date.now(),
    });
    return { txnId, payeeLabel };
  });
}

describe("0066_rename_reimbursement_payout_rows", () => {
  test("retitles a payee-labelled row to what was actually bought", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { txnId, payeeLabel } = await seedPayout(s, {
      payeeName: "Adam",
      lineDescriptions: ["Bus ticket", "Parking"],
    });

    const result = await run(s.t, (ctx) => runRenameReimbursementPayoutRows(ctx));
    expect(result.renamed).toBe(1);

    const after = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(after?.merchantName).toBe("Bus ticket + Parking");
    // Who was paid is not lost — it stays as the row's description.
    expect(after?.description).toBe(payeeLabel);
  });

  test("summarizes the tail past two lines", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { txnId } = await seedPayout(s, {
      payeeName: "Adam",
      lineDescriptions: ["Bus ticket", "Parking", "Gas", "Snacks"],
    });

    await run(s.t, (ctx) => runRenameReimbursementPayoutRows(ctx));
    const after = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(after?.merchantName).toBe("Bus ticket + Parking +2 more");
  });

  test("never overwrites a title a human set", async () => {
    // The equality check against the exact auto-generated label is the whole
    // safety argument for this migration.
    const t = newT();
    const s = await setupChapter(t);
    const { txnId } = await seedPayout(s, {
      payeeName: "Adam",
      lineDescriptions: ["Bus ticket", "Parking"],
      merchantName: "Retreat travel (Adam)",
    });

    const result = await run(s.t, (ctx) => runRenameReimbursementPayoutRows(ctx));
    expect(result.renamed).toBe(0);
    expect(result.humanTitled).toBe(1);
    const after = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(after?.merchantName).toBe("Retreat travel (Adam)");
  });

  test("leaves the payee label alone when no line says anything", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { txnId, payeeLabel } = await seedPayout(s, {
      payeeName: "Adam",
      lineDescriptions: ["", "   "],
    });

    const result = await run(s.t, (ctx) => runRenameReimbursementPayoutRows(ctx));
    expect(result.renamed).toBe(0);
    expect(result.noLineText).toBe(1);
    expect((await run(s.t, (ctx) => ctx.db.get(txnId)))?.merchantName).toBe(payeeLabel);
  });

  test("is idempotent — a second run renames nothing", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPayout(s, {
      payeeName: "Adam",
      lineDescriptions: ["Bus ticket", "Parking"],
    });

    expect((await run(s.t, (ctx) => runRenameReimbursementPayoutRows(ctx))).renamed).toBe(1);
    const second = await run(s.t, (ctx) => runRenameReimbursementPayoutRows(ctx));
    expect(second.renamed).toBe(0);
  });
});
