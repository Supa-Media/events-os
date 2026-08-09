/**
 * A checkbox with its label, as one press target and one tab stop.
 *
 * `Checkbox` is the bare box for grids, where the label is the row. This is
 * the form version — the pattern three screens had each hand-rolled a copy of
 * (`CardControlsModal`, `IssueCardModal`, `MerchantAllowlistSection`; the
 * first two byte-for-byte, the third differing only in a `disabled`). All
 * three had no role, no state and no name, so a screen reader announced them
 * as a line of text.
 *
 * The label is REQUIRED and doubles as the accessible name — the whole reason
 * these went unnamed is that the text sat in a sibling `<Text>` and nobody had
 * to say it twice.
 */
import { Pressable, Text, View } from "react-native";
import { Icon } from "./Icon";
import { spaceToggleProps } from "./spaceToggle";

export function CheckboxRow({
  checked,
  onPress,
  label,
  disabled = false,
  className = "mb-3",
}: {
  checked: boolean;
  onPress: () => void;
  label: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <Pressable
      {...spaceToggleProps(onPress, disabled)}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="checkbox"
      // `aria-checked` is the prop that survives to the DOM on web; see
      // `ui/Checkbox` for why `accessibilityState` alone is not enough.
      aria-checked={checked}
      accessibilityState={{ checked, disabled }}
      accessibilityLabel={label}
      className={`flex-row items-center gap-2 ${className} ${
        disabled ? "opacity-50" : ""
      }`}
    >
      <View
        className={`h-5 w-5 items-center justify-center rounded border ${
          checked ? "border-accent bg-accent" : "border-border-strong bg-raised"
        }`}
      >
        {checked ? <Icon name="check" size={13} color="#FFFFFF" /> : null}
      </View>
      <Text className="text-sm font-semibold text-ink">{label}</Text>
    </Pressable>
  );
}
