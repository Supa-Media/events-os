// The worker build has no bundled types; only its existence as a module
// matters — `receiptPdfRasterize.web.ts` assigns the whole module object to
// `globalThis.pdfjsWorker` so pdfjs runs its main-thread "fake worker" path.
declare module "pdfjs-dist/build/pdf.worker.min.mjs" {
  export const WorkerMessageHandler: unknown;
}
