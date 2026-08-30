/**
 * Native PDF pane — a `react-native-webview` instead of the canvas-rasterized
 * paging `PdfPane` in `FileViewer.tsx` uses on web (`pdfjs-dist` needs a DOM
 * canvas that doesn't exist on native — see `lib/pdfPages.ts`'s stub,
 * `supportsInlinePdf = false`).
 *
 * This used to be `FileViewer`'s `Unrenderable` state ("PDFs open outside the
 * app here") for every native PDF. iOS gets a real inline fix: WKWebView
 * (what `react-native-webview` wraps there) renders a PDF given directly as
 * `source.uri` — first-party, no third party ever sees the file.
 *
 * ANDROID DELIBERATELY STAYS "OPEN" INSTEAD OF INLINE. Chromium WebView does
 * not render PDFs from a raw URL, and the standard RN workaround for that —
 * routing the URL through Google's public viewer
 * (`docs.google.com/gview?url=...`) — was rejected here on review: a
 * `transactions` receipt is the org's financial document, and
 * `ctx.storage.getUrl()` returns a PERMANENT, UNAUTHENTICATED URL (it never
 * rotates or expires). Handing that URL to `docs.google.com` means Google's
 * own servers fetch, render, and can log or cache the org's receipts —
 * indefinitely, on a link anyone who ever captured it could also replay. That
 * is a real privacy exposure for a feature that only needed to save a tap.
 * `Linking.openURL` hands the SAME file to the device's own PDF viewer
 * instead — no network hop through a third party, nothing to leak.
 *
 * `originWhitelist` on the iOS WebView is narrowed to the URI's own origin
 * (not `"*"`) — the loaded document should never be able to navigate this
 * WebView to an arbitrary site.
 *
 * NEEDS DEVICE VERIFICATION — no simulator/automation here can load a real
 * network PDF into a WebView; confirm the iOS inline render on a real device.
 */
import { Linking, Platform, Pressable, Text, View } from "react-native";
import { loadWebView } from "../../lib/webView";
import { Icon } from "./Icon";
import { colors } from "../../lib/theme";
import type { NativePdfPaneProps } from "./NativePdfPane";

/** `scheme://host[:port]` off a URL, without relying on the global `URL`
 *  constructor (not reliably available in every RN/Hermes configuration).
 *  Falls back to the whole URI if it doesn't parse as one — `originWhitelist`
 *  then just narrows to that exact string, never widening to `"*"`. */
function originOf(uri: string): string {
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]+)/.exec(uri);
  return m ? m[1] : uri;
}

export function NativePdfPane({ uri, filename }: NativePdfPaneProps) {
  // `null` on a build whose native side has no web view — see `lib/webView.ts`.
  // Falls through to the same "open it outside the app" pane Android uses, so
  // the file is still reachable, just not inline.
  const WebView = loadWebView();

  if (Platform.OS === "android" || !WebView) {
    return (
      <View className="h-full w-full items-center justify-center gap-2 px-8">
        <Icon name="file-text" size={26} color={colors.faint} />
        <Text className="text-center text-sm font-semibold text-ink">
          {filename ?? "This PDF"}
        </Text>
        <Text className="text-center text-xs text-muted">
          Opens in your phone&apos;s own PDF viewer — this file never leaves
          the device to render it.
        </Text>
        <Pressable
          onPress={() => void Linking.openURL(uri)}
          accessibilityRole="button"
          accessibilityLabel="Open this PDF"
          className="mt-2 flex-row items-center gap-1.5 rounded-md border border-border-strong px-3 py-2 active:opacity-70"
        >
          <Icon name="external-link" size={15} color={colors.ink} />
          <Text className="text-sm font-semibold text-ink">Open this PDF</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: "#fff" }}>
      <WebView source={{ uri }} originWhitelist={[originOf(uri)]} />
    </View>
  );
}
