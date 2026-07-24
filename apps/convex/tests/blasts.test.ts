import { describe, expect, test, vi } from "vitest";
import { ConvexError } from "convex/values";
import { api, internal } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";

/**
 * Blasts — host announcements. Covers the two things that decide who gets a
 * message: audience → recipient-set resolution (with email de-dup), and the
 * guardrails on sending (SMS not wired, empty body rejected).
 */

async function seedEventWithGuests(s: ChapterSetup): Promise<Id<"events">> {
  return await run(s.t, async (ctx) => {
    const now = Date.now();
    const eventTypeId = await ctx.db.insert("eventTypes", {
      chapterId: s.chapterId,
      name: "Night",
      slug: "night",
      version: 1,
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
    const eventId = await ctx.db.insert("events", {
      chapterId: s.chapterId,
      eventTypeId,
      templateVersion: 1,
      name: "Night",
      eventDate: now,
      status: "planning",
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
    const rsvp = (
      name: string,
      email: string,
      status: "going" | "maybe" | "not_going",
      source: "rsvp" | "ticket",
    ) =>
      ctx.db.insert("rsvps", {
        eventId,
        chapterId: s.chapterId,
        name,
        email,
        status,
        token: `tok-${name}`,
        source,
        createdAt: now,
        updatedAt: now,
      });
    await rsvp("Ann", "ann@example.com", "going", "rsvp");
    await rsvp("Ben", "ben@example.com", "going", "ticket");
    await rsvp("Cat", "cat@example.com", "maybe", "rsvp");
    await rsvp("Dan", "dan@example.com", "not_going", "rsvp");
    await rsvp("Ann2", "ann@example.com", "going", "ticket"); // duplicate email
    return eventId;
  });
}

async function insertBlast(
  s: ChapterSetup,
  eventId: Id<"events">,
  audience: "everyone" | "going" | "maybe" | "ticket_holders",
): Promise<Id<"blasts">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("blasts", {
      eventId,
      chapterId: s.chapterId,
      channel: "email",
      body: "hello",
      audience,
      status: "sending",
      createdBy: s.userId,
      createdAt: Date.now(),
    }),
  );
}

async function recipientsFor(
  s: ChapterSetup,
  eventId: Id<"events">,
  audience: "everyone" | "going" | "maybe" | "ticket_holders",
): Promise<string[]> {
  const blastId = await insertBlast(s, eventId, audience);
  const payload = await s.t.query(internal.blasts.getBlastPayload, { blastId });
  return (payload?.emails ?? []).sort();
}

describe("blast audience resolution", () => {
  test("'everyone' reaches every RSVP, de-duped by email", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEventWithGuests(s);
    expect(await recipientsFor(s, eventId, "everyone")).toEqual([
      "ann@example.com",
      "ben@example.com",
      "cat@example.com",
      "dan@example.com",
    ]);
  });

  test("'going' reaches only confirmed guests", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEventWithGuests(s);
    expect(await recipientsFor(s, eventId, "going")).toEqual([
      "ann@example.com",
      "ben@example.com",
    ]);
  });

  test("'maybe' reaches only maybes", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEventWithGuests(s);
    expect(await recipientsFor(s, eventId, "maybe")).toEqual(["cat@example.com"]);
  });

  test("'ticket_holders' reaches only ticket buyers", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEventWithGuests(s);
    expect(await recipientsFor(s, eventId, "ticket_holders")).toEqual([
      "ann@example.com",
      "ben@example.com",
    ]);
  });
});

describe("email audience excludes emailSuppressions (campaigns integration)", () => {
  test("a suppressed address is dropped from the email audience and reported separately", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEventWithGuests(s);
    // "ann@example.com" is on the guest list (seedEventWithGuests) — suppress
    // it as if she'd unsubscribed from an email campaign.
    await run(s.t, (ctx) =>
      ctx.db.insert("emailSuppressions", {
        email: "ann@example.com",
        reason: "unsubscribe",
        createdAt: Date.now(),
      }),
    );
    const blastId = await insertBlast(s, eventId, "everyone");
    const payload = await s.t.query(internal.blasts.getBlastPayload, { blastId });
    expect(payload?.emails.sort()).toEqual([
      "ben@example.com",
      "cat@example.com",
      "dan@example.com",
    ]);

    const preview = await s.as.query(api.blasts.previewBlastAudience, {
      eventId,
      audience: "everyone",
    });
    expect(preview.emailRecipients).toBe(3);
    expect(preview.emailSuppressed).toBe(1);
  });

  test("suppression matching normalizes the rsvp email (trim + lowercase), not just lowercases it", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await run(s.t, async (ctx) => {
      const now = Date.now();
      const eventTypeId = await ctx.db.insert("eventTypes", {
        chapterId: s.chapterId,
        name: "Night",
        slug: "night-padded",
        version: 1,
        createdBy: s.userId,
        createdAt: now,
        updatedAt: now,
      });
      const eventId = await ctx.db.insert("events", {
        chapterId: s.chapterId,
        eventTypeId,
        templateVersion: 1,
        name: "Night",
        eventDate: now,
        status: "planning",
        createdBy: s.userId,
        createdAt: now,
        updatedAt: now,
      });
      // A padded/mixed-case email — the kind that slips in from a pasted or
      // imported address — while `emailSuppressions.email` is stored
      // normalized (trim + lowercase, per the schema doc).
      await ctx.db.insert("rsvps", {
        eventId,
        chapterId: s.chapterId,
        name: "Padded Pat",
        email: "  Pat@Example.com  ",
        status: "going",
        token: "tok-pat-padded",
        createdAt: now,
        updatedAt: now,
      });
      return eventId;
    });
    await run(s.t, (ctx) =>
      ctx.db.insert("emailSuppressions", {
        email: "pat@example.com",
        reason: "unsubscribe",
        createdAt: Date.now(),
      }),
    );

    const blastId = await insertBlast(s, eventId, "everyone");
    const payload = await s.t.query(internal.blasts.getBlastPayload, { blastId });
    expect(payload?.emails ?? []).toEqual([]);

    const preview = await s.as.query(api.blasts.previewBlastAudience, {
      eventId,
      audience: "everyone",
    });
    expect(preview.emailRecipients).toBe(0);
    expect(preview.emailSuppressed).toBe(1);
  });
});

