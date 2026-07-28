/**
 * The markdown SUBSET a campaign email understands, parsed once into a tree.
 *
 * The subset is deliberately tiny (`emailBlocks.ts` states it as the
 * contract): `**bold**`, `*italic*`, `[text](url)`, blank-line-separated
 * paragraphs, and `- ` list lines. Nothing else.
 *
 * ── Why a tree, rather than a string of HTML ───────────────────────────────
 * There are two renderers of the same document now — the send-ready HTML
 * (`emailRender.ts`) and the designer's on-canvas one, which draws React
 * Native `<Text>` runs and has no HTML to emit. Parsing twice is how "bold
 * looks bold in the editor but not in the inbox" happens. So the PARSE lives
 * here, once, and each renderer only walks the result.
 *
 * The nesting is real (`**bold *italic* text**` is an `em` inside a `strong`)
 * because both consumers need it: HTML nests elements, and RN nests `<Text>`.
 *
 * Zero dependencies — same portability contract as the rest of the email
 * layer (Convex V8, vitest, jest, Expo).
 */

/** One inline run. `text` carries no markup; the others wrap children. */
export type MarkdownInlineNode =
  | { kind: "text"; text: string }
  | { kind: "strong"; children: MarkdownInlineNode[] }
  | { kind: "em"; children: MarkdownInlineNode[] }
  | { kind: "link"; href: string; children: MarkdownInlineNode[] };

/** One block. A `list` is a run of consecutive `- ` lines; everything else
 *  between blank lines is a paragraph. */
export type MarkdownSubsetBlock =
  | { kind: "paragraph"; content: MarkdownInlineNode[] }
  | { kind: "list"; items: MarkdownInlineNode[][] };

/**
 * One level of parenthesis-nesting inside a link URL — `[^()\s]` handles the
 * ordinary case, `\([^()]*\)` lets a single balanced `(...)` pass through
 * (e.g. a Wikipedia-style `https://en.wikipedia.org/wiki/Foo_(bar)`), which a
 * plain `[^)]+` truncates at the URL's own first `)`.
 */
const LINK_RE = /\[([^\]]+)\]\(((?:[^()\s]|\([^()]*\))+)\)/g;

/**
 * Bold runs BEFORE italic, and non-greedily across ANY character (not just
 * non-`*` ones) — a greedy/`[^*]+`-style bold match can't span an embedded
 * single-`*` italic run (`**bold *italic* text**`: the content between the
 * outer `**` pair contains `*` characters a `[^*]+` class excludes), so it
 * simply fails to match and the whole thing falls through unrendered.
 */
const BOLD_RE = /\*\*(.+?)\*\*/g;
const ITALIC_RE = /\*([^*]+)\*/g;

/** Split `text` on `re`, mapping each match through `onMatch` and every gap
 *  through `onText`. Shared by all three inline passes, which differ only in
 *  what they build. */
function splitOn(
  text: string,
  re: RegExp,
  onMatch: (match: RegExpExecArray) => MarkdownInlineNode,
  onText: (chunk: string) => MarkdownInlineNode[],
): MarkdownInlineNode[] {
  // A fresh RegExp per call: the module-level literals carry the `g` flag and
  // therefore `lastIndex` state, which a nested/recursive parse would corrupt.
  const scanner = new RegExp(re.source, re.flags);
  const out: MarkdownInlineNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = scanner.exec(text)) !== null) {
    if (match.index > cursor) out.push(...onText(text.slice(cursor, match.index)));
    out.push(onMatch(match));
    cursor = match.index + match[0].length;
    // Zero-length matches can't happen with these patterns, but a guard here
    // is what stops a future pattern change from spinning forever.
    if (match[0].length === 0) scanner.lastIndex += 1;
  }
  if (cursor < text.length) out.push(...onText(text.slice(cursor)));
  return out;
}

function parseItalic(text: string): MarkdownInlineNode[] {
  if (text === "") return [];
  return splitOn(
    text,
    ITALIC_RE,
    (m) => ({ kind: "em", children: [{ kind: "text", text: m[1] }] }),
    (chunk) => (chunk === "" ? [] : [{ kind: "text", text: chunk }]),
  );
}

function parseEmphasis(text: string): MarkdownInlineNode[] {
  if (text === "") return [];
  return splitOn(
    text,
    BOLD_RE,
    (m) => ({ kind: "strong", children: parseItalic(m[1]) }),
    parseItalic,
  );
}

/**
 * Parse one line of inline markdown.
 *
 * Links are matched FIRST, on the whole line, so a URL's own punctuation can
 * never be mistaken for emphasis; the link's LABEL is then parsed for
 * emphasis, which is what makes `[**Give**](https://…)` bold.
 */
export function parseInlineMarkdown(text: string): MarkdownInlineNode[] {
  if (text === "") return [];
  return splitOn(
    text,
    LINK_RE,
    (m) => ({ kind: "link", href: m[2], children: parseEmphasis(m[1]) }),
    parseEmphasis,
  );
}

/**
 * Parse the block structure: paragraphs, and runs of `- ` lines as one list.
 *
 * Lines inside a paragraph are joined with a SPACE rather than kept as
 * separate lines, because that is what every mail client does with wrapped
 * text — and because the designer's own copy is written with soft wraps she
 * does not mean as line breaks.
 */
export function parseMarkdownSubset(text: string): MarkdownSubsetBlock[] {
  const out: MarkdownSubsetBlock[] = [];
  let paraLines: string[] = [];
  let listItems: string[] = [];

  const flushPara = () => {
    if (paraLines.length === 0) return;
    out.push({ kind: "paragraph", content: parseInlineMarkdown(paraLines.join(" ")) });
    paraLines = [];
  };
  const flushList = () => {
    if (listItems.length === 0) return;
    out.push({ kind: "list", items: listItems.map((i) => parseInlineMarkdown(i)) });
    listItems = [];
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") {
      flushPara();
      flushList();
      continue;
    }
    if (line.startsWith("- ")) {
      flushPara();
      listItems.push(line.slice(2));
      continue;
    }
    flushList();
    paraLines.push(line);
  }
  flushPara();
  flushList();
  return out;
}

/** The parsed text with every mark stripped — what a plaintext part, an
 *  accessibility label, or a one-line summary needs. */
export function markdownSubsetToPlainSpans(nodes: MarkdownInlineNode[]): string {
  return nodes
    .map((n) => (n.kind === "text" ? n.text : markdownSubsetToPlainSpans(n.children)))
    .join("");
}
