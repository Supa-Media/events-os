import { afterEach, describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import type { Doc, Id } from "../_generated/dataModel";

/**
 * Givebutter sync (PR B) tests. The apply mutation is the pure, testable core:
 * mirror ticket-type synthesis, order/ticket/RSVP creation, idempotent re-apply,
 * check-in reconciliation, batched rollup math, and the money invariant (only
 * rollups + soldCount + rsvps ever move). Plus the throttle, the cron date gate,
 * and the action's no-key no-op.
 */

type GbTicket = {
  externalId: string;
  ticketTypeName: string;
  attendeeName: string;
  email: string | null;
  phone: string | null;
  priceCents: number;
  checkedInAt: number | null;
  createdAt: number;
};

/** Build a normalized ticket (the shape the action hands the apply mutation). */
function gbTicket(over: Partial<GbTicket> & { externalId: string }): GbTicket {
  return {
    ticketTypeName: "General Admission",
    attendeeName: "Ada Guest",
    email: null,
    phone: null,
    priceCents: 2500,
    checkedInAt: null,
    createdAt: Date.now(),
    ...over,
  };
}

async function seedEvent(
  s: ChapterSetup,
  opts: { eventDate?: number } = {},
): Promise<Id<"events">> {
  return await run(s.t, async (ctx) => {
    const now = Date.now();
    const eventTypeId = await ctx.db.insert("eventTypes", {
      chapterId: s.chapterId,
      name: "Worship Night",
      slug: "worship-night",
      version: 1,
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
    return await ctx.db.insert("events", {
      chapterId: s.chapterId,
      eventTypeId,
      templateVersion: 1,
      name: "Field Day",
      eventDate: opts.eventDate ?? now + 14 * 24 * 60 * 60 * 1000,
      status: "planning",
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
  });
}

/** Create a page for the event and set its Givebutter campaign id. */
async function seedPage(
  s: ChapterSetup,
  eventId: Id<"events">,
  campaignId?: string,
): Promise<Id<"eventPages">> {
  const pageId = (await s.as.mutation(api.ticketing.createPage, {
    eventId,
  })) as Id<"eventPages">;
  if (campaignId) {
    await s.as.mutation(api.ticketing.updatePage, {
      pageId,
      patch: { givebutterCampaignId: campaignId },
    });
  }
  return pageId;
}

function apply(s: ChapterSetup, eventId: Id<"events">, tickets: GbTicket[]) {
  return s.t.mutation(internal.givebutterSync.applyGivebutterTickets, {
    eventId,
    tickets,
  });
}

const pageRow = (s: ChapterSetup, eventId: Id<"events">) =>
  run(s.t, (ctx) =>
    ctx.db
      .query("eventPages")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .unique(),
  );
const rows = <T extends "ticketTypes" | "ticketOrders" | "tickets" | "rsvps">(
  s: ChapterSetup,
  table: T,
  eventId: Id<"events">,
) =>
  run(s.t, (ctx) =>
    ctx.db
      .query(table)
      .withIndex("by_event", (q: any) => q.eq("eventId", eventId))
      .collect(),
  ) as Promise<Doc<T>[]>;

describe("applyGivebutterTickets", () => {
  test("new ticket creates inactive mirror type + paid order + ticket + RSVP with exact bumps", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    await seedPage(s, eventId);

    const res = await apply(s, eventId, [
      gbTicket({
        externalId: "1",
        ticketTypeName: "GA",
        attendeeName: "Ada Guest",
        email: "Ada@Example.com",
        priceCents: 2500,
      }),
    ]);
    expect(res).toMatchObject({ inserted: 1, reconciled: 0, skipped: 0 });

    const types = await rows(s, "ticketTypes", eventId);
    expect(types).toHaveLength(1);
    expect(types[0]).toMatchObject({
      name: "GA",
      isActive: false,
      externalProvider: "givebutter",
      soldCount: 1,
      priceCents: 2500,
    });

    const orders = await rows(s, "ticketOrders", eventId);
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({
      status: "paid",
      externalProvider: "givebutter",
      externalRef: "gb:ticket:1",
      totalCents: 2500,
    });
    expect(orders[0].stripeCheckoutSessionId).toBeUndefined();
    expect(orders[0].stripePaymentIntentId).toBeUndefined();
    expect(orders[0].rsvpId).toBeTruthy();

    const tickets = await rows(s, "tickets", eventId);
    expect(tickets).toHaveLength(1);
    expect(tickets[0].status).toBe("valid");
    expect(tickets[0].code).toMatch(/^PW-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);

    const rsvps = await rows(s, "rsvps", eventId);
    expect(rsvps).toHaveLength(1);
    expect(rsvps[0]).toMatchObject({
      email: "ada@example.com",
      status: "going",
      source: "ticket",
      emailVerified: true,
    });

    const page = await pageRow(s, eventId);
    expect(page).toMatchObject({
      ticketsSoldCount: 1,
      revenueCents: 2500,
      goingCount: 1,
    });
  });

  test("re-applying the same ticket id is a pure no-op (no duplicate rows)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    await seedPage(s, eventId);
    const ticket = gbTicket({ externalId: "7", email: "b@example.com" });

    await apply(s, eventId, [ticket]);
    const res2 = await apply(s, eventId, [ticket]);
    expect(res2).toMatchObject({ inserted: 0, reconciled: 0 });

    expect(await rows(s, "ticketOrders", eventId)).toHaveLength(1);
    expect(await rows(s, "tickets", eventId)).toHaveLength(1);
    expect(await rows(s, "ticketTypes", eventId)).toHaveLength(1);
    const page = await pageRow(s, eventId);
    expect(page).toMatchObject({ ticketsSoldCount: 1, revenueCents: 2500 });
  });

  test("check-in reconciliation flips valid→checked_in and never reverses", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    await seedPage(s, eventId);

    await apply(s, eventId, [gbTicket({ externalId: "9", email: "c@x.com" })]);
    expect((await rows(s, "tickets", eventId))[0].status).toBe("valid");

    const checkedAt = Date.now();
    const rec = await apply(s, eventId, [
      gbTicket({ externalId: "9", email: "c@x.com", checkedInAt: checkedAt }),
    ]);
    expect(rec).toMatchObject({ inserted: 0, reconciled: 1 });
    let ticket = (await rows(s, "tickets", eventId))[0];
    expect(ticket.status).toBe("checked_in");
    expect(ticket.checkedInAt).toBe(checkedAt);

    // A later sync that no longer reports the check-in must NOT reverse it.
    await apply(s, eventId, [
      gbTicket({ externalId: "9", email: "c@x.com", checkedInAt: null }),
    ]);
    ticket = (await rows(s, "tickets", eventId))[0];
    expect(ticket.status).toBe("checked_in");
    expect(ticket.checkedInAt).toBe(checkedAt);
    // Rollups untouched by reconciliation.
    expect(await pageRow(s, eventId)).toMatchObject({
      ticketsSoldCount: 1,
      revenueCents: 2500,
    });
  });

  test("a ticket already checked-in in Givebutter lands checked_in", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    await seedPage(s, eventId);
    const at = Date.now();
    await apply(s, eventId, [
      gbTicket({ externalId: "5", email: "d@x.com", checkedInAt: at }),
    ]);
    const ticket = (await rows(s, "tickets", eventId))[0];
    expect(ticket.status).toBe("checked_in");
    expect(ticket.checkedInAt).toBe(at);
  });

  test("existing RSVP (same email) upgrades to going/ticket without a duplicate; counters shift", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const pageId = await seedPage(s, eventId);
    // Seed a pre-existing "maybe" RSVP + reflect it in the page counter.
    await run(s.t, async (ctx) => {
      const page = (await ctx.db.get(pageId))!;
      await ctx.db.insert("rsvps", {
        eventId,
        chapterId: s.chapterId,
        name: "Eve Early",
        email: "eve@example.com",
        status: "maybe",
        token: "seed-token-eve",
        source: "rsvp",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await ctx.db.patch(pageId, { maybeCount: page.maybeCount + 1 });
    });

    await apply(s, eventId, [
      gbTicket({ externalId: "3", email: "Eve@example.com", priceCents: 1000 }),
    ]);

    const rsvps = await rows(s, "rsvps", eventId);
    expect(rsvps).toHaveLength(1); // no duplicate
    expect(rsvps[0]).toMatchObject({
      status: "going",
      source: "ticket",
      emailVerified: true,
    });
    const page = await pageRow(s, eventId);
    expect(page).toMatchObject({
      goingCount: 1,
      maybeCount: 0,
      ticketsSoldCount: 1,
      revenueCents: 1000,
    });
  });

  test("email-less ticket: order + ticket + name-only RSVP (post-PR-A schema)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    await seedPage(s, eventId);

    const res = await apply(s, eventId, [
      gbTicket({
        externalId: "42",
        email: null,
        phone: "555-0100",
        attendeeName: "No Email Nell",
        priceCents: 500,
      }),
    ]);
    expect(res.inserted).toBe(1);
    expect(await rows(s, "ticketOrders", eventId)).toHaveLength(1);
    expect(await rows(s, "tickets", eventId)).toHaveLength(1);
    // rsvps.email is optional (PR A) → a name/phone-only RSVP is created, but
    // WITHOUT emailVerified (no address to prove).
    const rsvps = await rows(s, "rsvps", eventId);
    expect(rsvps).toHaveLength(1);
    expect(rsvps[0]).toMatchObject({
      name: "No Email Nell",
      phone: "555-0100",
      status: "going",
      source: "ticket",
    });
    expect(rsvps[0].email).toBeUndefined();
    expect(rsvps[0].emailVerified).toBeUndefined();
    const page = await pageRow(s, eventId);
    expect(page).toMatchObject({
      ticketsSoldCount: 1,
      revenueCents: 500,
      goingCount: 1,
    });
  });

  test("batched page patch equals the sum of per-ticket expectations", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    await seedPage(s, eventId);

    await apply(s, eventId, [
      gbTicket({ externalId: "a", ticketTypeName: "GA", email: "a@x.com", priceCents: 1000 }),
      gbTicket({ externalId: "b", ticketTypeName: "GA", email: "b@x.com", priceCents: 1000 }),
      gbTicket({ externalId: "c", ticketTypeName: "VIP", email: "c@x.com", priceCents: 5000 }),
    ]);

    const types = await rows(s, "ticketTypes", eventId);
    expect(types).toHaveLength(2);
    const ga = types.find((tt) => tt.name === "GA")!;
    const vip = types.find((tt) => tt.name === "VIP")!;
    expect(ga.soldCount).toBe(2);
    expect(vip.soldCount).toBe(1);

    const page = await pageRow(s, eventId);
    expect(page).toMatchObject({
      ticketsSoldCount: 3,
      revenueCents: 7000, // 1000 + 1000 + 5000
      goingCount: 3,
    });
    expect(await rows(s, "tickets", eventId)).toHaveLength(3);
  });

  test("money invariant: never writes transactions/donations, and no rsvpEmailCodes", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    await seedPage(s, eventId);
    await apply(s, eventId, [
      gbTicket({ externalId: "m1", email: "m1@x.com" }),
      gbTicket({ externalId: "m2", email: null }),
    ]);

    const txns = await run(s.t, (ctx) => ctx.db.query("transactions").collect());
    const donations = await run(s.t, (ctx) =>
      ctx.db.query("donations").collect(),
    );
    const codes = await run(s.t, (ctx) =>
      ctx.db.query("rsvpEmailCodes").collect(),
    );
    expect(txns).toHaveLength(0);
    expect(donations).toHaveLength(0);
    expect(codes).toHaveLength(0);
  });

  test("native door scanner (checkInTicket) works on a synced ticket code", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    await seedPage(s, eventId);
    await apply(s, eventId, [gbTicket({ externalId: "door", email: "z@x.com" })]);
    const code = (await rows(s, "tickets", eventId))[0].code;

    const out = await s.as.mutation(api.ticketing.checkInTicket, {
      eventId,
      code,
    });
    expect(out.result).toBe("ok");
    expect((await rows(s, "tickets", eventId))[0].status).toBe("checked_in");
  });
});

