/**
 * EMAIL DESIGNER — pure doc-manipulation + undo/redo helpers for the campaign
 * block editor (`app/(app)/campaign/[id]/design.tsx`).
 *
 * Dependency-free (no react/react-native), so it's directly unit-testable
 * under this package's jest config (mirrors `lib/financeSeats.ts`'s colocated
 * pure-helper precedent) and safe to share between the web and native editor
 * screens.
 *
 * Undo/redo here is intentionally simpler than `SiteMapEditor`'s op-stack of
 * `{undo, redo}` closures tied to backend mutations: the designer's whole
 * document lives in local state and is autosaved (debounced), so history is
 * just a linear stack of whole-document snapshots — a classic
 * `{past, present, future}` zipper. No free positioning, no per-field diffing.
 */
import {
  MIN_COLUMNS,
  MIN_POLL_OPTIONS,
  isAllowedImageUrl,
  isAllowedLinkUrl,
  newBlockId,
  type EmailBlock,
  type EmailBlockKind,
  type EmailCardContent,
  type EmailCardVariant,
  type EmailDocument,
  type EmailPollOption,
} from "@events-os/shared";

/** An id-generator seam so tests get deterministic ids instead of
 *  `crypto.randomUUID()`. Production callers omit it and get `newBlockId`. */
export type IdFactory = () => string;

/** An empty column/card payload. Every field is optional in
 *  `EmailCardContent`, and a freshly-added card should start BLANK rather
 *  than with placeholder copy someone forgets to replace — except the
 *  heading, which is the one part that's always filled in and gives the
 *  block a visible shape in the preview straight away. */
function emptyCardContent(heading: string): EmailCardContent {
  return { heading };
}

/**
 * A block with sensible starting content for a freshly-added block of `kind`.
 *
 * Every default here must PASS `validateEmailDocument` as-is — with ONE
 * deliberate exception, `image` (see below). The composer autosaves 600ms
 * after the block lands, and `updateCampaignDoc` rejects an invalid document
 * outright (`INVALID_DOC`) — rejecting the WHOLE document, not just the
 * offending block, so an unsaveable default also blocks every unrelated edit
 * made while it exists. So the fields the validator requires to be non-empty
 * (`quote.text`, `poll.question`, every poll option label, `eyebrow.text`)
 * get real placeholder copy rather than `""`.
 *
 * THE `image` EXCEPTION: its `url` must be a non-empty http(s) string, and the
 * only way to satisfy that up front is a fabricated URL that would render as
 * a broken image and could be sent for real if nobody noticed. So it starts
 * `url: ""` — unsaveable until filled — and `ImageBlockEditor` says so
 * inline, in the words of the rule that's actually blocking the save (see
 * `imageUrlProblem`). `emailDesigner.test.ts` pins this as the one kind
 * exempt from the "every default is saveable" guard.
 *
 * `bleed_image` and `footer` are deliberately NOT exceptions. A banner's url
 * is optional (an unfilled slot renders as a neutral placeholder band — the
 * contract's own answer to "the masthead goes here" without naming a URL this
 * deployment may not own), and every field of a footer is optional, so both
 * start as saveable blocks that already have the right SHAPE in the preview.
 */
