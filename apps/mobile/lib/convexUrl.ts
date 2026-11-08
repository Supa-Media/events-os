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

/**
 * Keep everyone signed in across the switch to the proxy URL.
 *
 * @convex-dev/auth stores its tokens under keys namespaced by the client's
 * ADDRESS (`__convexAuthJWT_<address with non-alphanumerics stripped>`), so
 * changing the address from `…convex.cloud` to `…/os/_convex` would orphan
 * every stored session and sign every web user out once. This storage
 * rewrites the namespace back to the configured deployment URL's, so the
 * proxied client reads and writes the very same keys the direct one did.
 *
 * Local, not upstream: `SupaConvexProvider` (@supa-media/core) takes a
 * `storage` but not a `storageNamespace`, and adding one means a framework
 * release this change shouldn't wait on. If it grows that prop, pass the
 * configured URL as the namespace and delete this.
 *
 * `undefined` (use the provider's default storage) whenever the address
 * isn't rewritten — native, dev, previews.
 */
export function sessionPreservingStorage(configured: string | undefined) {
  const resolved = resolveConvexUrl(configured);
  if (!configured || resolved === configured || !resolved) return undefined;
  const escape = (s: string) => s.replace(/[^a-zA-Z0-9]/g, "");
  const from = `_${escape(resolved)}`;
  const to = `_${escape(configured)}`;
  const map = (key: string) => (key.endsWith(from) ? key.slice(0, -from.length) + to : key);
  return {
    getItem: (key: string) => window.localStorage.getItem(map(key)),
    setItem: (key: string, value: string) => window.localStorage.setItem(map(key), value),
    removeItem: (key: string) => window.localStorage.removeItem(map(key)),
  };
}
