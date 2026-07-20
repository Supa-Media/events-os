import { Platform } from "react-native";

/**
 * The Expo web app's base path once the Cloudflare Worker fronts
 * https://publicworship.life and proxies `/os/*` (prefix stripped) to this
 * app's EAS Hosting origin (events-os.expo.app) — see
 * docs/plans/url-consolidation.md. Every hand-built absolute web URL
 * (`window.location.origin + "/some/path"`) must re-add this prefix or it'll
 * 404 through the worker.
 *
 * Mirrored (not imported — `app.config.js` is plain CommonJS, not run through
 * the TS/Babel pipeline) as `experiments.baseUrl` in `app.config.js`, which is
 * how expo-router learns the base path for its OWN routing (internal
 * `<Link>`/`router.push` need no changes — that's handled automatically).
 * Keep both values in sync if this ever changes.
 */
export const APP_BASE_PATH = "/os";

/**
 * Absolute web URL for an in-app `path` (must start with "/"), correctly
 * prefixed with `APP_BASE_PATH` so it resolves through the Cloudflare Worker
 * at https://publicworship.life instead of 404ing. Web only — call only
 * behind a `Platform.OS === "web"` check; native has no "current origin" and
 * should build a deep link with `Linking.createURL` (the `eventsos://`
 * scheme) instead, which is unaffected by the web base path.
 */
export function webAppUrl(path: string): string {
  const origin =
    Platform.OS === "web" && typeof window !== "undefined"
      ? window.location.origin
      : "";
  return `${origin}${APP_BASE_PATH}${path}`;
}
