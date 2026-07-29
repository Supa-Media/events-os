/**
 * WS1 (2026-07-29, adversarial-review HIGH fix): end-to-end proof, through
 * the ACTUAL `Maily` renderer, that every href/src sink is now gated
 * post-resolution — pinning the exact hostile reproductions the adversarial
 * review used to prove the gap (a recipient's own profile name, carrying a
 * `javascript:`/`vbscript:`/`data:` payload, reaching a real `href`/`src` via
 * an `isXVariable`-flagged doc attr the write gate correctly can't scheme-
 * check because it only ever holds a variable NAME).
 *
 * `urlSanitize.test.ts` covers the two gate functions' own contract in
 * isolation; this file proves they are actually WIRED IN at every sink
 * `maily.tsx` has, and that the legitimate server-built values (root-relative
 * poll/unsubscribe URLs) this repo actually sends still work through the same
 * gate — see `renderEmail.ts`'s own `RenderEmailTiptapOptions.unsubscribeUrl`
 * doc and `apps/convex/campaigns.ts`'s `pollVoteUrl` builder for why those
 * are legitimately root-relative in some deployments.
 */
import { describe, expect, test } from "vitest";
import type { JSONContent } from "@tiptap/core";
import { Maily } from "./maily";

/** The exact class of hostile value this whole fix is about — what
 *  `apps/convex/lib/tiptapCampaignRender.ts#tiptapMergeVariables` would put
 *  in the `firstName`/`name` variable slots for a recipient who set their
 *  profile name to an XSS/phishing payload. */
const HOSTILE_VALUES = [
  "javascript:alert(document.cookie)",
  "vbscript:msgbox(1)",
  "data:text/html,<script>alert(1)</script>",
  "  JAVASCRIPT:alert(1)", // case + leading-whitespace variant
];

async function renderWithVariable(doc: JSONContent, variables: Record<string, string>): Promise<string> {
  const maily = new Maily(doc);
  maily.setVariableValues(variables);
  return maily.render();
}

describe("link mark: isUrlVariable resolves through the hostile variable map", () => {
  const doc: JSONContent = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "Click here",
            marks: [{ type: "link", attrs: { href: "firstName", isUrlVariable: true } }],
          },
        ],
      },
    ],
  };

  for (const hostile of HOSTILE_VALUES) {
    test(`"${hostile}" never reaches a raw href`, async () => {
      const html = await renderWithVariable(doc, { firstName: hostile, name: "friend" });
      expect(html).not.toContain(hostile);
      expect(html).toContain('href="#"');
    });
  }

  test("a legitimate https variable value still renders as a real link", async () => {
    const html = await renderWithVariable(doc, { firstName: "https://example.com/ok", name: "friend" });
    expect(html).toContain('href="https://example.com/ok"');
  });
});

describe("button.url: isUrlVariable resolves through the hostile variable map", () => {
  const doc: JSONContent = {
    type: "doc",
    content: [{ type: "button", attrs: { text: "Go", url: "firstName", isUrlVariable: true } }],
  };

  for (const hostile of HOSTILE_VALUES) {
    test(`"${hostile}" never reaches a raw href`, async () => {
      const html = await renderWithVariable(doc, { firstName: hostile, name: "friend" });
      expect(html).not.toContain(hostile);
    });
  }

  test("a legitimate https variable value still renders", async () => {
    const html = await renderWithVariable(doc, { firstName: "https://example.com/ok", name: "friend" });
    expect(html).toContain("https://example.com/ok");
  });
});

describe("image.src / image.externalLink: isSrcVariable / isExternalLinkVariable", () => {
  test("hostile src never reaches a raw <img src>", async () => {
    const doc: JSONContent = { type: "doc", content: [{ type: "image", attrs: { src: "firstName", isSrcVariable: true } }] };
    for (const hostile of HOSTILE_VALUES) {
      const html = await renderWithVariable(doc, { firstName: hostile, name: "friend" });
      expect(html).not.toContain(hostile);
    }
  });

  test("hostile externalLink never reaches a raw <a href> and the image is left unwrapped (falsy-means-unwrapped)", async () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "image",
          attrs: { src: "https://example.com/i.png", externalLink: "firstName", isExternalLinkVariable: true },
        },
      ],
    };
    const html = await renderWithVariable(doc, { firstName: "javascript:alert(1)", name: "friend" });
    expect(html).not.toContain("javascript:alert(1)");
    // No wrapping <a> at all — same as if externalLink had been absent.
    expect(html).not.toMatch(/<a[^>]*href/);
  });

  test("legitimate https src/externalLink still render", async () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "image",
          attrs: { src: "firstName", isSrcVariable: true, externalLink: "linkVar", isExternalLinkVariable: true },
        },
      ],
    };
    const html = await renderWithVariable(doc, {
      firstName: "https://example.com/i.png",
      linkVar: "https://example.com/click",
      name: "friend",
    });
    expect(html).toContain("https://example.com/i.png");
    expect(html).toContain("https://example.com/click");
  });
});

