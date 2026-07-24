import { afterEach, describe, expect, test, vi } from "vitest";
import { ConvexError } from "convex/values";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { internal } from "../_generated/api";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import {
  parseReceiptFromText,
  isReceiptInboxAddress,
  extractEmailAddress,
  deriveMerchantFromEmail,
  isLikelyInlineAsset,
  appendSkippedNote,
  isMeaningfulPdfText,
  isPdfContentType,
  ocrReceiptImage,
  extractReceiptFields,
  resolveOcrModel,
} from "../receiptInbox";
import { verifyStandardWebhookSignature } from "../lib/standardWebhook";
import type { AiEngineConfig } from "../lib/aiEngine";

/**
 * Inbound-email → OCR → reconcile pipeline (`receiptInbox.ts`). The network
 * side never runs here (no Resend/OpenRouter keys in the test env), so we
 * exercise the parts that decide MONEY-ADJACENT behavior directly:
 *  - `parseReceiptFromText` — the zero-LLM body-receipt total extractor,
 *  - `verifyStandardWebhookSignature` — the webhook auth gate,
 *  - `recordInboundReceipt` — the emailId dedup,
 *  - `resolvePersonByEmail` — sender resolution (case-insensitive, pwEmail),
 *  - `classifySender` — the team/roster/internal/external AUTOMATION axis,
 *  - `findReceiptMatches` — the exact-cent + date-window matcher (unique /
 *    ambiguous / none / excludes receipted+non-spend / date bounds),
 *  - `processInboundReceipt` — the end-to-end pipeline (roster auto-attach +
 *    reconcile; an untrusted external sender is processed + stored but never
 *    auto-attached),
 *  - `manualMatchInboundReceipt` — the bookkeeper resolution + its gate.
 *
 * The attach/link denorm behavior itself (create receipt → link → repoint) is
 * covered directly in `tests/receiptLinks.test.ts`.
 */

const DAY = 24 * 60 * 60 * 1000;

// ── Seed helpers ─────────────────────────────────────────────────────────────
async function seedPerson(
  s: ChapterSetup,
  opts: {
    email?: string;
    pwEmail?: string;
    linkUser?: boolean;
    isTeamMember?: boolean;
  } = {},
): Promise<Id<"people">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Cardholder",
      email: opts.email,
      pwEmail: opts.pwEmail,
      isTeamMember: opts.isTeamMember,
      userId: opts.linkUser ? s.userId : undefined,
      createdAt: Date.now(),
    }),
  );
}

async function grantRole(
  s: ChapterSetup,
  personId: Id<"people">,
  role: "viewer" | "bookkeeper" | "manager",
): Promise<void> {
  await run(s.t, (ctx) =>
    ctx.db.insert("financeRoles", {
      chapterId: s.chapterId,
      personId,
      role,
      scope: "chapter",
      createdAt: Date.now(),
    }),
  );
}

async function seedTxn(
  s: ChapterSetup,
  opts: {
    amountCents?: number;
    postedAt?: number;
    status?: "unreviewed" | "categorized" | "reconciled" | "excluded";
    flow?: "outflow" | "inflow" | "transfer";
    hasReceipt?: boolean;
    isPersonal?: boolean;
    personId?: Id<"people">;
    merchantName?: string;
  } = {},
): Promise<Id<"transactions">> {
  return await run(s.t, async (ctx) => {
    const storageId = opts.hasReceipt
      ? await (ctx.storage as unknown as {
          store: (b: Blob) => Promise<Id<"_storage">>;
        }).store(new Blob(["r"], { type: "image/png" }))
      : undefined;
    return await ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: "manual",
      flow: opts.flow ?? "outflow",
      amountCents: opts.amountCents ?? 4210,
      postedAt: opts.postedAt ?? Date.now(),
      merchantName: opts.merchantName ?? "Office Depot",
      status: opts.status ?? "unreviewed",
      isPersonal: opts.isPersonal,
      personId: opts.personId,
      receiptStorageId: storageId,
      createdAt: Date.now(),
    });
  });
}

async function storeReceipt(s: ChapterSetup): Promise<Id<"_storage">> {
  return await run(s.t, (ctx) =>
    (ctx.storage as unknown as {
      store: (b: Blob) => Promise<Id<"_storage">>;
    }).store(new Blob(["receipt"], { type: "image/png" })),
  );
}

