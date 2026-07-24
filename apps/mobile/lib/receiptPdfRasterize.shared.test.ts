// No @types/jest / ambient globals configured for this package — import test
// globals explicitly from @jest/globals (the repo convention; see other tests).
import { describe, expect, jest, test } from "@jest/globals";
import { expandFiles, hasMeaningfulText, isPdf } from "./receiptPdfRasterize.shared";
import type { UploadFile } from "./receiptPdfRasterize.shared";

// A tiny fake Blob-ish is enough — expandFiles never touches blob bytes; the
// injected `rasterize` does. Cast keeps the shared type honest without a real
// Blob in the jest (node) environment.
function file(name: string, contentType: string): UploadFile {
  return { blob: { name } as unknown as Blob, contentType, name };
}
function png(name: string): UploadFile {
  return file(name, "image/png");
}

type Rasterize = (file: UploadFile) => Promise<UploadFile[] | null>;

describe("isPdf", () => {
  test("matches by content type or .pdf name; images never match", () => {
    expect(isPdf(file("a.pdf", "application/pdf"))).toBe(true);
    expect(isPdf(file("scan", "application/pdf"))).toBe(true); // no extension
    expect(isPdf(file("receipt.PDF", "application/octet-stream"))).toBe(true); // name only
    expect(isPdf(file("photo.jpg", "image/jpeg"))).toBe(false);
    expect(isPdf(file("photo.png", "image/png"))).toBe(false);
  });
});

describe("hasMeaningfulText", () => {
  test("real receipt text passes; whitespace/short/symbol noise fails", () => {
    expect(hasMeaningfulText("Givebutter, Inc. Total: $33.80 Wilmington DE")).toBe(true);
    expect(hasMeaningfulText("   \n  \t ")).toBe(false); // empty scan
    expect(hasMeaningfulText("$$$")).toBe(false); // too short + no alnum
    expect(hasMeaningfulText("•·—·—·—·—·—·—·—·—·—·—")).toBe(false); // long but no alnum
  });
});

describe("expandFiles", () => {
  test("non-PDFs pass straight through, never sent to rasterize", async () => {
    const rasterize = jest.fn<Rasterize>();
    const files = [png("a.png"), file("b.jpg", "image/jpeg")];
    const out = await expandFiles(files, rasterize);
    expect(out).toEqual(files);
    expect(rasterize).not.toHaveBeenCalled();
  });

  test("a scanned PDF is replaced by its rendered page images", async () => {
    const pages = [png("scan (p1).png"), png("scan (p2).png")];
    const rasterize = jest.fn<Rasterize>(async () => pages);
    const out = await expandFiles([file("scan.pdf", "application/pdf")], rasterize);
    expect(out).toEqual(pages);
    expect(rasterize).toHaveBeenCalledTimes(1);
  });

  test("a digital PDF (rasterize returns null) is uploaded untouched", async () => {
    const digital = file("invoice.pdf", "application/pdf");
    const rasterize = jest.fn<Rasterize>(async () => null);
    const out = await expandFiles([digital], rasterize);
    expect(out).toEqual([digital]);
  });

  test("a rasterize that throws degrades to the original PDF — file is never dropped", async () => {
    const scanned = file("broken.pdf", "application/pdf");
    const rasterize = jest.fn<Rasterize>(async () => {
      throw new Error("pdfjs blew up");
    });
    const out = await expandFiles([scanned], rasterize);
    expect(out).toEqual([scanned]);
  });

  test("mixed batch: images pass, scanned PDF expands, digital PDF stays — order preserved", async () => {
    const img = png("a.png");
    const scanned = file("scan.pdf", "application/pdf");
    const digital = file("inv.pdf", "application/pdf");
    const scannedPages = [png("scan.png")];
    const rasterize = jest.fn<Rasterize>(async (f) =>
      f.name === "scan.pdf" ? scannedPages : null,
    );
    const out = await expandFiles([img, scanned, digital], rasterize);
    expect(out).toEqual([img, ...scannedPages, digital]);
  });
});
