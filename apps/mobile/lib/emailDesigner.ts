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
  newBlockId,
  type EmailBlock,
  type EmailBlockKind,
  type EmailCardContent,
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
  divider: "Divider",
  spacer: "Spacer",
  eyebrow: "Eyebrow",
  card: "Card",
  columns: "Columns",
  quote: "Quote",
  poll: "Poll",
};

/**
 * All block kinds, in the order the "Add block" palette renders them.
 *
 * Ordered by how the newsletter is actually built, not alphabetically: the
 * COMPOSED blocks (eyebrow → card → columns → quote → poll) come first
 * because they're the shapes the designer reaches for, and the primitives
 * (heading/text/image/button/divider/spacer) follow as the escape hatch.
 */
export const BLOCK_KINDS: EmailBlockKind[] = [
  "eyebrow",
  "card",
  "columns",
  "quote",
  "poll",
  "heading",
  "text",
  "image",
  "button",
  "divider",
  "spacer",
];

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
