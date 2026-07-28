import { describe, expect, test } from "vitest";
import {
  markdownSubsetToPlainSpans,
  parseInlineMarkdown,
  parseMarkdownSubset,
  type MarkdownInlineNode,
} from "./emailMarkdown";

/**
 * THE MARKDOWN SUBSET, PINNED.
 *
 * This file is a specification, not a smoke test. `emailMarkdown.ts` is on the
 * real send path — every campaign email's body goes through it — and its
 * failures are silent: a `**` that doesn't pair renders as two asterisks in
 * someone's inbox rather than throwing. A previous rewrite of this parser
 * claimed byte-identical output, shipped four separate rendering regressions,
 * and CI stayed green, because nothing here asserted on the parser itself.
 *
 * So the rules are written out as cases, including the ugly ones. If a change
 * makes a test below fail, that is a decision about what real recipients see —
 * make it deliberately.
 *
 * Assertions go through `html()` rather than on the node tree, because the
 * tree's shape is an implementation detail and the rendered string is the
 * thing that reaches a mail client. `html()` mirrors `emailRender.ts`'s
 * `inlineMarkdownHtml` with the styling stripped out.
 */
function html(nodes: readonly MarkdownInlineNode[]): string {
  return nodes
    .map((node) => {
      switch (node.kind) {
        case "text":
          return node.text;
        case "strong":
          return `<strong>${html(node.children)}</strong>`;
        case "em":
          return `<em>${html(node.children)}</em>`;
        case "link":
          return `<a href="${node.href}">${html(node.children)}</a>`;
      }
    })
    .join("");
}

/** One line of inline markdown, rendered. */
const inline = (markdown: string): string => html(parseInlineMarkdown(markdown));

/** A whole document, rendered — paragraphs and lists included. */
function blocks(markdown: string): string {
  return parseMarkdownSubset(markdown)
    .map((block) =>
      block.kind === "paragraph"
        ? `<p>${html(block.content)}</p>`
        : `<ul>${block.items.map((item) => `<li>${html(item)}</li>`).join("")}</ul>`,
    )
    .join("");
}

const A = "https://x.test/give";

describe("the subset itself", () => {
  test("bold, italic and links are the only marks", () => {
    expect(inline("**bold**")).toBe("<strong>bold</strong>");
    expect(inline("*italic*")).toBe("<em>italic</em>");
    expect(inline(`[label](${A})`)).toBe(`<a href="${A}">label</a>`);
  });

  test("anything else is literal text", () => {
    expect(inline("# not a heading")).toBe("# not a heading");
    expect(inline("_underscores_ and `code`")).toBe("_underscores_ and `code`");
    expect(inline("> quote")).toBe("> quote");
  });

  test("plain text passes through untouched", () => {
    expect(inline("Sunday at ten.")).toBe("Sunday at ten.");
    expect(inline("")).toBe("");
    expect(parseInlineMarkdown("")).toEqual([]);
  });

  test("marks compose along a line", () => {
    expect(inline(`a **b** c *d* e [f](${A}) g`)).toBe(
      `a <strong>b</strong> c <em>d</em> e <a href="${A}">f</a> g`,
    );
  });
});

/**
 * REGRESSION S1 — emphasis whose halves sit either side of a link.
 *
 * `**[Give now](…)**` is how a person actually writes a bold call to action,
 * and a parser that splits on links before pairing emphasis can never match
 * it: the two `**` land in different pieces. The symptom is raw asterisks in
 * the inbox, which is why every row of the table is nailed down here.
 */
