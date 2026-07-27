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
export type EmailCardContent = {
  imageUrl?: string;
  /** Required whenever `imageUrl` is set — enforced by `validateBlock`. */
  imageAlt?: string;
  heading?: string;
  /** Same markdown SUBSET as the `text` block. */
  body?: string;
  ctaLabel?: string;
  ctaUrl?: string;
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
  | { id: string; kind: "button"; label: string; url: string; align?: "left" | "center" }
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
      if (
        block.align !== undefined &&
        block.align !== "left" &&
        block.align !== "center"
      ) {
        return `${path}: button "align" must be "left" or "center"`;
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

  for (const key of ["heading", "body", "ctaLabel"] as const) {
    if (content[key] !== undefined && typeof content[key] !== "string") {
      return `${path}: "${key}" must be a string`;
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
