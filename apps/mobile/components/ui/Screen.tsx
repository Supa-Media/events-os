import { ComponentRef, ReactNode, Ref } from "react";
import { View, ActivityIndicator } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { colors } from "../../lib/theme";
import { useIsPhone } from "../../lib/breakpoints";
import { useMobileChrome } from "./MobileChrome";

type Props = {
  children?: ReactNode;
  /** Show a centered spinner instead of children. */
  loading?: boolean;
  /** Constrain the content to a centered work-app column. */
  maxWidth?: number;
  /**
   * Handle on the scroller, for a page that needs to jump to one of its own
   * sections — today `/project/[id]?section=money`, the deep link a budget
   * card uses to land on a project's money rather than the top of its page.
   *
   * Deliberately a ref rather than a `scrollToSection` prop: the scroller
   * belongs to this component, but WHICH offset to scroll to is something only
   * the page knows (it measures its own section with `onLayout`). Handing over
   * the handle keeps that knowledge where it lives instead of teaching
   * `Screen` about sections.
   */
  scrollRef?: Ref<ComponentRef<typeof KeyboardAwareScrollView>>;
};

/**
 * Width a page passes to <Screen> when it wants its database/grid tables to fill
 * the window (Notion-style — the table starts at the content's left edge and can
 * scroll into the empty space). The page wraps its reading sections in <Narrow>
 * so only the grids span the full width.
 */
export const FULL_WIDTH = 4000;

/** Comfortable reading column width used by <Narrow>. */
export const NARROW_WIDTH = 1180;

/** Caps its children at a comfortable reading width, left-aligned. */
export function Narrow({
  children,
  width = NARROW_WIDTH,
}: {
  children: ReactNode;
  width?: number;
}) {
  return <View style={{ width: "100%", maxWidth: width }}>{children}</View>;
}

/**
 * Page content wrapper used inside the app shell. Scrolls vertically and centers
 * a comfortable max-width column on wide screens (the shell already owns the
 * cream background + sidebar). Padding is generous and consistent.
 *
 * On a phone it also reserves room for the shell's FLOATING chrome — the top
 * buttons and the bottom dock hover over the page rather than boxing it in, so
 * the page has to start below one and end above the other while still
 * scrolling underneath both. Those numbers come from `useMobileChrome`, which
 * the shell fills in; outside the shell (login, onboarding, the public
 * share/pay routes) it reads zero and the page just pads itself normally.
 */
export function Screen({
  children,
  loading = false,
  maxWidth = 1080,
  scrollRef,
}: Props) {
  const phone = useIsPhone();
  const chrome = useMobileChrome();

  if (loading) {
    return (
      <View
        style={{ paddingTop: chrome.top, paddingBottom: chrome.bottom }}
        className="flex-1 items-center justify-center bg-surface"
      >
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <View className="flex-1 bg-surface">
      <KeyboardAwareScrollView
        ref={scrollRef}
        contentContainerStyle={{ flexGrow: 1, alignItems: "center" }}
        keyboardShouldPersistTaps="handled"
        bottomOffset={24}
        showsVerticalScrollIndicator={false}
      >
        <View
          style={{
            width: "100%",
            maxWidth,
            // `chrome.*` already carries the safe-area inset, so on a phone
            // inside the shell this IS the page's whole vertical padding, not
            // an addition to it. Outside the shell there is no chrome to clear
            // and the page falls back to plain phone padding.
            paddingTop: phone ? (chrome.top || 0) + PHONE_PAD_TOP : 0,
            paddingBottom: phone ? (chrome.bottom || 0) + PHONE_PAD_BOTTOM : 0,
          }}
          className={phone ? "px-4" : "px-6 py-7 sm:px-8 sm:py-8"}
        >
          {children}
        </View>
      </KeyboardAwareScrollView>
    </View>
  );
}

/** Breathing room between the floating top chrome and the page's own title. */
const PHONE_PAD_TOP = 16;
/** Trailing room so the last row doesn't stop flush against the dock. */
const PHONE_PAD_BOTTOM = 16;