describe("emphasis spans a link", () => {
  test("bold wrapping a link, alone", () => {
    expect(inline(`**[Give now](${A})**`)).toBe(
      `<strong><a href="${A}">Give now</a></strong>`,
    );
  });

  test("bold wrapping a link, mid-sentence", () => {
    expect(inline(`Read **[the full story](${A})** before Sunday.`)).toBe(
      `Read <strong><a href="${A}">the full story</a></strong> before Sunday.`,
    );
  });

  test("italic spanning a link", () => {
    expect(inline(`*Join us at [the chapel](${A}) this week.*`)).toBe(
      `<em>Join us at <a href="${A}">the chapel</a> this week.</em>`,
    );
  });

  test("bold wrapping a link inside a list item", () => {
    expect(blocks(`- **[Register](${A})** by Friday`)).toBe(
      `<ul><li><strong><a href="${A}">Register</a></strong> by Friday</li></ul>`,
    );
  });

  test("emphasis spanning TWO links", () => {
    expect(inline(`**[a](${A}) and [b](${A})**`)).toBe(
      `<strong><a href="${A}">a</a> and <a href="${A}">b</a></strong>`,
    );
  });

  test("bold spanning text on both sides of a link", () => {
    expect(inline(`**a [b](${A}) c**`)).toBe(
      `<strong>a <a href="${A}">b</a> c</strong>`,
    );
  });

  /** The other natural authoring of the same intent. Both must work — a fix
   *  for one that breaks the other is not a fix. */
  test("emphasis INSIDE the label still works", () => {
    expect(inline(`[**Give now**](${A})`)).toBe(
      `<a href="${A}"><strong>Give now</strong></a>`,
    );
    expect(inline(`[*Give now*](${A})`)).toBe(`<a href="${A}"><em>Give now</em></a>`);
  });

  test("a label's emphasis is its own — it never pairs with an outside marker", () => {
    // The `**` opening outside and the one inside the label are not a pair;
    // pairing them is how the old renderer produced tags that straddled the
    // `<a>` boundary and no mail client agreed on.
    expect(inline(`**a [b**c](${A})`)).toBe(`**a <a href="${A}">b**c</a>`);
  });
});

/**
 * REGRESSION S2 — nesting in both directions.
 *
 * A parser that resolves bold first and then only looks inside the gaps
 * severs the outer `*…*` of `*a **b** c*`. The reverse case kept working
 * throughout, which is exactly why the regression went unnoticed.
 */
describe("bold and italic nest either way round", () => {
  test("italic wrapping bold", () => {
    expect(inline("*a **b** c*")).toBe("<em>a <strong>b</strong> c</em>");
  });

  test("bold wrapping italic", () => {
    expect(inline("**a *b* c**")).toBe("<strong>a <em>b</em> c</strong>");
  });

  test("three levels, with a link at the bottom", () => {
    expect(inline(`**a *b [c](${A}) d* e**`)).toBe(
      `<strong>a <em>b <a href="${A}">c</a> d</em> e</strong>`,
    );
  });

  test("emphasis inside a label nests too", () => {
    expect(inline(`[**a *b* c**](${A})`)).toBe(
      `<a href="${A}"><strong>a <em>b</em> c</strong></a>`,
    );
  });
});

/**
 * The two places the tree parser is deliberately SAFER than the regex chain
 * it replaced. Both were real defects; neither may come back.
 */
describe("safety wins that must not regress", () => {
  test("asterisks inside a URL stay in the URL", () => {
    // The old chain ran emphasis over the finished HTML, so a `*a*` in a path
    // became `href="https://e.test/<em>a</em>/b"` — a broken link, and markup
    // injected into an attribute.
    expect(inline("[x](https://e.test/*a*/b)")).toBe(
      `<a href="https://e.test/*a*/b">x</a>`,
    );
  });

  test("asterisk runs never emit overlapping tags", () => {
    // `****a****` used to come out as `<strong>*<em>a</strong></em>*`.
    // Whatever these degenerate inputs render as, the tags must nest.
    for (const input of ["****", "***", "****a****", "***triple***", "*****five*****", "*******"]) {
      expect(wellFormed(inline(input)), input).toBe(true);
    }
  });

  test("a crossing pair resolves rather than interleaving", () => {
    // `*a **b* c**` is genuinely ambiguous. Bold wins; the italic's markers
    // stay literal. The one unacceptable answer is interleaved tags.
    const out = inline("*a **b* c**");
    expect(wellFormed(out)).toBe(true);
    expect(out).toBe("*a <strong>b* c</strong>");
  });
});

/** Are the tags properly nested and balanced? */
function wellFormed(markup: string): boolean {
  const stack: string[] = [];
  for (const tag of markup.matchAll(/<(\/?)(strong|em|a|p|ul|li)\b[^>]*>/g)) {
    if (tag[1]) {
      if (stack.pop() !== tag[2]) return false;
    } else {
      stack.push(tag[2]);
    }
  }
  return stack.length === 0;
}

