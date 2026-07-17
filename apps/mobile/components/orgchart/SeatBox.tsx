import { Pressable, Text, View } from "react-native";
import { colors } from "../../lib/theme";
import type { TreeNode } from "./treeUtils";

/** Fixed seat-box width — every box in the tree shares it so the horizontal
 *  first-level connector bar (see `OrgTree`) can anchor to a constant
 *  "box-center" pixel offset regardless of how wide a branch's own subtree
 *  grows underneath it. */
export const SEAT_BOX_WIDTH = 188;

/**
 * One seat box: small-caps title, a holder line (filled dot + name, "N
 * people" for a multi-holder seat, or a hollow dot + italic muted "Vacant"),
 * and — for a `derived` seat (today only Chapter Directors) — a dashed
 * border plus a "mirrors each chapter" hint. Tapping selects it for the
 * detail panel; one person legitimately appears in several boxes (pre-split
 * reality), so this never tries to dedupe holders across boxes.
 */
export function SeatBox({
  node,
  selected,
  onPress,
}: {
  node: TreeNode;
  selected: boolean;
  onPress: () => void;
}) {
  const { seat } = node;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${seat.title}${seat.vacant ? ", vacant" : ""}`}
      onPress={onPress}
      style={{ width: SEAT_BOX_WIDTH }}
      className={`gap-1 rounded-md border bg-raised px-3 py-2 shadow-card ${
        selected ? "border-accent" : "border-border"
      } ${seat.derived ? "border-dashed" : ""}`}
    >
      <Text
        className="text-2xs font-bold uppercase tracking-wider text-muted"
        numberOfLines={1}
      >
        {seat.title}
      </Text>

      {seat.vacant ? (
        <View className="flex-row items-center gap-1.5">
          <View
            style={{
              width: 8,
              height: 8,
              borderRadius: 4,
              borderWidth: 1.5,
              borderColor: colors.faint,
            }}
          />
          <Text className="text-xs italic text-faint">Vacant</Text>
        </View>
      ) : (
        <View className="flex-row items-center gap-1.5">
          <View
            style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.success }}
          />
          <Text className="flex-1 text-xs text-ink" numberOfLines={1}>
            {seat.holders.length === 1 ? seat.holders[0].name : `${seat.holders.length} people`}
          </Text>
        </View>
      )}

      {seat.derived ? (
        <Text className="text-2xs italic text-faint">mirrors each chapter</Text>
      ) : null}
    </Pressable>
  );
}
