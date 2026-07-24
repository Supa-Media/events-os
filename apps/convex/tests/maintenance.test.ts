/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { newT, run } from "./setup.helpers";
import { internal } from "../_generated/api";

/**
 * TTL sweep for the rate-limit "attempt" tables (#134 reimbursementSubmitAttempts,
 * #161 cardDetailsRevealAttempts, receiptNudgeAttempts) — all three only ever
 * INSERT, so a daily cron (crons.ts) sweeps rows older than each table's own
 * rate window (1 hour for the first two, 24h for receiptNudgeAttempts).
 */
describe("maintenance.sweepRateLimitAttempts", () => {
  test("drops attempt rows older than each table's own window, keeps recent ones, across all three tables", async () => {
    const t = newT();
    const now = Date.now();
    const HOUR = 60 * 60 * 1000;
    const DAY = 24 * HOUR;

    const staleReimbursement = await run(t, (ctx) =>
      ctx.db.insert("reimbursementSubmitAttempts", {
        key: "ip:1.2.3.4",
        createdAt: now - HOUR - 1,
      }),
    );
    const freshReimbursement = await run(t, (ctx) =>
      ctx.db.insert("reimbursementSubmitAttempts", {
        key: "ip:1.2.3.4",
        createdAt: now - 1000,
      }),
    );
    const staleCardReveal = await run(t, (ctx) =>
      ctx.db.insert("cardDetailsRevealAttempts", {
        key: "card:abc",
        createdAt: now - HOUR - 1,
      }),
    );
    const freshCardReveal = await run(t, (ctx) =>
      ctx.db.insert("cardDetailsRevealAttempts", {
        key: "card:abc",
        createdAt: now - 1000,
      }),
    );
    // Older than 1 hour but well inside the 24h nudge window — must survive.
    const freshNudge = await run(t, (ctx) =>
      ctx.db.insert("receiptNudgeAttempts", {
        key: "person:xyz",
        createdAt: now - HOUR - 1,
      }),
    );
    const staleNudge = await run(t, (ctx) =>
      ctx.db.insert("receiptNudgeAttempts", {
        key: "person:xyz",
        createdAt: now - DAY - 1,
      }),
    );

    const result = await t.mutation(internal.maintenance.sweepRateLimitAttempts, {});
    expect(result).toEqual({
      reimbursementAttempts: 1,
      cardRevealAttempts: 1,
      receiptNudgeAttempts: 1,
    });

    const remainingReimbursements = await run(t, (ctx) =>
      ctx.db.query("reimbursementSubmitAttempts").collect(),
    );
    expect(remainingReimbursements.map((r) => r._id)).toEqual([freshReimbursement]);
    expect(remainingReimbursements.map((r) => r._id)).not.toContain(staleReimbursement);

    const remainingCardReveals = await run(t, (ctx) =>
      ctx.db.query("cardDetailsRevealAttempts").collect(),
    );
    expect(remainingCardReveals.map((r) => r._id)).toEqual([freshCardReveal]);
    expect(remainingCardReveals.map((r) => r._id)).not.toContain(staleCardReveal);

    const remainingNudges = await run(t, (ctx) =>
      ctx.db.query("receiptNudgeAttempts").collect(),
    );
    expect(remainingNudges.map((r) => r._id)).toEqual([freshNudge]);
    expect(remainingNudges.map((r) => r._id)).not.toContain(staleNudge);
  });

  test("no-ops cleanly when all tables are empty", async () => {
    const t = newT();
    const result = await t.mutation(internal.maintenance.sweepRateLimitAttempts, {});
    expect(result).toEqual({
      reimbursementAttempts: 0,
      cardRevealAttempts: 0,
      receiptNudgeAttempts: 0,
    });
  });
});
