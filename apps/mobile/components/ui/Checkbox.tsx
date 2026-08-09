/**
 * A checkbox a keyboard user can actually toggle.
 *
 * Two defects live in every hand-rolled checkbox on react-native-web, which is
 * why the fix lives here once instead of in each grid:
 *
 * 1. Space did nothing — see `spaceToggle.ts` for the RNW gate and why the
 *    role stays `"checkbox"` rather than becoming `"button"`.
 * 2. `accessibilityState` is NOT in react-native-web 0.21.2's forwarded-prop
 *    list — only `accessibilityChecked` / `aria-checked` are
 *    (`modules/createDOMProps`). So every `accessibilityState={{ checked }}`
 *    in this app emitted no DOM attribute at all, and a screen reader
 *    announced the box as permanently unchecked. `aria-checked` below is a
 *    real React Native prop (native maps it back onto
 *    `accessibilityState.checked`), so both platforms are correct.
 */
import { Pressable, View } from "react-native";
import { Icon } from "./Icon";
import { spaceToggleProps } from "./spaceToggle";
import { colors } from "../../lib/theme";

export function Checkbox({
  checked,
  onPress,
  accessibilityLabel,
  disabled = false,
}: {
  checked: boolean;
  onPress: () => void;
  /** Always pass one — a bare box announces as "checkbox, checked" with no
   *  clue WHICH row it belongs to, which is useless in a grid. */
  accessibilityLabel: string;
  disabled?: boolean;
}) {
  return (
    <Pressable
      {...spaceToggleProps(onPress, disabled)}
      onPress={onPress}
      disabled={disabled}
      hitSlop={6}
      accessibilityRole="checkbox"
      // `aria-checked` is the one that survives to the DOM on web; the
      // `accessibilityState` beside it is what older native paths read.
      aria-checked={checked}
      accessibilityState={{ checked, disabled }}
      accessibilityLabel={accessibilityLabel}
      className={`rounded p-1 ${disabled ? "opacity-40" : "active:opacity-70"}`}
    >
      <View
        className={`h-4 w-4 items-center justify-center rounded border ${
          checked ? "border-accent bg-accent" : "border-border-strong bg-raised"
        }`}
      >
        {checked ? <Icon name="check" size={12} color={colors.accentText} /> : null}
      </View>
    </Pressable>
  );
}
