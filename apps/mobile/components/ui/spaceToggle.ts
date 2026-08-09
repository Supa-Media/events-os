/**
 * Space handling for the toggle roles react-native-web forgets.
 *
 * RNW activates a `Pressable` on Enter unconditionally, but on SPACE only when
 * the element's role is button-ish
 * (`modules/usePressEvents/PressResponder.js`):
 *
 *     var isButtonRole = element => getElementRole(element) === 'button';
 *     var isValidKeyPress = event => {
 *       var isSpacebar = key === ' ' || key === 'Spacebar';
 *       var isButtonish = getElementType(target) === 'button' || isButtonRole(target);
 *       return key === 'Enter' || isSpacebar && isButtonish;
 *     };
 *
 * So `role="checkbox"`, `role="switch"` and `role="radio"` all answer Enter and
 * ignore Space — exactly backwards from both the native controls and ARIA,
 * which require Space for every one of them. The fix is NOT to relabel the
 * control `role="button"`: that buys Space for free but costs the
 * checked-state announcement, trading a keyboard bug for a screen-reader one.
 * Handle the key instead, and keep the honest role.
 *
 * `preventDefault()` matters: RNW only suppresses Space's page-scroll for
 * button/menuitem roles, so without it a checkbox that toggles ALSO jumps the
 * page a screenful.
 *
 * **Only Space, never Enter.** `Pressable` COMPOSES a caller's `onKeyDown`
 * with the press responder's own rather than replacing it, and the responder
 * has already armed Enter by the time this handler runs — answering Enter here
 * too would toggle twice.
 */
import { Platform } from "react-native";

/** `onKeyDown` is web-only, so it isn't in React Native's `Pressable` types
 *  even though react-native-web forwards it (`forwardedProps`'s
 *  `keyboardProps`). Spread through this shape rather than casting a whole
 *  component's props to `any`. */
export type WebKeyHandlers = {
  onKeyDown?: (event: {
    key?: string;
    preventDefault?: () => void;
    nativeEvent?: { key?: string };
  }) => void;
};

export function isSpaceKey(event: {
  key?: string;
  nativeEvent?: { key?: string };
}): boolean {
  const key = event.key ?? event.nativeEvent?.key;
  return key === " " || key === "Spacebar";
}

/**
 * Props to spread onto a `Pressable` whose role is `checkbox`, `switch`, or
 * `radio` so that Space activates it. No-op off web.
 */
export function spaceToggleProps(
  onPress: () => void,
  disabled?: boolean,
): WebKeyHandlers {
  if (Platform.OS !== "web") return {};
  return {
    onKeyDown: (event) => {
      if (disabled) return;
      if (!isSpaceKey(event)) return;
      event.preventDefault?.();
      onPress();
    },
  };
}
