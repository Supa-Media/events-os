import { afterEach, describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * Integration settings (Attendance E) tests — the deployment-wide
 * `integrationSettings` singleton that stores the Givebutter API key:
 *  - `getIntegrationsStatus` / `setGivebutterApiKey` are SUPERUSER-gated (a
 *    non-superuser is rejected on both read and write),
 *  - the status projection NEVER carries the raw key — only
 *    `{configured, last4, updatedAt}`,
 *  - `setGivebutterApiKey` UPSERTS the singleton (at most one row), trims +
 *    rejects an empty key, and `apiKey: null` clears it,
 *  - `givebutterSync.ts`'s key resolution (`resolveGivebutterApiKey`) prefers
 *    the stored setting over `GIVEBUTTER_API_KEY`, falls back to the env var
 *    when nothing is stored, and no-ops cleanly (no fetch, no timestamp
 *    stamp) when neither exists — extending the `givebutterSync.test.ts`
 *    "no-key degrade" coverage to the new resolution order.
 *  - The Resend inbound webhook signing secret (`setResendInboundWebhookSecret`
 *    / `readResendInboundWebhookSecret`) follows the SAME superuser gate,
 *    write-only projection, trim/upsert/clear, and stored-setting-first
 *    resolution discipline as the Givebutter key.
 */

const SUPERUSER_EMAIL = "seyi@publicworship.life";

async function settingsRows(s: ChapterSetup) {
  return await run(s.t, (ctx) =>
    ctx.db.query("integrationSettings").collect(),
  );
}

describe("superuser gate", () => {
  test("a non-superuser is rejected on read", async () => {
    const t = newT();
    const s = await setupChapter(t); // default leader@ — NOT a superuser
    await expect(
      s.as.query(api.integrationSettings.getIntegrationsStatus, {}),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("a non-superuser is rejected on write — no row written", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await expect(
      s.as.mutation(api.integrationSettings.setGivebutterApiKey, {
        apiKey: "sk_test_123",
      }),
    ).rejects.toBeInstanceOf(ConvexError);
    expect((await settingsRows(s)).length).toBe(0);
  });

  test("a non-superuser is rejected setting the Resend inbound webhook secret — no row written", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await expect(
      s.as.mutation(api.integrationSettings.setResendInboundWebhookSecret, {
        secret: "whsec_abc123",
      }),
    ).rejects.toBeInstanceOf(ConvexError);
    expect((await settingsRows(s)).length).toBe(0);
  });
});

describe("setGivebutterApiKey (superuser) → getIntegrationsStatus", () => {
  test("set → status shows configured + correct last4 + updatedAt, and NEVER the key itself", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPERUSER_EMAIL });

    await s.as.mutation(api.integrationSettings.setGivebutterApiKey, {
      apiKey: "sk_test_ABCDwxyz9876",
    });

    const status = await s.as.query(
      api.integrationSettings.getIntegrationsStatus,
      {},
    );
    expect(status.givebutter).toMatchObject({
      configured: true,
      last4: "9876",
    });
    expect(status.givebutter.updatedAt).toBeTruthy();

    // The full key is NEVER present anywhere in the query result.
    expect(JSON.stringify(status)).not.toContain("sk_test_ABCDwxyz9876");
    expect((status.givebutter as Record<string, unknown>).givebutterApiKey).toBeUndefined();
    expect((status.givebutter as Record<string, unknown>).apiKey).toBeUndefined();

    // Upsert: exactly one row, stamped updatedBy — the raw key IS on the row
    // (it has to live somewhere), just never in a query response.
    const rows = await settingsRows(s);
    expect(rows.length).toBe(1);
    expect(rows[0].updatedBy).toBe(s.userId);
    expect(rows[0].givebutterApiKey).toBe("sk_test_ABCDwxyz9876");
  });

  test("re-setting patches the SAME row (upsert, not a second insert)", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPERUSER_EMAIL });
    await s.as.mutation(api.integrationSettings.setGivebutterApiKey, {
      apiKey: "sk_test_first111",
    });
    await s.as.mutation(api.integrationSettings.setGivebutterApiKey, {
      apiKey: "sk_test_second222",
    });
    const rows = await settingsRows(s);
    expect(rows.length).toBe(1);
    expect(rows[0].givebutterApiKey).toBe("sk_test_second222");
  });

  test("rejects an empty / whitespace-only key — no row written", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPERUSER_EMAIL });
    await expect(
      s.as.mutation(api.integrationSettings.setGivebutterApiKey, {
        apiKey: "   ",
      }),
    ).rejects.toBeInstanceOf(ConvexError);
    expect((await settingsRows(s)).length).toBe(0);
  });

  test("trims whitespace around a valid key", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPERUSER_EMAIL });
    await s.as.mutation(api.integrationSettings.setGivebutterApiKey, {
      apiKey: "  sk_test_trimmed  ",
    });
    const rows = await settingsRows(s);
    expect(rows[0].givebutterApiKey).toBe("sk_test_trimmed");
  });

  test("clear (apiKey:null) removes the key — status flips to not-configured", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPERUSER_EMAIL });
    await s.as.mutation(api.integrationSettings.setGivebutterApiKey, {
      apiKey: "sk_test_toClear99",
    });
    let status = await s.as.query(
      api.integrationSettings.getIntegrationsStatus,
      {},
    );
    expect(status.givebutter.configured).toBe(true);

    await s.as.mutation(api.integrationSettings.setGivebutterApiKey, {
      apiKey: null,
    });
    status = await s.as.query(api.integrationSettings.getIntegrationsStatus, {});
    expect(status.givebutter).toMatchObject({
      configured: false,
      last4: null,
    });

    // Still ONE row (patched, not deleted) but the field itself is unset.
    const rows = await settingsRows(s);
    expect(rows.length).toBe(1);
    expect(rows[0].givebutterApiKey).toBeUndefined();
  });
});