describe("logo.src: isSrcVariable", () => {
  const doc: JSONContent = { type: "doc", content: [{ type: "logo", attrs: { src: "firstName", isSrcVariable: true, size: "md" } }] };

  for (const hostile of HOSTILE_VALUES) {
    test(`"${hostile}" never reaches a raw <img src>`, async () => {
      const html = await renderWithVariable(doc, { firstName: hostile, name: "friend" });
      expect(html).not.toContain(hostile);
    });
  }

  test("a legitimate https variable value still renders", async () => {
    const html = await renderWithVariable(doc, { firstName: "https://example.com/logo.png", name: "friend" });
    expect(html).toContain("https://example.com/logo.png");
  });
});

describe("inlineImage.src / inlineImage.externalLink: isSrcVariable / isExternalLinkVariable", () => {
  test("hostile src/externalLink never reach a raw attr", async () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "inlineImage",
              attrs: { src: "firstName", isSrcVariable: true, externalLink: "firstName", isExternalLinkVariable: true },
            },
          ],
        },
      ],
    };
    for (const hostile of HOSTILE_VALUES) {
      const html = await renderWithVariable(doc, { firstName: hostile, name: "friend" });
      expect(html).not.toContain(hostile);
    }
  });
});

describe("linkCard.link: unconditional variable lookup (no isXVariable flag exists for this attr)", () => {
  test("an author-set 'link' value that happens to name a variable key is still gated, not passed raw", async () => {
    // linkCard has no isXVariable flag upstream — `link()` always consults
    // `variableValues` for whatever literal string `link` holds. The write
    // gate validates `link` as a literal URL (see `tiptapEmail.ts`'s
    // `NODE_URL_ATTR_RULES` comment on this node), so this specific doc would
    // NOT pass validation — this test is about the render-time chokepoint
    // holding even when a doc reaches the renderer some other way (a doc
    // written before the gate existed, a direct DB write, an import script).
    const doc: JSONContent = {
      type: "doc",
      content: [{ type: "linkCard", attrs: { title: "Card", link: "firstName" } }],
    };
    const html = await renderWithVariable(doc, { firstName: "javascript:alert(1)", name: "friend" });
    expect(html).not.toContain("javascript:alert(1)");
  });

  test("a legitimate resolved value still renders as a real href", async () => {
    const doc: JSONContent = {
      type: "doc",
      content: [{ type: "linkCard", attrs: { title: "Card", link: "firstName" } }],
    };
    const html = await renderWithVariable(doc, { firstName: "https://example.com/card", name: "friend" });
    expect(html).toContain('href="https://example.com/card"');
  });
});

describe("pwBleedImage: isSrcVariable (variable path, not just the literal path nodePack.test.ts covers)", () => {
  test("hostile variable-resolved src falls back to the placeholder band, not a raw <img src>", async () => {
    const doc: JSONContent = {
      type: "doc",
      content: [{ type: "pwBleedImage", attrs: { src: "firstName", isSrcVariable: true, alt: "Banner" } }],
    };
    const html = await renderWithVariable(doc, { firstName: "javascript:alert(1)", name: "friend" });
    expect(html).not.toContain("javascript:alert(1)");
    expect(html).toContain("Banner");
    expect(html).not.toMatch(/<img/);
  });
});

describe("pwPoll: the per-option vote link", () => {
  test("a hostile value under the poll's variable key never reaches a raw <a href>", async () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "pwPoll",
          attrs: {
            id: "poll1",
            question: "Sunday or Wednesday?",
            options: [{ id: "opt_a", label: "Sunday" }],
          },
        },
      ],
    };
    const html = await renderWithVariable(doc, {
      pw_poll_poll1_opt_a_url: "javascript:alert(1)",
      firstName: "friend",
      name: "friend",
    });
    expect(html).not.toContain("javascript:alert(1)");
  });

  test("a legitimate ROOT-RELATIVE vote URL (siteUrl() unset) still renders as a real link — the chokepoint must not neuter it", async () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "pwPoll",
          attrs: {
            id: "poll1",
            question: "Sunday or Wednesday?",
            options: [{ id: "opt_a", label: "Sunday" }],
          },
        },
      ],
    };
    const html = await renderWithVariable(doc, {
      pw_poll_poll1_opt_a_url: "/poll/campaign1/tok123/poll1/opt_a",
      firstName: "friend",
      name: "friend",
    });
    expect(html).toContain('href="/poll/campaign1/tok123/poll1/opt_a"');
  });

  test("a legitimate absolute vote URL still renders", async () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "pwPoll",
          attrs: { id: "poll1", question: "Q", options: [{ id: "opt_a", label: "A" }] },
        },
      ],
    };
    const html = await renderWithVariable(doc, {
      pw_poll_poll1_opt_a_url: "https://example.org/poll/1/tok/poll1/opt_a",
      firstName: "friend",
      name: "friend",
    });
    expect(html).toContain("https://example.org/poll/1/tok/poll1/opt_a");
  });
});
