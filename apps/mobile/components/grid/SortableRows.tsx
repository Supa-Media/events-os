/**
 * SortableRows — a vertical drag-to-reorder list that works on BOTH
 * react-native-web (mouse / pointer) and native iOS/Android (touch).
 *
 * Built on react-native-gesture-handler's modern `Gesture.Pan()` plus
 * react-native-reanimated shared values. Drag is initiated only from the grip
 * handle that `renderRow` wires up via the `drag` gesture it receives, so a
 * parent horizontal ScrollView keeps working everywhere else on the row.
 *
 * The component owns ONLY vertical reordering. Each row is expected to be
 * fixed-width content that the parent has already placed inside a horizontal
 * ScrollView, so we never touch horizontal layout.
 *
 * Variable row heights are supported: we measure each row's height onLayout and
 * drive displacement from cumulative offsets, so rows with tall (wrapped) cells
 * reorder correctly.
 *
 * The drop arithmetic — and the SCALE the list may be drawn at — lives in
 * `sortableRowMath.ts`, which is pure and therefore testable; see its header
 * for why a gesture and a layout are not measured in the same unit.
 */
import { useCallback, useMemo } from "react";
import { View, type LayoutChangeEvent } from "react-native";
import {
  Gesture,
  GestureDetector,
  type GestureType,
} from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import {
  DEFAULT_ROW_HEIGHT,
  contentTranslationY,
  dropOrder,
  safeScale,
} from "./sortableRowMath";

/** Props passed to each row's render function. */
export interface SortableRowRenderArgs {
  /** The row's id. */
  id: string;
  /** Index of the row in the current `ids` order. */
  index: number;
  /**
   * The pan gesture that initiates the drag for THIS row. Attach it to the grip
   * handle via `<GestureDetector gesture={drag}>…</GestureDetector>` so dragging
   * only starts from the handle and the rest of the row stays interactive.
   */
  drag: GestureType;
  /** True while this row is the one being dragged. */
  isActive: SharedValue<boolean>;
}

export interface SortableRowsProps {
  /** Ordered list of row ids; order defines render order. */
  ids: string[];
  /** Render one row. Wire `args.drag` to the grip handle. */
  renderRow: (args: SortableRowRenderArgs) => React.ReactNode;
  /** Called on drop with the new id order (only when the order changed). */
  onReorder: (orderedIds: string[]) => void;
  /**
   * Optional fixed row height (px). When provided it seeds the layout math
   * before measurement; rows are still measured for accuracy.
   */
  rowHeight?: number;
  /**
   * The scale the PARENT draws this list at (a `transform: [{ scale }]` above
   * it), default 1.
   *
   * A transform doesn't change layout, so measured row heights stay in the
   * list's own px while the pan gesture reports screen px. Telling the list
   * its scale is what keeps the dragged row under the finger and the drop
   * index on the row you let go over — see `sortableRowMath.ts`. The email
   * canvas draws its 600px document at ~0.6 on a phone; every other caller
   * leaves this alone.
   */
  scale?: number;
}

export function SortableRows({
  ids,
  renderRow,
  onReorder,
  rowHeight = DEFAULT_ROW_HEIGHT,
  scale,
}: SortableRowsProps) {
  // Measured per-row heights, keyed by id, on the JS thread. A shared value
  // mirror lets worklets read offsets without bridging.
  const heightsRef = useMemo(() => ({ current: {} as Record<string, number> }), []);

  // The id currently being dragged (-1 / null when idle). Shared so row
  // worklets can react to it.
  const activeId = useSharedValue<string | null>(null);
  // Live vertical translation of the dragged row.
  const translateY = useSharedValue(0);

  const heightsArrayFor = useCallback(
    (order: string[]) =>
      order.map((id) => heightsRef.current[id] ?? rowHeight),
    [heightsRef, rowHeight],
  );

  /** `screenTranslation` is the gesture's own, in screen px — converted here
   *  into the units the measured heights are in. */
  const commitReorder = useCallback(
    (id: string, screenTranslation: number) => {
      const next = dropOrder(
        ids,
        id,
        contentTranslationY(screenTranslation, scale),
        heightsArrayFor(ids),
      );
      if (next) onReorder(next);
    },
    [ids, heightsArrayFor, onReorder, scale],
  );

  return (
    <View>
      {ids.map((id, index) => (
        <SortableRow
          key={id}
          id={id}
          index={index}
          activeId={activeId}
          translateY={translateY}
          scale={safeScale(scale)}
          onMeasure={(h) => {
            heightsRef.current[id] = h;
          }}
          onDrop={commitReorder}
          renderRow={renderRow}
        />
      ))}
    </View>
  );
}

interface SortableRowProps {
  id: string;
  index: number;
  activeId: SharedValue<string | null>;
  translateY: SharedValue<number>;
  /** Already sanitized by `safeScale` — never 0, negative or NaN. */
  scale: number;
  onMeasure: (height: number) => void;
  onDrop: (id: string, translation: number) => void;
  renderRow: (args: SortableRowRenderArgs) => React.ReactNode;
}

function SortableRow({
  id,
  index,
  activeId,
  translateY,
  scale,
  onMeasure,
  onDrop,
  renderRow,
}: SortableRowProps) {
  // Per-row "is this the active drag target" flag for the renderRow consumer.
  const isActive = useSharedValue(false);

  const pan = useMemo(
    () =>
      Gesture.Pan()
        // activeOffsetY makes the gesture claim the drag vertically while
        // letting a parent horizontal ScrollView keep horizontal pans.
        .activeOffsetY([-6, 6])
        .onStart(() => {
          activeId.value = id;
          isActive.value = true;
          translateY.value = 0;
        })
        // The gesture reports SCREEN px; this row is displaced inside a parent
        // that may scale it, so the translation it is given has to be divided
        // by that scale for the row to stay under the finger. (The worklet
        // twin of `contentTranslationY` — a plain module function can't be
        // called from a worklet. The drop itself goes through the real one,
        // in `commitReorder`.)
        .onUpdate((e) => {
          translateY.value = e.translationY / scale;
        })
        .onEnd((e) => {
          runOnJS(onDrop)(id, e.translationY);
        })
        .onFinalize(() => {
          activeId.value = null;
          isActive.value = false;
          translateY.value = withTiming(0, { duration: 120 });
        }),
    [id, activeId, isActive, translateY, scale, onDrop],
  );

  const animatedStyle = useAnimatedStyle(() => {
    const dragging = activeId.value === id;
    return {
      transform: [{ translateY: dragging ? translateY.value : 0 }],
      zIndex: dragging ? 10 : 0,
      // Subtle lift on the row being dragged.
      opacity: dragging ? 0.95 : 1,
      elevation: dragging ? 6 : 0,
    };
  });

  const handleLayout = useCallback(
    (e: LayoutChangeEvent) => onMeasure(e.nativeEvent.layout.height),
    [onMeasure],
  );

  return (
    <Animated.View onLayout={handleLayout} style={animatedStyle}>
      {renderRow({ id, index, drag: pan, isActive })}
    </Animated.View>
  );
}
