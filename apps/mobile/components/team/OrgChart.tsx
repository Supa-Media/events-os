/**
 * OrgChart — the classic boxes-and-connector-lines org tree, house-styled.
 *
 * Each person is a card; children hang below their manager off a vertical
 * stub, a horizontal rail, and per-child stubs (all 1px border-token lines).
 * Wide trees scroll horizontally inside the caller's ScrollView. Same data
 * the list view uses; purely a different projection of `childrenOf`.
 */
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

const LINE = { backgroundColor: colors.border } as const;
const STUB_H = 14;

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
  return (
    <View className="flex-row items-start justify-center gap-6 py-2">
      {roots.map((p) => (
        <ChartNode
          key={p._id}
          person={p}
          childrenOf={childrenOf}
          teamSize={teamSize}
          projectCount={projectCount}
          onOpen={onOpen}
          visited={new Set([p._id])}
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
  visited,
}: {
  person: OrgChartPerson;
  childrenOf: Map<Id<"people">, OrgChartPerson[]>;
  teamSize: Map<Id<"people">, number>;
  projectCount: Map<Id<"people">, number>;
  onOpen: (id: Id<"people">) => void;
  visited: Set<Id<"people">>;
}) {
  // Cycle-safe like every other tree walk (a corrupt edge must not hang the UI).
  const children = (childrenOf.get(person._id) ?? []).filter(
    (c) => !visited.has(c._id),
  );
  for (const c of children) visited.add(c._id);
  const reports = teamSize.get(person._id) ?? 0;
  const activeProjects = projectCount.get(person._id) ?? 0;

  return (
    <View className="items-center">
      <NodeCard
        person={person}
        reports={reports}
        activeProjects={activeProjects}
        onPress={() => onOpen(person._id)}
      />

      {children.length > 0 ? (
        <>
          {/* Stub down from the parent card. */}
          <View style={[LINE, { width: 1, height: STUB_H }]} />
          <View className="flex-row items-start">
            {children.map((child, i) => (
              <View key={child._id} className="items-center px-2">
                {/* Rail across the children row + stub down to each child.
                    First/last children only draw their inner half. */}
                <View className="w-full flex-row">
                  <View
                    style={[i > 0 ? LINE : null, { flex: 1, height: 1 }]}
                  />
                  <View
                    style={[
                      i < children.length - 1 ? LINE : null,
                      { flex: 1, height: 1 },
                    ]}
                  />
                </View>
                <View style={[LINE, { width: 1, height: STUB_H }]} />
                <ChartNode
                  person={child}
                  childrenOf={childrenOf}
                  teamSize={teamSize}
                  projectCount={projectCount}
                  onOpen={onOpen}
                  visited={visited}
                />
              </View>
            ))}
          </View>
        </>
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
      style={{ width: 168 }}
      className="items-center gap-1 rounded-lg border border-border bg-raised px-3 py-3 shadow-sm active:bg-sunken web:hover:border-border-strong"
    >
      <Avatar name={person.name || "?"} size={34} uri={person.imageUrl} />
      <Text
        className="text-center text-sm font-semibold text-ink"
        numberOfLines={1}
      >
        {person.name}
      </Text>
      {person.role ? (
        <Text className="text-center text-xs text-muted" numberOfLines={1}>
          {person.role}
        </Text>
      ) : null}
      {reports > 0 || activeProjects > 0 ? (
        <Text className="text-2xs font-semibold text-faint">
          {reports > 0
            ? `${reports} ${reports === 1 ? "report" : "reports"}`
            : ""}
          {reports > 0 && activeProjects > 0 ? " · " : ""}
          {activeProjects > 0 ? (
            <Text className="text-accent">
              {activeProjects} {activeProjects === 1 ? "project" : "projects"}
            </Text>
          ) : null}
        </Text>
      ) : null}
    </Pressable>
  );
}
