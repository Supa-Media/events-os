/**
 * Web preview: a sandboxed `<iframe srcDoc>` — RN-web renders `<iframe>`
 * directly in the DOM (same technique as `BriefingView`'s video embed). The
 * campaign HTML is fully self-contained (inlined styles, no external
 * resources besides the recipient's own images), so `srcDoc` alone renders it
 * faithfully with no extra plumbing.
 */
import { View } from "react-native";
import { colors } from "../../lib/theme";
import type { EmailHtmlPreviewProps } from "./EmailHtmlPreview";

export function EmailHtmlPreview({ html, height = 560 }: EmailHtmlPreviewProps) {
  return (
    <View
      className="overflow-hidden rounded-lg border border-border bg-raised"
      style={{ height }}
    >
      <iframe
        srcDoc={html}
        title="Email preview"
        // No same-origin/scripts — this is untrusted-ish author content
        // (merge tags, pasted markdown) rendered for a live preview only.
        sandbox=""
        style={{ width: "100%", height: "100%", border: "0", backgroundColor: colors.raised }}
      />
    </View>
  );
}

export default EmailHtmlPreview;
