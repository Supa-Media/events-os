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
}

/** Default row-height seed used until a row reports its real height. */
const DEFAULT_ROW_HEIGHT = 44;

/**
 * Compute the index a dragged row should land at, given its top edge after the
 * drag translation, using measured cumulative offsets.
 *
 * Runs on the JS thread (called via runOnJS) so it can read the heights array.
 */
function resolveTargetIndex(
  from: number,
  translationY: number,
  heights: number[],
): number {
  const count = heights.length;
  // Cumulative top offset of each row in the *original* layout.
  const tops: number[] = [];
  let acc = 0;
  for (let i = 0; i < count; i++) {
    tops.push(acc);
    acc += heights[i] || DEFAULT_ROW_HEIGHT;
  }
  // Center of the dragged row after translation.
  const draggedCenter =
    tops[from] + (heights[from] || DEFAULT_ROW_HEIGHT) / 2 + translationY;

  let target = from;
  for (let i = 0; i < count; i++) {
    const center = tops[i] + (heights[i] || DEFAULT_ROW_HEIGHT) / 2;
    if (draggedCenter < center) {
      target = i;
      break;
    }
    target = i;
  }
  return Math.max(0, Math.min(count - 1, target));
}

export function SortableRows({
  ids,
  renderRow,
  onReorder,
  rowHeight = DEFAULT_ROW_HEIGHT,
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

  const commitReorder = useCallback(
    (id: string, translation: number) => {
      const from = ids.indexOf(id);
      if (from < 0) return;
      const heights = heightsArrayFor(ids);
      const to = resolveTargetIndex(from, translation, heights);
      if (to === from) return;
      const next = ids.slice();
      next.splice(to, 0, next.splice(from, 1)[0]);
      onReorder(next);
    },
    [ids, heightsArrayFor, onReorder],
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
  onMeasure: (height: number) => void;
  onDrop: (id: string, translation: number) => void;
  renderRow: (args: SortableRowRenderArgs) => React.ReactNode;
}

function SortableRow({
  id,
  index,
  activeId,
  translateY,
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
        .onUpdate((e) => {
          translateY.value = e.translationY;
        })
        .onEnd((e) => {
          runOnJS(onDrop)(id, e.translationY);
        })
        .onFinalize(() => {
          activeId.value = null;
          isActive.value = false;
          translateY.value = withTiming(0, { duration: 120 });
        }),
    [id, activeId, isActive, translateY, onDrop],
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