describe("readGivebutterApiKey (internalQuery, action-facing)", () => {
  test("null when unset, the raw key once set", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPERUSER_EMAIL });
    expect(
      await t.query(internal.integrationSettings.readGivebutterApiKey, {}),
    ).toBeNull();

    await s.as.mutation(api.integrationSettings.setGivebutterApiKey, {
      apiKey: "sk_test_raw",
    });
    expect(
      await t.query(internal.integrationSettings.readGivebutterApiKey, {}),
    ).toBe("sk_test_raw");
  });
});

describe("setResendInboundWebhookSecret (superuser) → getIntegrationsStatus", () => {
  test("set → status shows configured + correct last4 + updatedAt, and NEVER the secret itself", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPERUSER_EMAIL });

    await s.as.mutation(api.integrationSettings.setResendInboundWebhookSecret, {
      secret: "whsec_ABCDwxyz9876",
    });

    const status = await s.as.query(
      api.integrationSettings.getIntegrationsStatus,
      {},
    );
    expect(status.resendInbound).toMatchObject({
      configured: true,
      last4: "9876",
    });
    expect(status.resendInbound.updatedAt).toBeTruthy();

    // The full secret is NEVER present anywhere in the query result.
    expect(JSON.stringify(status)).not.toContain("whsec_ABCDwxyz9876");
    expect(
      (status.resendInbound as Record<string, unknown>).resendInboundWebhookSecret,
    ).toBeUndefined();
    expect((status.resendInbound as Record<string, unknown>).secret).toBeUndefined();

    // Upsert: exactly one row, stamped updatedBy — the raw secret IS on the
    // row (it has to live somewhere), just never in a query response.
    const rows = await settingsRows(s);
    expect(rows.length).toBe(1);
    expect(rows[0].updatedBy).toBe(s.userId);
    expect(rows[0].resendInboundWebhookSecret).toBe("whsec_ABCDwxyz9876");
  });

  test("re-setting patches the SAME row (upsert, not a second insert)", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPERUSER_EMAIL });
    await s.as.mutation(api.integrationSettings.setResendInboundWebhookSecret, {
      secret: "whsec_first111",
    });
    await s.as.mutation(api.integrationSettings.setResendInboundWebhookSecret, {
      secret: "whsec_second222",
    });
    const rows = await settingsRows(s);
    expect(rows.length).toBe(1);
    expect(rows[0].resendInboundWebhookSecret).toBe("whsec_second222");
  });

  test("rejects an empty / whitespace-only secret — no row written", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPERUSER_EMAIL });
    await expect(
      s.as.mutation(api.integrationSettings.setResendInboundWebhookSecret, {
        secret: "   ",
      }),
    ).rejects.toBeInstanceOf(ConvexError);
    expect((await settingsRows(s)).length).toBe(0);
  });

  test("trims whitespace around a valid secret", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPERUSER_EMAIL });
    await s.as.mutation(api.integrationSettings.setResendInboundWebhookSecret, {
      secret: "  whsec_trimmed  ",
    });
    const rows = await settingsRows(s);
    expect(rows[0].resendInboundWebhookSecret).toBe("whsec_trimmed");
  });

  test("clear (secret:null) removes the secret — status flips to not-configured", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPERUSER_EMAIL });
    await s.as.mutation(api.integrationSettings.setResendInboundWebhookSecret, {
      secret: "whsec_toClear99",
    });
    let status = await s.as.query(
      api.integrationSettings.getIntegrationsStatus,
      {},
    );
    expect(status.resendInbound.configured).toBe(true);

    await s.as.mutation(api.integrationSettings.setResendInboundWebhookSecret, {
      secret: null,
    });
    status = await s.as.query(api.integrationSettings.getIntegrationsStatus, {});
    expect(status.resendInbound).toMatchObject({
      configured: false,
      last4: null,
    });

    // Still ONE row (patched, not deleted) but the field itself is unset.
    const rows = await settingsRows(s);
    expect(rows.length).toBe(1);
    expect(rows[0].resendInboundWebhookSecret).toBeUndefined();
  });
});

