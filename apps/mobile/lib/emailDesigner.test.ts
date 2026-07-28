// No @types/jest / ambient globals configured for this package — import test
// globals explicitly from @jest/globals (mirrors `lib/financeSeats.test.ts`).
import { describe, expect, test } from "@jest/globals";
import {
  DEFAULT_EMAIL_THEME,
  MIN_COLUMNS,
  validateEmailDocument,
  type EmailBlock,
  type EmailBlockKind,
  type EmailDocument,
  type EmailPollOption,
} from "@events-os/shared";
import {
  BLOCK_GROUPS,
  BLOCK_KINDS,
  BLOCK_KIND_LABELS,
  CARD_VARIANT_OPTIONS,
  DEFAULT_IMAGE_WIDTH_PCT,
  MAX_FOOTER_LINKS,
  MAX_IMAGE_WIDTH_PCT,
  MIN_IMAGE_WIDTH_PCT,
  canRedo,
  canUndo,
  cardCtaUrlProblem,
  clampImageWidthPct,
  ctaPairProblem,
  defaultBlockFor,
  duplicateBlock,
  explainDocError,
  footerLinkProblem,
  bleedImageUrlProblem,
  imageAltProblem,
  imageUrlProblem,
  initHistory,
  insertBlock,
  linkUrlProblem,
  moveBlock,
  optionalImageUrlProblem,
  optionalLinkUrlProblem,
  pollHasBlankLabel,
  pushHistory,
  redoHistory,
  removeBlock,
  reorderBlocks,
  stepImageWidthPct,
  syncListKeys,
  undoHistory,
  updateBlock,
  type History,
} from "./emailDesigner";

/** A deterministic id factory for tests — `id1`, `id2`, … in call order. */
function seededIds(prefix = "id"): () => string {
  let n = 0;
  return () => `${prefix}${++n}`;
}

const emptyDoc: EmailDocument = { blocks: [] };

describe("defaultBlockFor", () => {
  test("produces a valid starting block for every kind", () => {
    for (const kind of BLOCK_KINDS) {
      const block = defaultBlockFor(kind, "x");
      expect(block.id).toBe("x");
      expect(block.kind).toBe(kind);
    }
  });
});

describe("insertBlock", () => {
  test("appends to an empty doc when afterId is null", () => {
    const { doc, id } = insertBlock(emptyDoc, "heading", null, seededIds());
    expect(doc.blocks).toHaveLength(1);
    expect(doc.blocks[0].id).toBe(id);
    expect(doc.blocks[0].kind).toBe("heading");
  });

  test("inserts immediately after the given block", () => {
    const withOne = insertBlock(emptyDoc, "heading", null, seededIds()).doc;
    const { doc, id } = insertBlock(withOne, "text", withOne.blocks[0].id, seededIds("t"));
    expect(doc.blocks.map((b) => b.id)).toEqual([withOne.blocks[0].id, id]);
    expect(doc.blocks[1].kind).toBe("text");
  });

  test("appends at the end when afterId doesn't match any block", () => {
    const withOne = insertBlock(emptyDoc, "heading", null, seededIds()).doc;
    const { doc } = insertBlock(withOne, "divider", "missing", seededIds("d"));
    expect(doc.blocks).toHaveLength(2);
    expect(doc.blocks[1].kind).toBe("divider");
  });

  test("does not mutate the input doc", () => {
    const before = emptyDoc;
    insertBlock(before, "spacer", null, seededIds());
    expect(before.blocks).toHaveLength(0);
  });
});

describe("removeBlock", () => {
  test("removes the matching block only", () => {
    const gen = seededIds();
    let doc = insertBlock(emptyDoc, "heading", null, gen).doc;
    const second = insertBlock(doc, "text", null, gen);
    doc = second.doc;
    const result = removeBlock(doc, doc.blocks[0].id);
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].id).toBe(second.id);
  });

  test("is a no-op when the id isn't found", () => {
    const doc = insertBlock(emptyDoc, "heading", null, seededIds()).doc;
    const result = removeBlock(doc, "nope");
    expect(result.blocks).toEqual(doc.blocks);
  });
});

describe("duplicateBlock", () => {
  test("inserts a copy right after the source with a new id", () => {
    const gen = seededIds();
    const doc = insertBlock(emptyDoc, "button", null, gen).doc;
    const sourceId = doc.blocks[0].id;
    const { doc: doc2, id } = duplicateBlock(doc, sourceId, seededIds("dup"));
    expect(id).toBe("dup1");
    expect(doc2.blocks.map((b) => b.id)).toEqual([sourceId, "dup1"]);
    // Content copied verbatim (kind + fields), only the id differs.
    expect(doc2.blocks[1]).toEqual({ ...doc2.blocks[0], id: "dup1" });
  });

  test("returns id: null and an unchanged doc when the source isn't found", () => {
    const doc = insertBlock(emptyDoc, "button", null, seededIds()).doc;
    const result = duplicateBlock(doc, "missing", seededIds("dup"));
    expect(result.id).toBeNull();
    expect(result.doc).toBe(doc);
  });
});

describe("updateBlock", () => {
  test("merges the patch into the matching block only", () => {
    const gen = seededIds();
    let doc = insertBlock(emptyDoc, "heading", null, gen).doc;
    const secondIns = insertBlock(doc, "heading", null, gen);
    doc = secondIns.doc;
    const firstId = doc.blocks[0].id;
    const result = updateBlock(doc, firstId, { text: "Hello" });
    expect((result.blocks[0] as any).text).toBe("Hello");
    expect((result.blocks[1] as any).text).toBe("Heading"); // untouched
  });
});

