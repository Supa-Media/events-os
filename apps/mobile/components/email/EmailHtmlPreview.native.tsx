/**
 * Native preview: hosts the rendered campaign HTML in a `react-native-webview`
 * (same hosting technique as `MarkdownEditor.native.tsx`, minus the RN<->WebView
 * message bridge — this is read-only, so a plain `source={{ html }}` is enough).
 */
import { View } from "react-native";
import { WebView } from "react-native-webview";
import type { EmailHtmlPreviewProps } from "./EmailHtmlPreview";

export function EmailHtmlPreview({ html, height = 560 }: EmailHtmlPreviewProps) {
  return (
    <View
      className="overflow-hidden rounded-lg border border-border bg-raised"
      style={{ height }}
    >
      <WebView
        originWhitelist={["*"]}
        source={{ html }}
        scrollEnabled
        style={{ backgroundColor: "transparent" }}
      />
    </View>
  );
}

export default EmailHtmlPreview;
