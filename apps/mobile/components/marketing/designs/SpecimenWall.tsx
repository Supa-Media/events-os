/**
 * MARKETING · Designs — the faces, as specimens set in themselves.
 *
 * A font row that isn't set in the font tells you nothing, which is what the
 * shipped tab was: a name, a note, and a "Get it" button. Each card here draws
 * `Aa Bb Cc` and the org's own sentence in the face it names.
 *
 * ── The honesty rule, which is the whole reason this file is careful ────────
 * Every platform silently substitutes a face it doesn't have, so a naive
 * specimen shows you Helvetica and calls it Barbra. `./fontSpecimen.shared`
 * decides what may be drawn against a real platform probe (`./fontProbe`), and
 * there are exactly three outcomes: draw it; draw the base cut and SAY that is
 * what you are looking at; or draw nothing typographic at all and offer the
 * download link, which is the only useful thing the card can do at that point.
 *
 * Concretely, on most devices: Inter and SF Pro draw; Times New Roman Condensed
 * draws as Times New Roman with the substitution named; Barbra Condensed draws
 * nothing and points at the file.
 */
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { BRAND_FONT_ROLE_LABELS, type BrandFont } from "@events-os/shared";
import { Icon } from "../../ui";
import { colors } from "../../../lib/theme";
import { hasFontFamily } from "./fontProbe";
import {
  SPECIMEN_GLYPHS,
  SPECIMEN_PHRASE,
  resolveSpecimen,
  specimenCaveat,
  type Specimen,
} from "./fontSpecimen.shared";

export function SpecimenWall({
  fonts,
  onOpen,
}: {
  fonts: BrandFont[];
  onOpen: (font: BrandFont) => void;
}) {
  return (
    <View className="flex-row flex-wrap gap-3">
      {fonts.map((font) => (
        <SpecimenCard key={font.id} font={font} onOpen={onOpen} />
      ))}
    </View>
  );
}

function SpecimenCard({
  font,
  onOpen,
}: {
  font: BrandFont;
  onOpen: (font: BrandFont) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const specimen = resolveSpecimen(font.name, hasFontFamily);

  return (
    <Pressable
      onPress={() => onOpen(font)}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      accessibilityRole="button"
      accessibilityLabel={`${font.name}, for ${BRAND_FONT_ROLE_LABELS[font.role]}`}
      className={`w-[256px] overflow-hidden rounded-lg border bg-raised ${
        hovered ? "border-border-strong shadow-raised" : "border-border shadow-card"
      }`}
    >
      <View className="min-h-[104px] justify-center gap-1 border-b border-border bg-sunken px-4 py-4">
        <SpecimenSample specimen={specimen} name={font.name} />
      </View>
      <View className="flex-row items-center gap-2 px-3 py-2.5">
        <Text className="flex-1 text-sm font-semibold text-ink" numberOfLines={1}>
          {font.name}
        </Text>
        <View className="rounded-pill bg-accent-soft px-2 py-0.5">
          <Text className="text-2xs font-semibold text-accent">
            {BRAND_FONT_ROLE_LABELS[font.role]}
          </Text>
        </View>
      </View>
    </Pressable>
  );
}

/**
 * The sample itself, at tile size. Shared with the inspector's larger preview
 * through `scale`, so the two can never disagree about whether a face is
 * showable — the bug that version would have is exactly the one this module
 * exists to prevent.
 */
export function SpecimenSample({
  specimen,
  name,
  scale = 1,
}: {
  specimen: Specimen;
  name: string;
  scale?: number;
}) {
  if (specimen.status === "unavailable") {
    return (
      <View className="gap-1">
        <View className="flex-row items-center gap-1.5">
          <Icon name="eye-off" size={13} color={colors.faint} />
          <Text className="text-xs font-semibold text-muted">
            No preview on this device
          </Text>
        </View>
        <Text className="text-2xs leading-4 text-faint">
          {specimenCaveat(name, specimen)} Open the download link to get the
          file — better an honest gap than a sample in the wrong typeface.
        </Text>
      </View>
    );
  }

  return (
    <View className="gap-1">
      <Text
        className="text-ink"
        numberOfLines={1}
        style={{ fontFamily: specimen.fontFamily, fontSize: 30 * scale, lineHeight: 36 * scale }}
      >
        {SPECIMEN_GLYPHS}
      </Text>
      <Text
        className="text-muted"
        numberOfLines={2}
        style={{ fontFamily: specimen.fontFamily, fontSize: 13 * scale, lineHeight: 18 * scale }}
      >
        {SPECIMEN_PHRASE}
      </Text>
      {specimen.status === "substitute" ? (
        <View className="mt-1 flex-row items-center gap-1.5">
          <Icon name="alert-circle" size={12} color={colors.warn} />
          <Text className="flex-1 text-2xs text-warn" numberOfLines={2}>
            {specimenCaveat(name, specimen)}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