describe("readResendInboundWebhookSecret (internalQuery, webhook-facing)", () => {
  test("null when unset, the raw secret once set", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPERUSER_EMAIL });
    expect(
      await t.query(internal.integrationSettings.readResendInboundWebhookSecret, {}),
    ).toBeNull();

    await s.as.mutation(api.integrationSettings.setResendInboundWebhookSecret, {
      secret: "whsec_raw",
    });
    expect(
      await t.query(internal.integrationSettings.readResendInboundWebhookSecret, {}),
    ).toBe("whsec_raw");
  });
});

// ── givebutterSync.ts key resolution (stored setting → env → no-op) ─────────

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
      name: "Field Day",
      eventDate: now + 14 * 24 * 60 * 60 * 1000,
      status: "planning",
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
  });
}

async function seedPage(
  s: ChapterSetup,
  eventId: Id<"events">,
  campaignId: string,
): Promise<Id<"eventPages">> {
  const pageId = (await s.as.mutation(api.ticketing.createPage, {
    eventId,
  })) as Id<"eventPages">;
  await s.as.mutation(api.ticketing.updatePage, {
    pageId,
    patch: { givebutterCampaignId: campaignId },
  });
  return pageId;
}

/** A minimal fetch Response stand-in for an empty Givebutter tickets page. */
function emptyTicketsPage(): unknown {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data: [], links: { next: null } }),
    text: async () => "{}",
  };
}

// ── Switchable AI engine (Ollama vs OpenRouter) ──────────────────────────────

describe("AI engine — superuser gate + write-only Ollama key", () => {
  test("a non-superuser is rejected setting the Ollama key — no row written", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await expect(
      s.as.mutation(api.integrationSettings.setOllamaApiKey, {
        apiKey: "ollama_secret_123",
      }),
    ).rejects.toBeInstanceOf(ConvexError);
    expect((await settingsRows(s)).length).toBe(0);
  });

  test("a non-superuser is rejected setting the AI engine — no row written", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await expect(
      s.as.mutation(api.integrationSettings.setAiEngine, { provider: "ollama" }),
    ).rejects.toBeInstanceOf(ConvexError);
    expect((await settingsRows(s)).length).toBe(0);
  });

  test("set Ollama key → status shows configured + last4, NEVER the key itself", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPERUSER_EMAIL });

    await s.as.mutation(api.integrationSettings.setOllamaApiKey, {
      apiKey: "ollama_ABCDwxyz9876",
    });

    const status = await s.as.query(
      api.integrationSettings.getIntegrationsStatus,
      {},
    );
    expect(status.aiEngine).toMatchObject({
      provider: "openrouter", // default until switched
      ollamaConfigured: true,
      ollamaLast4: "9876",
    });
    // The full key is NEVER present anywhere in the projection.
    expect(JSON.stringify(status)).not.toContain("ollama_ABCDwxyz9876");
    expect((status.aiEngine as Record<string, unknown>).ollamaApiKey).toBeUndefined();

    // The raw key IS on the row, readable only via the internalQuery.
    const rows = await settingsRows(s);
    expect(rows.length).toBe(1);
    expect(rows[0].ollamaApiKey).toBe("ollama_ABCDwxyz9876");
  });

  test("clear (apiKey:null) removes the Ollama key — status flips to not-configured", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPERUSER_EMAIL });
    await s.as.mutation(api.integrationSettings.setOllamaApiKey, {
      apiKey: "ollama_toClear99",
    });
    await s.as.mutation(api.integrationSettings.setOllamaApiKey, { apiKey: null });
    const status = await s.as.query(
      api.integrationSettings.getIntegrationsStatus,
      {},
    );
    expect(status.aiEngine.ollamaConfigured).toBe(false);
    expect(status.aiEngine.ollamaLast4).toBeNull();
    const rows = await settingsRows(s);
    expect(rows[0].ollamaApiKey).toBeUndefined();
  });

  test("rejects an empty / whitespace-only Ollama key", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPERUSER_EMAIL });
    await expect(
      s.as.mutation(api.integrationSettings.setOllamaApiKey, { apiKey: "   " }),
    ).rejects.toBeInstanceOf(ConvexError);
  });
});

