import { afterEach, describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import type { Doc, Id } from "../_generated/dataModel";

/**
 * Givebutter sync (PR B) tests. The apply mutation is the pure, testable core:
 * mirror ticket-type synthesis, order/ticket/RSVP creation, idempotent re-apply,
 * check-in reconciliation, batched rollup math, and the money invariant (only
 * rollups + soldCount + rsvps ever move). Plus the throttle, the cron date gate,
 * the action's no-key no-op, campaign id/code/slug resolution, and the
 * transactions→tickets two-sweep join (there is no campaign-scoped tickets
 * endpoint — see the file header on `givebutterSync.ts`).
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

  test("an existing ACTIVE native tier of the same name absorbs the synced sale (no mirror minted)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    await seedPage(s, eventId);
    const nativeId = (await s.as.mutation(api.ticketing.createTicketType, {
      eventId,
      name: "General Admission",
      priceCents: 2500,
    })) as Id<"ticketTypes">;

    const res = await apply(s, eventId, [
      gbTicket({
        externalId: "1",
        ticketTypeName: "general admission", // normalized match, different case
        attendeeName: "Ada Guest",
        email: "ada@example.com",
        priceCents: 2500,
      }),
    ]);
    expect(res).toMatchObject({ inserted: 1, reconciled: 0, skipped: 0 });

    // No mirror minted — exactly the one native type, untouched isActive.
    const types = await rows(s, "ticketTypes", eventId);
    expect(types).toHaveLength(1);
    expect(types[0]).toMatchObject({
      _id: nativeId,
      isActive: true,
      soldCount: 1,
    });
    expect(types[0].externalProvider).toBeUndefined();

    const orders = await rows(s, "ticketOrders", eventId);
    expect(orders[0].items[0].ticketTypeId).toBe(nativeId);
    const tickets = await rows(s, "tickets", eventId);
    expect(tickets[0].ticketTypeId).toBe(nativeId);
  });

  test("an INACTIVE native tier of the same name is NOT matched — falls back to a mirror", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    await seedPage(s, eventId);
    await s.as.mutation(api.ticketing.createTicketType, {
      eventId,
      name: "General Admission",
      priceCents: 2500,
    });
    const [offType] = await rows(s, "ticketTypes", eventId);
    await run(s.t, (ctx) =>
      ctx.db.patch(offType._id, { isActive: false, updatedAt: Date.now() }),
    );

    await apply(s, eventId, [
      gbTicket({
        externalId: "1",
        ticketTypeName: "General Admission",
        priceCents: 2500,
      }),
    ]);

    const types = await rows(s, "ticketTypes", eventId);
    expect(types).toHaveLength(2); // the off native tier + a fresh mirror
    const mirror = types.find((tt) => tt.externalProvider === "givebutter");
    expect(mirror).toMatchObject({ isActive: false });
    const orders = await rows(s, "ticketOrders", eventId);
    expect(orders[0].items[0].ticketTypeId).toBe(mirror!._id);
  });

  test("promoting an old mirror via setTicketTypeSellable makes it the native match for later syncs", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    await seedPage(s, eventId);

    // First sync: no native tier yet → mints a mirror.
    await apply(s, eventId, [
      gbTicket({ externalId: "1", ticketTypeName: "GA", priceCents: 2500 }),
    ]);
    const [mirror] = await rows(s, "ticketTypes", eventId);
    expect(mirror.externalProvider).toBe("givebutter");

    // Admin promotes it to sellable.
    await s.as.mutation(api.ticketing.setTicketTypeSellable, {
      ticketTypeId: mirror._id,
    });

    // A later sync now matches the promoted tier natively — no second mirror.
    await apply(s, eventId, [
      gbTicket({ externalId: "2", ticketTypeName: "GA", priceCents: 2500 }),
    ]);
    const types = await rows(s, "ticketTypes", eventId);
    expect(types).toHaveLength(1);
    expect(types[0]).toMatchObject({
      _id: mirror._id,
      isActive: true,
      soldCount: 2,
    });
    expect(types[0].externalProvider).toBeUndefined();
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

  test("listRsvpsAdmin reports ticketCount 2 for a buyer with two applied tickets, 0 for a plain RSVP", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const pageId = await seedPage(s, eventId);
    await s.as.mutation(api.ticketing.updatePage, {
      pageId,
      patch: { published: true },
    });

    // Same buyer, two admissions synced from Givebutter (two externalIds).
    await apply(s, eventId, [
      gbTicket({ externalId: "multi-1", email: "pair@example.com" }),
      gbTicket({ externalId: "multi-2", email: "pair@example.com" }),
    ]);
    // A guest who just RSVP'd, no tickets at all.
    await s.as.mutation(api.ticketing.submitRsvp, {
      slug: (await pageRow(s, eventId))!.slug,
      name: "Plain Rsvp",
      email: "plain@example.com",
      status: "going",
    });

    const admin = await s.as.query(api.ticketing.listRsvpsAdmin, { eventId });
    const buyer = admin.find((r) => r.email === "pair@example.com");
    const plain = admin.find((r) => r.email === "plain@example.com");
    expect(buyer?.ticketCount).toBe(2);
    expect(plain?.ticketCount).toBe(0);
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

    // The transaction sweep used the RESOLVED numeric id, not the raw slug
    // (there is no campaign-scoped tickets endpoint to hit directly).
    expect(calledUrls.some((u) => u.includes("/transactions"))).toBe(true);
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

  test("a numeric campaign id validates via GET /v1/campaigns/{id} and skips the list lookup", async () => {
    process.env.GIVEBUTTER_API_KEY = "test_key";
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    await seedPage(s, eventId, "686283");

    const calledUrls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      calledUrls.push(url);
      if (url.endsWith("/campaigns/686283")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { id: 686283 } }),
          text: async () => "{}",
        };
      }
      // Transactions come back empty → the ticket sweep is skipped entirely.
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

    expect(calledUrls.some((u) => u.endsWith("/campaigns/686283"))).toBe(true);
    expect(calledUrls.some((u) => u.endsWith("/v1/campaigns"))).toBe(false);
    expect(calledUrls.some((u) => u.includes("/transactions"))).toBe(true);
    // No matching transactions → no reason to ever hit /v1/tickets.
    expect(calledUrls.some((u) => u.includes("/tickets"))).toBe(false);
    expect((await pageRow(s, eventId))?.givebutterCampaignId).toBe("686283");
  });

  test("numeric value 404s on GET /v1/campaigns/{id} but matches a campaign CODE via the list — resolves and self-heals", async () => {
    process.env.GIVEBUTTER_API_KEY = "test_key";
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    // "686283" LOOKS numeric but is actually this campaign's CODE, not its id
    // (an all-digit code is legal per Givebutter).
    await seedPage(s, eventId, "686283");

    const calledUrls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      calledUrls.push(url);
      if (url.endsWith("/campaigns/686283")) {
        return {
          ok: true,
          status: 404,
          json: async () => ({}),
          text: async () => "{}",
        };
      }
      if (url.endsWith("/v1/campaigns")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [{ id: 999111, code: "686283", slug: "some-other-slug" }],
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

    const page = await pageRow(s, eventId);
    expect(page?.givebutterCampaignId).toBe("999111");
    expect(page?.givebutterLastSyncError).toBeUndefined();
    expect(calledUrls.some((u) => u.endsWith("/campaigns/686283"))).toBe(true);
    expect(calledUrls.some((u) => u.endsWith("/v1/campaigns"))).toBe(true);
    expect(calledUrls.some((u) => u.includes("/transactions"))).toBe(true);
  });

  test("HTTP error looking up /v1/campaigns/{id} (not a 404) surfaces the status", async () => {
    process.env.GIVEBUTTER_API_KEY = "test_key";
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    await seedPage(s, eventId, "686283");

    globalThis.fetch = (async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async () => "server error",
    })) as unknown as typeof fetch;

    await expect(
      t.action(internal.givebutterSync.syncGivebutterCampaign, { eventId }),
    ).resolves.toBeNull();

    const page = await pageRow(s, eventId);
    expect(page?.givebutterLastSyncError).toBe(
      'HTTP 500 looking up Givebutter campaign "686283".',
    );
  });
});

// ── Transactions → tickets two-sweep join (no campaign-scoped tickets
// endpoint exists — see the file header on `givebutterSync.ts`) ─────────────
describe("transactions to tickets join", () => {
  const realFetch = globalThis.fetch;
  const originalKey = process.env.GIVEBUTTER_API_KEY;

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (originalKey === undefined) delete process.env.GIVEBUTTER_API_KEY;
    else process.env.GIVEBUTTER_API_KEY = originalKey;
  });

  test("sweeps transactions then tickets, skipping refunded and other-campaign transactions", async () => {
    process.env.GIVEBUTTER_API_KEY = "test_key";
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    await seedPage(s, eventId, "686283");

    const calledUrls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      calledUrls.push(url);
      if (url.endsWith("/campaigns/686283")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { id: 686283 } }),
          text: async () => "{}",
        };
      }
      if (url.includes("/transactions")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [
              { id: "t1", campaign_id: 686283, refunded: false },
              { id: "t2", campaign_id: "686283", refunded: "false" },
              { id: "t3", campaign_id: 999999, refunded: false }, // other campaign
              { id: "t4", campaign_id: 686283, refunded: true }, // refunded
            ],
            links: { next: null },
          }),
          text: async () => "{}",
        };
      }
      if (url.includes("/tickets")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [
              {
                id: 101,
                transaction_id: "t1",
                email: "one@x.com",
                price: 25,
                title: "GA",
                created_at: new Date().toISOString(),
              },
              {
                id: 102,
                transaction_id: "t2",
                email: "two@x.com",
                price: 25,
                title: "GA",
                created_at: new Date().toISOString(),
              },
              {
                // Belongs to a transaction from ANOTHER campaign — must be excluded.
                id: 103,
                transaction_id: "t3",
                email: "three@x.com",
                price: 25,
                title: "GA",
                created_at: new Date().toISOString(),
              },
              {
                // Belongs to a REFUNDED transaction — must be excluded.
                id: 104,
                transaction_id: "t4",
                email: "four@x.com",
                price: 25,
                title: "GA",
                created_at: new Date().toISOString(),
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

    const orders = await rows(s, "ticketOrders", eventId);
    expect(orders).toHaveLength(2);
    expect(orders.map((o) => o.externalRef).sort()).toEqual([
      "gb:ticket:101",
      "gb:ticket:102",
    ]);
    expect(await rows(s, "tickets", eventId)).toHaveLength(2);
    expect(await rows(s, "rsvps", eventId)).toHaveLength(2);

    const page = await pageRow(s, eventId);
    expect(page).toMatchObject({
      ticketsSoldCount: 2,
      revenueCents: 5000,
      goingCount: 2,
    });
    expect(page?.givebutterLastSyncError).toBeUndefined();

    expect(calledUrls.some((u) => u.includes("/transactions"))).toBe(true);
    expect(calledUrls.some((u) => u.includes("/tickets"))).toBe(true);
  });

  test("HTTP error on /v1/transactions is recorded on the page", async () => {
    process.env.GIVEBUTTER_API_KEY = "test_key";
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    await seedPage(s, eventId, "686283");

    globalThis.fetch = (async (url: string) => {
      if (url.endsWith("/campaigns/686283")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { id: 686283 } }),
          text: async () => "{}",
        };
      }
      if (url.includes("/transactions")) {
        return {
          ok: false,
          status: 500,
          json: async () => ({}),
          text: async () => "server error",
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

    const page = await pageRow(s, eventId);
    expect(page?.givebutterLastSyncError).toContain(
      "HTTP 500 fetching Givebutter transactions.",
    );
  });

  test("HTTP error on /v1/tickets is recorded on the page (no misleading campaign-id hint)", async () => {
    process.env.GIVEBUTTER_API_KEY = "test_key";
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    await seedPage(s, eventId, "686283");

    globalThis.fetch = (async (url: string) => {
      if (url.endsWith("/campaigns/686283")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { id: 686283 } }),
          text: async () => "{}",
        };
      }
      if (url.includes("/transactions")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [{ id: "t1", campaign_id: 686283, refunded: false }],
            links: { next: null },
          }),
          text: async () => "{}",
        };
      }
      if (url.includes("/tickets")) {
        return {
          ok: false,
          status: 503,
          json: async () => ({}),
          text: async () => "unavailable",
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

    const page = await pageRow(s, eventId);
    expect(page?.givebutterLastSyncError).toContain(
      "HTTP 503 fetching Givebutter tickets.",
    );
  });

  test("ticket pagination via links.next is followed — both pages applied", async () => {
    process.env.GIVEBUTTER_API_KEY = "test_key";
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    await seedPage(s, eventId, "686283");

    const ticketsPage2Url = "https://api.givebutter.com/v1/tickets?page=2";
    globalThis.fetch = (async (url: string) => {
      if (url.endsWith("/campaigns/686283")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { id: 686283 } }),
          text: async () => "{}",
        };
      }
      if (url.includes("/transactions")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [
              { id: "t1", campaign_id: 686283, refunded: false },
              { id: "t2", campaign_id: 686283, refunded: false },
            ],
            links: { next: null },
          }),
          text: async () => "{}",
        };
      }
      if (url === ticketsPage2Url) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [
              {
                id: 202,
                transaction_id: "t2",
                email: "two@x.com",
                price: 10,
                title: "GA",
                created_at: new Date().toISOString(),
              },
            ],
            links: { next: null },
          }),
          text: async () => "{}",
        };
      }
      if (url.includes("/tickets")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [
              {
                id: 201,
                transaction_id: "t1",
                email: "one@x.com",
                price: 10,
                title: "GA",
                created_at: new Date().toISOString(),
              },
            ],
            links: { next: ticketsPage2Url },
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

    const orders = await rows(s, "ticketOrders", eventId);
    expect(orders).toHaveLength(2);
    const page = await pageRow(s, eventId);
    expect(page).toMatchObject({ ticketsSoldCount: 2, revenueCents: 2000 });
  });

  test("an account-wide transaction sweep that hits the page cap records a truncation warning", async () => {
    process.env.GIVEBUTTER_API_KEY = "test_key";
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    await seedPage(s, eventId, "686283");

    // Transactions ALWAYS advertise another page — the sweep must stop at the
    // cap and the sync must surface "counts may be incomplete" instead of
    // reporting clean success with silently under-counted rollups.
    globalThis.fetch = (async (url: string) => {
      if (url.endsWith("/campaigns/686283")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { id: 686283 } }),
          text: async () => "{}",
        };
      }
      if (url.includes("/transactions")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [{ id: `t-${url}`, campaign_id: 686283, refunded: false }],
            links: { next: `${url.split("?")[0]}?page=2` },
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

    const page = await pageRow(s, eventId);
    expect(page?.givebutterLastSyncError).toContain("counts may be incomplete");
    expect(page?.givebutterLastSyncError).toContain("transactions");
  });

  test("a polluted transactions links.next is sanitized to ?page=N (live-API 400 regression)", async () => {
    process.env.GIVEBUTTER_API_KEY = "test_key";
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    await seedPage(s, eventId, "686283");

    // Givebutter's real /v1/transactions paginator leaks Laravel model
    // attributes into links.next; following it verbatim gets HTTP 400. The
    // mock enforces exactly that: junk params → 400, clean ?page=2 → data.
    const pollutedNext =
      "https://api.givebutter.com/v1/transactions?apiKey%5Bincrementing%5D=1&keyable%5Bexists%5D=1&page=2";
    globalThis.fetch = (async (url: string) => {
      if (url.endsWith("/campaigns/686283")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { id: 686283 } }),
          text: async () => "{}",
        };
      }
      if (url.includes("apiKey")) {
        return {
          ok: false,
          status: 400,
          json: async () => ({}),
          text: async () => "The api key.incrementing field is prohibited.",
        };
      }
      if (url === "https://api.givebutter.com/v1/transactions?page=2") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [{ id: "t2", campaign_id: 686283, status: "succeeded" }],
            links: { next: null },
          }),
          text: async () => "{}",
        };
      }
      if (url.includes("/transactions")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [{ id: "t1", campaign_id: 686283, status: "succeeded" }],
            links: { next: pollutedNext },
          }),
          text: async () => "{}",
        };
      }
      if (url.includes("/tickets")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: ["t1", "t2"].map((txn, i) => ({
              id: 300 + i,
              transaction_id: txn,
              email: `${txn}@x.com`,
              price: 25,
              title: "GA",
              created_at: new Date().toISOString(),
            })),
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

    // Both transaction pages were reached (page 2 via the SANITIZED url), so
    // both tickets joined and no error was recorded.
    const page = await pageRow(s, eventId);
    expect(page?.givebutterLastSyncError).toBeUndefined();
    expect(page).toMatchObject({ ticketsSoldCount: 2 });
  });

  test("refunds are recognized in every live encoding: status, flat flag, nested sub-transactions", async () => {
    process.env.GIVEBUTTER_API_KEY = "test_key";
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    await seedPage(s, eventId, "686283");

    globalThis.fetch = (async (url: string) => {
      if (url.endsWith("/campaigns/686283")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { id: 686283 } }),
          text: async () => "{}",
        };
      }
      if (url.includes("/transactions")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [
              // Live payload shape: no flat `refunded`; nested carries it.
              {
                id: "ok1",
                campaign_id: 686283,
                status: "succeeded",
                transactions: [{ refunded: false }],
              },
              {
                id: "r-status",
                campaign_id: 686283,
                status: "refunded",
                transactions: [{ refunded: false }],
              },
              {
                id: "r-nested",
                campaign_id: 686283,
                status: "succeeded",
                transactions: [{ refunded: true }],
              },
              { id: "r-flat", campaign_id: 686283, refunded: "true" },
            ],
            links: { next: null },
          }),
          text: async () => "{}",
        };
      }
      if (url.includes("/tickets")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: ["ok1", "r-status", "r-nested", "r-flat"].map((txn, i) => ({
              id: 400 + i,
              transaction_id: txn,
              email: `${txn}@x.com`,
              price: 25,
              title: "GA",
              created_at: new Date().toISOString(),
            })),
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

    // Only the non-refunded transaction's ticket lands.
    const orders = await rows(s, "ticketOrders", eventId);
    expect(orders).toHaveLength(1);
    expect(orders[0].externalRef).toBe("gb:ticket:400");
  });
});

// ── Givebutter DONATIONS (the gift portion of a transaction) ─────────────────
//
// A transaction's donation line items roll into the event's Given total
// (`externalGiftsCents`), Revenue stays ticket-only, and re-running is
// idempotent (dedup on the transaction id). See the MONEY INVARIANT header +
// `applyGivebutterDonations` / `donationCentsFromTransaction` on
// givebutterSync.ts.

type GbDonation = {
  externalId: string;
  donationCents: number;
  donorName: string;
  email: string | null;
  phone: string | null;
  receivedAt: number;
};

function gbDonation(
  over: Partial<GbDonation> & { externalId: string },
): GbDonation {
  return {
    donationCents: 5000,
    donorName: "Gwen Giver",
    email: null,
    phone: null,
    receivedAt: Date.now(),
    ...over,
  };
}

const giftRows = (s: ChapterSetup, eventId: Id<"events">) =>
  run(s.t, (ctx) =>
    ctx.db
      .query("gifts")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .collect(),
  ) as Promise<Doc<"gifts">[]>;

function applyDonations(
  s: ChapterSetup,
  eventId: Id<"events">,
  donations: GbDonation[],
) {
  return s.t.mutation(internal.givebutterSync.applyGivebutterDonations, {
    eventId,
    donations,
  });
}

describe("applyGivebutterDonations", () => {
  test("a pure donation raises Given (externalGiftsCents), records a gift, and creates no ticket rows", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    await seedPage(s, eventId);

    const res = await applyDonations(s, eventId, [
      gbDonation({
        externalId: "txn_1",
        donationCents: 5000,
        email: "gwen@x.com",
      }),
    ]);
    expect(res).toMatchObject({ inserted: 1, skipped: 0 });

    const page = await pageRow(s, eventId);
    expect(page?.externalGiftsCents).toBe(5000);
    expect(page?.externalGiftsCount).toBe(1);
    // Revenue (ticket-only) is untouched.
    expect(page?.revenueCents).toBe(0);
    expect(page?.ticketsSoldCount).toBe(0);

    // The donation path creates NO ticket-side rows.
    expect(await rows(s, "ticketOrders", eventId)).toHaveLength(0);
    expect(await rows(s, "tickets", eventId)).toHaveLength(0);

    const gifts = await giftRows(s, eventId);
    expect(gifts).toHaveLength(1);
    expect(gifts[0]).toMatchObject({
      amountCents: 5000,
      method: "givebutter",
      externalRef: "txn_1",
      eventId,
    });
    expect(gifts[0].donationId).toBeUndefined();
  });

  test("re-applying the same transaction id is idempotent (Given unchanged, no duplicate gift)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    await seedPage(s, eventId);

    const d = gbDonation({
      externalId: "txn_dup",
      donationCents: 2500,
      email: "dup@x.com",
    });
    await applyDonations(s, eventId, [d]);
    const res2 = await applyDonations(s, eventId, [d]);
    expect(res2).toMatchObject({ inserted: 0, skipped: 1 });

    expect((await pageRow(s, eventId))?.externalGiftsCents).toBe(2500);
    expect((await pageRow(s, eventId))?.externalGiftsCount).toBe(1);
    expect(await giftRows(s, eventId)).toHaveLength(1);
  });

  test("a non-positive donation is skipped (no gift, no rollup)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    await seedPage(s, eventId);

    const res = await applyDonations(s, eventId, [
      gbDonation({ externalId: "txn_zero", donationCents: 0 }),
    ]);
    expect(res).toMatchObject({ inserted: 0, skipped: 1 });
    expect((await pageRow(s, eventId))?.externalGiftsCents ?? 0).toBe(0);
    expect(await giftRows(s, eventId)).toHaveLength(0);
  });
});

// Action-level: derive the donation from a transaction's `line_items` and prove
// the ticket/donation split never overlaps, refunds contribute nothing, and a
// full re-sync is idempotent.
describe("Givebutter donation sync (transactions → gifts)", () => {
  const realFetch = globalThis.fetch;
  const originalKey = process.env.GIVEBUTTER_API_KEY;

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (originalKey === undefined) delete process.env.GIVEBUTTER_API_KEY;
    else process.env.GIVEBUTTER_API_KEY = originalKey;
  });

  /** A fetch mock: campaign validate 200, then the given transactions + tickets
   *  payloads, everything else empty. */
  function mockGb(opts: {
    transactions: unknown[];
    tickets?: unknown[];
  }): void {
    globalThis.fetch = (async (url: string) => {
      if (url.endsWith("/campaigns/686283")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { id: 686283 } }),
          text: async () => "{}",
        };
      }
      if (url.includes("/transactions")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: opts.transactions, links: { next: null } }),
          text: async () => "{}",
        };
      }
      if (url.includes("/tickets")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: opts.tickets ?? [],
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
  }

  test("a pure-donation transaction lifts Given, writes a gift, and creates no ticket rows", async () => {
    process.env.GIVEBUTTER_API_KEY = "test_key";
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    await seedPage(s, eventId, "686283");

    // Live shape: line_items nested under `transactions[]` sub-transactions.
    // Pure donation $100 (+ $2.24 fee) → donation = 100.
    mockGb({
      transactions: [
        {
          id: "d1",
          campaign_id: 686283,
          status: "succeeded",
          first_name: "Dana",
          last_name: "Donor",
          email: "dana@x.com",
          created_at: new Date().toISOString(),
          transactions: [
            {
              refunded: false,
              line_items: [
                { subtype: "donation", total: 100 },
                { subtype: "fee", total: 2.24 },
              ],
            },
          ],
        },
      ],
      tickets: [],
    });

    await expect(
      t.action(internal.givebutterSync.syncGivebutterCampaign, { eventId }),
    ).resolves.toBeNull();

    const page = await pageRow(s, eventId);
    // Donation portion only (fee line excluded); Revenue untouched.
    expect(page?.externalGiftsCents).toBe(10000);
    expect(page?.externalGiftsCount).toBe(1);
    expect(page?.revenueCents).toBe(0);
    expect(page?.ticketsSoldCount).toBe(0);
    expect(page?.givebutterLastSyncError).toBeUndefined();

    expect(await rows(s, "ticketOrders", eventId)).toHaveLength(0);
    const gifts = await giftRows(s, eventId);
    expect(gifts).toHaveLength(1);
    expect(gifts[0]).toMatchObject({ amountCents: 10000, externalRef: "d1" });
  });

  test("a mixed ticket+donation transaction: Revenue gets the ticket, Given gets the donation, no overlap", async () => {
    process.env.GIVEBUTTER_API_KEY = "test_key";
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    await seedPage(s, eventId, "686283");

    // Live shape: ticket $25 + donation $75 + fee $3.30 (amount=100) → the
    // donation is exactly 75; the $25 ticket is Revenue, never Given.
    mockGb({
      transactions: [
        {
          id: "m1",
          campaign_id: 686283,
          status: "succeeded",
          first_name: "Mel",
          last_name: "Mixed",
          email: "mel@x.com",
          created_at: new Date().toISOString(),
          transactions: [
            {
              refunded: false,
              line_items: [
                { subtype: "ticket", total: 25 },
                { subtype: "donation", total: 75 },
                { subtype: "fee", total: 3.3 },
              ],
            },
          ],
        },
      ],
      tickets: [
        {
          id: 501,
          transaction_id: "m1",
          email: "mel@x.com",
          price: 25,
          title: "GA",
          created_at: new Date().toISOString(),
        },
      ],
    });

    await expect(
      t.action(internal.givebutterSync.syncGivebutterCampaign, { eventId }),
    ).resolves.toBeNull();

    const page = await pageRow(s, eventId);
    expect(page?.revenueCents).toBe(2500); // ticket price only
    expect(page?.ticketsSoldCount).toBe(1);
    expect(page?.externalGiftsCents).toBe(7500); // donation only ($75)
    expect(page?.externalGiftsCount).toBe(1);

    // Exactly one ticket order and one gift — the same dollar is never in both.
    expect(await rows(s, "ticketOrders", eventId)).toHaveLength(1);
    const gifts = await giftRows(s, eventId);
    expect(gifts).toHaveLength(1);
    expect(gifts[0]).toMatchObject({ amountCents: 7500, externalRef: "m1" });
  });

  test("re-running the full sync is idempotent — Revenue and Given unchanged", async () => {
    process.env.GIVEBUTTER_API_KEY = "test_key";
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    await seedPage(s, eventId, "686283");

    mockGb({
      transactions: [
        {
          id: "m1",
          campaign_id: 686283,
          status: "succeeded",
          email: "mel@x.com",
          created_at: new Date().toISOString(),
          transactions: [
            {
              refunded: false,
              line_items: [
                { subtype: "ticket", total: 25 },
                { subtype: "donation", total: 75 },
              ],
            },
          ],
        },
      ],
      tickets: [
        {
          id: 501,
          transaction_id: "m1",
          email: "mel@x.com",
          price: 25,
          title: "GA",
          created_at: new Date().toISOString(),
        },
      ],
    });

    await t.action(internal.givebutterSync.syncGivebutterCampaign, { eventId });
    await t.action(internal.givebutterSync.syncGivebutterCampaign, { eventId });

    const page = await pageRow(s, eventId);
    expect(page?.revenueCents).toBe(2500);
    expect(page?.ticketsSoldCount).toBe(1);
    expect(page?.externalGiftsCents).toBe(7500);
    expect(page?.externalGiftsCount).toBe(1);
    expect(await rows(s, "ticketOrders", eventId)).toHaveLength(1);
    expect(await giftRows(s, eventId)).toHaveLength(1);
  });

  test("a refunded transaction contributes no donation", async () => {
    process.env.GIVEBUTTER_API_KEY = "test_key";
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    await seedPage(s, eventId, "686283");

    mockGb({
      transactions: [
        {
          id: "r1",
          campaign_id: 686283,
          status: "refunded",
          email: "ref@x.com",
          created_at: new Date().toISOString(),
          transactions: [
            {
              refunded: true,
              line_items: [{ subtype: "donation", total: 50 }],
            },
          ],
        },
      ],
      tickets: [],
    });

    await expect(
      t.action(internal.givebutterSync.syncGivebutterCampaign, { eventId }),
    ).resolves.toBeNull();

    const page = await pageRow(s, eventId);
    expect(page?.externalGiftsCents ?? 0).toBe(0);
    expect(page?.externalGiftsCount ?? 0).toBe(0);
    expect(await giftRows(s, eventId)).toHaveLength(0);
  });

  test("a pure-ticket transaction adds no donation (Given stays 0)", async () => {
    process.env.GIVEBUTTER_API_KEY = "test_key";
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    await seedPage(s, eventId, "686283");

    // Ticket $25 + fee $1.06, NO donation line → donation = 0.
    mockGb({
      transactions: [
        {
          id: "k1",
          campaign_id: 686283,
          status: "succeeded",
          email: "buyer@x.com",
          created_at: new Date().toISOString(),
          transactions: [
            {
              refunded: false,
              line_items: [
                { subtype: "ticket", total: 25 },
                { subtype: "fee", total: 1.06 },
              ],
            },
          ],
        },
      ],
      tickets: [
        {
          id: 601,
          transaction_id: "k1",
          email: "buyer@x.com",
          price: 25,
          title: "GA",
          created_at: new Date().toISOString(),
        },
      ],
    });

    await expect(
      t.action(internal.givebutterSync.syncGivebutterCampaign, { eventId }),
    ).resolves.toBeNull();

    const page = await pageRow(s, eventId);
    // Ticket lands in Revenue; nothing lands in Given; no gift row.
    expect(page?.revenueCents).toBe(2500);
    expect(page?.ticketsSoldCount).toBe(1);
    expect(page?.externalGiftsCents ?? 0).toBe(0);
    expect(page?.externalGiftsCount ?? 0).toBe(0);
    expect(await giftRows(s, eventId)).toHaveLength(0);
  });
});
