/**
 * MARKETING · Designs — the workstation's pure logic.
 *
 * Everything the Designs tab decides BEFORE it draws anything: which shelf is
 * showing, what is on it, what a tile puts in its picture box, and what color
 * that picture is when there is no picture. No React and no react-native, on
 * purpose — the file is imported by `library.shared.test.ts`, which runs in a
 * bare node environment (see `jest.config.js`), so these answers are pinned by
 * tests rather than by looking at a screenshot.
 *
 * The same split `pdfPages.shared.ts` uses, for the same reason.
 */
import type { BrandColor, DesignAsset, DesignFolder } from "@events-os/shared";
import { colors as theme } from "../../../lib/theme";

// ── Shelves ──────────────────────────────────────────────────────────────────

/**
 * The rail is a list of SHELVES, not a list of folders: two of them are views
 * rather than rows in `designFolders`, and the ids are prefixed so a virtual
 * shelf can never collide with a Convex document id.
 */
export const SHELF_ALL = "shelf:all";
export const SHELF_UNFILED = "shelf:unfiled";

/** A shelf id is `SHELF_ALL`, `SHELF_UNFILED`, or a folder's id. */
export type ShelfId = string;

/** One row in the folder rail. */
export type Shelf = {
  id: ShelfId;
  name: string;
  /** 1 = a sub-folder, drawn indented under its parent. */
  depth: 0 | 1;
  /** How many designs the shelf shows — including, for "All files", every one. */
  count: number;
  /** The real folder behind it, or null for the two views. */
  folderId: string | null;
};

/** Whether a shelf is a real folder (renameable, deletable) or one of the two
 *  views the rail always shows. */
export function isVirtualShelf(shelfId: ShelfId): boolean {
  return shelfId === SHELF_ALL || shelfId === SHELF_UNFILED;
}

/**
 * A design is UNFILED when it has no folder — and also when it points at a
 * folder this payload doesn't contain, so a design orphaned by a folder deleted
 * in another tab shows up somewhere rather than nowhere. A row that renders
 * nowhere is a row people re-create.
 */
export function isUnfiled(
  design: Pick<DesignAsset, "folderId">,
  knownFolderIds: Set<string>,
): boolean {
  return design.folderId === null || !knownFolderIds.has(design.folderId);
}

/**
 * The rail, in the order it is drawn: All files, every top-level folder with
 * its children beneath it, then Unfiled.
 *
 * Unfiled is ALWAYS present, even at zero, because it is where a design lands
 * when its folder is deleted — a shelf that appears only once something is on
 * it is a shelf nobody knows exists. Empty named folders are present too: the
 * mockup's argument is that an empty shelf should ask for its first file rather
 * than report a zero, and it cannot ask if it isn't drawn.
 */
export function buildShelves(
  folders: DesignFolder[],
  designs: DesignAsset[],
): Shelf[] {
  const known = new Set(folders.map((f) => f.id));
  const directCount = new Map<string, number>();
  let unfiled = 0;
  for (const design of designs) {
    if (isUnfiled(design, known)) {
      unfiled += 1;
      continue;
    }
    const key = design.folderId as string;
    directCount.set(key, (directCount.get(key) ?? 0) + 1);
  }

  const childrenOf = (id: string) => folders.filter((f) => f.parentId === id);
  // A parent's count includes what is on its children's shelves: tapping
  // "Instagram posts" shows everything under it, so the number beside it has to
  // be the number you will then see.
  const shelfCount = (folder: DesignFolder): number =>
    (directCount.get(folder.id) ?? 0) +
    childrenOf(folder.id).reduce((n, c) => n + (directCount.get(c.id) ?? 0), 0);

  const rows: Shelf[] = [
    {
      id: SHELF_ALL,
      name: "All files",
      depth: 0,
      count: designs.length,
      folderId: null,
    },
  ];
  for (const top of folders.filter((f) => f.parentId === null)) {
    rows.push({
      id: top.id,
      name: top.name,
      depth: 0,
      count: shelfCount(top),
      folderId: top.id,
    });
    for (const child of childrenOf(top.id)) {
      rows.push({
        id: child.id,
        name: child.name,
        depth: 1,
        count: directCount.get(child.id) ?? 0,
        folderId: child.id,
      });
    }
  }
  rows.push({
    id: SHELF_UNFILED,
    name: "Unfiled",
    depth: 0,
    count: unfiled,
    folderId: null,
  });
  return rows;
}

/** The shelf's own name, for the breadcrumb and the panel's subtitle. */
export function shelfLabel(shelfId: ShelfId, shelves: Shelf[]): string {
  return shelves.find((s) => s.id === shelfId)?.name ?? "All files";
}

/**
 * A shelf that no longer exists falls back to All files rather than showing an
 * empty grid — what happens when the folder you were standing in is deleted
 * from another tab.
 */
export function resolveShelf(shelfId: ShelfId, shelves: Shelf[]): ShelfId {
  return shelves.some((s) => s.id === shelfId) ? shelfId : SHELF_ALL;
}

