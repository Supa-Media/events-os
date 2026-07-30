/**
 * Shared type + default export for the platform-split email HTML preview.
 *
 * The real implementations live in:
 *   - EmailHtmlPreview.web.tsx     (a sandboxed `<iframe srcDoc>`, per
 *     `components/crew/BriefingView.tsx`'s video-embed iframe precedent)
 *   - EmailHtmlPreview.native.tsx  (a `react-native-webview`, per
 *     `MarkdownEditor.native.tsx`'s WebView-hosting precedent)
 *
 * Metro/Webpack resolve `.web.tsx` / `.native.tsx` by platform automatically;
 * this bare `.tsx` is what TypeScript resolves for an extensionless import,
 * so it must export the same shape both variants do (mirrors
 * `markdown/MarkdownEditor.tsx`'s bridge file).
 */
export type EmailHtmlPreviewProps = {
  /** Full send-ready HTML — the designer passes `renderCampaignEmail(doc, …)`. */
  html: string;
  /**
   * Preview box height in px, or `"auto"` to fit the rendered document so the
   * WHOLE email is visible in the page instead of a scrolling sliver of it
   * (founder bug, 2026-07-30 — see `EmailHtmlPreview.web.tsx`'s module doc).
   * Defaults to a tall-ish reading pane.
   *
   * `"auto"` is measured for real on web only; the native WebView runs with
   * JavaScript disabled by design, and measuring its content would mean
   * re-enabling script execution inside untrusted author HTML for a layout
   * nicety. Native treats `"auto"` as a tall fixed pane that scrolls
   * internally (`EmailHtmlPreview.native.tsx`).
   */
  height?: number | "auto";
};

export { EmailHtmlPreview as default, EmailHtmlPreview } from "./EmailHtmlPreview.native";