export function defaultBlockFor(kind: EmailBlockKind, id: string): EmailBlock {
  switch (kind) {
    case "heading":
      return { id, kind: "heading", text: "Heading", level: 1 };
    case "text":
      return { id, kind: "text", markdown: "" };
    case "image":
      return { id, kind: "image", url: "", alt: "" };
    case "button":
      return { id, kind: "button", label: "Click here", url: "https://" };
    case "bleed_image":
      // No `url`: an unfilled banner is a legitimate, SAVEABLE state that
      // renders as a placeholder band, so the block lands with the layout
      // right and the designer fills the artwork in when she has it. `alt` is
      // required by the contract even while empty — "" is "decorative".
      return { id, kind: "bleed_image", alt: "" };
    case "hairline":
      return { id, kind: "hairline" };
    case "footer":
      // Every field is optional, so this saves as-is. It starts with the nav
      // line only: a logo needs a real image (see the exception above), and
      // fabricated social links would ship as dead ones if nobody looked.
      return { id, kind: "footer", navLine: "Public Worship" };
    case "divider":
      return { id, kind: "divider" };
    case "spacer":
      return { id, kind: "spacer", size: "md" };
    case "eyebrow":
      // The newsletter's own opener. `icon` defaults to the lozenge the real
      // Public Worship newsletter uses, so the block looks right before the
      // designer touches it.
      return { id, kind: "eyebrow", text: "THIS MONTH", icon: "◆" };
    case "card":
      return { id, kind: "card", ...emptyCardContent("Card heading") };
    case "columns":
      // MIN_COLUMNS, not MAX — two is the newsletter's actual layout, and
      // removing an unwanted third column is more work than adding one.
      return {
        id,
        kind: "columns",
        columns: Array.from({ length: MIN_COLUMNS }, (_, i) =>
          emptyCardContent(`Column ${i + 1}`),
        ),
      };
    case "quote":
      return { id, kind: "quote", text: "Add the quote here." };
    case "poll":
      // Option ids come from `newBlockId` — NEVER from the label. A vote is
      // recorded against the id, so deriving it from the label would
      // re-bucket every existing vote the moment the designer fixes a typo.
      return {
        id,
        kind: "poll",
        question: "What should we do next?",
        options: Array.from({ length: MIN_POLL_OPTIONS }, (_, i) => ({
          id: newBlockId(),
          label: `Option ${i + 1}`,
        })),
      };
    default: {
      // Exhaustiveness guard — a new EmailBlockKind added upstream without a
      // matching case here should fail loudly at compile time.
      const _exhaustive: never = kind;
      throw new Error(`emailDesigner: unknown block kind "${_exhaustive}"`);
    }
  }
}

/** Human label for a block kind — the "Add block" palette + block card header. */
export const BLOCK_KIND_LABELS: Record<EmailBlockKind, string> = {
  heading: "Heading",
  text: "Text",
  image: "Image",
  button: "Button",
  // "Banner", not "Bleed image": the designer's word for the thing (the strip
  // that carries the section heading as artwork), not the CSS term for how
  // it's painted.
  bleed_image: "Banner",
  hairline: "Hairline",
  footer: "Footer",
  divider: "Divider",
  spacer: "Spacer",
  eyebrow: "Eyebrow",
  card: "Card",
  columns: "Columns",
  quote: "Quote",
  poll: "Poll",
};

/**
 * The "Add block" palette, GROUPED.
 *
 * Fourteen equally-weighted buttons in one wrapped row is a wall, not a
 * palette: nothing tells the designer that a Card and a Spacer are different
 * kinds of decision. The groups are the three real ones —
 *
 *   Sections   the composed shapes a real issue is built from, in the order
 *              they appear down one (masthead → eyebrow → hero card → columns
 *              → testimonial → poll → footer);
 *   Basics     the primitives, for anything the sections don't cover;
 *   Space      the rules and gaps, which are adjustments rather than content.
 *
 * `BLOCK_KINDS` is DERIVED from this, so the palette's contents and its order
 * can't drift from the flat list the tests pin against the contract.
 */
export const BLOCK_GROUPS: readonly {
  title: string;
  /** One line under the heading, so a group explains what it's FOR. */
  hint: string;
  kinds: readonly EmailBlockKind[];
}[] = [
  {
    title: "Sections",
    hint: "The shapes a newsletter is built from.",
    kinds: ["bleed_image", "eyebrow", "card", "columns", "quote", "poll", "footer"],
  },
  {
    title: "Basics",
    hint: "Plain building blocks for anything else.",
    kinds: ["heading", "text", "image", "button"],
  },
  {
    title: "Space",
    hint: "Rules and gaps between sections.",
    kinds: ["hairline", "divider", "spacer"],
  },
];

/**
 * All block kinds, in the order the "Add block" palette renders them —
 * flattened out of `BLOCK_GROUPS` so the two are the same list by
 * construction.
 */
export const BLOCK_KINDS: EmailBlockKind[] = BLOCK_GROUPS.flatMap((g) => [...g.kinds]);

