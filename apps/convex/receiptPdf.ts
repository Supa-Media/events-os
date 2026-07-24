"use node";

/**
 * PDF text-layer extraction — the zero-LLM fix for the forwarded-Givebutter-
 * receipt bug: a DIGITAL PDF (one with a real text layer — Givebutter,
 * Stripe, Square, most any receipting platform) already carries its total as
 * SELECTABLE TEXT. The old pipeline base64'd every PDF into an `image_url`
 * data URL and handed it to a vision model, which silently failed on it
 * (multipage/dense PDFs degrade a vision model badly, and it cost an LLM call
 * for something a text extractor reads perfectly). This module reads that
 * text layer directly with `unpdf` (a pdf.js wrapper that runs in every JS
 * runtime) — no model, no network call, no cost.
 *
 * A SCANNED/faxed PDF has no text layer (or only OCR noise pdf.js can't
 * parse), so this returns `""`; the caller (`receiptInbox.ts`'s
 * `extractReceiptFields`) treats that as "no usable text" and degrades to a
 * clear, human-actionable `ocrError` (re-upload as a photo) — it NEVER hands
 * the raw PDF to a vision call, which is the whole point: Ollama 400s on
 * `image_url` with `application/pdf`. Rendering a scanned PDF page to an image
 * here would need a native canvas backend that doesn't bundle into Convex (see
 * git history / PR #406), so we don't attempt it.
 *
 * NODE-ONLY: `unpdf`'s `getDocumentProxy`/`extractText` need pdf.js's Node
 * build (`DOMMatrix`/canvas-adjacent shims unavailable in the default V8
 * runtime) — hence `"use node"` and this file's total
 * isolation from every query/mutation in the app (the guideline: never mix a
 * Node action with a query/mutation in the same file). Kept to the smallest
 * possible surface (a storage id in, raw text/a rendered-image storage id
 * out) so the default-runtime pipeline can stay action→action across the
 * runtime boundary without any parsing/OCR logic living here —
 * `receiptInbox.ts#parseReceiptFromText`/`extractReceiptFields` (unit-
 * testable, no Node, no ctx for the former) still own turning that text/image
 * into `{ amountCents, date, merchant }`.
 */
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { extractText, getDocumentProxy } from "unpdf";

export const extractPdfText = internalAction({
  args: { storageId: v.id("_storage") },
  returns: v.object({ text: v.string(), pageCount: v.number() }),
  handler: async (ctx, { storageId }) => {
    const blob = await ctx.storage.get(storageId);
    if (!blob) return { text: "", pageCount: 0 };
    try {
      const buf = await blob.arrayBuffer();
      const pdf = await getDocumentProxy(new Uint8Array(buf));
      const { text, totalPages } = await extractText(pdf, { mergePages: true });
      return { text: text ?? "", pageCount: totalPages };
    } catch (err) {
      // A malformed/encrypted/unparseable PDF — degrade to "no text", same as
      // a scanned PDF. The caller falls back to vision OCR either way.
      console.log(`[receiptPdf] text extraction failed: ${String(err)}`);
      return { text: "", pageCount: 0 };
    }
  },
});
