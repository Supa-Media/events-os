/**
 * `react-native-keyboard-controller` — gated, dynamically loaded.
 *
 * Reached from the root layout (`KeyboardProvider`) and from `Screen`, which
 * `components/ui`'s barrel re-exports — so a static import is evaluated on
 * every launch, before React mounts, where a missing native module's throw
 * cannot be caught and expo-updates turns it into an abort.
 *
 * Keyboard avoidance is an ENHANCEMENT: without it a form still renders and
 * still scrolls, the keyboard just may cover a field. That is the test for
 * whether something belongs in `gated` — see CLAUDE.md.
 *
 * Callers don't use this directly; they render
 * `components/ui/KeyboardAwareScroll`, which falls back to a plain
 * `ScrollView`. This module is the resolution half, kept JSX-free so it stays
 * importable from the node test environment.
 */
import type { ComponentType, ReactNode } from "react";

type KeyboardControllerModule = typeof import("react-native-keyboard-controller");

type Loaded = {
  KeyboardProvider: ComponentType<{ children: ReactNode }>;
  KeyboardAwareScrollView: ComponentType<Record<string, unknown>>;
};

let cached: Loaded | null | undefined;

/** Resolve the module, or `null` when this build has no keyboard native module. */
export function loadKeyboardController(): Loaded | null {
  if (cached !== undefined) return cached;
  try {
    const moduleName = "react-native-keyboard-controller";
    const mod = require(moduleName) as KeyboardControllerModule;
    cached = {
      KeyboardProvider: mod.KeyboardProvider as ComponentType<{
        children: ReactNode;
      }>,
      KeyboardAwareScrollView: mod.KeyboardAwareScrollView as ComponentType<
        Record<string, unknown>
      >,
    };
  } catch {
    cached = null;
  }
  return cached;
}

/** Drop the memoized module. Tests only — production resolves exactly once. */
export function resetKeyboardControllerForTest(): void {
  cached = undefined;
}
