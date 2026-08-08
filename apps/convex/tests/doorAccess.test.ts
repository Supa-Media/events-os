import { describe, expect, test, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import { api, internal } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import {
  activeDoorGrantFor,
  hasCheckInAccess,
  requireCheckInAccess,
  requireDoorGrantManage,
} from "../lib/ticketingAccess";

/**
 * Per-event door access for outside volunteers (`doorGrants` +
 * `doorAccess.ts`) — the membership-free third grant path in
 * `requireCheckInAccess`, the event-page grant/revoke surface, the
 * `accessAllowlist` coupling (rows stamped `grantedVia: "door"`), and the
 * door-only guardrails (`completeOnboarding` refusal, `profiles.me.doorOnly`).
 * Mirrors `ticketingAccess.test.ts`'s shape: raw inserts via `run`, resolver
 * calls through an identity-scoped client's `.run(...)`.
 */

// ── Setup helpers (mirrors ticketingAccess.test.ts) ─────────────────────────

/** Minimal template + event so the resolver has a real target. */
async function seedEvent(s: ChapterSetup): Promise<Id<"events">> {
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
      name: "Worship Night on the Pier",
      eventDate: now + 14 * 24 * 60 * 60 * 1000,
      status: "planning",
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
  });
}

interface DoorGuest {
  as: ChapterSetup["as"];
  userId: Id<"users">;
  email: string;
}

/**
 * An OUTSIDE volunteer: a users row + an active `accessAllowlist` row and
 * deliberately NO `userChapters` membership and NO `people` row — the state a
 * door-granted guest signs in as. `stamped` marks the allowlist row
 * `grantedVia: "door"` (what `doorAccess.grant` produces).
 */
async function setupDoorGuest(
  s: ChapterSetup,
  email: string,
  opts: { stamped?: boolean } = {},
): Promise<DoorGuest> {
  const userId = await run(s.t, async (ctx) => {
    const userId = await ctx.db.insert("users", { email });
    await ctx.db.insert("accessAllowlist", {
      email,
      isActive: true,
      createdAt: Date.now(),
      ...(opts.stamped ? { grantedVia: "door" as const } : {}),
    });
    return userId;
  });
  const as = s.t.withIdentity({ subject: `${userId}|session`, issuer: "test" });
  return { as, userId, email };
}

/** Raw `doorGrants` insert — for resolver tests that bypass the mutation. */
async function insertGrant(
  s: ChapterSetup,
  eventId: Id<"events">,
  email: string,
  isActive = true,
): Promise<Id<"doorGrants">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("doorGrants", {
      eventId,
      chapterId: s.chapterId,
      email,
      isActive,
      createdAt: Date.now(),
    }),
  );
}

