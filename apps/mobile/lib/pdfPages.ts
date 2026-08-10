/**
 * PDF → page images, NATIVE stub.
 *
 * Metro resolves `pdfPages.web.ts` for the web bundle (the real pdfjs
 * renderer); this file is what native gets, so `pdfjs-dist` — a browser-only
 * library that needs a DOM canvas — never lands in the native bundle. Same
 * split the deleted `receiptPdfRasterize` pair used, and the same reason.
 *
 * On native `FileViewer` therefore shows its explicit "can't render this here"
 * state with an Open/Download action rather than a blank frame — see
 * `FileViewer.tsx`'s `PdfPane`. `supportsInlinePdf` is what it branches on, so
 * the fallback is chosen by a real capability flag rather than by catching a
 * failure after the fact.
 */
import type { PdfPage, PdfPageRenderer } from "./pdfPages.shared";

export type { PdfPage } from "./pdfPages.shared";

/** False on native: there is no canvas to render a PDF page into. */
export const supportsInlinePdf = false;

export const renderPdfPage: PdfPageRenderer = async (): Promise<PdfPage> => {
  throw new Error("Inline PDF rendering is web-only.");
};

/** No-op — nothing is cached on native because nothing is rendered. */
export function releasePdf(_url: string): void {}
