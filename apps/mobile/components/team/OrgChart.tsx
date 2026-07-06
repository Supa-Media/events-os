/**
 * OrgChart — a compact VERTICAL org tree, house-styled.
 *
 * Reports stack vertically under their manager, indented one step, hung off
 * a vertical spine with an elbow into each card (the drawio-style layout) —
 * far denser than a horizontal fan for real org shapes. Cards are one-line:
 * avatar, name, role, rollup counts. Purely a different projection of the
 * same `childrenOf` the list view uses; cycles are pruned once in a memo so
 * the recursive render stays pure.
 */
import { useMemo } from "react";
import { View, Text, Pressable } from "react-native";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Avatar } from "../ui";
import { colors } from "../../lib/theme";

export type OrgChartPerson = {
  _id: Id<"people">;
  name: string;
  role: string | null;
  imageUrl?: string | null;
};

const CARD_W = 252;
/** Gap above each sibling card; the elbow meets the card's vertical center. */
const GAP_Y = 6;
const CARD_HALF = 23;
const ELBOW_Y = GAP_Y + CARD_HALF;
const INDENT = 14;
const TICK_W = 12;
const LINE = { backgroundColor: colors.border } as const;

export function OrgChart({
  roots,
  childrenOf,
  teamSize,
  projectCount,
  onOpen,
}: {
  roots: OrgChartPerson[];
  childrenOf: Map<Id<"people">, OrgChartPerson[]>;
  teamSize: Map<Id<"people">, number>;
  projectCount: Map<Id<"people">, number>;
  onOpen: (id: Id<"people">) => void;
}) {
  // Prune cycles/diamonds ONCE into plain data so ChartNode's render stays
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

  return (
    <View style={{ gap: 16 }} className="py-1">
      {roots.map((p) => (
        <ChartNode
          key={p._id}
          person={p}
          childrenOf={prunedChildrenOf}
          teamSize={teamSize}
          projectCount={projectCount}
          onOpen={onOpen}
        />
      ))}
    </View>
  );
}

function ChartNode({
  person,
  childrenOf,
  teamSize,
  projectCount,
  onOpen,
}: {
  person: OrgChartPerson;
  /** Already cycle-pruned by OrgChart — pure tree, safe to recurse. */
  childrenOf: Map<Id<"people">, OrgChartPerson[]>;
  teamSize: Map<Id<"people">, number>;
  projectCount: Map<Id<"people">, number>;
  onOpen: (id: Id<"people">) => void;
}) {
  const children = childrenOf.get(person._id) ?? [];

  return (
    <View>
      <NodeCard
        person={person}
        reports={teamSize.get(person._id) ?? 0}
        activeProjects={projectCount.get(person._id) ?? 0}
        onPress={() => onOpen(person._id)}
      />

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
              <View style={[LINE, { width: TICK_W, height: 1, marginTop: ELBOW_Y }]} />
              <View style={{ paddingTop: GAP_Y, flexShrink: 1 }}>
                <ChartNode
                  person={child}
                  childrenOf={childrenOf}
                  teamSize={teamSize}
                  projectCount={projectCount}
                  onOpen={onOpen}
                />
              </View>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function NodeCard({
  person,
  reports,
  activeProjects,
  onPress,
}: {
  person: OrgChartPerson;
  reports: number;
  activeProjects: number;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={{ width: CARD_W }}
      className="flex-row items-center gap-2.5 rounded-lg border border-border bg-raised px-3 py-2 shadow-sm active:bg-sunken web:hover:border-border-strong"
    >
      <Avatar name={person.name || "?"} size={28} uri={person.imageUrl} />
      <View className="flex-1">
        <Text className="text-sm font-semibold text-ink" numberOfLines={1}>
          {person.name}
        </Text>
        {person.role ? (
          <Text className="text-xs text-muted" numberOfLines={1}>
            {person.role}
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
