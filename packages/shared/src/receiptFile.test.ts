/**
 * The ONE receipt-file detector. Each block below pins a bug that one of the
 * five detectors this replaced actually shipped — see `receiptFile.ts`'s
 * module doc for the inventory.
 */
import { describe, expect, test } from "vitest";
import {
  isPdfReceiptFile,
  receiptFileKind,
  receiptRendersAsImage,
} from "./receiptFile";

describe("receiptFileKind — content type is the primary signal", () => {
  test("a PDF with NO filename is still a PDF", () => {
    // THE `attachReceipt` BUG: the busiest upload path stored no filename, so
    // the filename-only detector said "not a PDF" and `<Image>` drew a blank.
    expect(receiptFileKind({ contentType: "application/pdf", filename: null })).toBe("pdf");
  });

  test("images by content type, with or without a name", () => {
    expect(receiptFileKind({ contentType: "image/jpeg" })).toBe("image");
    expect(receiptFileKind({ contentType: "image/heic", filename: null })).toBe("image");
    expect(receiptFileKind({ contentType: "IMAGE/PNG" })).toBe("image");
  });

  test("charset parameters are stripped before matching", () => {
    expect(receiptFileKind({ contentType: "text/html;charset=utf-8" })).toBe("document");
    expect(receiptFileKind({ contentType: "application/pdf; qs=0.001" })).toBe("pdf");
  });

  test("an emailed HTML/plain body is a document", () => {
    expect(
      receiptFileKind({ contentType: "text/html;charset=utf-8", filename: "email body" }),
    ).toBe("document");
    expect(receiptFileKind({ contentType: "text/plain", filename: "text message" })).toBe(
      "document",
    );
  });

  test("an unrecognised but INFORMATIVE content type is a document, not an image", () => {
    expect(receiptFileKind({ contentType: "application/msword" })).toBe("document");
  });
});

describe("receiptFileKind — filename is the fallback, never the URL", () => {
  test("octet-stream falls through to the extension", () => {
    // A browser that gave us no `File.type`; the client posts octet-stream.
    expect(
      receiptFileKind({ contentType: "application/octet-stream", filename: "invoice.pdf" }),
    ).toBe("pdf");
    expect(
      receiptFileKind({ contentType: "application/octet-stream", filename: "IMG_0421.HEIC" }),
    ).toBe("image");
  });

  test("no content type at all still routes on the extension", () => {
    expect(receiptFileKind({ contentType: null, filename: "receipt.pdf" })).toBe("pdf");
    expect(receiptFileKind({ filename: "scan.jpeg" })).toBe("image");
    expect(receiptFileKind({ filename: "forwarded.eml" })).toBe("document");
  });

  test("'pdf' appearing anywhere but the extension does not count", () => {
    // The old `name.includes(".pdf")` rule matched all of these.
    expect(receiptFileKind({ filename: "pdf-scan-notes.txt" })).toBe("document");
    expect(receiptFileKind({ filename: "my.pdf.jpg" })).toBe("image");
    expect(receiptFileKind({ filename: "pdf" })).toBe("unknown");
  });

  test("a Convex storage URL carries no extension — nothing here reads one", () => {
    // THE `ReceiptExceptionSection` BUG: `url.includes(".pdf")` could never
    // fire, because a storage URL looks like this. The detector takes no URL
    // at all, so the bug is now unrepresentable.
    const hints = { contentType: null, filename: null };
    expect(receiptFileKind(hints)).toBe("unknown");
  });
});

describe("receiptFileKind — unknown is a real answer", () => {
  test("nothing known at all is 'unknown', never a wrong guess", () => {
    expect(receiptFileKind({})).toBe("unknown");
    expect(receiptFileKind({ contentType: "", filename: "" })).toBe("unknown");
    expect(receiptFileKind({ contentType: "application/octet-stream", filename: "scan" })).toBe(
      "unknown",
    );
  });

  test("unknown renders optimistically as an image", () => {
    expect(receiptRendersAsImage({ contentType: null, filename: null })).toBe(true);
    expect(receiptRendersAsImage({ contentType: "image/png" })).toBe(true);
    expect(receiptRendersAsImage({ contentType: "application/pdf" })).toBe(false);
    expect(receiptRendersAsImage({ contentType: "text/html" })).toBe(false);
    expect(receiptRendersAsImage("unknown")).toBe(true);
    expect(receiptRendersAsImage("pdf")).toBe(false);
  });
});

describe("isPdfReceiptFile — the server's routing question", () => {
  test("matches the old isPdfContentType behaviour, both ways round", () => {
    expect(isPdfReceiptFile({ contentType: "application/pdf", filename: "a.pdf" })).toBe(true);
    expect(isPdfReceiptFile({ contentType: "application/pdf", filename: undefined })).toBe(true);
    // A mail client that mislabels the attachment: the extension saves it.
    expect(isPdfReceiptFile({ contentType: "application/octet-stream", filename: "a.pdf" })).toBe(
      true,
    );
    expect(isPdfReceiptFile({ contentType: "image/png", filename: "a.png" })).toBe(false);
  });

  test("a mislabelled `text/html` attachment named .pdf is NOT forced to PDF", () => {
    // Content type wins when it is informative: an emailed HTML body saved as
    // "receipt.pdf" is still an HTML body, and the text route reads it.
    expect(isPdfReceiptFile({ contentType: "text/html", filename: "receipt.pdf" })).toBe(false);
  });
});
