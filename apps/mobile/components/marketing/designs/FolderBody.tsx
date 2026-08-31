/**
 * MARKETING · Designs — what is inside a folder, drawn.
 *
 * ONE renderer, used twice: for the folder you have selected in the library,
 * and for every pinned folder's own section. That is not a saving of code so
 * much as the point of the model — "Colors" is a folder that happens to be
 * pinned, so it has to draw exactly the way "Easter 2026" draws, or the two
 * would be different kinds of thing again.
 *
 * ── ONE WALL, NOT A ROW PER KIND ────────────────────────────────────────────
 * Every card — a design tile, a swatch, a specimen — goes into a single
 * wrapping wall, in that order, and the line fills before it breaks.
 *
 * The first cut of this gave each kind its own labelled block. In a mixed
 * folder holding one of each, that drew three rows of one card with the page
 * empty to the right of every one of them, which is exactly what the founder
 * saw: "PLEASE put these items side by side, I hate all the ugly unused empty
 * space." A folder of three things should read as three things.
 *
 * The kinds keep their ORDER inside the wall — files, then paint, then type —
 * so a folder still reads files-first, and the one-line count above it says
 * what the labels used to. Nothing is lost but the whitespace.
 *
 * ── Files, then paint, then type ────────────────────────────────────────────
 * That order is deliberate and it is the founder's: the design files lead. They
 * are what grows, what a search is aimed at, and what somebody opened the tab
 * to get; the color and the face are what you need one scroll later, once you
 * are making something. Holding it INSIDE the folder body means it holds
 * everywhere at once — in the library, in the Colors section, and in a mixed
 * event folder.
 *
 * ── The list view is the one thing that can't join the wall ─────────────────
 * A list row is full width, so it cannot sit beside a card. In list view the
 * designs render as their own list and the colors and faces still share one
 * wall underneath it — which is the densest honest arrangement of two shapes
 * that genuinely don't mix.
 */
import { ReactNode } from "react";
import { Text, View } from "react-native";
import {
  BRAND_FONT_ROLES,
  type BrandColor,
  type BrandFont,
  type DesignAsset,
} from "@events-os/shared";
import { DesignList, DesignTile, liveEmbedIds } from "./DesignGrid";
import { Swatch } from "./Swatch";
import { SpecimenCard } from "./Specimen";
import type { LibraryItems } from "./library.shared";

export function FolderBody({
  items,
  palette,
  view,
  onOpenColor,
  onOpenFont,
  onOpenDesign,
  empty,
}: {
  items: LibraryItems;
  /** The whole palette, for painting design placeholders — not what's shown. */
  palette: BrandColor[];
  view: "grid" | "list";
  onOpenColor: (color: BrandColor) => void;
  onOpenFont: (font: BrandFont) => void;
  onOpenDesign: (design: DesignAsset) => void;
  /** Rendered instead when the folder holds nothing at all. */
  empty: ReactNode;
}) {
  const kinds =
    (items.designs.length > 0 ? 1 : 0) +
    (items.colors.length > 0 ? 1 : 0) +
    (items.fonts.length > 0 ? 1 : 0);

  if (kinds === 0) return <>{empty}</>;

  // Faces read best headlines-first, and the role pill on each card names the
  // role — so they are ORDERED by role rather than split under a heading each,
  // which is what used to turn four faces into four one-card sections.
  const fonts = BRAND_FONT_ROLES.flatMap((role) =>
    items.fonts.filter((f) => f.role === role),
  );

  // In list view the designs leave the wall; everything else stays in it.
  const listed = view === "list" && items.designs.length > 0;
  const tiles = listed ? [] : items.designs;
  const live = liveEmbedIds(tiles);
  const hasWall = tiles.length + items.colors.length + fonts.length > 0;

  return (
    <View className="gap-4">
      {kinds > 1 ? <Breakdown items={items} /> : null}

      {listed ? (
        <DesignList
          designs={items.designs}
          palette={palette}
          onOpen={onOpenDesign}
        />
      ) : null}

      {hasWall ? (
        // `items-start` so a short card keeps its own height instead of
        // stretching to the tallest thing on its line.
        <View className="flex-row flex-wrap items-start gap-3.5">
          {tiles.map((design) => (
            <DesignTile
              key={design.id}
              design={design}
              palette={palette}
              live={live.has(design.id)}
              onOpen={onOpenDesign}
            />
          ))}
          {items.colors.map((color) => (
            <Swatch key={color.id} color={color} onOpen={onOpenColor} />
          ))}
          {fonts.map((font) => (
            <SpecimenCard key={font.id} font={font} onOpen={onOpenFont} />
          ))}
        </View>
      ) : null}

      {caption(items.colors.length > 0, fonts.length > 0) ? (
        <Text className="text-2xs leading-4 text-faint">
          {caption(items.colors.length > 0, fonts.length > 0)}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * "4 files · 1 color · 1 face" — what the per-kind headings used to say, in one
 * line above the wall instead of three rows through it.
 *
 * Only drawn for a MIXED folder. In a folder of one kind the section header's
 * own count already says it, and repeating it is the page saying the same
 * number twice.
 */
function Breakdown({ items }: { items: LibraryItems }) {
  const parts = [
    plural(items.designs.length, "file"),
    plural(items.colors.length, "color"),
    plural(items.fonts.length, "face"),
  ].filter((part): part is string => part !== null);

  return (
    <Text className="text-2xs text-faint">{parts.join(" · ")}</Text>
  );
}

function plural(count: number, noun: string): string | null {
  if (count === 0) return null;
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** The one line under the wall, saying only what it has cards for. */
function caption(hasColors: boolean, hasFonts: boolean): string | null {
  const lines = [
    hasColors ? "Press a swatch to copy its hex." : null,
    hasFonts
      ? "Each face is set in itself, where this device has it — and says what it's for."
      : null,
  ].filter((line): line is string => line !== null);
  return lines.length > 0 ? lines.join(" ") : null;
}
