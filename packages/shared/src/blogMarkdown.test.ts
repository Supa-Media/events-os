/**
 * The blog's markdown renderer and — mostly — its sanitizer.
 *
 * The balance of this file is deliberate. The happy path (a heading renders as
 * an `<h2>`) is cheap to assert and cheap to keep true; the SANITIZER is the
 * part that is served to the open internet, and a sanitizer test that only
 * proves `<b>` survives proves nothing at all. So the bulk of what follows is
 * adversarial: every shape that has historically walked past a naive
 * allowlist — case-mangled schemes, entity-encoded colons, tab-split schemes,
 * protocol-relative hosts, `>` inside a quoted attribute value, a `<script>`
 * whose body would otherwise land on the page as text, an unclosed `<div>`
 * reaching for the rest of the document.
 *
 * The other thing pinned here is the CONTRACT with the page: `extractHeadings`
 * and `renderBlogMarkdown` must agree about ids, because a table of contents
 * that links to an anchor the page does not have is the exact bug that a
 * second parser would eventually cause.
 */
import { describe, expect, test } from "vitest";
import {
  extractHeadings,
  renderBlogMarkdown,
  sanitizeBlogHtml,
} from "./blogMarkdown";

/** Does the rendered output contain anything a browser would execute or
 *  fetch? One predicate, used by every adversarial case below, so a new attack
 *  shape only has to be added in one place. */
function isInert(html: string): boolean {
  return (
    !/<script/i.test(html) &&
    !/<iframe/i.test(html) &&
    !/<style/i.test(html) &&
    !/\son[a-z]+\s*=/i.test(html) &&
    !/javascript\s*:/i.test(html) &&
    !/data\s*:/i.test(html) &&
    !/vbscript\s*:/i.test(html) &&
    !/\bsrcdoc\b/i.test(html)
  );
}

// ── Blocks ───────────────────────────────────────────────────────────────────

describe("block structure", () => {
  test("headings carry a slug id at every depth", () => {
    const html = renderBlogMarkdown("# One\n\n## Two words\n\n#### Four");
    expect(html).toContain('<h1 id="one">One</h1>');
    expect(html).toContain('<h2 id="two-words">Two words</h2>');
    expect(html).toContain('<h4 id="four">Four</h4>');
  });

  test("paragraphs are split on blank lines and joined across soft wraps", () => {
    const html = renderBlogMarkdown("one\ntwo\n\nthree");
    expect(html).toBe("<p>one\ntwo</p>\n<p>three</p>");
  });

  test("two trailing spaces are a hard break", () => {
    expect(renderBlogMarkdown("one  \ntwo")).toContain("one<br />\ntwo");
  });

  test("a thematic break renders, and does not eat the paragraph above it", () => {
    const html = renderBlogMarkdown("before\n\n---\n\nafter");
    expect(html).toBe("<p>before</p>\n<hr />\n<p>after</p>");
  });

  test("blockquotes nest their own blocks", () => {
    const html = renderBlogMarkdown("> A quote.\n>\n> ## Inside\n");
    expect(html).toContain("<blockquote><p>A quote.</p>");
    expect(html).toContain('<h2 id="inside">Inside</h2></blockquote>');
  });

  test("fenced code is literal — no markdown, no HTML, no entity decoding", () => {
    const html = renderBlogMarkdown(
      "```ts\nconst a = **not bold**;\n<script>x</script>\n&amp;\n```",
    );
    expect(html).toContain('<pre><code class="language-ts">');
    expect(html).toContain("const a = **not bold**;");
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
    // `&amp;` inside a fence is four characters the author typed.
    expect(html).toContain("&amp;amp;");
    expect(isInert(html)).toBe(true);
  });

  test("a fence's language is restricted to what a class name may be", () => {
    const html = renderBlogMarkdown('```js" onload="alert(1)\nx\n```');
    expect(html).toContain('<code class="language-js">');
    expect(isInert(html)).toBe(true);
  });

  test("a heading inside a fence is not a heading", () => {
    const md = "```sh\n# not a heading\n```\n\n## real";
    expect(extractHeadings(md).map((h) => h.text)).toEqual(["real"]);
  });

  test("YAML frontmatter is dropped rather than rendered as prose", () => {
    const html = renderBlogMarkdown('---\ntitle: "X"\ndraft: false\n---\n\nBody.');
    expect(html).toBe("<p>Body.</p>");
  });
});