// ── Card presentation choices ──────────────────────────────────────────────

/** The card variants, with the plain-English description of the treatment
 *  each one selects. Order matters: `plain` first because it's what an
 *  untouched card already is, then the four the newsletter is built from, in
 *  the order they appear down a real issue. */
export const CARD_VARIANT_OPTIONS: readonly { value: EmailCardVariant; label: string }[] = [
  { value: "plain", label: "Plain — no fill, no border" },
  { value: "hero", label: "Hero — accent fill, centred, big headline" },
  { value: "feature", label: "Feature — cream fill, text beside the image" },
  { value: "outlined", label: "Outlined — white with a hairline border" },
  { value: "testimonial", label: "Testimonial — near-black, quote and name" },
];

/**
 * Bounds on a card's image column, mirroring `emailBlocks.ts`'s own
 * `MIN_IMAGE_WIDTH_PCT`/`MAX_IMAGE_WIDTH_PCT` (private there, so this is a
 * mirror rather than an import — `emailDesigner.test.ts` pins both ends
 * against the real write gate so the two can't drift).
 */
export const MIN_IMAGE_WIDTH_PCT = 20;
export const MAX_IMAGE_WIDTH_PCT = 80;
/** What the renderer uses when a card doesn't say — see `renderCardInner`. */
export const DEFAULT_IMAGE_WIDTH_PCT = 45;
/** ± step for the width control. Small enough to hit the newsletter's own
 *  asymmetric rows (44, 52), big enough that the range isn't 60 taps wide. */
export const IMAGE_WIDTH_PCT_STEP = 2;

/** Clamp an image-column width into the range the write gate accepts, as a
 *  whole number. The control can then never produce a value that would reject
 *  the document. */
export function clampImageWidthPct(pct: number): number {
  if (!Number.isFinite(pct)) return DEFAULT_IMAGE_WIDTH_PCT;
  return Math.max(
    MIN_IMAGE_WIDTH_PCT,
    Math.min(MAX_IMAGE_WIDTH_PCT, Math.round(pct)),
  );
}

/** Nudge an image-column width by `delta`, treating "not set yet" as the
 *  renderer's own default so the first tap moves from what's on screen. */
export function stepImageWidthPct(current: number | undefined, delta: number): number {
  return clampImageWidthPct((current ?? DEFAULT_IMAGE_WIDTH_PCT) + delta);
}

// ── Editor-side mirrors of the write gate ──────────────────────────────────
//
// Every predicate below answers ONE question: "would
// `validateEmailDocument` reject this, right now?" They exist because the
// inline warnings in the designer are only worth anything if they fire on
// EXACTLY the states the server refuses — a warning that fires where the
// server is happy cries wolf, and (far worse) a state the server refuses
// with no warning at all reads as "the editor is broken", since a rejected
// document is rejected WHOLE and takes every other block's edits down with
// it. Keeping them here, pure and dependency-free, is what lets
// `emailDesigner.test.ts` assert them against the real validator instead of
// against a second copy of the rules written out in JSX.

/** Why the write gate would reject an `image` block's `url`, or null when it
 *  would accept it. Mirrors `validateBlock`'s `image` arm: a non-empty string
 *  whose scheme is http(s) — note the validator tests emptiness on the RAW
 *  string but `isAllowedImageUrl` trims, so `" "` fails as a bad scheme. */
export function imageUrlProblem(url: string): "missing" | "scheme" | null {
  if (url.trim().length === 0) return "missing";
  return isAllowedImageUrl(url) ? null : "scheme";
}

/** Why the write gate would reject a REQUIRED link url (`button.url`, a
 *  footer link's `url`), or null when it would accept it. The link twin of
 *  `imageUrlProblem`: the gate tests emptiness on the raw string and the
 *  scheme against http/https/mailto. */
export function linkUrlProblem(url: string): "missing" | "scheme" | null {
  if (url.length === 0) return "missing";
  return isAllowedLinkUrl(url) ? null : "scheme";
}

