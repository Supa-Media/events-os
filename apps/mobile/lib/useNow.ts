import { useEffect, useState } from "react";

/** A live wall clock — re-renders every `intervalMs` (default 30s). Anchors
 *  the run-of-show "now / up-next" highlight wherever the timeline renders. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
