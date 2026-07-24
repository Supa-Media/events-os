import { describe, expect, test, vi } from "vitest";
import { ConvexError } from "convex/values";
import { newT, run, setupChapter, storeBlob, type ChapterSetup } from "./setup.helpers";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { createReceipt } from "../lib/receiptLinks";
import { PDF_TEXT_LAYER_PROVENANCE } from "../receiptInbox";

/**
 * PDF text-layer extraction AND scanned-PDF rasterization (`receiptPdf.ts`,
 * `"use node"`) + the routing they feed (`receiptInbox.ts#extractReceiptFields`)
 * + `receipts.retryExtraction` — the fix for the forwarded-Givebutter-PDF bug
 * ("$33.80 paid on July 3, 2026" extracted NOTHING because a digital PDF was
 * base64'd to a vision model instead of reading its own text layer) AND the
 * follow-up fix for a SCANNED PDF (no text layer), which used to dead-end
 * unconditionally — it now renders each page to a PNG (`@hyzyla/pdfium`) and
 * hands vision THOSE, still never the raw `application/pdf` bytes (see PR
 * #406's invariant, unchanged).
 *
 * Both `receiptPdf.ts#extractPdfText` and `#renderScannedPdfPages` DO run
 * under `convex-test`'s `edge-runtime` environment (verified directly —
 * `unpdf`'s pdf.js build has no Node-only dependency at the API surface this
 * file uses, and `@hyzyla/pdfium`'s `browser/base64` build carries its wasm
 * inline for exactly this sandbox), so these tests exercise the real node
 * actions end-to-end via hand-built minimal PDF fixtures, rather than only
 * unit-testing the pure text→fields helper. The synthetic single-long-line
 * fixture PDF hits a pdf.js text-extraction quirk that trims a few trailing
 * characters (a MediaBox-width text-run artifact specific to this hand-rolled
 * single `Tj` fixture — a real multi-line receipt PDF, e.g. Givebutter's,
 * doesn't hit this), so the fixtures below put the dollar figure early in the
 * string and only assert on what actually matters: the PARSED amount, never
 * exact extracted-text equality.
 */

// ── Fixture PDFs ──────────────────────────────────────────────────────────────
function buildDigitalPdf(text: string): string {
  const streamBody = `BT /F1 24 Tf 20 100 Td (${text}) Tj ET`;
  const len = new TextEncoder().encode(streamBody).length;
  return `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 300 144] /Contents 5 0 R >>
endobj
4 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
5 0 obj
<< /Length ${len} >>
stream
${streamBody}
endstream
endobj
trailer
<< /Size 6 /Root 1 0 R >>
%%EOF`;
}

/** Same shape as `buildDigitalPdf`, but a much wider `MediaBox` — the
 *  hand-rolled single-`Tj` fixture's known pdf.js quirk (see the module doc)
 *  clips extracted text at roughly the visible page width; a 300pt-wide page
 *  only reliably survives ~28 characters at this font size. Used only where a
 *  test needs a LONGER string (e.g. a full "Mon D, YYYY" date) to survive
 *  extraction intact. */
function buildWideDigitalPdf(text: string): string {
  const streamBody = `BT /F1 24 Tf 20 100 Td (${text}) Tj ET`;
  const len = new TextEncoder().encode(streamBody).length;
  return `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 900 144] /Contents 5 0 R >>
endobj
4 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
5 0 obj
<< /Length ${len} >>
stream
${streamBody}
endstream
endobj
trailer
<< /Size 6 /Root 1 0 R >>
%%EOF`;
}

/** A structurally valid PDF with an EMPTY content stream — no text layer at
 *  all, the shape a scanned/faxed receipt (image-only page) produces. */
const SCANNED_PDF = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /Resources << >> /MediaBox [0 0 300 144] /Contents 4 0 R >>
endobj
4 0 obj
<< /Length 0 >>
stream
endstream
endobj
trailer
<< /Size 5 /Root 1 0 R >>
%%EOF`;

/** Same shape as `SCANNED_PDF`, but TWO pages — for pinning
 *  `renderScannedPdfPages`'s `maxPages` cap (a scanned PDF with more pages
 *  than the cap must still only render up to the cap). */
const SCANNED_PDF_2PAGE = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /Resources << >> /MediaBox [0 0 300 144] /Contents 4 0 R >>
endobj
4 0 obj
<< /Length 0 >>
stream
endstream
endobj
5 0 obj
<< /Type /Page /Parent 2 0 R /Resources << >> /MediaBox [0 0 300 144] /Contents 6 0 R >>
endobj
6 0 obj
<< /Length 0 >>
stream
endstream
endobj
trailer
<< /Size 7 /Root 1 0 R >>
%%EOF`;

