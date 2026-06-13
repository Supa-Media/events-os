import { Feather } from "@expo/vector-icons";
import { colors } from "../../lib/theme";

/**
 * Line-icon wrapper around `@expo/vector-icons` Feather set. Feather is a clean,
 * lucide-style line set that ships with Expo and renders reliably on web with
 * no extra native module (avoids pulling in react-native-svg). The whole UI kit
 * draws its glyphs through here so the icon language stays consistent.
 */
export type IconName = keyof typeof Feather.glyphMap;

type Props = {
  name: IconName;
  size?: number;
  /** Raw color; defaults to inherited ink. Prefer passing a token color. */
  color?: string;
};

export function Icon({ name, size = 18, color = colors.ink }: Props) {
  return <Feather name={name} size={size} color={color} />;
}
