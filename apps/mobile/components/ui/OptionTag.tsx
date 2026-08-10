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
    // `max-w-full` pairs with `self-start`: the chip still hugs its label
    // (that's what `self-start` buys), but it can never grow WIDER than the box
    // it was given. Without the cap, a long label in a fixed-width grid cell
    // sized the chip past the column and `numberOfLines={1}` never fired —
    // ellipsis only happens once the box is actually constrained — so the chip
    // rendered at full width, on top of the next column. See `Cell`'s comment
    // in `finance/reconcile/ReconcileList.tsx`.
    <View
      className={`max-w-full flex-row items-center gap-1 self-start rounded-sm ${
        isMd ? "px-3 py-1.5" : "px-2 py-0.5"
      }`}
      style={{
        backgroundColor: c.bg,
        ...(selected ? { borderWidth: 1, borderColor: c.text } : null),
      }}
    >
      <Text
        // `shrink` so the capped chip above can actually squeeze this label
        // down to where `numberOfLines={1}` ellipsizes it, instead of the label
        // holding the chip open at its natural width.
        className={`shrink ${isMd ? "text-sm font-semibold" : "text-xs font-semibold"}`}
        style={{ color: c.text }}
        numberOfLines={1}
      >
        {label}
      </Text>
      {onRemove ? (
        <Pressable
          onPress={onRemove}
          accessibilityRole="button"
          // The ✕ is an icon with no text, so without this it announced as an
          // anonymous button — in a row of chips, "button" five times over.
          accessibilityLabel={`Remove ${label}`}
          hitSlop={isMd ? 8 : 6}
        >
          <Icon name="x" size={isMd ? 14 : 11} color={c.text} />
        </Pressable>
      ) : null}
    </View>
  );
  if (!onPress) return inner;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      // Omitted when the caller passes no `selected` — a tag that merely opens
      // an editor is an action, not a toggle, and shouldn't announce a state.
      aria-pressed={selected}
      accessibilityLabel={label}
      className="self-start active:opacity-70"
    >
      {inner}
    </Pressable>
  );
}
