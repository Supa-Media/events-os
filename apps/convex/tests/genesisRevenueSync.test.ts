import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import { newT, run, type TestConvex } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";

/**
 * Revenue-side reconciliation: links direct-to-bank gifts so their bank row stops
 * being counted a second time, and creates the one in-kind gift still missing.
 *
 * The case worth pinning hardest is the split wire — one $7,000 deposit carrying two
 * gifts ($5,000 central, $2,000 New York). Both must link to the same row, and the
 * matcher must refuse rather than guess when a match is ambiguous.
 */
const RUN = internal.genesisRevenueSync.runGenesisRevenueSync;
const D = (iso: string) => Date.parse(iso + "T00:00:00Z");

type S = { t: TestConvex; chapterId: Id<"chapters">; userId: Id<"users">; donorId: Id<"donors"> };

async function setup(opts: { ambiguous?: boolean } = {}): Promise<S> {
  const t = newT();
  const ids = await run(t, async (ctx) => {
    const chapterId = await ctx.db.insert("chapters", {
      name: "New York", slug: "new-york", isActive: true, createdAt: Date.now(),
    });
    const userId = await ctx.db.insert("users", { email: "owner@publicworship.life" });
    const donorId = await ctx.db.insert("donors", {
      scope: chapterId, kind: "individual", name: "Oluseyi Olujide", status: "active",
      lifetimeCents: 800000, giftCount: 4, createdAt: Date.now(),
    });
    const bank = (cents: number, iso: string) =>
      ctx.db.insert("transactions", {
        chapterId, source: "relay_csv", flow: "inflow", amountCents: cents,
        currency: "usd", postedAt: D(iso), status: "unreviewed", createdAt: Date.now(),
      });
    await bank(700000, "2026-03-26");
    await bank(100000, "2025-09-17");
    await bank(50000, "2025-09-19");

    const gift = (cents: number, iso: string, scope: Id<"chapters"> | "central") =>
      ctx.db.insert("gifts", {
        donorId, scope, amountCents: cents, currency: "usd",
        receivedAt: D(iso), method: "wire", createdAt: Date.now(),
      });
    await gift(500000, "2026-03-26", "central");
    await gift(200000, "2026-03-26", chapterId);
    await gift(100000, "2025-09-17", chapterId);
    await gift(50000, "2025-09-19", chapterId);
    // A second identical NY gift makes the $1,000 match ambiguous.
    if (opts.ambiguous) await gift(100000, "2025-09-17", chapterId);
    return { chapterId, userId, donorId };
  });
  return { t, ...ids };
}

const gifts = (s: S) => run(s.t, (ctx) => ctx.db.query("gifts").collect());

describe("runGenesisRevenueSync", () => {
  test("dry run reports the work and writes nothing", async () => {
    const s = await setup();
    const res = await s.t.mutation(RUN, { editedBy: s.userId });
    expect(res.dryRun).toBe(true);
    expect(res.skipped).toEqual([]);
    expect(res.giftsLinked).toBe(4);
    expect(res.inKindGiftCreated).toBe(true);
    expect((await gifts(s)).every((g) => !g.transactionId)).toBe(true);
    expect((await gifts(s)).length).toBe(4);
  });

  test("both halves of the split wire link to the SAME deposit", async () => {
    const s = await setup();
    await s.t.mutation(RUN, { editedBy: s.userId, execute: true });
    const all = await gifts(s);
    const five = all.find((g) => g.amountCents === 500000)!;
    const two = all.find((g) => g.amountCents === 200000)!;
    expect(five.transactionId).toBeDefined();
    // One deposit, two gifts — the model's Set skips the row once.
    expect(two.transactionId).toBe(five.transactionId);
    const bank = await run(s.t, (ctx) => ctx.db.get(five.transactionId!));
    expect(bank!.amountCents).toBe(700000);
  });

  test("creates the missing in-kind gift and moves the donor rollup", async () => {
    const s = await setup();
    const before = await run(s.t, (ctx) => ctx.db.get(s.donorId));
    await s.t.mutation(RUN, { editedBy: s.userId, execute: true });
    const created = (await gifts(s)).find((g) => g.externalRef === "genesis:cleanup2026");
    expect(created).toBeDefined();
    expect(created!.amountCents).toBe(84303);
    expect(created!.method).toBe("in_kind");
    const after = await run(s.t, (ctx) => ctx.db.get(s.donorId));
    expect(after!.lifetimeCents).toBe(before!.lifetimeCents + 84303);
    expect(after!.giftCount).toBe(before!.giftCount + 1);
  });

  test("REFUSES an ambiguous match rather than linking the wrong gift", async () => {
    const s = await setup({ ambiguous: true });
    const res = await s.t.mutation(RUN, { editedBy: s.userId, execute: true });
    expect(res.skipped.join(" ")).toContain("found 2");
    // The unambiguous ones still linked.
    expect(res.giftsLinked).toBe(3);
  });

  test("second run is idempotent", async () => {
    const s = await setup();
    await s.t.mutation(RUN, { editedBy: s.userId, execute: true });
    const n = (await gifts(s)).length;
    const again = await s.t.mutation(RUN, { editedBy: s.userId, execute: true });
    expect(again.giftsLinked).toBe(0);
    expect(again.inKindGiftCreated).toBe(false);
    expect((await gifts(s)).length).toBe(n);
  });
});
