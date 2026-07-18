/**
 * Base URL for guest-facing links: landing pages, ticket pages, OG tags,
 * Stripe return URLs, and emails. Set PUBLIC_SITE_URL (e.g.
 * https://rsvp.publicworship.life) when a custom domain fronts the
 * deployment's HTTP actions; otherwise the built-in .convex.site domain
 * (CONVEX_SITE_URL) is used.
 */
export function siteUrl(): string {
  const base = process.env.PUBLIC_SITE_URL ?? process.env.CONVEX_SITE_URL ?? "";
  return base.replace(/\/+$/, "");
}

/**
 * URL path segment for public event pages. Was "e"; now "event" for branding
 * (e.g. events.publicworship.life/event/<slug>). The old "/e/" prefix is kept
 * as an alias in http.ts so already-shared links never break.
 */
export const EVENT_PATH = "event";

/**
 * Relative path of a public event page (or a sub-resource like "cover" /
 * "calendar.ics"). For pure renderers (e.g. landingPage.ts) that receive the
 * base URL as a parameter and can't call `siteUrl()` themselves — they compose
 * `${siteUrl}${eventPath(slug, sub)}`.
 */
export function eventPath(slug: string, sub?: string): string {
  return `/${EVENT_PATH}/${slug}${sub ? `/${sub}` : ""}`;
}

/** Absolute URL of a public event page (or a sub-resource). */
export function eventPageUrl(slug: string, sub?: string): string {
  return `${siteUrl()}${eventPath(slug, sub)}`;
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
 * rather than sending a dead one.
 */
export function appUrl(path: string): string | null {
  const base = process.env.APP_URL?.replace(/\/+$/, "");
  return base ? `${base}${path}` : null;
}