describe("reorderBlocks", () => {
  test("reorders to match the given id order", () => {
    const gen = seededIds();
    let doc = insertBlock(emptyDoc, "heading", null, gen).doc;
    doc = insertBlock(doc, "text", null, gen).doc;
    doc = insertBlock(doc, "divider", null, gen).doc;
    const [a, b, c] = doc.blocks.map((x) => x.id);
    const result = reorderBlocks(doc, [c, a, b]);
    expect(result.blocks.map((x) => x.id)).toEqual([c, a, b]);
  });

  test("appends any block missing from orderedIds rather than dropping it", () => {
    const gen = seededIds();
    let doc = insertBlock(emptyDoc, "heading", null, gen).doc;
    doc = insertBlock(doc, "text", null, gen).doc;
    const [a, b] = doc.blocks.map((x) => x.id);
    const result = reorderBlocks(doc, [b]); // `a` omitted
    expect(result.blocks.map((x) => x.id)).toEqual([b, a]);
  });

  test("skips stale ids not present in the doc", () => {
    const gen = seededIds();
    const doc = insertBlock(emptyDoc, "heading", null, gen).doc;
    const [a] = doc.blocks.map((x) => x.id);
    const result = reorderBlocks(doc, [a, "ghost"]);
    expect(result.blocks.map((x) => x.id)).toEqual([a]);
  });
});

describe("history (undo/redo)", () => {
  test("pushHistory moves the old present into past and clears future", () => {
    let h: History<number> = initHistory(0);
    h = pushHistory(h, 1);
    h = pushHistory(h, 2);
    expect(h).toEqual({ past: [0, 1], present: 2, future: [] });
  });

  test("undo then redo round-trips to the same present", () => {
    let h: History<number> = initHistory(0);
    h = pushHistory(h, 1);
    h = pushHistory(h, 2);
    h = undoHistory(h);
    expect(h.present).toBe(1);
    h = undoHistory(h);
    expect(h.present).toBe(0);
    expect(canUndo(h)).toBe(false);
    h = redoHistory(h);
    expect(h.present).toBe(1);
    h = redoHistory(h);
    expect(h.present).toBe(2);
    expect(canRedo(h)).toBe(false);
  });

  test("a new edit after undo discards the redo branch", () => {
    let h: History<number> = initHistory(0);
    h = pushHistory(h, 1);
    h = pushHistory(h, 2);
    h = undoHistory(h); // present: 1, future: [2]
    h = pushHistory(h, 99); // new branch
    expect(h).toEqual({ past: [0, 1], present: 99, future: [] });
    expect(canRedo(h)).toBe(false);
  });

  test("undo/redo are no-ops at the boundaries", () => {
    const h = initHistory(0);
    expect(undoHistory(h)).toBe(h);
    expect(redoHistory(h)).toBe(h);
    expect(canUndo(h)).toBe(false);
    expect(canRedo(h)).toBe(false);
  });
});

// ── Regression suites added with the composed blocks (eyebrow/card/columns/
//    quote/poll) and the document-level `theme` field ─────────────────────────

describe("defaultBlockFor — every new block must be SAVEABLE", () => {
  // `image` is the ONE kind whose default can't validate, and deliberately so:
  // its `url` must be a non-empty http(s) string, and the only way to satisfy
  // that up front is a fabricated URL that would render as a broken image and
  // could be sent for real if nobody noticed. An unsaveable block that says
  // "image url must be a non-empty string" is the better failure — the
  // composer's save indicator surfaces it, and filling the field fixes it.
  //
  // The newsletter blocks are NOT exceptions and must never become ones: a
  // banner's url is optional (an empty one renders as a placeholder band) and
  // every field of a footer is optional, so both have to save on insert.
  const NEEDS_INPUT_BEFORE_SAVING: EmailBlockKind[] = ["image"];

  test("every other kind's default passes the write gate on its own", () => {
    // The composer autosaves 600ms after a block is added, and
    // `campaigns.updateCampaignDoc` rejects an invalid document outright, so a
    // default that doesn't validate means the designer's very next edit
    // silently fails to save. This is the guard for that.
    for (const kind of BLOCK_KINDS) {
      if (NEEDS_INPUT_BEFORE_SAVING.includes(kind)) continue;
      const doc: EmailDocument = { blocks: [defaultBlockFor(kind, "blk1")] };
      const result = validateEmailDocument(doc);
      expect([kind, result.ok ? null : result.error]).toEqual([kind, null]);
    }
  });

  test("poll options get unique ids that are not derived from their labels", () => {
    const poll = defaultBlockFor("poll", "p1");
    if (poll.kind !== "poll") throw new Error("expected a poll block");
    const ids = poll.options.map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const option of poll.options) {
      expect(option.id).not.toContain(option.label);
    }
  });

  test("columns start at the minimum, not the maximum", () => {
    const columns = defaultBlockFor("columns", "c1");
    if (columns.kind !== "columns") throw new Error("expected a columns block");
    expect(columns.columns).toHaveLength(MIN_COLUMNS);
  });
});

describe("document-level fields survive every block operation", () => {
  // `EmailDocument` grew an optional `theme`; a helper that rebuilt the doc as
  // a bare `{ blocks }` would strip it and autosave the stripped version — an
  // off-brand send caused by an unrelated edit.
  const themed: EmailDocument = {
    theme: { ...DEFAULT_EMAIL_THEME, name: "Advent" },
    blocks: [defaultBlockFor("heading", "h1"), defaultBlockFor("text", "t1")],
  };

  test("insertBlock keeps the theme", () => {
    expect(insertBlock(themed, "quote", null, seededIds()).doc.theme).toEqual(themed.theme);
  });

  test("removeBlock keeps the theme", () => {
    expect(removeBlock(themed, "h1").theme).toEqual(themed.theme);
  });

  test("duplicateBlock keeps the theme", () => {
    expect(duplicateBlock(themed, "h1", seededIds()).doc.theme).toEqual(themed.theme);
  });

  test("updateBlock keeps the theme", () => {
    expect(updateBlock(themed, "h1", { text: "Hi" }).theme).toEqual(themed.theme);
  });

  test("reorderBlocks keeps the theme", () => {
    expect(reorderBlocks(themed, ["t1", "h1"]).theme).toEqual(themed.theme);
  });
});

