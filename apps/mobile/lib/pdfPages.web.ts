/**
 * PDF → page images, WEB implementation.
 *
 * Metro resolves this `.web.ts` for the web bundle; `pdfPages.ts` (a throwing
 * stub with `supportsInlinePdf = false`) is what native gets, so `pdfjs-dist`
 * never lands in the native bundle.
 *
 * WHY THIS EXISTS AT ALL: the receipt viewer must render a PDF *itself*, in
 * the same zoomable pane it renders a photo in, page by page. Handing the URL
 * to an `<iframe>` (what the old lightbox did) delegates to the browser's PDF
 * plugin instead: a different set of controls, its own toolbar, a full reload
 * every time the modal mounts, and no relationship to the app's own zoom. The
 * owner's report — "PDF views not reloading, having to open up in another
 * site" — is that seam. Rendering to a bitmap makes a PDF page and a receipt
 * photo literally the same thing to everything above this file.
 *
 * `pdfjs-dist` was ALREADY a direct dependency of this package (it powered the
 * client-side scanned-PDF rasterizer this PR deletes), so the viewer adds no
 * new dependency to the mobile graph — which matters here: see CLAUDE.md on
 * how a dependency change can break native rendering.
 *
 * CRITICAL: no `import.meta` may appear ANYWHERE in this file — not inside a
 * function that never runs, not in a try/catch. Metro emits the web bundle as
 * a classic script, so the token itself is a parse-time SyntaxError that kills
 * the ENTIRE entry bundle (this is what white-screened publicworship.life/os
 * in PRs #410/#415). The worker is loaded as a MODULE hung on
 * `globalThis.pdfjsWorker` so pdfjs takes its main-thread "fake worker" path
 * and never touches `workerSrc` (which is what needed `import.meta.url`).
 */
import type { PDFDocumentProxy } from "pdfjs-dist";
import {
  documentsToEvict,
  pageCacheKey,
  renderScaleForZoom,
  type PdfPage,
  type PdfPageRenderer,
} from "./pdfPages.shared";

export type { PdfPage } from "./pdfPages.shared";

/** True on web: there is a canvas, so a PDF renders inline like any photo. */
export const supportsInlinePdf = true;

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

type CachedDocument = {
  doc: Promise<PDFDocumentProxy>;
  /** Rendered bitmaps by `pageCacheKey(page, scale)` → object URL. */
  pages: Map<string, Promise<PdfPage>>;
  touchedAt: number;
};

/** Resident documents, keyed by file URL. Bounded by `MAX_CACHED_DOCUMENTS`
 *  (see `pdfPages.shared.ts` for why this cache is the whole point). */
const documents = new Map<string, CachedDocument>();

function evictIfNeeded(): void {
  const stale = documentsToEvict(
    [...documents.entries()].map(([url, d]) => ({ url, at: d.touchedAt })),
  );
  for (const url of stale) releasePdf(url);
}

/** Drop one document and every bitmap rendered from it. Object URLs are
 *  revoked HERE and nowhere else — a call site that revoked its own would
 *  break every other pane still showing that page. */
export function releasePdf(url: string): void {
  const cached = documents.get(url);
  if (!cached) return;
  documents.delete(url);
  for (const page of cached.pages.values()) {
    void page.then((p) => URL.revokeObjectURL(p.uri)).catch(() => {});
  }
  void cached.doc.then((d) => d.destroy()).catch(() => {});
}

function openDocument(url: string): CachedDocument {
  const existing = documents.get(url);
  if (existing) {
    existing.touchedAt = Date.now();
    return existing;
  }
  const doc = loadPdfjs()
    .then((pdfjs) => pdfjs.getDocument({ url }).promise)
    .catch((err: unknown) => {
      // A failed open must not poison the cache — the next attempt should be
      // allowed to try again (a transient network failure is the common case).
      documents.delete(url);
      throw err;
    });
  const entry: CachedDocument = { doc, pages: new Map(), touchedAt: Date.now() };
  documents.set(url, entry);
  evictIfNeeded();
  return entry;
}

/**
 * Render one page of `url` at a bitmap scale chosen from `zoom`, returning an
 * object URL plus the document's page count. Repeat calls for the same
 * (url, page, scale) return the SAME promise — paging back and forth, or
 * closing and re-opening the viewer, costs nothing after the first render.
 */
export const renderPdfPage: PdfPageRenderer = async (url, pageNumber, zoom) => {
  const entry = openDocument(url);
  entry.touchedAt = Date.now();
  const scale = renderScaleForZoom(zoom);
  const key = pageCacheKey(pageNumber, scale);

  const cached = entry.pages.get(key);
  if (cached) return cached;

  const rendering = (async (): Promise<PdfPage> => {
    const pdf = await entry.doc;
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("No 2D canvas context available.");
    await page.render({ canvasContext: ctx, viewport }).promise;
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), "image/png"),
    );
    if (!blob) throw new Error("The PDF page could not be turned into an image.");
    return {
      uri: URL.createObjectURL(blob),
      pageCount: pdf.numPages,
      width: canvas.width,
      height: canvas.height,
    };
  })();

  // Cache the PROMISE, not the result: two panes opening the same page at once
  // must share one render rather than racing two.
  entry.pages.set(key, rendering);
  rendering.catch(() => entry.pages.delete(key));
  return rendering;
};