// ── Filtering ────────────────────────────────────────────────────────────────

/** Case- and whitespace-insensitive, so "  LOGO " finds "PW logo". */
export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

function contains(haystack: string | null | undefined, needle: string): boolean {
  return Boolean(haystack && haystack.toLowerCase().includes(needle));
}

/** What the search box matches on a design: its title, its note, its link. */
export function designMatches(design: DesignAsset, query: string): boolean {
  const q = normalizeQuery(query);
  if (!q) return true;
  return (
    contains(design.title, q) ||
    contains(design.notes, q) ||
    contains(design.url, q) ||
    contains(design.kind, q)
  );
}

/**
 * What the grid shows: the chosen shelf, narrowed by the search box.
 *
 * SEARCH LOOKS EVERYWHERE. A query while standing in "Flyers" searches the
 * whole library, not that folder — someone typing a filename is asking "where
 * is this", and answering "not on the shelf you happen to be standing on" is
 * the behaviour that makes people re-upload a file they already have.
 */
export function visibleDesigns(
  designs: DesignAsset[],
  folders: DesignFolder[],
  shelfId: ShelfId,
  query: string,
): DesignAsset[] {
  const q = normalizeQuery(query);
  if (q) return designs.filter((design) => designMatches(design, q));
  if (shelfId === SHELF_ALL) return designs;

  const known = new Set(folders.map((f) => f.id));
  if (shelfId === SHELF_UNFILED) {
    return designs.filter((design) => isUnfiled(design, known));
  }

  // A parent shelf shows what is on it AND what is on its children — the
  // counts in the rail say so, and a folder that hides its own sub-folder's
  // files is a folder people stop trusting.
  const shown = new Set([
    shelfId,
    ...folders.filter((f) => f.parentId === shelfId).map((f) => f.id),
  ]);
  return designs.filter(
    (design) => design.folderId !== null && shown.has(design.folderId),
  );
}

/** Colors matching the search box — by name or by hex, so pasting `#891d1a`
 *  finds the swatch it belongs to. */
export function visibleColors(
  palette: BrandColor[],
  query: string,
): BrandColor[] {
  const q = normalizeQuery(query);
  if (!q) return palette;
  return palette.filter(
    (c) => contains(c.name, q) || contains(c.hex, q) || contains(c.usage, q),
  );
}

/** Faces matching the search box. */
export function visibleFonts<T extends { name: string; notes: string | null }>(
  fonts: T[],
  query: string,
): T[] {
  const q = normalizeQuery(query);
  if (!q) return fonts;
  return fonts.filter((f) => contains(f.name, q) || contains(f.notes, q));
}

// ── Pickers ──────────────────────────────────────────────────────────────────

/**
 * Folder choices for a picker, flattened to `Parent / Child` labels.
 *
 * A `Select` is a flat list, so the hierarchy has to survive in the label. It
 * only has to survive one level, which is the whole argument for the one-level
 * rule (`marketingDesigns.ts`: a tree is a filing system nobody else can
 * navigate; a shelf is one anybody can).
 *
 * "" is Unfiled — `Select` deals in strings, and null isn't one.
 */
export function folderOptions(
  folders: DesignFolder[],
): { value: string; label: string }[] {
  const options = [{ value: "", label: "Unfiled" }];
  for (const top of folders.filter((f) => f.parentId === null)) {
    options.push({ value: top.id, label: top.name });
    for (const child of folders.filter((f) => f.parentId === top.id)) {
      options.push({ value: child.id, label: `${top.name} / ${child.name}` });
    }
  }
  return options;
}

/**
 * Where a folder may be moved to: top-level folders, minus itself, and only
 * when it has no children of its own.
 *
 * The one-level rule enforced in the PICKER rather than left to the backend's
 * error — an option you can pick and then be told off for is a worse
 * explanation than an option that isn't there.
 */
export function parentChoicesFor(
  folders: DesignFolder[],
  folderId: string | null,
): DesignFolder[] {
  if (folderId && folders.some((f) => f.parentId === folderId)) return [];
  return folders.filter((f) => f.parentId === null && f.id !== folderId);
}

// ── The picture on a tile ────────────────────────────────────────────────────

/**
 * How many grid tiles may carry a LIVE embed at once.
 *
 * The founder's call, reversing the first cut's thumbnails-only rule: "I don't
 * care how slow it's gonna make the page — we just render the iframe for all
 * of them." So on web the grid embeds every Canva/Figma tile it shows, and
 * this cap is the "maybe we put a limit" half of the same instruction: past
 * it, tiles fall back to the still/placeholder ladder rather than mounting
 * hundreds of authenticated frames in one DOM (the library holds up to
 * `DESIGN_MAX_COUNT` = 500). Forty is far above any real shelf today.
 */
export const GRID_EMBED_MAX = 40;

/**
 * Which of the shown designs get a live frame on their tile: the first
 * `limit` that have an embeddable URL, in the order the grid draws them.
 * Order-based rather than per-tile so the cap is a property of the SHELF —
 * the same design can be live on a short shelf and a still on "All files".
 */
