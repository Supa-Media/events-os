/**
 * Scanned-PDF → image rasterization — WEB implementation.
 *
 * Metro resolves this `.web.ts` for the web bundle; `receiptPdfRasterize.ts`
 * (a passthrough stub) is used on native, so `pdfjs-dist` — a browser-only
 * library that needs a DOM canvas — never lands in the native bundle (same
 * split as `fcClient.web.ts`). This only ever runs on web anyway: the native
 * image pickers can't select a PDF, so a PDF is only ever picked on web.
 *
 * WHY: Convex reads a DIGITAL PDF's text layer directly (free, whole-document
 * — `receiptPdf.ts#extractPdfText`), but a SCANNED/image-only PDF has no text
 * layer and can't be OCR'd server-side (rendering a PDF page to an image needs
 * a native canvas backend that doesn't bundle into Convex — see PR #406). So
 * we rasterize scanned PDFs to PNGs HERE, on the client that DOES have a
 * canvas, and upload the images — which flow through the existing image-OCR
 * path (the upload's `Content-Type: image/png` becomes the stored content type
 * the server sniffs, so no backend change is needed). A PDF that already has a
 * usable text layer is uploaded untouched so the server's zero-LLM extraction
 * still handles it.
 */
import {
  expandFiles,
  hasMeaningfulText,
  type UploadFile,
} from "./receiptPdfRasterize.shared";

export type { UploadFile } from "./receiptPdfRasterize.shared";

// A receipt is short; cap runaway multi-page scans so one giant PDF can't
// render hundreds of pages.
const MAX_PAGES = 10;
// Scale 2 keeps small print legible for OCR without ballooning the PNG.
const RENDER_SCALE = 2;

// CRITICAL: no `import.meta` may appear ANYWHERE in this file (not even inside
// a function that never runs, not even in a try/catch). Metro emits the web
// bundle as a classic script, so the token itself is a parse-time SyntaxError
// that kills the ENTIRE entry bundle — this is what actually white-screened
// publicworship.life/os (PRs #410/#415: the crash survived "lazy + caught"
// because nothing ever executed). The babel `strip-import-meta` plugin
// (babel.config.js) now scrubs the token from all bundled code as a backstop,
// but this file must not reintroduce the pattern.
//
// Worker strategy: instead of `GlobalWorkerOptions.workerSrc` (which needs a
// URL to a separate worker file — the thing that required `import.meta.url`),
// we lazily import the worker MODULE and hang it on `globalThis.pdfjsWorker`.
// pdfjs then takes its main-thread "fake worker" path (see PDFWorker
// `#mainThreadWorkerMessageHandler` in pdf.mjs) and never touches workerSrc.
// Main-thread rendering is fine here: receipts are capped at MAX_PAGES pages.
let pdfjsPromise: Promise<typeof import("pdfjs-dist")> | null = null;
function loadPdfjs(): Promise<typeof import("pdfjs-dist")> {
  if (!pdfjsPromise) {
    pdfjsPromise = Promise.all([
      import("pdfjs-dist"),
      import("pdfjs-dist/build/pdf.worker.min.mjs"),
    ]).then(([pdfjs, worker]) => {
      (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker;
      return pdfjs;
    });
  }
  return pdfjsPromise;
}

/**
 * Render a SCANNED PDF to one PNG `UploadFile` per page. Returns `null` when
 * the PDF has a usable text layer (digital — the server should read it) so the
 * caller uploads it untouched. Throws only on an unexpected pdfjs failure,
 * which `expandFiles` catches and degrades to uploading the original PDF.
 */
async function rasterizePdf(file: UploadFile): Promise<UploadFile[] | null> {
  const pdfjs = await loadPdfjs();
  const buf = await file.blob.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
  try {
    // Text-layer probe: if ANY page (up to the cap) carries meaningful text,
    // treat the whole document as digital and leave it for the server.
    let combined = "";
    const probePages = Math.min(pdf.numPages, MAX_PAGES);
    for (let i = 1; i <= probePages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      combined +=
        " " +
        content.items.map((it) => ("str" in it ? it.str : "")).join(" ");
      if (hasMeaningfulText(combined)) return null;
    }

    // Scanned: render each page to a PNG.
    const pageCount = Math.min(pdf.numPages, MAX_PAGES);
    const base = file.name.replace(/\.pdf$/i, "") || "receipt";
    const out: UploadFile[] = [];
    for (let i = 1; i <= pageCount; i++) {
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: RENDER_SCALE });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      await page.render({ canvasContext: ctx, viewport }).promise;
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob((b) => resolve(b), "image/png"),
      );
      if (!blob) return null;
      out.push({
        blob,
        contentType: "image/png",
        name: pageCount === 1 ? `${base}.png` : `${base} (p${i}).png`,
      });
    }
    return out.length > 0 ? out : null;
  } finally {
    void pdf.destroy();
  }
}

/** Swap each scanned PDF in `files` for its page images; leave digital PDFs
 *  and non-PDFs untouched. See `expandFiles` for the exact fallback policy. */
export function expandScannedPdfs(files: UploadFile[]): Promise<UploadFile[]> {
  return expandFiles(files, rasterizePdf);
}