// ── The inline warnings must agree with the write gate ─────────────────────
//
// `updateCampaignDoc` rejects an invalid document WHOLE — every block's edits
// go down with the one bad field — so the designer's inline warnings are only
// useful if they fire on exactly the states the server refuses. Each suite
// below pins one predicate against `validateEmailDocument` itself rather than
// against a restatement of its rules.

/** Does the real write gate accept a document containing just this block? */
function gateAccepts(block: EmailBlock): boolean {
  return validateEmailDocument({ blocks: [block] }).ok;
}

describe("imageUrlProblem", () => {
  const CASES = [
    "",
    "   ",
    "example.com",
    "/local/photo.png",
    "ftp://example.com/photo.png",
    "javascript:alert(1)",
    "https://example.com/photo.png",
    "http://example.com/photo.png",
    "  https://example.com/photo.png  ",
  ];

  test("flags exactly the urls the write gate rejects", () => {
    for (const url of CASES) {
      const block: EmailBlock = { id: "i1", kind: "image", url, alt: "" };
      expect([url, imageUrlProblem(url) === null]).toEqual([url, gateAccepts(block)]);
    }
  });

  test("distinguishes an unfilled url from a scheme-less one", () => {
    expect(imageUrlProblem("")).toBe("missing");
    expect(imageUrlProblem("   ")).toBe("missing");
    expect(imageUrlProblem("example.com/photo.png")).toBe("scheme");
  });

  test("the freshly-added image block warns — it is what blocks the save", () => {
    // The regression: `defaultBlockFor("image")` starts with an empty url, the
    // gate rejects it, and the card used to say nothing about the url at all
    // (it warned about the ALT, which the gate explicitly accepts as "").
    const image = defaultBlockFor("image", "i1");
    if (image.kind !== "image") throw new Error("expected an image block");
    expect(imageUrlProblem(image.url)).toBe("missing");
    expect(image.alt).toBe("");
  });

  test("an empty image block takes the WHOLE document down with it", () => {
    // Why the warning has to name the blast radius: every other block edited
    // while this one sits unfilled also fails to save.
    const doc: EmailDocument = {
      blocks: [defaultBlockFor("heading", "h1"), defaultBlockFor("image", "i1")],
    };
    expect(validateEmailDocument(doc).ok).toBe(false);
  });

  test("an image with a url and no alt is ACCEPTED — '' means decorative", () => {
    expect(gateAccepts({ id: "i1", kind: "image", url: "https://x/p.png", alt: "" })).toBe(
      true,
    );
    expect(imageUrlProblem("https://x/p.png")).toBeNull();
  });
});

describe("ctaPairProblem", () => {
  function card(content: { ctaLabel?: string; ctaUrl?: string }): EmailBlock {
    return { id: "c1", kind: "card", heading: "Hi", ...content };
  }

  const CASES: { ctaLabel?: string; ctaUrl?: string }[] = [
    {},
    { ctaLabel: "Read more" },
    { ctaUrl: "https://example.com" },
    { ctaLabel: "Read more", ctaUrl: "https://example.com" },
    { ctaLabel: "" },
    { ctaLabel: "", ctaUrl: "" },
    { ctaLabel: " " },
    { ctaUrl: " " },
    { ctaLabel: " ", ctaUrl: "https://example.com" },
  ];

  test("warns on exactly the pairs the write gate rejects", () => {
    for (const content of CASES) {
      const label = JSON.stringify(content);
      expect([label, ctaPairProblem(content) === null]).toEqual([
        label,
        gateAccepts(card(content)),
      ]);
    }
  });

  test("a label backspaced down to a stray space still warns", () => {
    // The regression: the form tested `!!ctaLabel?.trim()` while the gate
    // tests `.length > 0` on the RAW string, so " " with no url was silent in
    // the UI and fatal on save.
    expect(ctaPairProblem({ ctaLabel: " " })).toBe("label-without-url");
    expect(gateAccepts(card({ ctaLabel: " " }))).toBe(false);
  });

  test("names which half is missing", () => {
    expect(ctaPairProblem({ ctaLabel: "Read more" })).toBe("label-without-url");
    expect(ctaPairProblem({ ctaUrl: "https://example.com" })).toBe("url-without-label");
  });
});

describe("pollHasBlankLabel", () => {
  function optionsFor(labels: string[]): EmailPollOption[] {
    return labels.map((label, i) => ({ id: `o${i}`, label }));
  }

  function poll(labels: string[]): EmailBlock {
    return { id: "p1", kind: "poll", question: "What next?", options: optionsFor(labels) };
  }

  test("warns on exactly the option lists the write gate rejects", () => {
    const CASES = [
      ["Yes", "No"],
      ["", "No"],
      ["Yes", ""],
      [" ", "No"],
      ["  ", "   "],
    ];
    for (const labels of CASES) {
      const key = JSON.stringify(labels);
      expect([key, !pollHasBlankLabel(optionsFor(labels))]).toEqual([
        key,
        gateAccepts(poll(labels)),
      ]);
    }
  });

  test("a whitespace-only label does NOT warn — the gate saves it", () => {
    // The regression: the form trimmed, the gate doesn't. Warning here told
    // the designer her campaign couldn't be saved when it saved fine.
    expect(pollHasBlankLabel(optionsFor([" "]))).toBe(false);
    expect(gateAccepts(poll([" ", "No"]))).toBe(true);
  });

  test("a genuinely empty label warns", () => {
    expect(pollHasBlankLabel(optionsFor([""]))).toBe(true);
  });
});

