import { afterEach, describe, expect, test, vi } from "vitest";
import { createHmac } from "node:crypto";
import { ConvexError } from "convex/values";
import { api, internal } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";
import { normalizePhone, validateTwilioSignature } from "../lib/twilio";
import { hashPhoneCode } from "../lib/phoneCodes";

/**
 * Twilio integration (Attendance F):
 *  - integrationSettings.setTwilioCredentials / getIntegrationsStatus /
 *    readTwilioCredentials — superuser gate, status shows account SID last4 +
 *    messaging-service presence but NEVER the auth token, all-three semantics.
 *  - normalizePhone matrix (E.164 output; US 10/11-digit; rejects junk).
 *  - RSVP phone-code begin/verify/resend mirror the email-code semantics.
 *  - SMS blast audience resolution: phoneVerified gate, dedup by normalized
 *    phone, email-less phone-only imported guests INCLUDED; not-configured →
 *    recorded error, configured → sent/failed counts.
 *  - validateTwilioSignature — the /twilio/webhook security gate.
 *  - /twilio/webhook — STOP/START opt-out handling + MessageSid dedup.
 */

const SUPERUSER_EMAIL = "seyi@publicworship.life";

async function settingsRows(s: ChapterSetup) {
  return await run(s.t, (ctx) => ctx.db.query("integrationSettings").collect());
}

// ── Settings: gating, last4-only, never-the-token ────────────────────────────

describe("setTwilioCredentials superuser gate", () => {
  test("a non-superuser is rejected — no row written", async () => {
    const t = newT();
    const s = await setupChapter(t); // leader@ — NOT a superuser
    await expect(
      s.as.mutation(api.integrationSettings.setTwilioCredentials, {
        accountSid: "AC123",
        authToken: "tok_secret",
        messagingServiceSid: "MG123",
      }),
    ).rejects.toBeInstanceOf(ConvexError);
    expect((await settingsRows(s)).length).toBe(0);
  });

  test("a non-superuser is rejected on read", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await expect(
      s.as.query(api.integrationSettings.getIntegrationsStatus, {}),
    ).rejects.toBeInstanceOf(ConvexError);
  });
});

describe("setTwilioCredentials → getIntegrationsStatus", () => {
  test("configured status shows SID last4 + messaging-service present, NEVER the token", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPERUSER_EMAIL });
    await s.as.mutation(api.integrationSettings.setTwilioCredentials, {
      accountSid: "ACabcd1234WXYZ",
      authToken: "super_secret_token_9999",
      messagingServiceSid: "MGabcd1234",
    });

    const status = await s.as.query(
      api.integrationSettings.getIntegrationsStatus,
      {},
    );
    expect(status.twilio).toMatchObject({
      configured: true,
      accountSidLast4: "WXYZ",
      messagingServiceConfigured: true,
    });
    expect(status.twilio.updatedAt).toBeTruthy();

    // The auth token is NEVER present anywhere in the query result.
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain("super_secret_token_9999");
    expect(serialized).not.toContain("ACabcd1234WXYZ"); // full SID isn't leaked either
    expect((status.twilio as Record<string, unknown>).authToken).toBeUndefined();
    expect((status.twilio as Record<string, unknown>).twilioAuthToken).toBeUndefined();

    // The raw token DOES live on the row (it has to) — just never in a response.
    const rows = await settingsRows(s);
    expect(rows.length).toBe(1);
    expect(rows[0].twilioAuthToken).toBe("super_secret_token_9999");
    expect(rows[0].updatedBy).toBe(s.userId);
  });

  test("rejects a mixed null/non-null trio, and empty-after-trim values", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPERUSER_EMAIL });
    await expect(
      s.as.mutation(api.integrationSettings.setTwilioCredentials, {
        accountSid: "AC1",
        authToken: null,
        messagingServiceSid: "MG1",
      }),
    ).rejects.toBeInstanceOf(ConvexError);
    await expect(
      s.as.mutation(api.integrationSettings.setTwilioCredentials, {
        accountSid: "AC1",
        authToken: "   ",
        messagingServiceSid: "MG1",
      }),
    ).rejects.toBeInstanceOf(ConvexError);
    expect((await settingsRows(s)).length).toBe(0);
  });

  test("clear (all null) unsets the trio — status flips to not-configured", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPERUSER_EMAIL });
    await s.as.mutation(api.integrationSettings.setTwilioCredentials, {
      accountSid: "ACzz",
      authToken: "tok",
      messagingServiceSid: "MGzz",
    });
    await s.as.mutation(api.integrationSettings.setTwilioCredentials, {
      accountSid: null,
      authToken: null,
      messagingServiceSid: null,
    });
    const status = await s.as.query(
      api.integrationSettings.getIntegrationsStatus,
      {},
    );
    expect(status.twilio).toMatchObject({
      configured: false,
      accountSidLast4: null,
      messagingServiceConfigured: false,
    });
    const rows = await settingsRows(s);
    expect(rows.length).toBe(1); // patched, not deleted
    expect(rows[0].twilioAuthToken).toBeUndefined();
  });

  test("setting Twilio leaves an existing Givebutter key untouched (shared singleton)", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPERUSER_EMAIL });
    await s.as.mutation(api.integrationSettings.setGivebutterApiKey, {
      apiKey: "gb_key_keepme",
    });
    await s.as.mutation(api.integrationSettings.setTwilioCredentials, {
      accountSid: "ACaa",
      authToken: "tok",
      messagingServiceSid: "MGaa",
    });
    const rows = await settingsRows(s);
    expect(rows.length).toBe(1);
    expect(rows[0].givebutterApiKey).toBe("gb_key_keepme");
    expect(rows[0].twilioAccountSid).toBe("ACaa");
  });
});

