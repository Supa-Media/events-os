import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import { newT, run, storeBlob, type TestConvex } from "./setup.helpers";
import type { Doc, Id } from "../_generated/dataModel";
import {
  DEDUPE_PAIRS,
  DEDUPE_DELETIONS,
  DEDUPE_PATCHES,
} from "../lib/seed/historical/genesisDedupe2026";

/**
 * Genesis dedupe: removes the 12 import rows that duplicate a bank-feed charge, the two
 * rows the owner retired, and corrects the lens rental amount.
 *
 * The tests that matter most here are the refusals. Deleting money rows on a stale plan
 * is the failure mode worth engineering against, so there is a case for each guard: a
 * moved amount, a missing twin, a flow mismatch, a twin that drifted out of the date
 * window, and a missing gift. Plus the one that motivated the whole design — a receipt
 * attached to a duplicate must end up on the survivor, never orphaned.
 */

const NY_SLUG = "new-york";
const DAY = 86400000;

type S = {
  t: TestConvex;
  chapterId: Id<"chapters">;
  userId: Id<"users">;
  donorId: Id<"donors">;
};

async function setup(): Promise<S> {
  const t = newT();
  const ids = await run(t, async (ctx) => {
    const chapterId = await ctx.db.insert("chapters", {
      name: "New York", slug: NY_SLUG, isActive: true, createdAt: Date.now(),
    });
    const userId = await ctx.db.insert("users", { email: "owner@publicworship.life" });
    const donorId = await ctx.db.insert("donors", {
      scope: chapterId, kind: "individual", name: "Donor", status: "active",
      lifetimeCents: 0, giftCount: 0, createdAt: Date.now(),
    });

    const txn = async (externalId: string, amountCents: number, postedAt: number, flow: "inflow" | "outflow" = "outflow") =>
      ctx.db.insert("transactions", {
        chapterId, source: "relay_csv", flow, amountCents, currency: "usd",
        postedAt, description: externalId, status: "categorized",
        externalId, createdAt: Date.now(),
      });

    // Both halves of every pair, posted on the same day.
    const base = Date.UTC(2026, 0, 10);
    for (const p of DEDUPE_PAIRS) {
      const flow = p.amountCents === 50000 ? ("inflow" as const) : ("outflow" as const);
      await txn(p.deleteExternalId, p.amountCents, base, flow);
      await txn(p.keepExternalId, p.amountCents, base, flow);
    }
    for (const d of DEDUPE_DELETIONS) {
      await txn(d.externalId, d.amountCents, base);
      await ctx.db.insert("gifts", {
        donorId, scope: chapterId, amountCents: d.amountCents, currency: "usd",
        receivedAt: base, method: "in_kind", externalRef: d.giftRef, createdAt: Date.now(),
      });
    }
    for (const p of DEDUPE_PATCHES) {
      await txn(p.externalId, p.externalId.endsWith("lens2") ? 7459 : p.amountCents, base);
      if (p.giftRef) {
        await ctx.db.insert("gifts", {
          donorId, scope: chapterId, amountCents: 7459, currency: "usd",
          receivedAt: base, method: "in_kind", externalRef: p.giftRef, createdAt: Date.now(),
        });
      }
    }
    // Rollups consistent with what was seeded.
    const gifts = await ctx.db.query("gifts").collect();
    await ctx.db.patch(donorId, {
      lifetimeCents: gifts.reduce((a, g) => a + g.amountCents, 0),
      giftCount: gifts.length,
    });
    return { chapterId, userId, donorId };
  });
  return { t, ...ids };
}

const RUN = internal.genesisDedupe.runGenesisDedupe;
const all = (s: S): Promise<Doc<"transactions">[]> =>
  run(s.t, (ctx) => ctx.db.query("transactions").collect());
const byExt = async (s: S, ext: string) =>
  (await all(s)).find((t) => t.externalId === ext);

