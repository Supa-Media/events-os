import { afterEach, describe, expect, test, vi } from "vitest";
import { ConvexError } from "convex/values";
import { api, internal } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";

/**
 * Blasts — host announcements. Covers the three things that decide who gets a
 * message and what it contains: audience → recipient-set resolution (with
 * email de-dup), the guardrails on sending (SMS not wired, empty body
 * rejected, no postal address rejected), and the bulk-mail furniture an email
 * blast legally has to carry (per-recipient unsubscribe link + headers,
 * postal address) — which transactional mail must NOT get.
 */

const MAILING_ADDRESS = "Public Worship, 123 Main St, Brooklyn, NY 11201";

/** Seed the org's CAN-SPAM postal address. Written straight to the singleton
 *  rather than through `setEmailCampaignSettings`, which is superuser-gated —
 *  a blast is fired by an ordinary event admin, who can't set it themselves. */
async function configureMailingAddress(s: ChapterSetup): Promise<void> {
  await run(s.t, (ctx) =>
    ctx.db.insert("integrationSettings", {
      orgMailingAddress: MAILING_ADDRESS,
      updatedBy: s.userId,
      updatedAt: Date.now(),
    }),
  );
}

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
      await configureMailingAddress(s);
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
      await configureMailingAddress(s);
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

  test("an email blast is refused when no postal address is on file (CAN-SPAM)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEventWithGuests(s);
    // No `configureMailingAddress` — the production default, since nothing in
    // the app could set the field before this fix.
    const error = await s.as
      .mutation(api.blasts.sendBlast, {
        eventId,
        channel: "email",
        body: "hello",
        audience: "everyone",
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConvexError);
    expect((error as ConvexError<{ code: string }>).data.code).toBe(
      "NO_MAILING_ADDRESS",
    );
    // Nothing was recorded — the refusal is loud and total, not a blast row
    // that quietly lands "failed".
    expect(await s.as.query(api.blasts.listBlasts, { eventId })).toHaveLength(0);
  });

  test("an SMS blast is NOT gated on the postal address — its opt-out is the STOP line", async () => {
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
      expect(await s.as.query(api.blasts.listBlasts, { eventId })).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── Bulk-mail furniture (unsubscribe link, headers, postal address) ──────────

type CapturedSend = {
  to: string;
  subject: string;
  html: string;
  headers?: Record<string, string>;
};

/** Fire an email blast with `fetch` stubbed, returning every message Resend
 *  would have been asked to send. */
async function sendEmailBlastCapturing(
  s: ChapterSetup,
  eventId: Id<"events">,
  audience: "everyone" | "going" | "maybe" | "ticket_holders",
): Promise<CapturedSend[]> {
  const sends: CapturedSend[] = [];
  globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    sends.push({
      to: body.to,
      subject: body.subject,
      html: body.html,
      headers: body.headers,
    });
    return { ok: true, status: 200, text: async () => "{}" };
  }) as unknown as typeof fetch;

  await s.as.mutation(api.blasts.sendBlast, {
    eventId,
    channel: "email",
    subject: "Doors at 6",
    body: "See you soon",
    audience,
  });
  await s.t.finishAllScheduledFunctions(vi.runAllTimers);
  return sends;
}

