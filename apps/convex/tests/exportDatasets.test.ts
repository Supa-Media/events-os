/// <reference types="vite/client" />
/**
 * Characterization tests for the giving/events/work/finance/academy export
 * builders (`lib/exportBuilders/{giving,eventsAndParticipation,work,finance,
 * academy}.ts`). Exercises the builder contract directly (`./types.ts`) —
 * never through the (not-yet-wired) runner — since a builder is defined to be
 * testable by calling it with a cursor.
 */
import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import type { Doc, Id } from "../_generated/dataModel";
import { givingBuilders } from "../lib/exportBuilders/giving";
import { eventsAndParticipationBuilders } from "../lib/exportBuilders/eventsAndParticipation";
import { workBuilders } from "../lib/exportBuilders/work";
import { financeBuilders } from "../lib/exportBuilders/finance";
import { academyBuilders } from "../lib/exportBuilders/academy";
import type { ExportBuilder, ExportBuilderContext } from "../lib/exportBuilders/types";

const ALL_BUILDERS: readonly ExportBuilder[] = [
  ...givingBuilders,
  ...eventsAndParticipationBuilders,
  ...workBuilders,
  ...financeBuilders,
  ...academyBuilders,
];

function builderFor(datasetId: string): ExportBuilder {
  const found = ALL_BUILDERS.find((b) => b.datasetId === datasetId);
  if (!found) throw new Error(`no builder registered for ${datasetId}`);
  return found;
}

function bctx(
  s: ChapterSetup,
  overrides: Partial<ExportBuilderContext> = {},
): ExportBuilderContext {
  return {
    scope: s.chapterId,
    chapterId: s.chapterId,
    filters: {},
    sections: new Set(),
    reach: { giving: true, finance: true },
    ...overrides,
  };
}

/** Walk a builder to completion with a small page size, collecting every row
 *  and the number of page() calls made — the shared engine behind the
 *  pagination-integrity and filtered-page tests below. One `run` transaction
 *  for the whole walk (each `page()` call still does exactly one
 *  `.paginate()`, per the contract — this just avoids a `run` per page). */
async function walkAll(
  s: ChapterSetup,
  builder: ExportBuilder,
  context: ExportBuilderContext,
  numItems: number,
  callCap = 50,
): Promise<{ rows: Record<string, unknown>[]; calls: number }> {
  return run(s.t, async (ctx) => {
    let cursor: string | null = null;
    let isDone = false;
    const rows: Record<string, unknown>[] = [];
    let calls = 0;
    while (!isDone) {
      calls += 1;
      if (calls > callCap) {
        throw new Error(`walkAll exceeded ${callCap} page() calls — looks stuck`);
      }
      const page = await builder.page(ctx, context, cursor, numItems);
      rows.push(...page.rows);
      cursor = page.cursor;
      isDone = page.isDone;
    }
    return { rows, calls };
  });
}

// ── Seed helpers (minimal valid rows per table) ──────────────────────────────

async function seedPerson(s: ChapterSetup, name: string): Promise<Id<"people">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("people", { chapterId: s.chapterId, name, createdAt: Date.now() }),
  );
}

async function seedDonor(
  s: ChapterSetup,
  over: Partial<Doc<"donors">> = {},
): Promise<Id<"donors">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("donors", {
      scope: s.chapterId,
      kind: "individual",
      name: "Test Donor",
      status: "active",
      lifetimeCents: 0,
      giftCount: 0,
      createdAt: Date.now(),
      ...over,
    }),
  );
}

async function seedGift(
  s: ChapterSetup,
  donorId: Id<"donors">,
  over: Partial<Doc<"gifts">> = {},
): Promise<Id<"gifts">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("gifts", {
      donorId,
      scope: s.chapterId,
      amountCents: 1000,
      currency: "usd",
      receivedAt: Date.now(),
      method: "cash",
      createdAt: Date.now(),
      ...over,
    }),
  );
}

async function seedPledge(
  s: ChapterSetup,
  donorId: Id<"donors">,
  over: Partial<Doc<"pledges">> = {},
): Promise<Id<"pledges">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("pledges", {
      donorId,
      scope: s.chapterId,
      amountCents: 2000,
      status: "active",
      origin: "stripe",
      createdAt: Date.now(),
      ...over,
    }),
  );
}

async function seedEventType(s: ChapterSetup): Promise<Id<"eventTypes">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("eventTypes", {
      chapterId: s.chapterId,
      name: "Sunday",
      slug: "sunday",
      version: 1,
      createdBy: s.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

async function seedEvent(
  s: ChapterSetup,
  eventTypeId: Id<"eventTypes">,
  over: Partial<Doc<"events">> = {},
): Promise<Id<"events">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("events", {
      chapterId: s.chapterId,
      eventTypeId,
      templateVersion: 1,
      name: "Test Event",
      eventDate: Date.now(),
      status: "planning",
      createdBy: s.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...over,
    }),
  );
}

