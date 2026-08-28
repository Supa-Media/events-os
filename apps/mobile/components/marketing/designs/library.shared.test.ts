// No @types/jest / ambient globals configured for this package — import test
// globals explicitly from @jest/globals (mirrors the sibling colocated tests).
import { describe, expect, test } from "@jest/globals";
import type { BrandColor, DesignAsset, DesignFolder } from "@events-os/shared";
import {
  SHELF_ALL,
  SHELF_UNFILED,
  buildShelves,
  designMatches,
  designPreview,
  gridEmbeds,
  initialsFor,
  folderOptions,
  isUnfiled,
  parentChoicesFor,
  placeholderPaint,
  readableInkOn,
  relativeLuminance,
  resolveShelf,
  shelfLabel,
  visibleColors,
  visibleDesigns,
  visibleFonts,
} from "./library.shared";

function folder(
  id: string,
  name: string,
  parentId: string | null = null,
): DesignFolder {
  return { id, name, parentId, order: 0, designCount: 0 };
}

function design(
  id: string,
  title: string,
  folderId: string | null,
  extra: Partial<DesignAsset> = {},
): DesignAsset {
  return {
    id,
    kind: "canva",
    title,
    folderId,
    url: "https://www.canva.com/design/abc/def/view",
    embedUrl: null,
    imageUrl: null,
    thumbnailUrl: null,
    notes: null,
    order: 0,
    updatedAt: 0,
    ...extra,
  };
}

const FOLDERS = [
  folder("f_logos", "Logos"),
  folder("f_social", "Social"),
  folder("f_reels", "Reels covers", "f_social"),
];

const DESIGNS = [
  design("d1", "PW wordmark", "f_logos"),
  design("d2", "Story overlay", "f_social"),
  design("d3", "Reel cover — Eden", "f_reels"),
  design("d4", "Brand guidelines", null, { notes: "The whole system, in a PDF" }),
  // Points at a folder this payload doesn't contain — a design orphaned by a
  // folder deleted in another tab.
  design("d5", "Orphan flyer", "f_gone"),
];

describe("isUnfiled", () => {
  const known = new Set(FOLDERS.map((f) => f.id));

  test("a design with no folder is unfiled", () => {
    expect(isUnfiled(design("x", "x", null), known)).toBe(true);
  });

  test("a design pointing at a folder that no longer exists is unfiled, not lost", () => {
    expect(isUnfiled(design("x", "x", "f_gone"), known)).toBe(true);
  });

  test("a filed design is not unfiled", () => {
    expect(isUnfiled(design("x", "x", "f_logos"), known)).toBe(false);
  });
});

describe("buildShelves", () => {
  const shelves = buildShelves(FOLDERS, DESIGNS);

  test("draws All files first and Unfiled last, always", () => {
    expect(shelves[0].id).toBe(SHELF_ALL);
    expect(shelves[shelves.length - 1].id).toBe(SHELF_UNFILED);
  });

  test("keeps Unfiled on the rail even when nothing is unfiled", () => {
    const tidy = buildShelves(FOLDERS, [design("d1", "PW wordmark", "f_logos")]);
    const unfiled = tidy.find((s) => s.id === SHELF_UNFILED);
    expect(unfiled?.count).toBe(0);
  });

  test("nests a sub-folder under its parent, one level deep", () => {
    const ids = shelves.map((s) => s.id);
    expect(ids).toEqual([
      SHELF_ALL,
      "f_logos",
      "f_social",
      "f_reels",
      SHELF_UNFILED,
    ]);
    expect(shelves.find((s) => s.id === "f_reels")?.depth).toBe(1);
    expect(shelves.find((s) => s.id === "f_social")?.depth).toBe(0);
  });

  test("a parent's count includes its children's files", () => {
    expect(shelves.find((s) => s.id === "f_social")?.count).toBe(2);
    expect(shelves.find((s) => s.id === "f_reels")?.count).toBe(1);
  });

  test("All files counts everything and Unfiled counts the orphans", () => {
    expect(shelves.find((s) => s.id === SHELF_ALL)?.count).toBe(5);
    expect(shelves.find((s) => s.id === SHELF_UNFILED)?.count).toBe(2);
  });

  test("an empty folder still gets a shelf, so it can ask for a first file", () => {
    const withEmpty = buildShelves([...FOLDERS, folder("f_sign", "Signage")], DESIGNS);
    expect(withEmpty.find((s) => s.id === "f_sign")?.count).toBe(0);
  });
});

