import { useEffect, useRef, useState } from "react";

/**
 * Eases a number toward `target` with a requestAnimationFrame loop
 * (ease-out-cubic). Drives the ring sweep + count-up so progress changes read
 * as motion — rings fill on mount and re-sweep live when Convex pushes new
 * scores. Plain rAF (not reanimated) because the web ring is a conic-gradient
 * string, which native drivers can't interpolate.
 */
export function useEasedValue(target: number, duration = 900): number {
  const [display, setDisplay] = useState(0);
  const currentRef = useRef(0);
  useEffect(() => {
    const from = currentRef.current;
    const delta = target - from;
    if (delta === 0) return;
    let raf: number;
    const start = Date.now();
    const tick = () => {
      const t = Math.min(1, (Date.now() - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      currentRef.current = from + delta * eased;
      setDisplay(currentRef.current);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return display;
}
