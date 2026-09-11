import { Pressable, Text, View } from "react-native";
import { Icon } from "../ui";
import { colors } from "../../lib/theme";
import type { TreeNode } from "./treeUtils";

/** Fixed seat-box width — every box in the tree shares it so the horizontal
 *  first-level connector bar (see `OrgTree`) can anchor to a constant
 *  "box-center" pixel offset regardless of how wide a branch's own subtree
 *  grows underneath it. */
export const SEAT_BOX_WIDTH = 188;

/** Collapse-chevron geometry. It OVERLAYS the box's title row (absolute, a
 *  sibling of the box's own Pressable) instead of sitting in the flex flow,
 *  which keeps it out of that Pressable — see this file's doc comment — and
 *  `CHEVRON_INSET` is the padding the title row gives up to make room. The
 *  x/y line it up with the title's own baseline inside the box's `px-3 py-2`. */
const CHEVRON_SIZE = 13;
const CHEVRON_X = 10;
const CHEVRON_Y = 9;
const CHEVRON_INSET = 15;

/**
 * One seat box: small-caps title, a holder line (filled dot + name, "N
 * people" for a multi-holder seat, or a hollow dot + italic muted "Vacant"),
 * and — for a `derived` seat (today only Chapter Directors) — a dashed
 * border plus a "mirrors each chapter" hint. Tapping selects it for the
 * detail panel; one person legitimately appears in several boxes (pre-split
 * reality), so this never tries to dedupe holders across boxes.
 *
 * In structure-edit mode (`onAddSeat` provided), a small "+" affix appears
 * bottom-right — the per-parent "add a seat under this one" affordance —
 * without disturbing the box's own tap target for selection.
 *
 * A box with reports under it also carries a COLLAPSE chevron
 * (`onToggleCollapse`) leading its title. Two things decide how it's drawn:
 *  - It is a SIBLING of the box's Pressable, not a child — nesting one
 *    role="button" inside another is what a screen reader then has to make
 *    sense of, the same reason the "+" affix is a sibling.
 *  - It is positioned INSIDE the box's own bounds rather than hanging off a
 *    corner like the "+", because a first-level column can be exactly one box
 *    wide, and anything overhanging a box's left edge lands on the NEIGHBOURING
 *    column's box. So it overlays the title row, which gives up `CHEVRON_INSET`
 *    of left padding for it.
 * Collapsed, the title row's trailing "+N" says how many seats are folded
 * away, so a folded branch declares its size instead of just disappearing. */
export function SeatBox({
  node,
  selected,
  onPress,
  onAddSeat,
  collapsed = false,
  hiddenCount = 0,
  onToggleCollapse,
}: {
  node: TreeNode;
  selected: boolean;
  onPress: () => void;
  /** Present only in structure-edit mode — renders the "+" affix. */
  onAddSeat?: (node: TreeNode) => void;
  /** True when this box's reports are folded away. */
  collapsed?: boolean;
  /** Seats hidden by that fold (every descendant, not just direct reports) —
   *  shown as "+N" so a folded branch still declares its size. */
  hiddenCount?: number;
  /** Omitted for a leaf (nothing to fold) — no chevron is rendered then. */
  onToggleCollapse?: () => void;
}) {
  const { seat } = node;

  return (
    <View style={{ width: SEAT_BOX_WIDTH }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${seat.title}${seat.vacant ? ", vacant" : ""}`}
        onPress={onPress}
        // The canvas's own background sets `cursor: grab` (click-drag pans
        // the chart) — this override keeps a seat box reading as clickable,
        // not draggable, since `cursor` otherwise inherits from the canvas.
        style={{ cursor: "pointer" } as any}
        className={`gap-1 rounded-md border bg-raised px-3 py-2 shadow-card ${
          selected ? "border-accent" : "border-border"
        } ${seat.derived ? "border-dashed" : ""}`}
      >
        <View
          className="flex-row items-center gap-1"
          // Room for the collapse chevron, which overlays this row's left
          // edge (see below) rather than sitting in the flex flow.
          style={onToggleCollapse ? { paddingLeft: CHEVRON_INSET } : undefined}
        >
          <Text
            className="flex-1 text-2xs font-bold uppercase tracking-wider text-muted"
            numberOfLines={1}
          >
            {seat.title}
          </Text>
          {collapsed && hiddenCount > 0 ? (
            <Text className="text-2xs font-bold text-accent">+{hiddenCount}</Text>
          ) : null}
        </View>

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

      {onToggleCollapse ? (
        <Pressable
          accessibilityRole="button"
          // `accessibilityState` does not survive react-native-web's
          // forwarded-prop list; `aria-expanded` is what actually reaches the
          // DOM. Both, so native and web each announce the fold state. See
          // `__tests__/toggleAria.test.js` for how this was learned.
          aria-expanded={!collapsed}
          accessibilityState={{ expanded: !collapsed }}
          accessibilityLabel={
            collapsed
              ? `Expand ${seat.title}'s reports, ${hiddenCount} hidden`
              : `Collapse ${seat.title}'s reports`
          }
          onPress={onToggleCollapse}
          hitSlop={10}
          style={
            {
              position: "absolute",
              left: CHEVRON_X,
              top: CHEVRON_Y,
              cursor: "pointer",
            } as any
          }
        >
          <Icon
            name={collapsed ? "chevron-right" : "chevron-down"}
            size={CHEVRON_SIZE}
            color={collapsed ? colors.accent : colors.muted}
          />
        </Pressable>
      ) : null}

      {onAddSeat ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Add a seat under ${seat.title}`}
          onPress={() => onAddSeat(node)}
          hitSlop={6}
          style={{ cursor: "pointer" } as any}
          className="absolute -bottom-2.5 -right-2.5 h-6 w-6 items-center justify-center rounded-pill border border-accent bg-raised shadow-card"
        >
          <Icon name="plus" size={13} color={colors.accent} />
        </Pressable>
      ) : null}
    </View>
  );
}
