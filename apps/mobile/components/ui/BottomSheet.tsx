import { ReactNode, useEffect, useRef } from "react";
import {
  Animated,
  Easing,
  Modal,
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon, type IconName } from "./Icon";
import { colors, radius } from "../../lib/theme";

/**
 * The phone menu surface — a sheet that rises from the bottom edge, dimming the
 * page behind it.
 *
 * This is the mobile counterpart to {@link Popover}, and the reason it exists:
 * an anchored dropdown is a pointer idiom. It assumes a cursor small enough to
 * aim at a 28px row and a window big enough that a panel can hang off its
 * trigger without covering the thing you were looking at. On a phone neither
 * holds — the panel lands under your thumb, its rows are below the 44pt touch
 * minimum, and it flips above or below the trigger depending on where you
 * happened to scroll. A sheet is the phone answer: it always arrives from the
 * same edge, always within thumb reach, and its rows can be as tall as a finger
 * needs. `Popover` routes itself here automatically below the desktop
 * breakpoint, so most callers get this without knowing it exists.
 *
 * Composition mirrors an inset-grouped list: one or more {@link SheetGroup}
 * cards, each holding {@link SheetRow}s, floating on the sheet's sunken ground.
 * Groups are how the sheet says "these belong together" without needing a
 * header for every cluster.
 */

/** How far the sheet may grow before its content starts scrolling instead. */
const MAX_HEIGHT_FRACTION = 0.86;

export function BottomSheet({
  visible,
  onClose,
  children,
  /** Optional title rendered above the first group. */
  title,
}: {
  visible: boolean;
  onClose: () => void;
  children: ReactNode;
  title?: string;
}) {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();

  // Slide + fade in. `useNativeDriver` is off because react-native-web has no
  // native driver; the sheet is a single transform on a small tree, so the JS
  // driver is fine here and keeps one code path across platforms.
  const progress = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!visible) {
      progress.setValue(0);
      return;
    }
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration: 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    });
    animation.start();
    return () => animation.stop();
  }, [visible, progress]);

  if (!visible) return null;

  const translateY = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [420, 0],
  });

  return (
    <Modal visible transparent animationType="none" onRequestClose={onClose}>
      <View className="flex-1 justify-end">
        {/* Scrim. Pressing anywhere off the sheet dismisses it — the phone
            equivalent of clicking outside a dropdown.

            Colors and radii here are inline `style`, not NativeWind classes:
            NativeWind only interops the components it wraps, and `Animated.View`
            is not one of them — a `className` on it is silently dropped, which
            renders the sheet as transparent rows floating over an undimmed
            page. Anything animated in this file styles itself from `colors`
            and `radius` (the same tokens the classes compile from) instead. */}
        <Animated.View
          style={{
            position: "absolute",
            top: 0,
            right: 0,
            bottom: 0,
            left: 0,
            opacity: progress,
            backgroundColor: colors.scrim,
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close menu"
            onPress={onClose}
            className="flex-1"
          />
        </Animated.View>

        <Animated.View
          style={{
            transform: [{ translateY }],
            maxHeight: height * MAX_HEIGHT_FRACTION,
            paddingBottom: insets.bottom + 12,
            paddingTop: 10,
            backgroundColor: colors.sunken,
            borderTopLeftRadius: radius.xl,
            borderTopRightRadius: radius.xl,
          }}
        >
          <Grabber />
          {title ? (
            <Text className="px-6 pb-1 pt-1.5 font-display text-lg text-ink">
              {title}
            </Text>
          ) : null}
          <ScrollView
            className="grow-0"
            contentContainerStyle={{ paddingTop: 8, paddingBottom: 4 }}
            showsVerticalScrollIndicator={false}
          >
            {children}
          </ScrollView>
        </Animated.View>
      </View>
    </Modal>
  );
}

/** The drag handle. Decorative — the sheet is dismissed by the scrim or a row. */
function Grabber() {
  return (
    <View className="items-center pb-1">
      <View className="h-1 w-9 rounded-pill bg-border-strong" />
    </View>
  );
}

/**
 * One inset card of rows. Rows inside a group are separated by a hairline that
 * starts at the label (not the card edge), so the icon column reads as a
 * continuous gutter rather than a stack of boxes.
 */
export function SheetGroup({ children }: { children: ReactNode }) {
  return (
    <View className="mx-3 mb-2.5 overflow-hidden rounded-lg bg-raised">
      {children}
    </View>
  );
}

/** A quiet caps label above a group, for sheets with more than one cluster. */
export function SheetSectionLabel({ label }: { label: string }) {
  return (
    <Text className="px-6 pb-1.5 pt-1 text-2xs font-bold uppercase tracking-wider text-faint">
      {label}
    </Text>
  );
}

/**
 * A single row. `first` suppresses the leading separator — the caller passes it
 * because only the caller knows the row's position in its group.
 *
 * With no `onPress` the row is a STATEMENT, not a control: it renders as plain
 * text with no press affordance. Some rows in a sheet are facts rather than
 * destinations — which chapter you're at, for a caller who has only one — and
 * a row that highlights under a finger but does nothing is worse than a label.
 */
export function SheetRow({
  label,
  sublabel,
  icon,
  onPress,
  active = false,
  destructive = false,
  first = false,
  trailing,
}: {
  label: string;
  sublabel?: string;
  icon?: IconName;
  /** Omit for a non-interactive informational row. */
  onPress?: () => void;
  active?: boolean;
  destructive?: boolean;
  first?: boolean;
  trailing?: ReactNode;
}) {
  const tint = destructive ? colors.danger : active ? colors.accent : colors.ink;
  const iconTint = destructive
    ? colors.danger
    : active
      ? colors.accent
      : colors.muted;
  // NativeWind interops on the LITERAL component in the JSX, so the two cases
  // are written out rather than switched through a `const Row = onPress ?
  // Pressable : View` — a dynamic component reference gets no className, the
  // same silent-drop this file's `Animated.View` comment describes.
  const padding = `${sublabel ? "py-2.5" : "py-3"} ${first ? "" : "border-t border-border"}`;

  const body = (
    <>
      {icon ? (
        <View className="w-5 items-center">
          <Icon name={icon} size={17} color={iconTint} />
        </View>
      ) : null}
      <View className="flex-1">
        <Text
          numberOfLines={1}
          className={`text-base ${active ? "font-semibold" : ""}`}
          style={{ color: tint }}
        >
          {label}
        </Text>
        {sublabel ? (
          <Text numberOfLines={1} className="text-xs text-muted">
            {sublabel}
          </Text>
        ) : null}
      </View>
      {trailing ??
        (active ? <Icon name="check" size={16} color={colors.accent} /> : null)}
    </>
  );

  if (!onPress) {
    return (
      <View
        accessible
        accessibilityRole="text"
        className={`flex-row items-center gap-3.5 px-4 ${padding}`}
      >
        {body}
      </View>
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      onPress={onPress}
      className={`flex-row items-center gap-3.5 px-4 active:bg-sunken web:hover:bg-sunken ${padding}`}
    >
      {body}
    </Pressable>
  );
}