// ── The newsletter blocks: banner, hairline, footer ────────────────────────

describe("the block tables cover every kind in the contract", () => {
  test("BLOCK_KINDS lists each kind exactly once", () => {
    expect(new Set(BLOCK_KINDS).size).toBe(BLOCK_KINDS.length);
  });

  test("every kind has a label, a default, and a palette entry", () => {
    // The four tables (`BLOCK_KIND_LABELS`, `BLOCK_KINDS`, `defaultBlockFor`,
    // `KIND_ICON`) are separate by necessity — `KIND_ICON` lives with the
    // palette component — and a kind added to the union without all four is
    // an editor that renders a blank card or crashes on a missing label.
    // `KIND_ICON` is typed `Record<EmailBlockKind, IconName>`, so the compiler
    // holds that one; these three are checked here.
    for (const kind of BLOCK_KINDS) {
      expect([kind, typeof BLOCK_KIND_LABELS[kind]]).toEqual([kind, "string"]);
      expect(defaultBlockFor(kind, "x").kind).toBe(kind);
    }
  });

  test("BLOCK_KINDS covers every kind the labels table knows", () => {
    // `BLOCK_KIND_LABELS` is a `Record<EmailBlockKind, string>`, so the
    // compiler forces it to be exhaustive — which makes it the honest list of
    // the union at runtime, and a kind missing from the PALETTE (a kind
    // nobody can add) shows up as a difference here.
    expect([...BLOCK_KINDS].sort()).toEqual(Object.keys(BLOCK_KIND_LABELS).sort());
  });
});

describe("bleed_image (the banner block)", () => {
  test("its default saves as-is — an unfilled banner is a placeholder, not an error", () => {
    // The contract makes a banner's url OPTIONAL precisely so a template can
    // say "the masthead goes here" without naming a URL. A default that
    // warned (or blocked the save) would contradict that on every insert.
    const banner = defaultBlockFor("bleed_image", "b1");
    if (banner.kind !== "bleed_image") throw new Error("expected a bleed_image block");
    expect(banner.url).toBeUndefined();
    expect(banner.alt).toBe("");
    expect(gateAccepts(banner)).toBe(true);
    expect(bleedImageUrlProblem(banner.url)).toBeNull();
  });

  test("bleedImageUrlProblem flags exactly the urls the gate rejects", () => {
    const CASES: (string | undefined)[] = [
      undefined,
      "",
      "   ",
      "example.com",
      "ftp://x/b.png",
      "javascript:alert(1)",
      "https://x/b.png",
      "http://x/b.png",
    ];
    for (const url of CASES) {
      const block = {
        id: "b1",
        kind: "bleed_image" as const,
        alt: "",
        ...(url === undefined ? {} : { url }),
      };
      const key = String(url);
      expect([key, bleedImageUrlProblem(url) === null]).toEqual([
        key,
        gateAccepts(block as EmailBlock),
      ]);
    }
  });

  test("the empty banner does NOT warn — the gate saves it", () => {
    // The mirror of the `image` block's rule, and the opposite answer: warning
    // here would tell the designer her campaign can't be saved when it can.
    expect(bleedImageUrlProblem(undefined)).toBeNull();
    expect(bleedImageUrlProblem("")).toBeNull();
    expect(bleedImageUrlProblem("example.com")).toBe("scheme");
  });

  test("inset is a plain boolean the gate accepts either way", () => {
    for (const inset of [undefined, true, false]) {
      const block = {
        id: "b1",
        kind: "bleed_image" as const,
        alt: "",
        ...(inset === undefined ? {} : { inset }),
      };
      expect([String(inset), gateAccepts(block as EmailBlock)]).toEqual([
        String(inset),
        true,
      ]);
    }
  });

  test("a missing alt is REJECTED — the same rule the card images carry", () => {
    const withAlt: EmailBlock = {
      id: "b1",
      kind: "bleed_image",
      url: "https://x/b.png",
      alt: "",
    };
    // `alt: ""` saves (decorative); dropping the field entirely does not.
    expect(gateAccepts(withAlt)).toBe(true);
    const { alt: _alt, ...withoutAlt } = withAlt;
    expect(gateAccepts(withoutAlt as EmailBlock)).toBe(false);
    expect(imageAltProblem({ url: "https://x/b.png", alt: undefined })).toBe("unsaveable");
    expect(imageAltProblem({ url: "https://x/b.png", alt: "" })).toBe("empty");
    expect(imageAltProblem({ url: "https://x/b.png", alt: "A banner" })).toBeNull();
  });

  test("an optional href warns on exactly what the gate refuses", () => {
    const CASES: (string | undefined)[] = [
      undefined,
      "",
      "https://x",
      "mailto:a@b.c",
      "example.com",
      "javascript:alert(1)",
    ];
    for (const href of CASES) {
      const block = {
        id: "b1",
        kind: "bleed_image" as const,
        url: "https://x/b.png",
        alt: "",
        ...(href === undefined ? {} : { href }),
      };
      const key = String(href);
      expect([key, optionalLinkUrlProblem(href) === null]).toEqual([
        key,
        gateAccepts(block as EmailBlock),
      ]);
    }
  });
});

