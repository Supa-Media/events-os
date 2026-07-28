/**
 * The block document model for the in-app email-campaign designer — pure
 * TypeScript, zero react/convex deps, so it runs unchanged in Convex's V8
 * mutation/action runtime, plain Node (vitest), and the Expo app.
 *
 * `EmailDocument` is the shape a campaign's HTML body is authored + stored
 * as; `emailRender.ts` (same package) turns one into the actual send-ready
 * HTML/plaintext. Other agents build the designer UI and the Convex
 * mutations/schema against THIS EXACT CONTRACT — treat the `EmailBlock`
 * union and `validateEmailDocument`'s error shape as stable.
 */

import type { EmailTheme } from "./emailTheme";
import { validateEmailTheme } from "./emailTheme";

/**
 * The payload of one "card" — an image, a headline, a paragraph, and a call
 * to action, in that order, any part omittable.
 *
 * Shared by the `card` block (full width) and each entry of a `columns` block
 * (2-up), because they are THE SAME THING at two widths: the designer's
 * newsletter uses a full-bleed hero card and a side-by-side pair built from
 * identical parts. One shape means the renderer, the validator, and the
 * composer editor are each written once.
 */
/**
 * How a card is painted. The real newsletter uses FOUR structurally distinct
 * card treatments, not one card with different colours — which is why a
 * `variant` exists at all despite the theme-level-only rule. The variant
 * selects a ROLE; the theme still supplies every colour.
 *
 *  - `hero`      — accent-filled, centred, image above, filled CTA.
 *  - `feature`   — cream, text beside an image, filled CTA.
 *  - `outlined`  — surface with a 1px border, image beside text, outline CTA.
 *  - `testimonial` — contrast-filled, centred, italic quote + attribution.
 *  - `plain`     — no fill, no border (the pre-existing behaviour, kept so
 *                  documents written before variants render unchanged).
 */
export type EmailCardVariant =
  | "plain"
  | "hero"
  | "feature"
  | "outlined"
  | "testimonial";

/** Where the card's image sits relative to its text. `left`/`right` produce
 *  the asymmetric two-column rows the newsletter uses; `top` stacks. */
export type EmailCardImageSide = "top" | "left" | "right";

/** Filled (accent or contrast) versus outline (transparent, 1px border). The
 *  newsletter uses both, and using only one is a visible mismatch. */
export type EmailButtonVariant = "filled" | "outline";

export type EmailCardContent = {
  imageUrl?: string;
  /** Required whenever `imageUrl` is set — enforced by `validateBlock`. */
  imageAlt?: string;
  heading?: string;
  /** Same markdown SUBSET as the `text` block. */
  body?: string;
  ctaLabel?: string;
  ctaUrl?: string;
  /** Small all-caps line above the heading, inside the card. */
  eyebrow?: string;
  /** Attribution line — `testimonial` only, rendered under the quote. */
  attribution?: string;
  variant?: EmailCardVariant;
  imageSide?: EmailCardImageSide;
  /** Percent width of the IMAGE column when `imageSide` is left/right. The
   *  newsletter's rows are deliberately asymmetric (44/56, 52/48); forcing 50
   *  is one of the things that made the rebuild look generic. 20-80. */
  imageWidthPct?: number;
  align?: "left" | "center";
  ctaStyle?: EmailButtonVariant;
};

/** One option in a `poll` block. `id` is stable and is what a vote is
 *  recorded against — renaming `label` later must NOT re-bucket existing
 *  votes, so the id is generated once (`newBlockId`) and never derived from
 *  the label. */
export type EmailPollOption = { id: string; label: string };

/** A single block in a campaign email. Unknown `kind` values (future blocks
 *  written by a newer client) must render as nothing rather than throw — see
 *  `emailRender.ts`. */