describe("readTwilioCredentials (internalQuery)", () => {
  test("null until the whole trio is set, then the raw creds", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPERUSER_EMAIL });
    expect(
      await t.query(internal.integrationSettings.readTwilioCredentials, {}),
    ).toBeNull();
    await s.as.mutation(api.integrationSettings.setTwilioCredentials, {
      accountSid: "ACraw",
      authToken: "tokraw",
      messagingServiceSid: "MGraw",
    });
    expect(
      await t.query(internal.integrationSettings.readTwilioCredentials, {}),
    ).toEqual({
      accountSid: "ACraw",
      authToken: "tokraw",
      messagingServiceSid: "MGraw",
    });
  });
});

// ── Phone normalization matrix ───────────────────────────────────────────────

describe("normalizePhone", () => {
  test("US 10-digit → +1", () => {
    expect(normalizePhone("9175550000")).toBe("+19175550000");
    expect(normalizePhone("(917) 555-0000")).toBe("+19175550000");
    expect(normalizePhone("917.555.0000")).toBe("+19175550000");
  });
  test("US 11-digit starting with 1 → +1", () => {
    expect(normalizePhone("19175550000")).toBe("+19175550000");
    expect(normalizePhone("1 (917) 555-0000")).toBe("+19175550000");
  });
  test("already-+E.164 is kept (plausible length)", () => {
    expect(normalizePhone("+19175550000")).toBe("+19175550000");
    expect(normalizePhone("+447911123456")).toBe("+447911123456");
  });
  test("junk / wrong-length is rejected", () => {
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone("12345")).toBeNull();
    expect(normalizePhone("29175550000")).toBeNull(); // 11 digits not 1-prefixed
    expect(normalizePhone("not a phone")).toBeNull();
    expect(normalizePhone("+12")).toBeNull(); // too short
  });
});

// ── Phone-code begin/verify/resend (mirror the email flow) ───────────────────

async function seedEvent(s: ChapterSetup): Promise<Id<"events">> {
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
    return await ctx.db.insert("events", {
      chapterId: s.chapterId,
      eventTypeId,
      templateVersion: 1,
      name: "SMS Night",
      eventDate: now + 7 * 24 * 60 * 60 * 1000,
      status: "planning",
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
  });
}

async function setupPage() {
  const t = newT();
  const s = await setupChapter(t);
  const eventId = await seedEvent(s);
  const pageId = (await s.as.mutation(api.ticketing.createPage, {
    eventId,
  })) as Id<"eventPages">;
  await s.as.mutation(api.ticketing.updatePage, {
    pageId,
    patch: { published: true },
  });
  const admin = await s.as.query(api.ticketing.getAdminPage, { eventId });
  return { t, s, eventId, pageId, slug: admin.page!.slug as string };
}

/** Insert a phone-carrying RSVP directly and return its token. */
async function seedPhoneRsvp(
  s: ChapterSetup,
  eventId: Id<"events">,
  phone: string,
  token: string,
): Promise<string> {
  await run(s.t, async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("rsvps", {
      eventId,
      chapterId: s.chapterId,
      name: "Phone Guest",
      phone,
      status: "going",
      token,
      source: "rsvp",
      createdAt: now,
      updatedAt: now,
    });
  });
  return token;
}

function rsvpByToken(s: ChapterSetup, token: string) {
  return run(s.t, (ctx) =>
    ctx.db
      .query("rsvps")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique(),
  );
}

