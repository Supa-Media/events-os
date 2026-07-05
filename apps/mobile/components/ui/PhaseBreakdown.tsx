import { Pressable, Text, View } from "react-native";
import { phaseColors } from "../../lib/theme";
import { ReadinessRing } from "./ReadinessRing";
import {
  PHASE_KEYS,
  PHASE_LABELS,
  type PhaseKey,
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
  size,
  active,
  onSelect,
}: {
  phase: PhaseKey;
  pct: number | null;
  size: number;
  active: boolean;
  onSelect?: (phase: PhaseKey) => void;
}) {
  const hue = phaseColors[phase];
  const complete = pct != null && pct >= 100;
  return (
    <Pressable
      onPress={onSelect ? () => onSelect(phase) : undefined}
      disabled={!onSelect}
      hitSlop={6}
      accessibilityRole={onSelect ? "button" : undefined}
      accessibilityLabel={`${PHASE_LABELS[phase]} readiness${
        pct == null ? "" : `, ${pct}%`
      }. Highlights this phase's tabs.`}
      className="items-center gap-1 active:opacity-70 web:hover:opacity-85"
      style={active ? { transform: [{ scale: 1.06 }] } : undefined}
    >
      <ReadinessRing
        value={pct}
        size={size}
        color={pct == null ? undefined : hue.main}
        glowColor={hue.glow}
      />
      <PhaseLabel
        label={PHASE_LABELS[phase]}
        hue={hue}
        lit={active || complete}
        dim={pct == null}
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
 */
export function PhaseBreakdown({
  phases,
  size = 52,
  onSelectPhase,
  activePhase,
}: {
  phases: PhaseScores;
  size?: number;
  /** Tap a ring → pulse its tabs. Rings are inert when omitted. */
  onSelectPhase?: (phase: PhaseKey) => void;
  activePhase?: PhaseKey | null;
}) {
  return (
    <View className="flex-row flex-wrap items-start gap-x-5 gap-y-2">
      {PHASE_KEYS.map((key) => {
        const score = phases[key];
        return (
          <PhaseRing
            key={key}
            phase={key}
            pct={score == null ? null : Math.round(score * 100)}
            size={size}
            active={activePhase === key}
            onSelect={onSelectPhase}
          />
        );
      })}
    </View>
  );
}