export type EmailBlock =
  | { id: string; kind: "heading"; text: string; level?: 1 | 2 }
  // Markdown SUBSET only: **bold**, *italic*, [text](url), blank-line-separated
  // paragraphs, and "- " prefixed list lines. No nested/other markdown.
  | { id: string; kind: "text"; markdown: string }
  | {
      id: string;
      kind: "image";
      url: string;
      alt: string;
      width?: "full" | "half";
      /** Wrap the image in a link. Exists because the newsletter's
       *  song-of-the-month artwork is meant to be tappable — previously only
       *  expressible as an image block followed by a redundant button. */
      href?: string;
    }
  | {
      id: string;
      kind: "button";
      label: string;
      url: string;
      align?: "left" | "center";
      variant?: EmailButtonVariant;
    }
  /** Edge-to-edge image with NO container padding — the masthead and the
   *  section banners, which in this design carry the section headings as
   *  artwork rather than sitting above a text title. */
  | {
      id: string;
      kind: "bleed_image";
      /** OPTIONAL. An unfilled slot renders as a neutral placeholder band from
       *  theme tokens — never an external request. A built-in template has to
       *  express "the masthead goes here" WITHOUT pointing at a URL this
       *  deployment doesn't own, or every new campaign opens with broken
       *  images. */
      url?: string;
      alt: string;
      href?: string;
      /** Sit inside the container padding instead of bleeding edge to edge —
       *  used for the song artwork, which is inset in the source. */
      inset?: boolean;
    }
  /** Thin full-width rule (`hairline` token), distinct from `divider`'s
   *  in-card border. */
  | { id: string; kind: "hairline" }
  /** The sign-off block: logo, a nav line, social links, and the legal row.
   *  A real block rather than renderer furniture, because the newsletter's
   *  footer is a cream card with its own layout. */
  | {
      id: string;
      kind: "footer";
      logoUrl?: string;
      logoAlt?: string;
      navLine?: string;
      links?: { label: string; url: string }[];
    }
  | { id: string; kind: "divider" }
  | { id: string; kind: "spacer"; size: "sm" | "md" | "lg" }
  // ── Composed blocks (the shapes the newsletter is actually built from) ────
  /** The small all-caps accent label that opens a section ("◆ THIS MONTH").
   *  `icon` is a short literal glyph/emoji, NOT an icon-font name — email
   *  clients don't load icon fonts, so anything else would render as a box. */
  | { id: string; kind: "eyebrow"; text: string; icon?: string }
  | ({ id: string; kind: "card" } & EmailCardContent)
  /** 2- or 3-up row of cards. Stacks to full width on narrow viewports (see
   *  `emailRender.ts`'s `@media` rules) and degrades to stacked blocks in
   *  clients that strip `<style>`. */
  | { id: string; kind: "columns"; columns: EmailCardContent[] }
  | { id: string; kind: "quote"; text: string; attribution?: string }
  /** An inline poll. Each option renders as a link built per-recipient by
   *  `RenderEmailOptions.pollVoteUrl`; with no builder (the composer preview)
   *  the options render inert. */
  | { id: string; kind: "poll"; question: string; options: EmailPollOption[] };

export type EmailBlockKind = EmailBlock["kind"];

/** Minimum/maximum columns in a `columns` block. Two is the newsletter's
 *  actual layout; three is the practical ceiling before a 520px card makes
 *  each column unreadably narrow on a phone. */
export const MIN_COLUMNS = 2;
export const MAX_COLUMNS = 3;

/** Poll bounds — one option is not a choice, and past ~6 the option list is
 *  taller than the email that contains it. */
export const MIN_POLL_OPTIONS = 2;
export const MAX_POLL_OPTIONS = 6;

/**
 * `theme` is OPTIONAL and additive: a document written before themes existed
 * has none and renders with `DEFAULT_EMAIL_THEME` (Public Worship's real
 * brand), which is what the hardcoded constants were trying and failing to be.
 *
 * It is stored INLINE on the document — a resolved snapshot, not a pointer to
 * an `emailThemes` row — so that what a reviewer approved is what sends, and
 * an already-sent campaign never silently restyles when the designer edits the
 * org theme months later. `campaigns.ts` resolves the org's current theme into
 * the doc at write time; see its `applyThemeToDoc`.
 */