/** A real (paid-for-free) ticket so `checkInTicket` can succeed end to end. */
async function seedTicket(s: ChapterSetup, eventId: Id<"events">): Promise<string> {
  return run(s.t, async (ctx) => {
    const now = Date.now();
    const ticketTypeId = await ctx.db.insert("ticketTypes", {
      eventId,
      chapterId: s.chapterId,
      name: "Community (Free)",
      priceCents: 0,
      currency: "usd",
      soldCount: 1,
      sortOrder: 0,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });
    const orderId = await ctx.db.insert("ticketOrders", {
      eventId,
      chapterId: s.chapterId,
      name: "Ben Buyer",
      email: "ben@example.com",
      items: [
        { ticketTypeId, name: "Community (Free)", quantity: 1, unitPriceCents: 0 },
      ],
      totalCents: 0,
      currency: "usd",
      status: "paid",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("tickets", {
      eventId,
      chapterId: s.chapterId,
      orderId,
      ticketTypeId,
      ticketTypeName: "Community (Free)",
      attendeeName: "Ben Buyer",
      attendeeEmail: "ben@example.com",
      code: "PW-TEST-CODE",
      status: "valid",
      createdAt: now,
    });
    return "PW-TEST-CODE";
  });
}

async function allowlistRow(s: ChapterSetup, email: string) {
  return run(s.t, (ctx) =>
    ctx.db
      .query("accessAllowlist")
      .withIndex("by_email", (q) => q.eq("email", email))
      .first(),
  );
}

async function grantRows(s: ChapterSetup, eventId: Id<"events">) {
  return run(s.t, (ctx) =>
    ctx.db
      .query("doorGrants")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .collect(),
  );
}

// ── Milestone 1: doorGrants + activeDoorGrantFor ────────────────────────────

describe("activeDoorGrantFor", () => {
  test("finds an active grant by (event, email); inactive and other-event grants don't count", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const otherEventId = await seedEvent(s);
    await insertGrant(s, eventId, "vol@example.com");
    await insertGrant(s, otherEventId, "revoked@example.com", false);

    const hit = await run(t, (ctx) => activeDoorGrantFor(ctx, eventId, "vol@example.com"));
    expect(hit?.email).toBe("vol@example.com");

    // Normalizes the probe email the same way grants are stored.
    const fuzzy = await run(t, (ctx) => activeDoorGrantFor(ctx, eventId, "  Vol@Example.COM "));
    expect(fuzzy?.email).toBe("vol@example.com");

    expect(await run(t, (ctx) => activeDoorGrantFor(ctx, otherEventId, "vol@example.com"))).toBeNull();
    expect(await run(t, (ctx) => activeDoorGrantFor(ctx, otherEventId, "revoked@example.com"))).toBeNull();
    expect(await run(t, (ctx) => activeDoorGrantFor(ctx, eventId, null))).toBeNull();
  });
});

// ── Milestone 2: the membership-free door path in requireCheckInAccess ──────

describe("requireCheckInAccess door path", () => {
  test("a chapterless allowlisted guest with an active grant is admitted, end to end", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const guest = await setupDoorGuest(s, "vol@example.com", { stamped: true });
    await insertGrant(s, eventId, guest.email);
    const code = await seedTicket(s, eventId);

    expect(await guest.as.run((ctx) => hasCheckInAccess(ctx, eventId))).toBe(true);
    const event = await guest.as.run((ctx) => requireCheckInAccess(ctx, eventId));
    expect(event._id).toBe(eventId);

    // The real mutation works for the guest — the whole point of the feature.
    const ok = await guest.as.mutation(api.ticketing.checkInTicket, { eventId, code });
    expect(ok.result).toBe("ok");
  });

  test("a revoked grant does not admit", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const guest = await setupDoorGuest(s, "vol@example.com", { stamped: true });
    await insertGrant(s, eventId, guest.email, false);

    expect(await guest.as.run((ctx) => hasCheckInAccess(ctx, eventId))).toBe(false);
    await expect(guest.as.run((ctx) => requireCheckInAccess(ctx, eventId))).rejects.toThrow();
  });

  test("a grant on a DIFFERENT event does not admit here", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const otherEventId = await seedEvent(s);
    const guest = await setupDoorGuest(s, "vol@example.com", { stamped: true });
    await insertGrant(s, otherEventId, guest.email);

    expect(await guest.as.run((ctx) => hasCheckInAccess(ctx, eventId))).toBe(false);
  });
});

// ── The door guest list (manual check-in from the attendee list) ────────────

describe("listCheckInAttendees", () => {
  test("a door guest sees a VIEW-ONLY guest list — no ticket codes, no emails; outsiders can't", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const code = await seedTicket(s, eventId);
    const guest = await setupDoorGuest(s, "vol@example.com", { stamped: true });
    await insertGrant(s, eventId, guest.email);

    const list = await guest.as.query(api.ticketing.listCheckInAttendees, { eventId });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      attendeeName: "Ben Buyer",
      ticketTypeName: "Community (Free)",
      status: "valid",
      checkedInAt: null,
      // This event doesn't use guest teams, so there's nothing to show.
      teamId: null,
      teamName: null,
      teamColor: null,
    });
    // View-only is the contract: no `code` (admission must prove possession
    // of the ticket — the guest supplies it), no email, no order linkage.
    // The team fields are safe to add here — they're what the volunteer is at
    // the door to hand out, and neither one admits anybody.
    expect(Object.keys(list[0]).sort()).toEqual(
      [
        "_id",
        "attendeeName",
        "checkedInAt",
        "status",
        "teamColor",
        "teamId",
        "teamName",
        "ticketTypeName",
      ].sort(),
    );

    // A check-in (code supplied BY the guest, scanned or typed) flips the
    // row reactively.
    const ok = await guest.as.mutation(api.ticketing.checkInTicket, { eventId, code });
    expect(ok.result).toBe("ok");
    const after = await guest.as.query(api.ticketing.listCheckInAttendees, { eventId });
    expect(after[0].status).toBe("checked_in");
    expect(after[0].checkedInAt).not.toBeNull();

    // No grant (a different signed-in guest) → refused.
    const stranger = await setupDoorGuest(s, "stranger@example.com");
    await expect(
      stranger.as.query(api.ticketing.listCheckInAttendees, { eventId }),
    ).rejects.toThrow();
  });
});

