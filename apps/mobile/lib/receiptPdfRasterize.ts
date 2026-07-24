/**
 * Scanned-PDF → image rasterization — NATIVE stub.
 *
 * Rasterization runs entirely in `pdfjs-dist`, a browser-only library that
 * needs a DOM canvas. Metro resolves `receiptPdfRasterize.web.ts` for the web
 * bundle (the real flow) and THIS file for native, so `pdfjs-dist` never lands
 * in the native bundle (same split as `fcClient.ts`). It's never actually
 * reached on native: the native image pickers can't select a PDF, so there's
 * nothing to rasterize — this just passes every file through untouched.
 */
import type { UploadFile } from "./receiptPdfRasterize.shared";

export type { UploadFile } from "./receiptPdfRasterize.shared";

/** No-op on native: nothing to rasterize (PDFs can't be picked here). */
export function expandScannedPdfs(files: UploadFile[]): Promise<UploadFile[]> {
  return Promise.resolve(files);
}
