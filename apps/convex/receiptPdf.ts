"use node";

/**
 * PDF text-layer extraction and scanned-PDF rasterization — the two ways a
 * PDF receipt reaches a total.
 *
 * A DIGITAL PDF (one with a real text layer — Givebutter, Stripe, Square,
 * most any receipting platform) already carries its total as SELECTABLE
 * TEXT. The old pipeline base64'd every PDF into an `image_url` data URL and
 * handed it to a vision model, which silently failed on it (multipage/dense
 * PDFs degrade a vision model badly, and it cost an LLM call for something a
 * text extractor reads perfectly). `extractPdfText` reads that text layer
 * directly with `unpdf` (a pdf.js wrapper that runs in every JS runtime) — no
 * model, no network call, no cost.
 *
 * A SCANNED/faxed PDF has no text layer (or only OCR noise pdf.js can't
 * parse), so `extractPdfText` returns `""`; the caller (`receiptInbox.ts`'s
 * `extractReceiptFields`) treats that as "no usable text" and falls back to
 * `renderScannedPdfPages` — it rasterizes each page to a PNG with `@hyzyla/
 * pdfium` (a WASM build of Chromium's PDF renderer, so no native `.node`
 * addon to bundle) and stores each page as its own `_storage` blob, which the
 * caller then hands to the vision model as `image_url` PNGs. This is the
 * fix for a REVERTED first attempt (PR #406) that rendered server-side via
 * `@napi-rs/canvas` — a native addon that broke Convex's esbuild bundling;
 * `@hyzyla/pdfium` is pure WASM + JS, so it bundles (with its wasm file kept
 * out of the bundle via `convex.json`'s `externalPackages` — it fs-loads the
 * file itself at runtime). The #406 invariant still holds and is the whole
 * point of both functions: raw `application/pdf` bytes must NEVER reach the
 * vision model (Ollama 400s on `image_url` with `application/pdf`) — a
 * rendered `image/png` is the fix, not a violation of that rule.
 *
 * NODE-ONLY: `unpdf`'s `getDocumentProxy`/`extractText` need pdf.js's Node
 * build (`DOMMatrix`/canvas-adjacent shims unavailable in the default V8
 * runtime), and `@hyzyla/pdfium`'s Node build fs-loads its own `.wasm` file —
 * hence `"use node"` and this file's total isolation from every query/
 * mutation in the app (the guideline: never mix a Node action with a query/
 * mutation in the same file). Kept to the smallest possible surface (a
 * storage id in, raw text/rendered-image storage ids out) so the default-
 * runtime pipeline can stay action→action across the runtime boundary
 * without any parsing/OCR logic living here — `receiptInbox.ts#
 * parseReceiptFromText`/`extractReceiptFields` (unit-testable, no Node, no
 * ctx for the former) still own turning that text/image into
 * `{ amountCents, date, merchant }`.
 */
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { extractText, getDocumentProxy } from "unpdf";
import { encode as encodePng } from "fast-png";
import type { PDFiumLibrary } from "@hyzyla/pdfium";
import type { Id } from "./_generated/dataModel";

/** Render scale for a rasterized scanned-PDF page — matches the client
 *  rasterizer's own `RENDER_SCALE` (`apps/mobile/lib/receiptPdfRasterize.web.ts`)
 *  so a server-rendered page and a client-rendered one read at the same
 *  effective resolution for the vision model. */
const RENDER_SCALE = 2;

/**
 * Instantiate the PDFium WASM module with a two-tier fallback. The default
 * build is what prod Node actually runs — cheap, because it fs-loads its
 * `.wasm` file straight off disk (the reason `convex.json` lists
 * `@hyzyla/pdfium` under `externalPackages`: esbuild must not try to inline a
 * WASM binary into the bundle). That same fs-load throws
 * `"wasmBinary is required for browser environment"` under vitest's test
 * sandbox, which runs Convex functions inside `@edge-runtime/vm` (see the
 * repo's Convex testing guideline) — a environment with no filesystem for the
 * default build to read from. The `browser/base64` build carries its wasm
 * inline instead, so it works in EITHER environment; it's only the fallback
 * (not the default) because decoding a base64'd wasm blob on every prod cold
 * start is needless overhead once the fs-backed build is available.
 */
