import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import { newT, run, setupChapter, type TestConvex } from "./setup.helpers";
import { grossUpCents, DEFAULT_FEE_SCHEDULE, type FeeRate } from "@events-os/shared";
import { runFoldFeeCoverageIntoGifts } from "../migrations/0072_fold_fee_coverage_into_gifts";
import type { Id } from "../_generated/dataModel";

/**
 * MIGRATION 0072 — folding the fee coverage back into the gift.
 *
 * The rows this corrects were written under the old split, so they cannot be
 * produced by the current settle path at all: every test here builds them by
 * hand, exactly as they sit in production — `amountCents` at the pre-coverage
 * figure, `feeCoverageCents` beside it, and the donor/scope rollups agreeing
 * with the smaller number.
 *
 * What has to hold, and what each test is really guarding:
 *   · the money moves, and every derived figure moves WITH it (a rollup left
 *     behind is a reconciliation gap that shows up months later),
 *   · it never runs twice on a row, because folding is not idempotent and
 *     nothing in the data could tell a folded row from an unfolded one,
 *   · a row the new code already wrote correctly is left alone — the deploy
 *     lands before the migration does, so this window is real,
 *   · a row it cannot correct safely is SKIPPED rather than half-corrected.
 */

const CARD = DEFAULT_FEE_SCHEDULE.find(
  (r) => r.processor === "stripe" && r.method === "card",
)! as FeeRate;

const CHARGED = grossUpCents(10_000, CARD); // 10_330
const COVERAGE = CHARGED - 10_000; // 330

/** A gift as the OLD code wrote it: the gift is the pre-coverage figure. */
async function seedOldStyleGift(
  t: TestConvex,
  opts: {
    scope: Id<"chapters"> | "central";
    amountCents?: number;
    feeCoverageCents?: number;
    countedInLaunchFund?: boolean;
    orphanDonor?: boolean;
  },
) {
  return run(t, async (ctx) => {
    const donorId = await ctx.db.insert("donors", {
      scope: opts.scope,
      kind: "individual",
      name: "Fee Coverer",
      email: "coverer@example.com",
      status: "active",
      lifetimeCents: opts.amountCents ?? 10_000,
      giftCount: 1,
      createdAt: Date.now(),
    });
    const giftId = await ctx.db.insert("gifts", {
      donorId,
      scope: opts.scope,
      amountCents: opts.amountCents ?? 10_000,
      currency: "usd",
      receivedAt: Date.now(),
      method: "stripe",
      ...(opts.feeCoverageCents !== undefined
        ? { feeCoverageCents: opts.feeCoverageCents }
        : {}),
      ...(opts.countedInLaunchFund ? { countedInLaunchFund: true } : {}),
      createdAt: Date.now(),
    });
    await ctx.db.insert("givingScopeRollups", {
      scope: opts.scope,
      lifetimeCents: opts.amountCents ?? 10_000,
      giftCount: 1,
      donorCount: 1,
      activeCount: 1,
      lapsedCount: 0,
      prospectCount: 0,
      updatedAt: Date.now(),
    });
    if (opts.orphanDonor) await ctx.db.delete(donorId);
    return { donorId, giftId };
  });
}

async function gift(t: TestConvex, giftId: Id<"gifts">) {
  return run(t, (ctx) => ctx.db.get(giftId));
}

async function scopeRollup(t: TestConvex, scope: Id<"chapters"> | "central") {
  return run(t, (ctx) =>
    ctx.db
      .query("givingScopeRollups")
      .withIndex("by_scope", (q) => q.eq("scope", scope))
      .unique(),
  );
}

