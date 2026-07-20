import { afterEach, describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api, internal } from "../_generated/api";

/**
 * Resend (own-key email) integration tests — the deployment-wide
 * `integrationSettings` singleton fields that let a chapter send email from
 * its own Resend account/domain instead of the shared default:
 *  - `setResendSettings` / `getIntegrationsStatus` are SUPERUSER-gated (a
 *    non-superuser is rejected on both read and write),
 *  - the status projection NEVER carries the raw API key — only
 *    `{configured, last4, updatedAt}` — but DOES return `fromAddress` in
 *    full (it's not secret, it's the sender line every recipient sees),
 *  - `setResendSettings` UPSERTS the singleton, trims + rejects an empty
 *    key, loosely validates a provided from-address, and `apiKey: null`
 *    clears BOTH fields,
 *  - the from-address can be updated on its own (`apiKey` omitted) only
 *    once a key is already on file,
 *  - `ticketingEmails.ts`'s send chokepoint (`sendEmail`/`sendEmailReporting`
 *    via `lib/resend.ts`'s `resolveResendSettings`) prefers the stored
 *    setting over `RESEND_API_KEY`/`AUTH_EMAIL_FROM`, falls back to the env
 *    vars when nothing is stored, and degrades to a no-op log when neither
 *    exists.
 */

const SUPERUSER_EMAIL = "seyi@publicworship.life";

async function settingsRows(s: ChapterSetup) {
  return await run(s.t, (ctx) => ctx.db.query("integrationSettings").collect());
}

// ── Settings: gating, last4-only-for-the-key, full-from-address ─────────────