describe("lists", () => {
  test("a tight list does not wrap its items in paragraphs", () => {
    expect(renderBlogMarkdown("- a\n- b")).toBe("<ul><li>a</li><li>b</li></ul>");
  });

  test("a loose list does", () => {
    expect(renderBlogMarkdown("- a\n\n- b")).toBe(
      "<ul><li><p>a</p></li><li><p>b</p></li></ul>",
    );
  });

  test("nesting comes from indentation", () => {
    const html = renderBlogMarkdown("- a\n  - a1\n  - a2\n- b");
    expect(html).toBe(
      "<ul><li>a<ul><li>a1</li><li>a2</li></ul></li><li>b</li></ul>",
    );
  });

  test("ordered lists keep a non-1 start, and drop a redundant one", () => {
    expect(renderBlogMarkdown("1. a\n2. b")).toBe("<ol><li>a</li><li>b</li></ol>");
    expect(renderBlogMarkdown("3. a\n4. b")).toBe(
      '<ol start="3"><li>a</li><li>b</li></ol>',
    );
  });

  test("an ordered list nested in a bullet is still ordered", () => {
    expect(renderBlogMarkdown("- a\n  1. one\n  2. two")).toBe(
      "<ul><li>a<ol><li>one</li><li>two</li></ol></li></ul>",
    );
  });

  test("a heading after a list ends the list rather than joining it", () => {
    const html = renderBlogMarkdown("- a\n## After");
    expect(html).toBe('<ul><li>a</li></ul>\n<h2 id="after">After</h2>');
  });
});

describe("tables", () => {
  test("a GFM pipe table renders head, body, and alignment", () => {
    const html = renderBlogMarkdown(
      "| A | B | C |\n| :-- | :-: | --: |\n| 1 | 2 | 3 |",
    );
    expect(html).toBe(
      '<table><thead><tr>' +
        '<th style="text-align:left">A</th>' +
        '<th style="text-align:center">B</th>' +
        '<th style="text-align:right">C</th>' +
        "</tr></thead><tbody><tr>" +
        '<td style="text-align:left">1</td>' +
        '<td style="text-align:center">2</td>' +
        '<td style="text-align:right">3</td>' +
        "</tr></tbody></table>",
    );
  });

  test("cell contents are inline markdown, and an escaped pipe is a pipe", () => {
    const html = renderBlogMarkdown("| A |\n| --- |\n| **b** \\| c |");
    expect(html).toContain("<td><strong>b</strong> | c</td>");
  });

  test("a paragraph that merely contains pipes and dashes is not a table", () => {
    const html = renderBlogMarkdown("a | b\n--- | --- | ---");
    expect(html).not.toContain("<table");
  });
});

// ── Inline ───────────────────────────────────────────────────────────────────

describe("inline", () => {
  test("bold, italic, both, strike, and code", () => {
    expect(renderBlogMarkdown("**b**")).toBe("<p><strong>b</strong></p>");
    expect(renderBlogMarkdown("*i*")).toBe("<p><em>i</em></p>");
    expect(renderBlogMarkdown("***x***")).toBe(
      "<p><strong><em>x</em></strong></p>",
    );
    expect(renderBlogMarkdown("~~gone~~")).toBe("<p><del>gone</del></p>");
    expect(renderBlogMarkdown("`a<b>c`")).toBe("<p><code>a&lt;b&gt;c</code></p>");
  });

  test("emphasis nests", () => {
    expect(renderBlogMarkdown("**bold *and* more**")).toBe(
      "<p><strong>bold <em>and</em> more</strong></p>",
    );
  });

  test("an unmatched delimiter stays literal punctuation", () => {
    expect(renderBlogMarkdown("2 * 3 * 4 =")).toContain("2 * 3 * 4 =");
    expect(renderBlogMarkdown("a ** b")).toContain("a ** b");
  });

  test("underscores inside a word are not emphasis", () => {
    expect(renderBlogMarkdown("snake_case_name")).toBe("<p>snake_case_name</p>");
    expect(renderBlogMarkdown("_yes_")).toBe("<p><em>yes</em></p>");
  });

  test("backslash escapes a delimiter", () => {
    expect(renderBlogMarkdown("\\*not italic\\*")).toBe("<p>*not italic*</p>");
  });

  test("links and images", () => {
    expect(renderBlogMarkdown("[t](https://x.test/a)")).toBe(
      '<p><a href="https://x.test/a">t</a></p>',
    );
    expect(renderBlogMarkdown('[t](https://x.test "Ti")')).toBe(
      '<p><a href="https://x.test" title="Ti">t</a></p>',
    );
    expect(renderBlogMarkdown("![alt](https://x.test/i.png)")).toBe(
      '<p><img src="https://x.test/i.png" alt="alt" loading="lazy" /></p>',
    );
  });

  test("a URL with balanced parens is not truncated", () => {
    expect(renderBlogMarkdown("[t](https://x.test/A_(b))")).toContain(
      'href="https://x.test/A_(b)"',
    );
  });

  test("relative and anchor destinations are allowed", () => {
    expect(renderBlogMarkdown("[t](/blog/x)")).toContain('href="/blog/x"');
    expect(renderBlogMarkdown("[t](#section)")).toContain('href="#section"');
    expect(renderBlogMarkdown("[t](mailto:a@b.test)")).toContain(
      'href="mailto:a@b.test"',
    );
  });

  test("an ampersand in a query string is not double-escaped", () => {
    expect(renderBlogMarkdown("[t](https://x.test/?a=1&amp;b=2)")).toContain(
      'href="https://x.test/?a=1&amp;b=2"',
    );
  });

  test("an HTML entity in prose survives; a bare ampersand is escaped", () => {
    expect(renderBlogMarkdown("*&mdash;* the team")).toBe(
      "<p><em>&mdash;</em> the team</p>",
    );
    expect(renderBlogMarkdown("Tom & Jerry")).toBe("<p>Tom &amp; Jerry</p>");
    // Not a well-formed entity — must not be mistaken for one.
    expect(renderBlogMarkdown("a &notanentity b")).toContain("&amp;notanentity");
  });
});

