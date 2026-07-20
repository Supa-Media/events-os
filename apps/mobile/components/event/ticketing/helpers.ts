/**
 * Shared helpers for the admin Tickets tab — money formatting, the public
 * site URL, and the cross-platform confirm dialog (Alert on native, DOM
 * confirm on web — mirrors event/[id].tsx's confirmDelete).
 */
import { Alert, Platform } from "react-native";

/** Production Convex deployment (see reference_convex-prod-deploy-target). */
const PROD_CONVEX_DEPLOYMENT = "vivid-rhinoceros-688";
/** Branded consolidated domain fronting prod's public RSVP pages (Convex
 *  serves /rsvp, /r, /event, /e, /t, /give, /p, /reimburse, /api, /stripe,
 *  /increase behind the Cloudflare Worker at the apex — see
 *  docs/plans/url-consolidation.md). */
const PROD_SITE_URL = "https://publicworship.life";

/**
 * Pure resolver for the public-page base URL — kept separate from `publicSiteUrl`
 * so it's unit-testable (babel-preset-expo inlines `EXPO_PUBLIC_*` at build time,
 * so the reader below can't be exercised with test-time env). Precedence:
 *   1. `siteUrl` (EXPO_PUBLIC_SITE_URL) — explicit override wins, always.
 *   2. Prod: when pointed at the prod Convex deployment, the branded domain —
 *      so the prod build is branded WITHOUT needing EXPO_PUBLIC_SITE_URL set.
 *   3. Other cloud deployments: swap `.convex.cloud` → `.convex.site`.
 *   4. Local backend: http routes serve on the next port up (3210 → 3211).
 */
export function resolvePublicSiteUrl(
  siteUrl: string,
  convexUrl: string,
): string {
  const custom = siteUrl.replace(/\/+$/, "");
  if (custom) return custom;
  const url = convexUrl.replace(/\/+$/, "");
  if (url.includes(PROD_CONVEX_DEPLOYMENT)) return PROD_SITE_URL;
  if (url.includes(".convex.cloud")) {
    return url.replace(".convex.cloud", ".convex.site");
  }
  const withPort = url.match(/^(.*):(\d+)$/);
  if (withPort) return `${withPort[1]}:${Number(withPort[2]) + 1}`;
  return url;
}

/**
 * Base URL of the public event pages (served from Convex http routes). Reads
 * the (build-time-inlined) Expo env and delegates to `resolvePublicSiteUrl`.
 */
export function publicSiteUrl(): string {
  return resolvePublicSiteUrl(
    process.env.EXPO_PUBLIC_SITE_URL ?? "",
    process.env.EXPO_PUBLIC_CONVEX_URL ?? "",
  );
}

/**
 * Absolute URL of an event's public RSVP page on the branded domain (or the
 * Convex fallback). The canonical path segment is `/rsvp/`; the `/r/` short
 * form and the pre-rename `/event/` + `/e/` prefixes are kept as aliases
 * server-side so already-shared links never break.
 */
export function rsvpPageUrl(slug: string): string {
  return `${publicSiteUrl()}/rsvp/${slug}`;
}

/** Integer cents → "$12" / "$12.50". */
export function formatMoney(cents: number): string {
  const dollars = cents / 100;
  return cents % 100 === 0 ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

/** Ticket price label — free tiers read "Free" instead of "$0". */
export function formatPrice(cents: number): string {
  return cents === 0 ? "Free" : formatMoney(cents);
}

/** Dollar input ("12", "$12.50") → integer cents, or null when unparsable. */
export function parseDollars(input: string): number | null {
  const trimmed = input.trim().replace(/^\$/, "");
  if (trimmed === "") return null;
  const n = Number(trimmed);
  if (Number.isNaN(n) || n < 0) return null;
  return Math.round(n * 100);
}

/** Cross-platform confirm: window.confirm on web, Alert.alert on native. */
export function confirmAction({
  title,
  message,
  confirmLabel,
  onConfirm,
  destructive = false,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  destructive?: boolean;
}): void {
  if (Platform.OS === "web") {
    if (
      typeof window !== "undefined" &&
      window.confirm(`${title}\n\n${message}`)
    ) {
      onConfirm();
    }
    return;
  }
  Alert.alert(title, message, [
    { text: "Cancel", style: "cancel" },
    {
      text: confirmLabel,
      style: destructive ? "destructive" : "default",
      onPress: onConfirm,
    },
  ]);
}
