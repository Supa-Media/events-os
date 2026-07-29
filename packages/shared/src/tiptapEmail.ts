/**
 * The tiptap half of the maily editor overhaul (see
 * `docs/plans/maily-editor-overhaul.md`, WS1). Pure JSON walking, zero deps —
 * `packages/shared` has none and must stay that way.
 *
 * ── Why this file exists ─────────────────────────────────────────────────
 * `packages/email-render`'s vendored `Maily` class (`maily.tsx`) THROWS on
 * any node/mark `type` it doesn't have a render method for (`renderNode`/
 * `renderMark`: `if (type in this) return this[type](...); throw new
 * Error(...)`). A campaign's `doc` is only ever validated once, at WRITE
 * time (composer save / approval submit) — by the time it reaches send, a
 * bad doc is a production incident, not a caught error. `validateTiptapEmailDoc`
 * is that write-time gate: it is the shared, backend-independent copy of
 * "would this doc make `Maily.render()` throw or emit something unsafe",
 * so the gate and the renderer can never quietly drift apart (the render
 * side has its own drift test — `packages/email-render/src/nodeTypes.ts` —
 * asserting its dispatch table matches `EMAIL_TIPTAP_NODE_TYPES` below
 * exactly).
 *
 * ── The correspondence guarantee this file exists to uphold ────────────────
 *   "a doc that validates must render without throwing;
 *    a doc that would throw at render must fail validation."
 * Three renderer behaviors specifically motivate a check below (not just
 * "unknown type", which is the obvious one):
 *   - `heading`/`pwHeading`: maily's `headings[\`h${Number(attrs.level)||1}\`]`
 *     lookup DESTRUCTURES the result — an out-of-range level (4, 0, a
 *     negative number, a non-integer) makes that lookup `undefined` and the
 *     destructure throws. `headingLevelIsSafe` below mirrors maily's own
 *     `Number(level) || 1` coercion so it rejects exactly the inputs that
 *     would throw, not a stricter set.
 *   - Any href/src-bearing attr (`button.url`, `image.src`/`externalLink`,
 *     `logo.src`, `linkCard.link`, `inlineImage.src`/`externalLink`,
 *     `pwBleedImage.src`/`href`, the `link` mark's `href`): the renderer
 *     never throws on a `javascript:`/`data:` value — it renders it VERBATIM
 *     into a real `href`/`src`. That's not a crash, it's an XSS/phishing
 *     vector in a real send, so it's write-gated here the same way
 *     `emailBlocks.ts` gates the block format's URLs (see below).
 *   - `pwPoll`: malformed `options` (missing id/label, duplicate id, out-of-
 *     bounds count) wouldn't throw maily's renderer either — the render
 *     method (see `email-render/src/maily.tsx`) is defensive — but a
 *     duplicate option id would silently merge two distinct choices into one
 *     vote tally at count time (`apps/convex/campaignPolls.ts`), which is a
 *     worse failure than a loud rejection at save time. Same reasoning
 *     `emailBlocks.ts`'s poll block validation already uses.
 *
 * ── URL scheme allowlist (SECURITY) ─────────────────────────────────────────
 * PORTED from `emailBlocks.ts`'s `isAllowedLinkUrl`/`isAllowedImageUrl` (see
 * that file's own "URL scheme allowlist" section for the full reasoning) —
 * not imported, deliberately: the block format is legacy-only going forward
 * (`docFormat: "blocks"`, frozen), and this file is the tiptap format's own
 * write gate, so its copy of the rule should not depend on the file that
 * exists only to keep old sends rendering. Semantics are identical: http/
 * https/mailto for links, http/https for images. `emailRender.ts`'s
 * `safeEmailHref`/`safeImageSrc` re-check the block format at RENDER time as
 * defense-in-depth; the tiptap render side (`pwBleedImage`) does the same
 * with its own copy of these two functions — see that file's comment.
 */

import { MAX_POLL_OPTIONS, MIN_POLL_OPTIONS } from "./emailBlocks";