describe("setAiEngine (superuser) → status projection", () => {
  test("provider / model / baseUrl set, then individually cleared", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPERUSER_EMAIL });

    await s.as.mutation(api.integrationSettings.setAiEngine, {
      provider: "ollama",
      model: "glm-ocr",
      baseUrl: "https://self.host",
    });
    let status = await s.as.query(
      api.integrationSettings.getIntegrationsStatus,
      {},
    );
    expect(status.aiEngine).toMatchObject({
      provider: "ollama",
      model: "glm-ocr",
      ollamaBaseUrl: "https://self.host",
    });

    // Clear just the model (null) — provider + baseUrl stay.
    await s.as.mutation(api.integrationSettings.setAiEngine, { model: null });
    status = await s.as.query(api.integrationSettings.getIntegrationsStatus, {});
    expect(status.aiEngine.model).toBeNull();
    expect(status.aiEngine.provider).toBe("ollama");
    expect(status.aiEngine.ollamaBaseUrl).toBe("https://self.host");

    // Switch back to openrouter without touching baseUrl.
    await s.as.mutation(api.integrationSettings.setAiEngine, {
      provider: "openrouter",
    });
    status = await s.as.query(api.integrationSettings.getIntegrationsStatus, {});
    expect(status.aiEngine.provider).toBe("openrouter");
  });

  test("rejects an empty model / baseUrl", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPERUSER_EMAIL });
    await expect(
      s.as.mutation(api.integrationSettings.setAiEngine, { model: "  " }),
    ).rejects.toBeInstanceOf(ConvexError);
    await expect(
      s.as.mutation(api.integrationSettings.setAiEngine, { baseUrl: "" }),
    ).rejects.toBeInstanceOf(ConvexError);
  });
});