/**
 * Why the write gate would reject a BANNER's url (`bleed_image.url`), or null.
 *
 * The one image url in the contract that is allowed to be blank: absent AND
 * empty are both saveable, because an unfilled banner renders as a neutral
 * placeholder band rather than a broken image. So the only rejection left is
 * a filled-in url with a scheme outside http(s) — and the "no url yet" state
 * must NOT warn, or every freshly-added banner would claim to be blocking a
 * save it isn't blocking.
 */
export function bleedImageUrlProblem(url: string | undefined): "scheme" | null {
  if (url === undefined || url.length === 0) return null;
  return isAllowedImageUrl(url) ? null : "scheme";
}

/**
 * The same question for an OPTIONAL image url (`footer.logoUrl`).
 *
 * `undefined` is the field being absent, which the gate is happy with — so the
 * editors write `undefined` (never `""`) when the designer clears one. `""` is
 * NOT the same thing: the gate rejects `logoUrl: ""` outright ("must be a
 * non-empty string"), which is reachable from a document written by an older
 * client, so it still has to warn.
 */
export function optionalImageUrlProblem(
  url: string | undefined,
): "missing" | "scheme" | null {
  return url === undefined ? null : imageUrlProblem(url);
}

/** The optional-link twin — `bleed_image.href`, `image.href`. Same rule:
 *  absent is fine, empty is not. */
export function optionalLinkUrlProblem(
  url: string | undefined,
): "missing" | "scheme" | null {
  return url === undefined ? null : linkUrlProblem(url);
}

/**
 * What's wrong with the alt text beside an image, in the write gate's terms.
 *
 * Two states, deliberately distinguished, because they have opposite
 * consequences and the editor used to show one warning for both:
 *  - `"unsaveable"` — there's an image and the alt is MISSING (`undefined`).
 *    The gate rejects the whole document over it. Only reachable from a
 *    document written before the editors started writing `""` alongside every
 *    url, or one hand-edited elsewhere.
 *  - `"empty"` — the alt is present but blank. The gate ACCEPTS this: `""` is
 *    the contract's "this image is decorative". Advisory only.
 *
 * With no image there is nothing to describe, so both stay quiet.
 */
export function imageAltProblem(image: {
  url?: string;
  alt?: string;
}): "unsaveable" | "empty" | null {
  if (typeof image.url !== "string" || image.url.length === 0) return null;
  if (typeof image.alt !== "string") return "unsaveable";
  return image.alt.trim() === "" ? "empty" : null;
}

/** Cap on a `footer` block's link row, mirroring `emailBlocks.ts`'s own
 *  `MAX_FOOTER_LINKS` (private there). Pinned against the gate in
 *  `emailDesigner.test.ts`. */
export const MAX_FOOTER_LINKS = 8;

/** Why the write gate would reject one footer link, or null. Unlike a card's
 *  call to action — where both halves or neither is the rule — a footer link
 *  that exists at all must have BOTH a label and a valid url, so a blank row
 *  is a rejection rather than a no-op. */
export function footerLinkProblem(link: {
  label: string;
  url: string;
}): "label-missing" | "url-missing" | "url-scheme" | null {
  if (link.label.length === 0) return "label-missing";
  const url = linkUrlProblem(link.url);
  return url === "missing" ? "url-missing" : url === "scheme" ? "url-scheme" : null;
}

/** Which half of a card's call-to-action pair is filled without the other, or
 *  null when the gate is happy (both filled, or neither).
 *
 *  Emptiness is tested on the RAW string, NOT the trimmed one, because
 *  `validateCardContent` uses `.length > 0`: a label backspaced down to a
 *  single stray space is "set" as far as the server is concerned, and pairing
 *  it with no url rejects the document. Trimming here would leave that state
 *  silent in the UI and fatal on save. */
export function ctaPairProblem(content: {
  ctaLabel?: string;
  ctaUrl?: string;
}): "label-without-url" | "url-without-label" | null {
  const hasLabel = typeof content.ctaLabel === "string" && content.ctaLabel.length > 0;
  const hasUrl = typeof content.ctaUrl === "string" && content.ctaUrl.length > 0;
  if (hasLabel === hasUrl) return null;
  return hasLabel ? "label-without-url" : "url-without-label";
}