describe("shelfLabel / resolveShelf", () => {
  const shelves = buildShelves(FOLDERS, DESIGNS);

  test("names a shelf", () => {
    expect(shelfLabel("f_reels", shelves)).toBe("Reels covers");
    expect(shelfLabel(SHELF_UNFILED, shelves)).toBe("Unfiled");
  });

  test("a shelf deleted underneath you falls back to All files", () => {
    expect(resolveShelf("f_gone", shelves)).toBe(SHELF_ALL);
    expect(resolveShelf("f_logos", shelves)).toBe("f_logos");
  });
});

describe("visibleDesigns", () => {
  test("All files shows everything", () => {
    expect(visibleDesigns(DESIGNS, FOLDERS, SHELF_ALL, "")).toHaveLength(5);
  });

  test("a folder shows its own files", () => {
    expect(
      visibleDesigns(DESIGNS, FOLDERS, "f_logos", "").map((d) => d.id),
    ).toEqual(["d1"]);
  });

  test("a parent folder shows its children's files too", () => {
    expect(
      visibleDesigns(DESIGNS, FOLDERS, "f_social", "").map((d) => d.id),
    ).toEqual(["d2", "d3"]);
  });

  test("Unfiled collects loose designs and orphans", () => {
    expect(
      visibleDesigns(DESIGNS, FOLDERS, SHELF_UNFILED, "").map((d) => d.id),
    ).toEqual(["d4", "d5"]);
  });

  test("a search looks across the whole library, not just the open shelf", () => {
    expect(
      visibleDesigns(DESIGNS, FOLDERS, "f_logos", "reel").map((d) => d.id),
    ).toEqual(["d3"]);
  });

  test("an empty query is not a filter", () => {
    expect(visibleDesigns(DESIGNS, FOLDERS, SHELF_ALL, "   ")).toHaveLength(5);
  });
});

describe("designMatches", () => {
  test("matches the title, case-insensitively", () => {
    expect(designMatches(DESIGNS[0], "WORDMARK")).toBe(true);
  });

  test("matches the note", () => {
    expect(designMatches(DESIGNS[3], "pdf")).toBe(true);
  });

  test("matches the link and the tool", () => {
    expect(designMatches(DESIGNS[0], "canva")).toBe(true);
  });

  test("misses what it should miss", () => {
    expect(designMatches(DESIGNS[0], "invoice")).toBe(false);
  });
});

describe("visibleColors / visibleFonts", () => {
  const palette: BrandColor[] = [
    { id: "c1", name: "PW Red", hex: "#891d1a", usage: "Headlines", order: 0 },
    { id: "c2", name: "Cream", hex: "#fff9ee", usage: null, order: 1 },
  ];

  test("a pasted hex finds its swatch", () => {
    expect(visibleColors(palette, "#891d1a").map((c) => c.id)).toEqual(["c1"]);
  });

  test("the usage note is searchable", () => {
    expect(visibleColors(palette, "headline").map((c) => c.id)).toEqual(["c1"]);
  });

  test("no query means no filter", () => {
    expect(visibleColors(palette, "")).toHaveLength(2);
  });

  test("faces match on name and note", () => {
    const fonts = [
      { name: "Inter", notes: "The newsletter's face" },
      { name: "Barbra Condensed", notes: null },
    ];
    expect(visibleFonts(fonts, "newsletter")).toHaveLength(1);
    expect(visibleFonts(fonts, "condensed")).toHaveLength(1);
    expect(visibleFonts(fonts, "")).toHaveLength(2);
  });
});

describe("folderOptions", () => {
  test("offers Unfiled first, then the shelves in order", () => {
    expect(folderOptions(FOLDERS)).toEqual([
      { value: "", label: "Unfiled" },
      { value: "f_logos", label: "Logos" },
      { value: "f_social", label: "Social" },
      { value: "f_reels", label: "Social / Reels covers" },
    ]);
  });

  test("keeps the one level of hierarchy in the label", () => {
    const child = folderOptions(FOLDERS).find((o) => o.value === "f_reels");
    expect(child?.label).toBe("Social / Reels covers");
  });
});

describe("parentChoicesFor", () => {
  test("offers the other top-level folders", () => {
    expect(parentChoicesFor(FOLDERS, "f_logos").map((f) => f.id)).toEqual([
      "f_social",
    ]);
  });

  test("never offers a folder itself as its own parent", () => {
    expect(parentChoicesFor(FOLDERS, "f_social").map((f) => f.id)).not.toContain(
      "f_social",
    );
  });

  test("a folder with children may not be nested — that would be a third level", () => {
    expect(parentChoicesFor(FOLDERS, "f_social")).toEqual([]);
  });

  test("a new folder may sit under any top-level one", () => {
    expect(parentChoicesFor(FOLDERS, null).map((f) => f.id)).toEqual([
      "f_logos",
      "f_social",
    ]);
  });
});

