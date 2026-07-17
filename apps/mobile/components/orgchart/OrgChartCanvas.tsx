/**
 * Shared props + default export for the platform-split org chart canvas.
 *
 * The real implementations live in:
 *   - OrgChartCanvas.web.tsx     (DOM wheel/mouse events — trackpad pinch via
 *                                  ctrl+wheel, two-finger scroll to pan, click-
 *                                  drag on empty canvas)
 *   - OrgChartCanvas.native.tsx  (react-native-gesture-handler Pinch + Pan,
 *                                  simultaneous, driving Reanimated shared
 *                                  values)
 *
 * Metro/Webpack resolve `.web.tsx` / `.native.tsx` by platform automatically.
 * This bare `.tsx` is what TypeScript resolves when you `import` the
 * component without an extension, so it must export the same shape both
 * variants do. We point it at the native implementation (the most
 * conservative default); the bundler swaps in the web build at runtime.
 */
import type { ReactNode } from "react";

export type OrgChartCanvasProps = {
  /** The pannable/zoomable content — the org tree. Rendered inside a
   *  `translate(x, y) scale(scale)` layer; its OWN unscaled size (measured via
   *  layout, not the visual/scaled size) is what pan clamping and "Fit" are
   *  computed against. */
  children: ReactNode;
  /** Fired when a click/tap lands on empty canvas — not on a seat box or any
   *  other interactive control inside `children`. The screen uses this to
   *  close the seat detail overlay panel. */
  onBackgroundPress?: () => void;
  /** Changing this value (e.g. on scope-pill change, or once when the chart
   *  first loads) re-runs the "Fit to screen" auto-layout, since a different
   *  scope means a differently-shaped, differently-sized tree. */
  fitToken: string | number;
  /** Extra right-edge inset (px) for the corner `CanvasControls` cluster —
   *  the caller passes the open `SeatOverlayPanel`'s width here while it's
   *  open (0 otherwise) so the zoom/Fit controls shift clear of the panel's
   *  strip instead of being covered by (and unclickable under) it. See
   *  `org-chart.tsx`. */
  controlsRightInset?: number;
};

export { OrgChartCanvas as default, OrgChartCanvas } from "./OrgChartCanvas.native";