async function seedRsvp(
  s: ChapterSetup,
  eventId: Id<"events">,
  over: Partial<Doc<"rsvps">> = {},
): Promise<Id<"rsvps">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("rsvps", {
      eventId,
      chapterId: s.chapterId,
      name: "Guest",
      status: "going",
      token: Math.random().toString(36),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...over,
    }),
  );
}

async function seedTicketOrder(
  s: ChapterSetup,
  eventId: Id<"events">,
  rsvpId: Id<"rsvps">,
  over: Partial<Doc<"ticketOrders">> = {},
): Promise<Id<"ticketOrders">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("ticketOrders", {
      eventId,
      chapterId: s.chapterId,
      rsvpId,
      name: "Guest",
      email: "guest@example.com",
      items: [],
      totalCents: 0,
      currency: "usd",
      status: "paid",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...over,
    }),
  );
}

async function seedTicket(
  s: ChapterSetup,
  eventId: Id<"events">,
  orderId: Id<"ticketOrders">,
  ticketTypeId: Id<"ticketTypes">,
  over: Partial<Doc<"tickets">> = {},
): Promise<Id<"tickets">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("tickets", {
      eventId,
      chapterId: s.chapterId,
      orderId,
      ticketTypeId,
      ticketTypeName: "GA",
      attendeeName: "Guest",
      attendeeEmail: "guest@example.com",
      code: Math.random().toString(36),
      status: "checked_in",
      checkedInAt: Date.now(),
      createdAt: Date.now(),
      ...over,
    }),
  );
}

async function seedTicketType(
  s: ChapterSetup,
  eventId: Id<"events">,
): Promise<Id<"ticketTypes">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("ticketTypes", {
      eventId,
      chapterId: s.chapterId,
      name: "GA",
      priceCents: 0,
      currency: "usd",
      soldCount: 0,
      sortOrder: 0,
      isActive: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

async function seedEngagement(
  s: ChapterSetup,
  eventId: Id<"events">,
  personId: Id<"people">,
  over: Partial<Doc<"engagements">> = {},
): Promise<Id<"engagements">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("engagements", {
      chapterId: s.chapterId,
      eventId,
      personId,
      type: "volunteer",
      service: "Welcome team",
      status: "confirmed",
      createdAt: Date.now(),
      ...over,
    }),
  );
}

async function seedEventItem(
  s: ChapterSetup,
  eventId: Id<"events">,
  over: Partial<Doc<"eventItems">> = {},
): Promise<Id<"eventItems">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("eventItems", {
      eventId,
      chapterId: s.chapterId,
      module: "planning_doc",
      title: "Book the room",
      order: 0,
      ...over,
    }),
  );
}

async function seedEventColumn(
  s: ChapterSetup,
  eventId: Id<"events">,
  module: string,
): Promise<void> {
  await run(s.t, (ctx) =>
    ctx.db.insert("eventColumns", {
      eventId,
      module,
      key: "status",
      label: "Status",
      kind: "system",
      type: "status",
      options: [
        { value: "done", label: "Done", isComplete: true },
        { value: "todo", label: "To do", isComplete: false },
      ],
      isVisible: true,
      order: 0,
    }),
  );
}

async function seedProject(
  s: ChapterSetup,
  over: Partial<Doc<"projects">> = {},
): Promise<Id<"projects">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("projects", {
      chapterId: s.chapterId,
      name: "Test Project",
      status: "in_progress",
      createdBy: s.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...over,
    }),
  );
}

async function seedFund(s: ChapterSetup): Promise<Id<"funds">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("funds", {
      chapterId: s.chapterId,
      name: "General Fund",
      restriction: "unrestricted",
      sortOrder: 0,
      createdAt: Date.now(),
    }),
  );
}

async function seedTransaction(
  s: ChapterSetup,
  over: Partial<Doc<"transactions">> = {},
): Promise<Id<"transactions">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: "manual",
      flow: "outflow",
      amountCents: 1000,
      postedAt: Date.now(),
      status: "unreviewed",
      createdAt: Date.now(),
      ...over,
    }),
  );
}

async function seedAcademyProgress(
  s: ChapterSetup,
  personId: Id<"people">,
  over: Partial<Doc<"academyProgress">> = {},
): Promise<Id<"academyProgress">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("academyProgress", {
      chapterId: s.chapterId,
      personId,
      sectionSlug: "welcome",
      ...over,
    }),
  );
}

// ── 1. columns() stability + row-keys-subset-of-columns, every builder ──────

