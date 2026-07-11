import { View } from "react-native";
import { colors } from "../../lib/theme";

/**
 * Thin progress bar driven by a 0..1 fraction. Fills accent while in
 * progress and flips to the success color at complete. Spans its parent's
 * width — constrain with a wrapper (e.g. `w-28`) for fixed-width bars.
 */
export function ProgressBar({ fraction }: { fraction: number }) {
  const pct = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
  const done = pct >= 100;
  return (
    <View className="h-2 w-full overflow-hidden rounded-pill bg-sunken">
      <View
        className="h-full rounded-pill"
        style={{
          width: `${pct}%`,
          backgroundColor: done ? colors.success : colors.accent,
        }}
      />
    </View>
  );
}
