import { Text, View } from "react-native";

type Props = {
  label: string;
  /** The metric value. Defaults to an em-dash — these tiles are illustrative
   *  in the Phase-1 shell (card issuance ships later), so they never show
   *  fabricated numbers. */
  value?: string;
  meta?: string;
  /** Optional value color class (e.g. a warn tint) — unused while empty. */
  valueClassName?: string;
};

/**
 * A single manager KPI tile from the prototype's Cards header row. In the
 * Phase-1 shell the value is a placeholder dash; the label + meta convey what
 * each number WILL mean once cards are live.
 */
export function CardTile({
  label,
  value = "—",
  meta,
  valueClassName = "text-ink",
}: Props) {
  return (
    <View className="min-w-[150px] flex-1 gap-1.5 rounded-lg border border-border bg-raised p-4 shadow-card">
      <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
        {label}
      </Text>
      <Text
        className={`font-display text-2xl ${valueClassName}`}
        style={{ fontVariant: ["tabular-nums"] }}
      >
        {value}
      </Text>
      {meta ? <Text className="text-xs text-muted">{meta}</Text> : null}
    </View>
  );
}