describe("initialsFor", () => {
  test("takes the first letters of the first two words", () => {
    expect(initialsFor("Light The Night")).toBe("LT");
  });

  test("skips numbers and punctuation rather than showing them", () => {
    expect(initialsFor("2026 — flyer")).toBe("F");
    expect(initialsFor("PW wordmark — cream on red")).toBe("PW");
  });

  test("splits on the separators a filename actually uses", () => {
    expect(initialsFor("eden/banner")).toBe("EB");
    expect(initialsFor("Merch table (A-frame)")).toBe("MT");
  });

  test("never comes back empty", () => {
    expect(initialsFor("   ")).toBe("?");
    expect(initialsFor("123")).toBe("?");
    expect(initialsFor("—")).toBe("?");
  });
});

describe("readableInkOn", () => {
  test("cream on a dark ground, ink on a light one", () => {
    expect(readableInkOn("#210706")).toBe("#FDF6F6");
    expect(readableInkOn("#891d1a")).toBe("#FDF6F6");
    expect(readableInkOn("#fff9ee")).toBe("#210909");
  });

  test("understands three-digit hexes", () => {
    expect(readableInkOn("#000")).toBe("#FDF6F6");
    expect(readableInkOn("#fff")).toBe("#210909");
  });

  test("an unparseable color still gets an answer", () => {
    expect(relativeLuminance("not a color")).toBe(0.5);
    expect(readableInkOn("not a color")).toBe("#210909");
  });
});

describe("designPreview", () => {
  const palette: BrandColor[] = [
    { id: "c1", name: "PW Red", hex: "#891d1a", usage: null, order: 0 },
    { id: "c2", name: "Cream", hex: "#fff9ee", usage: null, order: 1 },
  ];

  test("prefers the hosted thumbnail — the picture chosen for this box", () => {
    const preview = designPreview(
      design("d", "Flyer", null, {
        thumbnailUrl: "https://files/thumb.png",
        imageUrl: "https://files/art.png",
      }),
      palette,
    );
    expect(preview).toEqual({ kind: "image", uri: "https://files/thumb.png" });
  });

  test("falls back to the artwork when no thumbnail was uploaded", () => {
    const preview = designPreview(
      design("d", "Flyer", null, { imageUrl: "https://files/art.png" }),
      palette,
    );
    expect(preview).toEqual({ kind: "image", uri: "https://files/art.png" });
  });

  test("with neither, it draws initials in the brand's own palette", () => {
    const preview = designPreview(design("d1", "Eden banner", null), palette);
    expect(preview.kind).toBe("placeholder");
    if (preview.kind !== "placeholder") throw new Error("unreachable");
    expect(preview.initials).toBe("EB");
    expect(palette.map((c) => c.hex)).toContain(preview.background);
    expect([readableInkOn(preview.background)]).toContain(preview.foreground);
  });

  test("the placeholder's color is stable for a given design", () => {
    expect(placeholderPaint("d1", palette)).toBe(placeholderPaint("d1", palette));
  });

  test("an empty kit still paints something rather than a grey box", () => {
    expect(placeholderPaint("d1", [])).toBe("#D23B3A");
  });
});

describe("gridEmbeds", () => {
  const embed = "https://www.canva.com/design/abc/def/view?embed";

  test("every embeddable design gets a live frame — the founder's call", () => {
    const shelf = [
      design("d1", "Flyer", null, { embedUrl: embed }),
      design("d2", "Drive folder", null, { kind: "link" }),
      design("d3", "Banner", null, { embedUrl: embed }),
    ];
    expect(gridEmbeds(shelf)).toEqual(new Set(["d1", "d3"]));
  });

  test("a design with no embed never gets a frame, whatever the budget", () => {
    expect(gridEmbeds([design("d1", "Drive folder", null)])).toEqual(new Set());
  });

  test("past the cap, tiles fall back to stills — in draw order", () => {
    const shelf = [
      design("d1", "A", null, { embedUrl: embed }),
      design("d2", "B", null),
      design("d3", "C", null, { embedUrl: embed }),
      design("d4", "D", null, { embedUrl: embed }),
    ];
    expect(gridEmbeds(shelf, 2)).toEqual(new Set(["d1", "d3"]));
  });
});