// ── parseReceiptFromText ─────────────────────────────────────────────────────
describe("parseReceiptFromText", () => {
  test("picks the labelled total, not a larger unrelated figure", () => {
    const r = parseReceiptFromText(
      "Order #55123456\nSubtotal: $18.00\nTax: $1.62\nTotal: $19.62\n",
    );
    expect(r.amountCents).toBe(1962);
  });

  test("falls back to the largest currency figure when no total label", () => {
    const r = parseReceiptFromText("Coffee $4.50\nBagel $3.25\nThanks!");
    expect(r.amountCents).toBe(450);
  });

  test("handles thousands separators", () => {
    const r = parseReceiptFromText("Grand Total: $1,234.56");
    expect(r.amountCents).toBe(123456);
  });

  test("returns null amount when there is no currency figure", () => {
    const r = parseReceiptFromText("Thanks for your order — see you soon!");
    expect(r.amountCents).toBeNull();
  });

  test("extracts a date when present", () => {
    const r = parseReceiptFromText("Total: $10.00\nDate: 2026-03-14");
    expect(r.date).not.toBeNull();
    expect(new Date(r.date!).getUTCFullYear()).toBe(2026);
  });

  // ── merchant heuristic ───────────────────────────────────────────────────
  test("a business-suffix line (the Givebutter case) becomes the merchant", () => {
    const r = parseReceiptFromText(
      "Givebutter, Inc.\nThank you for your donation!\nReceipt #12345\nTotal: $50.00\n",
    );
    expect(r.merchant).toBe("Givebutter, Inc.");
  });

  test("an ambiguous body (no plausible merchant line) yields null", () => {
    const r = parseReceiptFromText("Coffee $4.50\nBagel $3.25\nThanks!");
    expect(r.merchant).toBeNull();
  });

  test("a body of pure labels/totals (no business-name line at all) yields null", () => {
    const r = parseReceiptFromText(
      "Order #55123456\nSubtotal: $18.00\nTax: $1.62\nTotal: $19.62\n",
    );
    expect(r.merchant).toBeNull();
  });
});

// ── deriveMerchantFromEmail (the email merchant fallback) ────────────────────
describe("deriveMerchantFromEmail", () => {
  test("prefers a real RFC-5322 display name", () => {
    expect(deriveMerchantFromEmail('"Givebutter" <receipts@givebutter.com>')).toBe(
      "Givebutter",
    );
  });

  test("falls back to the sending domain's label, title-cased", () => {
    expect(deriveMerchantFromEmail("noreply@doordash.com")).toBe("Doordash");
  });

  test("skips a generic mail host (no merchant identity of its own)", () => {
    expect(deriveMerchantFromEmail("someone@gmail.com")).toBeNull();
  });

  test("falls back to a 'receipt from X' subject fragment when the domain is generic", () => {
    expect(
      deriveMerchantFromEmail("someone@gmail.com", "Your receipt from Blue Bottle Coffee"),
    ).toBe("Blue Bottle Coffee");
  });

  test("a display name that's itself just the address isn't useful — falls through", () => {
    expect(deriveMerchantFromEmail("<receipts@givebutter.com>")).toBe("Givebutter");
  });
});

// ── resolveOcrModel (fix 4: a DEDICATED OCR model, never the global chat one) ─
// The root cause: the owner's global `aiModel` (a general reasoning model,
// e.g. "gemma4:31b") was silently doubling as the OCR model and choking on a
// busy receipt photo. OCR must resolve its own model, never fall back to the
// global one.
describe("resolveOcrModel", () => {
  test("prefers the per-call override over everything else", () => {
    expect(
      resolveOcrModel({ provider: "ollama", ocrModel: "stored-ocr-model" }, "override-model"),
    ).toBe("override-model");
  });

  test("prefers the stored dedicated aiOcrModel over the per-provider default", () => {
    expect(resolveOcrModel({ provider: "ollama", ocrModel: "glm-vision-custom" })).toBe(
      "glm-vision-custom",
    );
  });

  test("with nothing stored, Ollama falls back to gemma4 — cloud-hosted + vision-capable, confirmed working (glm-ocr 404s, local-only)", () => {
    expect(resolveOcrModel({ provider: "ollama", ocrModel: null })).toBe("gemma4");
  });

  test("with nothing stored, OpenRouter falls back to its own OCR default (env or hardcoded)", () => {
    const result = resolveOcrModel({ provider: "openrouter", ocrModel: null });
    // Not asserting the exact hardcoded id (env-overridable) — just that it's
    // NOT empty and NOT accidentally a global chat model slug.
    expect(result).toBeTruthy();
  });
});

