/**
 * The two id chores every part of the Designs workstation shares.
 *
 * They lived in `BrandKitSection.tsx` while that file was half the tab; the
 * workstation split it into a rail, three walls and four inspectors, and a
 * helper imported by seven of them belongs in its own module rather than in
 * whichever component happened to be written first.
 */

/**
 * A row id handed back to a mutation exactly as it arrived.
 *
 * This screen never constructs an id — it reads one off a library row and
 * returns the same string. Casting through `never` (assignable to any parameter
 * type) satisfies the generated `Id<"…">` argument types without four Convex
 * table names being spelled out in the UI layer, where they would be wrong the
 * first time the backend renamed one.
 */
export const asId = (id: string) => id as never;

/**
 * The full id order with two rows swapped, for a `reorder*` mutation.
 *
 * Takes the whole list even when the visible group is a subset (faces render
 * grouped by role, designs by shelf): the mutation replaces the entire order,
 * so a partial list would silently renumber everything it omitted.
 */
export function swappedIds<T extends { id: string }>(
  all: T[],
  aId: string,
  bId: string,
): string[] {
  const ids = all.map((row) => row.id);
  const i = ids.indexOf(aId);
  const j = ids.indexOf(bId);
  if (i < 0 || j < 0) return ids;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  return ids;
}

/**
 * The neighbour a "move earlier / move later" press swaps with, or null at the
 * end of the list.
 *
 * Ordering moved OUT of the browse surface and into the inspector with
 * everything else editable — the mockup's whole argument is that four icons on
 * every row made the page read as a database. Two labelled buttons in the panel
 * do the same job, are the same one press on a phone as on a desk, and cannot
 * be mistaken for part of the picture.
 */
export function neighbourFor<T extends { id: string }>(
  group: T[],
  id: string,
  delta: 1 | -1,
): T | null {
  const index = group.findIndex((row) => row.id === id);
  if (index < 0) return null;
  return group[index + delta] ?? null;
}