/** Whether a card's `ctaUrl` carries a scheme the write gate refuses. Separate
 *  from `ctaPairProblem` because the gate checks them separately: a card can
 *  have both halves filled (pair OK) and still be rejected for a `tel:` link.
 *  Nothing warned about that before, so it failed at save with no hint. */
export function cardCtaUrlProblem(content: { ctaUrl?: string }): "scheme" | null {
  const url = content.ctaUrl;
  if (typeof url !== "string" || url.length === 0) return null;
  return isAllowedLinkUrl(url) ? null : "scheme";
}

/** True when some poll option carries a label the write gate would reject.
 *  `.length === 0` and not `.trim()`, matching `validateBlock`'s poll arm —
 *  a whitespace label is ugly but SAVEABLE, and warning about it would put a
 *  block-the-save warning on a document that saves fine. */
export function pollHasBlankLabel(options: readonly EmailPollOption[]): boolean {
  return options.some((o) => o.label.length === 0);
}

/**
 * Reconcile a list of stable React keys against a new list length.
 *
 * `EmailCardContent` has no id of its own in the contract (the `columns`
 * block is a bare array), so the only key React could otherwise use is the
 * INDEX — and index keys are wrong the moment an element is removed from
 * anywhere but the end: removing column 1 of 3 slides column 3's data onto
 * the subtree that was rendering column 2, which keeps that subtree's
 * `useImageLibraryRegistration` ref (pointed at column 2's uploaded image)
 * and its half-typed TextInput. `ColumnsEditor` therefore keeps a key per
 * position and splices it in step with its own edits; this is the fallback
 * for lengths that changed from OUTSIDE it (an undo, a reloaded document),
 * where the worst case is a remount rather than a mismatch.
 */
export function syncListKeys(
  keys: readonly string[],
  length: number,
  idFactory: IdFactory = newBlockId,
): string[] {
  if (keys.length === length) return keys as string[];
  if (keys.length > length) return keys.slice(0, length);
  return [
    ...keys,
    ...Array.from({ length: length - keys.length }, () => idFactory()),
  ];
}

/**
 * Every helper below rebuilds the document by SPREADING the original
 * (`{ ...doc, blocks }`) rather than constructing a bare `{ blocks }`.
 *
 * That matters since `EmailDocument` grew an optional `theme`: a literal
 * `{ blocks }` silently drops it, so adding a block to a themed campaign
 * would strip the theme off the document and autosave the stripped version —
 * an off-brand send caused by an unrelated edit. Spreading keeps every
 * present and future document-level field intact by default.
 *
 * ── insertBlock ────────────────────────────────────────────────────────────
 * Insert a new block of `kind` right after `afterId` (or at the end when
 * `afterId` is null/not found — e.g. nothing selected). Returns the updated
 * doc and the new block's id (so the caller can select it).
 */
export function insertBlock(
  doc: EmailDocument,
  kind: EmailBlockKind,
  afterId: string | null,
  idFactory: IdFactory = newBlockId,
): { doc: EmailDocument; id: string } {
  const id = idFactory();
  const block = defaultBlockFor(kind, id);
  const blocks = doc.blocks.slice();
  const afterIndex = afterId ? blocks.findIndex((b) => b.id === afterId) : -1;
  if (afterIndex >= 0) {
    blocks.splice(afterIndex + 1, 0, block);
  } else {
    blocks.push(block);
  }
  return { doc: { ...doc, blocks }, id };
}

/** Remove the block with `id`. A no-op (same array contents) if not found. */
export function removeBlock(doc: EmailDocument, id: string): EmailDocument {
  return { ...doc, blocks: doc.blocks.filter((b) => b.id !== id) };
}

/**
 * Duplicate the block with `id`, inserting the copy immediately after the
 * original with a fresh id. Returns `id: null` (doc unchanged) if the source
 * block isn't found.
 */
export function duplicateBlock(
  doc: EmailDocument,
  id: string,
  idFactory: IdFactory = newBlockId,
): { doc: EmailDocument; id: string | null } {
  const index = doc.blocks.findIndex((b) => b.id === id);
  if (index < 0) return { doc, id: null };
  const newId = idFactory();
  const copy = { ...doc.blocks[index], id: newId } as EmailBlock;
  const blocks = doc.blocks.slice();
  blocks.splice(index + 1, 0, copy);
  return { doc: { ...doc, blocks }, id: newId };
}

