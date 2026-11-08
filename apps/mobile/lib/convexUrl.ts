/**
 * Which address the app's Convex client talks to.
 *
 * Native, local dev and any preview host: the configured deployment URL
 * (`*.convex.cloud`), unchanged.
 *
 * The production web app on publicworship.life: the SAME deployment, reached
 * through our own domain at `/os/_convex` — pw-router proxies it, WebSocket
 * upgrade included (infra/router/src/route.ts, CONVEX_PROXY_PATH). On Dev2's
 * iPhone (2026-11-08) the app loaded but its live connection to
 * *.convex.cloud never opened on that network, so it sat on "Checking your
 * sign-in…" indefinitely. A same-origin connection can't be singled out by a
 * network filter or content blocker that refuses a third-party host.
 *
 * Kept in sync with route.ts's CONVEX_PROXY_PATH by
 * infra/router/src/drift.test.ts.
 */
import { Platform } from "react-native";
import { APP_BASE_PATH } from "./appUrl";

export const CONVEX_PROXY_PATH = "/_convex";

/** The host the router fronts. Anything else (localhost, events-os.expo.app
 *  previews) has no proxy in front of it and talks to Convex directly. */
const PROXIED_HOST = "publicworship.life";

export function resolveConvexUrl(configured: string | undefined): string | undefined {
  if (Platform.OS !== "web" || typeof window === "undefined") return configured;
  const { hostname, origin } = window.location;
  if (hostname !== PROXIED_HOST) return configured;
  return `${origin}${APP_BASE_PATH}${CONVEX_PROXY_PATH}`;
}