describe("requestGivebutterSync", () => {
  test("throttles a re-request within the window", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    await seedPage(s, eventId, "686283");

    const first = await s.as.mutation(api.givebutterSync.requestGivebutterSync, {
      eventId,
    });
    expect(first.scheduled).toBe(true);
    const second = await s.as.mutation(
      api.givebutterSync.requestGivebutterSync,
      { eventId },
    );
    expect(second).toMatchObject({ scheduled: false, reason: "throttled" });
  });

  test("throws when no campaign id is set", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    await seedPage(s, eventId); // no campaign id
    await expect(
      s.as.mutation(api.givebutterSync.requestGivebutterSync, { eventId }),
    ).rejects.toThrow();
  });
});

describe("cron date gating", () => {
  test("listActiveGivebutterPages includes live events, excludes long-ended ones", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const now = Date.now();
    const liveEvent = await seedEvent(s, { eventDate: now });
    const deadEvent = await seedEvent(s, {
      eventDate: now - 30 * 24 * 60 * 60 * 1000,
    });
    await seedPage(s, liveEvent, "686283");
    await seedPage(s, deadEvent, "502858");

    const active = await t.query(
      internal.givebutterSync.listActiveGivebutterPages,
      {},
    );
    const ids = active.map((a) => a.eventId);
    expect(ids).toContain(liveEvent);
    expect(ids).not.toContain(deadEvent);
  });
});

