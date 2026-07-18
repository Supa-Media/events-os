import { Pressable, Text, View } from "react-native";
import { phaseColors, colors } from "../../lib/theme";
import { ReadinessRing } from "./ReadinessRing";
import {
  PHASE_KEYS,
  PHASE_LABELS,
  type PhaseKey,
  type PhasePace,
  type PhaseScores,
} from "@events-os/shared";

type PhaseHue = { main: string; glow: string };

/**
 * Label under a phase ring. Quiet by default (the ring's hue already encodes
 * the phase — no decorative dot repeating it); lit in the hue when active/done,
 * tinted amber (with a small attention dot) when the phase has overdue work —
 * the only loud state.
 */
function PhaseLabel({
  label,
  hue,
  lit,
  behind,
}: {
  label: string;
  hue: PhaseHue;
  lit: boolean;
  behind: boolean;
}) {
  return (
    <View className="flex-row items-center gap-1">
      {behind ? (
        <View
          style={{ width: 5, height: 5, borderRadius: 2.5, backgroundColor: colors.warn }}
        />
      ) : null}
      <Text
        className="text-2xs font-bold uppercase tracking-wider text-muted"
        style={behind ? { color: colors.warn } : lit ? { color: hue.main } : undefined}
      >
        {label}
      </Text>
    </View>
  );
}

/** One tappable phase ring + its label. Tapping asks the parent to spotlight it. */
function PhaseRing({
  phase,
  pct,
  expectedPct,
  pace,
  size,
  active,
  onSelect,
}: {
  phase: PhaseKey;
  pct: number | null;
  /** The baseline (actual + overdue debt cleared) — places the ghost tick. */
  expectedPct: number | null;
  /** Overdue tally for this phase (the pace SIGNAL), or null (pre-plan). */
  pace: PhasePace | null;
  size: number;
  active: boolean;
  onSelect?: (phase: PhaseKey) => void;
}) {
  const hue = phaseColors[phase];
  const complete = pct != null && pct >= 100;
  // The pace signal is the overdue count — the SAME rows the What's-next
  // list badges OVERDUE, tallied per phase, so ring and list always agree.
  // Per-ring it only tints the label; the header's single pace pill carries
  // the loud aggregate signal (one attention element, not four).
  const overdue = pace?.overdue ?? 0;
  const behind = overdue > 0 && !complete;
  return (
    <Pressable
      onPress={onSelect ? () => onSelect(phase) : undefined}
      disabled={!onSelect}
      hitSlop={6}
      accessibilityRole={onSelect ? "button" : undefined}
      accessibilityLabel={`${PHASE_LABELS[phase]} readiness${
        pct == null ? "" : `, ${pct}%`
      }${
        behind
          ? `, ${overdue} overdue item${overdue === 1 ? "" : "s"}`
          : ""
      }. Highlights this phase's tabs.`}
      className="items-center gap-1 active:opacity-70 web:hover:opacity-85"
      style={active ? { transform: [{ scale: 1.06 }] } : undefined}
    >
      <ReadinessRing
        value={pct}
        size={size}
        color={pct == null ? undefined : hue.main}
        glowColor={hue.glow}
        ghost={expectedPct}
      />
      <PhaseLabel
        label={PHASE_LABELS[phase]}
        hue={hue}
        lit={active || complete}
        behind={behind}
      />
    </Pressable>
  );
}

/**
 * The four phase scores as a row of labeled rings — the event header's headline
 * readiness signal. Each ring wears its phase's identity hue (the same hue its
 * module tabs wear below) and is pressable: tapping pulses the tabs that feed
 * it, answering "what do I do to move this number?". Values are 0..1 or null;
 * null renders "—" so an empty phase doesn't read as "0% ready".
 *
 * `expected` places each ring's dashed BASELINE TICK — the actual score
 * with all overdue debt cleared (early work shifts it up, so the tick is
 * always at-or-above the playhead); `pace` carries each phase's overdue
 * tally, which here only tints a behind phase's label amber. The loud
 * aggregate signal ("▲ N overdue" / "✓ on pace") is the header's single
 * pace pill, computed from the same counts, so rings, pill, and the
 * What's-next list always tell the same story.
 */
export function PhaseBreakdown({
  phases,
  expected,
  pace,
  size = 52,
  spread = false,
  onSelectPhase,
  activePhase,
}: {
  phases: PhaseScores;
  /** Expected (on-pace) scores; omit to render without target ticks. */
  expected?: PhaseScores;
  /** Per-phase overdue tallies; omit to render without pace captions. */
  pace?: Record<PhaseKey, PhasePace | null>;
  size?: number;
  /** Spread the rings evenly across the full width (a header strip) rather
   *  than clustering them at their natural width (the compact right column). */
  spread?: boolean;
  /** Tap a ring → pulse its tabs. Rings are inert when omitted. */
  onSelectPhase?: (phase: PhaseKey) => void;
  activePhase?: PhaseKey | null;
}) {
  return (
    <View
      className={
        spread
          ? "flex-row items-start justify-between"
          : "flex-row flex-wrap items-start gap-x-5 gap-y-2"
      }
    >
      {PHASE_KEYS.map((key) => {
        const score = phases[key];
        const target = expected?.[key];
        return (
          <PhaseRing
            key={key}
            phase={key}
            pct={score == null ? null : Math.round(score * 100)}
            expectedPct={target == null ? null : Math.round(target * 100)}
            pace={pace?.[key] ?? null}
            size={size}
            active={activePhase === key}
            onSelect={onSelectPhase}
          />
        );
      })}
    </View>
  );
}