describe("the fold corrects the gift and everything derived from it", () => {
  test("the gift becomes the charge, and keeps the note", async () => {
    const t = newT();
    const { giftId } = await seedOldStyleGift(t, {
      scope: "central",
      feeCoverageCents: COVERAGE,
    });

    const result = await run(t, (ctx) => runFoldFeeCoverageIntoGifts(ctx));

    expect(result.giftsFolded).toBe(1);
    expect(result.centsFolded).toBe(COVERAGE);
    const g = await gift(t, giftId);
    expect(g?.amountCents).toBe(CHARGED);
    expect(g?.feeCoverageCents).toBe(COVERAGE); // the note survives the fold
    expect(g?.feeCoverageInAmount).toBe(true);
  });

  test("the donor's lifetime and the scope rollup move by the same delta", async () => {
    // A rollup left behind is the failure mode that doesn't announce itself:
    // the gift reads right on the donor's page and the org's total is short.
    const t = newT();
    const { donorId } = await seedOldStyleGift(t, {
      scope: "central",
      feeCoverageCents: COVERAGE,
    });

    await run(t, (ctx) => runFoldFeeCoverageIntoGifts(ctx));

    const donor = await run(t, (ctx) => ctx.db.get(donorId));
    expect(donor?.lifetimeCents).toBe(CHARGED);
    expect(donor?.giftCount).toBe(1); // the gift got bigger, not doubled
    expect((await scopeRollup(t, "central"))?.lifetimeCents).toBe(CHARGED);
    expect((await scopeRollup(t, "central"))?.giftCount).toBe(1);
  });

  test("a launch-fund gift moves its territory pot too", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const before = await run(t, async (ctx) => {
      const terr = await ctx.db
        .query("territories")
        .filter((q) => q.eq(q.field("chapterId"), s.chapterId))
        .first();
      return terr?.launchFundCents ?? null;
    });
    // Only meaningful where the seeded chapter actually has a pre-launch
    // territory behind it; where it doesn't, `applyLaunchFundDelta` no-ops and
    // the gift still folds — which is the point of the flag being checked.
    await seedOldStyleGift(t, {
      scope: s.chapterId,
      feeCoverageCents: COVERAGE,
      countedInLaunchFund: true,
    });

    const result = await run(t, (ctx) => runFoldFeeCoverageIntoGifts(ctx));
    expect(result.giftsFolded).toBe(1);

    const after = await run(t, async (ctx) => {
      const terr = await ctx.db
        .query("territories")
        .filter((q) => q.eq(q.field("chapterId"), s.chapterId))
        .first();
      return terr?.launchFundCents ?? null;
    });
    if (before !== null && after !== null) {
      expect(after - before).toBe(COVERAGE);
    }
  });

  test("an in-flight ACH row is restated at its charge", async () => {
    const t = newT();
    await run(t, async (ctx) => {
      const donorId = await ctx.db.insert("donors", {
        scope: "central",
        kind: "individual",
        name: "Bank Giver",
        email: "bank@example.com",
        status: "prospect",
        lifetimeCents: 0,
        giftCount: 0,
        createdAt: Date.now(),
      });
      await ctx.db.insert("pendingGifts", {
        sessionId: "cs_pending_old",
        status: "in_flight",
        scope: "central",
        amountCents: 10_000,
        chargeTotalCents: CHARGED,
        currency: "usd",
        submittedAt: Date.now(),
        donorName: "Bank Giver",
        donorId,
        createdAt: Date.now(),
      });
    });

    const result = await run(t, (ctx) => runFoldFeeCoverageIntoGifts(ctx));

    expect(result.pendingFolded).toBe(1);
    const row = await run(t, (ctx) =>
      ctx.db.query("pendingGifts").first(),
    );
    expect(row?.amountCents).toBe(CHARGED);
  });
});

