import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import { newT, run, type TestConvex } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";

/**
 * Gift/expense realignment: puts the owner-paid genesis gifts back in step with the
 * expenses they mirror, after corrections to one side drifted them apart.
 *
 * The load-bearing tests are the refusals — this edits someone's recognised giving, so
 * it must never write from a stale plan, and must never delete a gift whose expense is
 * actually still there.
 */

const PREFIX = "genesis-inkind-exp:";
const RUN = internal.genesisGiftSync.runGenesisGiftSync;

/** The live-prod shape: expense corrected, gift left behind. */
const DRIFTED: [string, number, number][] = [
  ["buy25:3", 5440, 1087],
  ["buy25:22", 6465, 6000],
  ["buy25:25", 48646, 32657],
  ["buy25:2", 5878, 4349],
  ["buy25:4", 21557, 10879],
  ["buy25:5", 105930, 116608],
  ["buy25:29", 40511, 40500],
];
const ORPHAN_GIFTS: [string, number][] = [
  ["genesis:buy25:26", 1196],
  ["genesis:buy25:27", 11974],
];

type S = { t: TestConvex; userId: Id<"users">; donorId: Id<"donors">; chapterId: Id<"chapters"> };

async function setup(): Promise<S> {
  const t = newT();
  const ids = await run(t, async (ctx) => {
    const chapterId = await ctx.db.insert("chapters", {
      name: "New York", slug: "new-york", isActive: true, createdAt: Date.now(),
    });
    const userId = await ctx.db.insert("users", { email: "owner@publicworship.life" });
    const donorId = await ctx.db.insert("donors", {
      scope: chapterId, kind: "individual", name: "Oluseyi Olujide", status: "active",
      lifetimeCents: 0, giftCount: 0, createdAt: Date.now(),
    });
    const base = Date.UTC(2025, 3, 1);
    for (const [slug, txnCents, giftCents] of DRIFTED) {
      await ctx.db.insert("transactions", {
        chapterId, source: "manual", flow: "outflow", amountCents: txnCents,
        currency: "usd", postedAt: base, description: slug, status: "categorized",
        externalId: PREFIX + slug, createdAt: Date.now(),
      });
      await ctx.db.insert("gifts", {
        donorId, scope: chapterId, amountCents: giftCents, currency: "usd",
        receivedAt: base, method: "in_kind", externalRef: "genesis:" + slug,
        createdAt: Date.now(),
      });
    }
    // Orphans: gift present, transaction merged away.
    for (const [ref, cents] of ORPHAN_GIFTS) {
      await ctx.db.insert("gifts", {
        donorId, scope: chapterId, amountCents: cents, currency: "usd",
        receivedAt: base, method: "in_kind", externalRef: ref, createdAt: Date.now(),
      });
    }
    const gifts = await ctx.db.query("gifts").collect();
    await ctx.db.patch(donorId, {
      lifetimeCents: gifts.reduce((a, g) => a + g.amountCents, 0),
      giftCount: gifts.length,
    });
    return { userId, donorId, chapterId };
  });
  return { t, ...ids };
}

const giftBy = (s: S, ref: string) =>
  run(s.t, (ctx) =>
    ctx.db.query("gifts").withIndex("by_externalRef", (q) => q.eq("externalRef", ref)).first(),
  );

describe("runGenesisGiftSync", () => {
  test("dry run reports the work and writes nothing", async () => {
    const s = await setup();
    const before = await run(s.t, (ctx) => ctx.db.get(s.donorId));
    const res = await s.t.mutation(RUN, { editedBy: s.userId });
    expect(res.dryRun).toBe(true);
    expect(res.skipped).toEqual([]);
    expect(res.realigned).toBe(7);
    expect(res.orphansRemoved).toBe(2);
    const after = await run(s.t, (ctx) => ctx.db.get(s.donorId));
    expect(after!.lifetimeCents).toBe(before!.lifetimeCents);
  });

  test("every gift ends up equal to the expense it mirrors", async () => {
    const s = await setup();
    await s.t.mutation(RUN, { editedBy: s.userId, execute: true });
    for (const [slug, txnCents] of DRIFTED) {
      const g = await giftBy(s, "genesis:" + slug);
      expect(g!.amountCents).toBe(txnCents);
    }
  });

  test("orphaned gifts are removed and the donor rollup follows exactly", async () => {
    const s = await setup();
    const before = await run(s.t, (ctx) => ctx.db.get(s.donorId));
    const res = await s.t.mutation(RUN, { editedBy: s.userId, execute: true });

    for (const [ref] of ORPHAN_GIFTS) expect(await giftBy(s, ref)).toBeNull();

    const after = await run(s.t, (ctx) => ctx.db.get(s.donorId));
    // The rollup is the reason this goes through editGiftRow/removeGiftRow rather
    // than a raw patch — assert it moved by exactly the reported delta.
    expect(after!.lifetimeCents).toBe(before!.lifetimeCents + res.givingDeltaCents);
    expect(after!.giftCount).toBe(before!.giftCount - ORPHAN_GIFTS.length);
    // And that the total equals the sum of what's left.
    const gifts = await run(s.t, (ctx) => ctx.db.query("gifts").collect());
    expect(after!.lifetimeCents).toBe(gifts.reduce((a, g) => a + g.amountCents, 0));
  });

  test("REFUSES a row whose expense has moved since the plan was written", async () => {
    const s = await setup();
    await run(s.t, async (ctx) => {
      const rows = await ctx.db.query("transactions").collect();
      const t = rows.find((r) => r.externalId === PREFIX + "buy25:3")!;
      await ctx.db.patch(t._id, { amountCents: 9999 });
    });
    const res = await s.t.mutation(RUN, { editedBy: s.userId, execute: true });
    expect(res.skipped.join(" ")).toContain("moved since this was written");
    // Left exactly as it was rather than written from a stale figure.
    expect((await giftBy(s, "genesis:buy25:3"))!.amountCents).toBe(1087);
    expect(res.realigned).toBe(6);
  });

  test("REFUSES to delete an 'orphan' whose expense actually still exists", async () => {
    const s = await setup();
    await run(s.t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: s.chapterId, source: "manual", flow: "outflow", amountCents: 1196,
        currency: "usd", postedAt: Date.UTC(2025, 3, 1), description: "resurrected",
        status: "categorized", externalId: PREFIX + "buy25:26", createdAt: Date.now(),
      }),
    );
    const res = await s.t.mutation(RUN, { editedBy: s.userId, execute: true });
    expect(res.skipped.join(" ")).toContain("not an orphan");
    expect(await giftBy(s, "genesis:buy25:26")).not.toBeNull();
    expect(res.orphansRemoved).toBe(1);
  });

  test("second run is idempotent", async () => {
    const s = await setup();
    await s.t.mutation(RUN, { editedBy: s.userId, execute: true });
    const again = await s.t.mutation(RUN, { editedBy: s.userId, execute: true });
    expect(again.realigned).toBe(0);
    expect(again.orphansRemoved).toBe(0);
    expect(again.givingDeltaCents).toBe(0);
    expect(again.alreadyAligned).toBe(DRIFTED.length + ORPHAN_GIFTS.length);
  });
});
