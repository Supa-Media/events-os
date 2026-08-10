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

/** Preferred render scale for a rasterized scanned-PDF page — enough
 *  resolution that small print survives for the vision model. This is now the
 *  ONLY rasterizer: the client-side pdfjs one that used to mirror this
 *  constant is gone, along with the N-rows-per-PDF upload it produced (see
 *  `receiptsTab/UploadZone.tsx`'s module doc). A CEILING, not a constant: see
 *  `scannedPageRenderScale`. */
const RENDER_SCALE = 2;

/** Longest output dimension a rendered page may have, in pixels. Plenty for
 *  the vision model (which downscales large inputs anyway — small print on a
 *  receipt is legible well below this), and the bound that keeps rendering
 *  alive on the node worker: an RGBA bitmap is `w*h*4` bytes of wasm linear
 *  memory PLUS JS-side copies, so a scale-2 render of a tall phone scan
 *  (observed in prod: 2358×5112 = ~48MB per page, three pages per PDF)
 *  OOM-kills the memory-capped worker as an uncatchable process death
 *  (opaque InternalServerError, all logs lost — prod-verified 2026-07-24).
 *  At 2000px the same page is ~7MB of bitmap. */
const MAX_RENDER_DIM_PX = 2000;

/**
 * Per-page render scale: the preferred `RENDER_SCALE`, shrunk so the longest
 * output dimension never exceeds `MAX_RENDER_DIM_PX`. A normal receipt PDF
 * page (letter/A4, ≤1000pt) still gets the full 2x; only oversized scan pages
 * scale down. Exported for unit tests; degenerate page sizes fall back to the
 * plain ceiling rather than a zero/negative/infinite scale.
 */
export function scannedPageRenderScale(widthPt: number, heightPt: number): number {
  const longest = Math.max(widthPt, heightPt);
  if (!Number.isFinite(longest) || longest <= 0) return RENDER_SCALE;
  return Math.min(RENDER_SCALE, MAX_RENDER_DIM_PX / longest);
}

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
async function decodePdfiumWasm(): Promise<Uint8Array<ArrayBuffer>> {
  const { PDFIUM_WASM_BASE64 } = await import(
    "@hyzyla/pdfium/dist/pdfium.wasm.base64-B4io7kt4.js"
  );
  // `Buffer.from(..., "base64")` decodes without materializing an
  // intermediate binary STRING the way `atob` does — the node action runs
  // memory-throttled (512MB Lambda), so peak allocations during this decode
  // matter. Buffer slices come from Node's shared pool, so copy into an
  // exact-sized standalone ArrayBuffer before handing it to the wasm engine.
  const decoded = Buffer.from(PDFIUM_WASM_BASE64, "base64");
  const bytes = new Uint8Array(new ArrayBuffer(decoded.byteLength));
  bytes.set(decoded);
  return bytes;
}

async function initPdfiumLibrary(): Promise<PDFiumLibrary> {
  const { PDFiumLibrary: Lib } = await import("@hyzyla/pdfium");
  const bytes = await decodePdfiumWasm();
  return await Lib.init({ wasmBinary: bytes.buffer });
}

/**
 * Staged production probe for the pdfium pipeline — exists because a hard
 * process death in a Convex node action surfaces only as an opaque
 * `InternalServerError` with every log line LOST (observed 2026-07-24: the
 * render action died ~20s in with no output). Each invocation runs the
 * pipeline only UP TO `stage` and returns a timing report, so the killer
 * stage is identified by which invocation stops coming back rather than by
 * logs that don't survive. Stages, in order: `imports` (module loads),
 * `decode` (base64 → bytes), `compile` (raw `new WebAssembly.Module` —
 * isolates V8's wasm compile from emscripten entirely), `init` (the
 * package's emscripten glue), `render` (needs `storageId`: load + render
 * page 1 + PNG-encode, nothing stored). Ops-only; nothing in the product
 * pipeline calls this.
 */
export const pdfiumProbe = internalAction({
  args: { stage: v.string(), storageId: v.optional(v.id("_storage")) },
  returns: v.string(),
  handler: async (ctx, { stage, storageId }) => {
    const report: string[] = [];
    const t0 = Date.now();
    const mark = (label: string) => {
      report.push(`${label}@${Date.now() - t0}ms`);
    };
    try {
      const { PDFiumLibrary: Lib } = await import("@hyzyla/pdfium");
      mark("imports-ok");
      if (stage === "imports") return report.join(" ");

      const bytes = await decodePdfiumWasm();
      mark(`decode-ok:${bytes.byteLength}b`);
      if (stage === "decode") return report.join(" ");

      const module = new WebAssembly.Module(bytes);
      mark(`compile-ok:${module ? "module" : "?"}`);
      if (stage === "compile") return report.join(" ");

      const library = await Lib.init({ wasmBinary: bytes.buffer });
      mark("init-ok");
      if (stage === "init" || !storageId) {
        library.destroy();
        mark("destroy-ok");
        return report.join(" ");
      }

      const blob = await ctx.storage.get(storageId);
      if (!blob) {
        library.destroy();
        return report.join(" ") + " blob-missing";
      }
      const doc = await library.loadDocument(new Uint8Array(await blob.arrayBuffer()));
      mark(`load-ok:${doc.getPageCount()}p`);
      const page = doc.getPage(0);
      const { originalWidth, originalHeight } = page.getOriginalSize();
      const scale = scannedPageRenderScale(originalWidth, originalHeight);
      const rendered = await page.render({ scale, render: "bitmap" });
      mark(`render-ok:${rendered.width}x${rendered.height}@${scale.toFixed(3)}x`);
      const png = encodePng({
        width: rendered.width,
        height: rendered.height,
        data: rendered.data,
        channels: 4,
      });
      mark(`encode-ok:${png.length}b`);
      doc.destroy();
      library.destroy();
      mark("destroy-ok");
      return report.join(" ");
    } catch (err) {
      return report.join(" ") + ` ERROR: ${String(err)}`;
    }
  },
});

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
          const { originalWidth, originalHeight } = page.getOriginalSize();
          const rendered = await page.render({
            scale: scannedPageRenderScale(originalWidth, originalHeight),
            render: "bitmap",
          });
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