// ── Headings / table of contents ─────────────────────────────────────────────

describe("extractHeadings", () => {
  test("returns depth, plain text, and the id the HTML actually uses", () => {
    const md = "## The `word`: **doxology**\n\ntext\n\n### Sub [link](https://x.test)";
    const headings = extractHeadings(md);
    expect(headings).toEqual([
      { depth: 2, text: "The word: doxology", id: "the-word-doxology" },
      { depth: 3, text: "Sub link", id: "sub-link" },
    ]);
    const html = renderBlogMarkdown(md);
    for (const h of headings) expect(html).toContain(`id="${h.id}"`);
  });

  test("duplicate titles get distinct ids, in both functions", () => {
    const md = "## The test\n\na\n\n## The test\n\nb";
    expect(extractHeadings(md).map((h) => h.id)).toEqual([
      "the-test",
      "the-test-2",
    ]);
    const html = renderBlogMarkdown(md);
    expect(html).toContain('id="the-test"');
    expect(html).toContain('id="the-test-2"');
  });

  test("a heading with nothing sluggable still gets a unique anchor", () => {
    const md = "## ???\n\na\n\n## !!!\n\nb";
    const ids = extractHeadings(md).map((h) => h.id);
    expect(ids).toEqual(["section-1", "section-2"]);
    const html = renderBlogMarkdown(md);
    for (const id of ids) expect(html).toContain(`id="${id}"`);
  });

  test("a heading id can never carry markup, however it is titled", () => {
    const md = '## <img src=x onerror="alert(1)"> "quoted"';
    const html = renderBlogMarkdown(md);
    expect(isInert(html)).toBe(true);
    expect(html).toMatch(/<h2 id="[a-z0-9-]*">/);
  });
});

// ── The sanitizer: allowed shapes ────────────────────────────────────────────

describe("raw HTML passthrough", () => {
  test("the shapes the one real post uses survive intact", () => {
    const html = renderBlogMarkdown(
      '<div class="pw-scroll">\n<table>\n  <thead>\n    <tr><th>H</th></tr>\n  </thead>\n  <tbody>\n    <tr><td><em>&ldquo;q&rdquo;</em></td></tr>\n  </tbody>\n</table>\n</div>',
    );
    expect(html).toContain('<div class="pw-scroll">');
    expect(html).toContain("<th>H</th>");
    expect(html).toContain("<em>&ldquo;q&rdquo;</em>");
    expect(html).toContain("</div>");
  });

  test("raw HTML inline mid-sentence is sanitized, not escaped", () => {
    expect(renderBlogMarkdown("a <abbr title='x'>b</abbr> c")).toBe(
      '<p>a <abbr title="x">b</abbr> c</p>',
    );
  });

  test("a bare `<` in prose is escaped rather than eating the sentence", () => {
    expect(renderBlogMarkdown("5 < 6 and 7 > 6")).toBe("<p>5 &lt; 6 and 7 &gt; 6</p>");
  });

  test("an unknown tag is dropped but its words are kept", () => {
    expect(sanitizeBlogHtml("<my-widget>hello</my-widget>")).toBe("hello");
    expect(sanitizeBlogHtml("<font color=red>hello</font>")).toBe("hello");
  });
});

// ── The sanitizer: adversarial ───────────────────────────────────────────────

