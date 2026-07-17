/**
 * OrgChart — the hybrid org tree, house-styled.
 *
 * The root sits on top; their DIRECT reports fan out HORIZONTALLY beneath it
 * (a rail with a drop into each column, drawio-style); everything below a
 * direct stacks VERTICALLY — indented cards hung off a spine with elbow
 * connectors — so wide leadership rows stay scannable while deep teams stay
 * compact. Cards are one-line: avatar, name, title, rollup counts. Purely a
 * different projection of the same `childrenOf` the list view uses; cycles
 * are pruned once in a memo so the recursive render stays pure.
 */
import { useMemo } from "react";
import { View, Text, Pressable } from "react-native";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Avatar } from "../ui";
import { colors } from "../../lib/theme";

export type OrgChartPerson = {
  _id: Id<"people">;
  name: string;
  /** Seat title(s) if the person holds any, else their legacy `role` — see
   *  `hasSeatTitle` for which one this is (mirrors the List view's #188
   *  title-source pattern). */
  title: string | null;
  hasSeatTitle: boolean;
  imageUrl?: string | null;
};

const CARD_W = 252;
/** Fixed card height — the connector math depends on it, so cards without a
 *  role line keep the same box instead of detaching their connectors. */
const CARD_H = 48;
/** Vertical drop from the horizontal rail down into each direct's card. */
const DROP_H = 14;
/** Horizontal breathing room between sibling columns. */
const COL_GAP = 16;
/** Vertical-tree spacing: gap above each card; elbow meets its center. */
const GAP_Y = 6;
const ELBOW_Y = GAP_Y + CARD_H / 2;
const INDENT = 14;
const TICK_W = 12;
const LINE = { backgroundColor: colors.border } as const;

type TreeMaps = {
  childrenOf: Map<Id<"people">, OrgChartPerson[]>;
  teamSize: Map<Id<"people">, number>;
  projectCount: Map<Id<"people">, number>;
  onOpen: (id: Id<"people">) => void;
};

export function OrgChart({
  roots,
  childrenOf,
  teamSize,
  projectCount,
  onOpen,
}: {
  roots: OrgChartPerson[];
} & Omit<TreeMaps, "childrenOf"> & {
    childrenOf: Map<Id<"people">, OrgChartPerson[]>;
  }) {
  // Prune cycles/diamonds ONCE into plain data so the recursive render stays
  // pure — mutating a shared visited set during render breaks under
  // StrictMode double-renders and makes duplicate-edge layout order-dependent.
  const prunedChildrenOf = useMemo(() => {
    const pruned = new Map<Id<"people">, OrgChartPerson[]>();
    const visited = new Set<Id<"people">>(roots.map((r) => r._id));
    const queue = [...roots];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      const kids = (childrenOf.get(cur._id) ?? []).filter(
        (c) => !visited.has(c._id),
      );
      for (const c of kids) visited.add(c._id);
      pruned.set(cur._id, kids);
      queue.push(...kids);
    }
    return pruned;
  }, [roots, childrenOf]);

  const maps: TreeMaps = {
    childrenOf: prunedChildrenOf,
    teamSize,
    projectCount,
    onOpen,
  };

  return (
    <View style={{ gap: 28 }} className="py-1">
      {roots.map((root) => (
        <RootTree key={root._id} root={root} maps={maps} />
      ))}
    </View>
  );
}

/** One root: card on top, directs as horizontal columns, subtrees vertical. */
function RootTree({ root, maps }: { root: OrgChartPerson; maps: TreeMaps }) {
  const directs = maps.childrenOf.get(root._id) ?? [];

  return (
    <View className="self-start">
      <Card person={root} maps={maps} />

      {directs.length > 0 ? (
        <>
          {/* Drop from the root's card down to the rail. */}
          <View style={[LINE, { width: 1, height: DROP_H, marginLeft: CARD_W / 2 }]} />
          <View className="flex-row items-start">
            {directs.map((direct, i) => {
              const first = i === 0;
              const last = i === directs.length - 1;
              return (
                <View key={direct._id}>
                  {/* Rail: each column draws its slice — up to its drop point
                      (skipped on the first column) and onward to its right
                      edge (skipped on the last), so the line runs unbroken
                      between the first and last drops whatever each
                      column's subtree width is. */}
                  <View style={{ flexDirection: "row", height: 1 }}>
                    <View
                      style={[{ width: CARD_W / 2, height: 1 }, first ? null : LINE]}
                    />
                    <View style={[{ flex: 1, height: 1 }, last ? null : LINE]} />
                  </View>
                  {/* Drop into this direct's card. */}
                  <View
                    style={[LINE, { width: 1, height: DROP_H, marginLeft: CARD_W / 2 }]}
                  />
                  {/* The column: the direct + their team, vertical from here. */}
                  <View style={{ paddingRight: last ? 0 : COL_GAP }}>
                    <VerticalNode person={direct} maps={maps} />
                  </View>
                </View>
              );
            })}
          </View>
        </>
      ) : null}
    </View>
  );
}

/** Depth ≥ 1: a card with its team stacked vertically off a spine + elbows. */
function VerticalNode({
  person,
  maps,
}: {
  person: OrgChartPerson;
  maps: TreeMaps;
}) {
  const children = maps.childrenOf.get(person._id) ?? [];

  return (
    <View>
      <Card person={person} maps={maps} />

      {children.length > 0 ? (
        <View style={{ marginLeft: INDENT }}>
          {children.map((child, i) => (
            <View key={child._id} className="flex-row items-stretch">
              {/* Spine: runs the full sibling row, stopping at the elbow on
                  the last child so the line doesn't dangle past the tree. */}
              <View
                style={[
                  LINE,
                  { width: 1 },
                  i === children.length - 1
                    ? { height: ELBOW_Y }
                    : { alignSelf: "stretch" },
                ]}
              />
              {/* Elbow into this card's vertical center. */}
              <View
                style={[LINE, { width: TICK_W, height: 1, marginTop: ELBOW_Y }]}
              />
              <View style={{ paddingTop: GAP_Y, flexShrink: 1 }}>
                <VerticalNode person={child} maps={maps} />
              </View>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function Card({ person, maps }: { person: OrgChartPerson; maps: TreeMaps }) {
  const reports = maps.teamSize.get(person._id) ?? 0;
  const activeProjects = maps.projectCount.get(person._id) ?? 0;
  return (
    <Pressable
      onPress={() => maps.onOpen(person._id)}
      style={{ width: CARD_W, height: CARD_H }}
      className="flex-row items-center gap-2.5 rounded-lg border border-border bg-raised px-3 shadow-sm active:bg-sunken web:hover:border-border-strong"
    >
      <Avatar name={person.name || "?"} size={28} uri={person.imageUrl} />
      <View className="flex-1">
        <Text className="text-sm font-semibold text-ink" numberOfLines={1}>
          {person.name}
        </Text>
        {person.title ? (
          <Text
            className={`text-xs ${
              person.hasSeatTitle ? "text-muted" : "italic text-faint"
            }`}
            numberOfLines={1}
          >
            {person.title}
          </Text>
        ) : null}
      </View>
      {reports > 0 || activeProjects > 0 ? (
        <View className="items-end">
          {reports > 0 ? (
            <Text className="text-2xs font-semibold text-muted">
              {reports} {reports === 1 ? "rep" : "reps"}
            </Text>
          ) : null}
          {activeProjects > 0 ? (
            <Text className="text-2xs font-semibold text-accent">
              {activeProjects} proj
            </Text>
          ) : null}
        </View>
      ) : null}
    </Pressable>
  );
}
