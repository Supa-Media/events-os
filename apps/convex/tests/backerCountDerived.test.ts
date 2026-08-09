import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { runSeedSeatDefs } from "../migrations/0022_seed_seat_defs";
import type { Id } from "../_generated/dataModel";

/**
 * `chapters.backerCount` is DERIVED — one writer, no exceptions.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 * New York's stored count read 2 while its real count was 0, for three weeks,
 * on a public page that told readers a city was funded. It took two faults:
 * a second writer (`finances.setBackerCount`, hand-set 2 on 2026-07-17, now
 * deleted) and a set of pledge paths that INSERT without recomputing (the
 * Givebutter import landed 3 `past_due` pledges on 2026-07-19 and never
 * triggered a recount). Because none of New York's pledges ever underwent a
 * status TRANSITION, the derive had literally never run for that chapter.
 *
 * So this file walks every way a pledge can move and asserts the stored number
 * moves with it. The `past_due` fall is the one production never exercised and
 * is the heart of the bug.
 *
 * ── ALREADY COVERED ELSEWHERE (not re-litigated here) ───────────────────────
 *  - `territories.test.ts` — a prospect territory's SHADOW chapter counts a
 *    $50 activation, ignores a $20 one, and decrements on cancel.
 *  - `givingPledges.test.ts` — the same $50/$20/cancel/past_due walk on a live
 *    chapter, plus the out-of-order `invoice.paid` recovery counting a backer.
 * This file adds the transitions neither of those exercises, and the two INSERT
 * paths (canonical import, historical backfill) that had no recompute at all.
 */

const NY_SLUG = "new-york";

/** Link a `people` row to the caller's user + seat them, so their seat-derived
 *  giving capability resolves. Requires seeded seatDefs (house convention,
 *  copied from `givingPledges.test.ts`). */
async function seatCaller(
  s: ChapterSetup,
  slug: string,
  scope: Id<"chapters"> | "central",
): Promise<void> {
  await run(s.t, async (ctx) => {
    const personId = await ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Seated Caller",
      userId: s.userId,
      createdAt: Date.now(),
    });
    const def = await ctx.db
      .query("seatDefs")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique();
    if (!def) throw new Error(`${slug} not seeded`);
    await ctx.db.insert("seatAssignments", {
      seatDefId: def._id,
      scope,
      personId,
      createdAt: Date.now(),
    });
  });
}

/** A chapter whose caller is a development director at central (giving.manage
 *  over every scope) — needed for the desk mutations and the import. */
async function devDirectorSetup(): Promise<ChapterSetup> {
  const t = newT();
  await run(t, (ctx) => runSeedSeatDefs(ctx));
  const s = await setupChapter(t);
  await seatCaller(s, "development_director", "central");
  return s;
}

/** Prepare a pledge and activate it, as `checkout.session.completed` does. */
async function prepareAndActivate(
  s: ChapterSetup,
  amountCents: number,
  subscriptionId: string,
  email: string,
): Promise<Id<"pledges">> {
  const prepared = await s.t.mutation(internal.givingPledges.preparePledge, {
    chapterId: s.chapterId,
    amountCents,
    name: "Backer " + subscriptionId,
    email,
  });
  await s.t.mutation(internal.givingPledges.activatePledgeFromCheckout, {
    pledgeId: String(prepared.pledgeId),
    stripeCustomerId: "cus_" + subscriptionId,
    stripeSubscriptionId: subscriptionId,
  });
  return prepared.pledgeId as Id<"pledges">;
}

async function backerCount(s: ChapterSetup): Promise<number> {
  const chapter = await run(s.t, (ctx) => ctx.db.get(s.chapterId));
  return chapter?.backerCount ?? 0;
}

/** Plant the exact New York fault: a stored count nobody derived. */
async function plantStaleCount(
  s: ChapterSetup,
  stored: number,
): Promise<void> {
  await run(s.t, (ctx) =>
    ctx.db.patch(s.chapterId, {
      backerCount: stored,
      backerCountUpdatedAt: Date.now(),
      backerCountUpdatedBy: s.userId,
    }),
  );
}