const DIGITAL_RECEIPT_TEXT = "Givebutter Total 33.80 paid Jul 3 filler filler filler";
// Same shape, but with a full "Mon D, YYYY" date so `parseReceiptFromText`'s
// date regex (which requires a 4-digit year) actually parses an `ocrDate` —
// `DIGITAL_RECEIPT_TEXT` above deliberately omits the year and so never
// yields one, which the per-field retry tests below need to exercise. Built
// via `buildWideDigitalPdf` (below) so the trailing year survives extraction
// intact.
const DIGITAL_RECEIPT_TEXT_WITH_DATE = "Givebutter Total 33.80 paid Jul 3, 2026 filler filler";

async function storePdf(s: ChapterSetup, content: string): Promise<Id<"_storage">> {
  return await run(s.t, (ctx) =>
    (ctx.storage as unknown as { store: (b: Blob) => Promise<Id<"_storage">> }).store(
      new Blob([content], { type: "application/pdf" }),
    ),
  );
}

// ── Seed helpers (mirrors receipts.test.ts) ───────────────────────────────────
async function seedPerson(s: ChapterSetup): Promise<Id<"people">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Book Keeper",
      userId: s.userId,
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
    ctx.db.insert("financeRoles", { chapterId: s.chapterId, personId, role, scope: "chapter", createdAt: Date.now() }),
  );
}
async function seedBookkeeper(s: ChapterSetup): Promise<Id<"people">> {
  const personId = await seedPerson(s);
  await grantRole(s, personId, "bookkeeper");
  return personId;
}
async function seedTxn(
  s: ChapterSetup,
  opts: { amountCents?: number; postedAt?: number; status?: "unreviewed" | "categorized" | "reconciled" } = {},
): Promise<Id<"transactions">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: "manual",
      flow: "outflow",
      amountCents: opts.amountCents ?? 3380,
      postedAt: opts.postedAt ?? Date.now(),
      merchantName: "Givebutter",
      status: opts.status ?? "unreviewed",
      createdAt: Date.now(),
    }),
  );
}

// ── extractPdfText (the node action itself) ───────────────────────────────────
describe("receiptPdf.extractPdfText", () => {
  test("a digital PDF's text layer yields a parseable total", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const storageId = await storePdf(s, buildDigitalPdf(DIGITAL_RECEIPT_TEXT));

    const { text, pageCount } = await t.action(internal.receiptPdf.extractPdfText, { storageId });
    expect(pageCount).toBe(1);
    expect(text.length).toBeGreaterThan(10);
    // The important bit: the dollar figure survives extraction intact.
    expect(text).toContain("33.80");
  });

  test("a scanned PDF (no text layer) yields empty text", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const storageId = await storePdf(s, SCANNED_PDF);

    const { text, pageCount } = await t.action(internal.receiptPdf.extractPdfText, { storageId });
    expect(pageCount).toBe(1);
    expect(text).toBe("");
  });

  test("a malformed/unparseable PDF degrades gracefully to empty text, never throws", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const storageId = await storePdf(s, "not a pdf at all");

    const result = await t.action(internal.receiptPdf.extractPdfText, { storageId });
    expect(result).toEqual({ text: "", pageCount: 0 });
  });
});

