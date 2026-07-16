/// <reference types="vite/client" />
import { afterEach, describe, expect, test } from "vitest";
import { newT, run, type TestConvex } from "./setup.helpers";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * WP-C.2 ("Card art → Digital Card Profile pipeline") backend tests:
 *  - `uploadCardArtAssets` POSTs the two PNGs to `POST /files` with the right
 *    `purpose` values, stores the returned file ids on the current mode's
 *    `financeSettings` config, and DEGRADES (no fetch, null ids) without a key,
 *  - `createDigitalCardProfile` POSTs `/digital_card_profiles` from those file
 *    ids + stores the returned profile id; degrades without a key OR without
 *    uploaded file ids,
 *  - `backfillCardProfiles` PATCHes every non-canceled, Increase-backed card
 *    with ITS OWN environment's profile id, skips canceled + legacy (no
 *    `increaseCardId`) cards and cards whose environment has no profile yet,
 *    and is idempotent (a second run patches the same cards again with no
 *    error / no duplication),
 *  - `issueCard` (cards.ts) attaches the profile at issuance when configured
 *    and omits `digital_wallet` cleanly when not — see the dedicated test in
 *    `cards.test.ts`.
 *
 * No `INCREASE_API_KEY`/`INCREASE_SANDBOX_API_KEY` in the ambient test env, so
 * every test either mocks `fetch` explicitly or asserts the degrade path.
 */

const ENV = [
  "INCREASE_API_KEY",
  "INCREASE_SANDBOX_API_KEY",
  "INCREASE_API_BASE",
] as const;

function saveEnv() {
  const original: Partial<Record<(typeof ENV)[number], string>> = {};
  for (const k of ENV) original[k] = process.env[k];
  return original;
}

function restoreEnv(original: Partial<Record<(typeof ENV)[number], string>>) {
  for (const k of ENV) {
    if (original[k] === undefined) delete process.env[k];
    else process.env[k] = original[k];
  }
}

async function setSandboxMode(t: TestConvex, sandboxMode: boolean): Promise<void> {
  await run(t, async (ctx) => {
    const existing = await ctx.db.query("financeSettings").first();
    if (existing) {
      await ctx.db.patch(existing._id, { sandboxMode, updatedAt: Date.now() });
    } else {
      await ctx.db.insert("financeSettings", { sandboxMode, updatedAt: Date.now() });
    }
  });
}

/** A trivially-decodable base64 payload — the tests never touch real PNG
 *  bytes, they only assert what WE send Increase (purpose, file ids). */
const FAKE_PNG_BASE64 = Buffer.from("not-really-a-png").toString("base64");

interface FetchCall {
  url: string;
  method: string;
  auth: string | null;
  formFields: Record<string, string> | null; // purpose (+ any other string fields)
  hasFileField: boolean;
  jsonBody: Record<string, unknown> | null;
}

/** Records every fetch call, parsing a multipart `FormData` body (purpose +
 *  whether a `file` field was attached) or a JSON body, whichever applies. */
