/**
 * Native preview: hosts the rendered campaign HTML in a `react-native-webview`
 * (same hosting technique as `MarkdownEditor.native.tsx`, minus the RN<->WebView
 * message bridge — this is read-only, so a plain `source={{ html }}` is enough).
 */
import { Text, View } from "react-native";
import { loadWebView } from "../../lib/nativeWebView";
import type { EmailHtmlPreviewProps } from "./EmailHtmlPreview";

/** What `height="auto"` means here: the web variant measures the document and
 *  grows to fit it, which needs script access to the frame. This WebView runs
 *  with `javaScriptEnabled={false}` on purpose (see below), so native gives a
 *  tall pane that scrolls internally rather than re-enabling script execution
 *  inside untrusted author HTML for a layout nicety. */
const NATIVE_AUTO_HEIGHT = 720;

export function EmailHtmlPreview({ html, height = 560 }: EmailHtmlPreviewProps) {
  const boxHeight = height === "auto" ? NATIVE_AUTO_HEIGHT : height;
  // No WebView on this build (see `lib/nativeWebView.ts`). There is no honest
  // way to render author HTML without it — showing the raw markup would be
  // worse than saying so — and this is a preview of something the sender can
  // still send, so it degrades to a notice rather than blocking the screen.
  const webView = loadWebView();
  if (!webView) {
    return (
      <View
        className="items-center justify-center rounded-lg border border-border bg-raised px-6"
        style={{ height: boxHeight }}
      >
        <Text className="text-center text-xs text-muted">
          The preview needs a newer version of the app. Everything else about
          this email works as normal.
        </Text>
      </View>
    );
  }
  const { WebView } = webView;
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