// ── Milestone 3: requireDoorGrantManage ─────────────────────────────────────

describe("requireDoorGrantManage", () => {
  test("a chapter member may manage; a door guest and a foreign-chapter member may not", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);

    const event = await s.as.run((ctx) => requireDoorGrantManage(ctx, eventId));
    expect(event._id).toBe(eventId);

    const guest = await setupDoorGuest(s, "vol@example.com", { stamped: true });
    await insertGrant(s, eventId, guest.email);
    await expect(guest.as.run((ctx) => requireDoorGrantManage(ctx, eventId))).rejects.toThrow();

    const other = await setupChapter(t, {
      email: "other@publicworship.life",
      chapterName: "Other City",
    });
    await expect(
      other.as.run((ctx) => requireDoorGrantManage(ctx, eventId)),
    ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
  });
});

// ── Milestone 4: grant / listForEvent / revoke + allowlist coupling ─────────

describe("doorAccess.grant / revoke / listForEvent", () => {
  test("grant normalizes the email, records the grant, and stamps a fresh allowlist row", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);

    await s.as.mutation(api.doorAccess.grant, { eventId, email: "  Vol@Example.COM " });

    const grants = await grantRows(s, eventId);
    expect(grants).toHaveLength(1);
    expect(grants[0].email).toBe("vol@example.com");
    expect(grants[0].isActive).not.toBe(false);

    const row = await allowlistRow(s, "vol@example.com");
    expect(row?.isActive).toBe(true);
    expect(row?.grantedVia).toBe("door");
  });

  test("granting a publicworship.life email records the grant but never touches the allowlist", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);

    await s.as.mutation(api.doorAccess.grant, { eventId, email: "helper@publicworship.life" });

    expect(await grantRows(s, eventId)).toHaveLength(1);
    expect(await allowlistRow(s, "helper@publicworship.life")).toBeNull();
  });

  test("re-granting reactivates the same row instead of duplicating", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);

    await s.as.mutation(api.doorAccess.grant, { eventId, email: "vol@example.com" });
    const [first] = await grantRows(s, eventId);
    await s.as.mutation(api.doorAccess.revoke, { grantId: first._id });
    await s.as.mutation(api.doorAccess.grant, { eventId, email: "vol@example.com" });

    const grants = await grantRows(s, eventId);
    expect(grants).toHaveLength(1);
    expect(grants[0].isActive).not.toBe(false);
  });

  test("an ACTIVE un-stamped allowlist row (general guest) is left untouched by a door grant", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    await run(t, (ctx) =>
      ctx.db.insert("accessAllowlist", {
        email: "guest@example.com",
        isActive: true,
        createdAt: Date.now(),
      }),
    );

    await s.as.mutation(api.doorAccess.grant, { eventId, email: "guest@example.com" });

    const row = await allowlistRow(s, "guest@example.com");
    expect(row?.grantedVia).toBeUndefined();
  });

  test("revoking the LAST active grant deactivates a door-stamped allowlist row — and only that kind", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventA = await seedEvent(s);
    const eventB = await seedEvent(s);

    await s.as.mutation(api.doorAccess.grant, { eventId: eventA, email: "vol@example.com" });
    await s.as.mutation(api.doorAccess.grant, { eventId: eventB, email: "vol@example.com" });

    const [grantA] = await grantRows(s, eventA);
    await s.as.mutation(api.doorAccess.revoke, { grantId: grantA._id });
    // Another event still has an active grant — access stays on.
    expect((await allowlistRow(s, "vol@example.com"))?.isActive).toBe(true);

    const [grantB] = await grantRows(s, eventB);
    await s.as.mutation(api.doorAccess.revoke, { grantId: grantB._id });
    // Last one gone — the door-stamped row shuts off.
    expect((await allowlistRow(s, "vol@example.com"))?.isActive).toBe(false);

    // An un-stamped (general guest) row is NEVER deactivated by door revokes.
    await run(t, (ctx) =>
      ctx.db.insert("accessAllowlist", {
        email: "guest@example.com",
        isActive: true,
        createdAt: Date.now(),
      }),
    );
    await s.as.mutation(api.doorAccess.grant, { eventId: eventA, email: "guest@example.com" });
    const generals = await grantRows(s, eventA);
    const general = generals.find((g) => g.email === "guest@example.com")!;
    await s.as.mutation(api.doorAccess.revoke, { grantId: general._id });
    expect((await allowlistRow(s, "guest@example.com"))?.isActive).toBe(true);
  });

  test("listForEvent returns the event's grants; a door guest can't manage at all", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    await s.as.mutation(api.doorAccess.grant, { eventId, email: "vol@example.com" });

    const listed = await s.as.query(api.doorAccess.listForEvent, { eventId });
    expect(listed).toHaveLength(1);
    expect(listed[0].email).toBe("vol@example.com");
    expect(listed[0].isActive).toBe(true);

    const guest = await setupDoorGuest(s, "vol@example.com", { stamped: true });
    await expect(guest.as.query(api.doorAccess.listForEvent, { eventId })).rejects.toThrow();
    await expect(
      guest.as.mutation(api.doorAccess.grant, { eventId, email: "friend@example.com" }),
    ).rejects.toThrow();
    await expect(
      guest.as.mutation(api.doorAccess.revoke, { grantId: listed[0]._id }),
    ).rejects.toThrow();
  });
});

