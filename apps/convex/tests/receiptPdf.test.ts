import { describe, expect, test, vi } from "vitest";
import { ConvexError } from "convex/values";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { createReceipt } from "../lib/receiptLinks";
import { PDF_TEXT_LAYER_PROVENANCE } from "../receiptInbox";

/**
 * PDF text-layer extraction (`receiptPdf.ts`, `"use node"`) + the routing it
 * feeds (`receiptInbox.ts#extractReceiptFields`) + `receipts.retryExtraction`
 * — the fix for the forwarded-Givebutter-PDF bug ("$33.80 paid on July 3,
 * 2026" extracted NOTHING because a digital PDF was base64'd to a vision
 * model instead of reading its own text layer).
 *
 * `receiptPdf.ts#extractPdfText` DOES run under `convex-test`'s
 * `edge-runtime` environment (verified directly — `unpdf`'s pdf.js build has
 * no Node-only dependency at the API surface this file uses), so these tests
 * exercise the real node action end-to-end via hand-built minimal PDF
 * fixtures, rather than only unit-testing the pure text→fields helper. The
 * synthetic single-long-line fixture PDF hits a pdf.js text-extraction quirk
 * that trims a few trailing characters (a MediaBox-width text-run artifact
 * specific to this hand-rolled single `Tj` fixture — a real multi-line
 * receipt PDF, e.g. Givebutter's, doesn't hit this), so the fixtures below
 * put the dollar figure early in the string and only assert on what actually
 * matters: the PARSED amount, never exact extracted-text equality.
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

  test("a scanned PDF (no text layer) falls back to vision OCR, which sets ocrError when keyless", async () => {
    const savedKey = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const t = newT();
      const s = await setupChapter(t);
      await seedBookkeeper(s);
      const storageId = await storePdf(s, SCANNED_PDF);
      const receiptId = await run(t, (ctx) =>
        createReceipt(ctx, { chapterId: s.chapterId, storageId, source: "upload" }),
      );

      await t.action(internal.receipts.runRetryExtraction, { receiptId, model: undefined });

      const row = await run(t, (ctx) => ctx.db.get(receiptId));
      expect(row?.ocrAmountCents).toBeUndefined();
      // RECEIPT QUALITY PR (fix 2): a keyless failure is a TRANSPORT problem,
      // distinct from "scanned PDF, model found no total" — it gets its own
      // specific, actionable message (never the generic scanned-PDF wording,
      // which would wrongly imply the model tried and failed to read it).
      expect(row?.ocrError).toBe(
        "No AI engine key configured — set one in Settings → Integrations.",
      );
      // ocrModel is the VISION model this time (the fallback was attempted),
      // never the text-layer sentinel.
      expect(row?.ocrModel).not.toBe(PDF_TEXT_LAYER_PROVENANCE);
      expect(row?.ocrModel).toBeDefined();
    } finally {
      if (savedKey !== undefined) process.env.OPENROUTER_API_KEY = savedKey;
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
      // A SCANNED pdf so the routing actually reaches the vision call (whose
      // model argument we're asserting on) rather than short-circuiting via
      // the text layer.
      const storageId = await storePdf(s, SCANNED_PDF);
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
