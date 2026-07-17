import { Modal, View, Pressable, ScrollView, Dimensions } from "react-native";

type Anchor = { x: number; y: number; width: number; height: number };

type Props = {
  visible: boolean;
  onClose: () => void;
  /** Anchor rect in window coordinates. When omitted the panel is centered. */
  anchor?: Anchor;
  /** Panel width in px. Defaults to max(anchor.width, 240) or 240 when no anchor. */
  width?: number;
  children: React.ReactNode;
};

/** Max scrollable height of the panel — also used for flip/overflow math. */
const MAX_PANEL_HEIGHT = 320;
/** Gap between the anchor and the panel. */
const GAP = 4;
/** Keep the panel this far from the window edges when clamping. */
const EDGE_MARGIN = 8;

/**
 * Controlled, anchored dropdown for the desktop-first spreadsheet grid. Renders
 * a transparent Modal with an invisible full-screen backdrop that closes on
 * press; the panel itself is absolutely positioned beneath the anchor and flips
 * above when it would overflow the window bottom. With no anchor it centers like
 * a small dialog. Clicks inside the panel are swallowed so they don't close it.
 *
 * Flip-above positioning anchors the panel's BOTTOM edge to the trigger's top
 * edge (via the `bottom` style, not `top`) rather than computing a `top` from
 * the FIXED `MAX_PANEL_HEIGHT`. The panel's actual rendered height is almost
 * always far less than `MAX_PANEL_HEIGHT` (it hugs its content, capped at that
 * max) — positioning from `top = anchor.y - MAX_PANEL_HEIGHT` assumed the
 * panel to be exactly that tall, leaving a large empty gap between a short
 * panel and its trigger for anchors near the bottom of the window (e.g. the
 * shell's bottom-left desk-switcher pill). Anchoring from `bottom` instead
 * makes the panel grow upward from the trigger regardless of its content
 * height. The scrollable max height is also clamped to the actual space
 * available above the anchor so a tall panel still can't overflow past the
 * top edge of the window.
 */
export function Popover({ visible, onClose, anchor, width, children }: Props) {
  if (!visible) return null;

  const window = Dimensions.get("window");

  let panelStyle: {
    position: "absolute";
    left?: number;
    top?: number;
    bottom?: number;
    width: number;
  };
  let scrollMaxHeight = MAX_PANEL_HEIGHT;

  if (anchor) {
    const panelWidth = width ?? Math.max(anchor.width, 240);

    // Clamp horizontally so the panel stays on screen.
    const maxLeft = window.width - panelWidth - EDGE_MARGIN;
    const left = Math.max(EDGE_MARGIN, Math.min(anchor.x, maxLeft));

    const belowTop = anchor.y + anchor.height + GAP;
    const overflowsBottom = belowTop + MAX_PANEL_HEIGHT > window.height;
    if (overflowsBottom) {
      // Flip above: anchor the BOTTOM edge just above the trigger (see the
      // function doc) and clamp the scroll height to the real space above it.
      const bottom = Math.max(EDGE_MARGIN, window.height - anchor.y + GAP);
      const spaceAbove = anchor.y - GAP - EDGE_MARGIN;
      scrollMaxHeight = Math.max(0, Math.min(MAX_PANEL_HEIGHT, spaceAbove));
      panelStyle = { position: "absolute", left, bottom, width: panelWidth };
    } else {
      panelStyle = { position: "absolute", left, top: belowTop, width: panelWidth };
    }
  } else {
    panelStyle = { position: "absolute", width: width ?? 240 };
  }

  return (
    <Modal visible transparent animationType="none" onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        className={
          anchor ? "flex-1" : "flex-1 items-center justify-center p-6"
        }
      >
        <Pressable
          onPress={() => {}}
          style={anchor ? panelStyle : undefined}
          className="overflow-hidden rounded-lg border border-border bg-raised shadow-pop"
        >
          <ScrollView style={{ maxHeight: scrollMaxHeight }}>
            <View style={!anchor ? { width: width ?? 240 } : undefined}>
              {children}
            </View>
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
