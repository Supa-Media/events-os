/**
 * react-native-webview — gated, dynamically loaded (classified `"gated"` in
 * native-deps.json). Mirrors `lib/cameraScanning.ts` exactly; read that file's
 * header for the convention, and this one for why WebView specifically had to
 * join it.
 *
 * WHY THIS EXISTS. `runtimeVersion` here is `{ policy: "appVersion" }` and
 * `version` has been `"1.0.0"` since the repo was scaffolded, so every binary
 * and every OTA bundle share the runtime version `"1.0.0"` — EAS Update treats
 * them all as interchangeable even when EAS's own native fingerprints differ.
 * That is deliberate: one JS bundle serving clients on several binaries is what
 * lets an update reach everyone without a reinstall. The price is that a JS
 * bundle may land on a binary that lacks a native module it imports.
 *
 * `react-native-webview` was added 2026-06-14 at 23:57, ~5 hours AFTER the last
 * iOS binary of that day was built, and was classified `core` — a claim that
 * every installed binary already had it, when none did. It is statically
 * imported by three components, so the bundle failed to load on that binary;
 * expo-updates ran its recovery tasks, exhausted them, and aborted the process.
 * That is the TestFlight 1.0.0 (8) crash of 2026-08-15: SIGABRT 0.4s after
 * launch, in `ErrorRecovery.crash()`, naming nothing about WebView.
 *
 * `core` is a claim about BINARIES IN THE FIELD, not about package.json. A new
 * native dependency starts here, gated, and only graduates to `core` once a
 * binary containing it is the oldest one still being served.
 *
 * Every consumer must go through `loadWebView()` and render something useful
 * when it returns `null` — never a static module reference, and never a
 * top-level type import either. The guardrail's scan is TEXTUAL, so even a
 * type-only reference trips it, and so does spelling the import out in a
 * comment (this header did, and the check caught itself). That is why the
 * types below use an inline `typeof import(…)` query instead.
 */
import type { ComponentType, Ref } from "react";

type WebViewModule = typeof import("react-native-webview");

/** The `onMessage` event, re-exported so consumers need no static import. */
export type WebViewMessageEvent = Parameters<
  NonNullable<
    InstanceType<WebViewModule["WebView"]>["props"]["onMessage"]
  >
>[0];

/** The WebView instance type, for the `ref` the Markdown editor holds. */
export type WebViewInstance = InstanceType<WebViewModule["WebView"]>;

/** The subset of the module this app actually uses. */
export interface NativeWebViewModule {
  WebView: ComponentType<
    InstanceType<WebViewModule["WebView"]>["props"] & {
      ref?: Ref<WebViewInstance>;
    }
  >;
}

// Cached after the first resolution attempt so a missing module doesn't pay the
// `require` cost (or log noise) on every render.
let cached: NativeWebViewModule | null | undefined;

/**
 * Resolve `react-native-webview`'s `WebView`, or `null` if the native module
 * isn't present on this build/platform. Safe to call from a component body
 * (cheap after the first call).
 */
export function loadWebView(): NativeWebViewModule | null {
  if (cached !== undefined) return cached;
  try {
    const moduleName = "react-native-webview";
    const mod = require(moduleName) as WebViewModule;
    cached = { WebView: mod.WebView as NativeWebViewModule["WebView"] };
  } catch {
    cached = null;
  }
  return cached;
}