/** Shallow-patch the block with `id` (kind-narrowed patch is the caller's job —
 *  this just merges fields, same shape as a spread). No-op if not found. */
export function updateBlock<B extends EmailBlock>(
  doc: EmailDocument,
  id: string,
  patch: Partial<Omit<B, "id" | "kind">>,
): EmailDocument {
  return {
    ...doc,
    blocks: doc.blocks.map((b) =>
      b.id === id ? ({ ...b, ...patch } as EmailBlock) : b,
    ),
  };
}

/**
 * Move the block with `id` one place up (`delta: -1`) or down (`delta: +1`).
 *
 * The keyboard-and-thumb twin of the drag handle: dragging is the only way to
 * reorder today, which needs a pointer, a steady hand, and a grip target
 * that's 15px wide. Returns the doc UNCHANGED (same reference, so history and
 * autosave both correctly treat it as a no-op) when the block isn't found or
 * is already at that end of the stack.
 */
export function moveBlock(
  doc: EmailDocument,
  id: string,
  delta: -1 | 1,
): EmailDocument {
  const index = doc.blocks.findIndex((b) => b.id === id);
  if (index < 0) return doc;
  const target = index + delta;
  if (target < 0 || target >= doc.blocks.length) return doc;
  const blocks = doc.blocks.slice();
  const [moved] = blocks.splice(index, 1);
  blocks.splice(target, 0, moved);
  return { ...doc, blocks };
}

// ── Translating the write gate's rejections into the designer's own words ───

/**
 * A save rejection, explained in the labels on the designer's screen.
 *
 * `updateCampaignDoc` rejects a document with `validateEmailDocument`'s own
 * message, and that message is written for whoever is reading the CONTRACT:
 * `blocks[3]: card: "ctaLabel" and "ctaUrl" must be set together`. Nothing on
 * screen is called `ctaLabel` — the fields say "Button label" and "Button
 * link" — so the one moment the composer most needs to be understood is the
 * one moment it speaks a private vocabulary.
 *
 * This maps the gate's messages onto the composer's labels. It is deliberately
 * TOTAL: an unrecognised message passes through as-is rather than being
 * swallowed, because a rejection nobody can read still beats a rejection
 * nobody can see. `raw` is always carried so the original stays one tap away
 * (see `design.tsx`'s SaveIndicator).
 */
export type DocErrorExplanation = {
  /** Plain copy in the composer's own labels. */
  message: string;
  /** The validator's exact words — always kept, shown behind "Details". */
  raw: string;
  /** 1-based position of the offending block, when the message names one. */
  blockNumber: number | null;
  /** False when nothing matched and `message` is just `raw`. */
  recognized: boolean;
};

/**
 * Ordered patterns. FIRST match wins, so the more specific pattern must come
 * first: `bleed_image "url"` before `image "url"` (the second is a substring
 * of the first), a footer link's `"label"` before a poll option's, and every
 * `button "…"` rule before the card rules that share a field name (`variant`,
 * `align`). Getting that order wrong doesn't break the save — it just names
 * the wrong control, which is the exact failure this whole table exists to
 * stop, so `emailDesigner.test.ts` drives every rule from a document the REAL
 * validator rejected rather than from a hand-written string.
 */