describe("setResendSettings superuser gate", () => {
  test("a non-superuser is rejected — no row written", async () => {
    const t = newT();
    const s = await setupChapter(t); // leader@ — NOT a superuser
    await expect(
      s.as.mutation(api.integrationSettings.setResendSettings, {
        apiKey: "re_test_123",
        fromAddress: null,
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

describe("setResendSettings → getIntegrationsStatus", () => {
  test("set (key + from) → status shows configured + last4 + FULL from-address, and NEVER the key", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPERUSER_EMAIL });

    await s.as.mutation(api.integrationSettings.setResendSettings, {
      apiKey: "re_test_ABCDwxyz9876",
      fromAddress: "Chapter OS <os@publicworship.life>",
    });

    const status = await s.as.query(api.integrationSettings.getIntegrationsStatus, {});
    expect(status.resend).toMatchObject({
      configured: true,
      last4: "9876",
      fromAddress: "Chapter OS <os@publicworship.life>",
    });
    expect(status.resend.updatedAt).toBeTruthy();

    // The full key is NEVER present anywhere in the query result — but the
    // from-address (not secret) legitimately IS.
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain("re_test_ABCDwxyz9876");
    expect(serialized).toContain("os@publicworship.life");
    expect((status.resend as Record<string, unknown>).apiKey).toBeUndefined();
    expect((status.resend as Record<string, unknown>).resendApiKey).toBeUndefined();

    const rows = await settingsRows(s);
    expect(rows.length).toBe(1);
    expect(rows[0].updatedBy).toBe(s.userId);
    expect(rows[0].resendApiKey).toBe("re_test_ABCDwxyz9876");
    expect(rows[0].resendFromAddress).toBe("Chapter OS <os@publicworship.life>");
  });

  test("re-setting patches the SAME row (upsert, not a second insert)", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPERUSER_EMAIL });
    await s.as.mutation(api.integrationSettings.setResendSettings, {
      apiKey: "re_test_first111",
      fromAddress: null,
    });
    await s.as.mutation(api.integrationSettings.setResendSettings, {
      apiKey: "re_test_second222",
      fromAddress: null,
    });
    const rows = await settingsRows(s);
    expect(rows.length).toBe(1);
    expect(rows[0].resendApiKey).toBe("re_test_second222");
  });

  test("rejects an empty / whitespace-only key — no row written", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPERUSER_EMAIL });
    await expect(
      s.as.mutation(api.integrationSettings.setResendSettings, {
        apiKey: "   ",
        fromAddress: null,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
    expect((await settingsRows(s)).length).toBe(0);
  });

  test("trims whitespace around a valid key", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPERUSER_EMAIL });
    await s.as.mutation(api.integrationSettings.setResendSettings, {
      apiKey: "  re_test_trimmed  ",
      fromAddress: null,
    });
    const rows = await settingsRows(s);
    expect(rows[0].resendApiKey).toBe("re_test_trimmed");
  });

  test("requires at least one of apiKey / fromAddress", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPERUSER_EMAIL });
    await expect(
      s.as.mutation(api.integrationSettings.setResendSettings, {}),
    ).rejects.toBeInstanceOf(ConvexError);
    expect((await settingsRows(s)).length).toBe(0);
  });

  test("rejects a from-address with no '@' (loose validation)", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPERUSER_EMAIL });
    await expect(
      s.as.mutation(api.integrationSettings.setResendSettings, {
        apiKey: "re_test_key",
        fromAddress: "not-an-email",
      }),
    ).rejects.toBeInstanceOf(ConvexError);
    expect((await settingsRows(s)).length).toBe(0);
  });

  test("accepts the 'Name <email>' form", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPERUSER_EMAIL });
    await s.as.mutation(api.integrationSettings.setResendSettings, {
      apiKey: "re_test_key",
      fromAddress: "  Chapter OS <os@publicworship.life>  ",
    });
    const rows = await settingsRows(s);
    expect(rows[0].resendFromAddress).toBe("Chapter OS <os@publicworship.life>");
  });

  test("a blank from-address stores as unset rather than erroring", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPERUSER_EMAIL });
    await s.as.mutation(api.integrationSettings.setResendSettings, {
      apiKey: "re_test_key",
      fromAddress: "   ",
    });
    const rows = await settingsRows(s);
    expect(rows[0].resendFromAddress).toBeUndefined();
    const status = await s.as.query(api.integrationSettings.getIntegrationsStatus, {});
    expect(status.resend.fromAddress).toBeNull();
  });

  test("updating the from-address alone (apiKey omitted) requires a key already on file", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPERUSER_EMAIL });
    // No key stored yet — from-address-only update is rejected.
    await expect(
      s.as.mutation(api.integrationSettings.setResendSettings, {
        fromAddress: "os@publicworship.life",
      }),
    ).rejects.toBeInstanceOf(ConvexError);
    expect((await settingsRows(s)).length).toBe(0);

    // Once a key exists, updating just the from-address succeeds and leaves
    // the stored key untouched.
    await s.as.mutation(api.integrationSettings.setResendSettings, {
      apiKey: "re_test_stableKey",
      fromAddress: null,
    });
    await s.as.mutation(api.integrationSettings.setResendSettings, {
      fromAddress: "newsender@publicworship.life",
    });
    const rows = await settingsRows(s);
    expect(rows.length).toBe(1);
    expect(rows[0].resendApiKey).toBe("re_test_stableKey");
    expect(rows[0].resendFromAddress).toBe("newsender@publicworship.life");
  });

  test("clear (apiKey:null) removes BOTH fields — status flips to not-configured", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPERUSER_EMAIL });
    await s.as.mutation(api.integrationSettings.setResendSettings, {
      apiKey: "re_test_toClear99",
      fromAddress: "os@publicworship.life",
    });
    let status = await s.as.query(api.integrationSettings.getIntegrationsStatus, {});
    expect(status.resend.configured).toBe(true);

    await s.as.mutation(api.integrationSettings.setResendSettings, {
      apiKey: null,
      fromAddress: null,
    });
    status = await s.as.query(api.integrationSettings.getIntegrationsStatus, {});
    expect(status.resend).toMatchObject({
      configured: false,
      last4: null,
      fromAddress: null,
    });

    // Still ONE row (patched, not deleted) but both fields are unset.
    const rows = await settingsRows(s);
    expect(rows.length).toBe(1);
    expect(rows[0].resendApiKey).toBeUndefined();
    expect(rows[0].resendFromAddress).toBeUndefined();
  });

  test("`apiKey: null` clears both fields even when a from-address is also passed", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPERUSER_EMAIL });
    await s.as.mutation(api.integrationSettings.setResendSettings, {
      apiKey: "re_test_toClear",
      fromAddress: "os@publicworship.life",
    });
    await s.as.mutation(api.integrationSettings.setResendSettings, {
      apiKey: null,
      fromAddress: "ignored@publicworship.life",
    });
    const rows = await settingsRows(s);
    expect(rows[0].resendApiKey).toBeUndefined();
    expect(rows[0].resendFromAddress).toBeUndefined();
  });

  test("setting Resend leaves Givebutter and Twilio settings untouched, and vice versa", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPERUSER_EMAIL });
    await s.as.mutation(api.integrationSettings.setGivebutterApiKey, {
      apiKey: "gb_untouched",
    });
    await s.as.mutation(api.integrationSettings.setTwilioCredentials, {
      accountSid: "ACuntouched",
      authToken: "tok_untouched",
      messagingServiceSid: "MGuntouched",
    });
    await s.as.mutation(api.integrationSettings.setResendSettings, {
      apiKey: "re_isolated",
      fromAddress: "os@publicworship.life",
    });

    const rows = await settingsRows(s);
    expect(rows.length).toBe(1); // still the ONE singleton row
    expect(rows[0].givebutterApiKey).toBe("gb_untouched");
    expect(rows[0].twilioAccountSid).toBe("ACuntouched");
    expect(rows[0].twilioAuthToken).toBe("tok_untouched");
    expect(rows[0].twilioMessagingServiceSid).toBe("MGuntouched");
    expect(rows[0].resendApiKey).toBe("re_isolated");

    // And clearing Resend doesn't touch the other two.
    await s.as.mutation(api.integrationSettings.setResendSettings, {
      apiKey: null,
      fromAddress: null,
    });
    const rowsAfter = await settingsRows(s);
    expect(rowsAfter[0].givebutterApiKey).toBe("gb_untouched");
    expect(rowsAfter[0].twilioAccountSid).toBe("ACuntouched");
    expect(rowsAfter[0].resendApiKey).toBeUndefined();

    const status = await s.as.query(api.integrationSettings.getIntegrationsStatus, {});
    expect(status.givebutter.configured).toBe(true);
    expect(status.twilio.configured).toBe(true);
    expect(status.resend.configured).toBe(false);
  });
});

