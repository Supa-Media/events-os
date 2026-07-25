/**
 * HOVER TO EXPAND A THUMBNAIL — founder ask (2026-07-24): "allow people to
 * somehow easily and quickly view and inspect receipts... I'm even thinking an
 * on hover expansion of the image." Hovering a small thumbnail floats a large
 * preview next to the cursor; moving away dismisses it. No click, no modal, no
 * navigation — the point is scanning a backlog without leaving the list.
 *
 * WEB ONLY, by nature: hover has no touch equivalent. On native the hook
 * returns no handlers and renders no layer, so callers keep whatever tap
 * affordance they already have (`ImageLightbox` on press).
 *
 * WHY NOT `Popover`: that renders inside a `<Modal>`, whose overlay sits above
 * the cursor the moment it opens — the browser then fires `mouseleave` on the
 * thumbnail, which closes the popover, which puts the cursor back on the
 * thumbnail… a flicker loop. This layer is instead rendered as a sibling of
 * the scrolling grid with `pointerEvents="none"`, so it is never hit-tested
 * and the thumbnail keeps hover the whole time.
 *
 * WHY A SEPARATE LAYER rather than an absolutely-positioned child of the row:
 * the grid lives inside a horizontal `ScrollView`, which clips overflow — an
 * expanded preview taller than its row would be cut off. The layer mounts
 * OUTSIDE that scroll container and is positioned from page coordinates,
 * converted to the wrapper's local space via one `measureInWindow`.
 */
import { useCallback, useRef, useState } from "react";
import { Dimensions, Image, Platform, View } from "react-native";

const MARGIN = 16;

type PreviewState = { uri: string; pageX: number; pageY: number };

export function useHoverImagePreview(size = 280) {
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const wrapperRef = useRef<View>(null);
  const originRef = useRef({ x: 0, y: 0 });

  /** Cache the wrapper's page origin so page-space cursor coordinates can be
   *  converted to layer-local ones. Re-measured on layout (scroll/resize). */
  const onWrapperLayout = useCallback(() => {
    wrapperRef.current?.measureInWindow((x, y) => {
      originRef.current = { x, y };
    });
  }, []);

  /** Spread onto the Pressable wrapping a thumbnail. `null` uri (a PDF with no
   *  rendered preview, say) yields no handlers — nothing to show. */
  const hoverProps = useCallback(
    (uri: string | null | undefined) => {
      if (Platform.OS !== "web" || !uri) return {};
      return {
        onHoverIn: (e: { nativeEvent: { pageX: number; pageY: number } }) =>
          setPreview({ uri, pageX: e.nativeEvent.pageX, pageY: e.nativeEvent.pageY }),
        onHoverOut: () => setPreview(null),
      };
    },
    [],
  );

  let layer = null;
  if (preview) {
    const win = Dimensions.get("window");
    // Prefer down-and-right of the cursor; flip when that would run off the
    // viewport, so a row at the bottom/right edge still shows its preview.
    const flipX = preview.pageX + MARGIN + size > win.width;
    const flipY = preview.pageY + MARGIN + size > win.height;
    const pageLeft = flipX ? preview.pageX - size - MARGIN : preview.pageX + MARGIN;
    const pageTop = flipY ? preview.pageY - size - MARGIN : preview.pageY + MARGIN;
    layer = (
      <View
        pointerEvents="none"
        style={{
          position: "absolute",
          left: pageLeft - originRef.current.x,
          top: pageTop - originRef.current.y,
          width: size,
          height: size,
          zIndex: 50,
        }}
        className="overflow-hidden rounded-lg border border-border bg-raised shadow-pop"
      >
        <Image
          source={{ uri: preview.uri }}
          style={{ width: "100%", height: "100%" }}
          resizeMode="contain"
        />
      </View>
    );
  }

  return { wrapperRef, onWrapperLayout, hoverProps, layer };
}