const DOC_ERROR_RULES: readonly { pattern: RegExp; message: string }[] = [
  // ── Card / column content ────────────────────────────────────────────────
  {
    pattern: /"ctaLabel" and "ctaUrl" must be set together/,
    message:
      "A card's button needs both halves — fill in the Button link, or clear the Button label (a label of just a space still counts).",
  },
  {
    pattern: /"ctaUrl" must start with/,
    message: "A card's Button link has to start with http://, https:// or mailto:.",
  },
  {
    pattern: /"imageAlt" is required/,
    message:
      "A card with an image needs Alt text. Describe the picture — or leave the field deliberately empty if it's decorative.",
  },
  {
    pattern: /"imageUrl" must be a non-empty string/,
    message: "A card's Image field is empty. Fill it in, or clear it entirely.",
  },
  {
    pattern: /"imageUrl" must start with/,
    message: "A card's Image URL has to start with http:// or https://.",
  },
  {
    pattern: /"imageWidthPct"/,
    message: `A card's Image width has to be between ${MIN_IMAGE_WIDTH_PCT}% and ${MAX_IMAGE_WIDTH_PCT}%.`,
  },
  // ── Footer (before the image rules — a logo IS an image url) ─────────────
  {
    pattern: /footer links\[\d+\] "label"/,
    message: "A footer link has no Label. Give it one, or remove the row.",
  },
  {
    pattern: /footer links\[\d+\] "url" must be a non-empty string/,
    message: "A footer link has no address. Add one, or remove the row.",
  },
  {
    pattern: /footer links\[\d+\] "url" must start with/,
    message: "A footer link has to start with http://, https:// or mailto:.",
  },
  {
    pattern: /footer "logoUrl" must be a non-empty string/,
    message: "The footer's Logo field is empty. Choose an image, or clear the field.",
  },
  {
    pattern: /footer "logoUrl" must start with/,
    message: "The footer's Logo URL has to start with http:// or https://.",
  },
  {
    pattern: /footer "logoAlt" is required/,
    message: "The footer's logo needs Logo alt text (empty is fine if it's decorative).",
  },
  {
    pattern: /footer must have/,
    message: `The footer can carry ${MAX_FOOTER_LINKS} links at most.`,
  },
  // ── Banner (before `image`, whose messages it contains as a substring) ────
  {
    pattern: /bleed_image "url" must start with/,
    message: "The banner's image URL has to start with http:// or https://.",
  },
  {
    pattern: /bleed_image "alt"/,
    message:
      "The banner needs Alt text — it carries the section heading, so write out the words on it.",
  },
  {
    pattern: /bleed_image "href"/,
    message: "The banner's Link has to start with http://, https:// or mailto:.",
  },
  // ── Button (before the card rules that share a field name) ───────────────
  { pattern: /button "label"/, message: "A button needs a Button label." },
  {
    pattern: /button "url" must be a non-empty string/,
    message: "A button needs a Link URL.",
  },
  {
    pattern: /button "url" must start with/,
    message: "A button's Link URL has to start with http://, https:// or mailto:.",
  },
  { pattern: /button "variant" must be/, message: "A button's Style isn't one this design supports." },
  { pattern: /button "align" must be/, message: "A button's alignment isn't one this design supports." },
  // ── Image ────────────────────────────────────────────────────────────────
  {
    pattern: /image "url" must be a non-empty string/,
    message:
      "An image block has no Image URL yet. Upload a picture, or choose one from the library.",
  },
  {
    pattern: /image "url" must start with/,
    message: "An Image URL has to start with http:// or https://.",
  },
  {
    pattern: /image "alt"/,
    message:
      "An image needs Alt text. Describe the picture — or leave the field deliberately empty if it's decorative.",
  },
  {
    pattern: /image "href"/,
    message: "An image's Link has to start with http://, https:// or mailto:.",
  },
  { pattern: /image "width" must be/, message: "An image's Width isn't one this design supports." },
  // ── Poll (before nothing in particular, but after the footer's "label") ──
  { pattern: /poll "question"/, message: "A poll needs a Question." },
  { pattern: /poll must have/, message: "A poll needs between 2 and 6 options." },
  { pattern: /poll options\[\d+\] "label"/, message: "Every poll option needs a label." },
  { pattern: /poll options/, message: "One of the poll's options is malformed." },
  // ── The remaining kinds ──────────────────────────────────────────────────
  { pattern: /eyebrow "text"/, message: "An eyebrow needs its Eyebrow text." },
  { pattern: /quote "text"/, message: "A quote needs its Quote text." },
  { pattern: /columns must have/, message: "Columns needs 2 or 3 columns." },
  { pattern: /spacer "size"/, message: "A spacer's Height isn't one this design supports." },
  { pattern: /heading "level"/, message: "A heading's size isn't one this design supports." },
  // ── Card presentation (last: these field names are the least specific) ───
  { pattern: /"variant" must be/, message: "A card's Style isn't one this design supports." },
  { pattern: /"imageSide" must be/, message: "A card's Image placement isn't one this design supports." },
  { pattern: /"ctaStyle" must be/, message: "A card's Button style isn't one this design supports." },
  { pattern: /"align" must be/, message: "A card's Text alignment isn't one this design supports." },
  {
    pattern: /duplicate id/,
    message: "Two blocks somehow share an id. Undo the last change and try again.",
  },
  {
    pattern: /unknown block kind/,
    message: "This email has a block this version of the app doesn't know how to save.",
  },
  {
    pattern: /^theme:/,
    message:
      "This email's theme carries a value the renderer won't accept. Pick a theme again, or fix it on the Themes tab.",
  },
];

