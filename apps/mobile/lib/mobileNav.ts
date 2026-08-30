/**
 * The phone dock's one piece of real logic, kept apart from the components that
 * draw it.
 *
 * It lives here rather than in `components/ui/MobileChrome.tsx` so it can be
 * tested: this app has no component test runtime (see `jest.config.js` — a node
 * environment with no jsdom and no renderer), so anything that imports a React
 * Native component is untestable by construction. This module imports nothing,
 * which makes the rule below an ordinary unit test.
 */

/**
 * How many destinations ride in the dock before the rest go behind "More".
 * Four plus More is five targets across a phone's width — each comfortably
 * past the 44pt touch minimum on the narrowest phone we support.
 */
export const DOCK_SLOTS = 4;

/**
 * Which destinations ride in the dock, given everything the caller may see.
 *
 * The leading {@link DOCK_SLOTS} entries, in the order they were given —
 * `AppShell`'s `NAV` declares a fixed order that must never be re-sorted, so
 * this only ever takes a prefix. The one exception is the destination you are
 * actually ON: if it fell outside that prefix it takes the LAST slot, so the
 * dock can always answer "where am I?" without the user opening the sheet to
 * find out. Nothing else moves, and the entry it displaced is still one tap
 * away in the sheet.
 *
 * Generic over the item shape so it stays free of component types.
 */
export function dockSelection<T extends { path: string; active: boolean }>(
  items: T[],
): T[] {
  const leading = items.slice(0, DOCK_SLOTS);
  const active = items.find((i) => i.active);
  if (!active || leading.some((i) => i.path === active.path)) return leading;
  return [...leading.slice(0, DOCK_SLOTS - 1), active];
}
