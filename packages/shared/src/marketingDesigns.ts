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
 *            "Easter 2026"). One level deep, deliberately (see below).
 *   DESIGNS  `DesignAsset` — a Canva or Figma link, or an uploaded image.
 *            Answers "where's the template for this?"
 *
 * ── THE FOLDER IS THE PRIMITIVE, AND IT HOLDS ALL THREE ─────────────────────
 * A folder is not a shelf for design FILES. It is a collection, and a color, a
 * face and a design file may each be in one — which is what lets "Easter 2026"
 * be a real thing: the red it uses, the face its posters are set in, and the
 * posters, in one place. Colors and Faces are themselves nothing but folders
 * that happen to be PINNED (`DesignFolder.pinned`), seeded that way by
 * migration `0085` so the tab looks unchanged the day this lands.
 *
 * Membership is MANY-TO-MANY (`folderIds` on all three item types), and that is
 * the load-bearing decision. A strict filing cabinet — one home per item — puts
 * the org's red in exactly one of "Colors" and "Easter 2026", so either the
 * pinned palette goes incomplete or the event folder can't name the color it
 * uses. Neither is acceptable, and duplicating the row to dodge it would give
 * the kit two `#891d1a`s that drift the first time somebody corrects one. So an
 * item is IN a folder the way a song is in a playlist: added and removed, never
 * moved, and unaffected by what any other folder does with it.
 *
 * An item in no folder at all is UNFILED. That is a real, visible state, not an
 * error — the same argument the old `folderId: null` made.
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
  /** Every folder this color is in. Empty = unfiled. See the module doc on why
   *  membership is many-to-many. */
  folderIds: string[];
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
  /** Every folder this face is in. Empty = unfiled. */
  folderIds: string[];
  order: number;
}

export const BRAND_FONT_NAME_MAX = 60;
export const BRAND_FONT_NOTES_MAX = 200;
export const BRAND_FONT_MAX_COUNT = 12;

// ── Folders ──────────────────────────────────────────────────────────────────

/**
 * One collection. `parentId` null = a top-level folder.
 *
 * `pinned` is the whole of the "give this folder its own section" feature: a
 * pinned folder renders as a titled block of its own contents rather than
 * waiting to be selected in the rail. Deliberately a plain flag on the ordinary
 * folder row instead of a second "section" concept — the founder's framing was
 * that folders are the primitive and a section is just a folder you promoted,
 * and two kinds of section with different rules is exactly what that avoids.
 */
export interface DesignFolder {
  id: string;
  name: string;
  parentId: string | null;
  /** Render this folder as its own section, above the library. */
  pinned: boolean;
  order: number;
  /** How many items of ANY kind — colors, faces and designs — are in it, so
   *  the rail can say so without the caller counting. Direct membership only;
   *  a parent's total (which includes its children's) is a display decision the
   *  tab makes. */
  itemCount: number;
}

export const DESIGN_FOLDER_NAME_MAX = 50;
export const DESIGN_FOLDER_MAX_COUNT = 60;

/**
 * What kinds of thing live in a folder.
 *
 * Order is arbitrary here and deliberately not load-bearing — a folder's
 * section draws design files first (the founder's call: the files are what
 * somebody opened the tab to get), and `FolderBody` owns that.
 */
export const FOLDER_ITEM_KINDS = ["color", "font", "design"] as const;
export type FolderItemKind = (typeof FOLDER_ITEM_KINDS)[number];

/**
 * How many folders one item may be in at once.
 *
 * Not a database limit — a guard against the failure mode many-to-many
 * membership invites, where a color ends up in every folder because adding it
 * costs nothing, and folder membership stops meaning anything. Eight is far
 * above any honest use ("the red is in Colors, Easter, and the two campaigns
 * running this month") and far below "all of them".
 */
export const ITEM_FOLDER_MAX = 8;

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
 *  `video` — an upload we host that is PLAYED rather than looked at: the clip
 *      from Field Day, the reel cut for Instagram. Its own kind rather than an
 *      `image` with a video in it because every consumer has to branch — a
 *      video file handed to an `<Image>` is a blank box, and a tile has to say
 *      "this one plays" before somebody clicks it.
 */
export const DESIGN_KINDS = ["canva", "figma", "link", "image", "video"] as const;
export type DesignKind = (typeof DESIGN_KINDS)[number];

export const DESIGN_KIND_LABELS: Record<DesignKind, string> = {
  canva: "Canva",
  figma: "Figma",
  link: "Link",
  image: "Image",
  video: "Video",
};