describe("markers that do not pair", () => {
  test("an unclosed marker is literal text", () => {
    expect(inline("unclosed **bold")).toBe("unclosed **bold");
    expect(inline("unclosed *italic")).toBe("unclosed *italic");
    expect(inline("*")).toBe("*");
    expect(inline("**")).toBe("**");
  });

  test("an empty pair has nothing to emphasise, so it stays literal", () => {
    expect(inline("****")).toBe("****");
    expect(inline("a ** b")).toBe("a ** b");
  });

  test("adjacent pairs each stand alone", () => {
    expect(inline("**a** **b**")).toBe("<strong>a</strong> <strong>b</strong>");
    expect(inline("*a* *b* *c*")).toBe("<em>a</em> <em>b</em> <em>c</em>");
    expect(inline("**a** *b*")).toBe("<strong>a</strong> <em>b</em>");
  });

  test("a marker mid-word still pairs", () => {
    expect(inline("a*b*c")).toBe("a<em>b</em>c");
  });

  test("a malformed link is literal text", () => {
    expect(inline("[a]()")).toBe("[a]()");
    expect(inline("[]()")).toBe("[]()");
    expect(inline("[a](b c)")).toBe("[a](b c)");
    expect(inline("[unclosed](https://x.test")).toBe("[unclosed](https://x.test");
  });

  test("a URL's own balanced parentheses survive", () => {
    const wiki = "https://en.wikipedia.org/wiki/Foo_(bar)";
    expect(inline(`[wiki](${wiki})`)).toBe(`<a href="${wiki}">wiki</a>`);
    expect(inline(`**[wiki](${wiki})**`)).toBe(
      `<strong><a href="${wiki}">wiki</a></strong>`,
    );
  });
});

describe("blocks", () => {
  test("a blank line separates paragraphs", () => {
    expect(blocks("one\n\ntwo")).toBe("<p>one</p><p>two</p>");
  });

  test("a soft wrap inside a paragraph is a SPACE, not a break", () => {
    // Authors wrap their copy; mail clients reflow it. The parser has to
    // agree, and — see below — so does the plaintext part.
    expect(blocks("one\ntwo")).toBe("<p>one two</p>");
  });

  test("consecutive '- ' lines are one list", () => {
    expect(blocks("- a\n- b\n- c")).toBe("<ul><li>a</li><li>b</li><li>c</li></ul>");
    expect(blocks("- **a**\n- *b*")).toBe(
      "<ul><li><strong>a</strong></li><li><em>b</em></li></ul>",
    );
  });

  test("a list interrupts and resumes the surrounding text", () => {
    expect(blocks("intro\n- a\n- b\noutro")).toBe(
      "<p>intro</p><ul><li>a</li><li>b</li></ul><p>outro</p>",
    );
  });

  test("CRLF line endings behave exactly like LF", () => {
    expect(blocks("one\r\ntwo")).toBe(blocks("one\ntwo"));
    expect(blocks("one\r\n\r\ntwo")).toBe(blocks("one\n\ntwo"));
    expect(blocks("- a\r\n- b")).toBe(blocks("- a\n- b"));
  });

  test("blank and whitespace-only input produces no blocks", () => {
    expect(parseMarkdownSubset("")).toEqual([]);
    expect(parseMarkdownSubset("   \n\n  \n")).toEqual([]);
  });
});

/**
 * REGRESSION S3 — the text/plain and text/html parts of one email must agree
 * about what is markup.
 *
 * The HTML side joins a paragraph's lines with a space before parsing; the
 * plaintext side (`emailRender.ts`'s `stripMarkdownSubset`) keeps the line
 * breaks and parses the whole block at once. Both are legitimate, but they
 * only agree if the parse itself is indifferent to whether a soft wrap is a
 * newline or a space. When it wasn't, a wrapped link rendered as a link in
 * one part of the email and as raw `[…](…)` in the other.
 */
describe("a soft wrap is not a boundary", () => {
  const bothWays = (markdown: string) => ({
    wrapped: markdownSubsetToPlainSpans(parseInlineMarkdown(markdown)).replace(/\n/g, " "),
    flowed: markdownSubsetToPlainSpans(parseInlineMarkdown(markdown.replace(/\n/g, " "))),
  });

  test("a link label may wrap", () => {
    expect(inline("[the full\nstory](https://e.test/x)")).toBe(
      `<a href="https://e.test/x">the full\nstory</a>`,
    );
  });

  test("a bold pair may close on the next line", () => {
    expect(inline("**bold\nstill bold**")).toBe("<strong>bold\nstill bold</strong>");
  });

  test("an italic pair may close on the next line", () => {
    expect(inline("*it\nalics*")).toBe("<em>it\nalics</em>");
  });

  test("newline or space, the same things are markup", () => {
    for (const input of [
      "[the full\nstory](https://e.test/x)",
      "**bold\nstill bold**",
      "*it\nalics*",
      "a **b\nc** d",
      "**[Give\nnow](https://e.test/x)**",
    ]) {
      const { wrapped, flowed } = bothWays(input);
      expect(wrapped, input).toBe(flowed);
    }
  });
});