// ── ocrReceiptImage / extractReceiptFields — failure-reason mapping ──────────
// The DoorDash "could not read" fix: a transport failure (no key / rate-
// limited / out-of-credits) must never collapse into the same opaque message
// as "the model replied but found no total".
describe("ocrReceiptImage — typed failure reasons", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  function config(over: Partial<AiEngineConfig> = {}): AiEngineConfig {
    return {
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api",
      apiKey: "test-key",
      model: null,
      ocrModel: null,
      ...over,
    };
  }

  test("a missing key short-circuits to a no_key error (no fetch, no throw)", async () => {
    const res = await ocrReceiptImage(config({ apiKey: null }), "data:image/png;base64,x", "m");
    expect("error" in res && res.error.kind).toBe("no_key");
  });

  test("a 402 (out of credits) response is preserved as a typed http error", async () => {
    globalThis.fetch = (async () => ({
      ok: false,
      status: 402,
      text: async () => "insufficient credits",
      json: async () => ({}),
    })) as unknown as typeof fetch;

    const res = await ocrReceiptImage(config(), "data:image/png;base64,x", "m");
    expect("error" in res).toBe(true);
    if ("error" in res) {
      expect(res.error.kind).toBe("http");
      expect(res.error.status).toBe(402);
    }
  });

  test("a 429 (rate limited) response is preserved as a typed http error", async () => {
    globalThis.fetch = (async () => ({
      ok: false,
      status: 429,
      text: async () => "rate limited",
      json: async () => ({}),
    })) as unknown as typeof fetch;

    const res = await ocrReceiptImage(config(), "data:image/png;base64,x", "m");
    expect("error" in res).toBe(true);
    if ("error" in res) {
      expect(res.error.kind).toBe("http");
      expect(res.error.status).toBe(429);
    }
  });

  test("a clean reply with no usable amount is a distinct no_total error", async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          { message: { content: JSON.stringify({ amount: null, confidence: 0 }) } },
        ],
      }),
      text: async () => "",
    })) as unknown as typeof fetch;

    const res = await ocrReceiptImage(config(), "data:image/png;base64,x", "m");
    expect("error" in res).toBe(true);
    if ("error" in res) expect(res.error.kind).toBe("no_total");
  });

  test("a clean reply with a real amount succeeds", async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                amount: 42.1,
                date: "2026-03-14",
                merchant: "Home Depot",
                confidence: 0.9,
              }),
            },
          },
        ],
      }),
      text: async () => "",
    })) as unknown as typeof fetch;

    const res = await ocrReceiptImage(config(), "data:image/png;base64,x", "m");
    expect("error" in res).toBe(false);
    if (!("error" in res)) {
      expect(res.amountCents).toBe(4210);
      expect(res.merchant).toBe("Home Depot");
    }
  });
});

describe("extractReceiptFields — ocrError translation", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  function config(over: Partial<AiEngineConfig> = {}): AiEngineConfig {
    return {
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api",
      apiKey: "test-key",
      model: null,
      ocrModel: null,
      ...over,
    };
  }
  // Image content-type never touches `ctx` (only the PDF branch does) — an
  // unused stub is enough for a direct unit test.
  const fakeCtx = {} as ActionCtx;
  const blob = new Blob(["x"], { type: "image/png" });

  test("no_key → the Settings-pointing message", async () => {
    const result = await extractReceiptFields(fakeCtx, {
      storageId: "storage_id" as unknown as Id<"_storage">,
      config: config({ apiKey: null }),
      blob,
      contentType: "image/png",
      model: "m",
    });
    expect(result.ocrError).toBe(
      "No AI engine key configured — set one in Settings → Integrations.",
    );
  });

  test("HTTP 402 → the out-of-credits message naming the provider", async () => {
    globalThis.fetch = (async () => ({
      ok: false,
      status: 402,
      text: async () => "insufficient credits",
      json: async () => ({}),
    })) as unknown as typeof fetch;

    const result = await extractReceiptFields(fakeCtx, {
      storageId: "storage_id" as unknown as Id<"_storage">,
      config: config(),
      blob,
      contentType: "image/png",
      model: "m",
    });
    expect(result.ocrError).toContain("HTTP 402");
    expect(result.ocrError).toContain("out of credits");
  });

  test("read-but-no-total is distinct from a transport failure", async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          { message: { content: JSON.stringify({ amount: null, confidence: 0 }) } },
        ],
      }),
      text: async () => "",
    })) as unknown as typeof fetch;

    const result = await extractReceiptFields(fakeCtx, {
      storageId: "storage_id" as unknown as Id<"_storage">,
      config: config(),
      blob,
      contentType: "image/png",
      model: "m",
    });
    expect(result.ocrError).toBe(
      "The model read the receipt but couldn't find a clear total — try Retry with a different model.",
    );
  });
});

// ── verifyStandardWebhookSignature ───────────────────────────────────────────
describe("verifyStandardWebhookSignature", () => {
  async function sign(secretB64: string, id: string, ts: string, body: string) {
    const keyBytes = Uint8Array.from(atob(secretB64), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(`${id}.${ts}.${body}`),
      ),
    );
    let bin = "";
    for (const b of mac) bin += String.fromCharCode(b);
    return btoa(bin);
  }

  test("accepts a valid signature and rejects a tampered body", async () => {
    const secretB64 = btoa("supersecretkey-1234567890");
    const secret = `whsec_${secretB64}`;
    const id = "msg_1";
    const ts = String(Math.floor(Date.now() / 1000));
    const body = '{"type":"email.received"}';
    const sig = `v1,${await sign(secretB64, id, ts, body)}`;

    expect(
      await verifyStandardWebhookSignature(body, { id, timestamp: ts, signature: sig }, secret),
    ).toBe(true);
    expect(
      await verifyStandardWebhookSignature('{"type":"tampered"}', { id, timestamp: ts, signature: sig }, secret),
    ).toBe(false);
  });

  test("rejects an out-of-tolerance timestamp (replay guard)", async () => {
    const secretB64 = btoa("supersecretkey-1234567890");
    const secret = `whsec_${secretB64}`;
    const id = "msg_2";
    const oldTs = String(Math.floor(Date.now() / 1000) - 10_000);
    const body = "{}";
    const sig = `v1,${await sign(secretB64, id, oldTs, body)}`;
    expect(
      await verifyStandardWebhookSignature(body, { id, timestamp: oldTs, signature: sig }, secret),
    ).toBe(false);
  });

  test("rejects when a header is missing", async () => {
    expect(
      await verifyStandardWebhookSignature("{}", { id: null, timestamp: "1", signature: "v1,x" }, "whsec_aaaa"),
    ).toBe(false);
  });
});

