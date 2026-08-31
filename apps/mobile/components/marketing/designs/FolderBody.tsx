/**
 * MARKETING · Designs — what is inside a folder, drawn.
 *
 * ONE renderer, used twice: for the folder you have selected in the library,
 * and for every pinned folder's own section. That is not a saving of code so
 * much as the point of the model — "Colors" is a folder that happens to be
 * pinned, so it has to draw exactly the way "Easter 2026" draws, or the two
 * would be different kinds of thing again.
 *
 * ── Files, then paint, then type ────────────────────────────────────────────
 * The order is deliberate and it is the founder's: the design files lead. They
 * are what grows, what a search is aimed at, and what somebody opened the tab
 * to get; the color and the face are what you need one scroll later, once you
 * are making something. Holding that order INSIDE the folder body means it
 * holds everywhere at once — in the library, in the Colors section, and in a
 * mixed event folder.
 *
 * ── Labels appear only when they carry information ──────────────────────────
 * A folder holding one kind of thing gets no sub-headings: a wall of swatches
 * under a heading that says "Colors", inside a section already called Colors,
 * is the page saying the same word three times. A MIXED folder gets them,
 * because there the label is the only thing that says where one kind ends and
 * the next begins.
 */
import { ReactNode } from "react";
import { Text, View } from "react-native";
import {
  BRAND_FONT_ROLES,
  type BrandColor,
  type BrandFont,
  type DesignAsset,
} from "@events-os/shared";
import { DesignGrid } from "./DesignGrid";
import { SwatchWall } from "./SwatchWall";
import { SpecimenWall } from "./SpecimenWall";
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

  const labelled = kinds > 1;

  return (
    <View className="gap-5">
      {items.designs.length > 0 ? (
        <View>
          {labelled ? <KindLabel label="Design files" count={items.designs.length} /> : null}
          <DesignGrid
            designs={items.designs}
            palette={palette}
            view={view}
            onOpen={onOpenDesign}
          />
        </View>
      ) : null}

      {items.colors.length > 0 ? (
        <View>
          {labelled ? <KindLabel label="Colors" count={items.colors.length} /> : null}
          <SwatchWall palette={items.colors} onOpen={onOpenColor} />
          <Text className="mt-2 text-2xs text-faint">
            Press a swatch to copy its hex and open it.
          </Text>
        </View>
      ) : null}

      {fonts.length > 0 ? (
        <View>
          {labelled ? <KindLabel label="Faces" count={fonts.length} /> : null}
          <SpecimenWall fonts={fonts} onOpen={onOpenFont} />
          <Text className="mt-2 text-2xs text-faint">
            Each card is set in the face it names, where this device has it —
            and says what it&apos;s for.
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function KindLabel({ label, count }: { label: string; count: number }) {
  return (
    <View className="mb-2 flex-row items-baseline gap-2">
      <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
        {label}
      </Text>
      <Text
        className="text-2xs text-faint"
        style={{ fontVariant: ["tabular-nums"] }}
      >
        {count}
      </Text>
    </View>
  );
}