// ── Stripe-driven transitions ────────────────────────────────────────────────

describe("derived backerCount — billing transitions", () => {
  test("a failed payment (past_due) DROPS the count; this is the transition production never ran", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await prepareAndActivate(s, 5000, "sub_fail", "fail@example.com");
    expect(await backerCount(s)).toBe(1);

    await t.mutation(internal.givingPledges.markPledgePastDue, {
      subscriptionId: "sub_fail",
    });
    // No money is arriving, so the public "N backers" promise must shrink.
    expect(await backerCount(s)).toBe(0);
  });

  test("invoice.paid recovering a past_due pledge RAISES the count again", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await prepareAndActivate(s, 5000, "sub_recover", "rec@example.com");
    await t.mutation(internal.givingPledges.markPledgePastDue, {
      subscriptionId: "sub_recover",
    });
    expect(await backerCount(s)).toBe(0);

    await t.mutation(internal.givingPledges.recordPledgeInvoice, {
      subscriptionId: "sub_recover",
      invoiceId: "in_recover",
      amountPaidCents: 5000,
    });
    expect(await backerCount(s)).toBe(1);
  });

  test("an amount change across the $50 unit moves the count in BOTH directions", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await prepareAndActivate(s, 5000, "sub_amt", "amt@example.com");
    expect(await backerCount(s)).toBe(1);

    // Downgrade to $20: still an active, valued recurring gift — just not a
    // backer, because the tiers price a backer at exactly one $50 unit.
    await t.mutation(internal.givingPledges.syncPledgeSubscription, {
      subscriptionId: "sub_amt",
      stripeStatus: "active",
      amountCents: 2000,
    });
    expect(await backerCount(s)).toBe(0);

    // Back up over the unit.
    await t.mutation(internal.givingPledges.syncPledgeSubscription, {
      subscriptionId: "sub_amt",
      stripeStatus: "active",
      amountCents: 5000,
    });
    expect(await backerCount(s)).toBe(1);
  });

  test("a canceled subscription drops the count", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await prepareAndActivate(s, 5000, "sub_cancel", "can@example.com");
    expect(await backerCount(s)).toBe(1);

    await t.mutation(internal.givingPledges.cancelPledgeSubscription, {
      subscriptionId: "sub_cancel",
    });
    expect(await backerCount(s)).toBe(0);
  });
});

// ── Desk transitions ─────────────────────────────────────────────────────────

describe("derived backerCount — desk transitions", () => {
  test("a manual pause drops the count; resuming restores it", async () => {
    const s = await devDirectorSetup();
    const pledgeId = await prepareAndActivate(
      s,
      5000,
      "sub_pause",
      "pause@example.com",
    );
    expect(await backerCount(s)).toBe(1);

    await s.as.mutation(api.givingPledges.setPledgeStatus, {
      pledgeId,
      status: "paused",
      why: "Taking a break",
    });
    expect(await backerCount(s)).toBe(0);

    await s.as.mutation(api.givingPledges.setPledgeStatus, {
      pledgeId,
      status: "active",
    });
    expect(await backerCount(s)).toBe(1);
  });

  test("deleting a pledge drops the count", async () => {
    const s = await devDirectorSetup();
    const pledgeId = await prepareAndActivate(
      s,
      5000,
      "sub_delete",
      "del@example.com",
    );
    await prepareAndActivate(s, 5000, "sub_keep", "keep@example.com");
    expect(await backerCount(s)).toBe(2);

    await s.as.mutation(api.givingPledges.deletePledge, {
      pledgeId,
      why: "Duplicate row from the cutover",
    });
    expect(await backerCount(s)).toBe(1);
  });

  test("merging donors re-derives the count for the scope whose pledges moved", async () => {
    const s = await devDirectorSetup();
    await prepareAndActivate(s, 5000, "sub_merge_a", "merge-a@example.com");
    await prepareAndActivate(s, 5000, "sub_merge_b", "merge-b@example.com");
    expect(await backerCount(s)).toBe(2);

    const donors = await run(s.t, (ctx) =>
      ctx.db
        .query("donors")
        .withIndex("by_scope", (q) => q.eq("scope", s.chapterId))
        .collect(),
    );
    expect(donors).toHaveLength(2);
    // The merge only re-points `donorId`; the two pledges stay active and in
    // scope, so the honest count is still 2 — the point is that the merge
    // RECOMPUTES rather than leaving whatever was stored.
    await plantStaleCount(s, 9);
    await s.as.mutation(api.dataHygiene.mergeDonors, {
      scope: s.chapterId,
      survivorId: donors[0]._id,
      duplicateId: donors[1]._id,
    });
    expect(await backerCount(s)).toBe(2);
  });
});