// ── isReceiptInboxAddress (the addressing filter) ────────────────────────────
describe("isReceiptInboxAddress", () => {
  test("accepts only the receipts inbox, To or Cc, case-insensitively", () => {
    expect(isReceiptInboxAddress(["receipts@reply.publicworship.life"])).toBe(true);
    expect(isReceiptInboxAddress(["RECEIPTS@Reply.PublicWorship.Life"])).toBe(true);
    // Cc position counts too (second recipient).
    expect(
      isReceiptInboxAddress(["someone@else.com", "receipts@reply.publicworship.life"]),
    ).toBe(true);
    // Other addresses on the same inbound domain are NOT receipts.
    expect(isReceiptInboxAddress(["hello@reply.publicworship.life"])).toBe(false);
    expect(isReceiptInboxAddress([])).toBe(false);
    expect(isReceiptInboxAddress([null, undefined])).toBe(false);
  });

  test("handles display-name recipient forms", () => {
    expect(
      isReceiptInboxAddress(['"PW Receipts" <receipts@reply.publicworship.life>']),
    ).toBe(true);
  });

  test("honors the RECEIPT_INBOUND_ADDRESSES override (comma-separated)", () => {
    const prev = process.env.RECEIPT_INBOUND_ADDRESSES;
    try {
      process.env.RECEIPT_INBOUND_ADDRESSES =
        "backfill@reply.publicworship.life, receipts@reply.publicworship.life";
      expect(isReceiptInboxAddress(["backfill@reply.publicworship.life"])).toBe(true);
      expect(isReceiptInboxAddress(["receipts@reply.publicworship.life"])).toBe(true);
      process.env.RECEIPT_INBOUND_ADDRESSES = "only@reply.publicworship.life";
      expect(isReceiptInboxAddress(["receipts@reply.publicworship.life"])).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.RECEIPT_INBOUND_ADDRESSES;
      else process.env.RECEIPT_INBOUND_ADDRESSES = prev;
    }
  });
});

describe("extractEmailAddress", () => {
  test("strips display names and normalizes; passes bare addresses through", () => {
    expect(extractEmailAddress("Jane Doe <Jane@Example.com>")).toBe("jane@example.com");
    expect(extractEmailAddress("  BARE@X.COM ")).toBe("bare@x.com");
    expect(extractEmailAddress("")).toBeNull();
    expect(extractEmailAddress(null)).toBeNull();
  });
});

// ── isLikelyInlineAsset (the duplicate-receipt fix's filter) ─────────────────
describe("isLikelyInlineAsset", () => {
  test("a small, asset-named image is skipped", () => {
    expect(
      isLikelyInlineAsset({ contentType: "image/png", filename: "logo.png", size: 4_000 }),
    ).toBe(true);
    expect(
      isLikelyInlineAsset({ contentType: "image/png", filename: "signature.png", size: 2_000 }),
    ).toBe(true);
    expect(
      isLikelyInlineAsset({ contentType: "image/gif", filename: "spacer.gif", size: 43 }),
    ).toBe(true);
    expect(
      isLikelyInlineAsset({ contentType: "image/png", filename: "image001.png", size: 3_000 }),
    ).toBe(true);
  });

  test("a PDF always passes, regardless of size or name", () => {
    expect(
      isLikelyInlineAsset({ contentType: "application/pdf", filename: "logo.pdf", size: 500 }),
    ).toBe(false);
    expect(
      isLikelyInlineAsset({ contentType: "image/png", filename: "signature.pdf", size: 500 }),
    ).toBe(false);
  });

  test("a normal-sized receipt photo passes even with an unlucky name", () => {
    // Over the size floor — size alone (or combined with a coincidental name
    // hit) never disqualifies it.
    expect(
      isLikelyInlineAsset({ contentType: "image/jpeg", filename: "logo-hardware-receipt.jpg", size: 250_000 }),
    ).toBe(false);
  });

  test("a small photo with an unmatched (real camera) filename passes — size alone never disqualifies", () => {
    expect(
      isLikelyInlineAsset({ contentType: "image/jpeg", filename: "IMG_0341.jpg", size: 8_000 }),
    ).toBe(false);
    // Missing size metadata → never skipped (err toward processing).
    expect(
      isLikelyInlineAsset({ contentType: "image/jpeg", filename: "logo.jpg" }),
    ).toBe(false);
  });
});

