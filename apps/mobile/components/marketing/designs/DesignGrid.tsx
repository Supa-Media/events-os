/**
 * MARKETING · Designs — the files, as a grid of things you can see.
 *
 * The shipped tab drew a card per design with a live Canva frame inside it. The
 * grid draws a STORED THUMBNAIL and nothing else; the live embed happens once,
 * in the viewer, for the one file you opened. That is the mockup's own call and
 * it is the difference between a library that loads and nine authenticated
 * iframes racing each other.
 *
 * ── A design with no thumbnail is not a grey box ────────────────────────────
 * It gets a typographic tile painted from the ORG'S palette — the same colors
 * the swatch wall two sections up is showing — with the design's initials on
 * it. `designPreview` picks the paint deterministically so a tile doesn't
 * change color as the list reorders. A grey rectangle says "broken"; a red one
 * with "LT" on it says "this is ours and nobody has thumbnailed it yet".
 *
 * ── Grid and list are the same rows ─────────────────────────────────────────
 * The toggle changes density, not content: the list is for a folder of forty
 * near-identical story overlays where the title is the distinguishing feature,
 * the grid is for everything else.
 */
import { useState } from "react";
import { Image, Pressable, Text, View } from "react-native";
import {
  DESIGN_KIND_LABELS,
  type BrandColor,
  type DesignAsset,
} from "@events-os/shared";
import { designPreview, type DesignPreview } from "./library.shared";

export function DesignGrid({
  designs,
  palette,
  view,
  onOpen,
}: {
  designs: DesignAsset[];
  /** The brand kit, for painting the placeholders. */
  palette: BrandColor[];
  view: "grid" | "list";
  onOpen: (design: DesignAsset) => void;
}) {
  if (view === "list") {
    return (
      <View className="overflow-hidden rounded-lg border border-border bg-raised">
        {designs.map((design, index) => (
          <DesignRow
            key={design.id}
            design={design}
            palette={palette}
            first={index === 0}
            onOpen={onOpen}
          />
        ))}
      </View>
    );
  }

  return (
    <View className="flex-row flex-wrap gap-3.5">
      {designs.map((design) => (
        <DesignTile
          key={design.id}
          design={design}
          palette={palette}
          onOpen={onOpen}
        />
      ))}
    </View>
  );
}

function DesignTile({
  design,
  palette,
  onOpen,
}: {
  design: DesignAsset;
  palette: BrandColor[];
  onOpen: (design: DesignAsset) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const preview = designPreview(design, palette);

  return (
    <Pressable
      onPress={() => onOpen(design)}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      accessibilityRole="button"
      accessibilityLabel={`${design.title}, ${DESIGN_KIND_LABELS[design.kind]}`}
      className={`w-[178px] overflow-hidden rounded-lg border bg-raised ${
        hovered ? "border-border-strong shadow-raised" : "border-border shadow-card"
      }`}
    >
      <View className="h-[210px] w-full">
        <Preview preview={preview} title={design.title} />
        <View className="absolute left-2 top-2 rounded-pill bg-raised/95 px-2 py-0.5">
          <Text className="text-2xs font-semibold text-ink">
            {DESIGN_KIND_LABELS[design.kind]}
          </Text>
        </View>
      </View>
      <View className="gap-0.5 border-t border-border px-3 py-2.5">
        <Text className="text-sm font-semibold leading-4 text-ink" numberOfLines={2}>
          {design.title}
        </Text>
        {design.notes ? (
          <Text className="text-2xs text-faint" numberOfLines={1}>
            {design.notes}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

function DesignRow({
  design,
  palette,
  first,
  onOpen,
}: {
  design: DesignAsset;
  palette: BrandColor[];
  first: boolean;
  onOpen: (design: DesignAsset) => void;
}) {
  const preview = designPreview(design, palette);
  return (
    <Pressable
      onPress={() => onOpen(design)}
      accessibilityRole="button"
      accessibilityLabel={`${design.title}, ${DESIGN_KIND_LABELS[design.kind]}`}
      className={`flex-row items-center gap-3 px-3 py-2.5 web:hover:bg-sunken ${
        first ? "" : "border-t border-border"
      }`}
    >
      <View className="h-[50px] w-10 overflow-hidden rounded-sm">
        <Preview preview={preview} title={design.title} initialsSize={15} />
      </View>
      <View className="min-w-0 flex-1">
        <Text className="text-sm font-semibold text-ink" numberOfLines={1}>
          {design.title}
        </Text>
        {design.notes ? (
          <Text className="text-2xs text-faint" numberOfLines={1}>
            {design.notes}
          </Text>
        ) : null}
      </View>
      <Text className="text-2xs text-faint">
        {DESIGN_KIND_LABELS[design.kind]}
      </Text>
    </Pressable>
  );
}

/** The picture box — a hosted still, or the brand-painted stand-in. */
function Preview({
  preview,
  title,
  initialsSize = 34,
}: {
  preview: DesignPreview;
  title: string;
  /** The initials shrink for the list row's 40x50 stamp. */
  initialsSize?: number;
}) {
  if (preview.kind === "image") {
    return (
      <Image
        source={{ uri: preview.uri }}
        accessibilityLabel={title}
        className="h-full w-full bg-sunken"
        resizeMode="cover"
      />
    );
  }
  return (
    <View
      className="h-full w-full items-center justify-center"
      style={{ backgroundColor: preview.background }}
    >
      <Text
        className="font-display"
        style={{
          color: preview.foreground,
          fontSize: initialsSize,
          lineHeight: initialsSize * 1.2,
        }}
        numberOfLines={1}
      >
        {preview.initials}
      </Text>
    </View>
  );
}