describe("every export builder", () => {
  test("columns() is stable across two calls, for every builder", async () => {
    const t = newT();
    const s = await setupChapter(t);
    for (const b of ALL_BUILDERS) {
      const c1 = await run(s.t, (ctx) => b.columns(ctx, bctx(s)));
      const c2 = await run(s.t, (ctx) => b.columns(ctx, bctx(s)));
      expect(c2).toEqual(c1);
      expect(c1.length).toBeGreaterThan(0);
      // The builder's own stable id is always the first column.
      expect(c1[0].key).toMatch(/_id$/);
    }
  });

  test("every emitted row's keys are a subset of the declared columns, for every builder", async () => {
    const t = newT();
    const s = await setupChapter(t);

    // One fully-linked row per dataset, so every optional join path (person,
    // event, fund, category, ticket, engagement, ...) actually runs at least
    // once and can't silently emit a key with no matching column.
    const personId = await seedPerson(s, "Vera Volunteer");
    const donorId = await seedDonor(s, { personId, ownerPersonId: personId });
    await seedGift(s, donorId);
    await seedPledge(s, donorId);
    const eventTypeId = await seedEventType(s);
    const eventId = await seedEvent(s, eventTypeId, { ownerPersonId: personId });
    const rsvpId = await seedRsvp(s, eventId, { personId });
    const ticketTypeId = await seedTicketType(s, eventId);
    const orderId = await seedTicketOrder(s, eventId, rsvpId);
    await seedTicket(s, eventId, orderId, ticketTypeId);
    await seedEngagement(s, eventId, personId);
    await seedEventItem(s, eventId, { ownerPersonId: personId });
    await seedProject(s, { ownerPersonId: personId });
    const fundId = await seedFund(s);
    await seedTransaction(s, { fundId, personId });
    await seedAcademyProgress(s, personId, { passedAt: Date.now(), quizBestScore: 5 });

    for (const b of ALL_BUILDERS) {
      const columns = await run(s.t, (ctx) => b.columns(ctx, bctx(s)));
      const columnKeys = new Set(columns.map((c) => c.key));
      const page = await run(s.t, (ctx) => b.page(ctx, bctx(s), null, 100));
      expect(page.rows.length).toBeGreaterThan(0);
      for (const row of page.rows) {
        for (const key of Object.keys(row)) {
          expect(columnKeys.has(key)).toBe(true);
        }
      }
    }
  });
});

// ── 2. Money lands as dollars, not cents ─────────────────────────────────────

describe("money formatting", () => {
  test("gifts: amountCents 12345 exports as 123.45 dollars", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const donorId = await seedDonor(s);
    await seedGift(s, donorId, { amountCents: 12345 });

    const b = builderFor("gifts");
    const page = await run(s.t, (ctx) => b.page(ctx, bctx(s), null, 10));
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0].amount_dollars).toBe(123.45);
  });

  test("transactions: amountCents 250000 exports as 2500 dollars", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedTransaction(s, { amountCents: 250000 });

    const b = builderFor("transactions");
    const page = await run(s.t, (ctx) => b.page(ctx, bctx(s), null, 10));
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0].amount_dollars).toBe(2500);
  });

  test("donors: lifetimeCents 999 exports as 9.99 dollars", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedDonor(s, { lifetimeCents: 999 });

    const b = builderFor("donors");
    const page = await run(s.t, (ctx) => b.page(ctx, bctx(s), null, 10));
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0].lifetime_dollars).toBe(9.99);
  });
});

// ── 3. gifts dateRange: boundary-inclusive, outside-exclusive ───────────────

describe("gifts dateRange filter", () => {
  test("includes both boundary receivedAt values, excludes rows outside", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const donorId = await seedDonor(s);

    const from = 1_700_000_000_000;
    const to = 1_700_086_400_000; // from + 1 day

    const before = await seedGift(s, donorId, { receivedAt: from - 1 });
    const atFrom = await seedGift(s, donorId, { receivedAt: from });
    const middle = await seedGift(s, donorId, { receivedAt: (from + to) / 2 });
    const atTo = await seedGift(s, donorId, { receivedAt: to });
    const after = await seedGift(s, donorId, { receivedAt: to + 1 });

    const b = builderFor("gifts");
    const page = await run(s.t, (ctx) =>
      b.page(ctx, bctx(s, { filters: { from, to } }), null, 20),
    );
    const ids = page.rows.map((r) => r.gift_id);
    expect(new Set(ids)).toEqual(new Set([atFrom, middle, atTo]));
    expect(ids).not.toContain(before);
    expect(ids).not.toContain(after);
  });
});

// ── 4. Pagination integrity: every row exactly once across >= 3 pages ───────