// ── Milestone 5: completeOnboarding refuses door-stamped guests ─────────────

describe("completeOnboarding door guard", () => {
  test("a door-stamped guest cannot onboard; an un-stamped general guest still can", async () => {
    const t = newT();
    const s = await setupChapter(t);

    const doorGuest = await setupDoorGuest(s, "vol@example.com", { stamped: true });
    await expect(
      doorGuest.as.mutation(api.profiles.completeOnboarding, {
        name: "Vol",
        phone: "5550001111",
        chapterId: s.chapterId,
      }),
    ).rejects.toMatchObject({ data: { code: "DOOR_ONLY" } });

    const general = await setupDoorGuest(s, "guest@example.com"); // un-stamped
    await general.as.mutation(api.profiles.completeOnboarding, {
      name: "Guest",
      phone: "5550002222",
      chapterId: s.chapterId,
    });
    const membership = await run(t, (ctx) =>
      ctx.db
        .query("userChapters")
        .withIndex("by_userId", (q) => q.eq("userId", general.userId))
        .first(),
    );
    expect(membership?.chapterId).toBe(s.chapterId);
  });
});

// ── Milestone 6: profiles.me.doorOnly + myDoorEvents ────────────────────────

describe("doorOnly + myDoorEvents", () => {
  test("a door guest is doorOnly; a member with a grant is not", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const guest = await setupDoorGuest(s, "vol@example.com", { stamped: true });
    await insertGrant(s, eventId, guest.email);
    await insertGrant(s, eventId, s.email);

    const guestMe = await guest.as.query(api.profiles.me, {});
    expect(guestMe?.doorOnly).toBe(true);
    expect(guestMe?.onboarded).toBe(false);

    const memberMe = await s.as.query(api.profiles.me, {});
    expect(memberMe?.doorOnly).toBe(false);
  });

  test("myDoorEvents lists only the caller's active grants, soonest first", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventA = await seedEvent(s);
    const eventB = await seedEvent(s);
    const eventC = await seedEvent(s);
    await run(t, async (ctx) => {
      // Spread the dates so the sort is observable (B before A).
      await ctx.db.patch(eventA, { eventDate: Date.now() + 20 * 24 * 60 * 60 * 1000 });
      await ctx.db.patch(eventB, { eventDate: Date.now() + 5 * 24 * 60 * 60 * 1000 });
    });
    const guest = await setupDoorGuest(s, "vol@example.com", { stamped: true });
    await insertGrant(s, eventA, guest.email);
    await insertGrant(s, eventB, guest.email);
    await insertGrant(s, eventC, guest.email, false); // revoked
    await insertGrant(s, eventC, "someone-else@example.com");

    const events = await guest.as.query(api.doorAccess.myDoorEvents, {});
    expect(events.map((e) => e.eventId)).toEqual([eventB, eventA]);
    expect(events[0].name).toBe("Worship Night on the Pier");
    expect(events[0].chapterName).toBe("New York");
  });
});

