/**
 * The base64-encoded PDFium wasm binary `@hyzyla/pdfium` ships as a plain JS
 * chunk (its filename is content-hashed by the package's own build, which is
 * why the dependency is pinned EXACTLY in package.json — see
 * `receiptPdf.ts#initPdfiumLibrary`). The package publishes no types for the
 * hashed path, so this declaration provides the one export we consume.
 *
 * CONSUMED BY TWO PROGRAMS: the Convex tsconfig picks this up via its own
 * include sweep, but apps/mobile's typecheck ALSO compiles `receiptPdf.ts`
 * (reached through the generated api types) and only loads declaration files
 * its tsconfig names — hence the explicit `"../convex/pdfiumWasm.d.ts"` entry
 * in `apps/mobile/tsconfig.json`'s `include`. Removing either side breaks
 * the root `pnpm typecheck` while `npx convex typecheck` stays green.
 */
declare module "@hyzyla/pdfium/dist/pdfium.wasm.base64-B4io7kt4.js" {
  export const PDFIUM_WASM_BASE64: string;
}