// ── renderScannedPdfPages (the node action itself) ────────────────────────────
// `@hyzyla/pdfium` (WASM) renders a scanned PDF's pages to raw RGBA, which
// `fast-png` encodes to PNG bytes stored via `ctx.storage.store`. This is the
// two-tier-init module under vitest's `@edge-runtime/vm` sandbox (no
// filesystem for the default Node-native build to fs-load its wasm from), so
// these tests exercise the SAME fallback path (`browser/base64`) prod Node
// would only reach if the fs-backed init ever failed there too — the render
// behavior itself is identical either way.
describe("receiptPdf.renderScannedPdfPages", () => {
  test("a scanned PDF renders at least one PNG page", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const storageId = await storePdf(s, SCANNED_PDF);

    const result = await t.action(internal.receiptPdf.renderScannedPdfPages, {
      storageId,
      maxPages: 3,
    });

    expect(result.pages.length).toBeGreaterThanOrEqual(1);
    // convex-test's mock `_storage` system table doesn't track `contentType`
    // (only sha256/size), so the stored MIME type is verified by re-fetching
    // the blob itself rather than `ctx.db.system.get`.
    const info = await run(t, async (ctx) => {
      // `MutationCtx.storage` is a write-only `StorageWriter` (no `.get`) —
      // only an action's `ctx.storage` can fetch a blob back. `convex-test`'s
      // mock supports it at runtime regardless, so cast the same way
      // `setup.helpers.ts#storeBlob` casts to reach `.store`.
      const blob = await (
        ctx.storage as unknown as { get: (id: Id<"_storage">) => Promise<Blob | null> }
      ).get(result.pages[0].storageId);
      return { type: blob?.type ?? null };
    });
    expect(info.type).toBe("image/png");
  });

  test("a malformed/unparseable PDF degrades to { pages: [] }, never throws", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const storageId = await storePdf(s, "not a pdf at all");

    const result = await t.action(internal.receiptPdf.renderScannedPdfPages, {
      storageId,
      maxPages: 3,
    });
    expect(result).toEqual({ pages: [] });
  });

  test("a missing source blob degrades to { pages: [] }", async () => {
    const t = newT();
    const s = await setupChapter(t);
    // A syntactically valid `_storage` id whose blob no longer exists (stored
    // then deleted) — `convex-test` validates the table prefix on an action's
    // `v.id("_storage")` arg, so an arbitrary string wouldn't reach the
    // handler at all; this exercises the REAL "blob vanished" branch instead.
    const storageId = await storePdf(s, SCANNED_PDF);
    await run(t, (ctx) => ctx.storage.delete(storageId));

    const result = await t.action(internal.receiptPdf.renderScannedPdfPages, {
      storageId,
      maxPages: 3,
    });
    expect(result).toEqual({ pages: [] });
  });

  test("maxPages caps the number of rendered pages", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const storageId = await storePdf(s, SCANNED_PDF_2PAGE);

    const capped = await t.action(internal.receiptPdf.renderScannedPdfPages, {
      storageId,
      maxPages: 1,
    });
    expect(capped.pages.length).toBe(1);

    const uncapped = await t.action(internal.receiptPdf.renderScannedPdfPages, {
      storageId,
      maxPages: 3,
    });
    expect(uncapped.pages.length).toBe(2);
  });
});