describe("footer", () => {
  test("its default saves as-is — nothing about a footer is required", () => {
    expect(gateAccepts(defaultBlockFor("footer", "f1"))).toBe(true);
  });

  test("a logo url follows the same rules as any other image", () => {
    for (const logoUrl of [undefined, "", "example.com", "ftp://x/l.png", "https://x/l.png"]) {
      const block = {
        id: "f1",
        kind: "footer" as const,
        ...(logoUrl === undefined ? {} : { logoUrl, logoAlt: "" }),
      };
      const key = String(logoUrl);
      expect([key, optionalImageUrlProblem(logoUrl) === null]).toEqual([
        key,
        gateAccepts(block as EmailBlock),
      ]);
    }
  });

  test("a logo with no alt is REJECTED, and '' is the decorative escape", () => {
    // The rule the card images carry, applied to the one image in the footer.
    const withLogo = { id: "f1", kind: "footer" as const, logoUrl: "https://x/l.png" };
    expect(gateAccepts(withLogo as EmailBlock)).toBe(false);
    expect(imageAltProblem({ url: withLogo.logoUrl, alt: undefined })).toBe("unsaveable");
    expect(gateAccepts({ ...withLogo, logoAlt: "" } as EmailBlock)).toBe(true);
    expect(imageAltProblem({ url: withLogo.logoUrl, alt: "" })).toBe("empty");
  });

  test("footerLinkProblem flags exactly the link rows the gate rejects", () => {
    const CASES = [
      { label: "Instagram", url: "https://x" },
      { label: "Mail us", url: "mailto:a@b.c" },
      { label: "", url: "https://x" },
      { label: "Instagram", url: "" },
      { label: "Instagram", url: "example.com" },
      { label: "Instagram", url: "javascript:alert(1)" },
      { label: " ", url: "https://x" },
      { label: "Instagram", url: " " },
    ];
    for (const link of CASES) {
      const key = JSON.stringify(link);
      const block: EmailBlock = { id: "f1", kind: "footer", links: [link] };
      expect([key, footerLinkProblem(link) === null]).toEqual([key, gateAccepts(block)]);
    }
  });

  test("a whitespace label is SAVEABLE — the gate tests the raw string", () => {
    // Same raw-string semantics `pollHasBlankLabel` is pinned on: warning here
    // would tell the designer her campaign can't be saved when it saves fine.
    expect(footerLinkProblem({ label: " ", url: "https://x" })).toBeNull();
  });

  test("the freshly-added link row is saveable on the spot", () => {
    // What `FooterEditor`'s "+ Add link" inserts. A row that made the document
    // unsaveable the instant it appeared would block every other block's edits
    // while the designer was still typing the label.
    const row = { label: "Instagram", url: "https://" };
    expect(footerLinkProblem(row)).toBeNull();
    expect(gateAccepts({ id: "f1", kind: "footer", links: [row] })).toBe(true);
  });

  test("MAX_FOOTER_LINKS mirrors the gate's own cap", () => {
    const row = { label: "Instagram", url: "https://x" };
    const atCap = Array.from({ length: MAX_FOOTER_LINKS }, () => ({ ...row }));
    expect(gateAccepts({ id: "f1", kind: "footer", links: atCap })).toBe(true);
    expect(gateAccepts({ id: "f1", kind: "footer", links: [...atCap, { ...row }] })).toBe(
      false,
    );
  });
});

describe("hairline", () => {
  test("has no fields to get wrong", () => {
    expect(defaultBlockFor("hairline", "h1")).toEqual({ id: "h1", kind: "hairline" });
    expect(gateAccepts({ id: "h1", kind: "hairline" })).toBe(true);
  });
});

// ── Card presentation fields ───────────────────────────────────────────────

describe("card variants and layout", () => {
  test("every variant the picker offers is one the gate accepts", () => {
    for (const option of CARD_VARIANT_OPTIONS) {
      const block: EmailBlock = { id: "c1", kind: "card", heading: "Hi", variant: option.value };
      expect([option.value, gateAccepts(block)]).toEqual([option.value, true]);
    }
  });

  test("the picker offers every variant in the contract", () => {
    // A variant the renderer paints but the picker can't reach is a feature
    // nobody can use; one the picker offers but the gate refuses is a save
    // that fails on a tap.
    expect([...CARD_VARIANT_OPTIONS.map((o) => o.value)].sort()).toEqual(
      ["feature", "hero", "outlined", "plain", "testimonial"].sort(),
    );
  });

  test("clampImageWidthPct never produces a width the gate rejects", () => {
    for (const raw of [-100, 0, 19.6, 20, 45, 52.4, 80, 81, 1000, Number.NaN]) {
      const pct = clampImageWidthPct(raw);
      const block: EmailBlock = {
        id: "c1",
        kind: "card",
        heading: "Hi",
        imageUrl: "https://x/p.png",
        imageAlt: "",
        imageSide: "left",
        imageWidthPct: pct,
      };
      expect([raw, gateAccepts(block)]).toEqual([raw, true]);
      expect(Number.isInteger(pct)).toBe(true);
    }
  });

  test("the mirrored bounds are the gate's own bounds", () => {
    function cardAt(pct: number): EmailBlock {
      return { id: "c1", kind: "card", heading: "Hi", imageWidthPct: pct };
    }
    expect(gateAccepts(cardAt(MIN_IMAGE_WIDTH_PCT))).toBe(true);
    expect(gateAccepts(cardAt(MAX_IMAGE_WIDTH_PCT))).toBe(true);
    expect(gateAccepts(cardAt(MIN_IMAGE_WIDTH_PCT - 1))).toBe(false);
    expect(gateAccepts(cardAt(MAX_IMAGE_WIDTH_PCT + 1))).toBe(false);
  });

  test("stepImageWidthPct starts from the renderer's default and stops at the ends", () => {
    expect(stepImageWidthPct(undefined, 2)).toBe(DEFAULT_IMAGE_WIDTH_PCT + 2);
    expect(stepImageWidthPct(undefined, -2)).toBe(DEFAULT_IMAGE_WIDTH_PCT - 2);
    expect(stepImageWidthPct(MIN_IMAGE_WIDTH_PCT, -10)).toBe(MIN_IMAGE_WIDTH_PCT);
    expect(stepImageWidthPct(MAX_IMAGE_WIDTH_PCT, 10)).toBe(MAX_IMAGE_WIDTH_PCT);
  });

  test("an eyebrow and an attribution are plain strings the gate accepts", () => {
    expect(
      gateAccepts({
        id: "c1",
        kind: "card",
        variant: "testimonial",
        eyebrow: "WHAT PEOPLE SAY",
        attribution: "Sam, Tuesday nights",
        align: "center",
        ctaStyle: "outline",
        imageSide: "right",
        imageWidthPct: 44,
      }),
    ).toBe(true);
  });
});