function mockRecordingFetch(
  respond: (path: string, method: string) => { status: number; json: unknown },
) {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const auth = new Headers(init?.headers).get("authorization");
    let formFields: Record<string, string> | null = null;
    let hasFileField = false;
    let jsonBody: Record<string, unknown> | null = null;
    if (init?.body instanceof FormData) {
      formFields = {};
      for (const [k, v] of init.body.entries()) {
        if (typeof v === "string") formFields[k] = v;
        else hasFileField = hasFileField || k === "file";
      }
    } else if (typeof init?.body === "string") {
      try {
        jsonBody = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        // not JSON — leave null
      }
    }
    calls.push({ url, method, auth, formFields, hasFileField, jsonBody });
    const { status, json } = respond(url, method);
    return new Response(JSON.stringify(json), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return calls;
}

describe("uploadCardArtAssets", () => {
  const originalFetch = globalThis.fetch;
  let originalEnv: ReturnType<typeof saveEnv>;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    restoreEnv(originalEnv);
  });

  test("degrades (never calls fetch) without an Increase key for the current mode", async () => {
    originalEnv = saveEnv();
    const t = newT();
    delete process.env.INCREASE_API_KEY;
    globalThis.fetch = (() => {
      throw new Error("fetch must not be called when the key is unset");
    }) as unknown as typeof fetch;

    const result = await t.action(internal.increase.uploadCardArtAssets, {
      cardArtBase64: FAKE_PNG_BASE64,
      iconBase64: FAKE_PNG_BASE64,
    });
    expect(result).toEqual({ sandbox: false, fileId: null, iconFileId: null });

    const settings = await run(t, (ctx) => ctx.db.query("financeSettings").first());
    expect(settings?.cardArt).toBeUndefined();
  });

  test("production: uploads both files with the right purposes and stores the ids", async () => {
    originalEnv = saveEnv();
    const t = newT();
    process.env.INCREASE_API_KEY = "prod_key";
    delete process.env.INCREASE_API_BASE;
    let n = 0;
    const calls = mockRecordingFetch(() => {
      n += 1;
      return { status: 200, json: { id: `file_${n}` } };
    });

    const result = await t.action(internal.increase.uploadCardArtAssets, {
      cardArtBase64: FAKE_PNG_BASE64,
      iconBase64: FAKE_PNG_BASE64,
    });
    expect(result.sandbox).toBe(false);
    expect(result.fileId).toBe("file_1");
    expect(result.iconFileId).toBe("file_2");

    expect(calls.length).toBe(2);
    for (const c of calls) {
      expect(c.method).toBe("POST");
      expect(c.url).toBe("https://api.increase.com/files");
      expect(c.auth).toBe("Bearer prod_key");
      expect(c.hasFileField).toBe(true);
    }
    expect(calls[0].formFields?.purpose).toBe("digital_wallet_artwork");
    expect(calls[1].formFields?.purpose).toBe("digital_wallet_app_icon");

    const settings = await run(t, (ctx) => ctx.db.query("financeSettings").first());
    expect(settings?.cardArt).toEqual({ fileId: "file_1", iconFileId: "file_2" });
    expect(settings?.cardArtSandbox).toBeUndefined();
  });

  test("sandbox mode: routes to the sandbox host/key and stores under cardArtSandbox", async () => {
    originalEnv = saveEnv();
    const t = newT();
    await setSandboxMode(t, true);
    process.env.INCREASE_API_KEY = "prod_key";
    process.env.INCREASE_SANDBOX_API_KEY = "sandbox_key";
    let n = 0;
    const calls = mockRecordingFetch(() => {
      n += 1;
      return { status: 200, json: { id: `sandbox_file_${n}` } };
    });

    const result = await t.action(internal.increase.uploadCardArtAssets, {
      cardArtBase64: FAKE_PNG_BASE64,
      iconBase64: FAKE_PNG_BASE64,
    });
    expect(result.sandbox).toBe(true);
    expect(calls.every((c) => new URL(c.url).host === "sandbox.increase.com")).toBe(true);
    expect(calls.every((c) => c.auth === "Bearer sandbox_key")).toBe(true);

    const settings = await run(t, (ctx) => ctx.db.query("financeSettings").first());
    expect(settings?.cardArtSandbox).toEqual({
      fileId: "sandbox_file_1",
      iconFileId: "sandbox_file_2",
    });
    expect(settings?.cardArt).toBeUndefined();
  });

  test("re-uploading refreshes file ids but leaves a previously-minted profileId in place", async () => {
    originalEnv = saveEnv();
    const t = newT();
    process.env.INCREASE_API_KEY = "prod_key";
    await run(t, (ctx) =>
      ctx.db.insert("financeSettings", {
        sandboxMode: false,
        updatedAt: Date.now(),
        cardArt: { fileId: "file_old_art", iconFileId: "file_old_icon", profileId: "digital_card_profile_existing" },
      }),
    );
    let n = 0;
    mockRecordingFetch(() => {
      n += 1;
      return { status: 200, json: { id: `file_new_${n}` } };
    });

    await t.action(internal.increase.uploadCardArtAssets, {
      cardArtBase64: FAKE_PNG_BASE64,
      iconBase64: FAKE_PNG_BASE64,
    });

    const settings = await run(t, (ctx) => ctx.db.query("financeSettings").first());
    expect(settings?.cardArt).toEqual({
      fileId: "file_new_1",
      iconFileId: "file_new_2",
      profileId: "digital_card_profile_existing",
    });
  });
});

