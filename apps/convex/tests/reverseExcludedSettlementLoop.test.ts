import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { CENTRAL } from "@events-os/shared";
import type { Id } from "../_generated/dataModel";
import { netAfterVoiding } from "../reverseExcludedSettlementLoop";

/**
 * The race guard on the settlement-loop cleanup.
 *
 * The runners themselves address production rows by hard-coded id, so they can't
 * be exercised in a fixture — but their ONE non-obvious precondition can, and it
 * is the precondition that decides whether the cleanup is a correction or a
 * second bug.
 *
 * Everything else the runners check (leg count, amount, `transferOrigin`, no
 * `externalId`) still passes happily AFTER the engine has booked a counter-pair,
 * which is exactly when voiding is wrong: void round three while round four
 * stands and both books move $2,003.95 in the OPPOSITE direction. None of those
 * checks can see a newer `autosettle-` group. `netAfterVoiding` can — it asks
 * the only question that matters, "does voiding this leave the books settled",
 * through the same `chapterInterScopeRows` the engine uses.
 *
 * Delete this file with the module.
 */

/** Real chapter spend coded to a CENTRAL budget — direction (a). */
async function seedCrossBookSpend(
  s: ChapterSetup,
  amountCents: number,
): Promise<void> {
  await run(s.t, async (ctx) => {
    const centralBudgetId = await ctx.db.insert("budgets", {
      chapterId: CENTRAL,
      amountCents: 100_000,
      type: "recurring",
      cadence: "monthly",
      year: 2026,
      approvalStatus: "approved",
      createdAt: Date.now(),
    });
    await ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: "manual",
      flow: "outflow",
      amountCents,
      postedAt: Date.now(),
      status: "categorized",
      budgetId: centralBudgetId,
      createdAt: Date.now(),
    });
  });
}

/** A settling pair at a chosen status, in the shape `recordTransferPair` writes.
 *  Returns both leg ids so a test can hand them to `netAfterVoiding`. */
async function seedSettlingPair(
  s: ChapterSetup,
  args: {
    amountCents: number;
    direction: "central_to_chapter" | "chapter_to_central";
    status: "reconciled" | "excluded";
    transferGroupId: string;
  },
): Promise<Id<"transactions">[]> {
  return run(s.t, async (ctx) => {
    const ids: Id<"transactions">[] = [];
    for (const scope of [CENTRAL, s.chapterId] as const) {
      ids.push(
        await ctx.db.insert("transactions", {
          chapterId: scope,
          source: "transfer",
          flow: "transfer",
          amountCents: args.amountCents,
          postedAt: Date.now(),
          status: args.status,
          transferGroupId: args.transferGroupId,
          transferDirection: args.direction,
          transferOrigin: "auto_settlement",
          createdAt: Date.now(),
        }),
      );
    }
    return ids;
  });
}

/** Production's exact three-round pile: real spend, the honest settlement of it,
 *  the excluded round two, and the live round three this cleanup targets. */
async function seedProductionShape(s: ChapterSetup): Promise<{
  roundThree: Id<"transactions">[];
}> {
  await seedCrossBookSpend(s, 22_453);
  await seedSettlingPair(s, {
    amountCents: 22_453,
    direction: "central_to_chapter",
    status: "reconciled",
    transferGroupId: `autosettle-${s.chapterId}-2026-08-07`,
  });
  await seedSettlingPair(s, {
    amountCents: 200_395,
    direction: "chapter_to_central",
    status: "excluded",
    transferGroupId: `autosettle-${s.chapterId}-2026-08-09`,
  });
  const roundThree = await seedSettlingPair(s, {
    amountCents: 200_395,
    direction: "central_to_chapter",
    status: "reconciled",
    transferGroupId: `autosettle-${s.chapterId}-2026-08-10`,
  });
  return { roundThree };
}

describe("netAfterVoiding — the guard that makes merge order irrelevant", () => {
  test("reads 0 when voiding round three is the whole correction", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { roundThree } = await seedProductionShape(s);

    const net = await run(t, (ctx) =>
      netAfterVoiding(ctx, s.chapterId, new Set(roundThree)),
    );
    expect(net).toBe(0);
  });

  test("reads NONZERO once a later cron has booked round four — the runner must refuse", async () => {
    // THE FAILURE MODE THIS EXISTS FOR. Merge the filter, miss the 09:30 UTC
    // window, and the engine books round four off the now-negative net. Every
    // other precondition still passes on the 08-10 pair — same two legs, same
    // $2,003.95, same origin, still no externalId — so a runner that only
    // checked those would void it and leave round four standing, putting both
    // books $2,003.95 wrong the other way.
    const t = newT();
    const s = await setupChapter(t);
    const { roundThree } = await seedProductionShape(s);

    await seedSettlingPair(s, {
      amountCents: 200_395,
      direction: "chapter_to_central",
      status: "reconciled",
      transferGroupId: `autosettle-${s.chapterId}-2026-08-11`,
    });

    const net = await run(t, (ctx) =>
      netAfterVoiding(ctx, s.chapterId, new Set(roundThree)),
    );
    expect(net).toBe(200_395);
    expect(net).not.toBe(0); // → `problems[]`, nothing written
  });

  test("an already-voided pair still reads 0, so a re-run is safe", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedCrossBookSpend(s, 22_453);
    await seedSettlingPair(s, {
      amountCents: 22_453,
      direction: "central_to_chapter",
      status: "reconciled",
      transferGroupId: `autosettle-${s.chapterId}-2026-08-07`,
    });
    await seedSettlingPair(s, {
      amountCents: 200_395,
      direction: "chapter_to_central",
      status: "excluded",
      transferGroupId: `autosettle-${s.chapterId}-2026-08-09`,
    });
    const roundThree = await seedSettlingPair(s, {
      amountCents: 200_395,
      direction: "central_to_chapter",
      status: "excluded", // already voided by a prior run
      transferGroupId: `autosettle-${s.chapterId}-2026-08-10`,
    });

    const net = await run(t, (ctx) =>
      netAfterVoiding(ctx, s.chapterId, new Set(roundThree)),
    );
    expect(net).toBe(0);
  });
});
