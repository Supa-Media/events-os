import { Text, View, Pressable } from "react-native";
import { optionColor } from "../../lib/optionColor";
import { Icon } from "./Icon";

type Props = {
  label: string;
  color?: string | null;
  /** Tappable (e.g. to open an editor). */
  onPress?: () => void;
  /** Shows an ✕ to remove (multiselect chips). */
  onRemove?: () => void;
  selected?: boolean;
  /** "md" bumps padding/text/icon and the remove button's hit-slop for a more
   *  comfortably tappable chip — opt-in so existing dense uses (grid cells,
   *  tables) keep their compact "sm" footprint by default. */
  size?: "sm" | "md";
};

/**
 * A colored option chip for select / multiselect / status cells. Colors come
 * from the option's `color` string via inline style (NativeWind can't build
 * classes from dynamic strings); layout matches Badge/Pill.
 */
export function OptionTag({ label, color, onPress, onRemove, selected, size = "sm" }: Props) {
  const c = optionColor(color);
  const isMd = size === "md";
  const inner = (
    <View
      className={`flex-row items-center gap-1 self-start rounded-sm ${
        isMd ? "px-3 py-1.5" : "px-2 py-0.5"
      }`}
      style={{
        backgroundColor: c.bg,
        ...(selected ? { borderWidth: 1, borderColor: c.text } : null),
      }}
    >
      <Text
        className={isMd ? "text-sm font-semibold" : "text-xs font-semibold"}
        style={{ color: c.text }}
        numberOfLines={1}
      >
        {label}
      </Text>
      {onRemove ? (
        <Pressable onPress={onRemove} hitSlop={isMd ? 8 : 6}>
          <Icon name="x" size={isMd ? 14 : 11} color={c.text} />
        </Pressable>
      ) : null}
    </View>
  );
  if (!onPress) return inner;
  return (
    <Pressable onPress={onPress} className="self-start active:opacity-70">
      {inner}
    </Pressable>
  );
}
