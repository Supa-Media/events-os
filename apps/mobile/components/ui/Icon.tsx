import { Feather, Ionicons } from "@expo/vector-icons";
import { colors } from "../../lib/theme";

/**
 * Line-icon wrapper around `@expo/vector-icons` Feather set. Feather is a clean,
 * lucide-style line set that ships with Expo and renders reliably on web with
 * no extra native module (avoids pulling in react-native-svg). The whole UI kit
 * draws its glyphs through here so the icon language stays consistent.
 *
 * A small set of glyphs the AI surfaces need (e.g. the recognizable "sparkles"
 * AI star) don't exist in Feather, so we map those names onto Ionicons — also
 * part of `@expo/vector-icons`, font-based, and equally web-safe.
 */
const IONICONS_ALIASES = {
  // The four-point "sparkles" star is the widely recognized AI marker.
  sparkles: "sparkles",
  // Feather's flag is outline-only; the solid Ionicons flag fills with `color`
  // for markers that need to read as a bold, filled pin (e.g. the event day).
  "flag-solid": "flag",
  // Feather has no building glyph; Ionicons' "business" reads as the
  // recognizable building icon used for the People tab's "backer" mark.
  building: "business",
} as const;

export type IconName =
  | keyof typeof Feather.glyphMap
  | keyof typeof IONICONS_ALIASES;

type Props = {
  name: IconName;
  size?: number;
  /** Raw color; defaults to inherited ink. Prefer passing a token color. */
  color?: string;
};

export function Icon({ name, size = 18, color = colors.ink }: Props) {
  if (name in IONICONS_ALIASES) {
    const ionName = IONICONS_ALIASES[name as keyof typeof IONICONS_ALIASES];
    return <Ionicons name={ionName} size={size} color={color} />;
  }
  return (
    <Feather name={name as keyof typeof Feather.glyphMap} size={size} color={color} />
  );
}
