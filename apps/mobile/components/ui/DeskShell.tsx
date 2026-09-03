import { ReactNode } from "react";
import { ScrollView, View } from "react-native";
import { Pill } from "./Pill";
import { MobileChromeProvider, useMobileChrome } from "./MobileChrome";
import { useIsPhone } from "../../lib/breakpoints";

/**
 * A DESK's persistent sub-navigation — the horizontal pill row that
 * `finances/`, `giving/`, `marketing/` and `campaigns/` `_layout.tsx` each
 * render above their own `<Slot />`, and the ONE place all four now clear the
 * shell's floating top chrome.
 *
 * ## The bug this fixes
 *
 * Every one of the four desk layouts used to build this tab row by hand —
 * `<View className="border-b ..."><ScrollView horizontal>...</ScrollView></View>`
 * — as the FIRST thing in the route, with no idea `AppShell`'s phone shell
 * even exists. On a phone that meant the tab row rendered at the screen's
 * true (0,0) origin: under the OS status bar / notch, and under wherever
 * `FloatingTopBar` (the ☰ button and the account/chapter pill,
 * `MobileChrome.tsx`) floats — which DOES clear the safe area, so it painted
 * on top of the tab row's leftmost and rightmost pills rather than beside
 * them. The tabs a caller most needed (Dashboard, the first couple of desk
 * tabs) were the ones sitting exactly where the notch — and anything the OS
 * itself overlays there, like an active call or Live Activity bubble — ate
 * them. Founder report, 2026-09-02, three screenshots: Finance, Giving and
 * Marketing all showing the same cut-off header, "the header is not even
 * accessible."
 *
 * It compounded with a second, opposite bug directly beneath it: every
 * screen inside these desks renders `<Screen>` (`Screen.tsx`), which pads
 * itself by the FULL floating-chrome clearance (`useMobileChrome().top`) —
 * correct for a screen with nothing else above it, but this was the second
 * screen-shaped thing in the same column. The chrome clearance was being
 * reserved once (invisibly, inside `Screen`, well past the tab row) and
 * consumed nowhere at the top (the tab row itself), which is why the
 * screenshots also show a large dead gap between the (misplaced) header and
 * the page's actual first row of content.
 *
 * ## The fix, once
 *
 * `DeskShell` is the ONE place all four desks now get: it reads
 * `useMobileChrome()` itself and pads its own root by `chrome.top` — so the
 * tab row (and any extra chrome a desk hangs below it, like Finance's
 * sandbox banner or its `ScopeBadge`) starts BELOW the floating buttons and
 * the notch, never under either. Having consumed that clearance once, it
 * RE-PROVIDES the chrome context to its own `children` (the desk's
 * `<Slot />`) with `top: 0` — `bottom` unchanged, since the floating dock at
 * the screen's bottom edge is still there and still needs clearing — so the
 * `<Screen>` a routed page renders next no longer double-pays for the same
 * clearance. One inset, reserved exactly once, by the one component that
 * knows it needs reserving.
 *
 * A fifth desk copying the old hand-rolled pattern would silently reintroduce
 * this bug; there is no reason to hand-roll it when this exists.
 */
export function DeskShell({
  tabs,
  isActive,
  onNavigate,
  /** Extra chrome between the tab row and the routed content — Finance's
   *  sandbox-mode banner (rendered here, ABOVE the tabs, same as before) and
   *  its `ScopeBadge` (rendered here, BELOW the tabs) both pass through this
   *  rather than each growing their own safe-area handling. */
  beforeTabs,
  afterTabs,
  children,
}: {
  tabs: { label: string; path: string }[];
  /** Whether TAB `path` is the currently active one — pre-bound to the
   *  route's pathname by the caller, so this component stays ignorant of
   *  `usePathname`/satellite-route rules each desk defines its own way. */
  isActive: (path: string) => boolean;
  onNavigate: (path: string) => void;
  beforeTabs?: ReactNode;
  afterTabs?: ReactNode;
  /** The desk's own `<Slot />`. */
  children: ReactNode;
}) {
  const phone = useIsPhone();
  const chrome = useMobileChrome();

  return (
    <View
      className="flex-1"
      // Zero outside the phone shell (desktop's `AppShell` branch never
      // mounts `MobileChromeProvider`, so `chrome.top` already reads 0
      // there) — matches `Screen`'s own `phone ?` gate, so this never adds
      // padding a desktop reader would have to explain.
      style={phone ? { paddingTop: chrome.top } : undefined}
    >
      {beforeTabs}
      <View className="border-b border-border bg-raised px-4 py-2.5">
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 8 }}
        >
          {tabs.map((t) => (
            <Pill
              key={t.path}
              label={t.label}
              selected={isActive(t.path)}
              onPress={() => onNavigate(t.path)}
            />
          ))}
        </ScrollView>
      </View>
      {afterTabs}
      {/* Consumed above, so the routed screen's own `<Screen>` must not pay
       *  for the top clearance a second time. `bottom` passes through
       *  unchanged — nothing in this desk header claims the dock's space. */}
      <MobileChromeProvider top={0} bottom={chrome.bottom}>
        <View className="flex-1">{children}</View>
      </MobileChromeProvider>
    </View>
  );
}