describe("sendBlast guardrails", () => {
  test("accepts the SMS channel now (Attendance F); delivery records the outcome", async () => {
    // The old SMS_NOT_CONNECTED refusal is gone — an unconfigured Twilio is a
    // recorded delivery error, not a rejected send. (Detailed SMS delivery
    // behavior is covered in twilio.test.ts.)
    vi.useFakeTimers();
    try {
      const t = newT();
      const s = await setupChapter(t);
      const eventId = await seedEventWithGuests(s);
      await s.as.mutation(api.blasts.sendBlast, {
        eventId,
        channel: "sms",
        body: "hi",
        audience: "everyone",
      });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      const history = await s.as.query(api.blasts.listBlasts, { eventId });
      expect(history).toHaveLength(1);
      expect(history[0].channel).toBe("sms");
    } finally {
      vi.useRealTimers();
    }
  });

  test("rejects an empty body", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEventWithGuests(s);
    await expect(
      s.as.mutation(api.blasts.sendBlast, {
        eventId,
        channel: "email",
        body: "   ",
        audience: "everyone",
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("a valid email blast records a 'sending' row", async () => {
    // sendBlast schedules internal.blasts.deliverBlast — drain it, else it
    // leaks past this test's torn-down Convex context ("Write outside of
    // transaction _scheduled_functions", CI-only flake — see the same pattern
    // used for flagPersonalCharge in cards.test.ts).
    vi.useFakeTimers();
    try {
      const t = newT();
      const s = await setupChapter(t);
      const eventId = await seedEventWithGuests(s);
      await s.as.mutation(api.blasts.sendBlast, {
        eventId,
        channel: "email",
        subject: "Doors at 6",
        body: "See you soon",
        audience: "going",
      });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      const history = await s.as.query(api.blasts.listBlasts, { eventId });
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        subject: "Doors at 6",
        audience: "going",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test("a Resend outage marks the email blast 'failed', not silently 'sent' (FIX 1 regression)", async () => {
    // Before FIX 1, `sendEmail`/`sendEmailReporting` swallowed EVERY Resend
    // failure (bounce or outage alike) without throwing, so this per-recipient
    // catch in `deliverEmailBlast` never fired and a full outage still landed
    // as "sent" with sentCount:0. Now a transport-level failure propagates,
    // so this catch actually catches it.
    vi.useFakeTimers();
    const realFetch = globalThis.fetch;
    const realKey = process.env.RESEND_API_KEY;
    const realFrom = process.env.AUTH_EMAIL_FROM;
    try {
      process.env.RESEND_API_KEY = "env_key_used";
      process.env.AUTH_EMAIL_FROM = "env-from@used.com";
      const t = newT();
      const s = await setupChapter(t);
      const eventId = await seedEventWithGuests(s);

      globalThis.fetch = (async () => {
        throw new Error("resend outage");
      }) as unknown as typeof fetch;

      await s.as.mutation(api.blasts.sendBlast, {
        eventId,
        channel: "email",
        body: "hello",
        audience: "going", // 2 recipients (ann@, ben@)
      });
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      const history = await s.as.query(api.blasts.listBlasts, { eventId });
      expect(history[0].status).toBe("failed");
      expect(history[0].sentCount).toBe(0);
      expect(history[0].error).toMatch(/resend outage/);
    } finally {
      vi.useRealTimers();
      globalThis.fetch = realFetch;
      if (realKey === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = realKey;
      if (realFrom === undefined) delete process.env.AUTH_EMAIL_FROM;
      else process.env.AUTH_EMAIL_FROM = realFrom;
    }
  });
});
