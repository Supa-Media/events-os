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
  /** Preview box height (px). Defaults to a tall-ish reading pane. */
  height?: number;
};

export { EmailHtmlPreview as default, EmailHtmlPreview } from "./EmailHtmlPreview.native";