// ── extractReceiptFields routing, exercised via retryExtraction ──────────────
// `extractReceiptFields` isn't itself a Convex function (a plain helper an
// action calls), so it's exercised here through `receipts.runRetryExtraction`
// — a real internalAction that reaches the SAME routing code the email and
// upload pipelines use.
describe("PDF routing via retryExtraction (no vision-model call for a digital PDF)", () => {
  test("a digital PDF's total is read via the TEXT LAYER — ocrModel proves no vision call happened", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedBookkeeper(s);
    const storageId = await storePdf(s, buildDigitalPdf(DIGITAL_RECEIPT_TEXT));
    const receiptId = await run(t, (ctx) =>
      createReceipt(ctx, { chapterId: s.chapterId, storageId, source: "upload", filename: "givebutter.pdf" }),
    );
    // A unique matching charge — retry must NEVER auto-attach it even so.
    const txn = await seedTxn(s, { amountCents: 3380, status: "categorized" });

    await t.action(internal.receipts.runRetryExtraction, { receiptId, model: undefined });

    const row = await run(t, (ctx) => ctx.db.get(receiptId));
    expect(row?.ocrAmountCents).toBe(3380);
    expect(row?.ocrError).toBeUndefined();
    // The sentinel — NOT a vision-model slug — proves the vision model was
    // never called for this attachment.
    expect(row?.ocrModel).toBe(PDF_TEXT_LAYER_PROVENANCE);
    // Refreshed candidates surface the match...
    expect(row?.candidateTransactionIds).toEqual([txn]);
    // ...but retry NEVER auto-attaches, unlike the upload/email pipelines.
    expect(row?.linkCount).toBe(0);
    const links = await run(t, (ctx) => ctx.db.query("receiptLinks").collect());
    expect(links).toHaveLength(0);
  });

  // PDF-VISION-400 FIX, updated: a scanned PDF used to be base64'd straight
  // into an `image_url` as `application/pdf` and handed to the vision model —
  // Ollama rejects that with "HTTP 400: invalid image: expected image mime
  // type, got application/pdf" (the owner's ~25-receipts-on-one-upload bug).
  // The fix is STILL by-construction — a scanned PDF NEVER reaches vision
  // carrying `application/pdf` — but the routing no longer dead-ends there:
  // `renderScannedPdfPages` (pdfium WASM) rasterizes each page to a PNG
  // FIRST, and vision only ever sees THOSE rendered images. This test proves
  // the (updated) guarantee end to end by inspecting the actual request body
  // the mocked vision call received: every `image_url` part is a
  // `data:image/png` data URL, and `application/pdf` never appears in it.
  test("a scanned PDF (no text layer) renders to PNG pages and vision reads it — never a raw application/pdf payload", async () => {
    const savedKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "test-key";
    const realFetch = globalThis.fetch;
    try {
      const t = newT();
      const s = await setupChapter(t);
      await seedBookkeeper(s);
      const storageId = await storePdf(s, SCANNED_PDF);
      const receiptId = await run(t, (ctx) =>
        createReceipt(ctx, { chapterId: s.chapterId, storageId, source: "upload" }),
      );

      let capturedBody: { messages: { role: string; content: unknown }[] } | null =
        null;
      globalThis.fetch = (async (_url: unknown, init: { body?: string }) => {
        capturedBody = JSON.parse(init.body ?? "{}");
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    amount: 33.8,
                    date: "2026-07-03",
                    merchant: "Givebutter",
                    confidence: 0.9,
                  }),
                },
              },
            ],
          }),
          text: async () => "",
        };
      }) as unknown as typeof fetch;

      await t.action(internal.receipts.runRetryExtraction, { receiptId, model: undefined });

      const row = await run(t, (ctx) => ctx.db.get(receiptId));
      expect(row?.ocrAmountCents).toBe(3380);
      expect(row?.ocrError).toBeUndefined();
      // The vision model DID run this time — `ocrModel` is a real vision-model
      // slug, distinct from the text-layer sentinel.
      expect(row?.ocrModel).not.toBe(PDF_TEXT_LAYER_PROVENANCE);
      expect(row?.ocrModel).toBeDefined();

      // The invariant, verified on the wire: the vision call's user message
      // carries `image_url` parts, every one a rendered PNG data URL — never
      // the raw PDF bytes as `application/pdf`.
      expect(capturedBody).not.toBeNull();
      const userMessage = capturedBody!.messages.find((m) => m.role === "user");
      const imageParts = (
        userMessage!.content as { type: string; image_url?: { url: string } }[]
      ).filter((p) => p.type === "image_url");
      expect(imageParts.length).toBeGreaterThanOrEqual(1);
      for (const part of imageParts) {
        expect(part.image_url!.url).toMatch(/^data:image\/png;base64,/);
        expect(part.image_url!.url).not.toContain("application/pdf");
      }
    } finally {
      globalThis.fetch = realFetch;
      if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = savedKey;
    }
  });

  // The render fallback can ALSO fail (a malformed/unrenderable PDF) — the
  // routing then has no page to hand vision at all, so it degrades to the
  // SAME clear, human-actionable `ocrError` a scanned PDF has always produced
  // rather than ever attempting a vision call with nothing (or the raw PDF).
  test("a PDF that fails to render at all degrades to the clear ocrError, never a vision call", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedBookkeeper(s);
    // Passes `isPdfContentType` (real PDF-ish content type) but is garbage
    // bytes pdfium can't parse — both `extractPdfText` AND
    // `renderScannedPdfPages` fail on it, exactly like a corrupted upload.
    const storageId = await storePdf(s, "not a pdf at all");
    const receiptId = await run(t, (ctx) =>
      createReceipt(ctx, { chapterId: s.chapterId, storageId, source: "upload" }),
    );

    let fetchCalled = false;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      throw new Error("vision must never be called when nothing could be rendered");
    }) as unknown as typeof fetch;
    try {
      await t.action(internal.receipts.runRetryExtraction, { receiptId, model: undefined });
    } finally {
      globalThis.fetch = realFetch;
    }

    const row = await run(t, (ctx) => ctx.db.get(receiptId));
    expect(fetchCalled).toBe(false);
    expect(row?.ocrAmountCents).toBeUndefined();
    expect(row?.ocrError).toBe(
      "Scanned PDF (no readable text layer) — couldn't read it " +
        "automatically; re-upload as a photo/screenshot or enter the total " +
        "manually.",
    );
    expect(row?.ocrModel).not.toBe(PDF_TEXT_LAYER_PROVENANCE);
    expect(row?.ocrModel).toBeUndefined();
  });

  // The rendered pages are scratch artifacts for the vision call, not the
  // receipt document — the ORIGINAL PDF `storageId` stays canonical, and
  // every rendered page must be deleted once extraction is done (success or
  // failure) so a retry never accumulates orphaned page images in storage.
  test("rendered scratch pages are deleted from storage after extraction", async () => {
    const savedKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "test-key";
    const realFetch = globalThis.fetch;
    try {
      const t = newT();
      const s = await setupChapter(t);
      await seedBookkeeper(s);
      const storageId = await storePdf(s, SCANNED_PDF);
      const receiptId = await run(t, (ctx) =>
        createReceipt(ctx, { chapterId: s.chapterId, storageId, source: "upload" }),
      );

      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({ amount: 33.8, confidence: 0.9 }),
              },
            },
          ],
        }),
        text: async () => "",
      })) as unknown as typeof fetch;

      const countStorageRows = () =>
        run(t, (ctx) =>
          (ctx.db.system as unknown as { query: (t: "_storage") => { collect: () => Promise<unknown[]> } })
            .query("_storage")
            .collect(),
        ).then((rows) => rows.length);

      const before = await countStorageRows();
      await t.action(internal.receipts.runRetryExtraction, { receiptId, model: undefined });
      const after = await countStorageRows();

      // Only the original PDF remains — every rendered scratch page was
      // deleted, so the count is unchanged despite pages having been stored
      // mid-extraction.
      expect(after).toBe(before);
    } finally {
      globalThis.fetch = realFetch;
      if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = savedKey;
    }
  });
});

