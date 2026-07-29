/**
 * THE PUBLIC WORSHIP NODE PACK — the editor-extension half the plan doc
 * promised and the maily overhaul never actually shipped
 * (`docs/plans/maily-editor-overhaul.md`, "The Public Worship node pack":
 * "Each gap = an editor extension (real API) + a render method (ours now)").
 * `packages/email-render/src/maily.tsx` got its four render methods
 * (`pwHeading`/`pwParagraph`/`pwBleedImage`/`pwPoll`) for the SEND path; this
 * file is the missing other half, for the EDIT path.
 *
 * ── The bug this fixes ──────────────────────────────────────────────────────
 * `@maily-to/core`'s `<Editor>` is real Tiptap/ProseMirror: it only recognizes
 * node TYPES an actual `Node` extension registered. `MailyDocumentHost.web
 * .tsx` never passed these four types into `<Editor extensions={...}>`, so
 * the built-in "Monthly newsletter" — built almost entirely from `pwHeading`/
 * `pwParagraph`/`pwBleedImage` nodes (`tiptapNewsletterTemplate.ts`) — hit
 * `@tiptap/core`'s `createDocument` → `schema.nodeFromJSON`, which THROWS
 * `RangeError: Unknown node type: pwBleedImage` on the very first node.
 * Tiptap catches that internally (`createNodeFromContent`'s try/catch),
 * `console.warn`s, and silently falls back to `createNodeFromContent('',
 * schema, options)` — an EMPTY document. One unrecognized node type discards
 * the WHOLE doc, with no visible error: exactly "opened the built-in template
 * and it was blank." Proven in `pwNodePack.test.ts` by building the schema
 * with and without this file's extensions and parsing the real shipped
 * newsletter doc through both.
 *
 * ── Why plain `renderHTML`, no NodeView ─────────────────────────────────────
 * These four nodes need to ROUND-TRIP (load without crashing, save back out
 * unchanged) and look reasonably close to the shipped design — not full
 * click-to-edit chrome (a poll's per-option editing UI, a heading's own
 * floating toolbar) on day one. A `renderHTML`-only `Node` is exactly what
 * `pwParagraph`'s and `pwHeading's render-side twins already do: paint from
 * attrs, no interactive affordance beyond what ProseMirror gives inline
 * content for free (`pwHeading`/`pwParagraph` are NOT atoms — their text is
 * still directly editable in place; only `pwBleedImage`/`pwPoll`, which carry
 * no free-text ProseMirror content, are atoms). A richer NodeView (drag to
 * resize, a poll option editor) is real future work, not required to close
 * this defect.
 *
 * ── Attr fidelity ────────────────────────────────────────────────────────────
 * Every attr `tiptapNewsletterTemplate.ts` actually authors (see that file)
 * is declared here, so nothing gets silently dropped the way an undeclared
 * ProseMirror node/mark attr always is (`textStyle`'s `letterSpacing` already
 * demonstrates that failure mode in isolation — see this file's own test for
 * the proof). Numbers/strings mirror `maily.tsx`'s own fallback rules
 * (`lineHeight`: bare string/number passed through unitless, matching the
 * unitless ratios `emailGeometry.ts` authors; `fontSize`: number → `px`)
 * so the EDITOR's paint and the SEND renderer's paint read the same attrs the
 * same way.
 */
import { Node, mergeAttributes } from "@tiptap/core";

// ── Shared helpers ───────────────────────────────────────────────────────────

/** Build a CSS `style` attribute value from a sparse style map, dropping any
 *  unset entry — mirrors `maily.tsx`'s own "only set what's authored" rule
 *  for these same nodes. */
function styleAttr(style: Record<string, string | undefined>): string {
  return Object.entries(style)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0)
    .map(([key, value]) => `${key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}:${value}`)
    .join(";");
}

/** `fontSize`'s number → `px` rule, shared by `pwHeading`/`pwParagraph` — the
 *  exact coercion `maily.tsx`'s own methods apply. */
function pxOrUndefined(value: unknown): string | undefined {
  return typeof value === "number" ? `${value}px` : undefined;
}

/** `lineHeight`'s pass-through rule (unitless ratio strings like `"1.06"`,
 *  matching `emailGeometry.ts`'s authored values) — same coercion as
 *  `maily.tsx`'s `pwHeading`/`pwParagraph`. */
function lineHeightOrUndefined(value: unknown): string | undefined {
  if (typeof value === "number") return `${value}px`;
  if (typeof value === "string" && value.length > 0) return value;
  return undefined;
}

const VALID_PW_HEADING_LEVELS = new Set([1, 2, 3]);

// ── pwHeading ────────────────────────────────────────────────────────────────

export const PwHeadingExtension = Node.create({
  name: "pwHeading",
  group: "block",
  content: "inline*",
  addAttributes() {
    return {
      level: { default: 2 },
      fontSize: { default: null },
      lineHeight: { default: null },
      letterSpacing: { default: null },
      color: { default: null },
      textAlign: { default: null },
    };
  },
  parseHTML() {
    return [{ tag: "div[data-pw-heading]" }];
  },
  renderHTML({ node, HTMLAttributes }) {
    const attrs = node.attrs as {
      level: unknown;
      fontSize: unknown;
      lineHeight: unknown;
      letterSpacing: unknown;
      color: unknown;
      textAlign: unknown;
    };
    const level = VALID_PW_HEADING_LEVELS.has(Number(attrs.level)) ? Number(attrs.level) : 2;
    const style = styleAttr({
      fontSize: pxOrUndefined(attrs.fontSize),
      lineHeight: lineHeightOrUndefined(attrs.lineHeight),
      letterSpacing: typeof attrs.letterSpacing === "string" ? attrs.letterSpacing : undefined,
      color: typeof attrs.color === "string" ? attrs.color : undefined,
      textAlign: typeof attrs.textAlign === "string" ? attrs.textAlign : undefined,
    });
    return [
      `h${level}`,
      mergeAttributes(HTMLAttributes, { "data-pw-heading": "true", style }),
      0,
    ];
  },
});