// ── Node/mark whitelists ─────────────────────────────────────────────────
//
// The single source of truth for "what tiptap node/mark types can this
// system's renderer produce". `packages/email-render`'s `nodeTypes.ts`
// hand-maintains its OWN list of which `Maily` instance methods actually
// exist for node-type dispatch (reflection can't tell a real per-type render
// method apart from an internal helper with the same "instance method"
// shape — see that file's doc) and a drift test asserts the two lists are
// set-equal, so this file and the renderer can never silently disagree about
// what a "known" node type is.
//
// Stock maily nodes are every type `Maily.renderNode`/`this[type]` resolves
// to a method for (read from the vendored `maily.tsx`'s method list), MINUS
// `htmlCodeBlock`: that method lets an author embed raw HTML verbatim
// (`dangerouslySetInnerHTML`) — any href/src scheme, completely unchecked by
// the allowlist below, since it never goes through an attr the validator can
// see. Public Worship's campaign authors are church volunteers, not
// developers, and the plan doc's editing surface has no "insert raw HTML"
// affordance — so the safer default is to never accept that node type at the
// write gate rather than trust a future editor surface won't expose it.
// `email-render`'s `nodeTypes.ts` makes the matching exclusion; see its doc.
export const EMAIL_TIPTAP_NODE_TYPES = [
  "paragraph",
  "text",
  "variable",
  "heading",
  "horizontalRule",
  "orderedList",
  "bulletList",
  "listItem",
  "button",
  "spacer",
  "hardBreak",
  "logo",
  "image",
  "footer",
  "blockquote",
  "linkCard",
  "section",
  "columns",
  "column",
  "repeat",
  "for",
  "inlineImage",
  // ── The Public Worship node pack (docs/plans/maily-editor-overhaul.md,
  // "The Public Worship node pack") — gaps recon found stock maily can't
  // express, each a first-class render method on the vendored `Maily` now. ──
  "pwHeading",
  "pwParagraph",
  "pwBleedImage",
  "pwPoll",
] as const;
export type EmailTiptapNodeType = (typeof EMAIL_TIPTAP_NODE_TYPES)[number];

/** Mark types the renderer's `renderMark` dispatches on (`bold`, `italic`,
 *  `underline`, `strike`, `textStyle`, `link`, `code` — see `maily.tsx`'s
 *  `marksOrder` and per-mark methods). `textStyle` additionally carries the
 *  PW node pack's `letterSpacing` attr (tracking on text runs — maily has no
 *  tracking concept at all upstream); `link` carries `href`, checked below. */
export const EMAIL_TIPTAP_MARK_TYPES = [
  "bold",
  "italic",
  "underline",
  "strike",
  "textStyle",
  "link",
  "code",
] as const;
export type EmailTiptapMarkType = (typeof EMAIL_TIPTAP_MARK_TYPES)[number];

// ── Bounds (hostile-doc defense) ─────────────────────────────────────────
// A hostile/malformed doc must not stack-overflow the validator OR the
// renderer. Depth is checked BEFORE each recursive call (not after), so the
// validator itself never recurses past `EMAIL_TIPTAP_MAX_DEPTH + 1` frames —
// safe regardless of how deep (or cyclic) the actual input object graph is.
export const EMAIL_TIPTAP_MAX_DEPTH = 20;
export const EMAIL_TIPTAP_MAX_NODES = 2000;

// ── URL scheme allowlist — see module doc for why this is a PORT, not an
// import, of emailBlocks.ts's identical functions. ──────────────────────────
const ALLOWED_LINK_SCHEMES = ["http:", "https:", "mailto:"];
const ALLOWED_IMAGE_SCHEMES = ["http:", "https:"];

function urlScheme(url: string): string | null {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url.trim());
  return match ? `${match[1].toLowerCase()}:` : null;
}

function isAllowedLinkUrl(url: string): boolean {
  const scheme = urlScheme(url);
  return scheme !== null && ALLOWED_LINK_SCHEMES.includes(scheme);
}