describe("pagination integrity", () => {
  test("donors: 12 rows over pages of 5 returns every row exactly once, no dup/gap", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const ids: Id<"donors">[] = [];
    for (let i = 0; i < 12; i++) {
      ids.push(await seedDonor(s, { name: `Donor ${i}` }));
    }

    const b = builderFor("donors");
    const { rows, calls } = await walkAll(s, b, bctx(s), 5, 10);
    const seen = rows.map((r) => r.donor_id);

    expect(calls).toBe(3); // 5 + 5 + 2
    expect(seen).toHaveLength(12);
    expect(new Set(seen)).toEqual(new Set(ids));
  });
});

// ── 5. A fully-filtered page still advances and the walk completes ──────────

describe("filtered-out pages still advance", () => {
  test("donors: activeOnly drops every row, but the walk still terminates", async () => {
    const t = newT();
    const s = await setupChapter(t);
    for (let i = 0; i < 7; i++) {
      await seedDonor(s, { name: `Lapsed ${i}`, status: "lapsed" });
    }

    const b = builderFor("donors");
    const { rows, calls } = await walkAll(
      s,
      b,
      bctx(s, { filters: { activeOnly: true } }),
      3,
      10,
    );

    // 7 rows at 3 per page reads = 3 page() calls (3 + 3 + 1), every one of
    // which emits zero rows (every donor is "lapsed"), yet the walk completes.
    expect(calls).toBe(3);
    expect(rows).toHaveLength(0);
  });
});

// ── 6. Focused correctness checks on the trickier per-builder logic ────────

describe("tasks activeOnly", () => {
  test("drops an item whose status resolves isComplete via its status column", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventTypeId = await seedEventType(s);
    const eventId = await seedEvent(s, eventTypeId);
    await seedEventColumn(s, eventId, "planning_doc");
    await seedEventItem(s, eventId, { module: "planning_doc", title: "Done item", status: "done" });
    await seedEventItem(s, eventId, { module: "planning_doc", title: "Open item", status: "todo" });

    const b = builderFor("tasks");
    const page = await run(s.t, (ctx) =>
      b.page(ctx, bctx(s, { filters: { activeOnly: true } }), null, 10),
    );
    const titles = page.rows.map((r) => r.title);
    expect(titles).toEqual(["Open item"]);
  });
});

describe("event_participation", () => {
  test("resolves person, event, ticket check-in and volunteer role onto one row", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedPerson(s, "Vera Volunteer");
    const eventTypeId = await seedEventType(s);
    const eventId = await seedEvent(s, eventTypeId, { name: "Big Night" });
    const rsvpId = await seedRsvp(s, eventId, { personId, status: "going" });
    const ticketTypeId = await seedTicketType(s, eventId);
    const orderId = await seedTicketOrder(s, eventId, rsvpId);
    await seedTicket(s, eventId, orderId, ticketTypeId, { status: "checked_in" });
    await seedEngagement(s, eventId, personId, { service: "Sound booth" });

    const b = builderFor("event_participation");
    const page = await run(s.t, (ctx) => b.page(ctx, bctx(s), null, 10));
    expect(page.rows).toHaveLength(1);
    const row = page.rows[0];
    expect(row.person_id).toBe(personId);
    expect(row.person_name).toBe("Vera Volunteer");
    expect(row.event_id).toBe(eventId);
    expect(row.event_name).toBe("Big Night");
    expect(row.rsvp_status).toBe("going");
    expect(row.ticket_status).toBe("checked_in");
    expect(row.checked_in_at).not.toBe("");
    expect(row.volunteer_role).toBe("Sound booth");
  });

  test("excludes an archived rsvp (event switched RSVP -> ticketed)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventTypeId = await seedEventType(s);
    const eventId = await seedEvent(s, eventTypeId);
    await seedRsvp(s, eventId, { archivedAt: Date.now() });

    const b = builderFor("event_participation");
    const page = await run(s.t, (ctx) => b.page(ctx, bctx(s), null, 10));
    expect(page.rows).toHaveLength(0);
    expect(page.isDone).toBe(true);
  });
});

describe("pledges activeOnly", () => {
  test("drops canceled pledges only", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const donorId = await seedDonor(s);
    await seedPledge(s, donorId, { status: "active" });
    await seedPledge(s, donorId, { status: "canceled" });
    await seedPledge(s, donorId, { status: "past_due" });

    const b = builderFor("pledges");
    const page = await run(s.t, (ctx) =>
      b.page(ctx, bctx(s, { filters: { activeOnly: true } }), null, 10),
    );
    const statuses = page.rows.map((r) => r.status).sort();
    expect(statuses).toEqual(["active", "past_due"]);
  });
});