// ── pwParagraph ──────────────────────────────────────────────────────────────

export const PwParagraphExtension = Node.create({
  name: "pwParagraph",
  group: "block",
  content: "inline*",
  addAttributes() {
    return {
      fontSize: { default: null },
      lineHeight: { default: null },
      textAlign: { default: null },
    };
  },
  parseHTML() {
    return [{ tag: "p[data-pw-paragraph]" }];
  },
  renderHTML({ node, HTMLAttributes }) {
    const attrs = node.attrs as { fontSize: unknown; lineHeight: unknown; textAlign: unknown };
    const style = styleAttr({
      fontSize: pxOrUndefined(attrs.fontSize),
      lineHeight: lineHeightOrUndefined(attrs.lineHeight),
      textAlign: typeof attrs.textAlign === "string" ? attrs.textAlign : undefined,
    });
    return ["p", mergeAttributes(HTMLAttributes, { "data-pw-paragraph": "true", style }), 0];
  },
});

// ── pwBleedImage ─────────────────────────────────────────────────────────────
// Atom (no ProseMirror content) — the edge-to-edge banner image. Ships with an
// empty `src` until artwork import fills it (`fillTiptapArtwork`); rendered as
// a plain placeholder block in that case, same intent as the send-side
// renderer's dashed "Artwork slot" band (`maily.tsx`'s `pwBleedImage`).

export const PwBleedImageExtension = Node.create({
  name: "pwBleedImage",
  group: "block",
  atom: true,
  addAttributes() {
    return {
      src: { default: "" },
      alt: { default: "" },
      pwSlot: { default: null },
      href: { default: null },
    };
  },
  parseHTML() {
    return [{ tag: "img[data-pw-bleed-image]" }, { tag: "div[data-pw-bleed-image]" }];
  },
  renderHTML({ node }) {
    const attrs = node.attrs as { src: unknown; alt: unknown; pwSlot: unknown };
    const src = typeof attrs.src === "string" ? attrs.src : "";
    const alt = typeof attrs.alt === "string" ? attrs.alt : "";
    if (!src) {
      return [
        "div",
        {
          "data-pw-bleed-image": "true",
          "data-pw-slot": typeof attrs.pwSlot === "string" ? attrs.pwSlot : "",
          style: styleAttr({
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "24px",
            background: "#F3F4F6",
            color: "#6B7280",
            fontSize: "13px",
            fontWeight: "600",
            textTransform: "uppercase",
            letterSpacing: "0.08em",
          }),
        },
        alt || "Artwork slot",
      ];
    }
    return [
      "img",
      {
        "data-pw-bleed-image": "true",
        "data-pw-slot": typeof attrs.pwSlot === "string" ? attrs.pwSlot : "",
        src,
        alt,
        style: styleAttr({ display: "block", width: "100%", height: "auto" }),
      },
    ];
  },
});

// ── pwPoll ───────────────────────────────────────────────────────────────────
// Atom — question + options, read-only in the editor for now (voting only
// ever happens post-send, per-recipient — see `maily.tsx`'s `pwPoll` doc).
// `options` is the one non-primitive attr this pack carries; it round-trips
// through JSON (`Node.fromJSON`/`toJSON`) without needing a DOM attribute
// mapping at all, so no `parseHTML`/`renderHTML` per-attribute pair is
// required for the load-without-crashing fix this file exists for — only for
// copy/paste, which polls don't need yet.

type PwPollOption = { id: string; label: string };

export const PwPollExtension = Node.create({
  name: "pwPoll",
  group: "block",
  atom: true,
  addAttributes() {
    return {
      id: { default: "" },
      question: { default: "" },
      options: { default: [] as PwPollOption[] },
    };
  },
  renderHTML({ node }) {
    const attrs = node.attrs as { question: unknown; options: unknown };
    const question = typeof attrs.question === "string" ? attrs.question : "";
    const options = Array.isArray(attrs.options) ? (attrs.options as PwPollOption[]) : [];
    return [
      "div",
      {
        "data-pw-poll": "true",
        style: styleAttr({
          border: "1px solid #E5E7EB",
          borderRadius: "8px",
          padding: "16px",
        }),
      },
      ["p", { style: styleAttr({ fontWeight: "700", margin: "0 0 8px 0" }) }, question],
      ...options
        .filter((opt): opt is PwPollOption => typeof opt?.label === "string")
        .map((opt) => [
          "div",
          { style: styleAttr({ padding: "8px 12px", border: "1px solid #E5E7EB", borderRadius: "8px", marginTop: "6px" }) },
          opt.label,
        ]),
    ];
  },
});

/** Every Public Worship node-pack extension, in one place — pass this into
 *  `<Editor extensions={...}>` alongside whatever else the host needs
 *  (`MailyDocumentHost.web.tsx`). Kept as a single array (not exported
 *  individually for ad-hoc assembly) because these four ship as one unit:
 *  the built-in newsletter uses all four, and a doc missing even one still
 *  hits the exact "unknown node type" failure this pack exists to close. */
export const PW_NODE_PACK_EXTENSIONS = [
  PwHeadingExtension,
  PwParagraphExtension,
  PwBleedImageExtension,
  PwPollExtension,
];