function phoneCodeRowFor(s: ChapterSetup, rsvpId: Id<"rsvps">) {
  return run(s.t, (ctx) =>
    ctx.db
      .query("rsvpPhoneCodes")
      .withIndex("by_rsvp", (q) => q.eq("rsvpId", rsvpId))
      .unique(),
  );
}

async function plantPhoneCode(s: ChapterSetup, rsvpId: Id<"rsvps">, code: string) {
  const row = await phoneCodeRowFor(s, rsvpId);
  await run(s.t, (ctx) => ctx.db.patch(row!._id, { codeHash: hashPhoneCode(code) }));
}

describe("phone verification mirrors the email flow", () => {
  test("begin marks unverified + stores only a hash; verify confirms and clears", async () => {
    vi.useFakeTimers();
    try {
      const { t, s, eventId, slug } = await setupPage();
      const token = await seedPhoneRsvp(s, eventId, "9175550000", "tok-p1");

      await t.mutation(api.ticketingVerification.beginRsvpPhoneVerification, {
        slug,
        token,
      });
      await t.finishAllScheduledFunctions(vi.runAllTimers); // drain the SMS action

      const rsvp = await rsvpByToken(s, token);
      expect(rsvp!.phoneVerified).toBe(false);
      const row = await phoneCodeRowFor(s, rsvp!._id);
      expect(row).toMatchObject({ attempts: 0 });
      expect(row!.codeHash).toMatch(/^[0-9a-f]{64}$/);
      expect(row!.expiresAt).toBeGreaterThan(Date.now());

      await plantPhoneCode(s, rsvp!._id, "123456");
      const res = await t.mutation(api.ticketingVerification.verifyRsvpPhone, {
        slug,
        token,
        code: "123456",
      });
      expect(res).toEqual({ ok: true });
      expect((await rsvpByToken(s, token))!.phoneVerified).toBe(true);
      expect(await phoneCodeRowFor(s, rsvp!._id)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  test("five wrong codes lock it out; even the right code is then refused", async () => {
    vi.useFakeTimers();
    try {
      const { t, s, eventId, slug } = await setupPage();
      const token = await seedPhoneRsvp(s, eventId, "9175550001", "tok-p2");
      await t.mutation(api.ticketingVerification.beginRsvpPhoneVerification, {
        slug,
        token,
      });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      const rsvp = await rsvpByToken(s, token);
      await plantPhoneCode(s, rsvp!._id, "123456");

      for (let i = 0; i < 5; i++) {
        const res = await t.mutation(api.ticketingVerification.verifyRsvpPhone, {
          slug,
          token,
          code: "000000",
        });
        expect(res.ok).toBe(false);
      }
      expect((await phoneCodeRowFor(s, rsvp!._id))!.attempts).toBe(5);
      await expect(
        t.mutation(api.ticketingVerification.verifyRsvpPhone, {
          slug,
          token,
          code: "123456",
        }),
      ).rejects.toThrow(/Too many tries/);
      expect((await rsvpByToken(s, token))!.phoneVerified).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test("resend is rate-limited within 60s, then issues a fresh code", async () => {
    vi.useFakeTimers();
    try {
      const { t, s, eventId, slug } = await setupPage();
      const token = await seedPhoneRsvp(s, eventId, "9175550002", "tok-p3");
      await t.mutation(api.ticketingVerification.beginRsvpPhoneVerification, {
        slug,
        token,
      });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      const rsvp = await rsvpByToken(s, token);

      await expect(
        t.mutation(api.ticketingVerification.resendRsvpPhoneCode, { slug, token }),
      ).rejects.toThrow(/just sent/);

      const row = await phoneCodeRowFor(s, rsvp!._id);
      await run(s.t, (ctx) =>
        ctx.db.patch(row!._id, { lastSentAt: Date.now() - 61_000, attempts: 4 }),
      );
      await t.mutation(api.ticketingVerification.resendRsvpPhoneCode, { slug, token });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      const fresh = await phoneCodeRowFor(s, rsvp!._id);
      expect(fresh!.attempts).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("begin/resend refuse a phone-less RSVP and an already-verified one", async () => {
    const { t, s, eventId, slug } = await setupPage();
    // Phone-less RSVP.
    await run(s.t, (ctx) =>
      ctx.db.insert("rsvps", {
        eventId,
        chapterId: s.chapterId,
        name: "No Phone",
        status: "going",
        token: "tok-nophone",
        source: "rsvp",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    await expect(
      t.mutation(api.ticketingVerification.beginRsvpPhoneVerification, {
        slug,
        token: "tok-nophone",
      }),
    ).rejects.toThrow(/mobile number/);

    // Already verified.
    const token = await seedPhoneRsvp(s, eventId, "9175550003", "tok-verified");
    const rsvp = await rsvpByToken(s, token);
    await run(s.t, (ctx) => ctx.db.patch(rsvp!._id, { phoneVerified: true }));
    await expect(
      t.mutation(api.ticketingVerification.beginRsvpPhoneVerification, {
        slug,
        token,
      }),
    ).rejects.toThrow(/already verified/);
  });

  test("a sent verification code writes an smsUsageEvents row attributed to the RSVP's chapter/event", async () => {
    vi.useFakeTimers();
    const realSid = process.env.TWILIO_ACCOUNT_SID;
    const realToken = process.env.TWILIO_AUTH_TOKEN;
    const realMsid = process.env.TWILIO_MESSAGING_SERVICE_SID;
    try {
      process.env.TWILIO_ACCOUNT_SID = "ACenv";
      process.env.TWILIO_AUTH_TOKEN = "tokenv";
      process.env.TWILIO_MESSAGING_SERVICE_SID = "MGenv";
      globalThis.fetch = (async () =>
        ({ ok: true, status: 201, text: async () => "{}" }) as unknown as Response) as typeof fetch;

      const { t, s, eventId, slug } = await setupPage();
      const token = await seedPhoneRsvp(s, eventId, "9175550050", "tok-usage");
      await t.mutation(api.ticketingVerification.beginRsvpPhoneVerification, {
        slug,
        token,
      });
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      const rows = await run(s.t, (ctx) => ctx.db.query("smsUsageEvents").collect());
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        purpose: "verification",
        chapterId: s.chapterId,
        eventId,
        phoneLast4: "0050",
        outcome: "sent",
      });
      expect(rows[0].segments).toBeGreaterThan(0);
      expect(rows[0].costUsdMicros).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
      if (realSid === undefined) delete process.env.TWILIO_ACCOUNT_SID;
      else process.env.TWILIO_ACCOUNT_SID = realSid;
      if (realToken === undefined) delete process.env.TWILIO_AUTH_TOKEN;
      else process.env.TWILIO_AUTH_TOKEN = realToken;
      if (realMsid === undefined) delete process.env.TWILIO_MESSAGING_SERVICE_SID;
      else process.env.TWILIO_MESSAGING_SERVICE_SID = realMsid;
    }
  });
});

// ── SMS blast audience resolution + sending ──────────────────────────────────

async function seedSmsAudience(s: ChapterSetup, eventId: Id<"events">) {
  await run(s.t, async (ctx) => {
    const now = Date.now();
    const base = {
      eventId,
      chapterId: s.chapterId,
      status: "going" as const,
      source: "rsvp" as const,
      createdAt: now,
      updatedAt: now,
    };
    // Reachable: undefined phoneVerified (imported/synced) + explicit true.
    await ctx.db.insert("rsvps", { ...base, name: "Imported", phone: "9175550100", token: "t-imported" });
    await ctx.db.insert("rsvps", { ...base, name: "Verified", phone: "9175550101", phoneVerified: true, token: "t-verified" });
    // Same number in a different format → must dedup to one.
    await ctx.db.insert("rsvps", { ...base, name: "Dup", phone: "(917) 555-0100", token: "t-dup" });
    // Excluded: phoneVerified explicitly false.
    await ctx.db.insert("rsvps", { ...base, name: "Pending", phone: "9175550102", phoneVerified: false, token: "t-pending" });
    // Excluded: no phone at all (email-only) — but reachable by email.
    await ctx.db.insert("rsvps", { ...base, name: "EmailOnly", email: "e@example.com", token: "t-email" });
    // Included by SMS, NOT by email: phone-only imported guest, no email.
    await ctx.db.insert("rsvps", { ...base, name: "PhoneOnly", phone: "9175550103", token: "t-phoneonly" });
  });
}

async function insertBlast(
  s: ChapterSetup,
  eventId: Id<"events">,
  channel: "email" | "sms",
): Promise<Id<"blasts">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("blasts", {
      eventId,
      chapterId: s.chapterId,
      channel,
      body: "Doors at 6",
      audience: "everyone",
      status: "sending",
      createdBy: s.userId,
      createdAt: Date.now(),
    }),
  );
}

describe("SMS blast audience resolution", () => {
  test("targets verified/undefined phones, dedups by normalized phone, includes email-less phone-only guests", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    await seedSmsAudience(s, eventId);

    const blastId = await insertBlast(s, eventId, "sms");
    const payload = await s.t.query(internal.blasts.getBlastPayload, { blastId });
    expect(payload?.phones.sort()).toEqual([
      "+19175550100", // imported (dedups with the "(917) 555-0100" row)
      "+19175550101", // verified
      "+19175550103", // phone-only, no email — the payoff
    ]);
    // The pending (phoneVerified:false) number is excluded.
    expect(payload?.phones).not.toContain("+19175550102");
    // Email side still only reaches the row that has an email.
    expect(payload?.emails).toEqual(["e@example.com"]);
  });
});

describe("SMS blast delivery", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("not configured → records a clear error, sentCount 0, status failed", async () => {
    vi.useFakeTimers();
    try {
      const t = newT();
      const s = await setupChapter(t);
      const eventId = await seedEvent(s);
      await seedSmsAudience(s, eventId);

      let fetchCalled = false;
      globalThis.fetch = (async () => {
        fetchCalled = true;
        return { ok: true, status: 200, text: async () => "{}" } as unknown as Response;
      }) as typeof fetch;

      await s.as.mutation(api.blasts.sendBlast, {
        eventId,
        channel: "sms",
        body: "hi",
        audience: "everyone",
      });
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      const history = await s.as.query(api.blasts.listBlasts, { eventId });
      expect(history[0].status).toBe("failed");
      expect(history[0].sentCount).toBe(0);
      expect(history[0].error).toMatch(/Integrations/);
      expect(fetchCalled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test("configured → sends per recipient, records sent count", async () => {
    vi.useFakeTimers();
    const realSid = process.env.TWILIO_ACCOUNT_SID;
    const realToken = process.env.TWILIO_AUTH_TOKEN;
    const realMsid = process.env.TWILIO_MESSAGING_SERVICE_SID;
    try {
      process.env.TWILIO_ACCOUNT_SID = "ACenv";
      process.env.TWILIO_AUTH_TOKEN = "tokenv";
      process.env.TWILIO_MESSAGING_SERVICE_SID = "MGenv";

      const t = newT();
      const s = await setupChapter(t);
      const eventId = await seedEvent(s);
      await seedSmsAudience(s, eventId);

      const sentBodies: string[] = [];
      globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
        sentBodies.push(init?.body ?? "");
        return { ok: true, status: 201, text: async () => "{}" } as unknown as Response;
      }) as typeof fetch;

      await s.as.mutation(api.blasts.sendBlast, {
        eventId,
        channel: "sms",
        body: "See you soon",
        audience: "everyone",
      });
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      const history = await s.as.query(api.blasts.listBlasts, { eventId });
      expect(history[0].status).toBe("sent");
      expect(history[0].recipientCount).toBe(3);
      expect(history[0].sentCount).toBe(3);
      // The opt-out suffix rides along on marketing bodies.
      expect(sentBodies.every((b) => b.includes("STOP"))).toBe(true);
      // Auth token never appears in the request BODY (it's in the header).
      expect(sentBodies.some((b) => b.includes("tokenv"))).toBe(false);
    } finally {
      vi.useRealTimers();
      if (realSid === undefined) delete process.env.TWILIO_ACCOUNT_SID;
      else process.env.TWILIO_ACCOUNT_SID = realSid;
      if (realToken === undefined) delete process.env.TWILIO_AUTH_TOKEN;
      else process.env.TWILIO_AUTH_TOKEN = realToken;
      if (realMsid === undefined) delete process.env.TWILIO_MESSAGING_SERVICE_SID;
      else process.env.TWILIO_MESSAGING_SERVICE_SID = realMsid;
    }
  });

  test("configured status reaches a partial failure count", async () => {
    vi.useFakeTimers();
    const realSid = process.env.TWILIO_ACCOUNT_SID;
    const realToken = process.env.TWILIO_AUTH_TOKEN;
    const realMsid = process.env.TWILIO_MESSAGING_SERVICE_SID;
    try {
      process.env.TWILIO_ACCOUNT_SID = "ACenv";
      process.env.TWILIO_AUTH_TOKEN = "tokenv";
      process.env.TWILIO_MESSAGING_SERVICE_SID = "MGenv";

      const t = newT();
      const s = await setupChapter(t);
      const eventId = await seedEvent(s);
      await seedSmsAudience(s, eventId);

      let n = 0;
      globalThis.fetch = (async () => {
        n++;
        // Fail the 2nd send only.
        if (n === 2) return { ok: false, status: 400, text: async () => "bad" } as unknown as Response;
        return { ok: true, status: 201, text: async () => "{}" } as unknown as Response;
      }) as typeof fetch;

      await s.as.mutation(api.blasts.sendBlast, {
        eventId,
        channel: "sms",
        body: "hey",
        audience: "everyone",
      });
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      const history = await s.as.query(api.blasts.listBlasts, { eventId });
      // A partial success still finalizes as "sent" (email's convention).
      expect(history[0].status).toBe("sent");
      expect(history[0].recipientCount).toBe(3);
      expect(history[0].sentCount).toBe(2);
    } finally {
      vi.useRealTimers();
      if (realSid === undefined) delete process.env.TWILIO_ACCOUNT_SID;
      else process.env.TWILIO_ACCOUNT_SID = realSid;
      if (realToken === undefined) delete process.env.TWILIO_AUTH_TOKEN;
      else process.env.TWILIO_AUTH_TOKEN = realToken;
      if (realMsid === undefined) delete process.env.TWILIO_MESSAGING_SERVICE_SID;
      else process.env.TWILIO_MESSAGING_SERVICE_SID = realMsid;
    }
  });
});

describe("previewBlastAudience", () => {
  test("returns per-channel counts + smsConfigured", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    await seedSmsAudience(s, eventId);
    const preview = await s.as.query(api.blasts.previewBlastAudience, {
      eventId,
      audience: "everyone",
    });
    expect(preview.smsRecipients).toBe(3);
    expect(preview.emailRecipients).toBe(1);
    expect(preview.smsConfigured).toBe(false);
    // No draft body yet → no cost estimate, and nobody's opted out.
    expect(preview.smsOptedOut).toBe(0);
    expect(preview.estimatedSegments).toBe(0);
    expect(preview.estimatedCostUsdMicros).toBe(0);
  });

  test("a draft body drives the segment + cost estimate (including the STOP suffix)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    await seedSmsAudience(s, eventId); // 3 SMS recipients
    const preview = await s.as.query(api.blasts.previewBlastAudience, {
      eventId,
      audience: "everyone",
      body: "Doors at 6!",
    });
    // "Doors at 6!\n\nReply STOP to opt out." is well under 160 GSM-7 chars.
    expect(preview.estimatedSegments).toBe(1);
    expect(preview.estimatedCostUsdMicros).toBe(3 * 10_000); // 3 recipients × 1 segment × $0.01
  });
});

// ── SMS opt-outs (defense-in-depth STOP mirror) ──────────────────────────────

describe("SMS opt-out filtering", () => {
  test("an opted-out number is excluded from the blast payload and counted in the preview", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    await seedSmsAudience(s, eventId); // includes +19175550100 ("Imported")

    await run(s.t, (ctx) =>
      ctx.db.insert("smsOptOuts", {
        phone: "+19175550100",
        source: "stop_webhook",
        createdAt: Date.now(),
      }),
    );

    const blastId = await insertBlast(s, eventId, "sms");
    const payload = await s.t.query(internal.blasts.getBlastPayload, { blastId });
    expect(payload?.phones).not.toContain("+19175550100");
    expect(payload?.phones.sort()).toEqual(["+19175550101", "+19175550103"]);

    const preview = await s.as.query(api.blasts.previewBlastAudience, {
      eventId,
      audience: "everyone",
    });
    expect(preview.smsRecipients).toBe(2);
    expect(preview.smsOptedOut).toBe(1);
  });

  test("an opted-out number already excluded from the payload is never texted, and only 'sent' usage rows land for the rest", async () => {
    vi.useFakeTimers();
    const realSid = process.env.TWILIO_ACCOUNT_SID;
    const realToken = process.env.TWILIO_AUTH_TOKEN;
    const realMsid = process.env.TWILIO_MESSAGING_SERVICE_SID;
    try {
      process.env.TWILIO_ACCOUNT_SID = "ACenv";
      process.env.TWILIO_AUTH_TOKEN = "tokenv";
      process.env.TWILIO_MESSAGING_SERVICE_SID = "MGenv";

      const t = newT();
      const s = await setupChapter(t);
      const eventId = await seedEvent(s);
      await seedSmsAudience(s, eventId);
      await run(s.t, (ctx) =>
        ctx.db.insert("smsOptOuts", {
          phone: "+19175550100",
          source: "stop_webhook",
          createdAt: Date.now(),
        }),
      );

      const sentTo: string[] = [];
      globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
        const body = new URLSearchParams(init?.body ?? "");
        sentTo.push(body.get("To") ?? "");
        return { ok: true, status: 201, text: async () => "{}" } as unknown as Response;
      }) as typeof fetch;

      await s.as.mutation(api.blasts.sendBlast, {
        eventId,
        channel: "sms",
        body: "hey",
        audience: "everyone",
      });
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      // Only the 2 non-opted-out numbers were actually texted.
      expect(sentTo.sort()).toEqual(["+19175550101", "+19175550103"]);

      const history = await s.as.query(api.blasts.listBlasts, { eventId });
      expect(history[0].recipientCount).toBe(2); // opted-out never enters the payload
      expect(history[0].sentCount).toBe(2);

      const usageRows = await run(s.t, (ctx) => ctx.db.query("smsUsageEvents").collect());
      // No usage row at all for the opted-out number — it never reached
      // deliverSmsBlast (getBlastPayload filtered it out first).
      expect(usageRows.some((r) => r.phoneLast4 === "0100")).toBe(false);
      const sentRows = usageRows.filter((r) => r.outcome === "sent");
      expect(sentRows).toHaveLength(2);
      expect(sentRows.every((r) => r.purpose === "blast")).toBe(true);
      expect(sentRows.every((r) => r.costUsdMicros > 0)).toBe(true);
    } finally {
      vi.useRealTimers();
      if (realSid === undefined) delete process.env.TWILIO_ACCOUNT_SID;
      else process.env.TWILIO_ACCOUNT_SID = realSid;
      if (realToken === undefined) delete process.env.TWILIO_AUTH_TOKEN;
      else process.env.TWILIO_AUTH_TOKEN = realToken;
      if (realMsid === undefined) delete process.env.TWILIO_MESSAGING_SERVICE_SID;
      else process.env.TWILIO_MESSAGING_SERVICE_SID = realMsid;
    }
  });

  test("listOptedOutPhones (the send-time recheck's data source) reflects the current opt-out table", async () => {
    // `deliverSmsBlast` re-fetches the opt-out set right before sending via
    // this internalQuery (see blasts.ts) rather than trusting the payload
    // computed when the blast was scheduled. That data source is covered
    // directly here; the end-to-end "already excluded" case is covered by
    // the previous test (getBlastPayload's build-time filter already keeps a
    // known opt-out from ever reaching `deliverSmsBlast`'s send loop).
    const t = newT();
    expect(await t.query(internal.smsOptOuts.listOptedOutPhones, {})).toEqual([]);
    await run(t, (ctx) =>
      ctx.db.insert("smsOptOuts", {
        phone: "+19175550102",
        source: "stop_webhook",
        createdAt: Date.now(),
      }),
    );
    expect(await t.query(internal.smsOptOuts.listOptedOutPhones, {})).toEqual([
      "+19175550102",
    ]);
  });
});

// ── validateTwilioSignature ───────────────────────────────────────────────────

/** Sign `url` + sorted POST `params` per Twilio's spec, matching
 *  `validateTwilioSignature`'s own algorithm (independently reimplemented
 *  with Node's `crypto` so this test doesn't just assert the function against
 *  itself). */
function signTwilioRequest(
  url: string,
  params: Record<string, string>,
  authToken: string,
): string {
  let data = url;
  for (const key of Object.keys(params).sort()) data += key + params[key];
  return createHmac("sha1", authToken).update(data).digest("base64");
}

describe("validateTwilioSignature", () => {
  const URL = "https://example.convex.site/twilio/webhook";
  const TOKEN = "test_auth_token";
  const PARAMS = { From: "+19175550000", Body: "STOP", MessageSid: "SM123" };

  test("accepts a correctly signed request", async () => {
    const sig = signTwilioRequest(URL, PARAMS, TOKEN);
    expect(await validateTwilioSignature(URL, PARAMS, sig, TOKEN)).toBe(true);
  });

  test("rejects a tampered param", async () => {
    const sig = signTwilioRequest(URL, PARAMS, TOKEN);
    const tampered = { ...PARAMS, Body: "START" };
    expect(await validateTwilioSignature(URL, tampered, sig, TOKEN)).toBe(false);
  });

  test("rejects the wrong auth token", async () => {
    const sig = signTwilioRequest(URL, PARAMS, TOKEN);
    expect(await validateTwilioSignature(URL, PARAMS, sig, "wrong_token")).toBe(
      false,
    );
  });

  test("rejects a mismatched URL (e.g. http vs https, or a different host)", async () => {
    const sig = signTwilioRequest(URL, PARAMS, TOKEN);
    expect(
      await validateTwilioSignature(
        "https://example.convex.site/twilio/webhook/",
        PARAMS,
        sig,
        TOKEN,
      ),
    ).toBe(false);
  });

  test("rejects a missing signature header", async () => {
    expect(await validateTwilioSignature(URL, PARAMS, null, TOKEN)).toBe(false);
  });

  test("params order doesn't matter — sorted internally", async () => {
    const sig = signTwilioRequest(URL, PARAMS, TOKEN);
    const reordered = { MessageSid: PARAMS.MessageSid, Body: PARAMS.Body, From: PARAMS.From };
    expect(await validateTwilioSignature(URL, reordered, sig, TOKEN)).toBe(true);
  });
});

// ── /twilio/webhook (http.ts) ─────────────────────────────────────────────────

const WEBHOOK_URL = "https://some.convex.site/twilio/webhook"; // matches convex-test's t.fetch base

async function postTwilioWebhook(
  t: ReturnType<typeof newT>,
  authToken: string,
  params: Record<string, string>,
  opts: { badSignature?: boolean } = {},
) {
  const body = new URLSearchParams(params).toString();
  const signature = opts.badSignature
    ? "forged=="
    : signTwilioRequest(WEBHOOK_URL, params, authToken);
  return t.fetch("/twilio/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Twilio-Signature": signature,
    },
    body,
  });
}

describe("/twilio/webhook", () => {
  const realSid = process.env.TWILIO_ACCOUNT_SID;
  const realToken = process.env.TWILIO_AUTH_TOKEN;
  const realMsid = process.env.TWILIO_MESSAGING_SERVICE_SID;

  function setEnvCreds() {
    process.env.TWILIO_ACCOUNT_SID = "ACenv";
    process.env.TWILIO_AUTH_TOKEN = "webhook_token";
    process.env.TWILIO_MESSAGING_SERVICE_SID = "MGenv";
  }
  function restoreEnvCreds() {
    if (realSid === undefined) delete process.env.TWILIO_ACCOUNT_SID;
    else process.env.TWILIO_ACCOUNT_SID = realSid;
    if (realToken === undefined) delete process.env.TWILIO_AUTH_TOKEN;
    else process.env.TWILIO_AUTH_TOKEN = realToken;
    if (realMsid === undefined) delete process.env.TWILIO_MESSAGING_SERVICE_SID;
    else process.env.TWILIO_MESSAGING_SERVICE_SID = realMsid;
  }

  test("500s when Twilio isn't configured", async () => {
    const t = newT();
    const res = await postTwilioWebhook(t, "any_token", {
      From: "+19175550000",
      Body: "STOP",
      MessageSid: "SM1",
    });
    expect(res.status).toBe(500);
  });

  test("400s on an invalid signature", async () => {
    setEnvCreds();
    try {
      const t = newT();
      const res = await postTwilioWebhook(
        t,
        "webhook_token",
        { From: "+19175550000", Body: "STOP", MessageSid: "SM2" },
        { badSignature: true },
      );
      expect(res.status).toBe(400);
    } finally {
      restoreEnvCreds();
    }
  });

  test("STOP records an opt-out; START clears it", async () => {
    setEnvCreds();
    try {
      const t = newT();
      const res = await postTwilioWebhook(t, "webhook_token", {
        From: "9175550099", // deliberately not pre-normalized — mirrors a real device
        Body: "  stop  ", // lowercase + whitespace — must still match
        MessageSid: "SM3",
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("<Response/>");
      const rows = await run(t, (ctx) => ctx.db.query("smsOptOuts").collect());
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ phone: "+19175550099", source: "stop_webhook" });

      await postTwilioWebhook(t, "webhook_token", {
        From: "9175550099",
        Body: "START",
        MessageSid: "SM4",
      });
      const rowsAfterStart = await run(t, (ctx) => ctx.db.query("smsOptOuts").collect());
      expect(rowsAfterStart).toHaveLength(0);
    } finally {
      restoreEnvCreds();
    }
  });

  test("a redelivered MessageSid is deduped — processed only once", async () => {
    setEnvCreds();
    try {
      const t = newT();
      const params = { From: "9175550098", Body: "STOP", MessageSid: "SM-dup" };
      await postTwilioWebhook(t, "webhook_token", params);
      // "Redeliver" the exact same webhook (Twilio does this on a timeout).
      await postTwilioWebhook(t, "webhook_token", params);

      const rows = await run(t, (ctx) => ctx.db.query("smsOptOuts").collect());
      expect(rows).toHaveLength(1); // not double-inserted
      const webhookRows = await run(t, (ctx) => ctx.db.query("webhookEvents").collect());
      expect(webhookRows.filter((r) => r.provider === "twilio")).toHaveLength(1);
    } finally {
      restoreEnvCreds();
    }
  });

  test("an unrecognized message body is a silent no-op", async () => {
    setEnvCreds();
    try {
      const t = newT();
      const res = await postTwilioWebhook(t, "webhook_token", {
        From: "9175550097",
        Body: "Thanks so much!",
        MessageSid: "SM5",
      });
      expect(res.status).toBe(200);
      const rows = await run(t, (ctx) => ctx.db.query("smsOptOuts").collect());
      expect(rows).toHaveLength(0);
    } finally {
      restoreEnvCreds();
    }
  });
});
