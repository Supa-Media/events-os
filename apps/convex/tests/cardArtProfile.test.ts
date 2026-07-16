/// <reference types="vite/client" />
import { afterEach, describe, expect, test } from "vitest";
import { newT, run, type TestConvex } from "./setup.helpers";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * WP-C.2 ("Card art → Digital Card Profile pipeline") backend tests:
 *  - `uploadCardArtAssets` POSTs the two PNGs to `POST /files` as a HAND-BUILT
 *    multipart/form-data body (no `FormData`/`Blob` — see `increasePostFile`'s
 *    doc comment) with the right `purpose` values, stores the returned file
 *    ids on the current mode's `financeSettings` config, and DEGRADES (no
 *    fetch, null ids) without a key,
 *  - the hand-built multipart body itself is byte-exact — boundary placement,
 *    CRLFs, content-disposition lines, and an untouched binary payload,
 *  - `createDigitalCardProfile` POSTs `/digital_card_profiles` from those file
 *    ids + stores the returned profile id with `profileStatus: "pending"`;
 *    degrades without a key OR without uploaded file ids,
 *  - `refreshCardArtProfileStatus` GETs `/digital_card_profiles/{id}` and
 *    stores whatever status Increase reports, defensively normalizing any
 *    unrecognized value to `"pending"`; degrades without a key OR without a
 *    minted profile,
 *  - `getCardArtProfileId` (read by `issueCard` + `backfillCardProfiles`)
 *    ONLY surfaces the profile id once its stored status is `"active"` — a
 *    `"pending"` or `"rejected"` profile attaches to nothing,
 *  - `backfillCardProfiles` PATCHes every non-canceled, Increase-backed,
 *    ACTIVE-profile card with ITS OWN environment's profile id, skips
 *    canceled + legacy (no `increaseCardId`) cards, cards whose environment
 *    has no ACTIVE profile yet, and is idempotent (a second run patches the
 *    same cards again with no error / no duplication),
 *  - `issueCard` (cards.ts) attaches the profile at issuance when configured
 *    AND active, and omits `digital_wallet` cleanly otherwise — see the
 *    dedicated test in `cards.test.ts`.
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
  rawBody: Uint8Array | null;
  contentType: string | null;
}

/** Parse the boundary out of a `Content-Type: multipart/form-data;
 *  boundary=...` header. Deliberately independent of `increase.ts`'s own
 *  `buildMultipartFormData` — this reads the wire format `increasePostFile`
 *  actually sent, not a value it computed. */
function extractBoundary(contentType: string | null): string | null {
  const match = contentType?.match(/boundary=(.+)$/);
  return match ? match[1] : null;
}

/** Split a raw multipart body (bytes, NOT decoded text — a binary payload can
 *  contain bytes that are invalid UTF-8) into its named parts: every string
 *  field's decoded value, plus whether a `file` part was present. Headers are
 *  ASCII so decoding just the header slice is safe; the body slice of each
 *  part is handled as raw bytes throughout. */
function parseMultipartFields(
  body: Uint8Array,
  boundary: string,
): { formFields: Record<string, string>; hasFileField: boolean } {
  const decoder = new TextDecoder("utf-8");
  const encoder = new TextEncoder();
  const delimiter = encoder.encode(`--${boundary}`);
  const formFields: Record<string, string> = {};
  let hasFileField = false;

  const boundaryIndexes: number[] = [];
  for (let i = 0; i <= body.length - delimiter.length; i++) {
    let matched = true;
    for (let j = 0; j < delimiter.length; j++) {
      if (body[i + j] !== delimiter[j]) {
        matched = false;
        break;
      }
    }
    if (matched) boundaryIndexes.push(i);
  }

  for (let k = 0; k < boundaryIndexes.length - 1; k++) {
    // The bytes between the end of THIS boundary line and the start of the
    // NEXT boundary line are exactly one part: `\r\n{headers}\r\n\r\n{body}\r\n`.
    const partStart = boundaryIndexes[k] + delimiter.length;
    const partEnd = boundaryIndexes[k + 1];
    const partBytes = body.slice(partStart, partEnd);
    // Headers are ASCII/UTF-8 text; find the blank-line separator as bytes
    // (`\r\n\r\n`) so the subsequent binary body is never run through a text
    // decoder.
    const sep = encoder.encode("\r\n\r\n");
    let sepIndex = -1;
    for (let i = 0; i <= partBytes.length - sep.length; i++) {
      let matched = true;
      for (let j = 0; j < sep.length; j++) {
        if (partBytes[i + j] !== sep[j]) {
          matched = false;
          break;
        }
      }
      if (matched) {
        sepIndex = i;
        break;
      }
    }
    if (sepIndex === -1) continue;
    const headerText = decoder.decode(partBytes.slice(0, sepIndex)).replace(/^\r\n/, "");
    // Trailing `\r\n` before the next boundary delimiter belongs to the
    // multipart framing, not the field value.
    const rawFieldBody = partBytes.slice(sepIndex + sep.length, partBytes.length - 2);
    const nameMatch = headerText.match(/name="([^"]+)"/);
    if (!nameMatch) continue;
    if (/filename="/.test(headerText)) {
      hasFileField = hasFileField || nameMatch[1] === "file";
    } else {
      formFields[nameMatch[1]] = decoder.decode(rawFieldBody);
    }
  }

  return { formFields, hasFileField };
}

