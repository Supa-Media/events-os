import { View } from "react-native";
import { Pill } from "../ui";
import type { FullChart } from "./treeUtils";

/** `"central"` | `"full"` | a chapter id — what the pill row selects. */
export type ScopeChoice = "central" | "full" | string;

/**
 * The scope pill row: [Central] [<each chapter>] [Full tree]. Chapter pills
 * come straight from the chart query's own chapter enumeration — no separate
 * `chapters.list` call.
 */
export function ScopePills({
  chart,
  value,
  onChange,
}: {
  chart: FullChart;
  value: ScopeChoice;
  onChange: (v: ScopeChoice) => void;
}) {
  return (
    <View className="mb-5 flex-row flex-wrap gap-2">
      <Pill label="Central" selected={value === "central"} onPress={() => onChange("central")} />
      {chart.chapters.map((c) => (
        <Pill
          key={c.chapterId}
          label={c.chapterName}
          selected={value === c.chapterId}
          onPress={() => onChange(c.chapterId)}
        />
      ))}
      <Pill label="Full tree" selected={value === "full"} onPress={() => onChange("full")} />
    </View>
  );
}