/**
 * The two kinds whose whole content is a file we host — what a bulk upload can
 * produce, and the kinds that may exist with no URL at all.
 */
export const DESIGN_UPLOAD_KINDS = ["image", "video"] as const;
export type DesignUploadKind = (typeof DESIGN_UPLOAD_KINDS)[number];

/** Whether a design is one of those. Written once so the Convex mutation, the
 *  inspector's "does this need a link?" test, and the tiles all agree. */
export function isUploadKind(kind: DesignKind): kind is DesignUploadKind {
  return kind === "image" || kind === "video";
}

/** One design in the library. */
export interface DesignAsset {
  id: string;
  kind: DesignKind;
  title: string;
  /** Every folder this design is in. Empty = loose, shown in "Unfiled". */
  folderIds: string[];
  /** Where it lives. Always present except on an `image` or `video` whose only
   *  content is the upload itself. */
  url: string | null;
  /** The embeddable form of `url`, or null when it isn't embeddable — computed
   *  by `designEmbedUrl`, never stored, so fixing the embed rule fixes every
   *  existing row. */
  embedUrl: string | null;
  /** A servable URL for the upload itself — the artwork on an `image`, the
   *  playable file on a `video`. Null on every other kind. */
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

// ── Uploading a pile of files at once ────────────────────────────────────────

/**
 * A LIBRARY OF PHOTOS AND CLIPS, not one design at a time.
 *
 * The ask, in the marketing lead's words: "is there a way we can create a
 * library where we can upload multiple images/vid content ex: WWS or Field
 * Day". A folder already IS that library — what was missing is that adding to
 * it cost one form per file, which is the friction that keeps two hundred Field
 * Day photos in somebody's camera roll instead of in the org's hands.
 *
 * So a bulk upload skips the form entirely: every file becomes a design of its
 * own, titled from its filename, filed into the folder it was dropped on, and
 * editable afterwards like any other row. No second concept, no "album" table —
 * a folder of photos is a folder, and the search box, the checklist and the
 * pinning it already has all keep working on it.
 *
 * `DESIGN_UPLOAD_BATCH_MAX` bounds ONE press, not the library: the whole batch
 * lands in a single Convex mutation (so a half-failed upload leaves no half a
 * folder), and a transaction that inserts an unbounded number of rows is a
 * transaction that eventually fails on the size of itself. Forty is a phone's
 * worth of an event; a thousand-photo shoot is several presses, which is the
 * honest shape of the thing.
 *
 * The library-wide `DESIGN_MAX_COUNT` still applies and is now genuinely
 * reachable — `library` reads every row in one query, so the fix when 500 bites
 * is paging that query, never a bigger constant.
 */
export const DESIGN_UPLOAD_BATCH_MAX = 40;

/** What a file picker should offer. Same list `designKindForContentType`
 *  accepts, so the dialog can't hand back something the mutation refuses. */
export const DESIGN_UPLOAD_ACCEPT = "image/*,video/*";

/**
 * Which kind of design an uploaded file becomes, or `null` when the library
 * won't hold it.
 *
 * The MIME type decides, not the extension: the browser and `expo-image-picker`
 * both hand one over, and a name is the one part of a file a person can rename
 * into a lie. Anything that isn't an image or a video is refused outright
 * rather than filed as an `image` — a PDF in an `<Image>` is a blank tile, and
 * a blank tile that claims to be artwork is the failure mode this whole module
 * keeps writing rules against.
 */
export function designKindForContentType(
  contentType: string | null | undefined,
): DesignUploadKind | null {
  const type = contentType?.trim().toLowerCase() ?? "";
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  return null;
}

/**
 * The title a bulk-uploaded file starts life with — its filename, tidied.
 *
 * `field-day_01.JPG` → `field-day 01`. Deliberately not clever about it: the
 * point is that a marketer scanning forty new tiles can tell which photo is
 * which, and the filename is the only thing we know that distinguishes them.
 * Underscores become spaces because a camera writes them where a person would
 * type one; hyphens are left alone because they are usually load-bearing
 * ("2026-08", "field-day"). Renaming one afterwards is a title field like any
 * other design's.
 *
 * Falls back to "Untitled upload" rather than "" because a design with no title
 * is one `upsertDesign` would refuse and a grid would draw as a nameless box.
 */
export function designTitleFromFileName(name: string | null | undefined): string {
  const base = ((name ?? "").split(/[/\\]/).at(-1) ?? "")
    .replace(/\.[^.]+$/, "")
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (base.length === 0) return "Untitled upload";
  return base.slice(0, DESIGN_TITLE_MAX);
}

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