describe("no-key degrade", () => {
  const originalKey = process.env.GIVEBUTTER_API_KEY;
  afterEach(() => {
    if (originalKey === undefined) delete process.env.GIVEBUTTER_API_KEY;
    else process.env.GIVEBUTTER_API_KEY = originalKey;
  });

  test("syncGivebutterCampaign no-ops (no rows, no stamp) without GIVEBUTTER_API_KEY", async () => {
    delete process.env.GIVEBUTTER_API_KEY;
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    await seedPage(s, eventId, "686283");

    await expect(
      t.action(internal.givebutterSync.syncGivebutterCampaign, { eventId }),
    ).resolves.toBeNull();

    expect(await rows(s, "ticketOrders", eventId)).toHaveLength(0);
    expect((await pageRow(s, eventId))?.givebutterLastSyncedAt).toBeUndefined();
  });
});

// ── Campaign id/code/slug resolution (Attendance G) ──────────────────────────
//
// The UI hint says "found in your Givebutter campaign URL", which yields a
// SLUG — not the numeric id the tickets endpoint requires — so a non-numeric
// configured value must be resolved via `/v1/campaigns` before the tickets
// fetch, and a numeric value must skip that lookup entirely (current/fast
// path, unchanged).
describe("campaign id/code/slug resolution", () => {
  const realFetch = globalThis.fetch;
  const originalKey = process.env.GIVEBUTTER_API_KEY;

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (originalKey === undefined) delete process.env.GIVEBUTTER_API_KEY;
    else process.env.GIVEBUTTER_API_KEY = originalKey;
  });

  test("a non-numeric slug resolves via /v1/campaigns and self-heals the stored id", async () => {
    process.env.GIVEBUTTER_API_KEY = "test_key";
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    await seedPage(s, eventId, "public-worship-field-day-um8he0");

    const calledUrls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      calledUrls.push(url);
      if (url.includes("/v1/campaigns") && !url.includes("/tickets")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [
              {
                id: 686283,
                code: "UM8HE0",
                slug: "public-worship-field-day-um8he0",
              },
            ],
            links: { next: null },
          }),
          text: async () => "{}",
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [], links: { next: null } }),
        text: async () => "{}",
      };
    }) as unknown as typeof fetch;

    await expect(
      t.action(internal.givebutterSync.syncGivebutterCampaign, { eventId }),
    ).resolves.toBeNull();

    // Self-healed: the page's stored value is now the resolved numeric id.
    const page = await pageRow(s, eventId);
    expect(page?.givebutterCampaignId).toBe("686283");
    expect(page?.givebutterLastSyncError).toBeUndefined();

    // The tickets fetch used the RESOLVED numeric id, not the raw slug.
    expect(
      calledUrls.some((u) => u.includes("/campaigns/686283/tickets")),
    ).toBe(true);
  });

  test("case-insensitive match against a campaign's code", async () => {
    process.env.GIVEBUTTER_API_KEY = "test_key";
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    // Lowercase input; Givebutter's code is uppercase — must still match.
    await seedPage(s, eventId, "um8he0");

    globalThis.fetch = (async (url: string) => {
      if (url.includes("/v1/campaigns") && !url.includes("/tickets")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [{ id: 686283, code: "UM8HE0", slug: "field-day-um8he0" }],
            links: { next: null },
          }),
          text: async () => "{}",
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [], links: { next: null } }),
        text: async () => "{}",
      };
    }) as unknown as typeof fetch;

    await expect(
      t.action(internal.givebutterSync.syncGivebutterCampaign, { eventId }),
    ).resolves.toBeNull();

    expect((await pageRow(s, eventId))?.givebutterCampaignId).toBe("686283");
  });

  test("an unknown value stamps a friendly not-found error, not a bare HTTP 404", async () => {
    process.env.GIVEBUTTER_API_KEY = "test_key";
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    await seedPage(s, eventId, "nonexistent-slug");

    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [], links: { next: null } }),
      text: async () => "{}",
    })) as unknown as typeof fetch;

    await expect(
      t.action(internal.givebutterSync.syncGivebutterCampaign, { eventId }),
    ).resolves.toBeNull();

    const page = await pageRow(s, eventId);
    expect(page?.givebutterLastSyncError).toBe(
      "Campaign not found — enter the numeric ID, code, or slug from Givebutter.",
    );
    // No match → no self-heal; the stored value is left as the admin entered it.
    expect(page?.givebutterCampaignId).toBe("nonexistent-slug");
  });

  test("a numeric campaign id skips the /v1/campaigns lookup entirely", async () => {
    process.env.GIVEBUTTER_API_KEY = "test_key";
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    await seedPage(s, eventId, "686283");

    const calledUrls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      calledUrls.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [], links: { next: null } }),
        text: async () => "{}",
      };
    }) as unknown as typeof fetch;

    await expect(
      t.action(internal.givebutterSync.syncGivebutterCampaign, { eventId }),
    ).resolves.toBeNull();

    expect(calledUrls).toHaveLength(1);
    expect(calledUrls[0]).toContain("/campaigns/686283/tickets");
    expect(calledUrls.some((u) => u.endsWith("/v1/campaigns"))).toBe(false);
    expect((await pageRow(s, eventId))?.givebutterCampaignId).toBe("686283");
  });
});
