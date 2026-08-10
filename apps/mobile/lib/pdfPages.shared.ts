/**
 * PDF page rendering — the PURE, platform-neutral parts.
 *
 * Kept import-free (no pdfjs, no DOM) so jest can exercise the cache policy
 * and the render-scale rule directly, the way `receiptPdfRasterize.shared.ts`
 * used to for the upload path this replaced.
 */

/** One rendered page, ready to hand to `<Image source={{ uri }}>`. */
export type PdfPage = {
  /** An object URL for the rendered bitmap. Owned by the cache — never revoke
   *  it at a call site; `releasePdf` does that on eviction. */
  uri: string;
  /** How many pages the document has in total (so the viewer can page). */
  pageCount: number;
  /** Pixel size of the rendered bitmap, for the viewer's aspect ratio. */
  width: number;
  height: number;
};

export type PdfPageRenderer = (url: string, pageNumber: number, zoom: number) => Promise<PdfPage>;

/**
 * How many documents stay resident. THE POINT of this cache is the owner's
 * actual complaint — "PDF views not reloading", and reviewing twenty charges
 * in five minutes rather than forty. Re-opening a receipt you looked at thirty
 * seconds ago must not re-download and re-parse the PDF, and paging to page 2
 * must not re-open the document.
 *
 * Three is deliberate: a reviewer bounces between a handful of charges, not
 * hundreds, and each resident document holds its rendered page bitmaps.
 */
export const MAX_CACHED_DOCUMENTS = 3;

/**
 * Render scale for a page bitmap, given the viewer's current zoom.
 *
 * Two buckets, not a continuous function: re-rendering a PDF page costs real
 * milliseconds, so zooming must not re-render on every step. 2× is plenty for
 * a receipt at fit-to-window through 2× zoom; past that the bitmap would go
 * visibly soft, so we re-render once at 4× and stay there.
 */
export const RENDER_SCALE_BASE = 2;
export const RENDER_SCALE_HI = 4;

export function renderScaleForZoom(zoom: number): number {
  return zoom > 2 ? RENDER_SCALE_HI : RENDER_SCALE_BASE;
}

/** The cache key for one rendered bitmap: a page at a render scale. */
export function pageCacheKey(pageNumber: number, scale: number): string {
  return `${pageNumber}@${scale}`;
}

/**
 * Which documents to evict, oldest-touched first, to get back under the cap.
 * Pure so the policy is testable without a browser.
 */
export function documentsToEvict(
  lastTouched: { url: string; at: number }[],
  max: number = MAX_CACHED_DOCUMENTS,
): string[] {
  if (lastTouched.length <= max) return [];
  return [...lastTouched]
    .sort((a, b) => a.at - b.at)
    .slice(0, lastTouched.length - max)
    .map((d) => d.url);
}

/** Clamp a requested page into `[1, pageCount]` — the viewer's ‹/› buttons and
 *  arrow keys both go through this, so neither can run off either end. */
export function clampPage(page: number, pageCount: number): number {
  if (!Number.isFinite(page) || pageCount < 1) return 1;
  return Math.min(Math.max(Math.round(page), 1), pageCount);
}

/** The zoom ladder the +/− controls step through. Fit (1) first, so "reset"
 *  is always exactly the first rung. */
export const ZOOM_STEPS = [1, 1.5, 2, 3, 4, 6, 8] as const;

// Widened to `number` deliberately: `as const` above makes these literal `1`
// and `8`, which would infect every `useState`/setter that starts from them.
export const MIN_ZOOM: number = ZOOM_STEPS[0];
export const MAX_ZOOM: number = ZOOM_STEPS[ZOOM_STEPS.length - 1];

/** Next rung up/down the ladder from an arbitrary current zoom (wheel-zoom
 *  produces values between rungs, so this can't be an index lookup). */
export function stepZoom(current: number, direction: 1 | -1): number {
  if (direction === 1) {
    return ZOOM_STEPS.find((z) => z > current + 1e-6) ?? MAX_ZOOM;
  }
  return [...ZOOM_STEPS].reverse().find((z) => z < current - 1e-6) ?? MIN_ZOOM;
}

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return MIN_ZOOM;
  return Math.min(Math.max(zoom, MIN_ZOOM), MAX_ZOOM);
}