describe("plain spans", () => {
  test("every mark disappears, the words remain", () => {
    expect(markdownSubsetToPlainSpans(parseInlineMarkdown(`**a *b* [c](${A})**`))).toBe(
      "a b c",
    );
  });

  test("an unpaired marker is a word, so it survives", () => {
    expect(markdownSubsetToPlainSpans(parseInlineMarkdown("**a"))).toBe("**a");
  });
});

describe("unicode", () => {
  test("accents and emoji are ordinary characters", () => {
    expect(inline("**héllo** *wörld*")).toBe("<strong>héllo</strong> <em>wörld</em>");
    expect(inline("**🎉** *🎉*")).toBe("<strong>🎉</strong> <em>🎉</em>");
    expect(inline(`[🎉 give](${A})`)).toBe(`<a href="${A}">🎉 give</a>`);
  });

  test("an astral character is not split by the range arithmetic", () => {
    // Surrogate pairs make string indices and character counts disagree; the
    // parser works in indices, so the halves must never come apart.
    expect(inline("**👨‍👩‍👧‍👦**")).toBe("<strong>👨‍👩‍👧‍👦</strong>");
    expect(inline("a *👍* b")).toBe("a <em>👍</em> b");
  });
});

/**
 * The parser runs on text that is ALREADY HTML-escaped (`emailRender.ts`
 * escapes at both call sites before calling in). Its own contract is
 * therefore narrow but absolute: it may wrap text in tags, and it may never
 * introduce a character that changes how the surrounding text is parsed.
 */
describe("the parser introduces no markup of its own", () => {
  test("escaped text is carried through byte for byte", () => {
    expect(inline("&lt;script&gt;")).toBe("&lt;script&gt;");
    expect(inline("**&lt;b&gt;**")).toBe("<strong>&lt;b&gt;</strong>");
    expect(inline("&amp; &quot; &#39;")).toBe("&amp; &quot; &#39;");
  });

  test("the only tags emitted are the subset's own", () => {
    const emitted = new Set<string>();
    for (const input of SPECIMENS) {
      for (const tag of blocks(input).matchAll(/<\/?([a-z]+)/g)) emitted.add(tag[1]);
    }
    expect([...emitted].sort()).toEqual(["a", "em", "li", "p", "strong", "ul"]);
  });

  test("output is well-formed for every specimen", () => {
    for (const input of SPECIMENS) {
      expect(wellFormed(blocks(input)), JSON.stringify(input)).toBe(true);
    }
  });

  test("the flattened text of a document never loses the author's words", () => {
    // Marks vanish; letters do not. Catches a range-arithmetic slip that
    // silently drops a character.
    for (const input of SPECIMENS) {
      const letters = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, "");
      const flat = parseMarkdownSubset(input)
        .map((b) =>
          b.kind === "paragraph"
            ? markdownSubsetToPlainSpans(b.content)
            : b.items.map((i) => markdownSubsetToPlainSpans(i)).join(""),
        )
        .join("");
      // A link's URL is dropped from the visible label, so compare only the
      // letters that were outside link URLs.
      const withoutUrls = input.replace(/\]\(((?:[^()\s]|\([^()]*\))+)\)/g, "]");
      expect(letters(flat), JSON.stringify(input)).toBe(letters(withoutUrls));
    }
  });
});

/** A spread of ordinary and adversarial documents, reused by the property
 *  tests above so a new specimen is checked by all of them at once. */
const SPECIMENS: readonly string[] = [
  "",
  "plain",
  "**bold** and *italic*",
  `[a](${A})`,
  `**[a](${A})**`,
  `[**a**](${A})`,
  "*a **b** c*",
  "**a *b* c**",
  "****",
  "***",
  "*****five*****",
  "*a **b* c**",
  "[x](https://e.test/*a*/b)",
  "- a\n- **b**\n- [c](https://e.test/z)",
  "one\ntwo\n\nthree",
  "&lt;script&gt; **&amp;** *&quot;*",
  "**bold\nstill bold**",
  "[the full\nstory](https://e.test/x)",
  "a[b](https://e.test/z)c[d](https://e.test/z)e",
  "**héllo 🎉** *wörld*",
  "[[**[x](https://e.test/z))b",
  "]****[x]***",
  "- **[Register](https://e.test/z)** by Friday",
];
