import { describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import { newT, run, type TestConvex } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";
import { GENESIS_GIFTS } from "../lib/seed/historical/genesis";

/**
 * Genesis giving backfill: the one-time ops runner that loads Public Worship's
 * PRE-PLATFORM giving history (2024–2026 founder wires/transfers, paid-on-behalf
 * & in-kind gifts, Notion-era donations) into the NY chapter donor CRM. Covers:
 * dataset integrity (48 rows, exact 2411294¢ total, unique externalRefs);
 * dry-run writes nothing but reports counts; execute inserts 48 gifts with the
 * method mapping (in_kind/wire/other), scope rollups netting to the exact total,
 * and idempotent re-runs (48 duplicates, zero new writes); email-matched donors
 * linking to the roster person with that email; name-matched gifts attaching to
 * an existing same-name donor rather than duplicating; and the founder donor's
 * rollups + derived status.
 */

const NY_SLUG = "new-york";
const GENESIS_TOTAL_CENTS = 2411294;

type Setup = { t: TestConvex; chapterId: Id<"chapters">; userId: Id<"users"> };

/** A NY chapter (slug the backfill resolves by) + a user, no auth needed since
 *  the runners are internal. */
async function setupNy(): Promise<Setup> {
  const t = newT();
  const { chapterId, userId } = await run(t, async (ctx) => {
    const userId = await ctx.db.insert("users", {
      email: "leader@publicworship.life",
    });
    const chapterId = await ctx.db.insert("chapters", {
      name: "New York",
      slug: NY_SLUG,
      isActive: true,
      createdAt: Date.now(),
    });
    return { chapterId, userId };
  });
  return { t, chapterId, userId };
}

function scopeGifts(s: Setup, scope: Id<"chapters">) {
  return run(s.t, async (ctx) => {
    const gifts = await ctx.db
      .query("gifts")
      .withIndex("by_scope", (q) => q.eq("scope", scope))
      .collect();
    const donors = await ctx.db
      .query("donors")
      .withIndex("by_scope", (q) => q.eq("scope", scope))
      .collect();
    return {
      gifts,
      donors,
      giftCount: gifts.length,
      donorCount: donors.length,
      giftCentsTotal: gifts.reduce((sum, g) => sum + g.amountCents, 0),
    };
  });
}

describe("genesis dataset integrity", () => {
  test("48 rows, exact 2411294¢ total, unique externalRefs", () => {
    expect(GENESIS_GIFTS.length).toBe(48);
    expect(GENESIS_GIFTS.reduce((sum, r) => sum + r.amountCents, 0)).toBe(
      GENESIS_TOTAL_CENTS,
    );
    const refs = new Set(GENESIS_GIFTS.map((r) => r.externalRef));
    expect(refs.size).toBe(48);
    // Every amount is a positive integer number of cents (money invariant).
    for (const r of GENESIS_GIFTS) {
      expect(Number.isInteger(r.amountCents)).toBe(true);
      expect(r.amountCents).toBeGreaterThan(0);
    }
  });
});

describe("genesis giving backfill", () => {
  test("dry run writes nothing but reports full counts", async () => {
    const s = await setupNy();
    const res = await s.t.action(
      internal.historicalBackfill.runGenesisGivingBackfill,
      { execute: false },
    );
    expect(res.dryRun).toBe(true);
    expect(res.counts.gifts).toBe(48);
    expect(res.counts.giftsDuplicate).toBe(0);
    expect(res.counts.invalid).toBe(0);
    expect(res.totalCents).toBe(GENESIS_TOTAL_CENTS);

    const db = await scopeGifts(s, s.chapterId);
    expect(db.giftCount).toBe(0);
    expect(db.donorCount).toBe(0);
  });

  test("execute inserts 48 gifts, maps methods, nets rollups to the exact total, re-run idempotent", async () => {
    const s = await setupNy();

    const exec = await s.t.action(
      internal.historicalBackfill.runGenesisGivingBackfill,
      { execute: true },
    );
    expect(exec.dryRun).toBe(false);
    expect(exec.counts.gifts).toBe(48);
    expect(exec.counts.giftsDuplicate).toBe(0);
    expect(exec.counts.invalid).toBe(0);
    expect(exec.totalCents).toBe(GENESIS_TOTAL_CENTS);

    const db = await scopeGifts(s, s.chapterId);
    expect(db.giftCount).toBe(48);
    expect(db.giftCentsTotal).toBe(GENESIS_TOTAL_CENTS);
    // Donors created = distinct identities in the dataset.
    const distinctIdentities = new Set(
      GENESIS_GIFTS.map((r) => (r.donorEmail ?? r.donorName).toLowerCase()),
    );
    expect(db.donorCount).toBe(distinctIdentities.size);
    expect(exec.counts.donorsCreated).toBe(distinctIdentities.size);

    // Method mapping: inKind → in_kind, wire → wire, everything else → other.
    const byMethod = db.gifts.reduce<Record<string, number>>((acc, g) => {
      acc[g.method] = (acc[g.method] ?? 0) + 1;
      return acc;
    }, {});
    const expectInKind = GENESIS_GIFTS.filter((r) => r.inKind).length;
    const expectWire = GENESIS_GIFTS.filter(
      (r) => !r.inKind && r.method === "wire",
    ).length;
    const expectOther = GENESIS_GIFTS.filter(
      (r) => !r.inKind && r.method !== "wire",
    ).length;
    expect(byMethod["in_kind"] ?? 0).toBe(expectInKind);
    expect(byMethod["wire"] ?? 0).toBe(expectWire);
    expect(byMethod["other"] ?? 0).toBe(expectOther);
    // Every gift carries its curated genesis externalRef and note verbatim.
    expect(db.gifts.every((g) => g.externalRef?.startsWith("genesis:"))).toBe(
      true,
    );

    // Scope rollup: the denormalized aggregate nets to the exact dataset total.
    const rollup = await run(s.t, (ctx) =>
      ctx.db
        .query("givingScopeRollups")
        .withIndex("by_scope", (q) => q.eq("scope", s.chapterId))
        .unique(),
    );
    expect(rollup?.giftCount).toBe(48);
    expect(rollup?.lifetimeCents).toBe(GENESIS_TOTAL_CENTS);
    expect(rollup?.donorCount).toBe(distinctIdentities.size);

    // Re-run: every row dedups on its externalRef, nothing new is written.
    const rerun = await s.t.action(
      internal.historicalBackfill.runGenesisGivingBackfill,
      { execute: true },
    );
    expect(rerun.counts.gifts).toBe(0);
    expect(rerun.counts.giftsDuplicate).toBe(48);
    expect(rerun.counts.donorsCreated).toBe(0);
    expect(rerun.totalCents).toBe(0);
    const db2 = await scopeGifts(s, s.chapterId);
    expect(db2.giftCount).toBe(48);
    expect(db2.donorCount).toBe(distinctIdentities.size);
    expect(db2.giftCentsTotal).toBe(GENESIS_TOTAL_CENTS);
  });

  test("email-matched donor links to the roster person with that email", async () => {
    const s = await setupNy();
    const layomiEmail = "jesulayomi3.0@gmail.com";
    // The genesis dataset carries Layomi's email on several in-kind/donation rows.
    expect(
      GENESIS_GIFTS.some((r) => r.donorEmail === layomiEmail),
    ).toBe(true);

    // A roster person already exists with that email (the Givebutter-era import
    // would have created it). The genesis donor must LINK to it, not duplicate.
    const personId = await run(s.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Layomi Kupoluyi",
        email: layomiEmail,
        isTeamMember: false,
        createdAt: Date.now(),
      }),
    );

    await s.t.action(internal.historicalBackfill.runGenesisGivingBackfill, {
      execute: true,
    });

    const layomiDonors = await run(s.t, (ctx) =>
      ctx.db
        .query("donors")
        .withIndex("by_scope_and_email", (q) =>
          q.eq("scope", s.chapterId).eq("email", layomiEmail),
        )
        .collect(),
    );
    // Exactly one donor for that email, linked to the pre-existing person.
    expect(layomiDonors.length).toBe(1);
    expect(layomiDonors[0].personId).toBe(personId);
    // Its gifts equal the count of Layomi's emailed rows.
    const layomiRows = GENESIS_GIFTS.filter((r) => r.donorEmail === layomiEmail);
    expect(layomiDonors[0].giftCount).toBe(layomiRows.length);
    expect(layomiDonors[0].lifetimeCents).toBe(
      layomiRows.reduce((sum, r) => sum + r.amountCents, 0),
    );
  });

  test("name-matched founder attaches to an existing donor; rollups + active status", async () => {
    vi.useFakeTimers();
    try {
      // Freeze "now" shortly after the founder's last gift (2026-03-26) so the
      // 90-day lapse window makes them ACTIVE deterministically.
      vi.setSystemTime(new Date("2026-04-15T00:00:00Z"));

      const s = await setupNy();
      const founderName = "Oluseyi Olujide";
      const founderRows = GENESIS_GIFTS.filter(
        (r) => r.donorName === founderName,
      );
      expect(founderRows.length).toBeGreaterThan(0);
      // The founder's genesis rows carry no email → name is the match key.
      expect(founderRows.every((r) => r.donorEmail === undefined)).toBe(true);

      // A pre-existing founder donor (no email) — genesis must attach to it.
      const existingId = await run(s.t, (ctx) =>
        ctx.db.insert("donors", {
          scope: s.chapterId,
          kind: "individual",
          name: founderName,
          status: "prospect",
          lifetimeCents: 0,
          giftCount: 0,
          createdAt: Date.now(),
        }),
      );

      await s.t.action(internal.historicalBackfill.runGenesisGivingBackfill, {
        execute: true,
      });

      const founderDonors = await run(s.t, (ctx) =>
        ctx.db
          .query("donors")
          .withIndex("by_scope_and_name", (q) =>
            q.eq("scope", s.chapterId).eq("name", founderName),
          )
          .collect(),
      );
      // No duplicate — the single pre-existing donor absorbed every founder gift.
      expect(founderDonors.length).toBe(1);
      expect(founderDonors[0]._id).toBe(existingId);
      expect(founderDonors[0].giftCount).toBe(founderRows.length);
      expect(founderDonors[0].lifetimeCents).toBe(
        founderRows.reduce((sum, r) => sum + r.amountCents, 0),
      );
      // Latest gift is 2026-03-26, within 90 days of the frozen now → active.
      expect(founderDonors[0].status).toBe("active");
      expect(founderDonors[0].lastGiftAt).toBe(
        Math.max(...founderRows.map((r) => r.giftDateMs)),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