export function gridEmbeds(
  designs: Pick<DesignAsset, "id" | "embedUrl">[],
  limit: number = GRID_EMBED_MAX,
): Set<string> {
  const live = new Set<string>();
  for (const design of designs) {
    if (live.size >= limit) break;
    if (design.embedUrl) live.add(design.id);
  }
  return live;
}

/**
 * What a tile draws in its picture box — and, on web, what sits UNDER the live
 * frame while it loads (see `GRID_EMBED_MAX` above for the embed rule).
 */
export type DesignPreview =
  | { kind: "image"; uri: string }
  | {
      kind: "placeholder";
      /** One or two letters off the title. */
      initials: string;
      background: string;
      foreground: string;
    };

/**
 * Thumbnail first, artwork second, a typographic placeholder last.
 *
 * `thumbnailUrl` leads because it is the picture chosen FOR this box (see
 * `marketingDesigns.ts`: it is always an upload we host, never an expiring
 * Canva CDN link). An `image` design whose thumbnail was never filled in still
 * has its own artwork hosted, and that is a better tile than initials.
 *
 * Note this is the opposite order to `DesignEmbed`'s still, which prefers the
 * full artwork because it is filling a viewer rather than a 4:5 tile.
 */
export function designPreview(
  design: Pick<DesignAsset, "id" | "title" | "thumbnailUrl" | "imageUrl">,
  palette: BrandColor[],
): DesignPreview {
  const uri = design.thumbnailUrl ?? design.imageUrl;
  if (uri) return { kind: "image", uri };
  const background = placeholderPaint(design.id, palette);
  return {
    kind: "placeholder",
    initials: initialsFor(design.title),
    background,
    foreground: readableInkOn(background),
  };
}

/**
 * Up to two letters, taken from the first two words that start with one.
 *
 * Digits and punctuation are skipped rather than shown: "2026 — flyer" reading
 * "2F" tells you less than "F", and a tile full of numerals looks like an
 * error state.
 */
export function initialsFor(title: string): string {
  const letters = title
    .split(/[\s\-–—_/\\:,.·|()[\]]+/)
    .filter(Boolean)
    .map((word) => word[0])
    // "Is this a letter?" without a `\p{L}` escape, which needs the `u` flag
    // and a JS engine that implements property escapes: a letter is the one
    // kind of character whose two cases differ. True for Latin, Greek and
    // Cyrillic; false for digits, punctuation and CJK, which is the answer we
    // want in every one of those cases.
    .filter((ch) => ch.toLowerCase() !== ch.toUpperCase());
  if (letters.length === 0) return "?";
  return letters.slice(0, 2).join("").toUpperCase();
}

/**
 * The placeholder's ground, chosen from the ORG'S OWN palette rather than from
 * a grey — a library of files nobody has thumbnailed should still look like the
 * brand, and the swatch wall two sections up is where these colors came from.
 *
 * Deterministic in the design's id, so a tile does not change color on every
 * render (or, worse, every time the list reorders).
 */
export function placeholderPaint(
  designId: string,
  palette: BrandColor[],
): string {
  if (palette.length === 0) return theme.accent;
  return palette[hashCode(designId) % palette.length].hex;
}

/** A small, stable, non-cryptographic string hash (djb2). */
export function hashCode(value: string): number {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) >>> 0;
  }
  return hash;
}

/**
 * Where ink stops winning and cream starts, for THIS pair of inks.
 *
 * Solving `contrast(cream, L) = contrast(ink, L)` with the WCAG ratio
 * `(Lhi + .05) / (Llo + .05)` for cream (L≈0.93) and ink (L≈0.017) puts the
 * crossover at ≈0.206 — not the 0.5 a midpoint guess would use, because the two
 * inks are not symmetric about mid-grey. Below it, cream is the more legible of
 * the two; above it, ink is.
 */
const INK_CROSSOVER = 0.206;

/**
 * Ink or cream on a given ground, whichever a person can actually read.
 *
 * The kit's colors are the team's own, so a placeholder can land on anything
 * from the near-black "Ink" to "Cream" itself — one rule that looks at the
 * color beats a hardcoded white that disappears half the time. sRGB relative
 * luminance, the WCAG definition.
 */
export function readableInkOn(hex: string): string {
  return relativeLuminance(hex) > INK_CROSSOVER ? theme.ink : theme.surface;
}

/** `#rgb` / `#rrggbb` → 0..1 channels. Anything unparseable reads as mid-grey,
 *  which keeps `readableInkOn` answering instead of throwing at draw time. */
export function relativeLuminance(hex: string): number {
  const value = hex.trim().replace(/^#/, "");
  const full =
    value.length === 3
      ? value
          .split("")
          .map((c) => c + c)
          .join("")
      : value;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return 0.5;
  const channel = (start: number) => {
    const srgb = parseInt(full.slice(start, start + 2), 16) / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}
