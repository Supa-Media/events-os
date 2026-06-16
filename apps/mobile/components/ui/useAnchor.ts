/**
 * `useAnchor` — anchored-popover plumbing for the spreadsheet-style cells.
 *
 * A cell holds a `ref` on its trigger; `open()` measures that node into WINDOW
 * coordinates (via {@link measureAnchor}, shared with ContextMenu) and feeds the
 * rect to a {@link Popover}. Extracted from the near-identical copies in
 * `people.tsx`, `CrewSections.tsx`, and the grid cells so every select/edit cell
 * shares one measurement path.
 */
import { useRef, useState } from "react";
import { measureAnchor, type ContextMenuAnchor } from "./ContextMenu";

export type AnchorRect = ContextMenuAnchor;

export type UseAnchor = {
  /** Attach to the trigger node (a View/Pressable) you want to measure. */
  ref: React.MutableRefObject<any>;
  /** Measured trigger rect (window coords) — undefined until first `open()`. */
  anchor: AnchorRect | undefined;
  /** Whether the popover is open. */
  visible: boolean;
  /** Measure the trigger and open the popover. */
  open: () => void;
  /** Close the popover (keeps the last anchor). */
  close: () => void;
};

export function useAnchor(): UseAnchor {
  const ref = useRef<any>(null);
  const [anchor, setAnchor] = useState<AnchorRect | undefined>();
  const [visible, setVisible] = useState(false);

  const open = () => {
    measureAnchor(ref.current, (rect) => {
      setAnchor(rect);
      setVisible(true);
    });
  };

  return { ref, anchor, visible, open, close: () => setVisible(false) };
}
