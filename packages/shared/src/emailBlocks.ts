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

/** A single block in a campaign email. Unknown `kind` values (future blocks
 *  written by a newer client) must render as nothing rather than throw — see
 *  `emailRender.ts`. */
export type EmailBlock =
  | { id: string; kind: "heading"; text: string; level?: 1 | 2 }
  // Markdown SUBSET only: **bold**, *italic*, [text](url), blank-line-separated
  // paragraphs, and "- " prefixed list lines. No nested/other markdown.
  | { id: string; kind: "text"; markdown: string }
  | { id: string; kind: "image"; url: string; alt: string; width?: "full" | "half" }
  | { id: string; kind: "button"; label: string; url: string; align?: "left" | "center" }
  | { id: string; kind: "divider" }
  | { id: string; kind: "spacer"; size: "sm" | "md" | "lg" };

export type EmailBlockKind = EmailBlock["kind"];

export type EmailDocument = { blocks: EmailBlock[] };

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
      if (typeof block.alt !== "string") return `${path}: image "alt" must be a string`;
      if (
        block.width !== undefined &&
        block.width !== "full" &&
        block.width !== "half"
      ) {
        return `${path}: image "width" must be "full" or "half"`;
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
    default:
      return `${path}: unknown block kind "${String(block.kind)}"`;
  }
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

  return { ok: true, doc: doc as EmailDocument };
}