// ── Insert paths (the gap that let New York drift) ───────────────────────────

describe("derived backerCount — import paths recompute", () => {
  test("the canonical import corrects a chapter whose stored count is stale (the New York scenario)", async () => {
    const s = await devDirectorSetup();
    // Exactly the production shape: a hand-set 2 with an "edited by" stamp, and
    // no pledge on the chapter that anyone ever derived from.
    await plantStaleCount(s, 2);

    const committed = await s.as.mutation(api.givingImport.importCanonical, {
      scope: s.chapterId,
      rows: [
        {
          rowType: "recurring" as const,
          name: "Imported Backer",
          email: "imported@example.com",
          recurringMonthlyCents: 5000,
          externalRef: "gb_rec_ny_1",
        },
      ],
    });
    expect(committed.imported.pledges).toBe(1);

    const pledges = await run(s.t, (ctx) =>
      ctx.db
        .query("pledges")
        .withIndex("by_scope_and_status", (q) => q.eq("scope", s.chapterId))
        .collect(),
    );
    // An imported recurrence lands `past_due` — its card can't be ported, so no
    // money is arriving and it is NOT a backer yet.
    expect(pledges).toHaveLength(1);
    expect(pledges[0]).toMatchObject({ status: "past_due", origin: "imported" });
    expect(await backerCount(s)).toBe(0);

    // The stale hand-set attribution does not survive a recompute.
    const chapter = await run(s.t, (ctx) => ctx.db.get(s.chapterId));
    expect(chapter?.backerCountUpdatedBy).toBeUndefined();
  });

  test("the canonical import leaves a genuinely-earned count alone", async () => {
    const s = await devDirectorSetup();
    await prepareAndActivate(s, 5000, "sub_real", "real@example.com");
    expect(await backerCount(s)).toBe(1);

    await s.as.mutation(api.givingImport.importCanonical, {
      scope: s.chapterId,
      rows: [
        {
          rowType: "recurring" as const,
          name: "Imported Backer",
          email: "imported2@example.com",
          recurringMonthlyCents: 5000,
          externalRef: "gb_rec_ny_2",
        },
      ],
    });
    // One real active backer + one past_due import = still exactly one backer.
    expect(await backerCount(s)).toBe(1);
  });

  test("the historical backfill re-derives New York's count after loading its past_due recurrences", async () => {
    const t = newT();
    const { chapterId } = await run(t, async (ctx) => {
      await ctx.db.insert("users", { email: "leader@publicworship.life" });
      const chapterId = await ctx.db.insert("chapters", {
        name: "New York",
        slug: NY_SLUG,
        isActive: true,
        // The number that was actually sitting in production.
        backerCount: 2,
        backerCountUpdatedAt: Date.now(),
        createdAt: Date.now(),
      });
      return { chapterId };
    });

    let offset: number | null = 0;
    let pledges = 0;
    while (offset !== null) {
      const res: { nextOffset: number | null; counts: { pledges: number } } =
        await t.mutation(internal.historicalBackfill.runGivingBackfill, {
          offset,
          execute: true,
        });
      pledges += res.counts.pledges;
      offset = res.nextOffset;
    }
    // The curated dataset carries the three Givebutter recurrences.
    expect(pledges).toBe(3);

    const chapter = await run(t, (ctx) => ctx.db.get(chapterId));
    expect(chapter?.backerCount).toBe(0);
  });
});

