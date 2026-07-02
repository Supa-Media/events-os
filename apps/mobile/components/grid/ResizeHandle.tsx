/**
 * ResizeHandle — a thin draggable strip used to resize a grid column (horizontal
 * axis) or row (vertical axis). Built on the same react-native-gesture-handler +
 * reanimated stack as SortableRows so it works on web (pointer) and native
 * (touch).
 *
 * The handle is "uncontrolled" during a drag: it reports a live `onPreview(size)`
 * on every move (the parent renders that for instant feedback) and a final
 * `onCommit(size)` on release (the parent persists it). `start` must be the
 * COMMITTED size — never the live preview — so the gesture's base size doesn't
 * shift mid-drag. `onActiveChange` lets the parent suspend a wrapping scroll view
 * while a drag is in flight (so a horizontal column drag isn't stolen by a
 * horizontal ScrollView).
 */
import { useMemo } from "react";
import { View, Platform } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { runOnJS, useSharedValue } from "react-native-reanimated";
import { colors } from "../../lib/theme";

type Props = {
  axis: "x" | "y";
  /** Committed size (px) the drag starts from. */
  start: number;
  min: number;
  max: number;
  /** Live size on every move — render it for instant feedback. */
  onPreview: (size: number) => void;
  /** Final size on release — persist it. */
  onCommit: (size: number) => void;
  /** Drag begin/end — use to pause a wrapping scroll view during the drag. */
  onActiveChange?: (active: boolean) => void;
};

/** Hit-area thickness (px) of the grab strip. */
const THICKNESS = 10;

export function ResizeHandle({
  axis,
  start,
  min,
  max,
  onPreview,
  onCommit,
  onActiveChange,
}: Props) {
  // Mirrors the latest previewed size on the UI thread so onEnd can commit it.
  const current = useSharedValue(start);
  // Base size captured at drag begin and FROZEN for the whole drag. `start` can
  // change mid-drag (an auto-height row re-measures as each preview renders),
  // and re-deriving the base from it while the translation keeps accumulating
  // compounds every move into a runaway resize.
  const base = useSharedValue(start);

  const pan = useMemo(() => {
    const clamp = (n: number) => (n < min ? min : n > max ? max : n);
    let g = Gesture.Pan();
    // Claim the axis early with a small threshold so a parent ScrollView on the
    // same axis doesn't win the gesture.
    g = axis === "x" ? g.activeOffsetX([-2, 2]) : g.activeOffsetY([-2, 2]);
    return g
      .onBegin(() => {
        base.value = start;
        current.value = start;
        if (onActiveChange) runOnJS(onActiveChange)(true);
      })
      .onUpdate((e) => {
        const delta = axis === "x" ? e.translationX : e.translationY;
        const next = clamp(base.value + delta);
        current.value = next;
        runOnJS(onPreview)(next);
      })
      .onEnd(() => {
        runOnJS(onCommit)(current.value);
      })
      .onFinalize(() => {
        if (onActiveChange) runOnJS(onActiveChange)(false);
      });
  }, [axis, start, min, max, onPreview, onCommit, onActiveChange, current, base]);

  // Absolutely positioned just inside the cell's trailing edge (not straddling
  // it) so it neither overlaps the neighbouring cell nor gets clipped by a row's
  // overflow-hidden. On web we add the matching resize cursor.
  const positional =
    axis === "x"
      ? { top: 0, bottom: 0, right: 0, width: THICKNESS }
      : { left: 0, right: 0, bottom: 0, height: THICKNESS };

  // Bare cursor utilities (matches the existing `cursor-grab` usage); they're
  // no-ops on native.
  const cursorClass =
    Platform.OS === "web"
      ? axis === "x"
        ? "cursor-col-resize"
        : "cursor-row-resize"
      : "";

  return (
    <GestureDetector gesture={pan}>
      <View
        style={{ position: "absolute", zIndex: 40, ...positional }}
        // On web the whole strip is invisible until hovered; on native the faint
        // guide line shows always (a resize affordance / column separator).
        className={`items-center justify-center web:opacity-0 web:hover:opacity-100 ${cursorClass}`}
        hitSlop={4}
      >
        {/* The thin accent guide line. */}
        <View
          style={
            axis === "x"
              ? { width: 2, alignSelf: "stretch", backgroundColor: colors.accent }
              : { height: 2, alignSelf: "stretch", backgroundColor: colors.accent }
          }
        />
      </View>
    </GestureDetector>
  );
}
