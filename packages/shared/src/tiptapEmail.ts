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
 *     negative number, a non-integer) used to make that lookup `undefined`
 *     and the destructure throw (the actual bug this check was written to
 *     catch, found while vendoring — see `maily.tsx`'s own "DEVIATION FROM
 *     UPSTREAM" note on `heading()`). The vendored renderer now CLAMPS the
 *     coerced level to `{1,2,3}` before it becomes a lookup key, so an
 *     out-of-range level no longer actually throws — `headingLevelIsSafe`
 *     below is defense-in-depth over a fixed bug now, not the only thing
 *     standing between a bad doc and a crash, but it still mirrors maily's
 *     own `Number(level) || 1` coercion exactly, so it keeps rejecting
 *     precisely the inputs the renderer has to clamp rather than a stricter
 *     (or looser) set.
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
 *   - `doc.attrs.pwCanvasColor` (WS4, fidelity gap 2 fix): the page-canvas
 *     colour behind the 600px container. Themes-the-system are dead (a
 *     founder decision — see `renderEmailTiptap`'s doc, `email-render/src/
 *     renderEmail.ts`) so this colour lives IN THE DOCUMENT, not a theme
 *     table, which means it is now authored data that reaches a real CSS
 *     `background` — the same class of write-gate concern as an href/src,
 *     just for a colour instead of a URL. A non-hex string here wouldn't
 *     throw at render (`renderEmailTiptap` treats an invalid value as
 *     "absent", see that function's doc) but WOULD silently paint nothing
 *     while the author believed they'd set a page colour, so it's rejected
 *     loudly here instead — same "fail at save time, not send time"
 *     reasoning as every other check in this file.
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
 * defense-in-depth; the tiptap render side has its own equivalent
 * (`packages/email-render/src/urlSanitize.ts`'s `safeRenderHref`/
 * `safeRenderImageSrc`) — ONE chokepoint every href/src-bearing sink in
 * `maily.tsx` passes through post-resolution, not just `pwBleedImage` (which
 * is where this pattern started, before a 2026-07-29 adversarial review found
 * every OTHER sink lacked it — see that file's module doc for the full
 * story, including the reason this matters MORE for the tiptap format than
 * the check right above it looks like it should: an `isXVariable`-flagged
 * attr holds a variable NAME here, not a URL, so THIS gate below correctly
 * has nothing to check for it — the render-time chokepoint is where that
 * variable's resolved value is actually checked).
 */

import { MAX_POLL_OPTIONS, MIN_POLL_OPTIONS } from "./emailBlocks";
import { isPwFontStackId } from "./emailFont";
import { isHexColor } from "./emailTheme";

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

// A node/mark COUNT cap (above) bounds how many strings a doc can carry, but
// says nothing about how LONG any one of them is — a single 10MB `text` node
// sails through `EMAIL_TIPTAP_MAX_NODES` (it's one node), and 2000 of them
// (the max the count cap allows) would be a 20GB byte bomb. Three caps close
// that gap, all enforced by `validateTiptapEmailDoc` (never by a per-node
// helper alone, so nothing can be reached by a path that skips it):
//   - `EMAIL_TIPTAP_MAX_TEXT_LENGTH`: a single `text` node's `text` string.
//     Generous — the newsletter's longest single run of unbroken prose is
//     nowhere near this; a legitimate author never approaches it, only a
//     hostile doc does.
//   - `EMAIL_TIPTAP_MAX_ATTR_STRING_LENGTH`: any OTHER authored string this
//     file's checks touch — an href/src, a poll question or option label, a
//     button's text, a hex colour, `letterSpacing`, etc. Tighter than the
//     text cap on purpose: none of these are prose: a URL, a button label, a
//     poll question have no legitimate reason to run tens of thousands of
//     characters, and a generous cap here would leave the "many small attrs"
//     byte-bomb shape (thousands of nodes, each with a few near-cap attr
//     strings) nearly as open as no cap at all.
//   - `EMAIL_TIPTAP_MAX_SERIALIZED_BYTES`: the whole document, checked FIRST
//     (before the per-node walk even starts) via `JSON.stringify(doc).length`
//     — an approximation of byte size (UTF-16 code units, not UTF-8 bytes;
//     exact for the ASCII-heavy content real campaigns author, and "how many
//     bytes did this multi-byte character actually cost" is not a
//     distinction that matters for a byte-bomb defense) that costs one
//     allocation proportional to the ATTACK's own size, not the cap — a
//     10MB-text-node doc fails this check after one `JSON.stringify`, never
//     reaching the recursive node walk at all. This is the one check in this
//     file that runs before, not during, that walk, specifically so a byte
//     bomb is rejected in time proportional to itself rather than to
//     `EMAIL_TIPTAP_MAX_NODES` node-visits over a multi-megabyte string.
export const EMAIL_TIPTAP_MAX_TEXT_LENGTH = 20_000;
export const EMAIL_TIPTAP_MAX_ATTR_STRING_LENGTH = 2_000;
export const EMAIL_TIPTAP_MAX_SERIALIZED_BYTES = 1_000_000;

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

/** A single string-length check, shared by every call site below so the cap
 *  can only ever mean one thing. `label` is just for the error message. */
function checkStringLength(value: string, max: number, path: string, label: string): string | null {
  if (value.length > max) {
    return `${path}: "${label}" exceeds max length (${max} chars)`;
  }
  return null;
}

/**
 * Cap every STRING-valued entry directly on `attrs` (one level, not
 * recursive — nested string-bearing structures, e.g. `pwPoll`'s `options`
 * array, are capped by their own dedicated check, since a generic walk here
 * can't tell "an authored string" from "a structural key" once attrs nest).
 * Deliberately generic rather than an explicit list of known attr names: a
 * new node-pack attr that carries a string is caught by this the moment it's
 * added, with no second place to remember to update.
 */
function checkAttrStringLengths(attrs: Record<string, unknown>, path: string): string | null {
  for (const [key, value] of Object.entries(attrs)) {
    if (typeof value !== "string") continue;
    const err = checkStringLength(value, EMAIL_TIPTAP_MAX_ATTR_STRING_LENGTH, path, key);
    if (err) return err;
  }
  return null;
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
 *  is exactly what the renderer's OWN clamp now catches before its
 *  `headings[level]` lookup (see `maily.tsx`'s "DEVIATION FROM UPSTREAM"
 *  note on `heading()` — an out-of-range level used to make that lookup
 *  destructure `undefined` and throw; it no longer does, because the
 *  renderer clamps first). This check is defense-in-depth over that FIXED
 *  bug, not a guard against a live crash — kept strict (rejecting at write
 *  time exactly what the renderer would otherwise have to silently
 *  reinterpret at render time) rather than loosened to match the renderer's
 *  now-safe fallback, so an author sees a clear validation error instead of
 *  a silently-substituted heading level. `undefined` itself is safe (coerces
 *  to the default, 1). */
function headingLevelIsSafe(level: unknown): boolean {
  if (level === undefined) return true;
  const n = Number(level) || 1;
  return VALID_HEADING_LEVELS.has(n);
}

function validatePwPollAttrs(attrs: Record<string, unknown>, path: string): string | null {
  if (typeof attrs.id !== "string" || attrs.id.length === 0) {
    return `${path}: pwPoll "id" must be a non-empty string`;
  }
  let err = checkStringLength(attrs.id, EMAIL_TIPTAP_MAX_ATTR_STRING_LENGTH, path, "id");
  if (err) return err;
  if (typeof attrs.question !== "string" || attrs.question.length === 0) {
    return `${path}: pwPoll "question" must be a non-empty string`;
  }
  err = checkStringLength(attrs.question, EMAIL_TIPTAP_MAX_ATTR_STRING_LENGTH, path, "question");
  if (err) return err;
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
    err = checkStringLength(opt.id, EMAIL_TIPTAP_MAX_ATTR_STRING_LENGTH, `${path} options[${i}]`, "id");
    if (err) return err;
    err = checkStringLength(opt.label, EMAIL_TIPTAP_MAX_ATTR_STRING_LENGTH, `${path} options[${i}]`, "label");
    if (err) return err;
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
  const lengthErr = checkAttrStringLengths(attrs, path);
  if (lengthErr) return lengthErr;
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

  // `pwPoll`'s attr strings (id/question/option id/label) are capped inside
  // `validatePwPollAttrs` itself, at the tighter per-field granularity a
  // generic top-level walk can't reach (`options` is an array, not a
  // string) — skip the generic pass for this node type so its `options`
  // array isn't silently ignored by `checkAttrStringLengths` in a way that
  // reads as "checked" when only the shallow attrs were.
  if (node.type !== "pwPoll") {
    const attrLengthErr = checkAttrStringLengths(attrs, `${path} (${node.type})`);
    if (attrLengthErr) return attrLengthErr;
  }

  if (node.text !== undefined && typeof node.text !== "string") {
    return `${path}: "text" must be a string`;
  }
  if (typeof node.text === "string") {
    const textLengthErr = checkStringLength(node.text, EMAIL_TIPTAP_MAX_TEXT_LENGTH, path, "text");
    if (textLengthErr) return textLengthErr;
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
 * Doc-level `attrs` — NOT a node, so `validateNode`'s per-node walk never
 * touches this; it is checked once, directly on the top-level `doc` object.
 * The two doc-level attrs the write gate knows about today are
 * `pwCanvasColor` (see this file's module doc, the `doc.attrs.pwCanvasColor`
 * bullet) and `pwFontFamily` (founder bug #5, `emailFont.ts`) —
 * `undefined`/absent is fine for both (today's defaults, `renderEmailTiptap`'s
 * documented behavior); present-but-invalid is rejected outright rather than
 * silently ignored, so a typo'd colour or an unknown font id fails loud at
 * save time instead of quietly not applying at send time.
 *
 * `null` is treated exactly like `undefined` (not "invalid, reject") for
 * BOTH — not a defensive nicety, a required one:
 * `MailyDocumentHost.web.tsx`'s `PwDocAttrsExtension` declares both as
 * ProseMirror global attrs with `default: null` so they survive an editor
 * round-trip at all (see that file's own doc) — which means EVERY doc that
 * ever passes through the real editor and gets `editor.getJSON()`'d comes
 * back with `attrs: { pwCanvasColor: null, pwFontFamily: null }` explicitly
 * present, not simply omitted, the instant neither has been set. Rejecting
 * `null` here would mean no tiptap document could ever be saved through the
 * real editor at all — caught by this file's own test the moment the two
 * attrs were declared as real schema attrs (`pwDocAttrs.test.ts`).
 */
function validateDocAttrs(attrs: Record<string, unknown>): string | null {
  if (attrs.pwCanvasColor !== undefined && attrs.pwCanvasColor !== null) {
    if (typeof attrs.pwCanvasColor !== "string" || !isHexColor(attrs.pwCanvasColor)) {
      return '"attrs.pwCanvasColor" must be a hex colour like #f0f1f5';
    }
  }
  // `pwFontFamily` (WS4, founder bug #5 — document-level font, no theme
  // system): an ALLOWLIST of stack IDs, not a free-text font name — see
  // `emailFont.ts`'s module doc for why arbitrary input is rejected outright
  // rather than passed through.
  if (
    attrs.pwFontFamily !== undefined &&
    attrs.pwFontFamily !== null &&
    !isPwFontStackId(attrs.pwFontFamily)
  ) {
    return '"attrs.pwFontFamily" must be one of the known font stacks';
  }
  return null;
}

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

  // The total-size cap — deliberately BEFORE the per-node walk below, not
  // after (see `EMAIL_TIPTAP_MAX_SERIALIZED_BYTES`'s own comment): a
  // multi-megabyte doc is rejected in one `JSON.stringify` + length check,
  // never reaching a per-node/per-attr walk over that much data at all.
  //
  // `JSON.stringify` is itself capable of throwing — a cyclic object graph
  // (`TypeError: Converting circular structure to JSON`) or a doc nested tens
  // of thousands of levels deep (`RangeError: Maximum call stack size
  // exceeded`, from `JSON.stringify`'s OWN recursion, which has no depth cap
  // of its own — reached before `validateNode`'s bounded walk below ever
  // gets a turn). Both are exactly the hostile shapes `EMAIL_TIPTAP_MAX_DEPTH`
  // exists to reject, just reached one line earlier than that check now that
  // this size check runs first — so both are caught here and folded into an
  // ordinary `{ ok: false }`, keeping this function TOTAL (see its own doc)
  // rather than letting the size check's own implementation detail become a
  // new way to throw that `EMAIL_TIPTAP_MAX_DEPTH` no longer fully covers.
  try {
    if (JSON.stringify(doc).length > EMAIL_TIPTAP_MAX_SERIALIZED_BYTES) {
      return { ok: false, error: `document exceeds max serialized size (${EMAIL_TIPTAP_MAX_SERIALIZED_BYTES} bytes)` };
    }
  } catch {
    return { ok: false, error: "document could not be measured (too deep or cyclic)" };
  }

  if (doc.attrs !== undefined) {
    if (!isPlainObject(doc.attrs)) return { ok: false, error: '"attrs" must be an object' };
    const attrsErr = validateDocAttrs(doc.attrs);
    if (attrsErr) return { ok: false, error: attrsErr };
  }

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
