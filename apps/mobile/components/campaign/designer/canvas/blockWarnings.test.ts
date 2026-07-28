// No @types/jest / ambient globals configured for this package — import test
// globals explicitly from @jest/globals (mirrors `lib/emailDesigner.test.ts`).
import { describe, expect, test } from "@jest/globals";
import {
  validateEmailDocument,
  type EmailBlock,
  type EmailDocument,
} from "@events-os/shared";
import { BLOCK_KINDS } from "../../../../lib/emailDesigner";
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
      // Both of these are valid EMPTY — the canvas draws a placeholder.
      { id: "2", kind: "text", markdown: "" },
      { id: "3", kind: "divider" },
      { id: "4", kind: "spacer", size: "md" },
      { id: "5", kind: "hairline" },
      { id: "6", kind: "eyebrow", text: "THIS MONTH" },
      { id: "7", kind: "quote", text: "A line" },
    ];
    for (const block of quiet) expect(blockWarnings(block)).toEqual([]);
  });

  test("an eyebrow typed empty on the canvas is blocking", () => {
    // The canvas made this typeable (`BlockView`'s eyebrow `EditableField`),
    // and the gate refuses `text: ""` — so backspacing the last character
    // stopped autosave for the entire document with nothing on screen.
    expect(keys({ id: "e", kind: "eyebrow", text: "", icon: "◆" })).toEqual(["text-empty"]);
    expect(keys({ id: "e", kind: "eyebrow", text: " " })).toEqual([]);
  });

  test("a quote typed empty is blocking; its attribution is free to be empty", () => {
    expect(keys({ id: "q", kind: "quote", text: "" })).toEqual(["text-empty"]);
    expect(keys({ id: "q", kind: "quote", text: "A line", attribution: "" })).toEqual([]);
  });

  test("a poll's question is checked as well as its option labels", () => {
    const options = [
      { id: "1", label: "A" },
      { id: "2", label: "" },
    ];
    expect(keys({ id: "p", kind: "poll", question: "", options })).toEqual([
      "question-empty",
      "option-label",
    ]);
    expect(
      keys({ id: "p", kind: "poll", question: "", options: [{ id: "1", label: "A" }] }),
    ).toEqual(["question-empty"]);
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
 * THE PROPERTY THAT ACTUALLY MATTERS.
 *
 * A warning is only worth anything if it fires on EXACTLY the states the
 * server refuses: one that fires where the gate is happy cries wolf, and a
 * state the gate refuses with NO warning reads as "the editor stopped saving",
 * because a rejected document is rejected whole and takes every other block's
 * edits down with it.
 *
 * ── Why this is generated rather than listed ───────────────────────────────
 * It used to be a hand-picked list of two dozen cases, and it was green the
 * whole time three canvas-editable fields — an eyebrow's text, a quote's text,
 * a poll's question — could each be backspaced into a document the gate
 * refuses with no badge, no toolbar chip and no warning anywhere. A list only
 * ever covers the cases someone thought of; the next field the canvas makes
 * typeable is exactly the one nobody adds a case for.
 *
 * So: every block kind, and for each, EVERY string the canvas can clear,
 * found by walking the block rather than by being named. A new field on a
 * block is swept the day it is added, without anyone remembering to.
 */
describe("blocking warnings agree with the real write gate", () => {
  /**
   * Keys that are NOT free text somebody types.
   *
   * Ids (a vote is recorded against a poll option's id), the discriminant, and
   * the closed choices, which are chosen from toggles that can only ever write
   * a legal value. Everything NOT listed here is treated as clearable — the
   * list is deliberately the small closed one, so an unfamiliar new field is
   * covered by default rather than skipped by default.
   */
  const NOT_TYPED_TEXT = new Set([
    "id",
    "kind",
    "level",
    "size",
    "width",
    "variant",
    "align",
    "inset",
    "imageSide",
    "imageWidthPct",
    "ctaStyle",
  ]);

  /** Every string the canvas (or the inspector) could put an empty value into,
   *  as a path into the block. */
  function typedStringPaths(value: unknown, path: readonly string[] = []): string[][] {
    if (typeof value === "string") return [[...path]];
    if (Array.isArray(value)) {
      return value.flatMap((item, i) => typedStringPaths(item, [...path, String(i)]));
    }
    if (value !== null && typeof value === "object") {
      return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
        NOT_TYPED_TEXT.has(key) ? [] : typedStringPaths(child, [...path, key]),
      );
    }
    return [];
  }

  function withValueAt<T>(source: T, path: readonly string[], value: string): T {
    const copy: unknown = Array.isArray(source)
      ? [...(source as unknown[])]
      : { ...(source as object) };
    const [head, ...rest] = path;
    const container = copy as Record<string, unknown>;
    container[head] =
      rest.length === 0 ? value : withValueAt(container[head], rest, value);
    return copy as T;
  }

  /**
   * One fully-populated, VALID block per kind — every field the canvas can
   * type into filled in, so the sweep below has something to clear. Data, not
   * a case list: the cases come out of walking these.
   */
  const cardContent = {
    variant: "feature" as const,
    eyebrow: "Small line",
    heading: "Card heading",
    body: "Body **copy**.",
    attribution: "Ada Lovelace",
    ctaLabel: "Read more",
    ctaUrl: "https://x.test/more",
    imageUrl: "https://x.test/a.png",
    imageAlt: "A picture",
    imageSide: "left" as const,
    imageWidthPct: 44,
    align: "left" as const,
    ctaStyle: "filled" as const,
  };

  const populated: Record<string, EmailBlock> = {
    heading: { id: "x", kind: "heading", text: "Heading", level: 1 },
    text: { id: "x", kind: "text", markdown: "One.\n\nTwo." },
    image: {
      id: "x",
      kind: "image",
      url: "https://x.test/a.png",
      alt: "A picture",
      href: "https://x.test",
      width: "half",
    },
    button: {
      id: "x",
      kind: "button",
      label: "Give",
      url: "https://x.test",
      align: "center",
      variant: "filled",
    },
    bleed_image: {
      id: "x",
      kind: "bleed_image",
      url: "https://x.test/b.png",
      alt: "A banner",
      href: "https://x.test",
      inset: true,
    },
    hairline: { id: "x", kind: "hairline" },
    divider: { id: "x", kind: "divider" },
    spacer: { id: "x", kind: "spacer", size: "md" },
    eyebrow: { id: "x", kind: "eyebrow", text: "THIS MONTH", icon: "◆" },
    quote: { id: "x", kind: "quote", text: "A line worth pulling out.", attribution: "Ada" },
    poll: {
      id: "x",
      kind: "poll",
      question: "What should we do next?",
      options: [
        { id: "o1", label: "Option 1" },
        { id: "o2", label: "Option 2" },
      ],
    },
    footer: {
      id: "x",
      kind: "footer",
      logoUrl: "https://x.test/logo.png",
      logoAlt: "Public Worship",
      navLine: "Sundays · 10am",
      links: [
        { label: "Instagram", url: "https://ig.test" },
        { label: "Give", url: "https://give.test" },
      ],
    },
    card: { id: "x", kind: "card", ...cardContent },
    columns: {
      id: "x",
      kind: "columns",
      columns: [cardContent, { ...cardContent, variant: "outlined" }],
    },
  };

  /** The assertion, both ways round: a blocking warning iff the gate refuses.
   *  The gate's own message rides along on both sides so a failure names the
   *  rule that disagreed instead of just "expected true to be false". */
  function expectParity(label: string, block: EmailBlock) {
    const document = doc([block]);
    const gate = validateEmailDocument(document);
    const summary = documentWarnings(document);
    const reason = gate.ok ? null : gate.error;
    expect({ label, blocking: summary.blockingCount > 0, reason }).toEqual({
      label,
      blocking: !gate.ok,
      reason,
    });
  }

  test("the fixtures cover every block kind the palette can add", () => {
    // A new block kind fails HERE — loudly, and before it can reach the sweep
    // as a silent hole.
    expect(Object.keys(populated).sort()).toEqual([...BLOCK_KINDS].sort());
  });

  test("every populated fixture is saveable and warning-free", () => {
    for (const [kind, block] of Object.entries(populated)) {
      expect({ kind, ...validateEmailDocument(doc([block])) }).toEqual({ kind, ok: true, doc: doc([block]) });
      expect({ kind, warnings: blockWarnings(block) }).toEqual({ kind, warnings: [] });
    }
  });

  test("an empty document is saveable and silent", () => {
    expectParity("empty document", { id: "x", kind: "divider" });
    expect(documentWarnings(doc([])).blockingCount).toBe(0);
    expect(validateEmailDocument(doc([])).ok).toBe(true);
  });

  /**
   * The sweep. For every kind, for every string the canvas can clear:
   *  - `""`, which is what backspacing the last character commits, and
   *  - `" "`, which the gate accepts wherever it tests `.length > 0` — so a
   *    warning that trimmed would be crying wolf on a document that saves.
   */
  for (const [kind, block] of Object.entries(populated)) {
    const paths = typedStringPaths(block);
    for (const path of paths) {
      const field = path.join(".");
      for (const [name, value] of [
        ["cleared", ""],
        ["a single space", " "],
      ] as const) {
        test(`${kind}: ${field} ${name}`, () => {
          expectParity(`${kind}.${field} = ${JSON.stringify(value)}`, withValueAt(block, path, value));
        });
      }
    }
  }

  test("the sweep is actually sweeping — every kind contributed at least the fields it has", () => {
    // Cheap guard against a walker bug quietly reducing the sweep to nothing:
    // these counts are what the fixtures above contain today.
    expect(typedStringPaths(populated.eyebrow)).toEqual([["text"], ["icon"]]);
    expect(typedStringPaths(populated.quote)).toEqual([["text"], ["attribution"]]);
    expect(typedStringPaths(populated.poll)).toEqual([
      ["question"],
      ["options", "0", "label"],
      ["options", "1", "label"],
    ]);
    expect(typedStringPaths(populated.columns).length).toBeGreaterThan(10);
    expect(typedStringPaths(populated.divider)).toEqual([]);
  });
});
