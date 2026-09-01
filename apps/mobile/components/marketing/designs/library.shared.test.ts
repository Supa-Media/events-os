// No @types/jest / ambient globals configured for this package — import test
// globals explicitly from @jest/globals (mirrors the sibling colocated tests).
import { describe, expect, test } from "@jest/globals";
import type {
  BrandColor,
  BrandFont,
  DesignAsset,
  DesignFolder,
} from "@events-os/shared";
import {
  SHELF_ALL,
  SHELF_UNFILED,
  buildShelves,
  countLabel,
  designMatches,
  folderContents,
  designPreview,
  gridEmbeds,
  initialsFor,
  isInFolder,
  itemCount,
  folderOptions,
  isUnfiled,
  parentChoicesFor,
  pinnedFolders,
  placeholderPaint,
  readableInkOn,
  relativeLuminance,
  resolveShelf,
  shelfContents,
  shelfLabel,
  unpinnedItems,
  visibleColors,
  visibleDesigns,
  visibleFonts,
} from "./library.shared";

function folder(
  id: string,
  name: string,
  parentId: string | null = null,
  pinned = false,
): DesignFolder {
  return { id, name, parentId, pinned, order: 0, itemCount: 0 };
}

/** `folderIds` takes a single id, a list, or null for unfiled — the tests read
 *  better for it and every one of the three is a real state. */