export type EmailDocument = { blocks: EmailBlock[]; theme?: EmailTheme };

/** The merge tags a campaign author can drop into heading/text/button
 *  content — `{{tag}}` or `{{tag|fallback}}` (see `emailRender.ts`). This is
 *  the single source of truth for what the designer's "insert merge tag"
 *  picker offers and what the renderer knows how to substitute. */
export const MERGE_TAGS: readonly { tag: string; label: string; example: string }[] = [
  { tag: "firstName", label: "First name", example: "Alex" },
  { tag: "name", label: "Full name", example: "Alex Rivera" },
];

const MERGE_TAG_NAMES: ReadonlySet<string> = new Set(MERGE_TAGS.map((t) => t.tag));

/** Whether `tag` is a recognized merge-tag name (without the `{{ }}` /
 *  `|fallback` syntax) — used by the designer to validate free-typed tags. */
export function isKnownMergeTag(tag: string): boolean {
  return MERGE_TAG_NAMES.has(tag);
}

// ── URL scheme allowlist (SECURITY) ─────────────────────────────────────────
// Checked at TWO points, deliberately redundant (defense in depth):
// `validateEmailDocument` below rejects a disallowed scheme at the WRITE gate
// (so a malicious/malformed document — e.g. a `javascript:` button href, a
// `data:` image src — never lands in the table), and `emailRender.ts`'s
// `safeEmailHref`/`safeImageSrc` re-check at RENDER time (covering any
// document written before this gate existed, or via a path that bypassed it).

/** Schemes allowed for a button/link URL: http/https for normal links,
 *  mailto: for "email me" buttons. */
const ALLOWED_LINK_SCHEMES = ["http:", "https:", "mailto:"];
/** Images only ever need http/https — no reason for a campaign image to be a
 *  mailto: or anything else. */
const ALLOWED_IMAGE_SCHEMES = ["http:", "https:"];

/** The `scheme:` prefix of `url` (lowercased, trimmed), or null if it has
 *  none — a relative/scheme-less string (`"#anchor"`, `"example.com"`) is
 *  treated as having no scheme, not as implicitly safe. */
function urlScheme(url: string): string | null {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url.trim());
  return match ? `${match[1].toLowerCase()}:` : null;
}

/** True iff `url`'s scheme is one a button/markdown-link href may use. */
export function isAllowedLinkUrl(url: string): boolean {
  const scheme = urlScheme(url);
  return scheme !== null && ALLOWED_LINK_SCHEMES.includes(scheme);
}

/** True iff `url`'s scheme is one an image `src` may use. */
export function isAllowedImageUrl(url: string): boolean {
  const scheme = urlScheme(url);
  return scheme !== null && ALLOWED_IMAGE_SCHEMES.includes(scheme);
}

let fallbackIdCounter = 0;

/**
 * A new block id. Convex mutations can't call `Math.random()` (non-
 * deterministic execution isn't allowed), so this prefers
 * `crypto.randomUUID()` — available as a global in Convex's V8 runtime,
 * modern Node, and the Expo/RN crypto polyfill — and only falls back to a
 * timestamp+counter scheme (still collision-safe within a single process)
 * when it isn't present.
 *
 * Pass `seed` to force a specific, deterministic id (tests; a caller that
 * already has a stable identifier to key off of, e.g. restoring a known
 * block on undo). `seed` is used verbatim after prefixing — callers wanting
 * uniqueness across calls are responsible for making it unique.
 */
export function newBlockId(seed?: string | number): string {
  if (seed !== undefined) return `blk_${seed}`;
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (typeof g.crypto?.randomUUID === "function") {
    return `blk_${g.crypto.randomUUID()}`;
  }
  fallbackIdCounter += 1;
  return `blk_${Date.now().toString(36)}_${fallbackIdCounter}`;
}