describe("createDigitalCardProfile", () => {
  const originalFetch = globalThis.fetch;
  let originalEnv: ReturnType<typeof saveEnv>;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    restoreEnv(originalEnv);
  });

  test("degrades (returns null, never calls fetch) without an Increase key", async () => {
    originalEnv = saveEnv();
    const t = newT();
    delete process.env.INCREASE_API_KEY;
    await run(t, (ctx) =>
      ctx.db.insert("financeSettings", {
        sandboxMode: false,
        updatedAt: Date.now(),
        cardArt: { fileId: "file_art", iconFileId: "file_icon" },
      }),
    );
    globalThis.fetch = (() => {
      throw new Error("fetch must not be called when the key is unset");
    }) as unknown as typeof fetch;

    const profileId = await t.action(internal.increase.createDigitalCardProfile, {});
    expect(profileId).toBeNull();
  });

  test("degrades (returns null, never calls fetch) when no file ids are uploaded yet", async () => {
    originalEnv = saveEnv();
    const t = newT();
    process.env.INCREASE_API_KEY = "prod_key";
    globalThis.fetch = (() => {
      throw new Error("fetch must not be called with no uploaded file ids");
    }) as unknown as typeof fetch;

    const profileId = await t.action(internal.increase.createDigitalCardProfile, {});
    expect(profileId).toBeNull();
  });

  test("posts the required fields + white text color and stores the returned profile id", async () => {
    originalEnv = saveEnv();
    const t = newT();
    process.env.INCREASE_API_KEY = "prod_key";
    await run(t, (ctx) =>
      ctx.db.insert("financeSettings", {
        sandboxMode: false,
        updatedAt: Date.now(),
        cardArt: { fileId: "file_art", iconFileId: "file_icon" },
      }),
    );
    const calls = mockRecordingFetch(() => ({
      status: 200,
      json: { id: "digital_card_profile_123", status: "pending" },
    }));

    const profileId = await t.action(internal.increase.createDigitalCardProfile, {});
    expect(profileId).toBe("digital_card_profile_123");
    expect(calls.length).toBe(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("https://api.increase.com/digital_card_profiles");
    expect(calls[0].jsonBody).toEqual({
      background_image_file_id: "file_art",
      app_icon_file_id: "file_icon",
      card_description: "Public Worship",
      issuer_name: "Public Worship",
      description: "Public Worship — card art (WP-C.2)",
      text_color: { red: 255, green: 255, blue: 255 },
    });

    const settings = await run(t, (ctx) => ctx.db.query("financeSettings").first());
    expect(settings?.cardArt?.profileId).toBe("digital_card_profile_123");
  });
});

