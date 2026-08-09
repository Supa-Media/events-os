/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * The Sales grid's read + the two writes that make it a grid rather than a
 * report (`sales.ts`).
 *
 * The tests that matter here are the REFUSALS, same as `salesCatalog.test.ts`.
 * A bookkeeper is being invited to say what a bare card charge was, which is the
 * one place this feature could do real damage: the whole design rests on their
 * choice being confined to baskets the amount genuinely makes, and on the money
 * itself being untouchable. So: a fabricated basket is rejected, a day with no
 * price list offers nothing to fabricate FROM, gross and fee never move, and a
 * viewer — who can't even read this surface — certainly can't write it.
 */

// The real catalogue days (`lib/salesCatalog.ts`). Pop The Balloon's overlapping
// $1/$2/$3/$5 snack prices are what make a $3 tap genuinely ambiguous; Eden sold
// only $30 tees, which is what makes a $30 tap certain.
const PTB_DAY_MS = Date.UTC(2025, 11, 6, 18, 0, 0); // 2025-12-06
const EDEN_DAY_MS = Date.UTC(2026, 4, 31, 18, 0, 0); // 2026-05-31
const NO_CATALOG_DAY_MS = Date.UTC(2026, 7, 7, 18, 0, 0); // 2026-08-07 — no catalogue

async function seedPerson(s: ChapterSetup, name = "Caller"): Promise<Id<"people">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name,
      userId: s.userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
}

async function grantRole(
  s: ChapterSetup,
  personId: Id<"people">,
  role: "viewer" | "bookkeeper" | "manager",
): Promise<void> {
  await run(s.t, (ctx) =>
    ctx.db.insert("financeRoles", {
      chapterId: s.chapterId,
      personId,
      role,
      scope: "chapter",
      createdAt: Date.now(),
    }),
  );
}

/** A bookkeeper with a roster row — the ordinary caller for this surface. */
async function setupBookkeeper(): Promise<ChapterSetup> {
  const t = newT();
  const s = await setupChapter(t);
  const personId = await seedPerson(s);
  await grantRole(s, personId, "bookkeeper");
  return s;
}

async function seedSale(
  s: ChapterSetup,
  opts: {
    soldAt: number;
    grossCents: number;
    feeCents?: number;
    eventId?: Id<"events">;
    chapterId?: Id<"chapters">;
  },
): Promise<Id<"sales">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("sales", {
      chapterId: opts.chapterId ?? s.chapterId,
      ...(opts.eventId ? { eventId: opts.eventId } : {}),
      stripeChargeId: `ch_test_${Math.random().toString(36).slice(2)}`,
      soldAt: opts.soldAt,
      grossCents: opts.grossCents,
      feeCents: opts.feeCents ?? 30,
      items: [],
      itemSource: "unresolved",
      channel: "in_person",
      createdAt: Date.now(),
    }),
  );
}

