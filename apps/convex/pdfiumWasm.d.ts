/**
 * The base64-encoded PDFium wasm binary `@hyzyla/pdfium` ships as a plain JS
 * chunk (its filename is content-hashed by the package's own build, which is
 * why the dependency is pinned EXACTLY in package.json — see
 * `receiptPdf.ts#initPdfiumLibrary`). The package publishes no types for the
 * hashed path, so this declaration provides the one export we consume.
 */
declare module "@hyzyla/pdfium/dist/pdfium.wasm.base64-B4io7kt4.js" {
  export const PDFIUM_WASM_BASE64: string;
}