async function initPdfiumLibrary(): Promise<PDFiumLibrary> {
  try {
    const { PDFiumLibrary: Lib } = await import("@hyzyla/pdfium");
    return await Lib.init();
  } catch (err) {
    console.log(
      `[receiptPdf] default pdfium init unavailable (${String(err)}) — falling back to the embedded-wasm build.`,
    );
    const { PDFiumLibrary: Lib } = await import("@hyzyla/pdfium/browser/base64");
    return await Lib.init({ disableBase64Warning: true });
  }
}

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
 * Rasterize a SCANNED pdf (one `extractPdfText` found no usable text layer
 * on) into up to `maxPages` `image/png` blobs — the fix that lets a scanned
 * receipt reach the vision model at all, since the model can never be handed
 * the raw `application/pdf` bytes (see this file's module doc / PR #406).
 * Each rendered page is stored via `ctx.storage.store` and only its storage
 * id crosses back over the action boundary — a rendered page's raw pixels
 * would blow well past Convex's value-size limits for anything but a tiny
 * receipt, so returning base64 here (the way `extractReceiptFields` builds a
 * data URL for a PLAIN image already in storage) isn't an option for a
 * freshly-rendered one.
 *
 * Degrades to `{ pages: [] }` on ANY failure — a missing source blob, a
 * malformed/unparseable PDF, a pdfium init/render error, or a PNG-encode
 * error — never throws, mirroring `extractPdfText`'s own contract. The
 * caller (`receiptInbox.ts#extractReceiptFields`) treats an empty `pages`
 * array as "rendering couldn't help either" and falls back to the same
 * human-actionable `ocrError` a scanned PDF has always degraded to.
 */
export const renderScannedPdfPages = internalAction({
  args: { storageId: v.id("_storage"), maxPages: v.number() },
  returns: v.object({ pages: v.array(v.object({ storageId: v.id("_storage") })) }),
  handler: async (ctx, { storageId, maxPages }) => {
    const blob = await ctx.storage.get(storageId);
    if (!blob) {
      console.log("[receiptPdf] renderScannedPdfPages: source blob missing from storage.");
      return { pages: [] };
    }

    let library: PDFiumLibrary | null = null;
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      library = await initPdfiumLibrary();
      const doc = await library.loadDocument(bytes);
      try {
        const pages: { storageId: Id<"_storage"> }[] = [];
        let index = 0;
        for (const page of doc.pages()) {
          if (index >= maxPages) break;
          index++;
          const rendered = await page.render({ scale: RENDER_SCALE, render: "bitmap" });
          const png = encodePng({
            width: rendered.width,
            height: rendered.height,
            data: rendered.data,
            channels: 4,
          });
          // `fast-png#encode` types its return as a bare `Uint8Array`, which
          // TS's DOM lib widens to `Uint8Array<ArrayBufferLike>` — not
          // assignable to `BlobPart` (which wants the buffer concretely typed
          // `ArrayBuffer`, excluding `SharedArrayBuffer`). Re-wrapping through
          // the `ArrayLike<number>` constructor overload yields a concretely-
          // typed `Uint8Array<ArrayBuffer>` `Blob` can take directly.
          const pageStorageId = await ctx.storage.store(
            new Blob([new Uint8Array(png)], { type: "image/png" }),
          );
          pages.push({ storageId: pageStorageId });
        }
        return { pages };
      } finally {
        doc.destroy();
      }
    } catch (err) {
      // Malformed/encrypted/unparseable PDF, a pdfium init/render failure, or
      // a PNG-encode error — degrade to "couldn't render", same posture as
      // `extractPdfText`'s own catch. The caller falls back to the existing
      // scanned-PDF `ocrError` either way.
      console.log(`[receiptPdf] scanned-PDF render failed: ${String(err)}`);
      return { pages: [] };
    } finally {
      library?.destroy();
    }
  },
});
