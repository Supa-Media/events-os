/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";
import { runReimbursementPayoutsOutflowPage } from "../migrations/0044_reimbursement_payouts_outflow";

/**
 * Migration 0044 — reimbursement payouts become spend: every historical
 * `source:"reimbursement"` payout row flips from `flow:"transfer"` (excluded
 * from every budget/category total by `countsAsSpend`) to `flow:"outflow"`.
 *
 * The guards that matter: only reimbursement-sourced rows move, rows already
 * at `outflow` are skipped (so a re-run is a no-op), a hand-corrected
 * non-transfer flow is left alone, and genuine transfers — skim / launch
 * grant / settlement legs, personal-charge repayment credits — are never
 * touched, because those DO have a matching leg already in the ledger.
 */

async function seedReimbursementWithPayout(
  s: ChapterSetup,
  opts: { amountCents: number; flow: "transfer" | "outflow" | "inflow"; source?: string },
): Promise<{ reimbursementId: Id<"reimbursementRequests">; txnId: Id<"transactions"> }> {
  const now = Date.now();
  const reimbursementId = await run(s.t, (ctx) =>
    ctx.db.insert("reimbursementRequests", {
      chapterId: s.chapterId,
      token: crypto.randomUUID(),
      status: "paid",
      payeeName: "Sarah",
      payeeEmail: "sarah@example.com",
      totalCents: opts.amountCents,
      approvedCents: opts.amountCents,
      submittedAt: now,
      approvedAt: now,
      paidAt: now,
      createdAt: now,
      updatedAt: now,
    }),
  );
  const txnId = await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: (opts.source ?? "reimbursement") as "reimbursement",
      flow: opts.flow,
      amountCents: opts.amountCents,
      currency: "usd",
      postedAt: now,
      reimbursementId,
      status: "reconciled",
      createdAt: now,
    }),
  );
  return { reimbursementId, txnId };
}

async function flowOf(s: ChapterSetup, txnId: Id<"transactions">): Promise<string | undefined> {
  return (await run(s.t, (ctx) => ctx.db.get(txnId)))?.flow;
}

describe("0044 — reimbursement payouts flip to outflow", () => {
  test("flips transfer payouts, skips ones already outflow, leaves other flows and other sources alone", async () => {
    const t = newT();
    const s = await setupChapter(t);

    const stale = await seedReimbursementWithPayout(s, { amountCents: 30_386, flow: "transfer" });
    const already = await seedReimbursementWithPayout(s, { amountCents: 1_200, flow: "outflow" });
    // Someone corrected this one by hand to an inflow (a refund) — not ours to
    // re-interpret.
    const handFixed = await seedReimbursementWithPayout(s, { amountCents: 900, flow: "inflow" });
    // A row keyed to a reimbursement but written by something else — the
    // `source` guard mirrors `reimbursementBackfill.ts`.
    const foreign = await seedReimbursementWithPayout(s, {
      amountCents: 4_000,
      flow: "transfer",
      source: "manual",
    });

    const result = await run(s.t, (ctx) => runReimbursementPayoutsOutflowPage(ctx, null));

    expect(result.flipped).toBe(1);
    expect(result.skippedAlready).toBe(1);
    expect(result.skippedOther).toBe(1);
    expect(result.scanned).toBe(3); // the `manual`-sourced row isn't scanned
    expect(result.isDone).toBe(true);

    expect(await flowOf(s, stale.txnId)).toBe("outflow");
    expect(await flowOf(s, already.txnId)).toBe("outflow");
    expect(await flowOf(s, handFixed.txnId)).toBe("inflow");
    expect(await flowOf(s, foreign.txnId)).toBe("transfer");
  });

  test("re-running patches nothing (idempotent)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { txnId } = await seedReimbursementWithPayout(s, {
      amountCents: 30_386,
      flow: "transfer",
    });

    const first = await run(s.t, (ctx) => runReimbursementPayoutsOutflowPage(ctx, null));
    expect(first.flipped).toBe(1);

    const second = await run(s.t, (ctx) => runReimbursementPayoutsOutflowPage(ctx, null));
    expect(second.flipped).toBe(0);
    expect(second.skippedAlready).toBe(1);
    expect(await flowOf(s, txnId)).toBe("outflow");
  });

  test("a skim/settlement transfer leg is never touched (no reimbursement link)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const now = Date.now();
    const legId = await run(s.t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: s.chapterId,
        source: "skim",
        flow: "transfer",
        amountCents: 37_500,
        currency: "usd",
        postedAt: now,
        transferGroupId: "skim-test-2026-07",
        status: "reconciled",
        createdAt: now,
      }),
    );

    const result = await run(s.t, (ctx) => runReimbursementPayoutsOutflowPage(ctx, null));
    expect(result.flipped).toBe(0);
    expect(await flowOf(s, legId)).toBe("transfer");
  });

  test("paginates across pages, draining every payout", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const seeded = [];
    for (let i = 0; i < 5; i++) {
      seeded.push(await seedReimbursementWithPayout(s, { amountCents: 100 + i, flow: "transfer" }));
    }

    let cursor: string | null = null;
    let flipped = 0;
    // Drain by hand (the scheduled continuation is exercised in prod, not
    // here) — page size 2 forces three passes.
    for (let guard = 0; guard < 10; guard++) {
      const page = await run(s.t, (ctx) => runReimbursementPayoutsOutflowPage(ctx, cursor, 2));
      flipped += page.flipped;
      if (page.isDone) break;
      cursor = page.continueCursor;
    }

    expect(flipped).toBe(5);
    for (const row of seeded) {
      expect(await flowOf(s, row.txnId)).toBe("outflow");
    }
  });
});