// ── The grant email's guest sign-in link ────────────────────────────────────

describe("sendDoorGrantEmail — the guest sign-in link", () => {
  const realFetch = globalThis.fetch;

  test("with APP_URL set, the email's button links straight into guest sign-in, pre-filled with the volunteer's email", async () => {
    const prevAppUrl = process.env.APP_URL;
    const prevResendKey = process.env.RESEND_API_KEY;
    process.env.APP_URL = "https://app.publicworship.life";
    process.env.RESEND_API_KEY = "resend_test_key";
    try {
      const t = newT();
      const s = await setupChapter(t);
      void s;

      const sent: { to: string; subject: string; html: string }[] = [];
      globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
        const body = init?.body ? JSON.parse(init.body) : {};
        sent.push({ to: body.to, subject: body.subject, html: body.html });
        return { ok: true, status: 200, text: async () => "{}" };
      }) as unknown as typeof fetch;

      await t.action(internal.doorAccess.sendDoorGrantEmail, {
        email: "vol@example.com",
        eventName: "Worship Night on the Pier",
      });

      expect(sent).toHaveLength(1);
      // `[^>]*` before `href`: the themed button helper (`lib/emailShell.ts#emailButton`)
      // emits `class="pw-btn"` first, so attribute order isn't part of the contract.
      expect(sent[0].html).toMatch(
        /<a[^>]*href="https:\/\/app\.publicworship\.life\/login\?guestEmail=vol%40example\.com"[^>]*>/,
      );
    } finally {
      globalThis.fetch = realFetch;
      if (prevAppUrl === undefined) delete process.env.APP_URL;
      else process.env.APP_URL = prevAppUrl;
      if (prevResendKey === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = prevResendKey;
    }
  });

  test("with APP_URL unset, the email still sends (no dead link) and degrades LOUDLY via console.error", async () => {
    const prevAppUrl = process.env.APP_URL;
    const prevResendKey = process.env.RESEND_API_KEY;
    delete process.env.APP_URL;
    process.env.RESEND_API_KEY = "resend_test_key";
    try {
      const t = newT();
      const s = await setupChapter(t);
      void s;

      const sent: { to: string; subject: string; html: string }[] = [];
      globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
        const body = init?.body ? JSON.parse(init.body) : {};
        sent.push({ to: body.to, subject: body.subject, html: body.html });
        return { ok: true, status: 200, text: async () => "{}" };
      }) as unknown as typeof fetch;
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await t.action(internal.doorAccess.sendDoorGrantEmail, {
        email: "vol@example.com",
        eventName: "Worship Night on the Pier",
      });

      expect(sent).toHaveLength(1); // transactional — still sends
      expect(sent[0].html).not.toMatch(/<a[^>]*href=/); // no anchor at all, in any attribute order
      expect(sent[0].html).toContain("Sign in as a guest");
      expect(
        errorSpy.mock.calls.some((c) => String(c[0]).includes("APP_URL is unset")),
      ).toBe(true);
      errorSpy.mockRestore();
    } finally {
      globalThis.fetch = realFetch;
      if (prevAppUrl === undefined) delete process.env.APP_URL;
      else process.env.APP_URL = prevAppUrl;
      if (prevResendKey === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = prevResendKey;
    }
  });
});