describe("sanitizer — script and its relatives", () => {
  test.each([
    "<script>alert(1)</script>",
    "<SCRIPT>alert(1)</SCRIPT>",
    "<script\n src='https://evil.test/x.js'></script>",
    "<style>body{background:url(javascript:alert(1))}</style>",
    "<iframe src='https://evil.test'></iframe>",
    "<object data='https://evil.test/x.swf'></object>",
    "<embed src='https://evil.test/x'>",
    "<form action='https://evil.test'><input name=a></form>",
    "<svg><script>alert(1)</script></svg>",
    "<math><mtext><script>alert(1)</script></mtext></math>",
    "<noscript><p>x</p></noscript>",
    "<template><script>alert(1)</script></template>",
    "<textarea></textarea><script>alert(1)</script>",
    "<meta http-equiv='refresh' content='0;url=https://evil.test'>",
    "<base href='https://evil.test/'>",
    "<link rel=stylesheet href='https://evil.test/x.css'>",
  ])("drops %s along with its content", (payload) => {
    const html = sanitizeBlogHtml(payload);
    expect(isInert(html)).toBe(true);
    expect(html).not.toContain("alert(1)");
    expect(html).not.toContain("evil.test");
  });

  test("the same payloads are inert through the full markdown path", () => {
    const html = renderBlogMarkdown(
      "Intro.\n\n<script>alert(1)</script>\n\nOutro. <script>alert(2)</script>",
    );
    expect(isInert(html)).toBe(true);
    expect(html).not.toContain("alert(");
    expect(html).toContain("Intro.");
    expect(html).toContain("Outro.");
  });

  test("an unterminated dangerous tag swallows the rest rather than leaking it", () => {
    const html = sanitizeBlogHtml("<p>keep</p><script>alert(1); // never closed");
    expect(html).toContain("keep");
    expect(html).not.toContain("alert(1)");
    expect(isInert(html)).toBe(true);
  });
});

describe("sanitizer — event handlers", () => {
  test.each([
    '<img src="https://x.test/i.png" onerror="alert(1)">',
    '<img src="https://x.test/i.png" ONERROR="alert(1)">',
    "<div onclick=alert(1)>x</div>",
    '<a href="https://x.test" onmouseover="alert(1)">x</a>',
    '<p onfocus="alert(1)" tabindex="0">x</p>',
    '<div onload = "alert(1)">x</div>',
  ])("strips the handler in %s", (payload) => {
    const html = sanitizeBlogHtml(payload);
    expect(isInert(html)).toBe(true);
    expect(html).not.toContain("alert(1)");
  });

  test("a handler survives neither the block nor the inline path", () => {
    const block = renderBlogMarkdown('<div onclick="alert(1)">x</div>');
    const inline = renderBlogMarkdown('a <span onclick="alert(1)">b</span> c');
    expect(isInert(block)).toBe(true);
    expect(isInert(inline)).toBe(true);
    expect(inline).toContain("<span>b</span>");
  });
});

describe("sanitizer — URL schemes", () => {
  test.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "  javascript:alert(1)",
    "java\tscript:alert(1)",
    "java\nscript:alert(1)",
    "jav ascript:alert(1)",
    "&#106;avascript:alert(1)",
    "&#x6a;avascript:alert(1)",
    "javascript&colon;alert(1)",
    "&#0000106;avascript:alert(1)",
    "vbscript:msgbox(1)",
    "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
    "data:image/svg+xml;base64,PHN2Zz48c2NyaXB0Pg==",
    "//evil.test/x",
    "file:///etc/passwd",
  ])("refuses href %p", (url) => {
    const html = sanitizeBlogHtml(`<a href="${url}">click</a>`);
    expect(html).not.toContain("href");
    expect(html).toContain("click");
    expect(isInert(html)).toBe(true);
  });

  test.each([
    "javascript:alert(1)",
    "&#106;avascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "//evil.test/x.png",
  ])("refuses img src %p", (url) => {
    const html = sanitizeBlogHtml(`<img src="${url}" alt="a">`);
    expect(html).not.toContain("src=");
    expect(isInert(html)).toBe(true);
  });

  test("a refused markdown link keeps the words and loses the anchor", () => {
    const html = renderBlogMarkdown("[click me](javascript:alert(1))");
    expect(html).toBe("<p>click me</p>");
  });

  test("a refused markdown image keeps its alt text", () => {
    expect(renderBlogMarkdown("![the alt](javascript:alert(1))")).toBe(
      "<p>the alt</p>",
    );
  });

  test("a path containing a colon is still a relative URL", () => {
    expect(sanitizeBlogHtml('<a href="/a/b:c">x</a>')).toContain('href="/a/b:c"');
  });

  test("one bad srcset candidate voids the whole attribute", () => {
    const html = sanitizeBlogHtml(
      '<img src="https://x.test/a.png" srcset="https://x.test/a.png 1x, javascript:alert(1) 2x">',
    );
    expect(html).not.toContain("srcset");
    expect(html).toContain('src="https://x.test/a.png"');
  });

  test("target=_blank gets noopener even when the author supplied a rel", () => {
    const a = sanitizeBlogHtml('<a href="https://x.test" target="_blank">x</a>');
    expect(a).toContain('rel="noopener noreferrer"');
    const b = sanitizeBlogHtml(
      '<a href="https://x.test" target="_blank" rel="nofollow">x</a>',
    );
    expect(b).toMatch(/rel="[^"]*nofollow[^"]*"/);
    expect(b).toMatch(/rel="[^"]*noopener[^"]*"/);
  });
});

