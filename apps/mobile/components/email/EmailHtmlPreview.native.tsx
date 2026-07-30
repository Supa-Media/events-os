/**
 * Native preview: hosts the rendered campaign HTML in a `react-native-webview`
 * (same hosting technique as `MarkdownEditor.native.tsx`, minus the RN<->WebView
 * message bridge — this is read-only, so a plain `source={{ html }}` is enough).
 */
import { View } from "react-native";
import { WebView } from "react-native-webview";
import type { EmailHtmlPreviewProps } from "./EmailHtmlPreview";

/** What `height="auto"` means here: the web variant measures the document and
 *  grows to fit it, which needs script access to the frame. This WebView runs
 *  with `javaScriptEnabled={false}` on purpose (see below), so native gives a
 *  tall pane that scrolls internally rather than re-enabling script execution
 *  inside untrusted author HTML for a layout nicety. */
const NATIVE_AUTO_HEIGHT = 720;

export function EmailHtmlPreview({ html, height = 560 }: EmailHtmlPreviewProps) {
  const boxHeight = height === "auto" ? NATIVE_AUTO_HEIGHT : height;
  return (
    <View
      className="overflow-hidden rounded-lg border border-border bg-raised"
      style={{ height: boxHeight }}
    >
      <WebView
        originWhitelist={["*"]}
        source={{ html }}
        scrollEnabled
        // The preview is always static HTML (never fetched, never expects a
        // page script) — disabling JS closes off the native equivalent of
        // the web variant's sandboxed iframe (`EmailHtmlPreview.web.tsx`'s
        // `sandbox=""`), so a malicious/compromised author-written merge
        // tag or pasted markdown can't execute script inside the WebView.
        javaScriptEnabled={false}
        style={{ backgroundColor: "transparent" }}
      />
    </View>
  );
}

export default EmailHtmlPreview;
