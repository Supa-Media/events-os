/**
 * Drag-to-reschedule — long-press a day-panel card and drop it on any day in the
 * month grid. Works on web (mouse) and native (touch), same stack as the grid's
 * SortableRows: react-native-gesture-handler Pan + reanimated shared values.
 *
 * How it fits together:
 *   • `useCalendarDrag` (owned by ModuleCalendar) holds the drag state — which
 *     item is lifted, which day is hovered — plus the ghost's animated position.
 *   • Day cells register their nodes via `registerDayCell(ms)`; every cell is
 *     measured into window coords once, when a drag starts, and pointer moves
 *     hit-test against those rects on the JS thread (state only changes when the
 *     hovered day changes, so re-renders stay cheap).
 *   • `DraggableCard` wraps a card in a GestureDetector. Long-press (~220ms)
 *     lifts it, so plain taps, inline edits, and page scrolling keep working.
 *   • The pointer-following ghost is rendered by the calendar (it knows the
 *     item), positioned by `ghostStyle` relative to the calendar container.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import {
  Gesture,
  GestureDetector,
  type PanGesture,
} from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
} from "react-native-reanimated";
import type { ScheduleItem } from "./config";

/** How long a press must hold before the card lifts (ms). */
const LIFT_AFTER_MS = 220;
/** Ghost offset from the pointer so the finger/cursor never hides the label. */
const GHOST_OFFSET = { x: 14, y: 10 };

type DayRect = { ms: number; x: number; y: number; width: number; height: number };

export type CalendarDrag = {
  /** The card currently lifted, or null. */
  dragging: ScheduleItem | null;
  /** Day (start-of-day ms) currently under the pointer, or null. */
  hoverDay: number | null;
  /** Attach to the View that wraps the whole calendar (ghost coordinate space). */
  containerRef: React.MutableRefObject<any>;
  /** Ref callback for the wrapper around each day cell, keyed by its day ms. */
  registerDayCell: (ms: number) => (node: any) => void;
  /** Build the long-press pan gesture for one card. */
  buildGesture: (item: ScheduleItem) => PanGesture;
  /** Animated position/visibility for the pointer-following ghost. */
  ghostStyle: ReturnType<typeof useAnimatedStyle>;
};

export function useCalendarDrag({
  onDrop,
}: {
  /** Called when a card is dropped on a day (start-of-day ms). */
  onDrop: (item: ScheduleItem, dayMs: number) => void;
}): CalendarDrag {
  const [dragging, setDragging] = useState<ScheduleItem | null>(null);
  const [hoverDay, setHoverDay] = useState<number | null>(null);

  const containerRef = useRef<any>(null);
  const dayNodes = useRef(new Map<number, any>()).current;
  const rectsRef = useRef<DayRect[]>([]);
  const draggingRef = useRef<ScheduleItem | null>(null);
  const hoverRef = useRef<number | null>(null);

  // Pointer position (window coords) + the container's window origin, all on
  // the UI thread so the ghost tracks the finger without JS round-trips.
  const pointerX = useSharedValue(0);
  const pointerY = useSharedValue(0);
  const originX = useSharedValue(0);
  const originY = useSharedValue(0);
  const active = useSharedValue(false);

  const registerDayCell = useCallback(
    (ms: number) => (node: any) => {
      if (node) dayNodes.set(ms, node);
      else dayNodes.delete(ms);
    },
    [dayNodes],
  );

  const hitTest = useCallback((x: number, y: number): number | null => {
    for (const r of rectsRef.current) {
      if (x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height) {
        return r.ms;
      }
    }
    return null;
  }, []);

  const begin = useCallback(
    (item: ScheduleItem) => {
      draggingRef.current = item;
      setDragging(item);
      // Anchor the ghost's coordinate space to the calendar container.
      containerRef.current?.measureInWindow?.((x: number, y: number) => {
        originX.value = x;
        originY.value = y;
      });
      // Snapshot every visible day cell; drops hit-test against these rects.
      rectsRef.current = [];
      for (const [ms, node] of dayNodes) {
        node?.measureInWindow?.((x: number, y: number, width: number, height: number) => {
          rectsRef.current.push({ ms, x, y, width, height });
        });
      }
    },
    [dayNodes, originX, originY],
  );

  const update = useCallback(
    (x: number, y: number) => {
      const day = hitTest(x, y);
      if (day !== hoverRef.current) {
        hoverRef.current = day;
        setHoverDay(day);
      }
    },
    [hitTest],
  );

  const finish = useCallback(
    (x: number, y: number) => {
      const item = draggingRef.current;
      const day = hitTest(x, y);
      draggingRef.current = null;
      hoverRef.current = null;
      setDragging(null);
      setHoverDay(null);
      if (item && day != null) onDrop(item, day);
    },
    [hitTest, onDrop],
  );

  // Gesture cancelled (e.g. claimed by a scroll) — put everything back.
  const clear = useCallback(() => {
    if (!draggingRef.current && hoverRef.current == null) return;
    draggingRef.current = null;
    hoverRef.current = null;
    setDragging(null);
    setHoverDay(null);
  }, []);

  const buildGesture = useCallback(
    (item: ScheduleItem): PanGesture =>
      Gesture.Pan()
        .activateAfterLongPress(LIFT_AFTER_MS)
        .onStart((e) => {
          pointerX.value = e.absoluteX;
          pointerY.value = e.absoluteY;
          active.value = true;
          runOnJS(begin)(item);
        })
        .onUpdate((e) => {
          pointerX.value = e.absoluteX;
          pointerY.value = e.absoluteY;
          runOnJS(update)(e.absoluteX, e.absoluteY);
        })
        .onEnd((e) => {
          runOnJS(finish)(e.absoluteX, e.absoluteY);
        })
        .onFinalize(() => {
          active.value = false;
          runOnJS(clear)();
        }),
    [active, begin, clear, finish, pointerX, pointerY, update],
  );

  const ghostStyle = useAnimatedStyle(() => ({
    position: "absolute" as const,
    left: pointerX.value - originX.value + GHOST_OFFSET.x,
    top: pointerY.value - originY.value + GHOST_OFFSET.y,
    opacity: active.value ? 1 : 0,
  }));

  return {
    dragging,
    hoverDay,
    containerRef,
    registerDayCell,
    buildGesture,
    ghostStyle,
  };
}

/**
 * Wraps one day-panel card so a long-press lifts it into the drag. The wrapped
 * card dims while lifted (the ghost is what follows the pointer).
 */
export function DraggableCard({
  drag,
  item,
  children,
}: {
  drag: CalendarDrag;
  item: ScheduleItem;
  children: React.ReactNode;
}) {
  const gesture = useMemo(
    () => drag.buildGesture(item),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [drag.buildGesture, item],
  );
  const lifted = drag.dragging?._id === item._id;

  return (
    <GestureDetector gesture={gesture}>
      <View style={lifted ? { opacity: 0.35 } : undefined}>{children}</View>
    </GestureDetector>
  );
}

export { Animated as DragAnimated };
