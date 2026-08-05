import { Pressable, Text, View } from "react-native";
import { Icon } from "../../ui";
import { colors } from "../../../lib/theme";

type Props = {
  label: string;
  /** The metric value. Defaults to an em-dash — these tiles are illustrative
   *  in the Phase-1 shell (card issuance ships later), so they never show
   *  fabricated numbers. */
  value?: string;
  meta?: string;
  /** Optional value color class (e.g. a warn tint) — unused while empty. */
  valueClassName?: string;
  /** Makes the tile a drill-in: adds a chevron plus the pressed/hover
   *  affordance. Omitted (the default) leaves it the plain read-only KPI it
   *  has always been — a tile with nowhere to go must not LOOK tappable. */
  onPress?: () => void;
};

/**
 * A single manager KPI tile from the prototype's Cards header row. In the
 * Phase-1 shell the value is a placeholder dash; the label + meta convey what
 * each number WILL mean once cards are live.
 *
 * A tile with an `onPress` drills into the rows behind its number (founder
 * feedback: "it shows the things flagged as personal expenses, but there's no
 * way for me to click and see the line items"). Everything is identical either
 * way except the chevron — the number stays the headline.
 */
export function CardTile({
  label,
  value = "—",
  meta,
  valueClassName = "text-ink",
  onPress,
}: Props) {
  const body = (
    <>
      <View className="flex-row items-center justify-between gap-2">
        <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
          {label}
        </Text>
        {onPress ? (
          <Icon name="chevron-right" size={14} color={colors.faint} />
        ) : null}
      </View>
      <Text
        className={`font-display text-2xl ${valueClassName}`}
        style={{ fontVariant: ["tabular-nums"] }}
      >
        {value}
      </Text>
      {meta ? <Text className="text-xs text-muted">{meta}</Text> : null}
    </>
  );

  const shell =
    "min-w-[150px] flex-1 gap-1.5 rounded-lg border border-border bg-raised p-4 shadow-card";

  if (!onPress) return <View className={shell}>{body}</View>;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${label} — view details`}
      className={`${shell} active:opacity-70 web:hover:border-accent`}
    >
      {body}
    </Pressable>
  );
}
