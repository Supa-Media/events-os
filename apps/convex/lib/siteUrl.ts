/**
 * Base URL for guest-facing links: landing pages, ticket pages, OG tags,
 * Stripe return URLs, and emails. Set PUBLIC_SITE_URL (e.g.
 * https://publicworship.life) when a custom domain fronts the
 * deployment's HTTP actions; otherwise the built-in .convex.site domain
 * (CONVEX_SITE_URL) is used.
 */
export function siteUrl(): string {
  const base = process.env.PUBLIC_SITE_URL ?? process.env.CONVEX_SITE_URL ?? "";
  return base.replace(/\/+$/, "");
}

/**
 * URL path segment for public RSVP pages — the guest-facing event page, renamed
 * to the "RSVP page" (Events-director vocabulary). Now "rsvp" (e.g.
 * publicworship.life/rsvp/<slug>). The older "/event/" and "/e/" prefixes are
 * kept as aliases in http.ts so already-shared links never break.
 */
export const RSVP_PATH = "rsvp";

/**
 * Relative path of a public RSVP page (or a sub-resource like "cover" /
 * "calendar.ics"). For pure renderers (e.g. landingPage.ts) that receive the
 * base URL as a parameter and can't call `siteUrl()` themselves — they compose
 * `${siteUrl}${rsvpPath(slug, sub)}`.
 */
export function rsvpPath(slug: string, sub?: string): string {
  return `/${RSVP_PATH}/${slug}${sub ? `/${sub}` : ""}`;
}

/** Absolute URL of a public RSVP page (or a sub-resource). */
export function rsvpPageUrl(slug: string, sub?: string): string {
  return `${siteUrl()}${rsvpPath(slug, sub)}`;
}

/**
 * URL path segment for the public giving map (F-6 P3, docs/plans/
 * giving-platform.md §5): `/give` is the map, `/give/<slug>` a city campaign
 * page.
 */
export const GIVE_PATH = "give";

/** Relative path of the public giving map, or one city's campaign page. */
export function givePagePath(slug?: string): string {
  return slug ? `/${GIVE_PATH}/${slug}` : `/${GIVE_PATH}`;
}

/** Absolute URL of the public giving map, or one city's campaign page. */
export function givePageUrl(slug?: string): string {
  return `${siteUrl()}${givePagePath(slug)}`;
}

/**
 * Deep link into the authenticated app (the Expo web build) at `path`, when
 * APP_URL is configured. Null otherwise — callers omit the link entirely
 * rather than sending a dead one. In prod, APP_URL is
 * https://publicworship.life/os — the Cloudflare Worker routes that prefix
 * (stripped) to the Expo web app's EAS Hosting origin; see
 * docs/plans/url-consolidation.md.
 */
export function appUrl(path: string): string | null {
  const base = process.env.APP_URL?.replace(/\/+$/, "");
  return base ? `${base}${path}` : null;
}
