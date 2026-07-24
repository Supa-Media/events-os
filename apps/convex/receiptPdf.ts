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
 * `@hyzyla/pdfium` is pure WASM + JS, so it bundles — the wasm binary rides
 * along as a base64 JS constant handed to `init` explicitly (see
 * `initPdfiumLibrary`'s doc for why no other loading path survives every
 * runtime this code runs in). The #406 invariant still holds and is the whole
 * point of both functions: raw `application/pdf` bytes must NEVER reach the
 * vision model (Ollama 400s on `image_url` with `application/pdf`) — a
 * rendered `image/png` is the fix, not a violation of that rule.
 *
 * NODE-ONLY: `unpdf`'s `getDocumentProxy`/`extractText` need pdf.js's Node
 * build (`DOMMatrix`/canvas-adjacent shims unavailable in the default V8
 * runtime) — hence `"use node"` and this file's total isolation from every query/
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
 * Instantiate the PDFium WASM module with the binary passed EXPLICITLY —
 * never trusting the package's own environment detection or file loading.
 * Both of its automatic paths failed somewhere this code must run (verified
 * against production logs, 2026-07-24):
 *   - the default Node build fs-loads `pdfium.wasm` from its own package
 *     directory, but Convex's deploy doesn't ship that asset next to the
 *     bundled JS — prod threw `ENOENT ... modules/_deps/node/pdfium.wasm`
 *     (and `externalPackages` did not preserve the layout either);
 *   - the `browser/base64` build embeds the binary but its emscripten glue
 *     is compiled web-only — prod's real Node runtime throws
 *     `"not compiled for this environment"` (while vitest's `@edge-runtime/vm`
 *     accepts it, which is exactly why the two-tier fallback passed tests and
 *     still failed in prod).
 * The one path that works EVERYWHERE: import the base64-encoded binary the
 * package itself ships as a plain JS constant (bundles like any other JS —
 * no `.wasm` asset for the bundler to lose), decode it, and hand it to
 * `init({ wasmBinary })`, which every build accepts ahead of its own
 * detection. The chunk filename is content-hashed by the package's build, so
 * `@hyzyla/pdfium` is pinned EXACTLY in package.json — a version bump changes
 * the hash and must update the import below (the render tests catch it: the
 * import fails to resolve and every scanned-PDF test goes red).
 */
async function initPdfiumLibrary(): Promise<PDFiumLibrary> {
  const { PDFiumLibrary: Lib } = await import("@hyzyla/pdfium");
  const { PDFIUM_WASM_BASE64 } = await import(
    "@hyzyla/pdfium/dist/pdfium.wasm.base64-B4io7kt4.js"
  );
  const bin = atob(PDFIUM_WASM_BASE64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return await Lib.init({ wasmBinary: bytes.buffer });
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
