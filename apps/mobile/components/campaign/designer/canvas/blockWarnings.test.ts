// No @types/jest / ambient globals configured for this package — import test
// globals explicitly from @jest/globals (mirrors `lib/emailDesigner.test.ts`).
import { describe, expect, test } from "@jest/globals";
import {
  validateEmailDocument,
  type EmailBlock,
  type EmailDocument,
} from "@events-os/shared";
import {
  blockWarnings,
  cardContentWarnings,
  documentWarnings,
  worstSeverity,
} from "./blockWarnings";

const doc = (blocks: EmailBlock[]): EmailDocument => ({ blocks });

const keys = (block: EmailBlock) => blockWarnings(block).map((w) => w.key);
const severities = (block: EmailBlock) =>
  Object.fromEntries(blockWarnings(block).map((w) => [w.key, w.severity]));

describe("blockWarnings — the states the write gate refuses", () => {
  test("a button with no label and no link earns one warning per half", () => {
    const block: EmailBlock = { id: "b", kind: "button", label: "", url: "" };
    expect(keys(block)).toEqual(["label", "url-missing"]);
    expect(severities(block)).toEqual({ label: "blocking", "url-missing": "blocking" });
  });

  test("a button link with a refused scheme is distinguished from a missing one", () => {
    expect(keys({ id: "b", kind: "button", label: "Give", url: "tel:12345" })).toEqual([
      "url-scheme",
    ]);
  });

  test("a complete button is silent", () => {
    expect(keys({ id: "b", kind: "button", label: "Give", url: "https://x.test" })).toEqual([]);
  });

  test("an image with no url warns about the url, and stays quiet about the alt", () => {
    // The empty alt is ACCEPTED by the gate; nagging about it while the url is
    // the actual blocker is how the loud warning gets ignored.
    expect(keys({ id: "i", kind: "image", url: "", alt: "" })).toEqual(["url-missing"]);
  });

  test("an image with a url and an EMPTY alt is advisory, not blocking", () => {
    const block: EmailBlock = { id: "i", kind: "image", url: "https://x.test/a.png", alt: "" };
    expect(severities(block)).toEqual({ "image.alt-empty": "advisory" });
    expect(worstSeverity(blockWarnings(block))).toBe("advisory");
  });

  test("an image with a url and NO alt at all blocks the save", () => {
    const block = { id: "i", kind: "image", url: "https://x.test/a.png" } as unknown as EmailBlock;
    expect(severities(block)).toEqual({ "image.alt-missing": "blocking" });
    expect(worstSeverity(blockWarnings(block))).toBe("blocking");
  });

  test("an image's optional link still has to carry an allowed scheme", () => {
    expect(
      keys({
        id: "i",
        kind: "image",
        url: "https://x.test/a.png",
        alt: "A",
        href: "javascript:alert(1)",
      }),
    ).toEqual(["href"]);
  });

  test("an UNFILLED banner is silent — a blank banner url is saveable", () => {
    // The one image url the contract lets be blank: it renders as a
    // placeholder band. Warning here would put a save-blocking claim on every
    // freshly added banner.
    expect(keys({ id: "b", kind: "bleed_image", alt: "" })).toEqual([]);
  });

  test("a banner with a refused scheme warns", () => {
    expect(keys({ id: "b", kind: "bleed_image", url: "ftp://x.test/a.png", alt: "A" })).toEqual([
      "url-scheme",
    ]);
  });

  test("a footer's half-filled link row is blocking, per row", () => {
    const block: EmailBlock = {
      id: "f",
      kind: "footer",
      links: [
        { label: "", url: "https://x.test" },
        { label: "Insta", url: "" },
        { label: "Bad", url: "tel:123" },
        { label: "Fine", url: "https://ok.test" },
      ],
    };
    expect(keys(block)).toEqual(["link-0-label", "link-1-url", "link-2-scheme"]);
  });

  test("a footer logo may be ABSENT but not empty", () => {
    expect(keys({ id: "f", kind: "footer" })).toEqual([]);
    expect(keys({ id: "f", kind: "footer", logoUrl: "" })).toEqual(["logo-empty"]);
  });

  test("a poll with a blank option label is blocking", () => {
    expect(
      keys({
        id: "p",
        kind: "poll",
        question: "Which?",
        options: [
          { id: "1", label: "A" },
          { id: "2", label: "" },
        ],
      }),
    ).toEqual(["option-label"]);
  });

  test("a card's half-typed call to action names the missing half", () => {
    expect(keys({ id: "c", kind: "card", ctaLabel: "Read more" })).toEqual(["card.cta-no-url"]);
    expect(keys({ id: "c", kind: "card", ctaUrl: "https://x.test" })).toEqual([
      "card.cta-no-label",
    ]);
  });

  test("a card's CTA label of a single SPACE still counts as set", () => {
    // The validator tests `.length > 0` on the raw string, so trimming here
    // would leave this state silent in the editor and fatal on save.
    expect(keys({ id: "c", kind: "card", ctaLabel: " " })).toEqual(["card.cta-no-url"]);
  });

  test("a card's CTA can be paired and still carry a refused scheme", () => {
    expect(keys({ id: "c", kind: "card", ctaLabel: "Go", ctaUrl: "tel:123" })).toEqual([
      "card.cta-scheme",
    ]);
  });

  test("each column of a columns block is checked, and named", () => {
    const block: EmailBlock = {
      id: "cols",
      kind: "columns",
      columns: [{ heading: "One" }, { heading: "Two", ctaLabel: "Go" }],
    };
    const warnings = blockWarnings(block);
    expect(warnings.map((w) => w.key)).toEqual(["col-1.cta-no-url"]);
    expect(warnings[0].field).toBe("Column 2 button link");
  });

  test("blocking warnings sort ahead of advisory ones", () => {
    const block: EmailBlock = {
      id: "c",
      kind: "card",
      imageUrl: "https://x.test/a.png",
      imageAlt: "",
      ctaLabel: "Go",
    };
    expect(blockWarnings(block).map((w) => w.severity)).toEqual(["blocking", "advisory"]);
  });

  test("the kinds with nothing the gate can refuse stay silent", () => {
    const quiet: EmailBlock[] = [
      { id: "1", kind: "heading", text: "Hi" },
      { id: "2", kind: "text", markdown: "" },
      { id: "3", kind: "divider" },
      { id: "4", kind: "spacer", size: "md" },
      { id: "5", kind: "hairline" },
      { id: "6", kind: "eyebrow", text: "THIS MONTH" },
      { id: "7", kind: "quote", text: "A line" },
    ];
    for (const block of quiet) expect(blockWarnings(block)).toEqual([]);
  });

  test("cardContentWarnings is the same check for a card and for a column", () => {
    const content = { ctaLabel: "Go" };
    expect(cardContentWarnings(content, "x", "").map((w) => w.severity)).toEqual(["blocking"]);
  });
});

