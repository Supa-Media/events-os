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
 *
 * `[\s\S]` rather than `.` so a pair can close on a LATER LINE. The visual
 * renderers never see a newline (paragraph lines are joined with a space
 * before they get here), but the plaintext part parses a whole block at once,
 * and a `.`-based pattern made it disagree with the HTML part about
 * `**bold` / `still bold**` — one email, two different answers.
 */
const BOLD_RE = /\*\*([\s\S]+?)\*\*/g;
const ITALIC_RE = /\*([^*]+)\*/g;

/**
 * The stand-in character for "text that is spoken for" while scanning.
 *
 * Masking preserves LENGTH, so every index found in a masked string is an
 * index into the original — that positional identity is the whole trick (see
 * `parseInlineMarkdown`). It only ever needs to be a character that is not
 * `*`, so it cannot create or complete an emphasis pair; a space that was
 * already in the author's text is therefore harmless, because the mask is
 * used to LOCATE delimiters and never to produce output.
 */
const MASK = " ";

/** One matched construct, as a range over the ORIGINAL text. */
type MarkdownSpan = {
  start: number;
  end: number;
  /** The sub-range that becomes this node's children, or `null` for a node
   *  that parses its own (a link's label). */
  inner: readonly [number, number] | null;
  wrap: (children: MarkdownInlineNode[]) => MarkdownInlineNode;
};

/** Every match of `re` in `text`. A fresh RegExp per call: the module-level
 *  literals carry the `g` flag and therefore `lastIndex` state, which a
 *  nested/recursive parse would corrupt. */
function matchAll(text: string, re: RegExp): RegExpExecArray[] {
  const scanner = new RegExp(re.source, re.flags);
  const out: RegExpExecArray[] = [];
  let match: RegExpExecArray | null;
  while ((match = scanner.exec(text)) !== null) {
    out.push(match);
    // Zero-length matches can't happen with these patterns, but a guard here
    // is what stops a future pattern change from spinning forever.
    if (match[0].length === 0) scanner.lastIndex += 1;
  }
  return out;
}

/** `text` with `[from, to)` replaced by the same number of `MASK` characters. */
function maskRange(text: string, from: number, to: number): string {
  return text.slice(0, from) + MASK.repeat(to - from) + text.slice(to);
}

/** Do `a` and `b` overlap without either containing the other? Two such
 *  ranges cannot both become elements — one of them has to lose. */
function crosses(a: MarkdownSpan, b: readonly [number, number]): boolean {
  return (a.start < b[0] && a.end > b[0] && a.end < b[1]) ||
    (a.start > b[0] && a.start < b[1] && a.end > b[1]);
}

/**
 * Turn a set of properly-nested spans into the tree, left to right.
 *
 * `spans` is sorted outermost-first, so a span nested inside one already
 * emitted starts before the cursor and is skipped here — the recursive call
 * for that parent's `inner` range is what picks it up.
 */
function buildNodes(
  text: string,
  lo: number,
  hi: number,
  spans: readonly MarkdownSpan[],
): MarkdownInlineNode[] {
  const out: MarkdownInlineNode[] = [];
  let cursor = lo;
  for (const span of spans) {
    if (span.start < cursor || span.start < lo || span.end > hi) continue;
    if (span.start > cursor) out.push({ kind: "text", text: text.slice(cursor, span.start) });
    out.push(span.wrap(span.inner ? buildNodes(text, span.inner[0], span.inner[1], spans) : []));
    cursor = span.end;
  }
  if (cursor < hi) out.push({ kind: "text", text: text.slice(cursor, hi) });
  return out;
}

/**
 * Parse inline markdown: links, then bold, then italic.
 *
 * ── Why positions, and not a chain of string splits ────────────────────────
 * The obvious shape — split on links, parse emphasis in each gap — cannot
 * render `**[Give now](https://…)**`, because the two halves of that `**`
 * pair land in DIFFERENT gaps and never meet. Real copy is written that way
 * ("Read **[the full story](…)** before Sunday"), and the failure is silent:
 * literal asterisks ship to the inbox. Splitting the other way round is worse
 * — emphasis first would consume the `**` inside `[**Give**](…)` before the
 * link is even recognised.
 *
 * So nothing is split. Each pass scans a MASKED COPY of the text — same
 * length, with everything already claimed replaced by `MASK` — and records
 * the ranges it matched. Because masking preserves length, those ranges are
 * ranges of the original text, and the passes compose:
 *
 *  1. Links are matched first and masked whole, so a `*` inside a URL cannot
 *     become emphasis (it used to inject `<em>` into the `href`) and a `**`
 *     inside a label cannot pair with one outside it (which used to emit
 *     overlapping, malformed tags). A link is ATOMIC to the passes below it,
 *     but its label is re-parsed on its own — that is what keeps
 *     `[**Give**](…)` bold.
 *  2. Bold is matched over that, so a `**` pair spans a link node freely.
 *  3. Italic is matched over the text with bold's DELIMITERS masked too —
 *     which is how the outer pair of `*a **b** c*` still finds itself.
 *
 * Ranges from steps 2 and 3 nest properly, since an italic delimiter can
 * never sit on a masked (link or bold-delimiter) character. The pathological
 * exception is a genuinely crossing pair like `*a **b* c**`, where the older
 * renderer emitted interleaved `<em>`/`<strong>` tags that no mail client
 * agrees on; the italic loses, and its asterisks stay literal.
 */
export function parseInlineMarkdown(text: string): MarkdownInlineNode[] {
  if (text === "") return [];
  const spans: MarkdownSpan[] = [];

  let masked = text;
  for (const m of matchAll(text, LINK_RE)) {
    const [label, href] = [m[1], m[2]];
    const start = m.index;
    const end = start + m[0].length;
    // A label is `[^\]]+`, so it cannot itself contain a complete link — the
    // recursion is bounded and always on a strictly shorter string.
    spans.push({
      start,
      end,
      inner: null,
      wrap: () => ({ kind: "link", href, children: parseInlineMarkdown(label) }),
    });
    masked = maskRange(masked, start, end);
  }

  let postBold = masked;
  const boldRanges: (readonly [number, number])[] = [];
  for (const m of matchAll(masked, BOLD_RE)) {
    const start = m.index;
    const end = start + m[0].length;
    boldRanges.push([start, end]);
    spans.push({
      start,
      end,
      inner: [start + 2, end - 2],
      wrap: (children) => ({ kind: "strong", children }),
    });
    postBold = maskRange(maskRange(postBold, start, start + 2), end - 2, end);
  }

  for (const m of matchAll(postBold, ITALIC_RE)) {
    const start = m.index;
    const end = start + m[0].length;
    const span: MarkdownSpan = {
      start,
      end,
      inner: [start + 1, end - 1],
      wrap: (children) => ({ kind: "em", children }),
    };
    if (boldRanges.some((b) => crosses(span, b))) continue;
    spans.push(span);
  }

  // Outermost first, so `buildNodes` meets a parent before its children.
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  return buildNodes(text, 0, text.length, spans);
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
