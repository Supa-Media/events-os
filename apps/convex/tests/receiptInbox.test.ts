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
  isReceiptInboxSelf,
  resolveListSender,
  headerValue,
  parseInlineForwardEnvelope,
  extractMerchantGuess,
  composeReplyDigest,
  extractEmailAddress,
  deriveMerchantFromEmail,
  extractMidLineMerchant,
  isLikelyInlineAsset,
  isReceiptFileAttachment,
  collectForwardedReceiptSources,
  appendSkippedNote,
  isMeaningfulPdfText,
  isPdfContentType,
  ocrReceiptImage,
  extractReceiptFields,
  resolveOcrModel,
} from "../receiptInbox";
import { parseEmlMessage } from "../lib/emlMessage";
import { verifyStandardWebhookSignature } from "../lib/standardWebhook";
import type { AiEngineConfig } from "../lib/aiEngine";
import { getFunctionName } from "convex/server";

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
    isContactOnly?: boolean;
  } = {},
): Promise<Id<"people">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Cardholder",
      email: opts.email,
      pwEmail: opts.pwEmail,
      isTeamMember: opts.isTeamMember,
      isContactOnly: opts.isContactOnly,
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

  // ── BUG FIX: the mid-line business-suffix heuristic (unpdf glues a real
  // merchant name to the boilerplate riding next to it on the page — an
  // address, an invoice header) ─────────────────────────────────────────────
  test("a merchant+suffix glued directly to the following address (no separator) still resolves", () => {
    const r = parseReceiptFromText(
      "Invoice\nInvoice number ZADI4N1R-0008\nDate of issue July 3, 2026\n" +
        "Givebutter, Inc.2810 North Church Street\n#53748\n" +
        "Wilmington, Delaware 19802\nUnited States\nsupport@givebutter.com\nTotal: $33.80\n",
    );
    expect(r.merchant).toBe("Givebutter, Inc.");
  });

  test("the whole invoice header + address block glued onto one line still resolves", () => {
    const r = parseReceiptFromText(
      "Invoice\nInvoice number ZADI4N1R-0008\n" +
        "Date of issue July 3, 2026 Date due July 3, 2026 Givebutter, Inc. " +
        "2810 North Church Street #53748 Wilmington, Delaware 19802 " +
        "United States support@givebutter.com\nTotal: $33.80\n",
    );
    expect(r.merchant).toBe("Givebutter, Inc.");
  });

  test("a glued line naming a merchant with no suffix at all is NOT force-matched (conservative)", () => {
    const r = parseReceiptFromText(
      "Invoice\nSome Random Company Name And A Bunch Of Other Words Here Too\nTotal: $10.00\n",
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

  // ── BUG FIX: the forwarded-Givebutter-PDF case — a real person forwards the
  // original receipt email in, so `fromEmail` carries no merchant identity of
  // its own; only the SUBJECT line has it, prefixed with the forward marker
  // and suffixed with an order number. ─────────────────────────────────────
  test("a forwarded subject ('Fwd: ... #order-number') still yields the merchant", () => {
    expect(
      deriveMerchantFromEmail(
        "someone@gmail.com",
        "Fwd: Your receipt from Givebutter, Inc. #2383-5178",
      ),
    ).toBe("Givebutter, Inc.");
  });

  test("a doubly-prefixed subject ('Re: Fwd: ...') still yields the merchant", () => {
    expect(
      deriveMerchantFromEmail(
        "someone@gmail.com",
        "Re: Fwd: Your receipt from Givebutter, Inc. #2383-5178",
      ),
    ).toBe("Givebutter, Inc.");
  });

  // ── BUG FIX (the group-forward shape): a HUMAN's display name is not a
  // merchant. A team member forwarding a receipt from their gmail, or the
  // Google Group's own DMARC-rewritten `From:`, would otherwise become the
  // "merchant" on the receipt. Merchantless domains skip the display-name AND
  // domain-label tiers alike. ────────────────────────────────────────────────
  test("a person's display name on a free mail host is not a merchant", () => {
    expect(deriveMerchantFromEmail('"Charisma S." <charisma@gmail.com>')).toBeNull();
  });

  test("our own domain (and the list on it) carries no merchant identity", () => {
    expect(
      deriveMerchantFromEmail('"Charisma S. via receipts" <receipts@publicworship.life>'),
    ).toBeNull();
    expect(deriveMerchantFromEmail("receipts@reply.publicworship.life")).toBeNull();
  });

  test("a merchantless sender still yields a merchant off the subject", () => {
    expect(
      deriveMerchantFromEmail(
        '"Charisma S. via receipts" <receipts@publicworship.life>',
        "Fwd: Your receipt from Blue Bottle Coffee",
      ),
    ).toBe("Blue Bottle Coffee");
  });
});

// ── resolveListSender (the Google-Group relay: who actually posted?) ─────────
describe("resolveListSender", () => {
  const LIST_HEADERS = {
    "List-Id": "<receipts.publicworship.life>",
    "X-Original-Sender": "charisma@example.com",
  };

  test("recovers the poster from X-Original-Sender on list mail", () => {
    // Google rewrote `From:` for a DMARC-strict poster — without recovery this
    // classifies as the LIST, never as the person, so it can never auto-attach.
    expect(
      resolveListSender('"Charisma S. via receipts" <receipts@publicworship.life>', LIST_HEADERS),
    ).toEqual({
      fromEmail: "charisma@example.com",
      relayedVia: "<receipts.publicworship.life>",
    });
  });

  test("X-Original-Sender is IGNORED without a list header (direct mail)", () => {
    expect(
      resolveListSender("stranger@example.com", {
        "X-Original-Sender": "cfo@publicworship.life",
      }),
    ).toEqual({ fromEmail: "stranger@example.com", relayedVia: null });
  });

  test("list mail with no X-Original-Sender keeps the envelope From", () => {
    expect(
      resolveListSender("charisma@example.com", {
        "list-post": "<mailto:receipts@publicworship.life>",
      }),
    ).toEqual({
      fromEmail: "charisma@example.com",
      relayedVia: "<mailto:receipts@publicworship.life>",
    });
  });

  test("no headers at all (no API key, a failed fetch) is a clean no-op", () => {
    expect(resolveListSender("charisma@example.com", null)).toEqual({
      fromEmail: "charisma@example.com",
      relayedVia: null,
    });
  });
});

describe("headerValue", () => {
  test("looks headers up case-insensitively, skipping blanks", () => {
    const h = { "X-Original-Sender": "a@b.com", "List-Id": "   " };
    expect(headerValue(h, "x-original-sender")).toBe("a@b.com");
    expect(headerValue(h, "LIST-ID")).toBeNull();
    expect(headerValue(h, "missing")).toBeNull();
    expect(headerValue(null, "list-id")).toBeNull();
  });
});

// ── parseInlineForwardEnvelope (the ordinary "Forward") ──────────────────────
// The screenshot shape: a team member forwards the merchant's email INLINE, so
// the only real merchant signal is the forward banner Gmail pasted in.
describe("parseInlineForwardEnvelope", () => {
  test("reads From/Subject off a Gmail plain-text forward banner", () => {
    const body = [
      "Paying it back",
      "",
      "Best,",
      "Charisma Stevens",
      "",
      "---------- Forwarded message ---------",
      "From: Uber Receipts <noreply@uber.com>",
      "Date: Thu, Jul 30, 2026 at 9:35 PM",
      "Subject: [Personal] Your Thursday evening order with Uber Eats",
      "To: <charisma@example.com>",
      "",
      "Total $298.52",
    ].join("\n");
    expect(parseInlineForwardEnvelope(body)).toEqual({
      fromEmail: "Uber Receipts <noreply@uber.com>",
      subject: "[Personal] Your Thursday evening order with Uber Eats",
    });
  });

  test("reads an HTML forward banner whose headers collapse onto one line", () => {
    // `<br>`-separated in the source, so the pseudo-headers only stay apart
    // because each stops at the next header NAME, not at a newline.
    const html =
      "<div>Paying it back<br><br>---------- Forwarded message ---------<br>" +
      'From: <b>Uber Receipts</b> &lt;<a href="mailto:noreply@uber.com">noreply@uber.com</a>&gt;<br>' +
      "Date: Thu, Jul 30, 2026 at 9:35PM<br>" +
      "Subject: Your Thursday evening order with Uber Eats<br>" +
      "To: &lt;charisma@example.com&gt;</div>";
    const env = parseInlineForwardEnvelope(html);
    expect(env?.fromEmail).toContain("noreply@uber.com");
    expect(env?.subject).toBe("Your Thursday evening order with Uber Eats");
  });

  test("Apple Mail's and Outlook's banners are recognized too", () => {
    expect(
      parseInlineForwardEnvelope(
        "Begin forwarded message:\nFrom: Blue Bottle <hi@bluebottle.example>\nSubject: Receipt",
      )?.fromEmail,
    ).toBe("Blue Bottle <hi@bluebottle.example>");
    expect(
      parseInlineForwardEnvelope(
        "-----Original Message-----\nFrom: Blue Bottle <hi@bluebottle.example>\nSent: Monday\nSubject: Receipt",
      )?.subject,
    ).toBe("Receipt");
  });

  test("a body with no forward banner yields null (never a guess)", () => {
    expect(parseInlineForwardEnvelope("Total: $42.10\nThanks for your order.")).toBeNull();
    // A banner with nothing usable under it is null too.
    expect(parseInlineForwardEnvelope("---------- Forwarded message ---------")).toBeNull();
  });
});

// ── extractMerchantGuess (which tier a merchant came from) ───────────────────
describe("extractMerchantGuess", () => {
  test("a business-entity suffix is STRONG; a bare plausible line is WEAK", () => {
    expect(extractMerchantGuess(["Givebutter, Inc.", "Total: $75.00"])).toEqual({
      name: "Givebutter, Inc.",
      strong: true,
    });
    // Exactly the trap a forwarded marketing receipt sets: the first
    // plausible-looking line is chrome, not a merchant.
    expect(extractMerchantGuess(["Payments", "Total: $75.00"])).toEqual({
      name: "Payments",
      strong: false,
    });
    expect(extractMerchantGuess(["Total: $75.00"])).toBeNull();
  });
});

// ── extractMidLineMerchant (bug fix: a merchant name glued to surrounding
// PDF text — see `extractMerchantFromLines`'s doc) ───────────────────────────
describe("extractMidLineMerchant", () => {
  test("extracts just the name+suffix when glued directly to a following address", () => {
    expect(extractMidLineMerchant("Givebutter, Inc.2810 North Church Street")).toBe(
      "Givebutter, Inc.",
    );
  });

  test("extracts the name+suffix out of a long glued invoice+address line", () => {
    expect(
      extractMidLineMerchant(
        "Date of issue July 3, 2026 Date due July 3, 2026 Givebutter, Inc. " +
          "2810 North Church Street #53748 Wilmington, Delaware 19802 " +
          "United States support@givebutter.com",
      ),
    ).toBe("Givebutter, Inc.");
  });

  test("never matches starting mid-word (no capitalized word boundary to anchor on)", () => {
    expect(extractMidLineMerchant("receiptGivebutter, Inc. today")).toBeNull();
  });

  test("a bare 'Company' suffix with no comma is too common in prose to trust", () => {
    expect(
      extractMidLineMerchant("Some Random Company Name And A Bunch Of Other Words"),
    ).toBeNull();
  });

  test("a comma-preceded 'Company' suffix is trusted", () => {
    expect(extractMidLineMerchant("Thanks for shopping at Acme, Company today")).toBe(
      "Acme, Company",
    );
  });

  test("a line with no business-entity suffix at all yields null", () => {
    expect(extractMidLineMerchant("Thank you for your donation today")).toBeNull();
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
    const res = await ocrReceiptImage(config({ apiKey: null }), ["data:image/png;base64,x"], "m");
    expect("error" in res && res.error.kind).toBe("no_key");
  });

  test("a 402 (out of credits) response is preserved as a typed http error", async () => {
    globalThis.fetch = (async () => ({
      ok: false,
      status: 402,
      text: async () => "insufficient credits",
      json: async () => ({}),
    })) as unknown as typeof fetch;

    const res = await ocrReceiptImage(config(), ["data:image/png;base64,x"], "m");
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

    const res = await ocrReceiptImage(config(), ["data:image/png;base64,x"], "m");
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

    const res = await ocrReceiptImage(config(), ["data:image/png;base64,x"], "m");
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

    const res = await ocrReceiptImage(config(), ["data:image/png;base64,x"], "m");
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

// ── extractReceiptFields — a scanned PDF never reaches a vision call ────────
// THE FIX for the `application/pdf` vision-OCR 400 (Ollama sniffs the actual
// file bytes and rejects them: "invalid image: expected image mime type, got
// application/pdf" — the owner's ~25-receipts-in-one-upload bug): a scanned/
// image-only PDF (no usable text layer) must NEVER reach `ocrReceiptImage`
// carrying the raw PDF bytes. The guarantee is by construction — the routing
// only ever hands vision a RENDERED `image/png` page
// (`receiptPdf.ts#renderScannedPdfPages`, pdfium WASM), never the raw PDF.
// These tests mock the `ctx.runAction` boundary so `extractPdfText` reports
// "no text layer" AND `renderScannedPdfPages` reports "couldn't render
// either" (`{ pages: [] }`) — i.e. BOTH routes to a usable image fail — so the
// routing still bottoms out at the same dead-end `ocrError`, and vision is
// never fetched. (The render-succeeds path — rendered pages actually reach
// vision as `image/png` — is covered in `tests/receiptPdf.test.ts`, which can
// exercise the real `renderScannedPdfPages` action end to end.)
describe("extractReceiptFields — a scanned PDF never reaches a vision call", () => {
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

  // A structurally-real PDF signature — if this ever leaked into a vision
  // call's payload, it'd prove the guard failed.
  const pdfBlob = new Blob(["%PDF-1.4 (scanned, no text layer)"], {
    type: "application/pdf",
  });

  /** A fake `ActionCtx` whose `runAction` answers `extractPdfText` with "no
   *  text layer" (the scanned-PDF branch) and `renderScannedPdfPages` with
   *  "couldn't render either" (`{ pages: [] }`) — the render fallback ALSO
   *  fails, so the routing still bottoms out at the same dead-end `ocrError`
   *  these tests pin. No other action should ever be called. */
  function fakeCtxNoTextLayer(): ActionCtx {
    return {
      // Function references are fresh Proxy objects on every property access
      // (see `convex/server`'s `createApi`), so identify the call by its
      // stable dotted name (`getFunctionName`) rather than object identity.
      runAction: vi.fn(async (ref: unknown) => {
        const name = getFunctionName(ref as Parameters<typeof getFunctionName>[0]);
        if (name === getFunctionName(internal.receiptPdf.extractPdfText)) {
          return { text: "", pageCount: 1 };
        }
        if (name === getFunctionName(internal.receiptPdf.renderScannedPdfPages)) {
          return { pages: [] };
        }
        throw new Error(`unexpected runAction call: ${name}`);
      }),
      storage: {
        get: vi.fn(async () => null),
        delete: vi.fn(async () => undefined),
      },
    } as unknown as ActionCtx;
  }

  test("degrades to a clear ocrError — vision is NEVER called with the raw PDF", async () => {
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      throw new Error("vision must never be called on a raw PDF");
    }) as unknown as typeof fetch;

    const fakeCtx = fakeCtxNoTextLayer();

    const result = await extractReceiptFields(fakeCtx, {
      storageId: "storage_pdf" as unknown as Id<"_storage">,
      config: config(),
      blob: pdfBlob,
      contentType: "application/pdf",
      model: "m",
    });

    // No vision call was ever attempted — not even for a moment.
    expect(fetchCalled).toBe(false);
    expect(result.ocrAmountCents).toBeUndefined();
    expect(result.ocrModel).toBeUndefined();
    expect(result.ocrError).toBe(
      "Scanned PDF (no readable text layer) — couldn't read it " +
        "automatically; re-upload as a photo/screenshot or enter the total " +
        "manually.",
    );
  });

  test("the guarantee holds for Ollama too — no /api/chat call on a scanned PDF", async () => {
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      throw new Error("vision must never be called on a raw PDF");
    }) as unknown as typeof fetch;

    const fakeCtx = fakeCtxNoTextLayer();

    const result = await extractReceiptFields(fakeCtx, {
      storageId: "storage_pdf" as unknown as Id<"_storage">,
      config: config({ provider: "ollama", baseUrl: "http://localhost:11434" }),
      blob: pdfBlob,
      contentType: "application/pdf",
      model: "m",
    });

    expect(fetchCalled).toBe(false);
    expect(result.ocrError).toContain("Scanned PDF");
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

  // ── BUG FIX: humans mail the GOOGLE GROUP (`receipts@publicworship.life`),
  // which relays to our Resend inbound address because it's a member. The
  // relayed post still names the GROUP in `To:` — the member address only
  // appears on the envelope (`received_for`, unioned in by `http.ts`) — so a
  // filter that knew only the member address dropped every group forward.
  test("accepts the Google Group address the relay keeps in `To:`", () => {
    expect(isReceiptInboxAddress(["receipts@publicworship.life"])).toBe(true);
    expect(
      isReceiptInboxAddress(['"receipts" <Receipts@PublicWorship.life>']),
    ).toBe(true);
    // Still not a blanket domain accept — another group is not the receipts one.
    expect(isReceiptInboxAddress(["announce@publicworship.life"])).toBe(false);
  });
});

// ── isReceiptInboxSelf (the reply loop guard) ────────────────────────────────
describe("isReceiptInboxSelf", () => {
  test("recognizes both our inbound address and the group fronting it", () => {
    expect(isReceiptInboxSelf("receipts@reply.publicworship.life")).toBe(true);
    expect(isReceiptInboxSelf('"PW receipts" <receipts@publicworship.life>')).toBe(true);
  });

  test("an ordinary sender is not us", () => {
    expect(isReceiptInboxSelf("charisma@example.com")).toBe(false);
    expect(isReceiptInboxSelf(null)).toBe(false);
    expect(isReceiptInboxSelf(undefined)).toBe(false);
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
    expect(note).toBe(
      "Matched. (Skipped 1 attachment not processed as receipts: logo.png.)",
    );

    const many = appendSkippedNote(
      "No match.",
      ["a.png", "b.png", "c.png", "d.png", "e.png", "f.png", "g.png"],
    );
    expect(many).toContain("Skipped 7 attachments not processed as receipts:");
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

// ── Forwarded-as-attachment (.eml) expansion ─────────────────────────────────
// "Forward as attachment" (Gmail/Apple Mail/Outlook) wraps the original
// receipt email as a `message/rfc822` attachment, so the message that reaches
// the webhook has an EMPTY body and one opaque `.eml` — which the image/PDF
// filter used to drop, landing the whole email as `ignored` with the real
// receipt one MIME layer down, unread. These pin the two halves of the fix:
// the `.eml` gets PAST the attachment filter, and it gets OPENED into the
// receipt(s) inside it.
describe("isReceiptFileAttachment", () => {
  test("accepts images, PDFs, and forwarded messages — by type or extension", () => {
    expect(isReceiptFileAttachment("image/jpeg", "photo.jpg")).toBe(true);
    expect(isReceiptFileAttachment("application/pdf", "invoice.pdf")).toBe(true);
    // The bug: a forwarded message was rejected here and never opened.
    expect(isReceiptFileAttachment("message/rfc822", "Fwd invoice.eml")).toBe(true);
    expect(isReceiptFileAttachment("application/octet-stream", "Fwd invoice.eml")).toBe(true);
    // Genuinely unusable attachments are still rejected.
    expect(isReceiptFileAttachment("application/zip", "receipts.zip")).toBe(false);
    expect(isReceiptFileAttachment("text/calendar", "invite.ics")).toBe(false);
  });
});

describe("collectForwardedReceiptSources", () => {
  const CRLF = "\r\n";
  function buildEml(opts: {
    from: string;
    subject: string;
    text?: string;
    html?: string;
    parts?: { contentType: string; filename: string; body: string }[];
  }): string {
    const lines = [
      `Subject: ${opts.subject}`,
      `From: ${opts.from}`,
      'Content-Type: multipart/mixed; boundary="B"',
      "",
      "--B",
      'Content-Type: text/plain; charset="UTF-8"',
      "",
      opts.text ?? "",
    ];
    if (opts.html) {
      lines.push("--B", 'Content-Type: text/html; charset="UTF-8"', "", opts.html);
    }
    for (const part of opts.parts ?? []) {
      lines.push(
        "--B",
        `Content-Type: ${part.contentType}; name="${part.filename}"`,
        `Content-Disposition: attachment; filename="${part.filename}"`,
        "Content-Transfer-Encoding: base64",
        "",
        btoa(part.body),
      );
    }
    lines.push("--B--", "");
    return lines.join(CRLF);
  }

  test("a forwarded invoice yields its PDF, stamped with the MERCHANT's envelope", () => {
    const parsed = parseEmlMessage(
      buildEml({
        from: "Google Payments <payments-noreply@google.com>",
        subject: "Google Workspace: Your invoice is available",
        text: "Your invoice is attached.",
        parts: [
          { contentType: "application/pdf", filename: "5628803684.pdf", body: "%PDF-1.4 x" },
        ],
      }),
    );
    const sources = collectForwardedReceiptSources(parsed);
    expect(sources).toHaveLength(1);
    const [source] = sources;
    expect(source.kind).toBe("file");
    expect(source.filename).toBe("5628803684.pdf");
    // The envelope carried forward is the MERCHANT's, not the forwarder's —
    // this is what keeps the merchant fallback from deriving the team
    // member's own mail host as the "merchant".
    expect(deriveMerchantFromEmail(source.envelope!.fromEmail!, source.envelope!.subject))
      .toBe("Google Payments");
  });

  test("a forwarded email with NO file falls back to its own body text", () => {
    const parsed = parseEmlMessage(
      buildEml({
        from: "Blue Bottle Coffee <receipts@bluebottle.example>",
        subject: "Your receipt",
        text: "Thanks for your order.\r\nTotal: $42.10\r\n",
      }),
    );
    const sources = collectForwardedReceiptSources(parsed);
    expect(sources).toHaveLength(1);
    expect(sources[0].kind).toBe("body");
    expect(sources[0].filename).toBe("Your receipt (forwarded email)");
    if (sources[0].kind === "body") {
      expect(parseReceiptFromText(sources[0].text ?? "").amountCents).toBe(4210);
      // A text-only message has no HTML part to prefer for display.
      expect(sources[0].html).toBeNull();
    }
  });

  // The stored document must be the HTML the sender actually saw — storing
  // the plain-text alternative is what turned forwarded merchant receipts
  // into an unreadable wall of run-together text in the review queue.
  test("a message with BOTH parts carries the html for display and the text for parsing", () => {
    const parsed = parseEmlMessage(
      buildEml({
        from: "Uber Receipts <noreply@uber.com>",
        subject: "Your order",
        text: "Total: $42.10\r\n",
        html: "<div><h1>Uber Eats</h1><p>Total $42.10</p></div>",
      }),
    );
    const sources = collectForwardedReceiptSources(parsed);
    expect(sources).toHaveLength(1);
    if (sources[0].kind === "body") {
      expect(sources[0].html).toContain("<h1>Uber Eats</h1>");
      expect(sources[0].text).toContain("Total: $42.10");
    }
  });

  test("a file inside wins over the body — the body is only a fallback", () => {
    const parsed = parseEmlMessage(
      buildEml({
        from: "shop@example.com",
        subject: "Receipt",
        text: "Total: $42.10",
        parts: [{ contentType: "image/jpeg", filename: "receipt.jpg", body: "jpegbytes" }],
      }),
    );
    const sources = collectForwardedReceiptSources(parsed);
    expect(sources.map((s) => s.kind)).toEqual(["file"]);
  });

  test("an inline signature/logo inside the forward is skipped, not turned into a receipt", () => {
    const parsed = parseEmlMessage(
      buildEml({
        from: "shop@example.com",
        subject: "Receipt",
        text: "Total: $42.10",
        parts: [
          { contentType: "image/png", filename: "logo.png", body: "tiny" },
          { contentType: "application/pdf", filename: "receipt.pdf", body: "%PDF-1.4 x" },
        ],
      }),
    );
    const skipped: string[] = [];
    const sources = collectForwardedReceiptSources(parsed, skipped);
    expect(sources.map((s) => s.filename)).toEqual(["receipt.pdf"]);
    expect(skipped).toEqual(["logo.png"]);
  });

  test("a forward chain reaches the innermost receipt", () => {
    const inner = buildEml({
      from: "Google Payments <payments-noreply@google.com>",
      subject: "Invoice",
      parts: [{ contentType: "application/pdf", filename: "invoice.pdf", body: "%PDF-1.4 x" }],
    });
    const outer = [
      "Subject: Fwd: Invoice",
      "From: Alice <alice@publicworship.life>",
      'Content-Type: multipart/mixed; boundary="W"',
      "",
      "--W",
      "Content-Type: text/plain",
      "",
      "fyi",
      "--W",
      'Content-Type: message/rfc822; name="fwd.eml"',
      'Content-Disposition: attachment; filename="fwd.eml"',
      "",
      inner,
      "--W--",
      "",
    ].join(CRLF);

    const sources = collectForwardedReceiptSources(parseEmlMessage(outer));
    expect(sources).toHaveLength(1);
    expect(sources[0].filename).toBe("invoice.pdf");
    expect(sources[0].envelope?.fromEmail).toContain("payments-noreply@google.com");
  });

  test("a forward with nothing readable at all yields nothing", () => {
    const sources = collectForwardedReceiptSources(
      parseEmlMessage(["Subject: Empty", "From: a@b.com", "", ""].join(CRLF)),
    );
    expect(sources).toHaveLength(0);
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

  // NO-DATE MATCHING (the "$16.36 didn't auto-match" fix): a receipt whose OCR
  // found a total but NO date must match on exact amount ALONE — never against
  // a fabricated upload/receive date, which used to window out older charges.
  test("no receiptDate → matches a unique exact-amount charge even far outside ±14 days", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const now = Date.now();
    // A single unreceipted $16.36 charge, 6 MONTHS old — a fabricated "now"
    // date would have windowed this out; amount-alone matching keeps it.
    const txn = await seedTxn(s, { amountCents: 1636, postedAt: now - 180 * DAY });
    await seedTxn(s, { amountCents: 999, postedAt: now }); // wrong amount

    const matches = await t.query(internal.receiptInbox.findReceiptMatches, {
      chapterId: s.chapterId,
      amountCents: 1636,
      // receiptDate omitted — the dateless case.
    });
    expect(matches.map((m) => m.transactionId)).toEqual([txn]);
  });

  test("no receiptDate → still excludes receipted / non-spend / excluded charges", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const now = Date.now();
    await seedTxn(s, { amountCents: 1636, postedAt: now, hasReceipt: true });
    await seedTxn(s, { amountCents: 1636, postedAt: now, flow: "inflow" });
    await seedTxn(s, { amountCents: 1636, postedAt: now, status: "excluded" });
    await seedTxn(s, { amountCents: 1636, postedAt: now, isPersonal: true });
    const matches = await t.query(internal.receiptInbox.findReceiptMatches, {
      chapterId: s.chapterId,
      amountCents: 1636,
    });
    expect(matches).toEqual([]);
  });

  test("no receiptDate → returns all same-amount charges (ambiguous → no auto-attach), most recent first", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const now = Date.now();
    const older = await seedTxn(s, { amountCents: 1636, postedAt: now - 90 * DAY });
    const newer = await seedTxn(s, { amountCents: 1636, postedAt: now - 10 * DAY });
    const matches = await t.query(internal.receiptInbox.findReceiptMatches, {
      chapterId: s.chapterId,
      amountCents: 1636,
    });
    // Two candidates → downstream won't auto-attach (uniqueness guard holds).
    expect(matches.length).toBe(2);
    // Dateless ranking is most-recent-first.
    expect(matches[0].transactionId).toBe(newer);
    expect(matches[1].transactionId).toBe(older);
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

  test("a contact-only match (guest/donor, never a cardholder) falls through to the domain check, not auto-attached", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPerson(s, { email: "guest@example.com", isContactOnly: true });
    const c = await t.query(internal.receiptInbox.classifySender, {
      email: "guest@example.com",
    });
    // Falls through exactly like "no match" — an outside address → external.
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

  // ── Forward as attachment, end to end ──────────────────────────────────────
  // The reported bug: forwarding a receipt with Gmail's "Forward as
  // attachment" delivered a `message/rfc822` (.eml) the pipeline dropped, so
  // the email was `ignored` and the receipt never existed. Now the `.eml` is
  // opened and the message inside becomes the receipt — including its
  // merchant envelope, which is the MERCHANT's, not the forwarder's.
  describe("a forwarded-as-attachment email", () => {
    const realFetch = globalThis.fetch;
    const realKey = process.env.RESEND_API_KEY;
    afterEach(() => {
      globalThis.fetch = realFetch;
      if (realKey === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = realKey;
    });

    /** Serve Resend's attachment LIST + the signed download of one `.eml`.
     *  Any other call (the courtesy reply) is answered with a bare failure —
     *  `replyToSender` is best-effort by contract. */
    function mockResend(eml: string): void {
      process.env.RESEND_API_KEY = "test-key";
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/attachments")) {
          return {
            ok: true,
            json: async () => ({
              data: [
                {
                  id: "att_1",
                  filename: "Google Workspace invoice.eml",
                  content_type: "message/rfc822",
                  size: eml.length,
                  download_url: "https://files.example/att_1",
                },
              ],
            }),
          };
        }
        if (url.startsWith("https://files.example/")) {
          return {
            ok: true,
            blob: async () => new Blob([eml], { type: "message/rfc822" }),
          };
        }
        return { ok: false, status: 500, text: async () => "no" };
      }) as unknown as typeof fetch;
    }

    test("is opened, and the message inside becomes the receipt (merchant from ITS envelope)", async () => {
      const t = newT();
      const s = await setupChapter(t);
      // The FORWARDER is a roster member — that's what permits an auto-attach.
      await seedPerson(s, { email: "jane@example.com" });
      const txn = await seedTxn(s, { amountCents: 4210, status: "categorized" });

      mockResend(
        [
          "Subject: Your receipt",
          "From: Blue Bottle Coffee <receipts@bluebottle.example>",
          'Content-Type: text/plain; charset="UTF-8"',
          "",
          "Thanks for your order.",
          "Total: $42.10",
          "",
        ].join("\r\n"),
      );

      const { receiptId } = await t.mutation(internal.receiptInbox.recordInboundReceipt, {
        envelope: {
          emailId: "email_fwd_1",
          fromEmail: "Jane Doe <jane@example.com>",
          // Gmail sends the forward with an empty body — before the fix there
          // was nothing here to read at all.
          subject: "Fwd: Your receipt",
        },
      });
      await t.action(internal.receiptInbox.processInboundReceipt, { receiptId });

      const row = await run(t, (ctx) => ctx.db.get(receiptId));
      expect(row?.status).toBe("matched");
      expect(row?.matchedTransactionId).toBe(txn);

      const receipts = await run(t, (ctx) => ctx.db.query("receipts").take(5));
      expect(receipts).toHaveLength(1);
      expect(receipts[0].ocrAmountCents).toBe(4210);
      expect(receipts[0].filename).toBe("Your receipt (forwarded email)");
      // The forwarded message's own sender — NOT "Example" off the
      // forwarder's `jane@example.com`.
      expect(receipts[0].ocrMerchant).toBe("Blue Bottle Coffee");

      const txnRow = await run(t, (ctx) => ctx.db.get(txn));
      expect(txnRow?.status).toBe("reconciled");
    });

    test("an unreadable .eml is still stored as a document rather than silently ignored", async () => {
      const t = newT();
      const s = await setupChapter(t);
      await seedPerson(s, { email: "jane@example.com" });
      mockResend("this is not a parseable message at all");

      const { receiptId } = await t.mutation(internal.receiptInbox.recordInboundReceipt, {
        envelope: {
          emailId: "email_fwd_2",
          fromEmail: "jane@example.com",
          subject: "Fwd: receipt",
        },
      });
      await t.action(internal.receiptInbox.processInboundReceipt, { receiptId });

      const row = await run(t, (ctx) => ctx.db.get(receiptId));
      expect(row?.status).toBe("needs_review");
      const receipts = await run(t, (ctx) => ctx.db.query("receipts").take(5));
      expect(receipts).toHaveLength(1);
      expect(receipts[0].filename).toBe("Google Workspace invoice.eml");
    });
  });

  // ── Google Group relay, end to end ─────────────────────────────────────────
  // The reported shape: a team member forwards a merchant receipt INLINE to
  // `receipts@publicworship.life` (the group humans know), Google relays it to
  // our Resend inbound address because that address is a member, and rewrites
  // `From:` to the list on the way. Everything the pipeline needs about the
  // poster is then in `X-Original-Sender`, and everything it needs about the
  // merchant is in the forward banner.
  describe("a Google-Group-relayed inline forward", () => {
    const realFetch = globalThis.fetch;
    const realKey = process.env.RESEND_API_KEY;
    afterEach(() => {
      globalThis.fetch = realFetch;
      if (realKey === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = realKey;
    });

    /** No attachments (an inline forward has none), and a received-email
     *  record carrying the group's relay headers + the forwarded body. */
    function mockRelayedEmail(body: string, headers: Record<string, string>): string[] {
      const replies: string[] = [];
      process.env.RESEND_API_KEY = "test-key";
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/attachments")) {
          return { ok: true, json: async () => ({ data: [] }) };
        }
        if (url.includes("/emails/receiving/")) {
          return { ok: true, json: async () => ({ text: body, headers }) };
        }
        // The courtesy reply — record who it was addressed to.
        if (url.includes("/emails")) {
          replies.push(String((init?.body as string) ?? ""));
          return { ok: true, json: async () => ({ id: "sent_1" }) };
        }
        return { ok: false, status: 500, text: async () => "no" };
      }) as unknown as typeof fetch;
      return replies;
    }

    const FORWARDED_BODY = [
      "Paying it back",
      "",
      "Best,",
      "Charisma Stevens",
      "",
      "---------- Forwarded message ---------",
      "From: Uber Receipts <noreply@uber.com>",
      "Date: Thu, Jul 30, 2026 at 9:35 PM",
      "Subject: [Personal] Your Thursday evening order with Uber Eats",
      "To: <charisma@example.com>",
      "",
      "Payments",
      "Total $298.52",
    ].join("\n");

    test("attributes to the POSTER (not the list) and auto-attaches", async () => {
      const t = newT();
      const s = await setupChapter(t);
      await seedPerson(s, { email: "charisma@example.com" });
      const txn = await seedTxn(s, { amountCents: 29852, status: "categorized" });

      const replies = mockRelayedEmail(FORWARDED_BODY, {
        "List-Id": "<receipts.publicworship.life>",
        "X-Original-Sender": "charisma@example.com",
      });

      const { receiptId } = await t.mutation(internal.receiptInbox.recordInboundReceipt, {
        envelope: {
          emailId: "email_group_relay_1",
          // Google's DMARC rewrite — the list, not the person.
          fromEmail: '"Charisma S. via receipts" <receipts@publicworship.life>',
          toEmail: "receipts@publicworship.life",
          subject: "Fwd: [Personal] Your Thursday evening order with Uber Eats",
        },
      });
      await t.action(internal.receiptInbox.processInboundReceipt, { receiptId });

      const row = await run(t, (ctx) => ctx.db.get(receiptId));
      // Recovered to the roster member → trusted → the unique match attaches.
      expect(row?.senderClass).toBe("roster");
      // Both truths kept: the verbatim envelope AND who actually posted.
      expect(row?.fromEmail).toContain("receipts@publicworship.life");
      expect(row?.originalSenderEmail).toBe("charisma@example.com");
      expect(row?.status).toBe("matched");
      expect(row?.matchedTransactionId).toBe(txn);

      const receipts = await run(t, (ctx) => ctx.db.query("receipts").take(5));
      expect(receipts).toHaveLength(1);
      expect(receipts[0].ocrAmountCents).toBe(29852);
      // The forward banner's merchant beats the body's weak "Payments" guess —
      // and is nothing like the forwarder's/list's own domain.
      expect(receipts[0].ocrMerchant).toBe("Uber Receipts");

      // The courtesy reply is DEBOUNCED — nothing is sent inline; a batch is
      // opened for the PERSON, never for the group.
      expect(replies).toHaveLength(0);
      const batches = await run(t, (ctx) =>
        ctx.db.query("receiptReplyBatches").take(5),
      );
      expect(batches).toHaveLength(1);
      expect(batches[0].recipientEmail).toBe("charisma@example.com");
      expect(batches[0].items).toHaveLength(1);

      // Flushing it sends exactly one email, to the person.
      await t.action(internal.receiptInbox.flushReplyBatch, {
        batchId: batches[0]._id,
      });
      expect(replies).toHaveLength(1);
      expect(replies[0]).toContain("charisma@example.com");
      expect(replies[0]).not.toContain("receipts@publicworship.life");
    });

    test("no reply is ever sent to the group itself (loop guard)", async () => {
      const t = newT();
      const s = await setupChapter(t);
      // Pathological: the list address itself sits on the roster, so it would
      // otherwise classify as trusted and get a reply — which the group would
      // fan out to every member AND relay straight back to us.
      await seedPerson(s, { email: "receipts@publicworship.life" });

      const replies = mockRelayedEmail(FORWARDED_BODY, {
        "List-Id": "<receipts.publicworship.life>",
      });

      const { receiptId } = await t.mutation(internal.receiptInbox.recordInboundReceipt, {
        envelope: {
          emailId: "email_group_relay_2",
          fromEmail: "receipts@publicworship.life",
          subject: "Fwd: receipt",
        },
      });
      await t.action(internal.receiptInbox.processInboundReceipt, { receiptId });

      expect(replies).toHaveLength(0);
      // Not even a batch — the loop guard rejects our own address up front.
      const batches = await run(t, (ctx) =>
        ctx.db.query("receiptReplyBatches").take(5),
      );
      expect(batches).toHaveLength(0);
    });

    // ── The debounce, end to end ────────────────────────────────────────────
    // A person forwarding a stack of receipts (and a BACKFILL replaying months
    // of them) must earn ONE email, not one per receipt.
    test("several receipts from one sender collapse into a single digest", async () => {
      const t = newT();
      const s = await setupChapter(t);
      await seedPerson(s, { email: "charisma@example.com" });

      const replies = mockRelayedEmail(FORWARDED_BODY, {
        "List-Id": "<receipts.publicworship.life>",
        "X-Original-Sender": "charisma@example.com",
      });

      for (let i = 0; i < 3; i++) {
        const { receiptId } = await t.mutation(
          internal.receiptInbox.recordInboundReceipt,
          {
            envelope: {
              emailId: `email_batch_${i}`,
              fromEmail: '"Charisma S. via receipts" <receipts@publicworship.life>',
              subject: "Fwd: receipt",
            },
          },
        );
        await t.action(internal.receiptInbox.processInboundReceipt, { receiptId });
      }

      // One OPEN batch holding all three — not three batches, not three emails.
      const batches = await run(t, (ctx) =>
        ctx.db.query("receiptReplyBatches").take(5),
      );
      expect(batches).toHaveLength(1);
      expect(batches[0].items).toHaveLength(3);
      expect(replies).toHaveLength(0);

      await t.action(internal.receiptInbox.flushReplyBatch, {
        batchId: batches[0]._id,
      });
      expect(replies).toHaveLength(1);
      expect(replies[0]).toContain("3 receipts");

      // Claimed — a double-fired schedule can't send it again.
      await t.action(internal.receiptInbox.flushReplyBatch, {
        batchId: batches[0]._id,
      });
      expect(replies).toHaveLength(1);

      // A receipt arriving AFTER the flush opens a fresh window rather than
      // joining the closed one.
      const { receiptId } = await t.mutation(
        internal.receiptInbox.recordInboundReceipt,
        {
          envelope: {
            emailId: "email_batch_after",
            fromEmail: '"Charisma S. via receipts" <receipts@publicworship.life>',
            subject: "Fwd: receipt",
          },
        },
      );
      await t.action(internal.receiptInbox.processInboundReceipt, { receiptId });
      const after = await run(t, (ctx) =>
        ctx.db.query("receiptReplyBatches").take(5),
      );
      expect(after).toHaveLength(2);
    });

    test("two different senders get their own batches", async () => {
      const t = newT();
      const s = await setupChapter(t);
      await seedPerson(s, { email: "charisma@example.com" });
      await seedPerson(s, { email: "jane@example.com" });
      mockRelayedEmail(FORWARDED_BODY, {});

      for (const from of ["charisma@example.com", "jane@example.com"]) {
        const { receiptId } = await t.mutation(
          internal.receiptInbox.recordInboundReceipt,
          { envelope: { emailId: `email_two_${from}`, fromEmail: from, subject: "receipt" } },
        );
        await t.action(internal.receiptInbox.processInboundReceipt, { receiptId });
      }

      const batches = await run(t, (ctx) =>
        ctx.db.query("receiptReplyBatches").take(5),
      );
      expect(batches).toHaveLength(2);
      expect(batches.map((b) => b.recipientEmail).sort()).toEqual([
        "charisma@example.com",
        "jane@example.com",
      ]);
    });
  });

  // ── What the bookkeeper actually opens ─────────────────────────────────────
  // The reported symptom: a forwarded merchant receipt showed up as an
  // unreadable wall of run-together text with mojibake ("New Linâ€™s",
  // "9:35â€¯PM"), even though the same message renders fine in the mailing
  // list. Two causes, both here: we stored the plain-text ALTERNATIVE instead
  // of the HTML the sender saw, and we stored it with no charset so a UTF-8
  // body got decoded as latin-1.
  describe("the stored body document", () => {
    const realFetch = globalThis.fetch;
    const realKey = process.env.RESEND_API_KEY;
    afterEach(() => {
      globalThis.fetch = realFetch;
      if (realKey === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = realKey;
    });

    /** A received email carrying BOTH parts, as a real merchant receipt does. */
    function mockBothParts(html: string | null, text: string | null): void {
      process.env.RESEND_API_KEY = "test-key";
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/attachments")) {
          return { ok: true, json: async () => ({ data: [] }) };
        }
        if (url.includes("/emails/receiving/")) {
          return { ok: true, json: async () => ({ html, text, headers: null }) };
        }
        return { ok: false, status: 500, text: async () => "no" };
      }) as unknown as typeof fetch;
    }

    async function processOne(t: ReturnType<typeof newT>, emailId: string) {
      const { receiptId } = await t.mutation(
        internal.receiptInbox.recordInboundReceipt,
        { envelope: { emailId, fromEmail: "jane@example.com", subject: "Fwd: receipt" } },
      );
      await t.action(internal.receiptInbox.processInboundReceipt, { receiptId });
      const receipts = await run(t, (ctx) => ctx.db.query("receipts").take(5));
      // Read the blob INSIDE the callback — a Blob isn't a Convex value and
      // can't be returned across the `run` boundary.
      const file = await run(t, async (ctx) => {
        // `ctx.storage.get` returning a Blob is a convex-test affordance not
        // on the generated `StorageWriter` type (same cast `storeBlob` uses).
        const blob = await (
          ctx.storage as unknown as {
            get: (id: Id<"_storage">) => Promise<Blob | null>;
          }
        ).get(receipts[0].storageId!);
        return blob ? { type: blob.type, text: await blob.text() } : null;
      });
      return { receipt: receipts[0], contentType: file?.type, stored: file?.text };
    }

    test("stores the HTML the sender saw, tagged UTF-8 — not the text alternative", async () => {
      const t = newT();
      const s = await setupChapter(t);
      await seedPerson(s, { email: "jane@example.com" });
      mockBothParts(
        "<div><h1>Uber Eats</h1><p>Here's your receipt for New Lin’s kitchen.</p><p>Total $298.52</p></div>",
        "Uber Eats\nHere's your receipt for New Lin’s kitchen.\nTotal $298.52",
      );

      const { contentType, stored, receipt } = await processOne(t, "email_doc_html");

      // Declared charset is what stops "New Lin’s" rendering as "New Linâ€™s".
      expect(contentType).toBe("text/html;charset=utf-8");
      expect(stored).toContain("<h1>Uber Eats</h1>");
      // The total still parses — the TEXT part fed the heuristics.
      expect(receipt.ocrAmountCents).toBe(29852);
    });

    test("falls back to the text part when the message has no HTML", async () => {
      const t = newT();
      const s = await setupChapter(t);
      await seedPerson(s, { email: "jane@example.com" });
      mockBothParts(null, "Blue Bottle Coffee\nTotal: $42.10");

      const { contentType, stored, receipt } = await processOne(t, "email_doc_text");

      expect(contentType).toBe("text/plain;charset=utf-8");
      expect(stored).toContain("Blue Bottle Coffee");
      expect(receipt.ocrAmountCents).toBe(4210);
    });
  });
});

// ── composeReplyDigest (what the sender actually reads) ──────────────────────
describe("composeReplyDigest", () => {
  test("a single receipt reads exactly as it always did (no 'digest' voice)", () => {
    const one = composeReplyDigest([
      { outcome: "matched", amountCents: 29852, merchant: "Uber Receipts" },
    ]);
    expect(one.subject).toBe("Receipt matched ✓");
    expect(one.html).toContain("$298.52 from Uber Receipts");
    expect(one.html).not.toContain("<ul");

    expect(composeReplyDigest([{ outcome: "no_match", amountCents: 1636 }]).subject).toBe(
      "Receipt received — no matching charge yet",
    );
    expect(composeReplyDigest([{ outcome: "needs_review" }]).subject).toBe(
      "Receipt received — needs a quick look",
    );
  });

  test("an all-matched batch says so once, and lists each receipt", () => {
    const digest = composeReplyDigest([
      { outcome: "matched", amountCents: 1000, merchant: "Costco" },
      { outcome: "matched", amountCents: 2000, merchant: "Uber" },
    ]);
    expect(digest.subject).toBe("2 receipts matched ✓");
    expect(digest.html).toContain("all 2 receipts");
    expect(digest.html).toContain("$10.00 from Costco");
    expect(digest.html).toContain("$20.00 from Uber");
  });

  test("a mixed batch counts each outcome and promises nothing is lost", () => {
    const digest = composeReplyDigest([
      { outcome: "matched", amountCents: 1000 },
      { outcome: "no_match", amountCents: 2000 },
      { outcome: "needs_review", amountCents: 3000 },
    ]);
    expect(digest.subject).toBe("3 receipts received");
    expect(digest.html).toContain("1 attached to charges");
    expect(digest.html).toContain("1 with no matching charge yet");
    expect(digest.html).toContain("1 needing a bookkeeper's eye");
    expect(digest.html).toContain("nothing is lost");
  });

  test("overflow past the item cap is reported, never silently dropped", () => {
    const digest = composeReplyDigest(
      [
        { outcome: "matched", amountCents: 1000 },
        { outcome: "matched", amountCents: 2000 },
      ],
      7,
    );
    // The total counts the overflow, and it can't claim "all matched".
    expect(digest.subject).toBe("9 receipts received");
    expect(digest.html).toContain("+7 more");
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