describe("documentWarnings", () => {
  test("counts and lists the blocks that are blocking the save, in order", () => {
    const summary = documentWarnings(
      doc([
        { id: "ok", kind: "heading", text: "Hi" },
        { id: "bad1", kind: "button", label: "", url: "" },
        { id: "advisory", kind: "image", url: "https://x.test/a.png", alt: "" },
        { id: "bad2", kind: "card", ctaLabel: "Go" },
      ]),
    );
    expect(summary.blockingBlockIds).toEqual(["bad1", "bad2"]);
    expect(summary.blockingCount).toBe(3);
    expect(summary.advisoryCount).toBe(1);
    expect(Object.keys(summary.byBlockId).sort()).toEqual(["advisory", "bad1", "bad2"]);
  });

  test("a clean document produces nothing at all", () => {
    const summary = documentWarnings(
      doc([
        { id: "1", kind: "heading", text: "Hi" },
        { id: "2", kind: "button", label: "Give", url: "https://x.test" },
      ]),
    );
    expect(summary).toEqual({
      byBlockId: {},
      blockingBlockIds: [],
      blockingCount: 0,
      advisoryCount: 0,
    });
  });
});

/**
 * The property that actually matters.
 *
 * A warning is only worth anything if it fires on EXACTLY the states the
 * server refuses: one that fires where the gate is happy cries wolf, and a
 * state the gate refuses with NO warning reads as "the editor stopped saving",
 * because a rejected document is rejected whole and takes every other block's
 * edits down with it.
 *
 * So every case below is driven through the REAL `validateEmailDocument`, and
 * "is there a blocking warning?" must agree with "did the gate refuse it?".
 */
