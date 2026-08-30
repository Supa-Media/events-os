/**
 * `core` in native-deps.json is a claim about the SHIPPED BINARIES, and this
 * test makes changing it deliberate.
 *
 * Every native build of this app shares one runtime version (`policy:
 * "appVersion"` with a static `version`), on purpose: an OTA update reaches
 * every installed binary rather than only the ones built since a dependency
 * landed. The gate against a newer bundle crashing an older binary is
 * therefore in JS — a native module that might not be present is resolved at
 * runtime and falls back when it isn't there. That is what `gated` means, and
 * `@supa-media/testing`'s `nativeImports` check enforces it by refusing static
 * imports of anything on that list.
 *
 * What that check CANNOT catch is the classification itself. `core` is exempt
 * from it, so putting a brand-new dependency there silently opts out of the
 * whole mechanism — and a brand-new dependency is, by definition, absent from
 * every binary already on someone's phone. That is not hypothetical: #806
 * added `expo-clipboard` as `core` on 2026-08-28, statically imported from
 * `lib/clipboard.ts`, reached through `components/ui`'s barrel by every
 * screen. The OTA published on that merge threw as the bundle loaded on any
 * older binary, before React mounted, and expo-updates' ErrorRecovery turned
 * that into a native abort — TestFlight 1.0.0 build 8, crashing on
 * 2026-08-30, with a report whose frames were all `ErrorRecovery.crash()` and
 * no mention of a clipboard anywhere.
 *
 * So the rule is: **a native dependency added after the current baseline build
 * goes in `gated`, always.** It graduates to `core` only once a native build
 * containing it is the oldest binary in the field — which is a release
 * decision, not a code-review one. Editing the list below is how you record
 * having made it.
 *
 * UPSTREAM CANDIDATE: this is generic, and belongs beside `nativeImports` in
 * `@supa-media/testing` rather than here. It is local because the app took a
 * production crash from the gap and should not wait on a framework release; if
 * this graduates upstream, delete this file.
 */
const fs = require("fs");
const path = require("path");

/**
 * The native modules present in the baseline binary — the oldest build we
 * expect an OTA to reach. Sorted, and compared exactly.
 *
 * Last reviewed 2026-08-30. This repo's history begins 2026-08-14, so it
 * cannot date anything older than that on its own — entries here are the
 * modules judged structural (the app cannot start without them), not a
 * verified inventory of any particular binary. Anything a build could
 * plausibly run WITHOUT belongs in `gated` instead, and `expo-notifications`
 * / `expo-device` moved there for exactly that reason: push is a feature, and
 * a build lacking it must still start.
 */
const BASELINE_CORE = [
  "@expo/metro-runtime",
  "@expo/vector-icons",
  "@react-native-community/netinfo",
  "expo",
  "expo-constants",
  "expo-font",
  "expo-image-picker",
  "expo-linking",
  "expo-router",
  "expo-secure-store",
  "expo-splash-screen",
  "expo-status-bar",
  "expo-updates",
  "react-native",
  "react-native-css-interop",
  "react-native-gesture-handler",
  "react-native-keyboard-controller",
  "react-native-reanimated",
  "react-native-safe-area-context",
  "react-native-screens",
  "react-native-web",
  "react-native-webview",
  "react-native-worklets",
];

const nativeDeps = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "native-deps.json"), "utf8"),
);

describe("native-deps.json baseline", () => {
  it("lists exactly the modules the baseline binary is known to have as `core`", () => {
    expect([...nativeDeps.core].sort()).toEqual(BASELINE_CORE);
  });

  it("classifies every module exactly once", () => {
    const all = [...nativeDeps.core, ...nativeDeps.gated];
    expect(new Set(all).size).toBe(all.length);
  });

  it("keeps `gated` non-empty", () => {
    // Not a style rule — an empty `gated` list would mean the whole mechanism
    // is switched off, which is the state this app was in when it crashed.
    expect(nativeDeps.gated.length).toBeGreaterThan(0);
  });
});