describe("sanitizer — attribute parsing", () => {
  test("a `>` inside a quoted value does not end the tag early", () => {
    const html = sanitizeBlogHtml(
      '<a href="https://x.test" title="a > b" onclick="alert(1)">x</a>',
    );
    expect(html).toBe('<a href="https://x.test" title="a &gt; b">x</a>');
  });

  test("an unquoted attribute value is parsed and still allowlisted", () => {
    expect(sanitizeBlogHtml("<td colspan=2 bogus=3>x</td>")).toBe(
      '<td colspan="2">x</td>',
    );
  });

  test("style and id are refused on author HTML", () => {
    expect(sanitizeBlogHtml('<div style="position:fixed;top:0" id="pw-nav">x</div>')).toBe(
      "<div>x</div>",
    );
  });

  test("a quote in an attribute value cannot break out of the attribute", () => {
    // `isInert` is deliberately NOT used here: the handler text survives as
    // ESCAPED characters inside the class value, which the blunt
    // `\son[a-z]+=` probe would flag. What matters is that the quote is
    // escaped, so the value cannot end early and become real markup.
    const html = sanitizeBlogHtml(`<div class='a" onclick="alert(1)'>x</div>`);
    expect(html).toBe('<div class="a&quot; onclick=&quot;alert(1)">x</div>');
  });

  test("an unterminated quoted value is not a tag at all", () => {
    const html = sanitizeBlogHtml('<div class="never closed');
    expect(html).toContain("&lt;div");
    expect(isInert(html)).toBe(true);
  });

  test("HTML comments and doctypes are dropped", () => {
    expect(sanitizeBlogHtml("<!-- <script>alert(1)</script> -->a")).toBe("a");
    expect(sanitizeBlogHtml("<!DOCTYPE html>a")).toBe("a");
    expect(sanitizeBlogHtml("<?php echo 1; ?>a")).toBe("a");
  });
});

describe("sanitizer — nesting", () => {
  test("an unclosed tag is closed rather than swallowing what follows", () => {
    expect(sanitizeBlogHtml("<div><p>x")).toBe("<div><p>x</p></div>");
  });

  test("a stray closing tag is dropped", () => {
    expect(sanitizeBlogHtml("x</div>y")).toBe("xy");
  });

  test("misnesting is closed greedily so the output stays well formed", () => {
    expect(sanitizeBlogHtml("<div><em>x</div>y")).toBe("<div><em>x</em></div>y");
  });

  test("void tags are not pushed onto the stack", () => {
    expect(sanitizeBlogHtml("a<br>b<hr>c")).toBe("a<br />b<hr />c");
  });
});

// ── Robustness ───────────────────────────────────────────────────────────────

describe("total function", () => {
  test.each([
    "",
    "   \n\n  \n",
    "#",
    "```",
    "```\nunclosed",
    "- ",
    "|",
    "|\n|",
    "[",
    "[](",
    "![](",
    "<",
    "</",
    "<>",
    "**",
    "> ",
    "  ",
    "a".repeat(5000),
  ])("renders %p without throwing, and inert", (input) => {
    const html = renderBlogMarkdown(input);
    expect(typeof html).toBe("string");
    expect(isInert(html)).toBe(true);
    expect(() => extractHeadings(input)).not.toThrow();
  });

  test("the NUL used as the hard-break sentinel cannot be injected by an author", () => {
    // A literal NUL in the body must not become a `<br />` — it is stripped
    // before parsing, so the only NULs the inline scanner ever sees are the
    // ones the parser itself put there.
    expect(renderBlogMarkdown("a b")).toBe("<p>ab</p>");
  });
});
