/**
 * expo-clipboard — gated, dynamically loaded (classified `"gated"` in
 * native-deps.json, per `@supa-media/testing`'s native-import guardrail).
 *
 * Every native build of this app shares one runtime version, deliberately: an
 * OTA update reaches EVERY installed binary, not just ones built since the
 * dependency landed. So a native module that isn't in the baseline build has
 * to be gated in JS, by availability at runtime — that is the whole contract
 * `native-deps.json` encodes, and `expo-camera` (see `cameraScanning.ts`) was
 * its first subject.
 *
 * This module is the second, and it is here because the first version of it
 * was NOT gated. `expo-clipboard` shipped on 2026-08-28 (#806) classified
 * `core`, statically imported here, and reached from `components/ui`'s barrel
 * via `CopyButton` — which every screen pulls in, so it evaluated during
 * startup. Expo resolves a native module at module scope, so on any binary
 * built before that date the import THREW as the bundle loaded: a fatal JS
 * error before React mounted, which expo-updates' ErrorRecovery escalates
 * into a native abort. What came back was a SIGABRT crash log whose frames
 * are all `ErrorRecovery.crash()`, with no mention of a clipboard anywhere
 * (TestFlight 1.0.0 build 8, crashing 2026-08-30).
 *
 * So: never a static module reference — not even a TYPE-ONLY one, which trips
 * the guardrail's text scan, hence the inline `typeof import(…)` below rather
 * than a top-level `import type`. The module name goes through a variable so
 * the bundler leaves the `require` alone, and a build without the module gets
 * `null` back instead of an exception.
 */
import { Platform } from "react-native";

type ExpoClipboardModule = typeof import("expo-clipboard");

/** The subset of the module this app actually uses. */
export interface ClipboardModule {
  setStringAsync: ExpoClipboardModule["setStringAsync"];
}

// Cached after the first resolution attempt so a missing module doesn't pay the
// `require` cost (or log noise) on every copy.
let cached: ClipboardModule | null | undefined;

/**
 * Resolve `expo-clipboard`'s `setStringAsync`, or `null` if the native module
 * isn't present on this build/platform. Exported for the test, which needs to
 * clear the cache between cases.
 */
export function loadClipboard(): ClipboardModule | null {
  if (cached !== undefined) return cached;
  try {
    const moduleName = "expo-clipboard";
    const mod = require(moduleName) as ExpoClipboardModule;
    cached = { setStringAsync: mod.setStringAsync };
  } catch {
    cached = null;
  }
  return cached;
}

/** Drop the memoized module. Tests only — production resolves exactly once. */
export function resetClipboardForTest(): void {
  cached = undefined;
}

/**
 * Copy text to the system clipboard, returning whether it succeeded.
 *
 * Web keeps using the browser Clipboard API on secure origins. Native delegates
 * to Expo's clipboard module when this build has it. Either path reports
 * failure rather than showing a confirmation for text that was not actually
 * copied — which is also what an older binary running newer JS gets, instead of
 * a crash: `CopyButton` simply doesn't flip to "Copied".
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (
      Platform.OS === "web" &&
      typeof navigator !== "undefined" &&
      navigator.clipboard?.writeText
    ) {
      await navigator.clipboard.writeText(text);
      return true;
    }

    if (Platform.OS !== "web") {
      const clipboard = loadClipboard();
      if (!clipboard) return false;
      await clipboard.setStringAsync(text);
      return true;
    }

    return false;
  } catch {
    return false;
  }
}
