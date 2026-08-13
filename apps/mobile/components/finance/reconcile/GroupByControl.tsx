/**
 * `Group by: None · Month · Person` — a small segmented control sitting
 * directly above the grid, next to the thing it restructures.
 *
 * Segmented rather than another `Pill` row: the three options are MUTUALLY
 * EXCLUSIVE, and this screen's pills are all multi-select filters. Reusing the
 * pill idiom for a one-of-three choice would teach that two of them can be on
 * at once, which is the vocabulary collision the header chips already cost
 * this screen once.
 *
 * "None" is a real option and the default, and picking it returns the grid to
 * EXACTLY what it renders today (no group headers, one flat list) — the safety
 * property this control is built around.
 */
import { Pressable, Text, View } from "react-native";
import type { ReconcileGroupBy } from "./gridView";

const OPTIONS: { value: ReconcileGroupBy | null; label: string }[] = [
  { value: null, label: "None" },
  { value: "month", label: "Month" },
  { value: "person", label: "Person" },
];

export function GroupByControl({
  value,
  onChange,
}: {
  value: ReconcileGroupBy | null;
  onChange: (next: ReconcileGroupBy | null) => void;
}) {
  return (
    <View className="flex-row items-center gap-2">
      <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
        Group by
      </Text>
      <View className="flex-row items-center overflow-hidden rounded-md border border-border-strong bg-raised">
        {OPTIONS.map((opt, i) => {
          const selected = value === opt.value;
          return (
            <Pressable
              key={opt.label}
              onPress={() => onChange(opt.value)}
              accessibilityRole="button"
              aria-pressed={selected}
              accessibilityLabel={`Group by ${opt.label}`}
              className={`px-2.5 py-1 active:opacity-70 web:hover:bg-sunken ${
                i > 0 ? "border-l border-border-strong" : ""
              } ${selected ? "bg-accent-soft" : ""}`}
            >
              <Text
                className={`text-xs ${
                  selected ? "font-semibold text-accent" : "font-medium text-muted"
                }`}
              >
                {opt.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
