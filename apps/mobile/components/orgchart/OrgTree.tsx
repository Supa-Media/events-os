import { ScrollView, Text, View } from "react-native";
import { colors } from "../../lib/theme";
import { SeatBox, SEAT_BOX_WIDTH } from "./SeatBox";
import type { TreeNode } from "./treeUtils";

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
  selectedKey,
  onSelect,
}: {
  root: TreeNode;
  selectedKey: string | null;
  onSelect: (node: TreeNode) => void;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator
      contentContainerStyle={{ paddingHorizontal: 24, paddingVertical: 24 }}
    >
      <RootLevel root={root} selectedKey={selectedKey} onSelect={onSelect} />
    </ScrollView>
  );
}

const STEM = 18; // vertical connector segment length (root→bar, bar→box)

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
            {firstLevel.map((child, i) => (
              <View key={child.key} style={{ alignItems: "flex-start" }}>
                <FirstLevelConnector
                  isFirst={i === 0}
                  isLast={i === firstLevel.length - 1}
                  solo={firstLevel.length === 1}
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
            ))}
          </View>
        </>
      ) : null}
    </View>
  );
}

/** The horizontal bar + drop stem above one first-level box. Anchored to a
 *  CONSTANT pixel offset (`SEAT_BOX_WIDTH / 2`, the box's own center) rather
 *  than a percentage — so it stays correct even though sibling columns are
 *  variable-width (a branch's own subtree can be much wider than one box). */
function FirstLevelConnector({
  isFirst,
  isLast,
  solo,
}: {
  isFirst: boolean;
  isLast: boolean;
  solo: boolean;
}) {
  const center = SEAT_BOX_WIDTH / 2;
  // The bar segment this column contributes to the shared horizontal line —
  // each column only draws from its OWN box-center to whichever edge(s)
  // touch a sibling, so adjoining columns' segments meet exactly at the
  // shared boundary regardless of how wide either column ends up being.
  const barStyle = isFirst
    ? { left: center, right: 0 } // leftmost: center → right edge
    : isLast
      ? { left: 0, width: center } // rightmost: left edge → center
      : { left: 0, right: 0 }; // middle: spans the full column
  return (
    <View style={{ height: STEM, width: SEAT_BOX_WIDTH }}>
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

const RAIL_X = 10; // rail x-position within the connector gutter
const ELBOW_STUB = 14; // horizontal stub length, rail → box
const GUTTER = RAIL_X + ELBOW_STUB;
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
