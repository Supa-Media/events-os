/**
 * Bridge file for the platform-split native-PDF pane. Metro/Webpack resolve
 * `.web.tsx` / `.native.tsx` by platform automatically; this bare `.tsx` is
 * what TypeScript resolves for the extensionless import in `FileViewer.tsx`
 * (mirrors `components/email/EmailHtmlPreview.tsx`'s own bridge doc).
 *
 * WHY THE SPLIT: `react-native-webview` needs a real split even though it's
 * a "core" dep (installed on every platform) — see
 * `EmailHtmlPreview.native.tsx` / `MarkdownEditor.native.tsx` for the same
 * precedent. `FileViewer.tsx` itself is a single shared file (web + native),
 * so the WebView import has to live behind this seam rather than at its top
 * level, the same reason `pdfPages.ts` / `pdfPages.web.ts` keep `pdfjs-dist`
 * (browser-only) out of the native bundle.
 *
 * On web this branch is unreachable in practice (`supportsInlinePdf` is
 * `true` there, so `FileViewer` never renders it), but the bare specifier
 * still has to resolve to SOMETHING for the web bundle — `.web.tsx` renders
 * the same `Unrenderable` state `FileViewer` used to show for every PDF on
 * native, kept as a defensive fallback rather than assuming the branch is
 * truly dead.
 */
export type NativePdfPaneProps = {
  uri: string;
  filename?: string | null;
};

export { NativePdfPane as default, NativePdfPane } from "./NativePdfPane.native";