function design(
  id: string,
  title: string,
  folderIds: string | string[] | null,
  extra: Partial<DesignAsset> = {},
): DesignAsset {
  return {
    id,
    kind: "canva",
    title,
    folderIds: folderIds === null ? [] : ([] as string[]).concat(folderIds),
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

function color(
  id: string,
  name: string,
  hex: string,
  folderIds: string | string[] | null = null,
): BrandColor {
  return {
    id,
    name,
    hex,
    usage: null,
    folderIds: folderIds === null ? [] : ([] as string[]).concat(folderIds),
    order: 0,
  };
}

function font(
  id: string,
  name: string,
  folderIds: string | string[] | null = null,
): BrandFont {
  return {
    id,
    name,
    role: "headline",
    sourceUrl: null,
    notes: null,
    folderIds: folderIds === null ? [] : ([] as string[]).concat(folderIds),
    order: 0,
  };
}

/** The library as the screen holds it: three kinds of thing, one payload. */
function items(
  designs: DesignAsset[] = [],
  colors: BrandColor[] = [],
  fonts: BrandFont[] = [],
) {
  return { colors, fonts, designs };
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

const LIBRARY = items(DESIGNS);

/** The folder model's own fixture: a pinned palette folder and an event folder
 *  that BORROWS one of its colors — the arrangement the whole change exists
 *  for. */
const KIT_FOLDERS = [
  folder("f_colors", "Colors", null, true),
  folder("f_easter", "Easter 2026"),
];
const KIT = items(
  [design("d_poster", "Easter poster", "f_easter")],
  [color("c_red", "PW Red", "#891d1a", ["f_colors", "f_easter"])],
  [font("t_times", "Times New Roman Condensed", "f_easter")],
);

describe("isUnfiled", () => {
  const known = new Set(FOLDERS.map((f) => f.id));

  test("a design in no folder is unfiled", () => {
    expect(isUnfiled(design("x", "x", null), known)).toBe(true);
  });

  test("a design pointing only at a folder that no longer exists is unfiled, not lost", () => {
    expect(isUnfiled(design("x", "x", "f_gone"), known)).toBe(true);
  });

  test("a filed design is not unfiled", () => {
    expect(isUnfiled(design("x", "x", "f_logos"), known)).toBe(false);
  });

  test("one live folder is enough — an item is only unfiled when every folder it names is gone", () => {
    expect(isUnfiled(design("x", "x", ["f_gone", "f_logos"]), known)).toBe(false);
  });

  test("colors and faces are filed by exactly the same rule", () => {
    expect(isUnfiled(color("c", "PW Red", "#891d1a"), known)).toBe(true);
    expect(isUnfiled(color("c", "PW Red", "#891d1a", "f_logos"), known)).toBe(
      false,
    );
    expect(isUnfiled(font("t", "Inter", "f_logos"), known)).toBe(false);
  });
});

describe("isInFolder", () => {
  test("membership is many-to-many — the same red is in two folders at once", () => {
    const red = color("c_red", "PW Red", "#891d1a", ["f_colors", "f_easter"]);
    expect(isInFolder(red, "f_colors")).toBe(true);
    expect(isInFolder(red, "f_easter")).toBe(true);
    expect(isInFolder(red, "f_logos")).toBe(false);
  });
});

describe("pinnedFolders", () => {
  test("only the pinned ones, in rail order", () => {
    expect(pinnedFolders(KIT_FOLDERS).map((f) => f.id)).toEqual(["f_colors"]);
  });

  test("nothing pinned is not an error, just no sections", () => {
    expect(pinnedFolders(FOLDERS)).toEqual([]);
  });
});

describe("buildShelves", () => {
  const shelves = buildShelves(FOLDERS, LIBRARY);

  test("draws Everything first and Unfiled last, always", () => {
    expect(shelves[0].id).toBe(SHELF_ALL);
    expect(shelves[shelves.length - 1].id).toBe(SHELF_UNFILED);
  });

  test("keeps Unfiled on the rail even when nothing is unfiled", () => {
    const tidy = buildShelves(FOLDERS, items([design("d1", "PW wordmark", "f_logos")]));
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

  test("Everything counts everything and Unfiled counts the orphans", () => {
    expect(shelves.find((s) => s.id === SHELF_ALL)?.count).toBe(5);
    expect(shelves.find((s) => s.id === SHELF_UNFILED)?.count).toBe(2);
  });

  test("an empty folder still gets a shelf, so it can ask for a first file", () => {
    const withEmpty = buildShelves(
      [...FOLDERS, folder("f_sign", "Signage")],
      LIBRARY,
    );
    expect(withEmpty.find((s) => s.id === "f_sign")?.count).toBe(0);
  });

  test("a folder counts every KIND of thing in it, not just its files", () => {
    const shelves = buildShelves(KIT_FOLDERS, KIT);
    // A poster, the red, and the face it's set in.
    expect(shelves.find((s) => s.id === "f_easter")?.count).toBe(3);
    expect(shelves.find((s) => s.id === "f_colors")?.count).toBe(1);
    expect(shelves.find((s) => s.id === SHELF_ALL)?.count).toBe(3);
  });

  test("a color in two folders is counted by both — and unfiled by neither", () => {
    const shelves = buildShelves(KIT_FOLDERS, KIT);
    expect(shelves.find((s) => s.id === SHELF_UNFILED)?.count).toBe(0);
  });

  test("an item in both a parent and its child is counted once", () => {
    const shelves = buildShelves(
      FOLDERS,
      items([design("d", "Cover", ["f_social", "f_reels"])]),
    );
    expect(shelves.find((s) => s.id === "f_social")?.count).toBe(1);
  });

  test("carries the pin through, so the rail can mark it", () => {
    const shelves = buildShelves(KIT_FOLDERS, KIT);
    expect(shelves.find((s) => s.id === "f_colors")?.pinned).toBe(true);
    expect(shelves.find((s) => s.id === "f_easter")?.pinned).toBe(false);
  });
});

describe("shelfLabel / resolveShelf", () => {
  const shelves = buildShelves(FOLDERS, LIBRARY);

  test("names a shelf", () => {
    expect(shelfLabel("f_reels", shelves)).toBe("Reels covers");
    expect(shelfLabel(SHELF_UNFILED, shelves)).toBe("Unfiled");
  });

  test("a shelf deleted underneath you falls back to Everything", () => {
    expect(resolveShelf("f_gone", shelves)).toBe(SHELF_ALL);
    expect(resolveShelf("f_logos", shelves)).toBe("f_logos");
  });
});

describe("shelfContents", () => {
  const on = (shelf: string, query = "") =>
    shelfContents(LIBRARY, FOLDERS, shelf, query).designs.map((d) => d.id);

  test("Everything shows everything", () => {
    expect(on(SHELF_ALL)).toHaveLength(5);
  });

  test("a folder shows its own files", () => {
    expect(on("f_logos")).toEqual(["d1"]);
  });

  test("a parent folder shows its children's files too", () => {
    expect(on("f_social")).toEqual(["d2", "d3"]);
  });

  test("Unfiled collects loose designs and orphans", () => {
    expect(on(SHELF_UNFILED)).toEqual(["d4", "d5"]);
  });

  test("a search looks across the whole library, not just the open shelf", () => {
    expect(on("f_logos", "reel")).toEqual(["d3"]);
  });

  test("an empty query is not a filter", () => {
    expect(on(SHELF_ALL, "   ")).toHaveLength(5);
  });

  test("a shelf returns every kind of thing in it, not just designs", () => {
    const easter = shelfContents(KIT, KIT_FOLDERS, "f_easter", "");
    expect(easter.designs.map((d) => d.id)).toEqual(["d_poster"]);
    expect(easter.colors.map((c) => c.id)).toEqual(["c_red"]);
    expect(easter.fonts.map((f) => f.id)).toEqual(["t_times"]);
    expect(itemCount(easter)).toBe(3);
  });

  test("borrowing a color does not take it out of the folder it came from", () => {
    const kit = shelfContents(KIT, KIT_FOLDERS, "f_colors", "");
    expect(kit.colors.map((c) => c.id)).toEqual(["c_red"]);
    expect(kit.designs).toEqual([]);
  });

  test("the search reaches colors and faces too, wherever they are filed", () => {
    const hit = shelfContents(KIT, KIT_FOLDERS, "f_colors", "times");
    expect(hit.fonts.map((f) => f.id)).toEqual(["t_times"]);
  });
});

describe("folderContents", () => {
  test("a pinned section shows its OWN things, not the whole library", () => {
    // The library's search escapes the shelf on purpose; a section must not,
    // or every pinned heading answers the same query with the same cards.
    const easter = folderContents(KIT, KIT_FOLDERS, "f_easter", "poster");
    expect(easter.designs.map((d) => d.id)).toEqual(["d_poster"]);

    const kit = folderContents(KIT, KIT_FOLDERS, "f_colors", "poster");
    expect(kit.designs).toEqual([]);
    expect(itemCount(kit)).toBe(0);
  });

  test("no query is no filter — just the folder", () => {
    const easter = folderContents(KIT, KIT_FOLDERS, "f_easter", "");
    expect(itemCount(easter)).toBe(3);
  });

  test("a parent section includes its children's things", () => {
    expect(
      folderContents(LIBRARY, FOLDERS, "f_social", "").designs.map((d) => d.id),
    ).toEqual(["d2", "d3"]);
  });
});

describe("unpinnedItems", () => {
  test("drops what a pinned folder is already showing, so nothing is drawn twice", () => {
    const rest = unpinnedItems(KIT, KIT_FOLDERS);
    // The red is in the pinned Colors folder, so the library's own wall skips
    // it — the pinned section below is where it is drawn.
    expect(rest.colors).toEqual([]);
    // The poster and the face are only in the unpinned event folder.
    expect(rest.designs.map((d) => d.id)).toEqual(["d_poster"]);
    expect(rest.fonts.map((f) => f.id)).toEqual(["t_times"]);
  });

  test("nothing pinned means nothing is hidden", () => {
    expect(unpinnedItems(LIBRARY, FOLDERS)).toBe(LIBRARY);
  });

  test("an item in a pinned AND an unpinned folder is left to the pinned section", () => {
    const folders = [
      folder("f_pin", "Colors", null, true),
      folder("f_open", "Easter 2026"),
    ];
    const items = {
      colors: [color("c", "PW Red", "#891d1a", ["f_pin", "f_open"])],
      fonts: [],
      designs: [],
    };
    expect(unpinnedItems(items, folders).colors).toEqual([]);
  });
});

describe("countLabel", () => {
  test("a plain total when nothing is narrowing it", () => {
    expect(countLabel(4, 4)).toBe("4");
  });

  test("says so when something is", () => {
    expect(countLabel(2, 4)).toBe("2 of 4");
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

describe("visibleColors / visibleFonts / visibleDesigns", () => {
  const palette: BrandColor[] = [
    { ...color("c1", "PW Red", "#891d1a"), usage: "Headlines" },
    color("c2", "Cream", "#fff9ee"),
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

  test("designs match on title, note, link and tool", () => {
    expect(visibleDesigns(DESIGNS, "wordmark").map((d) => d.id)).toEqual(["d1"]);
    expect(visibleDesigns(DESIGNS, "")).toHaveLength(5);
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
    color("c1", "PW Red", "#891d1a"),
    color("c2", "Cream", "#fff9ee"),
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

  test("a video never falls back to its own file — an mp4 is not a still", () => {
    // `imageUrl` on a video is the clip. Handing it to an <Image> draws the
    // silent blank box the placeholder exists to prevent, so a clip with no
    // poster uploaded gets initials and the tile's play badge instead.
    const preview = designPreview(
      design("d", "Field Day reel", null, {
        kind: "video",
        imageUrl: "https://files/reel.mp4",
      }),
      palette,
    );
    expect(preview.kind).toBe("placeholder");

    // Its uploaded poster, when there is one, is exactly what it draws.
    expect(
      designPreview(
        design("d", "Field Day reel", null, {
          kind: "video",
          imageUrl: "https://files/reel.mp4",
          thumbnailUrl: "https://files/poster.png",
        }),
        palette,
      ),
    ).toEqual({ kind: "image", uri: "https://files/poster.png" });
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
