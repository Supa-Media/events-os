/**
 * The launch stepper — the spine of the event-page admin. Four phase steps in a
 * single rounded rail; each shows a completion state (✓ when its work is done,
 * else its number) and highlights the one that's currently open. Tapping a step
 * opens that phase below. It's what turns eight equal-weight sections into a
 * sequence with a sense of "where am I / what's next".
 */
import { Pressable, Text, View } from "react-native";
import { Icon } from "../../ui";
import { colors } from "../../../lib/theme";
import { LAUNCH_PHASES, type LaunchPhaseKey } from "./launchPhases";

export function LaunchStepper({
  activeKey,
  doneKeys,
  onSelect,
}: {
  activeKey: LaunchPhaseKey | null;
  doneKeys: Set<LaunchPhaseKey>;
  onSelect: (key: LaunchPhaseKey) => void;
}) {
  return (
    <View className="mb-3 flex-row rounded-2xl border border-border bg-raised p-1.5 shadow-card">
      {LAUNCH_PHASES.map((phase, i) => {
        const active = phase.key === activeKey;
        const done = doneKeys.has(phase.key);
        return (
          <Pressable
            key={phase.key}
            onPress={() => onSelect(phase.key)}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={`${phase.label} — ${phase.tagline}`}
            className="flex-1 items-center gap-1.5 rounded-xl px-1 py-3 active:opacity-80"
            style={active ? { backgroundColor: phase.hue.soft } : undefined}
          >
            {/* Index / done marker */}
            <View
              className="h-8 w-8 items-center justify-center rounded-pill"
              style={
                done
                  ? { backgroundColor: phase.hue.main }
                  : {
                      backgroundColor: colors.sunken,
                      borderWidth: 1.5,
                      borderColor: colors.borderStrong,
                    }
              }
            >
              {done ? (
                <Icon name="check" size={15} color="#FFFFFF" />
              ) : (
                <Text
                  className="text-sm font-extrabold"
                  style={{ color: active ? phase.hue.main : colors.faint }}
                >
                  {i + 1}
                </Text>
              )}
            </View>
            <Text
              className="text-xs font-bold"
              style={{ color: active || done ? colors.ink : colors.muted }}
              numberOfLines={1}
            >
              {phase.label}
            </Text>
            {/* Verb line — hidden on the tightest widths to avoid wrapping. */}
            <Text
              className="text-2xs font-semibold text-faint"
              numberOfLines={1}
            >
              {phase.tagline}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