describe("readResendSettings (internalQuery, action-facing)", () => {
  test("null when unset, {apiKey, fromAddress} once set", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPERUSER_EMAIL });
    expect(await t.query(internal.integrationSettings.readResendSettings, {})).toBeNull();

    await s.as.mutation(api.integrationSettings.setResendSettings, {
      apiKey: "re_test_raw",
      fromAddress: "os@publicworship.life",
    });
    expect(await t.query(internal.integrationSettings.readResendSettings, {})).toEqual({
      apiKey: "re_test_raw",
      fromAddress: "os@publicworship.life",
    });
  });

  test("fromAddress is null (not undefined) when a key is set but no address is", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPERUSER_EMAIL });
    await s.as.mutation(api.integrationSettings.setResendSettings, {
      apiKey: "re_test_noFrom",
      fromAddress: null,
    });
    expect(await t.query(internal.integrationSettings.readResendSettings, {})).toEqual({
      apiKey: "re_test_noFrom",
      fromAddress: null,
    });
  });
});

// ── Send path: resolveResendSettings resolution order + the real fetch ──────

/** A minimal fetch Response stand-in for a successful Resend send. */
function okResendResponse(): unknown {
  return { ok: true, status: 200, text: async () => "{}" };
}

describe("email send chokepoint (lib/resend.ts resolution order)", () => {
  const realFetch = globalThis.fetch;
  const realKey = process.env.RESEND_API_KEY;
  const realFrom = process.env.AUTH_EMAIL_FROM;

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = realKey;
    if (realFrom === undefined) delete process.env.AUTH_EMAIL_FROM;
    else process.env.AUTH_EMAIL_FROM = realFrom;
  });

  test("prefers the stored key + from-address over env vars when both are configured", async () => {
    process.env.RESEND_API_KEY = "env_key_should_lose";
    process.env.AUTH_EMAIL_FROM = "env-from@should-lose.com";
    const t = newT();
    const s = await setupChapter(t, { email: SUPERUSER_EMAIL });
    await s.as.mutation(api.integrationSettings.setResendSettings, {
      apiKey: "stored_key_should_win",
      fromAddress: "Chapter OS <stored-from@publicworship.life>",
    });

    let authHeader: string | undefined;
    let body: Record<string, unknown> | undefined;
    globalThis.fetch = (async (
      _url: string,
      init?: { headers?: Record<string, string>; body?: string },
    ) => {
      authHeader = init?.headers?.Authorization;
      body = init?.body ? JSON.parse(init.body) : undefined;
      return okResendResponse();
    }) as unknown as typeof fetch;

    await t.action(internal.ticketingEmails.sendVerificationEmail, {
      email: "guest@example.com",
      code: "123456",
    });

    expect(authHeader).toBe("Bearer stored_key_should_win");
    expect(body?.from).toBe("Chapter OS <stored-from@publicworship.life>");
    expect(body?.to).toBe("guest@example.com");
  });

  test("falls back to RESEND_API_KEY / AUTH_EMAIL_FROM when nothing is stored", async () => {
    process.env.RESEND_API_KEY = "env_key_used";
    process.env.AUTH_EMAIL_FROM = "env-from@used.com";
    const t = newT();
    await setupChapter(t); // no superuser, no stored setting

    let authHeader: string | undefined;
    let body: Record<string, unknown> | undefined;
    globalThis.fetch = (async (
      _url: string,
      init?: { headers?: Record<string, string>; body?: string },
    ) => {
      authHeader = init?.headers?.Authorization;
      body = init?.body ? JSON.parse(init.body) : undefined;
      return okResendResponse();
    }) as unknown as typeof fetch;

    await t.action(internal.ticketingEmails.sendVerificationEmail, {
      email: "guest@example.com",
      code: "123456",
    });

    expect(authHeader).toBe("Bearer env_key_used");
    expect(body?.from).toBe("env-from@used.com");
  });

  test("a stored key with no from-address falls back to the env from-address", async () => {
    delete process.env.RESEND_API_KEY;
    process.env.AUTH_EMAIL_FROM = "env-from@fallback.com";
    const t = newT();
    const s = await setupChapter(t, { email: SUPERUSER_EMAIL });
    await s.as.mutation(api.integrationSettings.setResendSettings, {
      apiKey: "stored_key_no_from",
      fromAddress: null,
    });

    let body: Record<string, unknown> | undefined;
    globalThis.fetch = (async (
      _url: string,
      init?: { headers?: Record<string, string>; body?: string },
    ) => {
      body = init?.body ? JSON.parse(init.body) : undefined;
      return okResendResponse();
    }) as unknown as typeof fetch;

    await t.action(internal.ticketingEmails.sendVerificationEmail, {
      email: "guest@example.com",
      code: "123456",
    });

    expect(body?.from).toBe("env-from@fallback.com");
  });

  test("degrades gracefully (no fetch, no throw) when neither a stored setting nor RESEND_API_KEY exists", async () => {
    delete process.env.RESEND_API_KEY;
    delete process.env.AUTH_EMAIL_FROM;
    const t = newT();
    await setupChapter(t);

    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return okResendResponse();
    }) as unknown as typeof fetch;

    await expect(
      t.action(internal.ticketingEmails.sendVerificationEmail, {
        email: "guest@example.com",
        code: "123456",
      }),
    ).resolves.toBeNull();

    expect(fetchCalled).toBe(false);
  });

  // ── FIX 1: non-2xx vs. transport-failure semantics ─────────────────────────
  // The regression this guards: `sendResendEmail` used to throw on BOTH a
  // non-2xx response AND a network exception, and `sendEmailReporting`
  // swallowed both in one blanket try/catch — so a full Resend outage looked
  // identical to an ordinary bounce, and `blasts.ts#deliverEmailBlast`'s
  // per-recipient catch (which needs a real throw to count a failure) never
  // fired for either. Now: non-2xx logs + resolves `false` (no throw);
  // a transport/fetch exception propagates all the way out.

  test("a non-2xx Resend response is logged and resolves without throwing", async () => {
    process.env.RESEND_API_KEY = "env_key_used";
    process.env.AUTH_EMAIL_FROM = "env-from@used.com";
    const t = newT();
    await setupChapter(t);

    globalThis.fetch = (async () => ({
      ok: false,
      status: 422,
      text: async () => '{"message":"invalid to address"}',
    })) as unknown as typeof fetch;

    // The action itself never throws — sendEmail/sendEmailReporting treat a
    // rejected response as a best-effort miss, not a system failure.
    await expect(
      t.action(internal.ticketingEmails.sendVerificationEmail, {
        email: "guest@example.com",
        code: "123456",
      }),
    ).resolves.toBeNull();
  });

  test("a fetch/network exception propagates out of the send chokepoint instead of being swallowed", async () => {
    process.env.RESEND_API_KEY = "env_key_used";
    process.env.AUTH_EMAIL_FROM = "env-from@used.com";
    const t = newT();
    await setupChapter(t);

    globalThis.fetch = (async () => {
      throw new Error("resend is unreachable");
    }) as unknown as typeof fetch;

    await expect(
      t.action(internal.ticketingEmails.sendVerificationEmail, {
        email: "guest@example.com",
        code: "123456",
      }),
    ).rejects.toThrow(/resend is unreachable/);
  });
});