describe("backfillCardProfiles", () => {
  const originalFetch = globalThis.fetch;
  let originalEnv: ReturnType<typeof saveEnv>;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    restoreEnv(originalEnv);
  });

  async function makeChapter(t: TestConvex): Promise<Id<"chapters">> {
    return run(t, (ctx) =>
      ctx.db.insert("chapters", { name: "Test Chapter", isActive: true, createdAt: Date.now() }),
    );
  }

  async function makeCardholder(t: TestConvex, chapterId: Id<"chapters">): Promise<Id<"people">> {
    return run(t, (ctx) =>
      ctx.db.insert("people", {
        chapterId,
        name: "Holder",
        isTeamMember: true,
        pwEmail: "holder@publicworship.life",
        createdAt: Date.now(),
      }),
    );
  }

  async function seedCard(
    t: TestConvex,
    chapterId: Id<"chapters">,
    cardholderPersonId: Id<"people">,
    opts: { status?: "active" | "locked" | "canceled"; increaseCardId?: string },
  ): Promise<Id<"cards">> {
    return run(t, (ctx) =>
      ctx.db.insert("cards", {
        chapterId,
        cardholderPersonId,
        type: "virtual",
        status: opts.status ?? "active",
        increaseCardId: opts.increaseCardId,
        createdAt: Date.now(),
      }),
    );
  }

  test("skips canceled + legacy (no increaseCardId) cards; patches the rest", async () => {
    originalEnv = saveEnv();
    const t = newT();
    process.env.INCREASE_API_KEY = "prod_key";
    const chapterId = await makeChapter(t);
    const holder = await makeCardholder(t, chapterId);
    await run(t, (ctx) =>
      ctx.db.insert("financeSettings", {
        sandboxMode: false,
        updatedAt: Date.now(),
        cardArt: { fileId: "f", iconFileId: "i", profileId: "digital_card_profile_prod" },
      }),
    );

    await seedCard(t, chapterId, holder, { status: "active", increaseCardId: "card_active" });
    await seedCard(t, chapterId, holder, { status: "canceled", increaseCardId: "card_canceled" });
    await seedCard(t, chapterId, holder, { status: "active" }); // legacy — no increaseCardId

    const calls = mockRecordingFetch(() => ({ status: 200, json: { id: "card_active" } }));

    const result = await t.action(internal.increase.backfillCardProfiles, {});
    expect(result.scanned).toBe(1); // only the one eligible card
    expect(result.patched).toBe(1);
    expect(result.skipped).toBe(0);

    expect(calls.length).toBe(1);
    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].url).toBe("https://api.increase.com/cards/card_active");
    expect(calls[0].jsonBody).toEqual({
      digital_wallet: { digital_card_profile_id: "digital_card_profile_prod" },
    });
  });

  test("routes each card to ITS OWN environment's profile id (sandbox vs. production)", async () => {
    originalEnv = saveEnv();
    const t = newT();
    process.env.INCREASE_API_KEY = "prod_key";
    process.env.INCREASE_SANDBOX_API_KEY = "sandbox_key";
    const chapterId = await makeChapter(t);
    const holder = await makeCardholder(t, chapterId);
    await run(t, (ctx) =>
      ctx.db.insert("financeSettings", {
        sandboxMode: false,
        updatedAt: Date.now(),
        cardArt: { fileId: "f", iconFileId: "i", profileId: "digital_card_profile_prod" },
        cardArtSandbox: {
          fileId: "sandbox_f",
          iconFileId: "sandbox_i",
          profileId: "sandbox_digital_card_profile",
        },
      }),
    );
    await seedCard(t, chapterId, holder, { increaseCardId: "card_prod" });
    await seedCard(t, chapterId, holder, { increaseCardId: "sandbox_card_1" });

    const calls = mockRecordingFetch(() => ({ status: 200, json: {} }));
    const result = await t.action(internal.increase.backfillCardProfiles, {});
    expect(result.patched).toBe(2);

    const prodCall = calls.find((c) => c.url.includes("/cards/card_prod"));
    expect(prodCall).toBeTruthy();
    expect(new URL(prodCall!.url).host).toBe("api.increase.com");
    expect(prodCall!.auth).toBe("Bearer prod_key");
    expect(prodCall!.jsonBody).toEqual({
      digital_wallet: { digital_card_profile_id: "digital_card_profile_prod" },
    });

    const sandboxCall = calls.find((c) => c.url.includes("/cards/sandbox_card_1"));
    expect(sandboxCall).toBeTruthy();
    expect(new URL(sandboxCall!.url).host).toBe("sandbox.increase.com");
    expect(sandboxCall!.auth).toBe("Bearer sandbox_key");
    expect(sandboxCall!.jsonBody).toEqual({
      digital_wallet: { digital_card_profile_id: "sandbox_digital_card_profile" },
    });
  });

  test("skips (never calls fetch for) a card whose environment has no minted profile yet", async () => {
    originalEnv = saveEnv();
    const t = newT();
    process.env.INCREASE_API_KEY = "prod_key";
    const chapterId = await makeChapter(t);
    const holder = await makeCardholder(t, chapterId);
    // No financeSettings row at all — no profile configured for any mode.
    await seedCard(t, chapterId, holder, { increaseCardId: "card_no_profile" });

    globalThis.fetch = (() => {
      throw new Error("fetch must not be called with no profile configured");
    }) as unknown as typeof fetch;

    const result = await t.action(internal.increase.backfillCardProfiles, {});
    expect(result.scanned).toBe(1);
    expect(result.patched).toBe(0);
    expect(result.skipped).toBe(1);
  });

  test("is idempotent — a second run patches the same eligible cards again with no error", async () => {
    originalEnv = saveEnv();
    const t = newT();
    process.env.INCREASE_API_KEY = "prod_key";
    const chapterId = await makeChapter(t);
    const holder = await makeCardholder(t, chapterId);
    await run(t, (ctx) =>
      ctx.db.insert("financeSettings", {
        sandboxMode: false,
        updatedAt: Date.now(),
        cardArt: { fileId: "f", iconFileId: "i", profileId: "digital_card_profile_prod" },
      }),
    );
    await seedCard(t, chapterId, holder, { increaseCardId: "card_active" });
    mockRecordingFetch(() => ({ status: 200, json: {} }));

    const first = await t.action(internal.increase.backfillCardProfiles, {});
    expect(first.patched).toBe(1);

    const second = await t.action(internal.increase.backfillCardProfiles, {});
    expect(second.patched).toBe(1);
    expect(second.skipped).toBe(0);
  });
});
