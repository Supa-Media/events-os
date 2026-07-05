import { useEffect, useRef, useState } from "react";
import type { PhaseKey } from "@events-os/shared";

const PULSE_MS = 2200;

/**
 * Transient "which phase was just tapped" state for the event header ↔ tab-bar
 * link. `flash(phase)` lights a phase for ~2s (self-clearing), so tapping a
 * readiness ring pulses the tabs that feed it. Returns the active phase (null
 * when idle) and the trigger.
 */
export function usePhasePulse(): {
  pulsePhase: PhaseKey | null;
  flash: (phase: PhaseKey) => void;
} {
  const [pulsePhase, setPulsePhase] = useState<PhaseKey | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const flash = (phase: PhaseKey) => {
    setPulsePhase(phase);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setPulsePhase(null), PULSE_MS);
  };

  return { pulsePhase, flash };
}
