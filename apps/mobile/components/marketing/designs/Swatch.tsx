/**
 * MARKETING · Designs — one color, as a card of the paint itself.
 *
 * Nobody reads `#891d1a` and pictures a color. The shipped tab was a table of
 * hex codes with a 36px chip beside each one; this is the inverse — the swatch
 * IS the tile, the name is its caption, and the hex sits under the name in the
 * small type that a code deserves.
 *
 * ── One tap does the thing people came for ──────────────────────────────────
 * Pressing a swatch copies its hex AND opens it in the viewer, which is what
 * the approved mockup does. The copy is best-effort: the tile only says
 * "Copied" when the system clipboard actually took it. The panel that opens is
 * still where the hex is legible and selectable if the copy is unavailable.
 *
 * ── One card, and somebody else owns the wall ───────────────────────────────
 * This used to export a `SwatchWall` that laid its own swatches out. It doesn't
 * any more, because a folder holds colors AND faces AND files, and three
 * components each drawing their own row turned a mixed folder into three
 * one-card rows with the page empty to the right of each. `FolderBody` now owns
 * a single wrapping wall and puts every kind of card into it, so they flow
 * together and fill the line.
 *
 * The card keeps its FIXED WIDTH, matching the design tile's, so a wall of
 * mixed cards lines up instead of looking hand-placed. A fixed width also
 * reflows correctly on every platform without measuring the window — which
 * matters because this renders inside a rail-and-canvas split whose available
 * width is not the window's.
 */
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { BrandColor } from "@events-os/shared";
import { copyToClipboard } from "../../../lib/clipboard";
import { readableInkOn } from "./library.shared";

export function Swatch({
  color,
  onOpen,
}: {
  color: BrandColor;
  onOpen: (color: BrandColor) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [hovered, setHovered] = useState(false);

  async function press() {
    if (await copyToClipboard(color.hex)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
    onOpen(color);
  }

  return (
    <Pressable
      onPress={() => void press()}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      accessibilityRole="button"
      accessibilityLabel={`${color.name}, ${color.hex}. Copy and open.`}
      className={`w-[178px] overflow-hidden rounded-lg border bg-raised ${
        hovered ? "border-border-strong shadow-raised" : "border-border shadow-card"
      }`}
    >
      {/* The one place a raw hex belongs in a screen: it is the data, not a
          design token. */}
      <View
        className="h-[84px] w-full items-end justify-start p-2"
        style={{ backgroundColor: color.hex }}
      >
        {copied ? (
          <Text
            className="text-2xs font-semibold"
            style={{ color: readableInkOn(color.hex) }}
          >
            Copied
          </Text>
        ) : null}
      </View>
      <View className="gap-0.5 px-3 py-2.5">
        <Text className="text-sm font-semibold text-ink" numberOfLines={1}>
          {color.name}
        </Text>
        <Text
          className="text-2xs text-muted"
          style={{ fontVariant: ["tabular-nums"] }}
        >
          {color.hex}
        </Text>
      </View>
    </Pressable>
  );
}
