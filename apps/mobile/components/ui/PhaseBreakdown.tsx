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

/** Label under a phase ring: a hue dot + the phase name, lit when active/done. */
function PhaseLabel({
  label,
  hue,
  lit,
  dim,
}: {
  label: string;
  hue: PhaseHue;
  lit: boolean;
  dim: boolean;
}) {
  return (
    <View className="flex-row items-center gap-1">
      <View
        style={{
          width: 6,
          height: 6,
          borderRadius: 3,
          backgroundColor: hue.main,
          opacity: dim ? 0.35 : 1,
        }}
      />
      <Text
        className="text-2xs font-bold uppercase tracking-wider text-muted"
        style={lit ? { color: hue.main } : undefined}
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
  /** Where this ring SHOULD be today (places the ghost tick), or null. */
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
  // The expected % only places the dashed target tick on the ring.
  const overdue = pace?.overdue ?? 0;
  const behind = overdue > 0 && !complete;
  const showPace = pace != null && !complete;
  return (
    <Pressable
      onPress={onSelect ? () => onSelect(phase) : undefined}
      disabled={!onSelect}
      hitSlop={6}
      accessibilityRole={onSelect ? "button" : undefined}
      accessibilityLabel={`${PHASE_LABELS[phase]} readiness${
        pct == null ? "" : `, ${pct}%`
      }${
        showPace
          ? behind
            ? `, ${overdue} overdue item${overdue === 1 ? "" : "s"}`
            : ", on pace — nothing overdue"
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
        dim={pct == null}
      />
      {showPace ? (
        behind ? (
          <View
            className="flex-row items-center rounded-pill px-1.5 py-px"
            style={{ backgroundColor: colors.amberBg }}
          >
            <Text
              className="text-2xs font-bold"
              style={{ color: colors.amber }}
            >
              ▲ {overdue} overdue
            </Text>
          </View>
        ) : (
          // On pace is GOOD NEWS — say so, don't just go quiet.
          <Text
            className="text-2xs font-semibold"
            style={{ color: colors.success }}
          >
            ✓ on pace
          </Text>
        )
      ) : null}
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
 * `expected` places each ring's dashed TARGET TICK (where the score should
 * be today); `pace` carries each phase's overdue tally — the signal behind
 * the green "✓ on pace" / amber "▲ N overdue" captions. The overdue counts
 * are computed with the same rule as the What's-next list's OVERDUE badges,
 * so the rings and the list always tell the same story.
 */
export function PhaseBreakdown({
  phases,
  expected,
  pace,
  size = 52,
  onSelectPhase,
  activePhase,
}: {
  phases: PhaseScores;
  /** Expected (on-pace) scores; omit to render without target ticks. */
  expected?: PhaseScores;
  /** Per-phase overdue tallies; omit to render without pace captions. */
  pace?: Record<PhaseKey, PhasePace | null>;
  size?: number;
  /** Tap a ring → pulse its tabs. Rings are inert when omitted. */
  onSelectPhase?: (phase: PhaseKey) => void;
  activePhase?: PhaseKey | null;
}) {
  return (
    <View className="flex-row flex-wrap items-start gap-x-5 gap-y-2">
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
