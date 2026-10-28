/**
 * RSVP page presentation options an organizer can pick in the Design phase:
 * the big-title font and a short list of extra links (a questionnaire, a
 * sign-up form, a playlist).
 *
 * The title font is stored as one of a fixed set of IDs, never a free-text
 * CSS string, for the same reason as `emailFont.ts`: "valid" stays a plain
 * set-membership check, and the actual stack is looked up here by both the
 * server-rendered page and the editor's preview.
 */

export const RSVP_TITLE_FONT_IDS = ["classic", "sans", "helvetica"] as const;
export type RsvpTitleFontId = (typeof RSVP_TITLE_FONT_IDS)[number];

export const DEFAULT_RSVP_TITLE_FONT: RsvpTitleFontId = "classic";

export type RsvpTitleFont = {
  id: RsvpTitleFontId;
  label: string;
  /** CSS `font-family` stack for the public page. */
  family: string;
  /** CSS `font-weight` for the public page. */
  weight: number;
  /** CSS `letter-spacing` for the public page. */
  letterSpacing: string;
};

export const RSVP_TITLE_FONTS: Record<RsvpTitleFontId, RsvpTitleFont> = {
  // Corben, the brand display face. What every page used before the option.
  classic: {
    id: "classic",
    label: "Classic",
    family: "'Corben',Georgia,serif",
    weight: 700,
    letterSpacing: "-.01em",
  },
  // DM Sans, the face the tagline and body already use, set heavier.
  sans: {
    id: "sans",
    label: "Bold sans",
    family: "'DM Sans',-apple-system,'Segoe UI',sans-serif",
    weight: 800,
    letterSpacing: "-.025em",
  },
  // A system font, so it needs no web-font load. Arial stands in on Windows.
  helvetica: {
    id: "helvetica",
    label: "Helvetica",
    family: "'Helvetica Neue',Helvetica,Arial,sans-serif",
    weight: 700,
    letterSpacing: "-.02em",
  },
};

/** The font for a stored value, falling back to the default for unset/unknown. */
export function rsvpTitleFont(id: string | null | undefined): RsvpTitleFont {
  return (
    RSVP_TITLE_FONTS[(id ?? DEFAULT_RSVP_TITLE_FONT) as RsvpTitleFontId] ??
    RSVP_TITLE_FONTS[DEFAULT_RSVP_TITLE_FONT]
  );
}

// ── Page links ───────────────────────────────────────────────────────────────

export const RSVP_PAGE_LINKS_MAX = 6;
export const RSVP_PAGE_LINK_LABEL_MAX = 80;
const URL_MAX = 2000;

export type RsvpPageLink = { label: string; url: string };

/**
 * Normalize an organizer-typed link to an absolute http(s) URL, or null when
 * it isn't one. A bare domain ("forms.gle/abc") gets `https://`. Any other
 * scheme (`javascript:`, `data:`, `mailto:`) is rejected, because the result
 * goes straight into an `href` on a public page.
 */
export function normalizeRsvpPageLinkUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > URL_MAX || /\s/.test(trimmed)) return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed);
  if (hasScheme && !/^https?:\/\//i.test(trimmed)) return null;
  const candidate = hasScheme ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  // Needs a real-looking host: "localhost" or a dotted name.
  if (!parsed.hostname.includes(".") && parsed.hostname !== "localhost") {
    return null;
  }
  return candidate;
}

/** The host shown under a link's label ("forms.gle"), without `www.`. */
export function rsvpPageLinkHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