describe("an email blast carries the bulk-mail furniture", () => {
  const realFetch = globalThis.fetch;
  const realKey = process.env.RESEND_API_KEY;
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = realKey;
    vi.useRealTimers();
  });

  test("every recipient gets their OWN unsubscribe token, link, and one-click headers", async () => {
    vi.useFakeTimers();
    process.env.RESEND_API_KEY = "re_test_key";
    const t = newT();
    const s = await setupChapter(t);
    await configureMailingAddress(s);
    const eventId = await seedEventWithGuests(s);

    const sends = await sendEmailBlastCapturing(s, eventId, "going"); // ann@, ben@
    expect(sends.map((x) => x.to).sort()).toEqual([
      "ann@example.com",
      "ben@example.com",
    ]);

    const tokens = new Set<string>();
    for (const send of sends) {
      const header = send.headers?.["List-Unsubscribe"];
      expect(header).toMatch(/^<.*\/unsubscribe\/.+>$/);
      expect(send.headers?.["List-Unsubscribe-Post"]).toBe(
        "List-Unsubscribe=One-Click",
      );
      // The footer carries BOTH legally required things.
      expect(send.html).toContain(MAILING_ADDRESS);
      expect(send.html).toContain("Unsubscribe");
      const token = /\/unsubscribe\/([^>"]+)/.exec(header ?? "")?.[1];
      expect(token).toBeTruthy();
      // The visible link and the header point at the SAME token.
      expect(send.html).toContain(`/unsubscribe/${token}`);
      tokens.add(token!);
    }
    // Two recipients, two DIFFERENT tokens — not one shared blast-wide link.
    expect(tokens.size).toBe(2);

    const rows = await run(s.t, (ctx) => ctx.db.query("blastRecipients").collect());
    expect(rows.map((r) => r.email).sort()).toEqual([
      "ann@example.com",
      "ben@example.com",
    ]);
    expect(rows.every((r) => r.status === "sent")).toBe(true);
  });

  test("a recipient's token unsubscribes THEM and nobody else", async () => {
    vi.useFakeTimers();
    process.env.RESEND_API_KEY = "re_test_key";
    const t = newT();
    const s = await setupChapter(t);
    await configureMailingAddress(s);
    const eventId = await seedEventWithGuests(s);
    await sendEmailBlastCapturing(s, eventId, "going"); // ann@, ben@
    vi.useRealTimers();

    const annRow = await run(s.t, async (ctx) =>
      (await ctx.db.query("blastRecipients").collect()).find(
        (r) => r.email === "ann@example.com",
      ),
    );
    expect(annRow).toBeTruthy();

    // The SAME `/unsubscribe/<token>` route campaign recipients use — no
    // second code path, no separate page.
    const confirm = await t.fetch(`/unsubscribe/${annRow!.unsubscribeToken}`, {
      method: "GET",
    });
    expect(confirm.status).toBe(200);
    expect(await confirm.text()).toContain("ann@example.com");

    const res = await t.fetch(`/unsubscribe/${annRow!.unsubscribeToken}`, {
      method: "POST",
    });
    expect(res.status).toBe(200);

    const suppressed = await run(s.t, (ctx) =>
      ctx.db.query("emailSuppressions").collect(),
    );
    expect(suppressed.map((r) => r.email)).toEqual(["ann@example.com"]);
    expect(suppressed[0].reason).toBe("unsubscribe");

    // Ben's row is untouched, and a NEW blast still reaches him — one
    // recipient's token can never silence another's.
    const ben = await run(s.t, async (ctx) =>
      (await ctx.db.query("blastRecipients").collect()).find(
        (r) => r.email === "ben@example.com",
      ),
    );
    expect(ben?.unsubscribedAt).toBeUndefined();

    const blastId = await insertBlast(s, eventId, "going");
    const payload = await s.t.query(internal.blasts.getBlastPayload, { blastId });
    expect(payload?.emails).toEqual(["ben@example.com"]);
  });

  test("a TRANSACTIONAL email gets no unsubscribe link and no List-Unsubscribe header", async () => {
    // `emailShell` is shared by both kinds of mail — the bulk footer is
    // opt-in per call site, and this is the assertion that keeps it that way.
    // An RSVP verification code must never offer to suppress the very address
    // the recipient's own receipts arrive at.
    process.env.RESEND_API_KEY = "re_test_key";
    const sends: CapturedSend[] = [];
    globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
      const body = init?.body ? JSON.parse(init.body) : {};
      sends.push({
        to: body.to,
        subject: body.subject,
        html: body.html,
        headers: body.headers,
      });
      return { ok: true, status: 200, text: async () => "{}" };
    }) as unknown as typeof fetch;

    const t = newT();
    const s = await setupChapter(t);
    await configureMailingAddress(s);
    await t.action(internal.ticketingEmails.sendVerificationEmail, {
      email: "guest@example.com",
      code: "123456",
    });

    expect(sends).toHaveLength(1);
    expect(sends[0].html.toLowerCase()).not.toContain("unsubscribe");
    expect(sends[0].html).not.toContain(MAILING_ADDRESS);
    expect(sends[0].headers).toBeUndefined();
  });
});
