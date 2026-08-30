/**
 * `react-native-webview` — gated, dynamically loaded.
 *
 * The web view is reached from `components/ui`'s barrel (FileViewer →
 * NativePdfPane), and that barrel is imported by `(app)/_layout.tsx` for
 * `AppShell` — so a static import here is evaluated as the bundle loads, on
 * every launch, whether or not anyone opens a PDF. Expo/RN resolve a native
 * module at module scope, so on a build without it that throw happens before
 * React mounts, where nothing can catch it.
 *
 * Inline PDF rendering is a nicety with an existing fallback (the same
 * "open in your phone's own PDF viewer" path Android already takes), so this
 * is exactly the kind of module that must never be able to stop the app
 * starting. Same shape as `cameraScanning.ts` / `clipboard.ts`.
 */
type WebViewModule = typeof import("react-native-webview");

/** The real component type, so call sites keep full prop and ref typing. */
export type GatedWebView = WebViewModule["WebView"];

/** The instance a `ref` yields — for callers that drive it imperatively. */
export type GatedWebViewInstance = InstanceType<GatedWebView>;

/** The `onMessage` event, for the editor's RN <-> page bridge. */
export type GatedWebViewMessageEvent = Parameters<
  NonNullable<GatedWebViewInstance["props"]["onMessage"]>
>[0];

let cached: GatedWebView | null | undefined;

/** Resolve `WebView`, or `null` when this build has no web view native module. */
export function loadWebView(): GatedWebView | null {
  if (cached !== undefined) return cached;
  try {
    const moduleName = "react-native-webview";
    const mod = require(moduleName) as WebViewModule;
    cached = mod.WebView;
  } catch {
    cached = null;
  }
  return cached;
}

/** Drop the memoized module. Tests only — production resolves exactly once. */
export function resetWebViewForTest(): void {
  cached = undefined;
}
