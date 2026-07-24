/**
 * Scanned-PDF → image rasterization — PURE, platform-neutral orchestration.
 *
 * The pdfjs/DOM-canvas work lives in `receiptPdfRasterize.web.ts` (web only —
 * pdfjs needs a browser canvas). This file holds the parts worth unit-testing
 * with no browser: which files are PDFs, whether a PDF's text is "meaningful"
 * enough that the server can read it directly, and the per-file swap/fallback
 * loop. Kept import-free (no pdfjs, no DOM) so jest can exercise it directly.
 */

/** One file queued for upload — matches `UploadZone`/`ReceiptViewerModal`'s
 *  own `{ blob, contentType, name }` shape (the header of the generate-url →
 *  POST → storageId dance every upload surface uses). */
export type UploadFile = { blob: Blob; contentType: string; name: string };

/** A file is a PDF by its content type OR its filename — web file inputs
 *  usually set `application/pdf`, but a stray upload with only a `.pdf` name
 *  still routes correctly. */
export function isPdf(file: UploadFile): boolean {
  return file.contentType === "application/pdf" || /\.pdf$/i.test(file.name);
}

/**
 * Mirrors the server's `receiptInbox.ts#isMeaningfulPdfText`: enough real text
 * that the backend's zero-LLM text-layer extractor will read the total, so we
 * must NOT rasterize (rasterizing a digital PDF would needlessly turn free,
 * whole-document text into an image OCR). Same 20-char / >30%-alphanumeric bar
 * so client and server agree on "digital vs scanned."
 */
export function hasMeaningfulText(text: string): boolean {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length < 20) return false;
  const alnum = (collapsed.match(/[a-zA-Z0-9]/g) ?? []).length;
  return alnum / collapsed.length > 0.3;
}

/**
 * Swap each SCANNED PDF for its rendered page images; pass everything else
 * through untouched. `rasterize` returns the page images for a scanned PDF, or
 * `null` for a digital PDF (has a text layer — let the server read it). A
 * non-PDF, a digital PDF, or a rasterize that throws all fall through to the
 * ORIGINAL file, so the server always receives something — worst case it shows
 * its own "re-upload as a photo" guidance. Never drops a file.
 */
export async function expandFiles(
  files: UploadFile[],
  rasterize: (file: UploadFile) => Promise<UploadFile[] | null>,
): Promise<UploadFile[]> {
  const out: UploadFile[] = [];
  for (const file of files) {
    if (!isPdf(file)) {
      out.push(file);
      continue;
    }
    try {
      const images = await rasterize(file);
      if (images && images.length > 0) out.push(...images);
      else out.push(file); // digital PDF (text layer) → server reads it directly
    } catch {
      out.push(file); // rendering failed → let the server try / guide the user
    }
  }
  return out;
}
