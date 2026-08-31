import { useEffect, useState } from "react";

/**
 * The value `delayMs` after it last changed — for a text box that drives a
 * server query, so a search costs one round trip per pause rather than one
 * per keystroke.
 *
 * Extracted from `AudiencesView.tsx`'s hand-pick search (which had this as a
 * local `useState` + `setTimeout` pair) when people search moved server-side
 * across every picker; `AudiencesView` keeps its own copy only because its
 * debounce also covers non-search filter state.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
