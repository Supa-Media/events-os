/**
 * RECEIPT FILE KIND — the ONE answer to "how do I render/read this file?".
 *
 * A receipt document is a photo, a PDF, or a text document (a forwarded email
 * body). Every surface that shows one has to branch on that: an `<Image>`
 * renders nothing at all for `application/pdf` or `text/html`, and an
 * OCR pipeline routes a PDF through its text layer rather than a vision call.
 *
 * This used to be answered FIVE different ways, each with a different bug:
 *
 *   1. `receiptsTab/helpers.ts#isPdfReceipt(filename)` — `/\.pdf$/i` on the
 *      FILENAME only. `finances.attachReceipt` (the busiest upload path: the
 *      "Attached" chip's own uploader, used from Reconcile, Transaction
 *      Detail, My Transactions and the Money view) stored NO filename at all,
 *      so every PDF uploaded there answered "not a PDF" and was handed to
 *      `<Image>`, which drew a blank box.
 *   2. `receiptsTab/helpers.ts#isDocumentReceipt(contentType)` — `text/*`
 *      only, so it could never recognise a PDF and had to be paired with (1).
 *   3. `myTransactions/receiptSuggestions.ts#looksLikeDocument` — content type
 *      if present, else `.pdf` anywhere in `filename + url`.
 *   4. `reconcile/ReceiptExceptionSection.tsx` — `url.includes(".pdf")`
 *      inline. This one could NEVER fire: a Convex storage URL is
 *      `.../api/storage/<uuid>` with no extension anywhere in it, so
 *      receipt-exception evidence that was a PDF rendered as a blank box, 100%
 *      of the time.
 *   5. `receiptInbox.ts#isPdfContentType` — the server's own copy.
 *
 * ONE function replaces all five. Order of evidence, most reliable first:
 *
 *   a. The STORED CONTENT TYPE. Convex records this on `_storage` from the
 *      upload's `Content-Type` header for every file, on every path, and every
 *      receipt query already surfaces it (`receipts.ts#receiptSummary`). This
 *      is the signal that actually exists for ~all rows.
 *   b. The FILENAME extension — the fallback for the one case (a) can't
 *      answer: a browser that handed us no `File.type` and a client that
 *      posted `application/octet-stream`, or a mail client that mislabels an
 *      attachment.
 *   c. `"unknown"` — say so, and let the caller render optimistically and
 *      fail visibly, rather than guessing wrong and drawing an empty frame.
 *
 * Deliberately NOT the URL: it carries no extension (see 4 above).
 */

/** How a stored receipt file should be rendered / read. */
export type ReceiptFileKind = "image" | "pdf" | "document" | "unknown";

/** Everything known about a stored file, from the receipt row itself. Both
 *  fields are optional because both are genuinely absent on some rows. */
export type ReceiptFileHints = {
  contentType?: string | null;
  filename?: string | null;
};

/** `image/jpeg; charset=binary` → `image/jpeg`. */
function normalizeContentType(contentType: string | null | undefined): string {
  return (contentType ?? "").split(";")[0].trim().toLowerCase();
}

/** The lowercased extension including the dot (`".pdf"`), or `""`. */
function extensionOf(filename: string | null | undefined): string {
  const name = (filename ?? "").trim().toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot);
}

const PDF_CONTENT_TYPES = new Set(["application/pdf", "application/x-pdf"]);

/** Content types that carry no information — a client that couldn't work out
 *  what it was posting. These fall through to the filename rather than being
 *  reported as a `document`. */
const UNINFORMATIVE_CONTENT_TYPES = new Set([
  "",
  "application/octet-stream",
  "binary/octet-stream",
  "application/binary",
  "content/unknown",
  "*/*",
]);

const IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".heic",
  ".heif",
  ".bmp",
  ".tif",
  ".tiff",
  ".avif",
]);

const DOCUMENT_EXTENSIONS = new Set([".html", ".htm", ".txt", ".eml", ".msg"]);

/**
 * The single receipt-file detector. See the module doc for why this order.
 *
 * Returns `"unknown"` rather than guessing when neither signal is present —
 * callers are expected to render optimistically and show a real failure state
 * (never a blank frame) if that doesn't work out.
 */
export function receiptFileKind(hints: ReceiptFileHints): ReceiptFileKind {
  const ct = normalizeContentType(hints.contentType);
  if (!UNINFORMATIVE_CONTENT_TYPES.has(ct)) {
    if (PDF_CONTENT_TYPES.has(ct)) return "pdf";
    if (ct.startsWith("image/")) return "image";
    if (ct !== "") return "document";
  }

  const ext = extensionOf(hints.filename);
  if (ext === ".pdf") return "pdf";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (DOCUMENT_EXTENSIONS.has(ext)) return "document";

  return "unknown";
}

/**
 * True iff this file is a PDF — the server's routing question ("text layer or
 * vision?"). Kept as a named helper because that call site reads better than a
 * `=== "pdf"` comparison, and because it makes the server's old
 * `isPdfContentType` a one-line swap.
 */
export function isPdfReceiptFile(hints: ReceiptFileHints): boolean {
  return receiptFileKind(hints) === "pdf";
}

/**
 * True iff a viewer should hand this to `<Image>`. `"unknown"` says YES: an
 * image decoder is the right optimistic guess (it is what almost every
 * unlabelled receipt turns out to be), and a decode failure is a visible,
 * recoverable state — whereas a document frame around a photo is a dead end.
 */
export function receiptRendersAsImage(hints: ReceiptFileKind | ReceiptFileHints): boolean {
  const kind = typeof hints === "string" ? hints : receiptFileKind(hints);
  return kind === "image" || kind === "unknown";
}
