import { useEffect, type ReactNode } from "react";
import { Pressable, ScrollView, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { Icon } from "../ui";
import { colors } from "../../lib/theme";

/** Slide duration — quick enough to feel responsive, slow enough to read as
 *  motion rather than a snap. */
const DURATION = 220;

/**
 * The seat detail overlay: slides `children` (the unmodified `SeatDetailPanel`
 * — see `org-chart.tsx`) in from the right OVER the canvas, absolutely
 * positioned so the canvas stays visible (and pannable) around and behind it.
 * Dismissible via the "×" here, or the canvas's own background-press (which
 * the screen wires to the same `onClose`).
 *
 * Keeps rendering its last `children` while sliding CLOSED (the caller only
 * flips `open` to false — it doesn't unmount `children` immediately) so the
 * panel doesn't flash empty mid-animation; the caller is free to swap
 * `children` for `null`-safe content once `open` goes false since nothing is
 * visible by the time that matters.
 */
export function SeatOverlayPanel({
  open,
  width,
  onClose,
  children,
}: {
  open: boolean;
  /** Panel width in px (the caller clamps this to the window width on
   *  narrow screens so it reads as a near-full-width drawer on phones). */
  width: number;
  onClose: () => void;
  children: ReactNode;
}) {
  const progress = useSharedValue(open ? 1 : 0);
  // Animate as a side effect (never assign a shared value's `.value` directly
  // in the render body — Reanimated's strict mode warns, and it can race with
  // React's own render pass).
  useEffect(() => {
    progress.value = withTiming(open ? 1 : 0, { duration: DURATION });
  }, [open, progress]);

  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: (1 - progress.value) * width }],
  }));

  return (
    <Animated.View
      pointerEvents={open ? "auto" : "none"}
      style={[
        {
          position: "absolute",
          top: 0,
          right: 0,
          bottom: 0,
          width,
          backgroundColor: colors.surface,
          borderLeftWidth: 1,
          borderLeftColor: colors.border,
          shadowColor: "#000",
          shadowOpacity: 0.15,
          shadowRadius: 20,
          shadowOffset: { width: -6, height: 0 },
          elevation: 10,
        },
        style,
      ]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close seat details"
        onPress={onClose}
        hitSlop={8}
        style={{ cursor: "pointer" } as any}
        className="absolute right-3 top-3 z-10 h-8 w-8 items-center justify-center rounded-pill bg-raised shadow-card active:bg-sunken web:hover:bg-sunken"
      >
        <Icon name="x" size={16} color={colors.muted} />
      </Pressable>
      <ScrollView showsVerticalScrollIndicator={false}>
        <View className="p-4 pt-14">{children}</View>
      </ScrollView>
    </Animated.View>
  );
}