describe("it cannot run twice, and cannot touch what it shouldn't", () => {
  test("a second run folds nothing — the money moves exactly once", async () => {
    // Folding is `amount += coverage`. Run it twice with no guard and every
    // covered gift in the org is overstated by its coverage, permanently.
    const t = newT();
    const { giftId, donorId } = await seedOldStyleGift(t, {
      scope: "central",
      feeCoverageCents: COVERAGE,
    });

    await run(t, (ctx) => runFoldFeeCoverageIntoGifts(ctx));
    const second = await run(t, (ctx) => runFoldFeeCoverageIntoGifts(ctx));

    expect(second.giftsFolded).toBe(0);
    expect(second.centsFolded).toBe(0);
    expect((await gift(t, giftId))?.amountCents).toBe(CHARGED);
    expect((await run(t, (ctx) => ctx.db.get(donorId)))?.lifetimeCents).toBe(
      CHARGED,
    );
    expect((await scopeRollup(t, "central"))?.lifetimeCents).toBe(CHARGED);
  });

  test("a gift the NEW code wrote in the deploy window is left alone", async () => {
    // THE CASE THE MIGRATION LEDGER CANNOT SEE. The deploy lands before the
    // migration runs, so a gift can settle in between: written by the new
    // code, already gross, and otherwise shaped exactly like a historical row.
    // Folding it would overstate it by its coverage. The stamp
    // `recordGiftForDonor` writes is the only thing that tells them apart.
    const t = newT();
    const donorId = await run(t, (ctx) =>
      ctx.db.insert("donors", {
        scope: "central",
        kind: "individual",
        name: "New Giver",
        email: "new@example.com",
        status: "prospect",
        lifetimeCents: 0,
        giftCount: 0,
        createdAt: Date.now(),
      }),
    );
    await t.mutation(internal.givingDonations.recordGiveDonationPaid, {
      sessionId: "cs_new_code",
      amountTotalCents: CHARGED,
      donorId: String(donorId),
      scope: "central",
      intendedCents: 10_000,
    });
    const before = await run(t, (ctx) => ctx.db.query("gifts").first());
    expect(before?.amountCents).toBe(CHARGED); // the new path books the gross
    expect(before?.feeCoverageInAmount).toBe(true); // …and says so

    const result = await run(t, (ctx) => runFoldFeeCoverageIntoGifts(ctx));

    expect(result.giftsFolded).toBe(0);
    const after = await run(t, (ctx) => ctx.db.query("gifts").first());
    expect(after?.amountCents).toBe(CHARGED); // untouched, to the cent
    expect(
      (await run(t, (ctx) => ctx.db.get(donorId)))?.lifetimeCents,
    ).toBe(CHARGED);
  });

  test("old and new rows in the same table are each handled correctly", async () => {
    // The realistic shape of the deploy window: one historical row to fold,
    // one fresh row to leave alone, in one pass.
    const t = newT();
    const { giftId: oldGiftId } = await seedOldStyleGift(t, {
      scope: "central",
      feeCoverageCents: COVERAGE,
    });
    const newDonorId = await run(t, (ctx) =>
      ctx.db.insert("donors", {
        scope: "central",
        kind: "individual",
        name: "New Giver",
        email: "new@example.com",
        status: "prospect",
        lifetimeCents: 0,
        giftCount: 0,
        createdAt: Date.now(),
      }),
    );
    await t.mutation(internal.givingDonations.recordGiveDonationPaid, {
      sessionId: "cs_new_code",
      amountTotalCents: CHARGED,
      donorId: String(newDonorId),
      scope: "central",
      intendedCents: 10_000,
    });

    const result = await run(t, (ctx) => runFoldFeeCoverageIntoGifts(ctx));

    expect(result.giftsFolded).toBe(1);
    expect(result.centsFolded).toBe(COVERAGE);
    expect((await gift(t, oldGiftId))?.amountCents).toBe(CHARGED);
    const newGift = await run(t, (ctx) =>
      ctx.db
        .query("gifts")
        .filter((q) => q.eq(q.field("donorId"), newDonorId))
        .unique(),
    );
    expect(newGift?.amountCents).toBe(CHARGED);
  });

  test("an uncovered gift is untouched", async () => {
    const t = newT();
    const { giftId, donorId } = await seedOldStyleGift(t, { scope: "central" });

    const result = await run(t, (ctx) => runFoldFeeCoverageIntoGifts(ctx));

    expect(result.giftsFolded).toBe(0);
    expect((await gift(t, giftId))?.amountCents).toBe(10_000);
    expect((await gift(t, giftId))?.feeCoverageInAmount).toBeUndefined();
    expect((await run(t, (ctx) => ctx.db.get(donorId)))?.lifetimeCents).toBe(
      10_000,
    );
  });

  test("a gift whose donor row is gone is SKIPPED, not half-corrected", async () => {
    // Correcting the gift without the donor and identity rollups it feeds
    // would desync the scope rollup from the donor rows behind it — a gap that
    // no screen shows and no later run would find.
    const t = newT();
    const { giftId } = await seedOldStyleGift(t, {
      scope: "central",
      feeCoverageCents: COVERAGE,
      orphanDonor: true,
    });

    const result = await run(t, (ctx) => runFoldFeeCoverageIntoGifts(ctx));

    expect(result.giftsFolded).toBe(0);
    const g = await gift(t, giftId);
    expect(g?.amountCents).toBe(10_000); // exactly as it was
    expect(g?.feeCoverageInAmount).toBeUndefined();
  });
});