describe("dedupe dataset", () => {
  test("12 pairs, no row is both deleted and kept", () => {
    expect(DEDUPE_PAIRS).toHaveLength(12);
    const del = new Set(DEDUPE_PAIRS.map((p) => p.deleteExternalId));
    const keep = new Set(DEDUPE_PAIRS.map((p) => p.keepExternalId));
    expect(del.size).toBe(12);
    expect(keep.size).toBe(12);
    for (const k of keep) expect(del.has(k)).toBe(false);
    // Every deletion targets an IMPORT row; never a live bank row.
    for (const d of del) expect(d.startsWith("genesis-bank:")).toBe(true);
  });

  test("every retired row names the gift that must go with it", () => {
    for (const d of DEDUPE_DELETIONS) expect(d.giftRef).toMatch(/^genesis:/);
  });
});

describe("runGenesisDedupe", () => {
  test("dry run predicts and writes nothing", async () => {
    const s = await setup();
    const before = (await all(s)).length;
    const res = await s.t.mutation(RUN, { editedBy: s.userId });
    expect(res.dryRun).toBe(true);
    expect(res.skipped).toEqual([]);
    expect(res.counts.duplicatesDeleted).toBe(12);
    expect(res.counts.rowsRemoved).toBe(DEDUPE_DELETIONS.length);
    expect((await all(s)).length).toBe(before);
  });

  test("execute deletes only the import copies and keeps every twin", async () => {
    const s = await setup();
    await s.t.mutation(RUN, { editedBy: s.userId, execute: true });
    for (const p of DEDUPE_PAIRS) {
      expect(await byExt(s, p.deleteExternalId)).toBeUndefined();
      expect(await byExt(s, p.keepExternalId)).toBeDefined();
    }
  });

  test("a receipt on a duplicate MOVES to the survivor and is never orphaned", async () => {
    const s = await setup();
    const p = DEDUPE_PAIRS[0];
    const storageId = await storeBlob(s.t);
    const receiptId = await run(s.t, async (ctx) => {
      const rows = await ctx.db.query("transactions").collect();
      const dupe = rows.find((r) => r.externalId === p.deleteExternalId)!;
      const rid = await ctx.db.insert("receipts", {
        chapterId: s.chapterId, storageId, source: "upload", linkCount: 1,
        createdAt: Date.now(), updatedAt: Date.now(),
      });
      await ctx.db.insert("receiptLinks", {
        receiptId: rid, transactionId: dupe._id, chapterId: s.chapterId,
        source: "upload", createdAt: Date.now(),
      });
      await ctx.db.patch(dupe._id, { receiptStorageId: storageId });
      return rid;
    });

    const res = await s.t.mutation(RUN, { editedBy: s.userId, execute: true });
    expect(res.counts.receiptsMoved).toBe(1);

    // The document survives, and now points at the row that survives.
    const receipt = await run(s.t, (ctx) => ctx.db.get(receiptId));
    expect(receipt).not.toBeNull();
    const links = await run(s.t, (ctx) => ctx.db.query("receiptLinks").collect());
    expect(links).toHaveLength(1);
    const keep = (await byExt(s, p.keepExternalId))!;
    expect(links[0].transactionId).toBe(keep._id);
    expect(keep.receiptStorageId).toBe(storageId);
  });

  test("retired rows take their gift with them, and the donor rollup follows", async () => {
    const s = await setup();
    const before = await run(s.t, (ctx) => ctx.db.get(s.donorId));
    const removed = DEDUPE_DELETIONS.reduce((a, d) => a + d.amountCents, 0);
    await s.t.mutation(RUN, { editedBy: s.userId, execute: true });
    for (const d of DEDUPE_DELETIONS) {
      expect(await byExt(s, d.externalId)).toBeUndefined();
      const gift = await run(s.t, (ctx) =>
        ctx.db.query("gifts").withIndex("by_externalRef", (q) => q.eq("externalRef", d.giftRef)).first(),
      );
      expect(gift).toBeNull();
    }
    // The same run also corrects the lens gift ($74.59 → $35.20) on this donor, so the
    // lifetime moves by the deletions PLUS that delta. Asserting only the deletions
    // would pass for the wrong reason if the lens leg silently stopped moving.
    const lensDelta = 7459 - 3520;
    const after = await run(s.t, (ctx) => ctx.db.get(s.donorId));
    expect(after!.lifetimeCents).toBe(before!.lifetimeCents - removed - lensDelta);
    expect(after!.giftCount).toBe(before!.giftCount - DEDUPE_DELETIONS.length);
  });

  test("the lens correction moves the expense AND the gift to $35.20", async () => {
    const s = await setup();
    await s.t.mutation(RUN, { editedBy: s.userId, execute: true });
    const lens2 = DEDUPE_PATCHES.find((p) => p.giftRef)!;
    expect((await byExt(s, lens2.externalId))!.amountCents).toBe(3520);
    const gift = await run(s.t, (ctx) =>
      ctx.db.query("gifts").withIndex("by_externalRef", (q) => q.eq("externalRef", lens2.giftRef!)).first(),
    );
    expect(gift!.amountCents).toBe(3520);
  });

  test("REFUSES a pair whose amount has moved since the plan was written", async () => {
    const s = await setup();
    const p = DEDUPE_PAIRS[1];
    await run(s.t, async (ctx) => {
      const rows = await ctx.db.query("transactions").collect();
      const dupe = rows.find((r) => r.externalId === p.deleteExternalId)!;
      await ctx.db.patch(dupe._id, { amountCents: p.amountCents + 111 });
    });
    const res = await s.t.mutation(RUN, { editedBy: s.userId, execute: true });
    expect(res.skipped.join(" ")).toContain(p.deleteExternalId);
    expect(await byExt(s, p.deleteExternalId)).toBeDefined(); // untouched
    expect(res.counts.duplicatesDeleted).toBe(11);
  });

  test("REFUSES a pair whose twin has drifted out of the date window", async () => {
    const s = await setup();
    const p = DEDUPE_PAIRS[2];
    await run(s.t, async (ctx) => {
      const rows = await ctx.db.query("transactions").collect();
      const keep = rows.find((r) => r.externalId === p.keepExternalId)!;
      await ctx.db.patch(keep._id, { postedAt: keep.postedAt + 9 * DAY });
    });
    const res = await s.t.mutation(RUN, { editedBy: s.userId, execute: true });
    expect(res.skipped.join(" ")).toContain("more than 2 days");
    expect(await byExt(s, p.deleteExternalId)).toBeDefined();
  });

  test("REFUSES a pair whose twin is gone — never deletes the last copy", async () => {
    const s = await setup();
    const p = DEDUPE_PAIRS[3];
    await run(s.t, async (ctx) => {
      const rows = await ctx.db.query("transactions").collect();
      await ctx.db.delete(rows.find((r) => r.externalId === p.keepExternalId)!._id);
    });
    const res = await s.t.mutation(RUN, { editedBy: s.userId, execute: true });
    expect(res.skipped.join(" ")).toContain("not found");
    expect(await byExt(s, p.deleteExternalId)).toBeDefined();
  });

  test("REFUSES an amount correction whose gift is missing", async () => {
    const s = await setup();
    const lens2 = DEDUPE_PATCHES.find((p) => p.giftRef)!;
    await run(s.t, async (ctx) => {
      const g = await ctx.db
        .query("gifts")
        .withIndex("by_externalRef", (q) => q.eq("externalRef", lens2.giftRef!))
        .first();
      await ctx.db.delete(g!._id);
    });
    const res = await s.t.mutation(RUN, { editedBy: s.userId, execute: true });
    expect(res.skipped.join(" ")).toContain("refusing to move one leg alone");
    expect((await byExt(s, lens2.externalId))!.amountCents).toBe(7459); // unchanged
  });

  test("second run is idempotent", async () => {
    const s = await setup();
    await s.t.mutation(RUN, { editedBy: s.userId, execute: true });
    const after = (await all(s)).length;
    const again = await s.t.mutation(RUN, { editedBy: s.userId, execute: true });
    expect(again.counts.duplicatesDeleted).toBe(0);
    expect(again.counts.rowsRemoved).toBe(0);
    expect(again.counts.giftsRemoved).toBe(0);
    expect(again.counts.amountsCorrected).toBe(0);
    expect((await all(s)).length).toBe(after);
  });
});
