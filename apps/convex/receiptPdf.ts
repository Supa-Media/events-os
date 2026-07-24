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
 * `extractReceiptFields`) treats that as "no usable text" and now renders
 * page 1 to a PNG via `renderPdfFirstPagePng` (below) so the vision model can
 * OCR an actual IMAGE — never the raw PDF (see that function's doc for why:
 * Ollama 400s on `image_url` with `application/pdf`, and the fix's whole
 * point is that a PDF must never reach a vision call as anything but an
 * image).
 *
 * NODE-ONLY: `unpdf`'s `getDocumentProxy`/`extractText`/`renderPageAsImage`
 * need pdf.js's Node build (`DOMMatrix`/canvas-adjacent shims unavailable in
 * the default V8 runtime) — hence `"use node"` and this file's total
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
import { extractText, getDocumentProxy, renderPageAsImage } from "unpdf";

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

/**
 * Render PAGE 1 of a PDF to a PNG and store it, for a scanned/image-only PDF
 * (no usable text layer — see `extractPdfText`) so the caller can OCR that
 * PNG with the vision model instead of ever handing it the raw PDF bytes.
 * THIS is the fix for the `application/pdf` vision-OCR 400: Ollama's
 * `image_url` input requires a real image mime type, and the old pipeline
 * base64'd the PDF itself into that field. Only page 1 is rendered — a
 * receipt is page 1 (this is a receipt-OCR pipeline, not a document
 * archiver); a multipage PDF's later pages are never looked at.
 *
 * Uses `unpdf`'s `renderPageAsImage`, which — in Node.js — needs a canvas
 * backend to actually rasterize the page; `@napi-rs/canvas` (a prebuilt
 * native N-API addon, `convex.json`'s `node.externalPackages` keeps it OUT of
 * the esbuild bundle so Convex installs it for real in the deployed Node
 * environment instead of esbuild trying and failing to inline a native
 * binary) is the backend `unpdf` documents for exactly this. That's a native
 * dependency in a serverless Node runtime — a combination that doesn't
 * always survive a platform it wasn't built for, so EVERY step here is
 * wrapped in one try/catch: any failure (the addon fails to load, pdf.js
 * chokes on a malformed page, anything) degrades to `{ ok: false, reason }`,
 * never a throw. The caller (`receiptInbox.ts#extractReceiptFields`) treats
 * `ok: false` as "couldn't OCR this as an image" and returns a clear,
 * human-actionable `ocrError` instead — the guaranteed fallback that keeps a
 * scanned PDF from ever reaching the vision model as `application/pdf`,
 * whether or not this rendering path actually works in a given deployment.
 *
 * Returns a STORAGE ID rather than base64 bytes directly: a full-page PNG at
 * `scale: 2` can comfortably exceed Convex's ~1MB action argument/return size
 * limit, but file storage has no such limit. The caller loads the blob via
 * `ctx.storage.get` and base64-encodes it itself (reusing
 * `receiptInbox.ts#arrayBufferToBase64`, the same helper the image-OCR path
 * already uses) to build the `data:image/png;base64,...` URL — this file
 * never sees or builds a data URL, keeping the OCR-request shape owned by
 * one place. The rendered PNG is a scratch file for one OCR call; the caller
 * deletes it once it's done reading it.
 */
export const renderPdfFirstPagePng = internalAction({
  args: { storageId: v.id("_storage") },
  returns: v.union(
    v.object({ ok: v.literal(true), storageId: v.id("_storage") }),
    v.object({ ok: v.literal(false), reason: v.string() }),
  ),
  handler: async (ctx, { storageId }) => {
    const blob = await ctx.storage.get(storageId);
    if (!blob) return { ok: false as const, reason: "PDF not found in storage." };
    try {
      const buf = await blob.arrayBuffer();
      const pdf = await getDocumentProxy(new Uint8Array(buf));
      const png = await renderPageAsImage(pdf, 1, {
        scale: 2,
        canvasImport: () => import("@napi-rs/canvas"),
      });
      const pngStorageId = await ctx.storage.store(
        new Blob([png], { type: "image/png" }),
      );
      return { ok: true as const, storageId: pngStorageId };
    } catch (err) {
      // Native canvas backend unavailable in this runtime, a malformed page,
      // or anything else — never throw. The caller degrades to a clear
      // ocrError instead of a raw-PDF vision call.
      console.log(`[receiptPdf] page-1 render failed: ${String(err)}`);
      return { ok: false as const, reason: String(err) };
    }
  },
});
