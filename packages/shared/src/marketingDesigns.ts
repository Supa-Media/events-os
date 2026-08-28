/**
 * THE BRAND KIT AND THE DESIGN LIBRARY — the Marketing desk's Designs tab.
 *
 * Four things, and they are four because a marketer looking for them is asking
 * four different questions:
 *
 *   COLORS   `BrandColor` — the hexes, with names and a note on where each is
 *            used. Answers "what red is our red?"
 *   FONTS    `BrandFont` — the faces and what each is for. Answers "what do I
 *            set a headline in?"
 *   FOLDERS  `DesignFolder` — the marketer's own filing ("Instagram posts",
 *            "Event flyers"). One level deep, deliberately (see below).
 *   DESIGNS  `DesignAsset` — a Canva or Figma link, or an uploaded image.
 *            Answers "where's the template for this?"
 *
 * ── Reading this is ungated. That is the feature ────────────────────────────
 * `marketing.designs.edit` has no `view` sibling. The Academy's own brand
 * lesson is the argument: "Nobody should have to ask permission to look
 * right." A chapter volunteer making a flyer at 11pm needs the hex code and the
 * logo, and a brand kit behind a permission is a brand kit people work around —
 * which is the exact inconsistency it exists to prevent.
 *
 * ── Why folders are one level deep ──────────────────────────────────────────
 * Same rule `serviceOptions` settled on, for the same reason: a row may point
 * at a parent, but a row that HAS a parent may never itself be a parent. Two
 * levels covers "Instagram posts / Stories" and stops before the point where
 * somebody has to remember which of four nested folders a flyer went in. A
 * tree is a filing system nobody else can navigate; a shelf is one anybody can.
 *
 * ── The Canva CDN trap, written down because it already bit this repo ───────
 * `emailHtmlImport.ts` exists partly because `*.canva-cdn.email` image URLs
 * EXPIRE — pasted newsletter designs went blank weeks later and had to be
 * re-hosted. So a design's `url` is its Canva/Figma EDIT-or-SHARE link (stable,
 * and where a human actually wants to land), and its thumbnail is always an
 * upload we host. Never store a CDN preview URL as the thumbnail; it will die
 * quietly and the library will fill with grey boxes.
 */

// ── Colors ───────────────────────────────────────────────────────────────────

/** One color in the brand kit. */
export interface BrandColor {
  id: string;
  /** What the team calls it — "PW Red". */
  name: string;
  /** `#rrggbb`, lowercased. Validated on write by `isBrandHex`. */
  hex: string;
  /** Where it's used, in a sentence. The half people actually need. */
  usage: string | null;
  order: number;
}

export const BRAND_COLOR_NAME_MAX = 40;
export const BRAND_COLOR_USAGE_MAX = 200;
export const BRAND_COLOR_MAX_COUNT = 24;

/**
 * Whether a string is a color the kit will store: `#rgb` or `#rrggbb`, nothing
 * else.
 *
 * Deliberately NOT accepting `rgb()`, `hsl()`, or a named color. A brand kit's
 * whole job is that two people typing the same color get the same bytes, and
 * the moment three notations are allowed, `#891d1a`, `rgb(137,29,26)` and
 * `maroon` become three entries for one color.
 */
export function isBrandHex(value: string): boolean {
  return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value.trim());
}

/** Canonical storage form: lowercased, `#rgb` expanded to `#rrggbb`, so two
 *  spellings of one color compare equal. */
export function normalizeBrandHex(value: string): string {
  const v = value.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(v)) {
    return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  }
  return v;
}

// ── Fonts ────────────────────────────────────────────────────────────────────

/**
 * What a face is FOR. The roles are a fixed list because the useful question is
 * "what do I set a headline in?", which a free-text label answers badly — three
 * people write "headings", "Headings", and "titles" and the kit stops sorting.
 */
export const BRAND_FONT_ROLES = [
  "headline",
  "body",
  "caption",
  "accent",
] as const;
export type BrandFontRole = (typeof BRAND_FONT_ROLES)[number];

export const BRAND_FONT_ROLE_LABELS: Record<BrandFontRole, string> = {
  headline: "Headlines",
  body: "Body text",
  caption: "Captions",
  accent: "Supporting / accent",
};

/** One typeface in the brand kit. */
export interface BrandFont {
  id: string;
  /** The face's real name — "Times New Roman Condensed". */
  name: string;
  role: BrandFontRole;
  /** Where to get it, if it isn't already on everyone's machine. */
  sourceUrl: string | null;
  /** Anything a person needs to know before using it. */
  notes: string | null;
  order: number;
}

export const BRAND_FONT_NAME_MAX = 60;
export const BRAND_FONT_NOTES_MAX = 200;
export const BRAND_FONT_MAX_COUNT = 12;

// ── Folders ──────────────────────────────────────────────────────────────────

/** One shelf in the library. `parentId` null = a top-level folder. */
export interface DesignFolder {
  id: string;
  name: string;
  parentId: string | null;
  order: number;
  /** How many designs sit directly in it — so the list can say so without the
   *  caller counting. */
  designCount: number;
}

export const DESIGN_FOLDER_NAME_MAX = 50;
export const DESIGN_FOLDER_MAX_COUNT = 60;

// ── Designs ──────────────────────────────────────────────────────────────────

