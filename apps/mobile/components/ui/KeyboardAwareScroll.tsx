import { forwardRef, type ReactNode } from "react";
import { ScrollView, type ScrollViewProps } from "react-native";
import { loadKeyboardController } from "../../lib/keyboardController";

type Props = ScrollViewProps & {
  children?: ReactNode;
  /** Extra room kept below the focused input. Ignored by the fallback. */
  bottomOffset?: number;
};

/**
 * Drop-in for `KeyboardAwareScrollView` that degrades to a plain `ScrollView`
 * when this build has no keyboard native module (see `lib/keyboardController.ts`).
 *
 * Deliberately takes NO `className`: NativeWind's interop runs on the literal
 * component in the JSX, so a class passed down to whichever scroller we
 * resolved would be silently dropped — the same failure that made the bottom
 * sheet render transparent. Callers style with `style` or wrap in a `View`.
 * The ref is typed as a `ScrollView` because that is the handle both branches
 * expose, and `scrollTo` is all any caller uses.
 */
export const KeyboardAwareScroll = forwardRef<ScrollView, Props>(
  function KeyboardAwareScroll({ children, bottomOffset, ...rest }, ref) {
    const keyboard = loadKeyboardController();

    if (keyboard) {
      const Scroller = keyboard.KeyboardAwareScrollView;
      return (
        <Scroller ref={ref} bottomOffset={bottomOffset} {...rest}>
          {children}
        </Scroller>
      );
    }

    return (
      <ScrollView ref={ref} {...rest}>
        {children}
      </ScrollView>
    );
  },
);