describe("a card's own image url", () => {
  test("optionalImageUrlProblem flags exactly what the card arm rejects", () => {
    // The card's rule is its own: absent is fine (there's no image), but a url
    // that IS set must be non-empty and http(s). The scheme half had no
    // warning at all, so a pasted `example.com` stopped every save on the page
    // with nothing on screen to explain it.
    const CASES: (string | undefined)[] = [
      undefined,
      "",
      "example.com",
      "ftp://x/p.png",
      "javascript:alert(1)",
      "https://x/p.png",
    ];
    for (const imageUrl of CASES) {
      const block = {
        id: "c1",
        kind: "card" as const,
        heading: "Hi",
        ...(imageUrl === undefined ? {} : { imageUrl, imageAlt: "" }),
      };
      const key = String(imageUrl);
      expect([key, optionalImageUrlProblem(imageUrl) === null]).toEqual([
        key,
        gateAccepts(block as EmailBlock),
      ]);
    }
  });
});

describe("link url warnings", () => {
  test("linkUrlProblem flags exactly the button urls the gate rejects", () => {
    const CASES = [
      "",
      " ",
      "https://",
      "https://x",
      "http://x",
      "mailto:a@b.c",
      "example.com",
      "ftp://x",
      "javascript:alert(1)",
    ];
    for (const url of CASES) {
      const block: EmailBlock = { id: "b1", kind: "button", label: "Go", url };
      expect([url, linkUrlProblem(url) === null]).toEqual([url, gateAccepts(block)]);
    }
  });

  test("the freshly-added button is saveable — its https:// stub passes", () => {
    const button = defaultBlockFor("button", "b1");
    expect(gateAccepts(button)).toBe(true);
  });

  test("cardCtaUrlProblem catches the scheme the pair check can't see", () => {
    // The gate checks the PAIR first and the scheme second, so a card with
    // both halves filled and a `tel:` link is rejected by a rule
    // `ctaPairProblem` says nothing about — which used to mean no warning at
    // all, and a save that stopped working.
    const content = { ctaLabel: "Call us", ctaUrl: "tel:+441234" };
    expect(ctaPairProblem(content)).toBeNull();
    expect(cardCtaUrlProblem(content)).toBe("scheme");
    expect(gateAccepts({ id: "c1", kind: "card", ...content })).toBe(false);
  });

  test("together, the two card CTA warnings cover the gate exactly", () => {
    const CASES = [
      {},
      { ctaLabel: "Read", ctaUrl: "https://x" },
      { ctaLabel: "Read", ctaUrl: "mailto:a@b.c" },
      { ctaLabel: "Read" },
      { ctaUrl: "https://x" },
      { ctaLabel: "Read", ctaUrl: "example.com" },
      { ctaLabel: "", ctaUrl: "ftp://x" },
      { ctaLabel: " ", ctaUrl: "tel:+44" },
    ];
    for (const content of CASES) {
      const key = JSON.stringify(content);
      const quiet = ctaPairProblem(content) === null && cardCtaUrlProblem(content) === null;
      expect([key, quiet]).toEqual([key, gateAccepts({ id: "c1", kind: "card", ...content })]);
    }
  });
});

describe("syncListKeys", () => {
  test("is a no-op (same reference) when the length already matches", () => {
    const keys = ["a", "b"];
    expect(syncListKeys(keys, 2, seededIds())).toBe(keys);
  });

  test("appends fresh keys for a grown list, keeping the existing ones", () => {
    expect(syncListKeys(["a", "b"], 4, seededIds("k"))).toEqual(["a", "b", "k1", "k2"]);
  });

  test("truncates from the end for a shrunken list", () => {
    expect(syncListKeys(["a", "b", "c"], 1)).toEqual(["a"]);
  });

  test("seeds a whole list from empty with unique keys", () => {
    const keys = syncListKeys([], 3);
    expect(new Set(keys).size).toBe(3);
  });

  test("a column removed from the MIDDLE leaves the survivors' keys intact", () => {
    // The regression this exists for: `key={index}` re-keyed column 3's data
    // onto the subtree rendering column 2, carrying that subtree's image-
    // library ref and half-typed caret across to a different column's data.
    // `ColumnsEditor` splices the key out with the column, so the surviving
    // columns keep the keys — and therefore the subtrees — they had.
    const keys = syncListKeys([], 3, seededIds("col"));
    const columns = ["one", "two", "three"];
    const removed = 1;
    const nextKeys = keys.filter((_, i) => i !== removed);
    const nextColumns = columns.filter((_, i) => i !== removed);
    expect(nextKeys).toEqual(["col1", "col3"]);
    // Every surviving column is still paired with the key it started with.
    for (const [i, column] of nextColumns.entries()) {
      expect(nextKeys[i]).toBe(keys[columns.indexOf(column)]);
    }
    // And the reconcile agrees, so the render that follows doesn't re-key.
    expect(syncListKeys(nextKeys, nextColumns.length)).toBe(nextKeys);
  });
});