describe("readAiEngineConfig (internalQuery) — stored-first → env fallback", () => {
  const realOllamaKey = process.env.OLLAMA_API_KEY;
  const realOllamaBase = process.env.OLLAMA_BASE_URL;
  const realOpenRouterKey = process.env.OPENROUTER_API_KEY;
  afterEach(() => {
    const restore = (k: string, v: string | undefined) =>
      v === undefined ? delete process.env[k] : (process.env[k] = v);
    restore("OLLAMA_API_KEY", realOllamaKey);
    restore("OLLAMA_BASE_URL", realOllamaBase);
    restore("OPENROUTER_API_KEY", realOpenRouterKey);
  });

  test("absent config → provider openrouter, key from OPENROUTER_API_KEY env", async () => {
    process.env.OPENROUTER_API_KEY = "or_env_key";
    const t = newT();
    const cfg = await t.query(internal.integrationSettings.readAiEngineConfig, {});
    expect(cfg.provider).toBe("openrouter");
    expect(cfg.apiKey).toBe("or_env_key");
    expect(cfg.baseUrl).toBe("https://openrouter.ai/api");
    expect(cfg.model).toBeNull();
  });

  test("ollama: stored key beats OLLAMA_API_KEY env; stored baseUrl beats env + default", async () => {
    process.env.OLLAMA_API_KEY = "env_ollama_should_lose";
    process.env.OLLAMA_BASE_URL = "https://env.host";
    const t = newT();
    const s = await setupChapter(t, { email: SUPERUSER_EMAIL });
    await s.as.mutation(api.integrationSettings.setAiEngine, {
      provider: "ollama",
      model: "gemma4",
      baseUrl: "https://stored.host",
    });
    await s.as.mutation(api.integrationSettings.setOllamaApiKey, {
      apiKey: "stored_ollama_wins",
    });
    const cfg = await t.query(internal.integrationSettings.readAiEngineConfig, {});
    expect(cfg).toEqual({
      provider: "ollama",
      baseUrl: "https://stored.host",
      apiKey: "stored_ollama_wins",
      model: "gemma4",
    });
  });

  test("ollama: falls back to OLLAMA_API_KEY env + default base URL when nothing stored", async () => {
    process.env.OLLAMA_API_KEY = "env_ollama_used";
    delete process.env.OLLAMA_BASE_URL;
    const t = newT();
    const s = await setupChapter(t, { email: SUPERUSER_EMAIL });
    await s.as.mutation(api.integrationSettings.setAiEngine, { provider: "ollama" });
    const cfg = await t.query(internal.integrationSettings.readAiEngineConfig, {});
    expect(cfg.provider).toBe("ollama");
    expect(cfg.apiKey).toBe("env_ollama_used");
    expect(cfg.baseUrl).toBe("https://ollama.com");
    expect(cfg.model).toBeNull();
  });
});

describe("givebutterSync key resolution (PR E)", () => {
  const realFetch = globalThis.fetch;
  const realKey = process.env.GIVEBUTTER_API_KEY;

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.GIVEBUTTER_API_KEY;
    else process.env.GIVEBUTTER_API_KEY = realKey;
  });

  test("prefers the stored setting's key over GIVEBUTTER_API_KEY when both are configured", async () => {
    process.env.GIVEBUTTER_API_KEY = "env_key_should_lose";
    const t = newT();
    const s = await setupChapter(t, { email: SUPERUSER_EMAIL });
    await s.as.mutation(api.integrationSettings.setGivebutterApiKey, {
      apiKey: "stored_key_should_win",
    });
    const eventId = await seedEvent(s);
    await seedPage(s, eventId, "686283");

    let authHeader: string | undefined;
    globalThis.fetch = (async (
      _url: string,
      init?: { headers?: Record<string, string> },
    ) => {
      authHeader = init?.headers?.Authorization;
      return emptyTicketsPage();
    }) as unknown as typeof fetch;

    await expect(
      t.action(internal.givebutterSync.syncGivebutterCampaign, { eventId }),
    ).resolves.toBeNull();

    expect(authHeader).toBe("Bearer stored_key_should_win");
  });

  test("falls back to GIVEBUTTER_API_KEY when no setting is stored", async () => {
    process.env.GIVEBUTTER_API_KEY = "env_key_used";
    const t = newT();
    const s = await setupChapter(t); // no superuser, no stored setting
    const eventId = await seedEvent(s);
    await seedPage(s, eventId, "686283");

    let authHeader: string | undefined;
    globalThis.fetch = (async (
      _url: string,
      init?: { headers?: Record<string, string> },
    ) => {
      authHeader = init?.headers?.Authorization;
      return emptyTicketsPage();
    }) as unknown as typeof fetch;

    await expect(
      t.action(internal.givebutterSync.syncGivebutterCampaign, { eventId }),
    ).resolves.toBeNull();

    expect(authHeader).toBe("Bearer env_key_used");
  });

  test("no-ops cleanly (no fetch, no timestamp stamp) when neither the setting nor the env var is configured", async () => {
    delete process.env.GIVEBUTTER_API_KEY;
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    await seedPage(s, eventId, "686283");

    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return emptyTicketsPage();
    }) as unknown as typeof fetch;

    await expect(
      t.action(internal.givebutterSync.syncGivebutterCampaign, { eventId }),
    ).resolves.toBeNull();

    expect(fetchCalled).toBe(false);
    const page = await run(s.t, (ctx) =>
      ctx.db
        .query("eventPages")
        .withIndex("by_event", (q) => q.eq("eventId", eventId))
        .unique(),
    );
    expect(page?.givebutterLastSyncedAt).toBeUndefined();
  });
});