/**
 * What kind of thing a design row points at.
 *
 *  `canva` / `figma` — a link that EMBEDS. The tab renders it inline and lets
 *      you click through to the real editor. Split into two kinds rather than
 *      one `embed` because the embed URLs are built differently and because a
 *      marketer scanning the library wants to know which tool a file is in
 *      before they click.
 *  `link` — anything else with a URL: a Dropbox folder, a Google Drive file, a
 *      Notion page. No embed; a link and a label.
 *  `image` — an upload we host. The finished artwork, not the source file.
 */
export const DESIGN_KINDS = ["canva", "figma", "link", "image"] as const;
export type DesignKind = (typeof DESIGN_KINDS)[number];

export const DESIGN_KIND_LABELS: Record<DesignKind, string> = {
  canva: "Canva",
  figma: "Figma",
  link: "Link",
  image: "Image",
};

/** One design in the library. */
export interface DesignAsset {
  id: string;
  kind: DesignKind;
  title: string;
  /** Which shelf. Null = loose, shown in "Unfiled". */
  folderId: string | null;
  /** Where it lives. Always present except on an `image` whose only content is
   *  the upload itself. */
  url: string | null;
  /** The embeddable form of `url`, or null when it isn't embeddable — computed
   *  by `designEmbedUrl`, never stored, so fixing the embed rule fixes every
   *  existing row. */
  embedUrl: string | null;
  /** A servable URL for the uploaded artwork (`image` kind). */
  imageUrl: string | null;
  /** A servable URL for the hosted thumbnail, for any kind. Always an upload —
   *  see the Canva CDN note in this module's doc. */
  thumbnailUrl: string | null;
  /** What it's for, in a line. */
  notes: string | null;
  order: number;
  updatedAt: number;
}

export const DESIGN_TITLE_MAX = 80;
export const DESIGN_NOTES_MAX = 300;
export const DESIGN_URL_MAX = 800;
export const DESIGN_MAX_COUNT = 500;

// ── Embeds ───────────────────────────────────────────────────────────────────

/**
 * The embeddable form of a design's URL, or `null` when there isn't one.
 *
 * Modelled on `apps/mobile/lib/videoEmbed.ts` exactly, including the two rules
 * that make that module safe:
 *
 *  1. **`null` for anything unrecognized**, so every caller has to have a
 *     fallback and the fallback is "just link to it" rather than a broken
 *     frame.
 *  2. **Subdomain-safe host matching** (`hostIs`), so `canva.com.evil.test`
 *     does not read as Canva. A URL that reaches an `<iframe>` is a URL an
 *     attacker would like to control.
 *
 * Canva: `https://www.canva.com/design/<id>/<token>/view` → append `?embed`.
 * Figma: any figma.com file/design/board/proto URL → `figma.com/embed`.
 *
 * Pure and dependency-free so the Convex serializer, the Expo screen, and the
 * tests share one answer.
 */
export function designEmbedUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  // http: is deliberately excluded — an embedded frame on an https page would
  // be blocked as mixed content anyway, so returning one would only produce a
  // blank box instead of the honest link fallback.
  if (u.protocol !== "https:") return null;
  const host = u.hostname.replace(/^www\./, "");

  if (hostIs(host, "canva.com")) {
    // A Canva view link already carries everything the embed needs; the embed
    // is the same URL with the flag on. Anything that isn't a /design/ link
    // (a homepage, a template gallery) has nothing to show.
    if (!u.pathname.startsWith("/design/")) return null;
    const base = `https://www.canva.com${u.pathname.replace(/\/?$/, "")}`;
    return `${base.replace(/\/(view|edit)$/, "/view")}?embed`;
  }

  if (hostIs(host, "figma.com")) {
    // Figma's embed takes the ORIGINAL url as a parameter rather than
    // rewriting the path, which is why this branch looks different.
    return `https://www.figma.com/embed?embed_host=chapter-os&url=${encodeURIComponent(u.toString())}`;
  }

  return null;
}

/** `host === base` or a real subdomain of it — never a suffix match, which
 *  `canva.com.evil.test` would pass. */
function hostIs(host: string, base: string): boolean {
  return host === base || host.endsWith(`.${base}`);
}

/**
 * Whether a design's URL is one the library will store.
 *
 * Narrower than the site's `isAllowedSiteLinkUrl`: this one has no
 * site-relative case (a design lives in another tool, by definition) and no
 * `tel:`. `mailto:` stays, because "email the printer" is a real row.
 */
export function isAllowedDesignUrl(url: string): boolean {
  const trimmed = url.trim();
  if (trimmed.length === 0 || trimmed.length > DESIGN_URL_MAX) return false;
  try {
    const parsed = new URL(trimmed);
    return ["https:", "mailto:"].includes(parsed.protocol);
  } catch {
    return false;
  }
}

// ── The wire shape ───────────────────────────────────────────────────────────

/** Everything the Designs tab renders, in one read. Small enough (a few dozen
 *  rows) that paging it would be more code than it saves. */
export interface DesignLibrary {
  colors: BrandColor[];
  fonts: BrandFont[];
  folders: DesignFolder[];
  designs: DesignAsset[];
  /** True when the caller may change any of it. The tab renders read-only
   *  otherwise, rather than refusing — reading is the ungated case. */
  canEdit: boolean;
}