/** Records every fetch call, parsing the hand-built multipart body
 *  (`increasePostFile`'s wire format — see `parseMultipartFields`) or a JSON
 *  body, whichever applies. */
function mockRecordingFetch(
  respond: (path: string, method: string) => { status: number; json: unknown },
) {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const auth = new Headers(init?.headers).get("authorization");
    const contentType = new Headers(init?.headers).get("content-type");
    let formFields: Record<string, string> | null = null;
    let hasFileField = false;
    let jsonBody: Record<string, unknown> | null = null;
    let rawBody: Uint8Array | null = null;
    if (init?.body instanceof Uint8Array) {
      rawBody = init.body;
      const boundary = extractBoundary(contentType);
      if (boundary) {
        const parsed = parseMultipartFields(init.body, boundary);
        formFields = parsed.formFields;
        hasFileField = parsed.hasFileField;
      }
    } else if (typeof init?.body === "string") {
      try {
        jsonBody = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        // not JSON — leave null
      }
    }
    calls.push({ url, method, auth, formFields, hasFileField, jsonBody, rawBody, contentType });
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

  test("increasePostFile builds an exact, RFC 7578-correct multipart body (boundary, CRLFs, content-disposition, binary payload intact)", async () => {
    originalEnv = saveEnv();
    const t = newT();
    process.env.INCREASE_API_KEY = "prod_key";
    // Every byte value 0-255 once — proves the payload survives untouched
    // (including bytes like 0x0d/0x0a that could be mistaken for CRLF framing
    // and 0x2d ("-") that could be mistaken for boundary dashes by a naive
    // parser) rather than a plain-ASCII stand-in.
    const allBytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) allBytes[i] = i;
    const base64AllBytes = Buffer.from(allBytes).toString("base64");

    const calls = mockRecordingFetch(() => ({ status: 200, json: { id: "file_1" } }));

    await t.action(internal.increase.uploadCardArtAssets, {
      cardArtBase64: base64AllBytes,
      iconBase64: FAKE_PNG_BASE64,
    });

    const artCall = calls[0];
    expect(artCall.rawBody).not.toBeNull();
    const boundary = extractBoundary(artCall.contentType);
    expect(boundary).toBeTruthy();
    expect(artCall.contentType).toBe(`multipart/form-data; boundary=${boundary}`);

    const body = artCall.rawBody!;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder("utf-8");

    // Exact expected layout, byte for byte: the "purpose" field part, then
    // the "file" field part (headers as text + the raw binary payload),
    // then the closing delimiter — every line CRLF-terminated per RFC 7578.
    const purposePart = `--${boundary!}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\ndigital_wallet_artwork\r\n`;
    const filePartHeader = `--${boundary!}\r\nContent-Disposition: form-data; name="file"; filename="card-art.png"\r\nContent-Type: image/png\r\n\r\n`;
    const closing = `\r\n--${boundary!}--\r\n`;

    const purposeBytes = encoder.encode(purposePart);
    const fileHeaderBytes = encoder.encode(filePartHeader);
    const closingBytes = encoder.encode(closing);

    // 1. The purpose part starts at byte 0, exactly as constructed.
    expect(Array.from(body.slice(0, purposeBytes.length))).toEqual(Array.from(purposeBytes));

    // 2. The file part's headers immediately follow.
    let offset = purposeBytes.length;
    expect(Array.from(body.slice(offset, offset + fileHeaderBytes.length))).toEqual(
      Array.from(fileHeaderBytes),
    );
    offset += fileHeaderBytes.length;

    // 3. The binary payload immediately follows, byte-for-byte identical to
    // the original 256-byte input — no re-encoding, no truncation, no
    // corruption from the CRLF/boundary framing around it.
    const payloadBytes = body.slice(offset, offset + allBytes.length);
    expect(Array.from(payloadBytes)).toEqual(Array.from(allBytes));
    offset += allBytes.length;

    // 4. The closing boundary immediately follows the payload, with no stray
    // bytes in between.
    expect(Array.from(body.slice(offset, offset + closingBytes.length))).toEqual(
      Array.from(closingBytes),
    );
    expect(offset + closingBytes.length).toBe(body.length);

    // Sanity: every CRLF in the framing is a real `\r\n`, never a bare `\n`
    // (decode just the ASCII framing regions to confirm).
    expect(decoder.decode(body.slice(0, purposeBytes.length))).toBe(purposePart);
  });

  test("rejects a data: URI prefix instead of silently uploading a corrupt PNG", async () => {
    originalEnv = saveEnv();
    const t = newT();
    process.env.INCREASE_API_KEY = "prod_key";
    globalThis.fetch = (() => {
      throw new Error("fetch must not be called for a data: URI payload");
    }) as unknown as typeof fetch;

    await expect(
      t.action(internal.increase.uploadCardArtAssets, {
        cardArtBase64: `data:image/png;base64,${FAKE_PNG_BASE64}`,
        iconBase64: FAKE_PNG_BASE64,
      }),
    ).rejects.toThrow();
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

  test("re-uploading refreshes file ids but leaves a previously-minted profileId + profileStatus in place", async () => {
    originalEnv = saveEnv();
    const t = newT();
    process.env.INCREASE_API_KEY = "prod_key";
    await run(t, (ctx) =>
      ctx.db.insert("financeSettings", {
        sandboxMode: false,
        updatedAt: Date.now(),
        cardArt: {
          fileId: "file_old_art",
          iconFileId: "file_old_icon",
          profileId: "digital_card_profile_existing",
          profileStatus: "active",
        },
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
      profileStatus: "active",
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
    // Freshly minted — always starts pending, regardless of what Increase's
    // create response happens to report; only refreshCardArtProfileStatus
    // ever advances it.
    expect(settings?.cardArt?.profileStatus).toBe("pending");
  });
});

describe("finishCreateDigitalCardProfile", () => {
  test("no-op (logs + does not throw) when there's no prior card-art config to attach the profile id to", async () => {
    const t = newT();
    // No financeSettings row at all — the defensive branch this test covers.
    await expect(
      t.mutation(internal.increase.finishCreateDigitalCardProfile, {
        sandbox: false,
        profileId: "digital_card_profile_orphan",
      }),
    ).resolves.toBeNull();

    const settings = await run(t, (ctx) => ctx.db.query("financeSettings").first());
    expect(settings).toBeNull();
  });

  test("no-op when a financeSettings row exists but this mode has no uploaded file ids yet", async () => {
    const t = newT();
    await run(t, (ctx) =>
      ctx.db.insert("financeSettings", { sandboxMode: false, updatedAt: Date.now() }),
    );

    await expect(
      t.mutation(internal.increase.finishCreateDigitalCardProfile, {
        sandbox: false,
        profileId: "digital_card_profile_orphan",
      }),
    ).resolves.toBeNull();

    const settings = await run(t, (ctx) => ctx.db.query("financeSettings").first());
    expect(settings?.cardArt).toBeUndefined();
  });
});

describe("refreshCardArtProfileStatus", () => {
  const originalFetch = globalThis.fetch;
  let originalEnv: ReturnType<typeof saveEnv>;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    restoreEnv(originalEnv);
  });

  async function seedMintedProfile(
    t: TestConvex,
    opts: { sandbox?: boolean; profileStatus?: "pending" | "active" | "rejected" } = {},
  ): Promise<void> {
    const key = opts.sandbox ? "cardArtSandbox" : "cardArt";
    await run(t, (ctx) =>
      ctx.db.insert("financeSettings", {
        sandboxMode: opts.sandbox ?? false,
        updatedAt: Date.now(),
        [key]: {
          fileId: "file_art",
          iconFileId: "file_icon",
          profileId: "digital_card_profile_123",
          profileStatus: opts.profileStatus ?? "pending",
        },
      }),
    );
  }

  test("degrades (never calls fetch) without an Increase key for the current mode", async () => {
    originalEnv = saveEnv();
    const t = newT();
    delete process.env.INCREASE_API_KEY;
    await seedMintedProfile(t);
    globalThis.fetch = (() => {
      throw new Error("fetch must not be called when the key is unset");
    }) as unknown as typeof fetch;

    const result = await t.action(internal.increase.refreshCardArtProfileStatus, {});
    expect(result).toBeNull();
  });

  test("degrades (never calls fetch) when no profile has been minted yet for this mode", async () => {
    originalEnv = saveEnv();
    const t = newT();
    process.env.INCREASE_API_KEY = "prod_key";
    // No financeSettings row at all.
    globalThis.fetch = (() => {
      throw new Error("fetch must not be called with no minted profile");
    }) as unknown as typeof fetch;

    const result = await t.action(internal.increase.refreshCardArtProfileStatus, {});
    expect(result).toBeNull();
  });

  test("GETs the profile and stores an active status", async () => {
    originalEnv = saveEnv();
    const t = newT();
    process.env.INCREASE_API_KEY = "prod_key";
    await seedMintedProfile(t, { profileStatus: "pending" });
    const calls = mockRecordingFetch(() => ({
      status: 200,
      json: { id: "digital_card_profile_123", status: "active" },
    }));

    const result = await t.action(internal.increase.refreshCardArtProfileStatus, {});
    expect(result).toEqual({ profileId: "digital_card_profile_123", status: "active" });
    expect(calls.length).toBe(1);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe(
      "https://api.increase.com/digital_card_profiles/digital_card_profile_123",
    );

    const settings = await run(t, (ctx) => ctx.db.query("financeSettings").first());
    expect(settings?.cardArt?.profileStatus).toBe("active");
    // profileId/file ids untouched by the status refresh.
    expect(settings?.cardArt?.profileId).toBe("digital_card_profile_123");
  });

  test("stores a rejected status", async () => {
    originalEnv = saveEnv();
    const t = newT();
    process.env.INCREASE_API_KEY = "prod_key";
    await seedMintedProfile(t, { profileStatus: "pending" });
    mockRecordingFetch(() => ({
      status: 200,
      json: { id: "digital_card_profile_123", status: "rejected" },
    }));

    const result = await t.action(internal.increase.refreshCardArtProfileStatus, {});
    expect(result?.status).toBe("rejected");

    const settings = await run(t, (ctx) => ctx.db.query("financeSettings").first());
    expect(settings?.cardArt?.profileStatus).toBe("rejected");
  });

  test("normalizes an unrecognized/missing status to pending (never mistakes it for active)", async () => {
    originalEnv = saveEnv();
    const t = newT();
    process.env.INCREASE_API_KEY = "prod_key";
    await seedMintedProfile(t, { profileStatus: "pending" });
    mockRecordingFetch(() => ({
      status: 200,
      json: { id: "digital_card_profile_123" /* no status field at all */ },
    }));

    const result = await t.action(internal.increase.refreshCardArtProfileStatus, {});
    expect(result?.status).toBe("pending");
  });

  test("sandbox mode: routes to the sandbox host/key and reads/writes cardArtSandbox", async () => {
    originalEnv = saveEnv();
    const t = newT();
    await setSandboxMode(t, true);
    process.env.INCREASE_API_KEY = "prod_key";
    process.env.INCREASE_SANDBOX_API_KEY = "sandbox_key";
    await run(t, async (ctx) => {
      const existing = await ctx.db.query("financeSettings").first();
      await ctx.db.patch(existing!._id, {
        cardArtSandbox: {
          fileId: "sf",
          iconFileId: "si",
          profileId: "sandbox_digital_card_profile",
          profileStatus: "pending",
        },
      });
    });
    const calls = mockRecordingFetch(() => ({
      status: 200,
      json: { id: "sandbox_digital_card_profile", status: "active" },
    }));

    const result = await t.action(internal.increase.refreshCardArtProfileStatus, {});
    expect(result).toEqual({ profileId: "sandbox_digital_card_profile", status: "active" });
    expect(new URL(calls[0].url).host).toBe("sandbox.increase.com");
    expect(calls[0].auth).toBe("Bearer sandbox_key");

    const settings = await run(t, (ctx) => ctx.db.query("financeSettings").first());
    expect(settings?.cardArtSandbox?.profileStatus).toBe("active");
    expect(settings?.cardArt).toBeUndefined();
  });
});

describe("getCardArtProfileId (status gating)", () => {
  test("returns null when no profile has been minted", async () => {
    const t = newT();
    const result = await t.query(internal.increase.getCardArtProfileId, { sandbox: false });
    expect(result).toBeNull();
  });

  test("returns null for a pending profile", async () => {
    const t = newT();
    await run(t, (ctx) =>
      ctx.db.insert("financeSettings", {
        sandboxMode: false,
        updatedAt: Date.now(),
        cardArt: { fileId: "f", iconFileId: "i", profileId: "digital_card_profile_1", profileStatus: "pending" },
      }),
    );
    const result = await t.query(internal.increase.getCardArtProfileId, { sandbox: false });
    expect(result).toBeNull();
  });

  test("returns null for a rejected profile", async () => {
    const t = newT();
    await run(t, (ctx) =>
      ctx.db.insert("financeSettings", {
        sandboxMode: false,
        updatedAt: Date.now(),
        cardArt: { fileId: "f", iconFileId: "i", profileId: "digital_card_profile_1", profileStatus: "rejected" },
      }),
    );
    const result = await t.query(internal.increase.getCardArtProfileId, { sandbox: false });
    expect(result).toBeNull();
  });

  test("returns the profile id once it's active", async () => {
    const t = newT();
    await run(t, (ctx) =>
      ctx.db.insert("financeSettings", {
        sandboxMode: false,
        updatedAt: Date.now(),
        cardArt: { fileId: "f", iconFileId: "i", profileId: "digital_card_profile_1", profileStatus: "active" },
      }),
    );
    const result = await t.query(internal.increase.getCardArtProfileId, { sandbox: false });
    expect(result).toBe("digital_card_profile_1");
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
        cardArt: {
          fileId: "f",
          iconFileId: "i",
          profileId: "digital_card_profile_prod",
          profileStatus: "active",
        },
      }),
    );

    await seedCard(t, chapterId, holder, { status: "active", increaseCardId: "card_active" });
    await seedCard(t, chapterId, holder, { status: "canceled", increaseCardId: "card_canceled" });
    await seedCard(t, chapterId, holder, { status: "active" }); // legacy — no increaseCardId

    const calls = mockRecordingFetch(() => ({ status: 200, json: { id: "card_active" } }));

    const result = await t.action(internal.increase.backfillCardProfiles, {});
    expect(result.eligible).toBe(1); // only the one eligible card
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
        cardArt: {
          fileId: "f",
          iconFileId: "i",
          profileId: "digital_card_profile_prod",
          profileStatus: "active",
        },
        cardArtSandbox: {
          fileId: "sandbox_f",
          iconFileId: "sandbox_i",
          profileId: "sandbox_digital_card_profile",
          profileStatus: "active",
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
    expect(result.eligible).toBe(1);
    expect(result.patched).toBe(0);
    expect(result.skipped).toBe(1);
  });

  test("skips (never calls fetch for) a card whose environment's profile is still pending review", async () => {
    originalEnv = saveEnv();
    const t = newT();
    process.env.INCREASE_API_KEY = "prod_key";
    const chapterId = await makeChapter(t);
    const holder = await makeCardholder(t, chapterId);
    await run(t, (ctx) =>
      ctx.db.insert("financeSettings", {
        sandboxMode: false,
        updatedAt: Date.now(),
        // Minted but not yet reviewed — getCardArtProfileId must NOT surface
        // this id, so backfill must SKIP rather than attach it.
        cardArt: {
          fileId: "f",
          iconFileId: "i",
          profileId: "digital_card_profile_prod",
          profileStatus: "pending",
        },
      }),
    );
    await seedCard(t, chapterId, holder, { increaseCardId: "card_pending" });

    globalThis.fetch = (() => {
      throw new Error("fetch must not be called for a pending (unreviewed) profile");
    }) as unknown as typeof fetch;

    const result = await t.action(internal.increase.backfillCardProfiles, {});
    expect(result.eligible).toBe(1);
    expect(result.patched).toBe(0);
    expect(result.skipped).toBe(1);
  });

  test("skips (never calls fetch for) a card whose environment's profile was rejected", async () => {
    originalEnv = saveEnv();
    const t = newT();
    process.env.INCREASE_API_KEY = "prod_key";
    const chapterId = await makeChapter(t);
    const holder = await makeCardholder(t, chapterId);
    await run(t, (ctx) =>
      ctx.db.insert("financeSettings", {
        sandboxMode: false,
        updatedAt: Date.now(),
        cardArt: {
          fileId: "f",
          iconFileId: "i",
          profileId: "digital_card_profile_prod",
          profileStatus: "rejected",
        },
      }),
    );
    await seedCard(t, chapterId, holder, { increaseCardId: "card_rejected" });

    globalThis.fetch = (() => {
      throw new Error("fetch must not be called for a rejected profile");
    }) as unknown as typeof fetch;

    const result = await t.action(internal.increase.backfillCardProfiles, {});
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
        cardArt: {
          fileId: "f",
          iconFileId: "i",
          profileId: "digital_card_profile_prod",
          profileStatus: "active",
        },
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