export type ValidateEmailDocumentResult =
  | { ok: true; doc: EmailDocument }
  | { ok: false; error: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ── Bounds and literal sets used by the validators below ────────────────────
// Kept next to the code that enforces them (rather than beside the block
// union) so the accepted values and the error strings that name them can
// never drift apart.

/** Cap on a `footer` block's link row. The real newsletter carries five (four
 *  socials plus "view in browser"); eight is headroom, not a target — past
 *  that the row wraps into an unreadable block on a phone. */
const MAX_FOOTER_LINKS = 8;

/** Bounds on a card's IMAGE column when `imageSide` is left/right. Below ~20%
 *  the image is a thumbnail; above ~80% the text column can't hold a line of
 *  copy. The newsletter's own rows sit at 44 and 52. */
const MIN_IMAGE_WIDTH_PCT = 20;
const MAX_IMAGE_WIDTH_PCT = 80;

const CARD_VARIANTS: readonly EmailCardVariant[] = [
  "plain",
  "hero",
  "feature",
  "outlined",
  "testimonial",
];
const CARD_IMAGE_SIDES: readonly EmailCardImageSide[] = ["top", "left", "right"];
const BUTTON_VARIANTS: readonly EmailButtonVariant[] = ["filled", "outline"];
const ALIGNMENTS: readonly ("left" | "center")[] = ["left", "center"];

/** `"a" or "b"` / `"a", "b", or "c"` — so a rejection names every accepted
 *  value instead of making the author guess which literal was wanted. The
 *  two-value form drops the comma so the pre-existing messages (`button
 *  "align" must be "left" or "center"`) read exactly as they always have. */
function oneOfList(values: readonly string[]): string {
  const quoted = values.map((v) => `"${v}"`);
  if (quoted.length <= 1) return quoted[0] ?? "";
  if (quoted.length === 2) return `${quoted[0]} or ${quoted[1]}`;
  return `${quoted.slice(0, -1).join(", ")}, or ${quoted[quoted.length - 1]}`;
}

/** True iff `value` is one of `values` — narrow enough that the callers below
 *  read as one line each rather than a chain of `!==` comparisons. */
function isOneOf(value: unknown, values: readonly string[]): boolean {
  return typeof value === "string" && values.includes(value);
}

/** Validate a single block, returning an error string (or null when valid).
 *  `path` is a human-readable locator prefixed onto any error message. */
function validateBlock(block: unknown, path: string): string | null {
  if (!isPlainObject(block)) return `${path}: not an object`;
  if (typeof block.id !== "string" || block.id.length === 0) {
    return `${path}: "id" must be a non-empty string`;
  }
  if (typeof block.kind !== "string") return `${path}: "kind" must be a string`;

  switch (block.kind) {
    case "heading": {
      if (typeof block.text !== "string") return `${path}: heading "text" must be a string`;
      if (
        block.level !== undefined &&
        block.level !== 1 &&
        block.level !== 2
      ) {
        return `${path}: heading "level" must be 1 or 2`;
      }
      return null;
    }
    case "text": {
      if (typeof block.markdown !== "string") {
        return `${path}: text "markdown" must be a string`;
      }
      return null;
    }
    case "image": {
      if (typeof block.url !== "string" || block.url.length === 0) {
        return `${path}: image "url" must be a non-empty string`;
      }
      if (!isAllowedImageUrl(block.url)) {
        return `${path}: image "url" must start with http: or https:`;
      }
      if (typeof block.alt !== "string") return `${path}: image "alt" must be a string`;
      if (
        block.width !== undefined &&
        block.width !== "full" &&
        block.width !== "half"
      ) {
        return `${path}: image "width" must be "full" or "half"`;
      }
      if (block.href !== undefined) {
        if (typeof block.href !== "string" || block.href.length === 0) {
          return `${path}: image "href" must be a non-empty string`;
        }
        if (!isAllowedLinkUrl(block.href)) {
          return `${path}: image "href" must start with http:, https:, or mailto:`;
        }
      }
      return null;
    }
    case "button": {
      if (typeof block.label !== "string" || block.label.length === 0) {
        return `${path}: button "label" must be a non-empty string`;
      }
      if (typeof block.url !== "string" || block.url.length === 0) {
        return `${path}: button "url" must be a non-empty string`;
      }
      if (!isAllowedLinkUrl(block.url)) {
        return `${path}: button "url" must start with http:, https:, or mailto:`;
      }
      if (block.align !== undefined && !isOneOf(block.align, ALIGNMENTS)) {
        return `${path}: button "align" must be ${oneOfList(ALIGNMENTS)}`;
      }
      if (block.variant !== undefined && !isOneOf(block.variant, BUTTON_VARIANTS)) {
        return `${path}: button "variant" must be ${oneOfList(BUTTON_VARIANTS)}`;
      }
      return null;
    }
    case "bleed_image": {
      // `url` is OPTIONAL — an unfilled slot is a legitimate, saveable state.
      // The built-in template ships its masthead and section banners empty so
      // the LAYOUT is right from the first open without naming a URL this
      // deployment may not own; `emailRender.ts` draws a neutral placeholder
      // band and makes no external request. When a url IS set it must be a
      // real image URL.
      if (block.url !== undefined) {
        if (typeof block.url !== "string") {
          return `${path}: bleed_image "url" must be a string`;
        }
        if (block.url.length > 0 && !isAllowedImageUrl(block.url)) {
          return `${path}: bleed_image "url" must start with http: or https:`;
        }
      }
      if (block.inset !== undefined && typeof block.inset !== "boolean") {
        return `${path}: bleed_image "inset" must be a boolean`;
      }
      // Required, exactly like `image` and a card's `imageAlt` — a masthead is
      // the FIRST thing a recipient meets, and Gmail/Outlook block remote
      // images by default. `""` is the legitimate "decorative" value; only
      // `undefined` is rejected.
      if (typeof block.alt !== "string") {
        return `${path}: bleed_image "alt" must be a string (use "" for a decorative image)`;
      }
      if (block.href !== undefined) {
        if (typeof block.href !== "string" || block.href.length === 0) {
          return `${path}: bleed_image "href" must be a non-empty string`;
        }
        if (!isAllowedLinkUrl(block.href)) {
          return `${path}: bleed_image "href" must start with http:, https:, or mailto:`;
        }
      }
      return null;
    }
    case "hairline": {
      return null;
    }
    case "footer": {
      if (block.logoUrl !== undefined) {
        if (typeof block.logoUrl !== "string" || block.logoUrl.length === 0) {
          return `${path}: footer "logoUrl" must be a non-empty string`;
        }
        if (!isAllowedImageUrl(block.logoUrl)) {
          return `${path}: footer "logoUrl" must start with http: or https:`;
        }
        // Same required-alt rule the card images carry, for the same reason.
        if (typeof block.logoAlt !== "string") {
          return `${path}: footer "logoAlt" is required when "logoUrl" is set (use "" for a decorative logo)`;
        }
      }
      if (block.navLine !== undefined && typeof block.navLine !== "string") {
        return `${path}: footer "navLine" must be a string`;
      }
      if (block.links !== undefined) {
        if (!Array.isArray(block.links)) {
          return `${path}: footer "links" must be an array`;
        }
        if (block.links.length > MAX_FOOTER_LINKS) {
          return `${path}: footer must have ${MAX_FOOTER_LINKS} links or fewer`;
        }
        for (let i = 0; i < block.links.length; i++) {
          const link = block.links[i];
          if (!isPlainObject(link)) {
            return `${path}: footer links[${i}] must be an object`;
          }
          if (typeof link.label !== "string" || link.label.length === 0) {
            return `${path}: footer links[${i}] "label" must be a non-empty string`;
          }
          if (typeof link.url !== "string" || link.url.length === 0) {
            return `${path}: footer links[${i}] "url" must be a non-empty string`;
          }
          if (!isAllowedLinkUrl(link.url)) {
            return `${path}: footer links[${i}] "url" must start with http:, https:, or mailto:`;
          }
        }
      }
      return null;
    }
    case "divider": {
      return null;
    }
    case "spacer": {
      if (block.size !== "sm" && block.size !== "md" && block.size !== "lg") {
        return `${path}: spacer "size" must be "sm", "md", or "lg"`;
      }
      return null;
    }
    case "eyebrow": {
      if (typeof block.text !== "string" || block.text.length === 0) {
        return `${path}: eyebrow "text" must be a non-empty string`;
      }
      if (block.icon !== undefined && typeof block.icon !== "string") {
        return `${path}: eyebrow "icon" must be a string`;
      }
      return null;
    }
    case "card": {
      return validateCardContent(block, `${path}: card`);
    }
    case "columns": {
      if (!Array.isArray(block.columns)) {
        return `${path}: columns "columns" must be an array`;
      }
      if (block.columns.length < MIN_COLUMNS || block.columns.length > MAX_COLUMNS) {
        return `${path}: columns must have ${MIN_COLUMNS}-${MAX_COLUMNS} columns`;
      }
      for (let i = 0; i < block.columns.length; i++) {
        const err = validateCardContent(block.columns[i], `${path}: columns[${i}]`);
        if (err) return err;
      }
      return null;
    }
    case "quote": {
      if (typeof block.text !== "string" || block.text.length === 0) {
        return `${path}: quote "text" must be a non-empty string`;
      }
      if (block.attribution !== undefined && typeof block.attribution !== "string") {
        return `${path}: quote "attribution" must be a string`;
      }
      return null;
    }
    case "poll": {
      if (typeof block.question !== "string" || block.question.length === 0) {
        return `${path}: poll "question" must be a non-empty string`;
      }
      if (!Array.isArray(block.options)) {
        return `${path}: poll "options" must be an array`;
      }
      if (
        block.options.length < MIN_POLL_OPTIONS ||
        block.options.length > MAX_POLL_OPTIONS
      ) {
        return `${path}: poll must have ${MIN_POLL_OPTIONS}-${MAX_POLL_OPTIONS} options`;
      }
      // Option ids are what votes are keyed by, so a duplicate would silently
      // merge two distinct choices into one tally — rejected at the gate
      // rather than discovered when the results look wrong.
      const optionIds = new Set<string>();
      for (let i = 0; i < block.options.length; i++) {
        const opt = block.options[i];
        if (!isPlainObject(opt)) return `${path}: poll options[${i}] must be an object`;
        if (typeof opt.id !== "string" || opt.id.length === 0) {
          return `${path}: poll options[${i}] "id" must be a non-empty string`;
        }
        if (typeof opt.label !== "string" || opt.label.length === 0) {
          return `${path}: poll options[${i}] "label" must be a non-empty string`;
        }
        if (optionIds.has(opt.id)) {
          return `${path}: poll options[${i}] duplicate id "${opt.id}"`;
        }
        optionIds.add(opt.id);
      }
      return null;
    }
    default:
      return `${path}: unknown block kind "${String(block.kind)}"`;
  }
}

/** Validate an `EmailCardContent` payload — shared by the `card` block and
 *  every entry of a `columns` block, so the two can never drift. */
function validateCardContent(content: unknown, path: string): string | null {
  if (!isPlainObject(content)) return `${path}: not an object`;

  if (content.imageUrl !== undefined) {
    if (typeof content.imageUrl !== "string" || content.imageUrl.length === 0) {
      return `${path}: "imageUrl" must be a non-empty string`;
    }
    if (!isAllowedImageUrl(content.imageUrl)) {
      return `${path}: "imageUrl" must start with http: or https:`;
    }
    // Alt text is REQUIRED once there's an image — an unlabelled image is
    // invisible to a screen reader and shows nothing when a client blocks
    // remote images (which Gmail and Outlook both do by default). The empty
    // string is a legitimate value meaning "decorative"; only `undefined` is
    // rejected.
    if (typeof content.imageAlt !== "string") {
      return `${path}: "imageAlt" is required when "imageUrl" is set (use "" for a decorative image)`;
    }
  }

  for (const key of ["heading", "body", "ctaLabel", "eyebrow", "attribution"] as const) {
    if (content[key] !== undefined && typeof content[key] !== "string") {
      return `${path}: "${key}" must be a string`;
    }
  }

  // Presentation fields. Each selects a ROLE the renderer knows how to paint
  // (see `EmailCardVariant`'s doc) — an unknown value would silently fall
  // through to the plain treatment, so it's rejected here rather than
  // coerced, in keeping with this being the write gate.
  if (content.variant !== undefined && !isOneOf(content.variant, CARD_VARIANTS)) {
    return `${path}: "variant" must be ${oneOfList(CARD_VARIANTS)}`;
  }
  if (content.imageSide !== undefined && !isOneOf(content.imageSide, CARD_IMAGE_SIDES)) {
    return `${path}: "imageSide" must be ${oneOfList(CARD_IMAGE_SIDES)}`;
  }
  if (content.align !== undefined && !isOneOf(content.align, ALIGNMENTS)) {
    return `${path}: "align" must be ${oneOfList(ALIGNMENTS)}`;
  }
  if (content.ctaStyle !== undefined && !isOneOf(content.ctaStyle, BUTTON_VARIANTS)) {
    return `${path}: "ctaStyle" must be ${oneOfList(BUTTON_VARIANTS)}`;
  }
  if (content.imageWidthPct !== undefined) {
    const pct = content.imageWidthPct;
    if (
      typeof pct !== "number" ||
      !Number.isFinite(pct) ||
      pct < MIN_IMAGE_WIDTH_PCT ||
      pct > MAX_IMAGE_WIDTH_PCT
    ) {
      return `${path}: "imageWidthPct" must be a number between ${MIN_IMAGE_WIDTH_PCT} and ${MAX_IMAGE_WIDTH_PCT}`;
    }
  }

  // A label with no destination is a dead button; a destination with no label
  // is an invisible one. Both halves or neither.
  const hasLabel = typeof content.ctaLabel === "string" && content.ctaLabel.length > 0;
  const hasUrl = typeof content.ctaUrl === "string" && content.ctaUrl.length > 0;
  if (hasLabel !== hasUrl) {
    return `${path}: "ctaLabel" and "ctaUrl" must be set together`;
  }
  if (hasUrl && !isAllowedLinkUrl(content.ctaUrl as string)) {
    return `${path}: "ctaUrl" must start with http:, https:, or mailto:`;
  }

  return null;
}

/**
 * Validate an unknown value as an `EmailDocument`. Strict: rejects unknown
 * block kinds and malformed fields (this is the write-path gate — a
 * malformed document should never be saved) rather than silently dropping
 * them. `emailRender.ts` is separately forward-compatible (it skips unknown
 * kinds) for documents written by a NEWER client than the one rendering.
 */
export function validateEmailDocument(doc: unknown): ValidateEmailDocumentResult {
  if (!isPlainObject(doc)) return { ok: false, error: "document must be an object" };
  if (!Array.isArray(doc.blocks)) return { ok: false, error: '"blocks" must be an array' };

  const ids = new Set<string>();
  for (let i = 0; i < doc.blocks.length; i++) {
    const err = validateBlock(doc.blocks[i], `blocks[${i}]`);
    if (err) return { ok: false, error: err };
    const id = (doc.blocks[i] as { id: string }).id;
    if (ids.has(id)) return { ok: false, error: `blocks[${i}]: duplicate id "${id}"` };
    ids.add(id);
  }

  // `theme` is optional — a document written before themes existed simply has
  // none and renders on `DEFAULT_EMAIL_THEME`. When PRESENT it must be
  // complete and well-formed: a half-filled theme reaching the renderer would
  // paint `undefined` into a style attribute on a real send.
  if (doc.theme !== undefined) {
    const themeResult = validateEmailTheme(doc.theme);
    if (!themeResult.ok) return { ok: false, error: `theme: ${themeResult.error}` };
    return { ok: true, doc: { ...(doc as EmailDocument), theme: themeResult.theme } };
  }

  return { ok: true, doc: doc as EmailDocument };
}
