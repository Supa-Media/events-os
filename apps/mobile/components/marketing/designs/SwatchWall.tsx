/**
 * MARKETING · Designs — the colors, as a wall of paint.
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
 * ── Tiles are a fixed width, not a computed column count ────────────────────
 * `flex-wrap` with a fixed tile width reflows correctly on every platform
 * without measuring the window — which matters because this file renders inside
 * a rail-and-canvas split whose available width is not the window's.
 */
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { BrandColor } from "@events-os/shared";
import { copyToClipboard } from "../../../lib/clipboard";
import { readableInkOn } from "./library.shared";

export function SwatchWall({
  palette,
  onOpen,
}: {
  palette: BrandColor[];
  onOpen: (color: BrandColor) => void;
}) {
  return (
    <View className="flex-row flex-wrap gap-3">
      {palette.map((color) => (
        <Swatch key={color.id} color={color} onOpen={onOpen} />
      ))}
    </View>
  );
}

function Swatch({
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
      className={`w-[164px] overflow-hidden rounded-lg border bg-raised ${
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
