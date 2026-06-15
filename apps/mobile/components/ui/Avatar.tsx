import { View, Text, Image } from "react-native";
import { palette } from "../../lib/theme";

const PASTELS = [
  { bg: palette.peach, fg: "#7A4B12" },
  { bg: palette.mint, fg: "#1F5A41" },
  { bg: palette.lavender, fg: "#4B2A66" },
  { bg: palette.sky, fg: "#274877" },
  { bg: palette.brand200, fg: palette.brand700 },
];

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * Avatar — a profile photo when `uri` is given, otherwise an initials chip with
 * a deterministic pastel fill keyed off the name.
 */
export function Avatar({
  name,
  size = 28,
  uri,
}: {
  name: string;
  size?: number;
  uri?: string | null;
}) {
  if (uri) {
    return (
      <Image
        source={{ uri }}
        style={{ width: size, height: size, borderRadius: size / 2 }}
        resizeMode="cover"
      />
    );
  }
  const c = PASTELS[hash(name) % PASTELS.length];
  return (
    <View
      style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: c.bg }}
      className="items-center justify-center"
    >
      <Text style={{ color: c.fg, fontSize: size * 0.4 }} className="font-bold">
        {initials(name)}
      </Text>
    </View>
  );
}