/** `blocks[3]: …` → 4 (1-based, as the composer numbers the stack). */
function blockNumberFrom(raw: string): number | null {
  const match = /^blocks\[(\d+)\]/.exec(raw);
  if (!match) return null;
  const index = Number(match[1]);
  return Number.isFinite(index) ? index + 1 : null;
}

/** See {@link DocErrorExplanation}. */
export function explainDocError(raw: string): DocErrorExplanation {
  const blockNumber = blockNumberFrom(raw);
  const rule = DOC_ERROR_RULES.find((r) => r.pattern.test(raw));
  if (!rule) {
    return { message: raw, raw, blockNumber, recognized: false };
  }
  return {
    message: blockNumber === null ? rule.message : `Block ${blockNumber}: ${rule.message}`,
    raw,
    blockNumber,
    recognized: true,
  };
}

/** Reorder the doc's blocks to match `orderedIds` (as `SortableRows.onReorder`
 *  hands back). Any id in `orderedIds` not found in `doc.blocks` is skipped —
 *  defensive against a stale drag callback racing a remote doc update. */
export function reorderBlocks(
  doc: EmailDocument,
  orderedIds: string[],
): EmailDocument {
  const byId = new Map(doc.blocks.map((b) => [b.id, b]));
  const blocks = orderedIds
    .map((id) => byId.get(id))
    .filter((b): b is EmailBlock => b !== undefined);
  // Preserve any block that somehow wasn't in orderedIds (shouldn't happen in
  // practice — SortableRows is seeded from the same id list — but dropping
  // data on a mismatch would be a much worse failure mode than appending it).
  const seen = new Set(blocks.map((b) => b.id));
  for (const b of doc.blocks) {
    if (!seen.has(b.id)) blocks.push(b);
  }
  return { ...doc, blocks };
}

// ── Undo / redo (linear document-snapshot history) ─────────────────────────

export type History<T> = {
  past: T[];
  present: T;
  future: T[];
};

/** A fresh history with no past/future — the starting point when a designer
 *  screen mounts with a loaded document. */
export function initHistory<T>(present: T): History<T> {
  return { past: [], present, future: [] };
}

/** Record a new present, pushing the old present onto `past` and clearing
 *  `future` (a fresh edit invalidates any redo branch — standard editor
 *  semantics). Callers should skip calling this when `next` is
 *  reference-equal to the current present (e.g. an edit that resolved to a
 *  no-op) to avoid polluting history with empty steps. */
export function pushHistory<T>(history: History<T>, next: T): History<T> {
  return { past: [...history.past, history.present], present: next, future: [] };
}

/** Step back one snapshot. No-op (same reference) when there's nothing to undo. */
export function undoHistory<T>(history: History<T>): History<T> {
  if (history.past.length === 0) return history;
  const previous = history.past[history.past.length - 1];
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
  };
}

/** Step forward one snapshot. No-op (same reference) when there's nothing to redo. */
export function redoHistory<T>(history: History<T>): History<T> {
  if (history.future.length === 0) return history;
  const [next, ...rest] = history.future;
  return { past: [...history.past, history.present], present: next, future: rest };
}

export function canUndo<T>(history: History<T>): boolean {
  return history.past.length > 0;
}

export function canRedo<T>(history: History<T>): boolean {
  return history.future.length > 0;
}
