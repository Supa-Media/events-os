import { ScrollView, Text, View } from "react-native";
import { colors } from "../../lib/theme";
import { SeatBox, SEAT_BOX_WIDTH } from "./SeatBox";
import { subtreeDepth, type TreeNode } from "./treeUtils";

/**
 * The tree canvas: root box top-center, its FIRST level of reports laid out
 * horizontally underneath with the classic "T" connector, and every level
 * below THAT rendered as a vertical, indented stack with elbow connectors
 * (space-efficient — reads as "these all report to the box above").
 *
 * Owns its OWN horizontal scroll (the page body never scrolls sideways) —
 * branches can be much wider than the screen, especially the Expansion
 * Director branch in the Full tree view once every chapter's subtree is
 * grafted underneath it.
 */
export function OrgTree({
  root,
  orphans,
  selectedKey,
  onSelect,
}: {
  root: TreeNode;
  orphans: TreeNode[];
  selectedKey: string | null;
  onSelect: (node: TreeNode) => void;
}) {
  return (
    <View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator
        contentContainerStyle={{ paddingHorizontal: 24, paddingVertical: 24 }}
      >
        <RootLevel root={root} selectedKey={selectedKey} onSelect={onSelect} />
      </ScrollView>
      {orphans.length > 0 ? (
        <UnplacedStrip orphans={orphans} selectedKey={selectedKey} onSelect={onSelect} />
      ) : null}
    </View>
  );
}

/** Seats present in the payload but unreachable from the tree root (see
 *  `treeUtils.findOrphanSeats`) — a partially-applied structure edit can
 *  transiently produce these. Rendered as a flat, muted strip at the bottom
 *  of the canvas instead of silently vanishing, so a broken structure edit
 *  is visible instead of invisible. */
function UnplacedStrip({
  orphans,
  selectedKey,
  onSelect,
}: {
  orphans: TreeNode[];
  selectedKey: string | null;
  onSelect: (node: TreeNode) => void;
}) {
  return (
    <View
      style={{
        borderTopWidth: 1,
        borderTopColor: colors.border,
        paddingHorizontal: 24,
        paddingVertical: 16,
      }}
    >
      <Text className="mb-2 text-2xs font-bold uppercase tracking-wider text-faint">
        Unplaced ({orphans.length})
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, opacity: 0.6 }}>
        {orphans.map((node) => (
          <SeatBox
            key={node.key}
            node={node}
            selected={node.key === selectedKey}
            onPress={() => onSelect(node)}
          />
        ))}
      </View>
    </View>
  );
}

const STEM = 18; // vertical connector segment length (root→bar, bar→box)
const RAIL_X = 10; // rail x-position within the connector gutter
const ELBOW_STUB = 14; // horizontal stub length, rail → box
const GUTTER = RAIL_X + ELBOW_STUB; // indent added per nested VerticalChildren level

/** Root box + its first-level reports, laid out horizontally with the
 *  classic top-down "T" connector: one stem from the root down to a bar, the
 *  bar spanning from the first child's center to the last child's center,
 *  and a drop stem from the bar into each child's box. */
function RootLevel({
  root,
  selectedKey,
  onSelect,
}: {
  root: TreeNode;
  selectedKey: string | null;
  onSelect: (node: TreeNode) => void;
}) {
  const firstLevel = root.children;
  return (
    <View style={{ alignItems: "center" }}>
      <SeatBox node={root} selected={root.key === selectedKey} onPress={() => onSelect(root)} />

      {firstLevel.length > 0 ? (
        <>
          <View style={{ width: 1, height: STEM, backgroundColor: colors.border }} />
          <View style={{ flexDirection: "row" }}>
            {firstLevel.map((child, i) => {
              // A column's TRUE rendered width — SEAT_BOX_WIDTH plus one
              // GUTTER per nested VerticalChildren level below it. Computed
              // (not measured) so the T-bar can be sized deterministically in
              // the same pass, and set explicitly on the column so its
              // rendered width can never drift from what the bar assumes.
              const width = SEAT_BOX_WIDTH + subtreeDepth(child) * GUTTER;
              return (
                <View key={child.key} style={{ alignItems: "flex-start", width }}>
                  <FirstLevelConnector
                    isFirst={i === 0}
                    isLast={i === firstLevel.length - 1}
                    solo={firstLevel.length === 1}
                    width={width}
                  />
                  <SeatBox
                    node={child}
                    selected={child.key === selectedKey}
                    onPress={() => onSelect(child)}
                  />
                  {child.children.length > 0 ? (
                    <View style={{ marginTop: 8 }}>
                      <VerticalChildren
                        nodes={child.children}
                        selectedKey={selectedKey}
                        onSelect={onSelect}
                      />
                    </View>
                  ) : null}
                </View>
              );
            })}
          </View>
        </>
      ) : null}
    </View>
  );
}

