/**
 * OrgChartCanvas (native) — Figma-natural pan/zoom over the org tree, via
 * react-native-gesture-handler (already installed, used elsewhere for drag —
 * see `dragToReschedule.tsx`) + Reanimated shared values, matching the same
 * pan/zoom model `canvasMath.ts` defines for web.
 *
 * Gestures:
 *   - Pinch → scale around the two-finger focal point.
 *   - Pan (`minDistance(10)`) → drag to reposition. The distance threshold
 *     (same idiom as `dragToReschedule.tsx`'s `.activateAfterLongPress`) is
 *     what lets a plain tap on a seat box resolve as a normal `Pressable`
 *     press instead of being claimed by this gesture.
 *   - A background `Pressable`, layered BEHIND the pannable content, catches
 *     a tap that lands on truly empty canvas (nothing else claimed it) and
 *     fires `onBackgroundPress`.
 *
 * NOTE on `canvasMath.ts`: the pinch/pan `.onUpdate` callbacks below run on
 * the UI thread as Reanimated worklets, which can only call functions that
 * are THEMSELVES compiled as worklets — cross-file worklet detection isn't
 * reliable, so the (small) zoom-around-focal-point arithmetic is inlined here
 * rather than calling `canvasMath.ts`'s `zoomAroundPoint`. Low-frequency,
 * JS-thread-only paths (the corner +/-/Fit controls, the post-gesture clamp)
 * DO call into `canvasMath.ts` directly — see `fit`/`zoomAtCenter`/
 * `clampAfterGesture` below. Keep the inlined pinch math in sync with
 * `zoomAroundPoint` if that model ever changes.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, View, type LayoutChangeEvent } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import type { OrgChartCanvasProps } from "./OrgChartCanvas";
import { CanvasControls } from "./CanvasControls";
import {
  MAX_SCALE,
  MIN_SCALE,
  clampTranslation,
  computeFitTransform,
  zoomAroundPoint,
  type Size,
} from "./canvasMath";

const ZOOM_BUTTON_FACTOR = 1.25;

export function OrgChartCanvas({ children, onBackgroundPress, fitToken }: OrgChartCanvasProps) {
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const scale = useSharedValue(1);

  // Gesture-start snapshots (UI thread) — see the pinch/pan builders below.
  const startTranslateX = useSharedValue(0);
  const startTranslateY = useSharedValue(0);
  const startScale = useSharedValue(1);
  const focalWorldX = useSharedValue(0);
  const focalWorldY = useSharedValue(0);

  const containerSizeRef = useRef<Size>({ width: 0, height: 0 });
  const contentSizeRef = useRef<Size>({ width: 0, height: 0 });
  // Mirrors `scale` to React state ONLY for the corner readout — set on
  // gesture end / button press (low frequency), never per-frame.
  const [scaleLabel, setScaleLabel] = useState(1);
  const reportScale = useCallback((s: number) => setScaleLabel(s), []);

  const clampAfterGesture = useCallback(() => {
    const clamped = clampTranslation(
      { x: translateX.value, y: translateY.value, scale: scale.value },
      containerSizeRef.current,
      contentSizeRef.current,
    );
    translateX.value = withTiming(clamped.x, { duration: 180 });
    translateY.value = withTiming(clamped.y, { duration: 180 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onContainerLayout = useCallback((e: LayoutChangeEvent) => {
    containerSizeRef.current = { width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height };
  }, []);
  const onContentLayout = useCallback((e: LayoutChangeEvent) => {
    contentSizeRef.current = { width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height };
  }, []);

  // ── Fit to screen — on mount, whenever `fitToken` changes (scope switch /
  // the chart finishing its first load), and via the corner control. ───────
  const fit = useCallback(() => {
    const next = computeFitTransform(containerSizeRef.current, contentSizeRef.current);
    translateX.value = withTiming(next.x, { duration: 220 });
    translateY.value = withTiming(next.y, { duration: 220 });
    scale.value = withTiming(next.scale, { duration: 220 });
    reportScale(next.scale);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportScale]);

  useEffect(() => {
    // Defer so the new content (a scope switch swaps the whole tree) has
    // committed a layout pass before measuring.
    const id = setTimeout(fit, 0);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitToken]);

  const zoomAtCenter = useCallback(
    (factor: number) => {
      const pointer = {
        x: containerSizeRef.current.width / 2,
        y: containerSizeRef.current.height / 2,
      };
      const next = zoomAroundPoint(
        { x: translateX.value, y: translateY.value, scale: scale.value },
        pointer,
        factor,
      );
      translateX.value = withTiming(next.x, { duration: 150 });
      translateY.value = withTiming(next.y, { duration: 150 });
      scale.value = withTiming(next.scale, { duration: 150 });
      reportScale(next.scale);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [reportScale],
  );

  // Inlined zoom-around-focal-point (see file header) — scale clamped the
  // same [MIN_SCALE, MAX_SCALE] range as `canvasMath.clampScale`.
  const pinch = Gesture.Pinch()
    .onStart((e) => {
      startScale.value = scale.value;
      focalWorldX.value = (e.focalX - translateX.value) / scale.value;
      focalWorldY.value = (e.focalY - translateY.value) / scale.value;
    })
    .onUpdate((e) => {
      const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, startScale.value * e.scale));
      scale.value = next;
      translateX.value = e.focalX - focalWorldX.value * next;
      translateY.value = e.focalY - focalWorldY.value * next;
    })
    .onEnd(() => {
      runOnJS(reportScale)(scale.value);
      runOnJS(clampAfterGesture)();
    });

  // `minDistance` lets a plain tap on a seat box (a Pressable, resolved by
  // RN's own responder system) settle normally before this gesture would
  // ever claim the touch — same idiom as `dragToReschedule.tsx`'s
  // `.activateAfterLongPress`.
  const pan = Gesture.Pan()
    .minDistance(10)
    .onStart(() => {
      startTranslateX.value = translateX.value;
      startTranslateY.value = translateY.value;
    })
    .onUpdate((e) => {
      translateX.value = startTranslateX.value + e.translationX;
      translateY.value = startTranslateY.value + e.translationY;
    })
    .onEnd(() => {
      runOnJS(clampAfterGesture)();
    });

  const composed = Gesture.Simultaneous(pan, pinch);

  const contentStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }, { translateY: translateY.value }, { scale: scale.value }],
  }));

  return (
    <View style={{ flex: 1 }} onLayout={onContainerLayout}>
      {/* Background layer, BEHIND the pannable content — catches a tap that
          lands on truly empty canvas. The content wrapper below is
          `pointerEvents="box-none"` so a tap in a gap between seat boxes
          (nothing there to claim it) falls through to this. */}
      <Pressable
        accessibilityLabel="Canvas background"
        onPress={onBackgroundPress}
        style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}
      />
      <GestureDetector gesture={composed}>
        <Animated.View
          onLayout={onContentLayout}
          pointerEvents="box-none"
          style={[
            { position: "absolute", top: 0, left: 0, transformOrigin: [0, 0] },
            contentStyle,
          ]}
        >
          {children}
        </Animated.View>
      </GestureDetector>
      <CanvasControls
        scale={scaleLabel}
        onZoomIn={() => zoomAtCenter(ZOOM_BUTTON_FACTOR)}
        onZoomOut={() => zoomAtCenter(1 / ZOOM_BUTTON_FACTOR)}
        onFit={fit}
      />
    </View>
  );
}