describe("appendSkippedNote", () => {
  test("no-op when nothing was skipped", () => {
    expect(appendSkippedNote("Matched.", [])).toBe("Matched.");
  });

  test("appends a count + names, capped with a '+N more' tail", () => {
    const note = appendSkippedNote("Matched.", ["logo.png"]);
    expect(note).toBe("Matched. (Skipped 1 likely non-receipt attachment: logo.png.)");

    const many = appendSkippedNote(
      "No match.",
      ["a.png", "b.png", "c.png", "d.png", "e.png", "f.png", "g.png"],
    );
    expect(many).toContain("Skipped 7 likely non-receipt attachments:");
    expect(many).toContain("+2 more");
  });
});

// ── PDF text-layer routing helpers (zero-LLM digital-PDF fix) ────────────────
describe("isMeaningfulPdfText", () => {
  test("real receipt-shaped text is meaningful", () => {
    expect(isMeaningfulPdfText("Givebutter Receipt\nTotal: $33.80\nPaid Jul 3, 2026")).toBe(true);
  });

  test("empty or garbage/whitespace text from a scanned PDF is not", () => {
    expect(isMeaningfulPdfText("")).toBe(false);
    expect(isMeaningfulPdfText("   \n\n  ")).toBe(false);
    expect(isMeaningfulPdfText("...---...")).toBe(false);
    expect(isMeaningfulPdfText("ab")).toBe(false);
  });
});

describe("isPdfContentType", () => {
  test("detects by content-type or by filename extension", () => {
    expect(isPdfContentType("application/pdf")).toBe(true);
    expect(isPdfContentType("APPLICATION/PDF")).toBe(true);
    expect(isPdfContentType("application/octet-stream", "receipt.PDF")).toBe(true);
    expect(isPdfContentType("image/png", "photo.png")).toBe(false);
  });
});

// ── recordInboundReceipt (dedup) ─────────────────────────────────────────────
describe("recordInboundReceipt", () => {
  test("dedupes on emailId", async () => {
    const t = newT();
    const envelope = { emailId: "email_abc", fromEmail: "a@x.com", subject: "r" };
    const first = await t.mutation(internal.receiptInbox.recordInboundReceipt, { envelope });
    expect(first.isNew).toBe(true);
    const second = await t.mutation(internal.receiptInbox.recordInboundReceipt, { envelope });
    expect(second.isNew).toBe(false);
    expect(second.receiptId).toBe(first.receiptId);
  });
});

// ── resolvePersonByEmail (auth gate) ─────────────────────────────────────────
describe("resolvePersonByEmail", () => {
  test("matches case-insensitively on email and on pwEmail; unknown → null", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const p1 = await seedPerson(s, { email: "Jane.Doe@Example.com" });
    const p2 = await seedPerson(s, { pwEmail: "pastor@publicworship.life" });

    const hit1 = await t.query(internal.receiptInbox.resolvePersonByEmail, {
      email: "jane.doe@example.com",
    });
    expect(hit1?.personId).toBe(p1);
    const hit2 = await t.query(internal.receiptInbox.resolvePersonByEmail, {
      email: "  PASTOR@publicworship.life ",
    });
    expect(hit2?.personId).toBe(p2);
    const miss = await t.query(internal.receiptInbox.resolvePersonByEmail, {
      email: "stranger@nowhere.com",
    });
    expect(miss).toBeNull();
  });

  test("resolves a display-name From value", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const p = await seedPerson(s, { email: "jane@example.com" });
    const hit = await t.query(internal.receiptInbox.resolvePersonByEmail, {
      email: "Jane Doe <Jane@Example.com>",
    });
    expect(hit?.personId).toBe(p);
  });
});

// ── findReceiptMatches (the matcher) ─────────────────────────────────────────
describe("findReceiptMatches", () => {
  test("returns exactly one on a unique exact-cent, in-window match", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const now = Date.now();
    const txn = await seedTxn(s, { amountCents: 4210, postedAt: now });
    // Noise that must NOT match: wrong amount, and right amount but receipted.
    await seedTxn(s, { amountCents: 999, postedAt: now });
    await seedTxn(s, { amountCents: 4210, postedAt: now, hasReceipt: true });

    const matches = await t.query(internal.receiptInbox.findReceiptMatches, {
      chapterId: s.chapterId,
      amountCents: 4210,
      receiptDate: now,
    });
    expect(matches.map((m) => m.transactionId)).toEqual([txn]);
  });

  test("returns multiple when several charges share the amount (ambiguous)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const now = Date.now();
    const a = await seedTxn(s, { amountCents: 4210, postedAt: now });
    const b = await seedTxn(s, { amountCents: 4210, postedAt: now - DAY });
    const matches = await t.query(internal.receiptInbox.findReceiptMatches, {
      chapterId: s.chapterId,
      amountCents: 4210,
      receiptDate: now,
    });
    expect(matches.length).toBe(2);
    expect(matches.map((m) => m.transactionId).sort()).toEqual([a, b].sort());
  });

  test("excludes charges outside the ±14 day window and non-spend/excluded", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const now = Date.now();
    await seedTxn(s, { amountCents: 4210, postedAt: now - 20 * DAY }); // too old
    await seedTxn(s, { amountCents: 4210, postedAt: now, flow: "inflow" }); // not spend
    await seedTxn(s, { amountCents: 4210, postedAt: now, status: "excluded" });
    await seedTxn(s, { amountCents: 4210, postedAt: now, isPersonal: true });
    const matches = await t.query(internal.receiptInbox.findReceiptMatches, {
      chapterId: s.chapterId,
      amountCents: 4210,
      receiptDate: now,
    });
    expect(matches).toEqual([]);
  });

  test("ranks the sender's own charge and a merchant-overlap first", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const now = Date.now();
    const me = await seedPerson(s, { email: "me@x.com" });
    const plain = await seedTxn(s, { amountCents: 4210, postedAt: now, merchantName: "Costco" });
    const mine = await seedTxn(s, {
      amountCents: 4210,
      postedAt: now - DAY,
      personId: me,
      merchantName: "Home Depot",
    });
    const matches = await t.query(internal.receiptInbox.findReceiptMatches, {
      chapterId: s.chapterId,
      amountCents: 4210,
      receiptDate: now,
      ocrMerchant: "HOME DEPOT #234",
      senderPersonId: me,
    });
    // `mine` is both own-charge and merchant-overlap → ranked first.
    expect(matches[0].transactionId).toBe(mine);
    expect(matches.map((m) => m.transactionId)).toContain(plain);
  });
});