describe("blocking warnings agree with the real write gate", () => {
  const cases: { name: string; blocks: EmailBlock[] }[] = [
    { name: "empty document", blocks: [] },
    { name: "clean heading", blocks: [{ id: "1", kind: "heading", text: "Hi" }] },
    { name: "button, no url", blocks: [{ id: "1", kind: "button", label: "Go", url: "" }] },
    { name: "button, bad scheme", blocks: [{ id: "1", kind: "button", label: "Go", url: "tel:1" }] },
    {
      name: "button, complete",
      blocks: [{ id: "1", kind: "button", label: "Go", url: "https://x.test" }],
    },
    { name: "image, no url", blocks: [{ id: "1", kind: "image", url: "", alt: "" }] },
    {
      name: "image, url with empty alt (saveable)",
      blocks: [{ id: "1", kind: "image", url: "https://x.test/a.png", alt: "" }],
    },
    {
      name: "image, url with missing alt",
      blocks: [{ id: "1", kind: "image", url: "https://x.test/a.png" } as unknown as EmailBlock],
    },
    {
      name: "image, bad href",
      blocks: [
        { id: "1", kind: "image", url: "https://x.test/a.png", alt: "A", href: "data:x" },
      ],
    },
    { name: "banner, unfilled", blocks: [{ id: "1", kind: "bleed_image", alt: "" }] },
    {
      name: "banner, bad scheme",
      blocks: [{ id: "1", kind: "bleed_image", url: "ftp://x/a.png", alt: "A" }],
    },
    { name: "footer, bare", blocks: [{ id: "1", kind: "footer", navLine: "Public Worship" }] },
    {
      name: "footer, empty logo url",
      blocks: [{ id: "1", kind: "footer", logoUrl: "" }],
    },
    {
      name: "footer, half link",
      blocks: [{ id: "1", kind: "footer", links: [{ label: "Insta", url: "" }] }],
    },
    {
      name: "poll, blank option",
      blocks: [
        {
          id: "1",
          kind: "poll",
          question: "Which?",
          options: [
            { id: "a", label: "A" },
            { id: "b", label: "" },
          ],
        },
      ],
    },
    { name: "card, label without url", blocks: [{ id: "1", kind: "card", ctaLabel: "Go" }] },
    { name: "card, url without label", blocks: [{ id: "1", kind: "card", ctaUrl: "https://x.t" }] },
    {
      name: "card, paired cta with bad scheme",
      blocks: [{ id: "1", kind: "card", ctaLabel: "Go", ctaUrl: "tel:1" }],
    },
    {
      name: "card, image without alt",
      blocks: [{ id: "1", kind: "card", imageUrl: "https://x.test/a.png" }],
    },
    {
      name: "card, empty image url",
      blocks: [{ id: "1", kind: "card", imageUrl: "", imageAlt: "" }],
    },
    {
      name: "columns, one bad column",
      blocks: [
        { id: "1", kind: "columns", columns: [{ heading: "A" }, { ctaUrl: "https://x.t" }] },
      ],
    },
    {
      name: "columns, both fine",
      blocks: [{ id: "1", kind: "columns", columns: [{ heading: "A" }, { heading: "B" }] }],
    },
  ];

  for (const { name, blocks } of cases) {
    test(name, () => {
      const result = validateEmailDocument(doc(blocks));
      const blocking = documentWarnings(doc(blocks)).blockingCount > 0;
      expect(blocking).toBe(!result.ok);
    });
  }
});
