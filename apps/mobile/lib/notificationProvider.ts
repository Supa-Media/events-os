/**
 * `@supa-media/notifications` — gated, dynamically loaded.
 *
 * The package itself is plain JS, but it pulls `expo-notifications` and
 * `expo-device`, and Expo resolves a native module at module scope. The root
 * layout mounts `NotificationProvider` above everything, so with a static
 * import that resolution happens as the bundle loads, before React mounts —
 * where nothing can catch a throw, and expo-updates' ErrorRecovery turns it
 * into a native abort at launch.
 *
 * Push is a FEATURE. A build that lacks the native modules for it should run
 * without push, not fail to start. Every native build of this app shares one
 * runtime version deliberately (see CLAUDE.md), so an OTA reaches binaries
 * older than any given dependency — which makes "the app still starts without
 * this" the requirement for anything that isn't structural.
 *
 * Same shape as `cameraScanning.ts` and `clipboard.ts`: a runtime `require`
 * through a `const` (which Metro still constant-folds into a real dependency,
 * so the module IS bundled and push works wherever it exists — it is simply
 * never EVALUATED until this function runs), inside a try/catch, cached, and
 * `null` when the module isn't there.
 *
 * No JSX in this file, deliberately: a `.tsx` here would pull NativeWind's jsx
 * runtime (and through it react-native) into the node test environment, which
 * has no RN component runtime. The root layout does the conditional render.
 */
import type { ComponentType, ReactNode } from "react";

type NotificationsPackage = typeof import("@supa-media/notifications");

/** The provider component, as the root layout needs to see it. */
export type NotificationProviderComponent = ComponentType<{
  children: ReactNode;
}>;

// Cached after the first attempt so a missing module doesn't pay the `require`
// cost, or re-log, on every render of the root layout.
let cached: NotificationProviderComponent | null | undefined;

/**
 * Resolve the real `NotificationProvider`, or `null` on a build whose native
 * side has no notification modules.
 */
export function loadNotificationProvider(): NotificationProviderComponent | null {
  if (cached !== undefined) return cached;
  try {
    const moduleName = "@supa-media/notifications";
    const mod = require(moduleName) as NotificationsPackage;
    cached = mod.NotificationProvider as NotificationProviderComponent;
  } catch {
    cached = null;
  }
  return cached;
}

/** Drop the memoized module. Tests only — production resolves exactly once. */
export function resetNotificationProviderForTest(): void {
  cached = undefined;
}