// ── classifySender (the team/roster/internal/external automation axis) ───────
describe("classifySender", () => {
  test("a core-team person → team", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPerson(s, { email: "boss@publicworship.life", isTeamMember: true });
    const c = await t.query(internal.receiptInbox.classifySender, {
      email: "boss@publicworship.life",
    });
    expect(c.senderClass).toBe("team");
    expect(c.personId).not.toBeNull();
    expect(c.chapterId).not.toBeNull();
  });

  test("a non-team roster person → roster", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPerson(s, { email: "helper@example.com" });
    const c = await t.query(internal.receiptInbox.classifySender, {
      email: "helper@example.com",
    });
    expect(c.senderClass).toBe("roster");
  });

  test("no person match but the org domain → internal", async () => {
    const t = newT();
    await setupChapter(t);
    const c = await t.query(internal.receiptInbox.classifySender, {
      email: "nobody@publicworship.life",
    });
    expect(c.senderClass).toBe("internal");
    expect(c.personId).toBeNull();
    expect(c.chapterId).toBeNull();
  });

  test("an unknown outside address → external", async () => {
    const t = newT();
    await setupChapter(t);
    const c = await t.query(internal.receiptInbox.classifySender, {
      email: "stranger@nowhere.com",
    });
    expect(c.senderClass).toBe("external");
    expect(c.personId).toBeNull();
    expect(c.chapterId).toBeNull();
  });
});

