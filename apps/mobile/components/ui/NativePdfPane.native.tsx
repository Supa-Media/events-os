/**
 * Native PDF pane — a `react-native-webview` instead of the canvas-rasterized
 * paging `PdfPane` in `FileViewer.tsx` uses on web (`pdfjs-dist` needs a DOM
 * canvas that doesn't exist on native — see `lib/pdfPages.native.ts`... i.e.
 * the plain `lib/pdfPages.ts` stub, `supportsInlinePdf = false`).
 *
 * This used to be `FileViewer`'s `Unrenderable` state ("PDFs open outside the
 * app here") for every native PDF — correct as far as it went, but the spec
 * this pane ships for is explicit: "whether it's PDF, whether it's an image"
 * has to render INLINE on the coding workbench panel, and `react-native-webview`
 * was already an installed, unused dependency for exactly this.
 *
 * iOS: WKWebView (what `react-native-webview` wraps there) renders a PDF
 * given directly as `source.uri` — no extra plumbing.
 * Android: Chromium WebView does NOT render PDFs from a raw URL; it downloads
 * instead of displaying. Routed through Google's public viewer
 * (`docs.google.com/gview`) instead, the standard RN workaround — it fetches
 * `uri` itself and renders the pages inside the WebView. This requires `uri`
 * to be reachable without extra auth headers, which a Convex storage URL is
 * (`ctx.storage.getUrl()` returns a signed, headerless-GET URL).
 *
 * NEEDS DEVICE VERIFICATION — no simulator/automation here can load a real
 * network PDF into a WebView. Confirm on both platforms, and confirm the
 * Google Docs viewer path specifically on Android (it depends on Google's
 * service reaching the storage URL from wherever the device is).
 */
import { Platform, View } from "react-native";
import { WebView } from "react-native-webview";
import type { NativePdfPaneProps } from "./NativePdfPane";

export function NativePdfPane({ uri }: NativePdfPaneProps) {
  const source =
    Platform.OS === "android"
      ? `https://docs.google.com/gview?embedded=true&url=${encodeURIComponent(uri)}`
      : uri;

  return (
    <View style={{ flex: 1, backgroundColor: "#fff" }}>
      <WebView source={{ uri: source }} originWhitelist={["*"]} />
    </View>
  );
}
