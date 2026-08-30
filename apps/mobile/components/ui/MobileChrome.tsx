import {
  ReactNode,
  createContext,
  useContext,
  useMemo,
} from "react";
import { Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BottomSheet, SheetGroup, SheetRow, SheetSectionLabel } from "./BottomSheet";
import { Icon, type IconName } from "./Icon";
import { colors } from "../../lib/theme";
import { DOCK_SLOTS } from "../../lib/mobileNav";

/**
 * The phone's navigation chrome: a pair of floating buttons at the top and a
 * floating dock at the bottom, with the full destination list behind a sheet.
 *
 * Everything here is PRESENTATIONAL — it takes destinations and callbacks and
 * renders them. `AppShell` is where the seat/tier queries decide what the
 * caller may see. Keeping that split means the chrome can be rendered in a
 * screenshot harness or a test with fixture data, and it keeps the layout math
 * (which is the fiddly part) away from the access rules (which are the
 * important part).
 *
 * The design target is the phone-native shape the app was missing: chrome that
 * floats over the page instead of boxing it in, so a small screen spends its
 * vertical budget on content. The old mobile shell had a solid 48px title bar
 * on top and a solid tab bar below it that rendered EVERY visible destination
 * side by side — for an admin that was twelve tabs sharing a phone's width,
 * about 32px each, with 11px labels underneath. That is the thing this
 * replaces: four destinations plus a "More" that opens the rest as a readable
 * list.
 */

// ── Layout constants ────────────────────────────────────────────────────────
/** Side of the square floating buttons in the top chrome. */
const TOP_BUTTON = 38;
/** Gap between the top chrome and the safe-area top edge. */
const TOP_GAP = 6;
/** Height of the floating dock capsule. */
const DOCK_HEIGHT = 54;
/** Gap between the dock and the safe-area bottom edge. */
const DOCK_GAP = 10;
// ── Content insets ──────────────────────────────────────────────────────────
/**
 * How much room the floating chrome occupies at each edge, so page content can
 * start below the top buttons and end above the dock.
 *
 * `Screen` reads this and pads itself. Defaulting to zeros means the same
 * `Screen` renders correctly OUTSIDE the shell too (the login and onboarding
 * screens, the public share/pay routes) — those have no chrome to clear, and
 * padding them for a dock that isn't there would leave a dead band at the
 * bottom of every signed-out page.
 */
export type ChromeInsets = { top: number; bottom: number };

const MobileChromeContext = createContext<ChromeInsets>({ top: 0, bottom: 0 });

/**
 * Takes the two numbers rather than an object so the memo below has primitive
 * dependencies — an object rebuilt on every shell render would hand a new
 * context value to every `Screen` in the app on every render.
 */
export function MobileChromeProvider({
  top,
  bottom,
  children,
}: {
  top: number;
  bottom: number;
  children: ReactNode;
}) {
  const value = useMemo(() => ({ top, bottom }), [top, bottom]);
  return (
    <MobileChromeContext.Provider value={value}>
      {children}
    </MobileChromeContext.Provider>
  );
}

/** Padding a scrolling page needs to clear the floating chrome. Zeros outside the shell. */
export function useMobileChrome(): ChromeInsets {
  return useContext(MobileChromeContext);
}

/**
 * The insets the chrome will occupy for the current safe area. Computed by the
 * shell (which knows the safe area) and handed to both the provider and the
 * chrome itself, so the padding a page reserves and the space the chrome takes
 * can never drift apart.
 */
export function chromeInsets(safeTop: number, safeBottom: number): ChromeInsets {
  return {
    top: safeTop + TOP_GAP + TOP_BUTTON + TOP_GAP,
    bottom: safeBottom + DOCK_GAP + DOCK_HEIGHT + DOCK_GAP,
  };
}

// ── Top chrome ──────────────────────────────────────────────────────────────
/**
 * The floating top row: a menu button on the left, caller-supplied controls on
 * the right. Absolutely positioned so page content scrolls underneath it
 * rather than being pushed down by a bar.
 *
 * `pointerEvents="box-none"` on the row is what makes that safe: the row spans
 * the full width, but only the buttons themselves take touches, so the empty
 * middle stays scrollable.
 */
export function FloatingTopBar({
  onOpenNav,
  right,
}: {
  onOpenNav: () => void;
  right?: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View
      pointerEvents="box-none"
      style={{ paddingTop: insets.top + TOP_GAP }}
      className="absolute inset-x-0 top-0 z-40 flex-row items-center px-3"
    >
      <ChromeButton
        icon="sidebar"
        label="Open navigation"
        onPress={onOpenNav}
      />
      <View pointerEvents="none" className="flex-1" />
      {right}
    </View>
  );
}