async function seedEvent(
  s: ChapterSetup,
  opts: { name?: string; chapterId?: Id<"chapters">; userId?: Id<"users"> } = {},
): Promise<Id<"events">> {
  const chapterId = opts.chapterId ?? s.chapterId;
  const createdBy = opts.userId ?? s.userId;
  return await run(s.t, async (ctx) => {
    const eventTypeId = await ctx.db.insert("eventTypes", {
      chapterId,
      name: "Service",
      slug: `service-${Date.now()}-${Math.random()}`,
      version: 1,
      createdBy,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return await ctx.db.insert("events", {
      chapterId,
      eventTypeId,
      templateVersion: 1,
      name: opts.name ?? "Pop The Balloon",
      eventDate: PTB_DAY_MS,
      status: "planning",
      createdBy,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}

describe("listSales", () => {
  test("ships each row the baskets its own amount could be", async () => {
    const s = await setupBookkeeper();
    // $3 on a Pop The Balloon day: a $3 item, or $2+$1, or three $1 waters.
    const ambiguous = await seedSale(s, { soldAt: PTB_DAY_MS, grossCents: 300 });
    // $30 at Eden, where only tees were sold — exactly one reading.
    const certain = await seedSale(s, { soldAt: EDEN_DAY_MS, grossCents: 3000 });

    const { sales } = await s.as.query(api.sales.listSales, { chapterId: s.chapterId });
    const a = sales.find((r) => r.saleId === ambiguous)!;
    const c = sales.find((r) => r.saleId === certain)!;

    expect(a.itemOptions.length).toBe(3);
    expect(a.hasCatalog).toBe(true);
    expect(a.itemsKey).toBeNull(); // nothing recorded yet
    expect(c.itemOptions.length).toBe(1);
    expect(c.itemOptions[0].label).toBe("PW Tee");
  });

  test("a day with no price list offers nothing, and says which dead end it is", async () => {
    const s = await setupBookkeeper();
    const saleId = await seedSale(s, { soldAt: NO_CATALOG_DAY_MS, grossCents: 300 });
    // $45 at Eden: a catalogue exists, but no number of $30 tees makes it.
    const unreachable = await seedSale(s, { soldAt: EDEN_DAY_MS, grossCents: 4500 });

    const { sales } = await s.as.query(api.sales.listSales, { chapterId: s.chapterId });
    const noCatalog = sales.find((r) => r.saleId === saleId)!;
    const noBasket = sales.find((r) => r.saleId === unreachable)!;

    expect(noCatalog.itemOptions).toEqual([]);
    expect(noCatalog.hasCatalog).toBe(false);
    expect(noBasket.itemOptions).toEqual([]);
    // The distinction the UI needs: a price list DOES exist, it just doesn't
    // reach this amount.
    expect(noBasket.hasCatalog).toBe(true);
  });

  test("the summary counts every sale gross, breakdown or not", async () => {
    const s = await setupBookkeeper();
    await seedSale(s, { soldAt: PTB_DAY_MS, grossCents: 300, feeCents: 23 });
    await seedSale(s, { soldAt: EDEN_DAY_MS, grossCents: 3000, feeCents: 122 });

    const { summary } = await s.as.query(api.sales.listSales, { chapterId: s.chapterId });
    expect(summary.count).toBe(2);
    expect(summary.grossCents).toBe(3300);
    expect(summary.feeCents).toBe(145);
    expect(summary.netCents).toBe(3155);
    // Both were seeded unresolved — and every cent of it is still real revenue.
    expect(summary.unresolvedCount).toBe(2);
    expect(summary.unresolvedCents).toBe(3300);
  });

  test("the event picker offers every chapter event, not just the ones with sales", async () => {
    const s = await setupBookkeeper();
    await seedEvent(s, { name: "Pop The Balloon" });
    await seedEvent(s, { name: "Eden" });
    await seedSale(s, { soldAt: PTB_DAY_MS, grossCents: 300 });

    const { events } = await s.as.query(api.sales.listSales, { chapterId: s.chapterId });
    expect(events.map((e) => e.name).sort()).toEqual(["Eden", "Pop The Balloon"]);
  });

  test("a viewer can't read sales at all", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedPerson(s);
    await grantRole(s, personId, "viewer");
    await expect(
      s.as.query(api.sales.listSales, { chapterId: s.chapterId }),
    ).rejects.toThrow(ConvexError);
  });
});

describe("setSaleItems", () => {
  test("a bookkeeper settles an ambiguous tap from the readings it allows", async () => {
    const s = await setupBookkeeper();
    const saleId = await seedSale(s, { soldAt: PTB_DAY_MS, grossCents: 300 });

    const before = await s.as.query(api.sales.listSales, { chapterId: s.chapterId });
    const row = before.sales.find((r) => r.saleId === saleId)!;
    const single = row.itemOptions.find((o) => o.label === "$3 item")!;

    await s.as.mutation(api.sales.setSaleItems, { saleId, basketKey: single.key });

    const doc = await run(s.t, (ctx) => ctx.db.get(saleId));
    expect(doc?.items).toEqual([
      { label: "$3 item", quantity: 1, unitPriceCents: 300, candidates: ["Candy", "Snapple"] },
    ]);
    // A person's recollection stays distinguishable from arithmetic.
    expect(doc?.itemSource).toBe("manual");
    // …and the money is exactly where it was.
    expect(doc?.grossCents).toBe(300);
    expect(doc?.feeCents).toBe(30);

    const after = await s.as.query(api.sales.listSales, { chapterId: s.chapterId });
    expect(after.sales.find((r) => r.saleId === saleId)!.itemsKey).toBe(single.key);
  });

  test("a basket the amount doesn't make is refused", async () => {
    const s = await setupBookkeeper();
    // $30 at Eden buys one tee. Claiming a $50 hoodie would be a fabrication —
    // and it isn't even representable, since the key names prices too.
    const saleId = await seedSale(s, { soldAt: EDEN_DAY_MS, grossCents: 3000 });
    await expect(
      s.as.mutation(api.sales.setSaleItems, {
        saleId,
        basketKey: "5000:Made To Worship Hoodie:1",
      }),
    ).rejects.toThrow(/doesn't add up/);

    const doc = await run(s.t, (ctx) => ctx.db.get(saleId));
    expect(doc?.items).toEqual([]);
    expect(doc?.itemSource).toBe("unresolved");
  });

  test("a day with no price list has nothing to choose from", async () => {
    const s = await setupBookkeeper();
    const saleId = await seedSale(s, { soldAt: NO_CATALOG_DAY_MS, grossCents: 300 });
    await expect(
      s.as.mutation(api.sales.setSaleItems, { saleId, basketKey: "300:$3 item:1" }),
    ).rejects.toThrow(/no price list/i);
  });

  test("null puts a row back to unresolved — including one the importer resolved", async () => {
    const s = await setupBookkeeper();
    const saleId = await seedSale(s, { soldAt: EDEN_DAY_MS, grossCents: 3000 });
    await run(s.t, (ctx) =>
      ctx.db.patch(saleId, {
        items: [
          { label: "PW Tee", quantity: 1, unitPriceCents: 3000, candidates: ["PW Tee"] },
        ],
        itemSource: "amount_decomposition",
      }),
    );

    await s.as.mutation(api.sales.setSaleItems, { saleId, basketKey: null });

    const doc = await run(s.t, (ctx) => ctx.db.get(saleId));
    expect(doc?.items).toEqual([]);
    expect(doc?.itemSource).toBe("unresolved");
  });

  test("every change is on the shared finance audit trail", async () => {
    const s = await setupBookkeeper();
    const saleId = await seedSale(s, { soldAt: EDEN_DAY_MS, grossCents: 3000 });
    const { sales } = await s.as.query(api.sales.listSales, { chapterId: s.chapterId });
    const key = sales.find((r) => r.saleId === saleId)!.itemOptions[0].key;

    await s.as.mutation(api.sales.setSaleItems, { saleId, basketKey: key });
    await s.as.mutation(api.sales.setSaleItems, { saleId, basketKey: null });

    const trail = await s.as.query(api.finances.financeAuditTrail, {
      subjectType: "sale",
      subjectId: saleId,
    });
    expect(trail.map((r) => r.action)).toEqual(["sale_items_set", "sale_items_set"]);
    // Newest first: the clear, then the assignment that preceded it.
    expect(trail[0].before).toBe("PW Tee");
    expect(trail[0].after).toBe("Unresolved");
    expect(trail[1].before).toBe("Unresolved");
    expect(trail[1].after).toBe("PW Tee");
    expect(trail[1].actorName).toBe("Caller");
  });

  test("a viewer is rejected (FORBIDDEN)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedPerson(s);
    await grantRole(s, personId, "viewer");
    const saleId = await seedSale(s, { soldAt: EDEN_DAY_MS, grossCents: 3000 });

    await expect(
      s.as.mutation(api.sales.setSaleItems, { saleId, basketKey: "3000:PW Tee:1" }),
    ).rejects.toThrow(ConvexError);
    const doc = await run(s.t, (ctx) => ctx.db.get(saleId));
    expect(doc?.items).toEqual([]);
  });
});

describe("setSaleEvent", () => {
  test("an orphan tap is adopted, and can be detached again", async () => {
    const s = await setupBookkeeper();
    const eventId = await seedEvent(s, { name: "Pop The Balloon" });
    const saleId = await seedSale(s, { soldAt: PTB_DAY_MS, grossCents: 300 });

    await s.as.mutation(api.sales.setSaleEvent, { saleId, eventId });
    expect((await run(s.t, (ctx) => ctx.db.get(saleId)))?.eventId).toBe(eventId);

    await s.as.mutation(api.sales.setSaleEvent, { saleId, eventId: null });
    // Absence, not a null — the orphan state in this schema is a missing field.
    expect((await run(s.t, (ctx) => ctx.db.get(saleId)))?.eventId).toBeUndefined();

    const trail = await s.as.query(api.finances.financeAuditTrail, {
      subjectType: "sale",
      subjectId: saleId,
    });
    expect(trail.map((r) => r.action)).toEqual(["sale_event_set", "sale_event_set"]);
    expect(trail[1].after).toBe("Pop The Balloon");
    expect(trail[0].after).toBe("Unattributed");
  });

  test("another chapter's event is refused — a sale stays with the book that took it", async () => {
    const s = await setupBookkeeper();
    const otherChapterId = await run(s.t, (ctx) =>
      ctx.db.insert("chapters", { name: "Atlanta", isActive: true, createdAt: Date.now() }),
    );
    const foreignEventId = await seedEvent(s, {
      name: "Someone Else's Event",
      chapterId: otherChapterId,
    });
    const saleId = await seedSale(s, { soldAt: PTB_DAY_MS, grossCents: 300 });

    await expect(
      s.as.mutation(api.sales.setSaleEvent, { saleId, eventId: foreignEventId }),
    ).rejects.toThrow(/another chapter/i);
    expect((await run(s.t, (ctx) => ctx.db.get(saleId)))?.eventId).toBeUndefined();
  });

  test("a no-op change writes nothing to the trail", async () => {
    const s = await setupBookkeeper();
    const saleId = await seedSale(s, { soldAt: PTB_DAY_MS, grossCents: 300 });
    await s.as.mutation(api.sales.setSaleEvent, { saleId, eventId: null });

    const trail = await s.as.query(api.finances.financeAuditTrail, {
      subjectType: "sale",
      subjectId: saleId,
    });
    expect(trail).toEqual([]);
  });

  test("a viewer is rejected (FORBIDDEN)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedPerson(s);
    await grantRole(s, personId, "viewer");
    const eventId = await seedEvent(s);
    const saleId = await seedSale(s, { soldAt: PTB_DAY_MS, grossCents: 300 });

    await expect(
      s.as.mutation(api.sales.setSaleEvent, { saleId, eventId }),
    ).rejects.toThrow(ConvexError);
    expect((await run(s.t, (ctx) => ctx.db.get(saleId)))?.eventId).toBeUndefined();
  });
});