function isAllowedImageUrl(url: string): boolean {
  const scheme = urlScheme(url);
  return scheme !== null && ALLOWED_IMAGE_SCHEMES.includes(scheme);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ── Node-specific structural checks ──────────────────────────────────────

/** Every attr on a node type that ends up as a real `href`/`src` at render,
 *  and whether an `isXVariable` sibling flag (when present and `true`) turns
 *  the value into a variable NAME rather than a literal URL — in which case
 *  the scheme check does not apply (mirrors `Maily`'s own `variableUrlValue`
 *  branches in `maily.tsx`). */
type UrlAttrRule = { attr: string; variableFlag?: string; scheme: "link" | "image" };

const NODE_URL_ATTR_RULES: Record<string, UrlAttrRule[]> = {
  button: [{ attr: "url", variableFlag: "isUrlVariable", scheme: "link" }],
  image: [
    { attr: "src", variableFlag: "isSrcVariable", scheme: "image" },
    { attr: "externalLink", variableFlag: "isExternalLinkVariable", scheme: "link" },
  ],
  logo: [{ attr: "src", variableFlag: "isSrcVariable", scheme: "image" }],
  // `linkCard.link` has no `isXVariable` flag upstream — when neither
  // `linkValues` nor `variableValues` has a mapping for it, maily's `link()`
  // method falls through to the RAW attr value as the href, unchecked. So
  // unlike the others, this one is always checked as a literal URL.
  linkCard: [{ attr: "link", scheme: "link" }],
  inlineImage: [
    { attr: "src", variableFlag: "isSrcVariable", scheme: "image" },
    { attr: "externalLink", variableFlag: "isExternalLinkVariable", scheme: "link" },
  ],
  pwBleedImage: [
    { attr: "src", scheme: "image" },
    { attr: "href", scheme: "link" },
  ],
};

function checkUrlAttr(
  attrs: Record<string, unknown>,
  rule: UrlAttrRule,
  path: string,
): string | null {
  const value = attrs[rule.attr];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return `${path}: "${rule.attr}" must be a string`;
  if (rule.variableFlag && attrs[rule.variableFlag] === true) return null;
  const allowed = rule.scheme === "image" ? isAllowedImageUrl(value) : isAllowedLinkUrl(value);
  if (!allowed) {
    const schemes = rule.scheme === "image" ? "http: or https:" : "http:, https:, or mailto:";
    return `${path}: "${rule.attr}" must start with ${schemes}`;
  }
  return null;
}

const VALID_HEADING_LEVELS = new Set([1, 2, 3]);

/** Mirrors `heading()`/`pwHeading()`'s own `Number(attrs.level) || 1`
 *  coercion in `maily.tsx` — anything that coercion sends outside {1,2,3}
 *  makes the renderer's `headings[level]` lookup destructure `undefined`
 *  and throw. `undefined` itself is safe (coerces to the default, 1). */
function headingLevelIsSafe(level: unknown): boolean {
  if (level === undefined) return true;
  const n = Number(level) || 1;
  return VALID_HEADING_LEVELS.has(n);
}

function validatePwPollAttrs(attrs: Record<string, unknown>, path: string): string | null {
  if (typeof attrs.id !== "string" || attrs.id.length === 0) {
    return `${path}: pwPoll "id" must be a non-empty string`;
  }
  if (typeof attrs.question !== "string" || attrs.question.length === 0) {
    return `${path}: pwPoll "question" must be a non-empty string`;
  }
  if (!Array.isArray(attrs.options)) {
    return `${path}: pwPoll "options" must be an array`;
  }
  if (attrs.options.length < MIN_POLL_OPTIONS || attrs.options.length > MAX_POLL_OPTIONS) {
    return `${path}: pwPoll must have ${MIN_POLL_OPTIONS}-${MAX_POLL_OPTIONS} options`;
  }
  const ids = new Set<string>();
  for (let i = 0; i < attrs.options.length; i++) {
    const opt: unknown = attrs.options[i];
    if (!isPlainObject(opt)) return `${path}: pwPoll options[${i}] must be an object`;
    if (typeof opt.id !== "string" || opt.id.length === 0) {
      return `${path}: pwPoll options[${i}] "id" must be a non-empty string`;
    }
    if (typeof opt.label !== "string" || opt.label.length === 0) {
      return `${path}: pwPoll options[${i}] "label" must be a non-empty string`;
    }
    if (ids.has(opt.id)) return `${path}: pwPoll options[${i}] duplicate id "${opt.id}"`;
    ids.add(opt.id);
  }
  return null;
}

function validateMark(mark: unknown, path: string): string | null {
  if (!isPlainObject(mark)) return `${path}: mark must be an object`;
  if (typeof mark.type !== "string" || mark.type.length === 0) {
    return `${path}: mark "type" must be a non-empty string`;
  }
  if (!(EMAIL_TIPTAP_MARK_TYPES as readonly string[]).includes(mark.type)) {
    return `${path}: unknown mark type "${mark.type}"`;
  }
  const attrs = isPlainObject(mark.attrs) ? mark.attrs : {};
  if (mark.type === "link") {
    const err = checkUrlAttr(attrs, { attr: "href", variableFlag: "isUrlVariable", scheme: "link" }, path);
    if (err) return err;
  }
  if (mark.type === "textStyle" && attrs.letterSpacing !== undefined && typeof attrs.letterSpacing !== "string") {
    return `${path}: textStyle mark "letterSpacing" must be a string`;
  }
  return null;
}

function validateMarks(marks: unknown, path: string): string | null {
  if (marks === undefined) return null;
  if (!Array.isArray(marks)) return `${path}: "marks" must be an array`;
  for (let i = 0; i < marks.length; i++) {
    const err = validateMark(marks[i], `${path}.marks[${i}]`);
    if (err) return err;
  }
  return null;
}

/** Shared mutable read budget threaded through the recursive walk — a plain
 *  object (not a closure counter) so a future caller could reuse the same
 *  budget across sibling calls if this ever needs to compose. */
type NodeBudget = { nodes: number };

function validateNode(node: unknown, path: string, depth: number, budget: NodeBudget): string | null {
  if (depth > EMAIL_TIPTAP_MAX_DEPTH) {
    return `${path}: exceeds max nesting depth (${EMAIL_TIPTAP_MAX_DEPTH})`;
  }
  budget.nodes += 1;
  if (budget.nodes > EMAIL_TIPTAP_MAX_NODES) {
    return `document exceeds max node count (${EMAIL_TIPTAP_MAX_NODES})`;
  }

  if (!isPlainObject(node)) return `${path}: node must be an object`;
  if (typeof node.type !== "string" || node.type.length === 0) {
    return `${path}: node "type" must be a non-empty string`;
  }
  if (!(EMAIL_TIPTAP_NODE_TYPES as readonly string[]).includes(node.type)) {
    return `${path}: unknown node type "${node.type}"`;
  }

  const attrs = isPlainObject(node.attrs) ? node.attrs : {};

  const urlRules = NODE_URL_ATTR_RULES[node.type];
  if (urlRules) {
    for (const rule of urlRules) {
      const err = checkUrlAttr(attrs, rule, `${path} (${node.type})`);
      if (err) return err;
    }
  }

  if (node.type === "heading" || node.type === "pwHeading") {
    if (!headingLevelIsSafe(attrs.level)) {
      return `${path}: ${node.type} "level" must resolve to 1, 2, or 3`;
    }
  }
  if (node.type === "pwPoll") {
    const err = validatePwPollAttrs(attrs, path);
    if (err) return err;
  }
  if (node.type === "pwHeading" || node.type === "pwParagraph") {
    if (attrs.fontSize !== undefined && typeof attrs.fontSize !== "number") {
      return `${path}: ${node.type} "fontSize" must be a number`;
    }
    if (attrs.letterSpacing !== undefined && typeof attrs.letterSpacing !== "string") {
      return `${path}: ${node.type} "letterSpacing" must be a string`;
    }
  }
  if (node.type === "button" && attrs.maxWidth !== undefined && typeof attrs.maxWidth !== "number") {
    return `${path}: button "maxWidth" must be a number`;
  }

  if (node.text !== undefined && typeof node.text !== "string") {
    return `${path}: "text" must be a string`;
  }

  const marksErr = validateMarks(node.marks, path);
  if (marksErr) return marksErr;

  if (node.content !== undefined) {
    if (!Array.isArray(node.content)) return `${path}: "content" must be an array`;
    for (let i = 0; i < node.content.length; i++) {
      const err = validateNode(node.content[i], `${path}.content[${i}]`, depth + 1, budget);
      if (err) return err;
    }
  }

  return null;
}

export type ValidateTiptapEmailDocResult = { ok: true } | { ok: false; error: string };

/**
 * Validate an unknown value as a tiptap `JSONContent` email document — the
 * WRITE gate for `docFormat: "tiptap"` campaigns (composer save / approval
 * submit; wiring is a later lane's job, see `docs/plans/maily-editor-
 * overhaul.md`'s WS2). Total: never throws, always returns a result.
 *
 * See this file's module doc for the exact correspondence this maintains
 * with `packages/email-render`'s vendored `Maily.render()`.
 */
export function validateTiptapEmailDoc(doc: unknown): ValidateTiptapEmailDocResult {
  if (!isPlainObject(doc)) return { ok: false, error: "document must be an object" };
  if (doc.type !== "doc") return { ok: false, error: '"type" must be "doc"' };
  if (!Array.isArray(doc.content)) return { ok: false, error: '"content" must be an array' };

  const budget: NodeBudget = { nodes: 0 };
  for (let i = 0; i < doc.content.length; i++) {
    const err = validateNode(doc.content[i], `content[${i}]`, 1, budget);
    if (err) return { ok: false, error: err };
  }

  return { ok: true };
}

// ── The shared poll-walk helper ──────────────────────────────────────────
//
// Replaces the two independent "find polls in this doc" implementations —
// `apps/convex/campaignPolls.ts`'s `pollBlocksOf` (blocks format only) and
// mobile's `CampaignPollResults.tsx` — with ONE format-aware helper so they
// can never disagree about what a poll is again. Wiring the two call sites
// to import this instead is a LATER lane's job (see the plan doc's "The
// Public Worship node pack", point 5); this file only builds and tests the
// helper, exhaustively, against both formats.
//
// Deliberately LENIENT, unlike `validateTiptapEmailDoc`/`validateEmailDocument`
// above: this is a READ path (rendering poll results, listing polls in a
// UI), not the write gate, and it mirrors `pollBlocksOf`'s existing
// behavior of silently skipping malformed entries rather than failing the
// whole read over one bad poll.

export type NormalizedPollOption = { id: string; label: string };
export type NormalizedPoll = { id: string; question: string; options: NormalizedPollOption[] };

function normalizePollOptions(raw: unknown): NormalizedPollOption[] | null {
  if (!Array.isArray(raw)) return null;
  const out: NormalizedPollOption[] = [];
  for (const opt of raw) {
    if (!isPlainObject(opt)) continue;
    if (typeof opt.id !== "string" || opt.id.length === 0) continue;
    if (typeof opt.label !== "string" || opt.label.length === 0) continue;
    out.push({ id: opt.id, label: opt.label });
  }
  return out;
}

/** Blocks format: `doc.blocks[]` with `kind === "poll"` — top-level only,
 *  matching `pollBlocksOf` (poll blocks are never nested inside a card or a
 *  columns block in the block model, so this doesn't need to recurse). */
function pollNodesFromBlocksDoc(doc: Record<string, unknown>): NormalizedPoll[] {
  const blocks = doc.blocks;
  if (!Array.isArray(blocks)) return [];
  const out: NormalizedPoll[] = [];
  for (const block of blocks) {
    if (!isPlainObject(block)) continue;
    if (block.kind !== "poll") continue;
    if (typeof block.id !== "string" || block.id.length === 0) continue;
    if (typeof block.question !== "string") continue;
    const options = normalizePollOptions(block.options);
    if (!options) continue;
    out.push({ id: block.id, question: block.question, options });
  }
  return out;
}

/** Tiptap format: walk the tree for `pwPoll` nodes at any depth (a poll can
 *  sit inside a `section`/`columns` layout, unlike the block format). Bounded
 *  by a generous fixed depth (not `EMAIL_TIPTAP_MAX_DEPTH` — this is a READ
 *  helper that must stay usable on documents that predate today's caps, so
 *  it uses its own, purely-a-stack-overflow-guard bound) rather than
 *  rejecting anything; a doc past that bound simply stops yielding polls
 *  from beyond it. */
function pollNodesFromTiptapDoc(doc: Record<string, unknown>): NormalizedPoll[] {
  const out: NormalizedPoll[] = [];
  const MAX_WALK_DEPTH = 64;

  function walk(node: unknown, depth: number): void {
    if (depth > MAX_WALK_DEPTH) return;
    if (!isPlainObject(node)) return;
    if (node.type === "pwPoll") {
      const attrs = isPlainObject(node.attrs) ? node.attrs : {};
      if (typeof attrs.id === "string" && attrs.id.length > 0 && typeof attrs.question === "string") {
        const options = normalizePollOptions(attrs.options);
        if (options) out.push({ id: attrs.id, question: attrs.question, options });
      }
    }
    const content = node.content;
    if (Array.isArray(content)) {
      for (const child of content) walk(child, depth + 1);
    }
  }

  walk(doc, 0);
  return out;
}

/**
 * Find every poll in a campaign doc of EITHER format, normalized to one
 * shape regardless of source. Returns `[]` for anything that isn't a
 * recognizable doc of either format (including `null`/non-object input) —
 * total, never throws.
 */
export function findPollNodes(doc: unknown): NormalizedPoll[] {
  if (!isPlainObject(doc)) return [];
  if (Array.isArray(doc.blocks)) return pollNodesFromBlocksDoc(doc);
  if (doc.type === "doc" && Array.isArray(doc.content)) return pollNodesFromTiptapDoc(doc);
  return [];
}
