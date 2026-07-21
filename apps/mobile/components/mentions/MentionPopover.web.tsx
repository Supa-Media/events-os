/**
 * MentionPopover (web) — DOM-portal variant of the mention suggestion panel.
 *
 * Deliberately NOT the shared `Popover`: that renders a react-native-web
 * Modal, whose focus trap steals focus from the textarea as soon as the panel
 * mounts — the input blurs, the blur handler commits + closes the trigger,
 * and the picker unmounts before it is ever seen. A plain portal has no focus
 * management, so focus stays in the input while suggestions show.
 *
 * `onMouseDown={preventDefault}` on the container keeps it that way during a
 * suggestion click too: preventing mousedown's default stops the browser from
 * moving focus to the clicked row (the press/click handlers still fire), so
 * picking a suggestion never blurs the input mid-edit.
 *
 * Positioning mirrors `Popover`'s math (below the anchor, flip above when it
 * would overflow the bottom, clamped to the viewport edges) in fixed-position
 * viewport coordinates, which is what `measureAnchor` yields on web.
 */
import type { CSSProperties, ReactNode } from "react";
import { createPortal } from "react-dom";
import { ScrollView, View } from "react-native";
import type { AnchorRect } from "../ui/useAnchor";

const MAX_PANEL_HEIGHT = 320;
const GAP = 4;
const EDGE_MARGIN = 8;

export function MentionPopover({
  visible,
  anchor,
  children,
}: {
  visible: boolean;
  /** Unused on web — there is no backdrop; the input's blur closes the panel. */
  onClose: () => void;
  anchor: AnchorRect | undefined;
  children: ReactNode;
}) {
  if (!visible || !anchor) return null;

  const panelWidth = Math.max(anchor.width, 240);
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const left = Math.max(
    EDGE_MARGIN,
    Math.min(anchor.x, vw - panelWidth - EDGE_MARGIN),
  );

  const style: CSSProperties = {
    position: "fixed",
    left,
    width: panelWidth,
    zIndex: 1000,
  };
  let scrollMaxHeight = MAX_PANEL_HEIGHT;

  const belowTop = anchor.y + anchor.height + GAP;
  if (belowTop + MAX_PANEL_HEIGHT > vh) {
    // Flip above: pin the panel's bottom edge just above the anchor and clamp
    // the scroll height to the space actually available (same as Popover).
    style.bottom = Math.max(EDGE_MARGIN, vh - anchor.y + GAP);
    scrollMaxHeight = Math.max(
      0,
      Math.min(MAX_PANEL_HEIGHT, anchor.y - GAP - EDGE_MARGIN),
    );
  } else {
    style.top = belowTop;
  }

  return createPortal(
    <div style={style} onMouseDown={(e) => e.preventDefault()}>
      <View className="overflow-hidden rounded-lg border border-border bg-raised shadow-pop">
        <ScrollView style={{ maxHeight: scrollMaxHeight }}>{children}</ScrollView>
      </View>
    </div>,
    document.body,
  );
}
