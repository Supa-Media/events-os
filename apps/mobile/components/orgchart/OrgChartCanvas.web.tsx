/**
 * OrgChartCanvas (web) — Figma-natural pan/zoom over the org tree, via raw DOM
 * events on a plain `<div>` (react-native-web renders RN Views as divs anyway,
 * so nesting the RN tree inside one is safe — same trick `SiteMapEditor.tsx`
 * uses for its react-rnd shapes).
 *
 * Navigation:
 *   - ctrl+wheel (how browsers report macOS trackpad pinch) → zoom toward the
 *     cursor.
 *   - plain wheel (two-finger scroll) → pan.
 *   - click-drag starting on EMPTY canvas → pan, grab/grabbing cursor. A
 *     mousedown that starts on a seat box or any other interactive control
 *     (role="button", input, …) is left alone so it stays clickable.
 *   - a mousedown+mouseup with negligible movement on empty canvas fires
 *     `onBackgroundPress` (closes the seat detail overlay).
 *
 * The wheel listener is attached as a native, non-passive DOM listener (not
 * React's `onWheel`) so `preventDefault()` reliably blocks the browser's own
 * pinch-zoom / page-scroll — React attaches `onWheel` passively by default.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { OrgChartCanvasProps } from "./OrgChartCanvas";
import { CanvasControls } from "./CanvasControls";
import {
  IDENTITY_TRANSFORM,
  clampTranslation,
  computeFitTransform,
  panBy,
  zoomAroundPoint,
  type Size,
  type Transform,
} from "./canvasMath";

const ZOOM_BUTTON_FACTOR = 1.25;
/** ctrl+wheel sensitivity — a deltaY of ~100 (one "notch") is roughly a 25%
 *  scale change, which reads as a natural pinch speed. */
const WHEEL_ZOOM_SENSITIVITY = 0.0025;
/** Below this much total mouse movement, a mousedown→mouseup on the canvas
 *  background is a click (deselect), not a drag-pan. */
const DRAG_CLICK_THRESHOLD = 4;
/** Elements a canvas-background mousedown must NOT start a pan from — every
 *  interactive control in the tree (seat boxes, the "+" add-seat affix,
 *  toolbar buttons, inline rename inputs, …) sets accessibilityRole="button"
 *  (→ role="button" on web) or is a native form control. */
const INTERACTIVE_SELECTOR = '[role="button"], input, textarea, select, [contenteditable="true"]';

export function OrgChartCanvas({
  children,
  onBackgroundPress,
  fitToken,
  controlsRightInset,
}: OrgChartCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const contentSizeRef = useRef<Size>({ width: 0, height: 0 });

  const [transform, setTransform] = useState<Transform>(IDENTITY_TRANSFORM);
  const transformRef = useRef(transform);
  transformRef.current = transform;

  const [dragging, setDragging] = useState(false);

  // ── measure the content's NATURAL (untransformed) size ───────────────────
  // CSS transform is paint-only — offsetWidth/offsetHeight of the transformed
  // node still reports its untransformed layout box, exactly the "world
  // space" size clamping/fit need.
  const measureContent = useCallback(() => {
    const node = contentRef.current;
    if (!node) return;
    contentSizeRef.current = { width: node.offsetWidth, height: node.offsetHeight };
  }, []);

  useLayoutEffect(() => {
    measureContent();
  });

  useEffect(() => {
    const node = contentRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measureContent());
    ro.observe(node);
    return () => ro.disconnect();
  }, [measureContent]);

  const getContainerSize = useCallback((): Size => {
    const el = containerRef.current;
    if (!el) return { width: 0, height: 0 };
    const rect = el.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  }, []);

  const applyTransform = useCallback(
    (next: Transform) => {
      const container = getContainerSize();
      const content = contentSizeRef.current;
      const clamped =
        container.width > 0 && container.height > 0
          ? clampTranslation(next, container, content)
          : next;
      setTransform(clamped);
    },
    [getContainerSize],
  );

  // ── Fit to screen — on mount, whenever `fitToken` changes (scope switch /
  // the chart finishing its first load), and via the corner control. ───────
  const fit = useCallback(() => {
    measureContent();
    const container = getContainerSize();
    const content = contentSizeRef.current;
    if (content.width <= 0 || content.height <= 0) return;
    setTransform(computeFitTransform(container, content));
  }, [getContainerSize, measureContent]);

  useEffect(() => {
    // Defer a frame so the new content (a scope switch swaps the whole tree)
    // has settled its layout before measuring.
    const id = requestAnimationFrame(fit);
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitToken]);

  // ── Wheel: ctrl = zoom toward cursor, plain = pan. ────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const pointer = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      if (e.ctrlKey) {
        const factor = Math.exp(-e.deltaY * WHEEL_ZOOM_SENSITIVITY);
        applyTransform(zoomAroundPoint(transformRef.current, pointer, factor));
      } else {
        applyTransform(panBy(transformRef.current, -e.deltaX, -e.deltaY));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [applyTransform]);

  // ── Click-drag on empty canvas → pan; a stationary click → background
  // press (closes the overlay panel). ───────────────────────────────────────
  const dragStart = useRef<{ x: number; y: number; baseX: number; baseY: number; moved: boolean } | null>(
    null,
  );

  const onMouseDown = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest(INTERACTIVE_SELECTOR)) return;
    e.preventDefault(); // avoid native text/image drag-selection while panning
    const t = transformRef.current;
    dragStart.current = { x: e.clientX, y: e.clientY, baseX: t.x, baseY: t.y, moved: false };
    setDragging(true);
  }, []);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const start = dragStart.current;
      if (!start) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (Math.abs(dx) > DRAG_CLICK_THRESHOLD || Math.abs(dy) > DRAG_CLICK_THRESHOLD) {
        start.moved = true;
      }
      applyTransform({ ...transformRef.current, x: start.baseX + dx, y: start.baseY + dy });
    };
    const onUp = () => {
      const start = dragStart.current;
      setDragging(false);
      dragStart.current = null;
      if (start && !start.moved) onBackgroundPress?.();
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, [dragging, applyTransform, onBackgroundPress]);

  const zoomAtCenter = useCallback(
    (factor: number) => {
      const container = getContainerSize();
      const pointer = { x: container.width / 2, y: container.height / 2 };
      applyTransform(zoomAroundPoint(transformRef.current, pointer, factor));
    },
    [applyTransform, getContainerSize],
  );

  return (
    <div
      ref={containerRef}
      onMouseDown={onMouseDown}
      style={{
        position: "relative",
        flex: 1,
        width: "100%",
        height: "100%",
        overflow: "hidden",
        touchAction: "none",
        cursor: dragging ? "grabbing" : "grab",
      }}
    >
      <div
        ref={contentRef}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
          transformOrigin: "0 0",
          willChange: "transform",
        }}
      >
        {children}
      </div>
      <CanvasControls
        scale={transform.scale}
        onZoomIn={() => zoomAtCenter(ZOOM_BUTTON_FACTOR)}
        onZoomOut={() => zoomAtCenter(1 / ZOOM_BUTTON_FACTOR)}
        onFit={fit}
        rightInset={controlsRightInset}
      />
    </div>
  );
}