/** The horizontal bar + drop stem above one first-level box. The drop stem is
 *  anchored to a CONSTANT pixel offset (`SEAT_BOX_WIDTH / 2`, the box's own
 *  center — the box is always left-aligned within its column). The BAR,
 *  though, must reach the column's TRUE right/left edge to meet a
 *  neighboring column's segment — so `width` is the column's actual
 *  rendered width (`SEAT_BOX_WIDTH` + one gutter per nested level below it,
 *  see `RootLevel`), not a hardcoded `SEAT_BOX_WIDTH`. Getting this wrong is
 *  invisible for `isFirst`/`isLast` columns (their bar only needs to reach
 *  the box's own center) but leaves a visible gap over any MIDDLE column
 *  whose subtree is wider than one box (e.g. a chapter's `music_lead` /
 *  `event_lead`, each one level deep). */
function FirstLevelConnector({
  isFirst,
  isLast,
  solo,
  width,
}: {
  isFirst: boolean;
  isLast: boolean;
  solo: boolean;
  width: number;
}) {
  const center = SEAT_BOX_WIDTH / 2;
  // The bar segment this column contributes to the shared horizontal line —
  // each column draws from its OWN box-center to whichever edge(s) touch a
  // sibling, using the column's TRUE width so adjoining columns' segments
  // meet exactly at the shared boundary regardless of how wide either column
  // ends up being.
  const barStyle = isFirst
    ? { left: center, right: 0 } // leftmost: center → true right edge
    : isLast
      ? { left: 0, width: center } // rightmost: left edge → center
      : { left: 0, right: 0 }; // middle: spans the full (true) column width
  return (
    <View style={{ height: STEM, width }}>
      {!solo ? (
        <View
          style={{
            position: "absolute",
            top: 0,
            height: 1,
            backgroundColor: colors.border,
            ...barStyle,
          }}
        />
      ) : null}
      <View
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: center,
          width: 1,
          backgroundColor: colors.border,
        }}
      />
    </View>
  );
}

// ── Vertical stack (every level below the first) ────────────────────────────

const ROW_HEAD_H = 60; // connector height — matches one seat box's rendered height

function VerticalChildren({
  nodes,
  selectedKey,
  onSelect,
}: {
  nodes: TreeNode[];
  selectedKey: string | null;
  onSelect: (node: TreeNode) => void;
}) {
  return (
    <View>
      {nodes.map((node, i) => (
        <VerticalRow
          key={node.key}
          node={node}
          isLast={i === nodes.length - 1}
          selectedKey={selectedKey}
          onSelect={onSelect}
        />
      ))}
    </View>
  );
}

/** One row in a vertical stack: an indented-left-rail + elbow connector into
 *  the box, then the box's OWN children recursing as a further-indented
 *  vertical stack underneath. The connector column has a FIXED height
 *  (`ROW_HEAD_H`, just this row's own box) so it's never stretched by a
 *  deep subtree hanging below it — descendants render in the sibling content
 *  column, not inside the connector's box. */
function VerticalRow({
  node,
  isLast,
  selectedKey,
  onSelect,
}: {
  node: TreeNode;
  isLast: boolean;
  selectedKey: string | null;
  onSelect: (node: TreeNode) => void;
}) {
  return (
    <View style={{ flexDirection: "row" }}>
      <View style={{ width: GUTTER, height: ROW_HEAD_H }}>
        <View
          style={{
            position: "absolute",
            left: RAIL_X,
            top: 0,
            bottom: isLast ? ROW_HEAD_H / 2 : 0,
            width: 1,
            backgroundColor: colors.border,
          }}
        />
        <View
          style={{
            position: "absolute",
            left: RAIL_X,
            top: ROW_HEAD_H / 2,
            width: ELBOW_STUB,
            height: 1,
            backgroundColor: colors.border,
          }}
        />
      </View>
      <View style={{ paddingBottom: 8 }}>
        {node.chapterLabel ? <ChapterLabel name={node.chapterLabel} /> : null}
        <SeatBox node={node} selected={node.key === selectedKey} onPress={() => onSelect(node)} />
        {node.children.length > 0 ? (
          <View style={{ marginTop: 4 }}>
            <VerticalChildren nodes={node.children} selectedKey={selectedKey} onSelect={onSelect} />
          </View>
        ) : null}
      </View>
    </View>
  );
}

/** The small eyebrow label above a chapter's root box when its whole subtree
 *  is grafted into the Full tree view — the one visual cue distinguishing an
 *  otherwise identically-shaped chapter branch. */
function ChapterLabel({ name }: { name: string }) {
  return (
    <Text className="mb-1 text-2xs font-bold uppercase tracking-wider text-accent">{name}</Text>
  );
}
