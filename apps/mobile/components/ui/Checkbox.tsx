/**
 * A checkbox a keyboard user can actually toggle.
 *
 * react-native-web activates a `Pressable` on Enter unconditionally, but on
 * SPACE only when the element's role is button-ish
 * (`modules/usePressEvents/PressResponder.js`):
 *
 *     var isButtonRole = element => getElementRole(element) === 'button';
 *     var isValidKeyPress = event => {
 *       var isSpacebar = key === ' ' || key === 'Spacebar';
 *       var isButtonish = getElementType(target) === 'button' || isButtonRole(target);
 *       return key === 'Enter' || isSpacebar && isButtonish;
 *     };
 *
 * So a `<Pressable accessibilityRole="checkbox">` answers Enter and ignores
 * Space — exactly backwards. A native `<input type="checkbox">` toggles on
 * Space and ignores Enter, and ARIA requires Space for the role, so the one
 * key a keyboard user will actually press is the one that did nothing. Every
 * hand-rolled checkbox in this app carried that defect, which is why the fix
 * lives here once instead of in each grid.
 *
 * The role stays `"checkbox"`. Switching it to `"button"` would restore Space
 * for free, but at the cost of the checked-state announcement — trading a
 * keyboard bug for a screen-reader one. Space is handled directly instead:
 * react-native-web forwards `onKeyDown` to the DOM node (`forwardedProps`'s
 * `keyboardProps`), and `Pressable` explicitly COMPOSES a caller's handler
 * with the press responder's own rather than replacing it. That ordering is
 * why only Space is handled here: the responder runs first and has already
 * armed the Enter activation, so also answering Enter would toggle twice.
 *
 * Second defect, same class, fixed here too: `accessibilityState` is NOT in
 * react-native-web 0.21.2's forwarded-prop list — only `accessibilityChecked`
 * / `aria-checked` are (`modules/createDOMProps`). So every
 * `accessibilityState={{ checked }}` in this app emitted no DOM attribute at
 * all, and a screen reader announced the box as permanently unchecked. This
 * passes `aria-checked`, which is a real React Native prop (native maps it
 * back onto `accessibilityState.checked`), so both platforms are correct.
 */
import { Platform, Pressable, View } from "react-native";
import { Icon } from "./Icon";
import { colors } from "../../lib/theme";

/** `onKeyDown` is web-only, so it isn't in React Native's `Pressable` types
 *  even though react-native-web forwards it. Spread through this shape rather
 *  than casting the whole component's props to `any`. */
type WebKeyHandlers = {
  onKeyDown?: (event: {
    key?: string;
    preventDefault?: () => void;
    nativeEvent?: { key?: string };
  }) => void;
};

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
  const webKeys: WebKeyHandlers =
    Platform.OS === "web"
      ? {
          onKeyDown: (event) => {
            if (disabled) return;
            const key = event.key ?? event.nativeEvent?.key;
            if (key !== " " && key !== "Spacebar") return;
            // Space scrolls the page by default; a checkbox that toggles AND
            // jumps the grid a screenful is barely better than one that
            // doesn't toggle.
            event.preventDefault?.();
            onPress();
          },
        }
      : {};

  return (
    <Pressable
      {...webKeys}
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
