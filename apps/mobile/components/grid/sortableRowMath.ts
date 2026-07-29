/**
 * The ARITHMETIC behind `SortableRows` — where a dragged row lands, and in
 * which units the question is asked.
 *
 * It lives apart from the component for two reasons. It is the part that can
 * be quietly wrong (a drop index is either the row you let go over or it is
 * not, and nothing on screen says which), and `SortableRows.tsx` imports
 * react-native-gesture-handler and reanimated — so nothing that imports it can
 * run under this package's node-environment jest, while this module can.
 *
 * ── Two coordinate spaces, and why they differ ─────────────────────────────
 * A pan gesture reports its translation in SCREEN pixels. Row heights come
 * from `onLayout`, which reports the LAYOUT box: untransformed on both
 * platforms (react-native-web's `UIManager.measure` reads `offsetHeight`;
 * Yoga lays out before transforms are applied). A list drawn inside a parent
 * that scales it — the email canvas draws its 600px document at ~0.6 on a
 * phone — therefore has a gesture measured in one unit and a layout measured
 * in another, and comparing them directly drops the row a long way from the
 * finger. `contentTranslationY` converts the gesture into the layout's space.
 *
 * At the default scale of 1 it is the identity, which is every caller that
 * isn't the canvas.
 */

/** Height assumed for a row that hasn't reported its own yet. */
export const DEFAULT_ROW_HEIGHT = 44;

/**
 * The scale to actually divide by. Junk (0, negative, NaN, undefined) means
 * "unscaled" rather than a division that would return Infinity and send the
 * row to an index nobody asked for.
 */
export function safeScale(scale: number | undefined): number {
  return typeof scale === "number" && Number.isFinite(scale) && scale > 0 ? scale : 1;
}

/**
 * A pan translation in SCREEN px, expressed in the row list's own layout px.
 *
 * The same conversion the dragged row's `translateY` needs: a row inside a
 * container scaled by `s` moves `s ×` its own translation on screen, so it
 * only follows the finger when the translation it is given is the screen
 * distance divided by `s`.
 */
export function contentTranslationY(
  screenTranslationY: number,
  scale?: number,
): number {
  return screenTranslationY / safeScale(scale);
}

/**
 * The index a dragged row should land at, given its translation in the LIST's
 * own units and the measured heights of every row in current order.
 *
 * The rule is "every row whose CENTRE you have passed, you have moved past" —
 * which is what makes a drag over rows of very different heights land where
 * the eye expects, and what makes the answer symmetric: dragging up 40px and
 * back down 40px leaves the row exactly where it started.
 *
 * That symmetry is load-bearing rather than tidy. The earlier form took the
 * first row whose centre was BELOW the dragged centre, which meant a row let
 * go where it was picked up resolved to `from + 1` — a drag of zero distance
 * reordered the list. On a grid that is a puzzling nudge; on the email canvas
 * it is a history step and an autosave for a drag the designer abandoned.
 */
export function resolveTargetIndex(
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
    // Rows above: the highest one whose centre the drag has risen past.
    if (i < from && draggedCenter < center) target = Math.min(target, i);
    // Rows below: the lowest one whose centre the drag has fallen past.
    else if (i > from && draggedCenter > center) target = Math.max(target, i);
  }
  return Math.max(0, Math.min(count - 1, target));
}

/**
 * The new id order a drop produces, or `null` when the drag changed nothing
 * (dropped back where it started, or on an id the list no longer holds).
 *
 * `translationY` is in the LIST's units — pass it through
 * `contentTranslationY` first when the list is drawn at a scale.
 */
export function dropOrder(
  ids: string[],
  draggedId: string,
  translationY: number,
  heights: number[],
): string[] | null {
  const from = ids.indexOf(draggedId);
  if (from < 0) return null;
  const to = resolveTargetIndex(from, translationY, heights);
  if (to === from) return null;
  const next = ids.slice();
  next.splice(to, 0, next.splice(from, 1)[0]);
  return next;
}