// ── retryExtraction (the "no way to retry" fix) ───────────────────────────────
describe("retryExtraction", () => {
  test("gates below bookkeeper+", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const person = await seedPerson(s);
    await grantRole(s, person, "viewer");
    const storageId = await storePdf(s, buildDigitalPdf(DIGITAL_RECEIPT_TEXT));
    const receiptId = await run(t, (ctx) =>
      createReceipt(ctx, { chapterId: s.chapterId, storageId, source: "upload" }),
    );
    await expect(
      s.as.mutation(api.receipts.retryExtraction, { receiptId }),
    ).rejects.toThrow(ConvexError);
  });

  test("rejects a receipt outside the caller's chapter", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "a@publicworship.life", chapterName: "NY" });
    const other = await setupChapter(t, { email: "b@publicworship.life", chapterName: "LA" });
    await seedBookkeeper(s);
    const storageId = await storePdf(other, buildDigitalPdf(DIGITAL_RECEIPT_TEXT));
    const receiptId = await run(t, (ctx) =>
      createReceipt(ctx, { chapterId: other.chapterId, storageId, source: "upload" }),
    );
    await expect(
      s.as.mutation(api.receipts.retryExtraction, { receiptId }),
    ).rejects.toThrow(ConvexError);
  });

  test("schedules reprocessing; a fresh read never overwrites a HUMAN-corrected canonical field", async () => {
    vi.useFakeTimers();
    try {
      const t = newT();
      const s = await setupChapter(t);
      const bookkeeper = await seedBookkeeper(s);
      const storageId = await storePdf(s, buildDigitalPdf(DIGITAL_RECEIPT_TEXT));
      const receiptId = await run(t, (ctx) =>
        createReceipt(ctx, { chapterId: s.chapterId, storageId, source: "upload" }),
      );
      // A human already corrected the canonical amount away from what a fresh
      // OCR read would produce.
      await run(t, (ctx) =>
        ctx.db.patch(receiptId, {
          amountCents: 9999,
          correctedByPersonId: bookkeeper,
          correctedAt: Date.now(),
        }),
      );

      await s.as.mutation(api.receipts.retryExtraction, { receiptId });
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      const row = await run(t, (ctx) => ctx.db.get(receiptId));
      // The immutable OCR provenance refreshed to the new read...
      expect(row?.ocrAmountCents).toBe(3380);
      // ...but the human-corrected CANONICAL amount is untouched.
      expect(row?.amountCents).toBe(9999);
      expect(row?.correctedAt).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  // RECEIPT QUALITY PR (per-field retry fix): the old rule gated ALL THREE
  // canonical fields on the single `correctedAt` flag, so a receipt that had
  // `correctedAt` set (from correcting one field, or ever having been
  // "touched") could never fill in an EMPTY field on retry — even a
  // successful fresh read never reached it. The fix is per-field: a still-
  // blank canonical field fills in from the fresh read regardless of
  // `correctedAt`; a field that already holds a value (human-set or not) is
  // preserved.
  test("a receipt with correctedAt set but a BLANK amount/date gets them filled on retry", async () => {
    vi.useFakeTimers();
    try {
      const t = newT();
      const s = await setupChapter(t);
      const bookkeeper = await seedBookkeeper(s);
      const storageId = await storePdf(s, buildWideDigitalPdf(DIGITAL_RECEIPT_TEXT_WITH_DATE));
      const receiptId = await run(t, (ctx) =>
        createReceipt(ctx, { chapterId: s.chapterId, storageId, source: "upload" }),
      );
      // Simulate the reported bug: `correctedAt` is set (e.g. the merchant
      // was corrected, or a field was cleared after correction), but the
      // canonical amount/date are BLANK — the fresh OCR read (gemma4 reading
      // "$303.86 · Jul 2" off a photo) must still fill them in.
      await run(t, (ctx) =>
        ctx.db.patch(receiptId, {
          amountCents: undefined,
          receiptDate: undefined,
          correctedByPersonId: bookkeeper,
          correctedAt: Date.now(),
        }),
      );

      await s.as.mutation(api.receipts.retryExtraction, { receiptId });
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      const row = await run(t, (ctx) => ctx.db.get(receiptId));
      expect(row?.ocrAmountCents).toBe(3380);
      // The previously-blank canonical fields are now filled from the fresh
      // read — the whole point of the fix.
      expect(row?.amountCents).toBe(3380);
      expect(row?.receiptDate).toBe(row?.ocrDate);
      expect(row?.receiptDate).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  test("a receipt with a human-set amount keeps it on retry, while a blank date still fills in", async () => {
    vi.useFakeTimers();
    try {
      const t = newT();
      const s = await setupChapter(t);
      const bookkeeper = await seedBookkeeper(s);
      const storageId = await storePdf(s, buildWideDigitalPdf(DIGITAL_RECEIPT_TEXT_WITH_DATE));
      const receiptId = await run(t, (ctx) =>
        createReceipt(ctx, { chapterId: s.chapterId, storageId, source: "upload" }),
      );
      // A human corrected the AMOUNT only — the date was never set.
      await run(t, (ctx) =>
        ctx.db.patch(receiptId, {
          amountCents: 4444,
          receiptDate: undefined,
          correctedByPersonId: bookkeeper,
          correctedAt: Date.now(),
        }),
      );

      await s.as.mutation(api.receipts.retryExtraction, { receiptId });
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      const row = await run(t, (ctx) => ctx.db.get(receiptId));
      // The human-corrected amount survives untouched...
      expect(row?.amountCents).toBe(4444);
      // ...but the blank date fills in from the fresh read.
      expect(row?.receiptDate).toBeDefined();
      expect(row?.receiptDate).toBe(row?.ocrDate);
    } finally {
      vi.useRealTimers();
    }
  });

  test("seeds canonical fields from a fresh read when nobody has corrected the receipt yet", async () => {
    vi.useFakeTimers();
    try {
      const t = newT();
      const s = await setupChapter(t);
      await seedBookkeeper(s);
      const storageId = await storePdf(s, buildDigitalPdf(DIGITAL_RECEIPT_TEXT));
      const receiptId = await run(t, (ctx) =>
        createReceipt(ctx, { chapterId: s.chapterId, storageId, source: "upload" }),
      );

      await s.as.mutation(api.receipts.retryExtraction, { receiptId });
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      const row = await run(t, (ctx) => ctx.db.get(receiptId));
      expect(row?.amountCents).toBe(3380);
      expect(row?.ocrAmountCents).toBe(3380);
    } finally {
      vi.useRealTimers();
    }
  });

  test("clears a stale ocrError once a retry succeeds", async () => {
    vi.useFakeTimers();
    try {
      const t = newT();
      const s = await setupChapter(t);
      await seedBookkeeper(s);
      const storageId = await storePdf(s, buildDigitalPdf(DIGITAL_RECEIPT_TEXT));
      const receiptId = await run(t, (ctx) =>
        createReceipt(ctx, { chapterId: s.chapterId, storageId, source: "upload" }),
      );
      await run(t, (ctx) =>
        ctx.db.patch(receiptId, { ocrError: "Vision OCR is not configured (no API key) — extraction was skipped." }),
      );

      await s.as.mutation(api.receipts.retryExtraction, { receiptId });
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      const row = await run(t, (ctx) => ctx.db.get(receiptId));
      expect(row?.ocrError).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  test("threads the optional model override through instead of the configured default", async () => {
    vi.useFakeTimers();
    try {
      const t = newT();
      const s = await setupChapter(t);
      await seedBookkeeper(s);
      // A plain image so the routing reaches the vision call directly,
      // without the extra render hop a scanned PDF would take (covered by
      // its own tests above and in `receiptInbox.test.ts`) — keeps this test
      // focused on the one thing it's pinning: the MODEL argument threaded
      // through.
      const storageId = await storeBlob(t);
      const receiptId = await run(t, (ctx) =>
        createReceipt(ctx, { chapterId: s.chapterId, storageId, source: "upload" }),
      );

      await s.as.mutation(api.receipts.retryExtraction, {
        receiptId,
        model: "openai/gpt-4o-mini",
      });
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      const row = await run(t, (ctx) => ctx.db.get(receiptId));
      // Keyless, so the call still fails — but the MODEL attempted is the
      // override, not the chapter's configured default.
      expect(row?.ocrModel).toBe("openai/gpt-4o-mini");
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── retry email merchant fallback (BUG FIX) ───────────────────────────────────
// `deriveMerchantFromEmail` only ever ran during INITIAL email processing
// (`receiptInbox.ts#runPipeline`) — a retry re-ran the SAME PDF-text/vision
// routing with no email context at all, so an email-sourced receipt whose
// fresh extraction still found no merchant stayed blank FOREVER, even after a
// successful retry. `runRetryExtraction` now mirrors the same fallback: an
// email-sourced receipt (has an `inboundReceiptId`) whose fresh read yields no
// merchant loads its originating `inboundReceipts` row and derives one from
// the envelope, exactly like the initial pipeline does.
describe("retryExtraction — email merchant fallback", () => {
  async function seedInboundRow(
    s: ChapterSetup,
    opts: { fromEmail: string; subject?: string },
  ): Promise<Id<"inboundReceipts">> {
    return await run(s.t, (ctx) =>
      ctx.db.insert("inboundReceipts", {
        emailId: `e_${Math.random()}`,
        status: "needs_review",
        fromEmail: opts.fromEmail,
        subject: opts.subject,
        chapterId: s.chapterId,
        receivedAt: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
  }

  test("a blank-merchant email receipt gets the merchant filled from the subject fallback on retry", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedBookkeeper(s);
    // `DIGITAL_RECEIPT_TEXT`'s PDF-text heuristic finds an amount but no
    // merchant (no business-suffix line at all) — exactly the gap the email
    // fallback needs to fill.
    const storageId = await storePdf(s, buildDigitalPdf(DIGITAL_RECEIPT_TEXT));
    const inboundReceiptId = await seedInboundRow(s, {
      fromEmail: "someone@gmail.com",
      subject: "Fwd: Your receipt from Givebutter, Inc. #2383-5178",
    });
    const receiptId = await run(t, (ctx) =>
      createReceipt(ctx, {
        chapterId: s.chapterId,
        storageId,
        source: "email",
        inboundReceiptId,
      }),
    );

    await t.action(internal.receipts.runRetryExtraction, { receiptId, model: undefined });

    const row = await run(t, (ctx) => ctx.db.get(receiptId));
    expect(row?.ocrAmountCents).toBe(3380);
    // The fresh PDF-text read alone found no merchant...
    // ...but the email fallback fills it in.
    expect(row?.ocrMerchant).toBe("Givebutter, Inc.");
    // Per-field rule: the canonical `merchant` (still blank) is also filled.
    expect(row?.merchant).toBe("Givebutter, Inc.");
  });

  test("never overwrites a merchant the fresh extraction DID find", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedBookkeeper(s);
    // A PDF whose text layer DOES carry a clean business-suffix name
    // (single-line fixture — see the module doc on the hand-rolled single-`Tj`
    // fixture's quirks with embedded line breaks).
    const storageId = await storePdf(s, buildDigitalPdf("Acme Co. Total 33.80 paid"));
    const inboundReceiptId = await seedInboundRow(s, {
      fromEmail: "someone@gmail.com",
      subject: "Fwd: Your receipt from Givebutter, Inc. #2383-5178",
    });
    const receiptId = await run(t, (ctx) =>
      createReceipt(ctx, {
        chapterId: s.chapterId,
        storageId,
        source: "email",
        inboundReceiptId,
      }),
    );

    await t.action(internal.receipts.runRetryExtraction, { receiptId, model: undefined });

    const row = await run(t, (ctx) => ctx.db.get(receiptId));
    // The real extracted merchant wins — the email fallback never runs when
    // extraction already found one.
    expect(row?.ocrMerchant).not.toBe("Givebutter, Inc.");
  });

  test("an upload-sourced receipt (no inboundReceiptId) never triggers the email fallback", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedBookkeeper(s);
    const storageId = await storePdf(s, buildDigitalPdf(DIGITAL_RECEIPT_TEXT));
    const receiptId = await run(t, (ctx) =>
      createReceipt(ctx, { chapterId: s.chapterId, storageId, source: "upload" }),
    );

    await t.action(internal.receipts.runRetryExtraction, { receiptId, model: undefined });

    const row = await run(t, (ctx) => ctx.db.get(receiptId));
    expect(row?.ocrAmountCents).toBe(3380);
    expect(row?.ocrMerchant).toBeUndefined();
  });
});

// ── submitUploadedReceipts filenames ──────────────────────────────────────────
describe("submitUploadedReceipts filenames", () => {
  test("the client-supplied filename is stamped onto the created receipt", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedBookkeeper(s);
    const storageId = await storePdf(s, buildDigitalPdf(DIGITAL_RECEIPT_TEXT));

    const [outcome] = await s.as.mutation(api.receipts.submitUploadedReceipts, {
      storageIds: [storageId],
      filenames: ["givebutter-receipt.pdf"],
    });

    const row = await run(t, (ctx) => ctx.db.get(outcome.receiptId));
    expect(row?.filename).toBe("givebutter-receipt.pdf");
  });

  test("filenames is optional — omitting it leaves the receipt filename unset", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedBookkeeper(s);
    const storageId = await storePdf(s, buildDigitalPdf(DIGITAL_RECEIPT_TEXT));

    const [outcome] = await s.as.mutation(api.receipts.submitUploadedReceipts, {
      storageIds: [storageId],
    });

    const row = await run(t, (ctx) => ctx.db.get(outcome.receiptId));
    expect(row?.filename).toBeUndefined();
  });
});

// ── processUploadedReceipt: PDF text-layer routing on the upload path ────────
describe("processUploadedReceipt PDF routing", () => {
  test("a digital PDF upload is read via the text layer, zero vision calls, and auto-attaches a unique candidate", async () => {
    vi.useFakeTimers();
    try {
      const t = newT();
      const s = await setupChapter(t);
      await seedBookkeeper(s);
      const txn = await seedTxn(s, { amountCents: 3380, status: "categorized" });
      const storageId = await storePdf(s, buildDigitalPdf(DIGITAL_RECEIPT_TEXT));

      const [outcome] = await s.as.mutation(api.receipts.submitUploadedReceipts, {
        storageIds: [storageId],
        filenames: ["givebutter.pdf"],
      });
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      const row = await run(t, (ctx) => ctx.db.get(outcome.receiptId));
      expect(row?.ocrAmountCents).toBe(3380);
      expect(row?.ocrModel).toBe(PDF_TEXT_LAYER_PROVENANCE);
      expect(row?.ocrError).toBeUndefined();
      expect(row?.filename).toBe("givebutter.pdf");
      // Unlike retry, the UPLOAD pipeline DOES auto-attach a unique candidate
      // (mirrors the email pipeline's trusted in-app bar).
      expect(row?.linkCount).toBe(1);
      const txnRow = await run(t, (ctx) => ctx.db.get(txn));
      expect(txnRow?.status).toBe("reconciled");
    } finally {
      vi.useRealTimers();
    }
  });
});
