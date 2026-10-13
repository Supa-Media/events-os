/** Immutable list edits the editor uses for lessons, blocks, questions and
 *  answers alike. Out-of-range moves return the list unchanged. */

export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  if (from === to || to < 0 || to >= list.length) return [...list];
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

export function replaceAt<T>(list: readonly T[], index: number, item: T): T[] {
  return list.map((x, i) => (i === index ? item : x));
}

export function removeAt<T>(list: readonly T[], index: number): T[] {
  return list.filter((_, i) => i !== index);
}

export function insertAt<T>(list: readonly T[], index: number, item: T): T[] {
  const next = [...list];
  next.splice(index, 0, item);
  return next;
}