// ── The standing repair tool ─────────────────────────────────────────────────

describe("recomputeAllBackerCounts", () => {
  test("dry run reports the drift and writes NOTHING; execute fixes it; a second run is clean", async () => {
    const s = await devDirectorSetup();
    await prepareAndActivate(s, 5000, "sub_repair", "repair@example.com");
    // The derive just wrote 1; hand a lie over the top of it, exactly as the
    // deleted manual setter did.
    await plantStaleCount(s, 7);

    const dry = await s.t.mutation(
      internal.givingPledges.recomputeAllBackerCounts,
      {},
    );
    expect(dry.dryRun).toBe(true);
    expect(dry.chaptersChecked).toBe(1);
    expect(dry.drifted).toBe(1);
    expect(dry.fixed).toBe(0);
    expect(dry.chapters[0]).toMatchObject({
      stored: 7,
      derived: 1,
      willFix: true,
    });
    expect(await backerCount(s)).toBe(7); // untouched

    const live = await s.t.mutation(
      internal.givingPledges.recomputeAllBackerCounts,
      { execute: true },
    );
    expect(live.dryRun).toBe(false);
    expect(live.drifted).toBe(1);
    expect(live.fixed).toBe(1);
    expect(await backerCount(s)).toBe(1);

    const chapter = await run(s.t, (ctx) => ctx.db.get(s.chapterId));
    expect(chapter?.backerCountUpdatedBy).toBeUndefined();

    // Idempotent — the second pass finds nothing to do.
    const again = await s.t.mutation(
      internal.givingPledges.recomputeAllBackerCounts,
      { execute: true },
    );
    expect(again.drifted).toBe(0);
    expect(again.fixed).toBe(0);
    expect(again.problems).toEqual([]);
  });

  test("repairs an inactive shadow chapter too — that's where the public promise renders", async () => {
    const s = await devDirectorSetup();
    const shadowId = await run(s.t, (ctx) =>
      ctx.db.insert("chapters", {
        name: "Queens",
        slug: "queens",
        isActive: false,
        backerCount: 4,
        createdAt: Date.now(),
      }),
    );

    const res = await s.t.mutation(
      internal.givingPledges.recomputeAllBackerCounts,
      { execute: true },
    );
    expect(res.fixed).toBe(1);
    const shadow = await run(s.t, (ctx) => ctx.db.get(shadowId));
    expect(shadow?.backerCount).toBe(0);
  });

  test("pledges scoped to `central` are reported and SKIPPED — central carries no backer count", async () => {
    const s = await devDirectorSetup();
    await run(s.t, async (ctx) => {
      const donorId = await ctx.db.insert("donors", {
        scope: "central",
        kind: "individual",
        name: "Central Giver",
        status: "active",
        lifetimeCents: 0,
        giftCount: 0,
        createdAt: Date.now(),
      });
      await ctx.db.insert("pledges", {
        donorId,
        scope: "central",
        amountCents: 5000,
        status: "active",
        origin: "stripe",
        createdAt: Date.now(),
      });
    });

    const res = await s.t.mutation(
      internal.givingPledges.recomputeAllBackerCounts,
      {},
    );
    expect(res.problems.some((p) => p.includes("central"))).toBe(true);
    expect(res.problems.some((p) => p.includes("SKIPPED"))).toBe(true);
    // The central pledge contributed to no chapter's number.
    expect(res.chapters.every((c) => c.derived === 0)).toBe(true);
  });
});