// ── Composer ergonomics: the grouped palette and keyboard-free reordering ───

describe("BLOCK_GROUPS (the grouped palette)", () => {
  test("covers every kind in the contract exactly once", () => {
    const grouped = BLOCK_GROUPS.flatMap((g) => g.kinds);
    expect(new Set(grouped).size).toBe(grouped.length);
    expect([...grouped].sort()).toEqual([...BLOCK_KINDS].sort());
  });

  test("BLOCK_KINDS is the flattened groups, in group order", () => {
    // Derived, not maintained in parallel: a kind added to a group shows up
    // in the flat list (and therefore in every test that walks it) for free.
    expect(BLOCK_KINDS).toEqual(BLOCK_GROUPS.flatMap((g) => [...g.kinds]));
  });

  test("every group has a title and a hint, and no group is empty", () => {
    for (const group of BLOCK_GROUPS) {
      expect(group.title.length).toBeGreaterThan(0);
      expect(group.hint.length).toBeGreaterThan(0);
      expect(group.kinds.length).toBeGreaterThan(0);
    }
  });

  test("the composed newsletter shapes lead the palette", () => {
    // The reason the groups exist: a Spacer had the same visual weight as a
    // Card, so the shapes an issue is actually built from were lost in the
    // middle of fourteen identical buttons.
    expect(BLOCK_GROUPS[0].kinds).toContain("card");
    expect(BLOCK_GROUPS[0].kinds).toContain("bleed_image");
    expect(BLOCK_GROUPS[0].kinds).not.toContain("spacer");
  });
});

describe("moveBlock", () => {
  function docOf(...kinds: EmailBlockKind[]): EmailDocument {
    return {
      blocks: kinds.map((kind, i) => defaultBlockFor(kind, `b${i + 1}`)),
    };
  }

  test("moves a block up one place", () => {
    const doc = docOf("heading", "text", "divider");
    expect(moveBlock(doc, "b2", -1).blocks.map((b) => b.id)).toEqual(["b2", "b1", "b3"]);
  });

  test("moves a block down one place", () => {
    const doc = docOf("heading", "text", "divider");
    expect(moveBlock(doc, "b2", 1).blocks.map((b) => b.id)).toEqual(["b1", "b3", "b2"]);
  });

  test("is a REFERENCE no-op at either end", () => {
    // Reference equality matters, not just contents: `design.tsx` skips the
    // history push (and therefore the autosave) when the doc comes back
    // unchanged, so a tap on a disabled edge costs nothing.
    const doc = docOf("heading", "text");
    expect(moveBlock(doc, "b1", -1)).toBe(doc);
    expect(moveBlock(doc, "b2", 1)).toBe(doc);
  });

  test("is a no-op for an unknown id", () => {
    const doc = docOf("heading", "text");
    expect(moveBlock(doc, "nope", 1)).toBe(doc);
  });

  test("keeps document-level fields (the theme survives a reorder)", () => {
    const doc: EmailDocument = {
      theme: { ...DEFAULT_EMAIL_THEME, name: "Advent" },
      blocks: docOf("heading", "text").blocks,
    };
    expect(moveBlock(doc, "b1", 1).theme?.name).toBe("Advent");
  });

  test("a move up and back down round-trips to the original order", () => {
    const doc = docOf("heading", "text", "divider");
    const there = moveBlock(doc, "b3", -1);
    const back = moveBlock(there, "b3", 1);
    expect(back.blocks.map((b) => b.id)).toEqual(doc.blocks.map((b) => b.id));
  });
});

// ── The save-rejection translator ───────────────────────────────────────────
//
// Every case below is driven by a document the REAL validator rejected, never
// by a hand-typed message: the whole point of the table is that it names the
// control the designer is looking at, and the only way it can be wrong is by
// matching a message it wasn't written for.