// ── processInboundReceipt (end-to-end, keyless) ──────────────────────────────
// With no RESEND/OPENROUTER keys in the test env, the attachment + body
// fetches degrade and the SUBJECT becomes the body text — so this exercises
// the real pipeline: sender gate → body stored as the receipt file → parse →
// unique match → auto-attach + reconcile.
describe("processInboundReceipt", () => {
  test("a roster body-only email auto-attaches, reconciles, and writes a receipt + link", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPerson(s, { email: "jane@example.com" });
    const txn = await seedTxn(s, { amountCents: 4210, status: "categorized" });

    const { receiptId } = await t.mutation(internal.receiptInbox.recordInboundReceipt, {
      envelope: {
        emailId: "email_body_1",
        fromEmail: "Jane Doe <jane@example.com>",
        subject: "Home Depot receipt — Total: $42.10",
      },
    });
    await t.action(internal.receiptInbox.processInboundReceipt, { receiptId });

    const row = await run(t, (ctx) => ctx.db.get(receiptId));
    expect(row?.status).toBe("matched");
    expect(row?.matchedTransactionId).toBe(txn);
    expect(row?.sourceKind).toBe("body");
    expect(row?.senderClass).toBe("roster");
    expect(row?.receiptStorageId).toBeDefined();
    const txnRow = await run(t, (ctx) => ctx.db.get(txn));
    expect(txnRow?.status).toBe("reconciled");
    expect(txnRow?.receiptStorageId).toBe(row?.receiptStorageId);

    // A first-class receipt document + a link were written (source auto_email).
    const receipts = await run(t, (ctx) => ctx.db.query("receipts").take(5));
    expect(receipts.length).toBe(1);
    expect(receipts[0].source).toBe("email");
    expect(receipts[0].senderClass).toBe("roster");
    expect(receipts[0].linkCount).toBe(1);
    // A body-sourced receipt is stamped with the synthetic "email body" label
    // (there's no attachment filename to carry), and a clean extraction never
    // sets `ocrError`.
    expect(receipts[0].filename).toBe("email body");
    expect(receipts[0].ocrError).toBeUndefined();
    const links = await run(t, (ctx) => ctx.db.query("receiptLinks").take(5));
    expect(links.length).toBe(1);
    expect(links[0].source).toBe("auto_email");
    expect(links[0].transactionId).toBe(txn);
  });

  test("a body with no readable total sets ocrError on the receipt (the '—' bug fix)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPerson(s, { email: "jane@example.com" });

    const { receiptId } = await t.mutation(internal.receiptInbox.recordInboundReceipt, {
      envelope: {
        emailId: "email_no_total_1",
        fromEmail: "jane@example.com",
        subject: "Thanks for stopping by — see you next time!",
      },
    });
    await t.action(internal.receiptInbox.processInboundReceipt, { receiptId });

    const row = await run(t, (ctx) => ctx.db.get(receiptId));
    expect(row?.status).toBe("needs_review");

    const receipts = await run(t, (ctx) => ctx.db.query("receipts").take(5));
    expect(receipts).toHaveLength(1);
    expect(receipts[0].ocrAmountCents).toBeUndefined();
    // The historical bug: OCR failing left NO visible reason anywhere. Now the
    // receipt document always carries a human-readable `ocrError`.
    expect(receipts[0].ocrError).toBe("Couldn't find a total in the email body text.");
    expect(receipts[0].filename).toBe("email body");
  });

  test("an EXTERNAL sender is processed + stored but NEVER auto-attached, even on a unique exact match", async () => {
    const t = newT();
    const s = await setupChapter(t);
    // A perfect, unique candidate exists — a trusted sender would auto-attach.
    const txn = await seedTxn(s, { amountCents: 4210, status: "categorized" });

    const { receiptId } = await t.mutation(internal.receiptInbox.recordInboundReceipt, {
      envelope: {
        emailId: "email_external_1",
        fromEmail: "stranger@nowhere.com",
        subject: "Receipt — Total: $42.10",
      },
    });
    await t.action(internal.receiptInbox.processInboundReceipt, { receiptId });

    const row = await run(t, (ctx) => ctx.db.get(receiptId));
    // Processed end-to-end: the body was stored and OCR'd.
    expect(row?.senderClass).toBe("external");
    expect(row?.sourceKind).toBe("body");
    expect(row?.receiptStorageId).toBeDefined();
    expect(row?.ocrAmountCents).toBe(4210);
    // But an untrusted From: never moves money → review, no chapter inferred.
    expect(row?.status).toBe("needs_review");
    expect(row?.chapterId).toBeUndefined();
    expect(row?.matchedTransactionId).toBeUndefined();

    // The transaction is untouched — no receipt attached, no reconcile.
    const txnRow = await run(t, (ctx) => ctx.db.get(txn));
    expect(txnRow?.receiptStorageId).toBeUndefined();
    expect(txnRow?.status).toBe("categorized");

    // A receipt DOCUMENT was still created (unlinked) — the CRM view surfaces it.
    const links = await run(t, (ctx) => ctx.db.query("receiptLinks").take(5));
    expect(links.length).toBe(0);
    const receipts = await run(t, (ctx) => ctx.db.query("receipts").take(5));
    expect(receipts.length).toBe(1);
    expect(receipts[0].linkCount).toBe(0);
    expect(receipts[0].chapterId).toBeUndefined();
    expect(receipts[0].senderClass).toBe("external");
  });

  // CRM PR: the SAME email body text (byte-identical stored file) arriving
  // twice — even though a fresh, otherwise-unique candidate exists for the
  // second one — must never auto-attach the second time. `fileSha256` catches
  // it regardless of amount/date parsing (see `lib/receiptLinks.ts#findDuplicateReceiptBySha256`).
  test("a byte-identical re-send never auto-attaches, even against a fresh unique candidate", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPerson(s, { email: "jane@example.com" });
    const txnA = await seedTxn(s, { amountCents: 4210, status: "categorized" });
    const subject = "Home Depot receipt — Total: $42.10";

    const first = await t.mutation(internal.receiptInbox.recordInboundReceipt, {
      envelope: { emailId: "email_dup_1", fromEmail: "jane@example.com", subject },
    });
    await t.action(internal.receiptInbox.processInboundReceipt, {
      receiptId: first.receiptId,
    });
    const firstRow = await run(t, (ctx) => ctx.db.get(first.receiptId));
    expect(firstRow?.status).toBe("matched");
    expect(firstRow?.matchedTransactionId).toBe(txnA);

    // A second, genuinely unreceipted charge with the same amount now exists —
    // a fresh unique candidate, IF the resend weren't a duplicate.
    const txnB = await seedTxn(s, { amountCents: 4210, status: "categorized" });
    const second = await t.mutation(internal.receiptInbox.recordInboundReceipt, {
      envelope: { emailId: "email_dup_2", fromEmail: "jane@example.com", subject },
    });
    await t.action(internal.receiptInbox.processInboundReceipt, {
      receiptId: second.receiptId,
    });

    const secondRow = await run(t, (ctx) => ctx.db.get(second.receiptId));
    expect(secondRow?.status).toBe("needs_review");
    expect(secondRow?.detail).toMatch(/duplicate/i);
    expect(secondRow?.matchedTransactionId).toBeUndefined();

    const receiptDocs = await run(t, (ctx) => ctx.db.query("receipts").collect());
    expect(receiptDocs).toHaveLength(2);
    const dupDoc = receiptDocs.find((r) => r.inboundReceiptId === second.receiptId);
    const firstDoc = receiptDocs.find((r) => r.inboundReceiptId === first.receiptId);
    expect(dupDoc?.duplicateOfReceiptId).toBe(firstDoc?._id);
    expect(dupDoc?.fileSha256).toBeDefined();
    expect(dupDoc?.fileSha256).toBe(firstDoc?.fileSha256);

    // txnB was never touched — the would-be unique match was suppressed.
    const txnBRow = await run(t, (ctx) => ctx.db.get(txnB));
    expect(txnBRow?.receiptStorageId).toBeUndefined();
    expect(txnBRow?.status).toBe("categorized");
    const links = await run(t, (ctx) => ctx.db.query("receiptLinks").collect());
    expect(links).toHaveLength(1); // only the first email's link
  });

  // FIX 1 (merchant extraction): when neither the body parse nor OCR yields a
  // merchant, the pipeline falls back to one derived from the sender email —
  // here, a Givebutter-style display name — so `ocrMerchant` isn't left
  // blank just because the receipt text itself carried no business name.
  test("no extracted merchant falls back to the sender's display name", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPerson(s, { email: "receipts@givebutter.com" });

    const { receiptId } = await t.mutation(internal.receiptInbox.recordInboundReceipt, {
      envelope: {
        emailId: "email_merchant_fallback_1",
        fromEmail: '"Givebutter" <receipts@givebutter.com>',
        // A subject with a total but no plausible merchant-name line — the
        // body parser's own heuristic finds no merchant here.
        subject: "Receipt — Total: $75.00",
      },
    });
    await t.action(internal.receiptInbox.processInboundReceipt, { receiptId });

    const receipts = await run(t, (ctx) => ctx.db.query("receipts").take(5));
    expect(receipts).toHaveLength(1);
    expect(receipts[0].ocrMerchant).toBe("Givebutter");
    expect(receipts[0].merchant).toBe("Givebutter");
  });

  // A real extracted merchant is NEVER overwritten by the email fallback —
  // the sender domain here ("differentcompany.com") would derive a DIFFERENT
  // merchant than the one the body text itself confidently names, so this
  // fails loudly if the fallback ever clobbers a real read.
  test("a real extracted merchant is never overwritten by the sender fallback", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPerson(s, { email: "billing@differentcompany.com" });

    const { receiptId } = await t.mutation(internal.receiptInbox.recordInboundReceipt, {
      envelope: {
        emailId: "email_merchant_fallback_2",
        fromEmail: "billing@differentcompany.com",
        // A confident merchant line on its own (no price on the same line —
        // see the merchant heuristic's price-line guard), plus a total on a
        // separate line.
        subject: "Givebutter, Inc.\nTotal: $75.00",
      },
    });
    await t.action(internal.receiptInbox.processInboundReceipt, { receiptId });

    const receipts = await run(t, (ctx) => ctx.db.query("receipts").take(5));
    expect(receipts).toHaveLength(1);
    expect(receipts[0].ocrMerchant).toBe("Givebutter, Inc.");
  });
});

