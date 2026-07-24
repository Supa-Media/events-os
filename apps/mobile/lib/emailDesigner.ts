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
  newBlockId,
  type EmailBlock,
  type EmailBlockKind,
  type EmailDocument,
} from "@events-os/shared";

/** An id-generator seam so tests get deterministic ids instead of
 *  `crypto.randomUUID()`. Production callers omit it and get `newBlockId`. */
export type IdFactory = () => string;

/** A block with sensible starting content for a freshly-added block of `kind`. */
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
};

/** All block kinds, in the order the "Add block" palette renders them. */
export const BLOCK_KINDS: EmailBlockKind[] = [
  "heading",
  "text",
  "image",
  "button",
  "divider",
  "spacer",
];

/**
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
  return { doc: { blocks }, id };
}

/** Remove the block with `id`. A no-op (same array contents) if not found. */
export function removeBlock(doc: EmailDocument, id: string): EmailDocument {
  return { blocks: doc.blocks.filter((b) => b.id !== id) };
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
  return { doc: { blocks }, id: newId };
}

/** Shallow-patch the block with `id` (kind-narrowed patch is the caller's job —
 *  this just merges fields, same shape as a spread). No-op if not found. */
export function updateBlock<B extends EmailBlock>(
  doc: EmailDocument,
  id: string,
  patch: Partial<Omit<B, "id" | "kind">>,
): EmailDocument {
  return {
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
  return { blocks };
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