describe("explainDocError", () => {
  /** Reject `doc` with the real write gate and hand the reason over. */
  function explainRejectionOf(doc: unknown) {
    const result = validateEmailDocument(doc);
    if (result.ok) throw new Error("expected the validator to reject this document");
    return explainDocError(result.error);
  }

  /** Field names that only exist in the CONTRACT — never on screen. */
  const CONTRACT_ONLY_WORDS = [
    "ctaLabel",
    "ctaUrl",
    "ctaStyle",
    "imageUrl",
    "imageAlt",
    "imageSide",
    "imageWidthPct",
    "logoUrl",
    "logoAlt",
    "navLine",
    "bleed_image",
    "markdown",
    "blocks[",
  ];

  const REJECTED_DOCUMENTS: { name: string; doc: unknown; expect: RegExp }[] = [
    {
      name: "a card with half a button",
      doc: { blocks: [{ id: "b1", kind: "card", heading: "Hi", ctaLabel: "Read more" }] },
      expect: /Button link/,
    },
    {
      name: "a card whose button link has a rejected scheme",
      doc: {
        blocks: [{ id: "b1", kind: "card", ctaLabel: "Call", ctaUrl: "tel:+441234567890" }],
      },
      expect: /Button link/,
    },
    {
      name: "a card image with no alt at all",
      doc: { blocks: [{ id: "b1", kind: "card", imageUrl: "https://x.test/a.png" }] },
      expect: /Alt text/,
    },
    {
      name: "an image block with an empty url",
      doc: { blocks: [{ id: "b1", kind: "image", url: "", alt: "" }] },
      expect: /Image URL/,
    },
    {
      name: "an image block with a bad scheme",
      doc: { blocks: [{ id: "b1", kind: "image", url: "ftp://x.test/a.png", alt: "" }] },
      expect: /http/,
    },
    {
      name: "a button with no label",
      doc: { blocks: [{ id: "b1", kind: "button", label: "", url: "https://x.test" }] },
      expect: /Button label/,
    },
    {
      name: "a button with no link",
      doc: { blocks: [{ id: "b1", kind: "button", label: "Go", url: "" }] },
      expect: /Link URL/,
    },
    {
      name: "a button link with a rejected scheme",
      doc: { blocks: [{ id: "b1", kind: "button", label: "Go", url: "ftp://x.test" }] },
      expect: /Link URL/,
    },
    {
      name: "a banner with a bad scheme",
      doc: { blocks: [{ id: "b1", kind: "bleed_image", url: "ftp://x.test/a.png", alt: "" }] },
      expect: /banner/i,
    },
    {
      name: "a banner with no alt",
      doc: { blocks: [{ id: "b1", kind: "bleed_image", url: "https://x.test/a.png" }] },
      expect: /Alt text/,
    },
    {
      name: "a footer link with no label",
      doc: {
        blocks: [{ id: "b1", kind: "footer", links: [{ label: "", url: "https://x.test" }] }],
      },
      expect: /footer link/i,
    },
    {
      name: "a footer link with no address",
      doc: { blocks: [{ id: "b1", kind: "footer", links: [{ label: "Insta", url: "" }] }] },
      expect: /footer link/i,
    },
    {
      name: "a footer logo blanked rather than removed",
      doc: { blocks: [{ id: "b1", kind: "footer", logoUrl: "", logoAlt: "" }] },
      expect: /Logo/,
    },
    {
      name: "a footer logo with no alt",
      doc: { blocks: [{ id: "b1", kind: "footer", logoUrl: "https://x.test/l.png" }] },
      expect: /Logo alt text/,
    },
    {
      name: "an eyebrow with no text",
      doc: { blocks: [{ id: "b1", kind: "eyebrow", text: "" }] },
      expect: /Eyebrow text/,
    },
    {
      name: "a quote with no text",
      doc: { blocks: [{ id: "b1", kind: "quote", text: "" }] },
      expect: /Quote text/,
    },
    {
      name: "a poll with no question",
      doc: {
        blocks: [
          {
            id: "b1",
            kind: "poll",
            question: "",
            options: [
              { id: "o1", label: "A" },
              { id: "o2", label: "B" },
            ],
          },
        ],
      },
      expect: /Question/,
    },
    {
      name: "a poll option with a blank label",
      doc: {
        blocks: [
          {
            id: "b1",
            kind: "poll",
            question: "Which?",
            options: [
              { id: "o1", label: "A" },
              { id: "o2", label: "" },
            ],
          },
        ],
      },
      expect: /poll option/i,
    },
    {
      name: "a columns block with one column",
      doc: { blocks: [{ id: "b1", kind: "columns", columns: [{ heading: "Only" }] }] },
      expect: /Columns/,
    },
    {
      name: "two blocks sharing an id",
      doc: {
        blocks: [
          { id: "same", kind: "divider" },
          { id: "same", kind: "divider" },
        ],
      },
      expect: /id/,
    },
  ];

  for (const { name, doc, expect: pattern } of REJECTED_DOCUMENTS) {
    test(`${name} is explained in the composer's own words`, () => {
      const explained = explainRejectionOf(doc);
      expect(explained.recognized).toBe(true);
      expect(explained.message).toMatch(pattern);
      // The raw message is ALWAYS kept — "Details" in the save indicator
      // shows it, and it's what someone greps the validator for.
      expect(explained.raw.length).toBeGreaterThan(0);
    });
  }

  test("no explanation leaks a contract-only field name", () => {
    // The bug this whole table exists for: a designer told her save failed
    // because of "ctaLabel", a word that appears nowhere on her screen.
    for (const { doc } of REJECTED_DOCUMENTS) {
      const explained = explainRejectionOf(doc);
      for (const word of CONTRACT_ONLY_WORDS) {
        expect([explained.raw, explained.message]).toEqual([
          explained.raw,
          expect.not.stringContaining(word),
        ]);
      }
    }
  });

  test("names the offending block, 1-based, the way the stack is counted", () => {
    const explained = explainRejectionOf({
      blocks: [
        defaultBlockFor("divider", "b1"),
        defaultBlockFor("divider", "b2"),
        { id: "b3", kind: "button", label: "Go", url: "" },
      ],
    });
    expect(explained.blockNumber).toBe(3);
    expect(explained.message).toMatch(/^Block 3: /);
  });

  test("an unrecognised message passes through untranslated rather than vanishing", () => {
    const explained = explainDocError("NOT_EDITABLE: this campaign is locked.");
    expect(explained.recognized).toBe(false);
    expect(explained.message).toBe("NOT_EDITABLE: this campaign is locked.");
    expect(explained.blockNumber).toBeNull();
  });

  test("a rejected THEME is explained without naming a colour token", () => {
    const explained = explainRejectionOf({
      blocks: [],
      theme: { ...DEFAULT_EMAIL_THEME, accent: "not-a-colour" },
    });
    expect(explained.recognized).toBe(true);
    expect(explained.message).toMatch(/theme/i);
  });
});