/** A single floating square button — the top chrome's unit of chrome. */
export function ChromeButton({
  icon,
  label,
  onPress,
  tint,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  tint?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={8}
      onPress={onPress}
      style={{ width: TOP_BUTTON, height: TOP_BUTTON }}
      className="items-center justify-center rounded-md bg-raised shadow-dock active:bg-sunken web:hover:bg-sunken"
    >
      <Icon name={icon} size={19} color={tint ?? colors.ink} />
    </Pressable>
  );
}

/**
 * A floating capsule on the right of the top chrome holding one or more
 * controls — the desk switcher and the account button. Grouped into one pill
 * (rather than separate buttons) so the top-right reads as a single object.
 */
export function ChromePill({ children }: { children: ReactNode }) {
  return (
    <View
      style={{ minHeight: TOP_BUTTON }}
      className="flex-row items-center gap-0.5 rounded-pill bg-raised px-1 shadow-dock"
    >
      {children}
    </View>
  );
}

/** An icon button sized to sit inside a {@link ChromePill}. */
export function ChromePillButton({
  icon,
  label,
  onPress,
  tint,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  tint?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      onPress={onPress}
      className="h-8 w-8 items-center justify-center rounded-pill active:bg-sunken web:hover:bg-sunken"
    >
      <Icon name={icon} size={18} color={tint ?? colors.ink} />
    </Pressable>
  );
}

// ── Dock ────────────────────────────────────────────────────────────────────
export type DockItem = {
  label: string;
  icon: IconName;
  path: string;
  active: boolean;
};

/**
 * The floating bottom dock: up to {@link DOCK_SLOTS} destinations plus a
 * "More" button, in a centered capsule that hovers above the home indicator.
 *
 * Destinations are icon-only EXCEPT the active one, which expands to show its
 * label. That keeps the dock quiet (the Obsidian shape — a row of glyphs, no
 * text) while still answering "where am I?" without making the user count
 * icons. Every button keeps a full accessibility label regardless.
 */
export function MobileDock({
  items,
  onNavigate,
  onOpenMore,
}: {
  items: DockItem[];
  onNavigate: (path: string) => void;
  onOpenMore: () => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View
      pointerEvents="box-none"
      style={{ paddingBottom: insets.bottom + DOCK_GAP }}
      className="absolute inset-x-0 bottom-0 z-40 items-center"
    >
      <View
        accessibilityRole="tablist"
        style={{ height: DOCK_HEIGHT }}
        className="max-w-full flex-row items-center rounded-pill bg-raised px-1.5 shadow-dock"
      >
        {items.map((item) => (
          <DockButton
            key={item.path}
            item={item}
            onPress={() => onNavigate(item.path)}
          />
        ))}
        <DockButton
          item={{ label: "More", icon: "more-horizontal", path: "", active: false }}
          onPress={onOpenMore}
        />
      </View>
    </View>
  );
}

function DockButton({ item, onPress }: { item: DockItem; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityLabel={item.label}
      accessibilityState={{ selected: item.active }}
      onPress={onPress}
      className={`h-11 flex-row items-center justify-center gap-1.5 rounded-pill ${
        item.active ? "bg-accent-soft px-3" : "w-12 active:bg-sunken web:hover:bg-sunken"
      }`}
    >
      <Icon
        name={item.icon}
        size={21}
        color={item.active ? colors.accent : colors.muted}
      />
      {item.active ? (
        <Text
          numberOfLines={1}
          className="max-w-[92px] text-sm font-semibold text-accent"
        >
          {item.label}
        </Text>
      ) : null}
    </Pressable>
  );
}

// ── Navigation sheet ────────────────────────────────────────────────────────
export type NavSheetGroup = { label?: string; items: DockItem[] };

/**
 * Every destination, as a sheet. This is where the twelve-tab problem actually
 * gets solved: a list can be as long as the caller's access makes it and stays
 * readable, where a tab bar cannot.
 *
 * `groups` arrive pre-bucketed (the shell groups them by PARA, the same
 * grouping the desktop sidebar uses and the Academy teaches) so the two
 * navigations describe the app the same way. `footer` carries the account
 * rows, which are destinations of a different kind and get their own card.
 */
export function NavSheet({
  visible,
  onClose,
  groups,
  onNavigate,
  header,
  footer,
}: {
  visible: boolean;
  onClose: () => void;
  groups: NavSheetGroup[];
  onNavigate: (path: string) => void;
  header?: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <BottomSheet visible={visible} onClose={onClose}>
      {header}
      {groups.map((group, gi) => (
        <View key={group.label ?? gi}>
          {group.label ? <SheetSectionLabel label={group.label} /> : null}
          <SheetGroup>
            {group.items.map((item, i) => (
              <SheetRow
                key={item.path}
                label={item.label}
                icon={item.icon}
                active={item.active}
                first={i === 0}
                onPress={() => {
                  onClose();
                  onNavigate(item.path);
                }}
              />
            ))}
          </SheetGroup>
        </View>
      ))}
      {footer}
    </BottomSheet>
  );
}