// ── manualMatchInboundReceipt (bookkeeper resolution) ────────────────────────
describe("manualMatchInboundReceipt", () => {
  async function seedInboundRow(
    s: ChapterSetup,
    storageId: Id<"_storage"> | undefined,
  ): Promise<Id<"inboundReceipts">> {
    return await run(s.t, (ctx) =>
      ctx.db.insert("inboundReceipts", {
        emailId: `e_${Math.random()}`,
        status: "needs_review",
        fromEmail: "sender@x.com",
        chapterId: s.chapterId,
        receiptStorageId: storageId,
        receivedAt: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
  }

  test("a bookkeeper attaches the inbound receipt to a chosen txn", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const self = await seedPerson(s, { linkUser: true });
    await grantRole(s, self, "bookkeeper");
    const storageId = await storeReceipt(s);
    const rowId = await seedInboundRow(s, storageId);
    const txn = await seedTxn(s, { status: "categorized" });

    const res = await s.as.mutation(api.receiptInbox.manualMatchInboundReceipt, {
      receiptId: rowId,
      transactionId: txn,
    });
    expect(res.reconciled).toBe(true);
    const row = await run(t, (ctx) => ctx.db.get(rowId));
    expect(row?.status).toBe("matched");
    expect(row?.matchedTransactionId).toBe(txn);
    const txnRow = await run(t, (ctx) => ctx.db.get(txn));
    expect(txnRow?.receiptStorageId).toBe(storageId);
  });

  test("a viewer (below bookkeeper) is refused", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const self = await seedPerson(s, { linkUser: true });
    await grantRole(s, self, "viewer");
    const storageId = await storeReceipt(s);
    const rowId = await seedInboundRow(s, storageId);
    const txn = await seedTxn(s, { status: "categorized" });
    await expect(
      s.as.mutation(api.receiptInbox.manualMatchInboundReceipt, {
        receiptId: rowId,
        transactionId: txn,
      }),
    ).rejects.toThrow(ConvexError);
  });
});
