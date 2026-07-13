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
 * Deep link into the authenticated app (the Expo web build) at `path`, when
 * APP_URL is configured. Null otherwise — callers omit the link entirely
 * rather than sending a dead one.
 */
export function appUrl(path: string): string | null {
  const base = process.env.APP_URL?.replace(/\/+$/, "");
  return base ? `${base}${path}` : null;
}
