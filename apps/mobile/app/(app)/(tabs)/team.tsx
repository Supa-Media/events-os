/**
 * TEAM — the org-hierarchy view of the chapter.
 *
 * Managers see the people they manage as a collapsible tree built from the
 * People tab's Manager column: reports nest under their manager, transitively,
 * so a director can zoom out and see the whole structure. Each node rolls up
 * how many people and projects sit under it; tapping a person drills into
 * their workload page (their projects + everything their subtree owns).
 *
 * Who sees what is decided SERVER-SIDE by `org.overview`: chapter admins get
 * the whole roster (plus the Unassigned-projects triage section), managers get
 * exactly their own subtree, and everyone else gets nothing (the nav entry is
 * hidden for them too). `projects.list` is scoped the same way.
 */
import { useMemo, useState } from "react";
import { View, Text, Pressable } from "react-native";
import { useRouter } from "expo-router";
import { useQuery, useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  Screen,
  Narrow,
  Avatar,
  Icon,
  Button,
  EmptyState,
  SectionHeader,
} from "../../../components/ui";
import {
  ProjectCard,
  buildProjectTree,
} from "../../../components/team/ProjectCard";
import { colors, spacing } from "../../../lib/theme";
import { alertError } from "../../../lib/errors";

type Overview = FunctionReturnType<typeof api.org.overview>;
type Person = Overview["people"][number];

export default function TeamScreen() {
  const router = useRouter();
  const overview = useQuery(api.org.overview);
  const projects = useQuery(api.projects.list);
  const createProject = useMutation(api.projects.create);

  // The org chart covers team members plus anyone wired into a manager
  // relationship (so a report who isn't flagged Team yet still shows up).
  // `overview.people` is already scoped server-side (chapter for admins,
  // the caller's subtree for managers).
  const org = useMemo(() => {
    const roster = overview?.people ?? [];
    const managerIds = new Set(
      roster.map((p) => p.managerId).filter((id): id is Id<"people"> => !!id),
    );
    const included = roster.filter(
      (p) => p.isTeamMember || p.managerId != null || managerIds.has(p._id),
    );
    const includedIds = new Set(included.map((p) => p._id));
    const childrenOf = new Map<Id<"people">, Person[]>();
    for (const p of included) {
      if (!p.managerId || !includedIds.has(p.managerId)) continue;
      const list = childrenOf.get(p.managerId) ?? [];
      list.push(p);
      childrenOf.set(p.managerId, list);
    }
    const roots = included.filter(
      (p) => !p.managerId || !includedIds.has(p.managerId),
    );

    // Subtree sizes (people below each node), cycle-safe via visited set.
    const teamSize = new Map<Id<"people">, number>();
    const sizeOf = (id: Id<"people">, visited: Set<Id<"people">>): number => {
      if (visited.has(id)) return 0;
      visited.add(id);
      let n = 0;
      for (const child of childrenOf.get(id) ?? []) {
        n += 1 + sizeOf(child._id, visited);
      }
      teamSize.set(id, n);
      return n;
    };
    for (const r of roots) sizeOf(r._id, new Set());

    roots.sort(
      (a, b) =>
        (teamSize.get(b._id) ?? 0) - (teamSize.get(a._id) ?? 0) ||
        a.name.localeCompare(b.name),
    );
    for (const list of childrenOf.values()) {
      list.sort(
        (a, b) =>
          (teamSize.get(b._id) ?? 0) - (teamSize.get(a._id) ?? 0) ||
          a.name.localeCompare(b.name),
      );
    }
    return { included, includedIds, childrenOf, roots, teamSize };
  }, [overview]);

  // Project rollups: how many (non-done) projects each person's subtree owns.
  const projectCount = useMemo(() => {
    const owned = new Map<Id<"people">, number>();
    for (const p of projects ?? []) {
      if (!p.ownerPersonId || p.status === "done") continue;
      owned.set(p.ownerPersonId, (owned.get(p.ownerPersonId) ?? 0) + 1);
    }
    const rollup = new Map<Id<"people">, number>();
    const count = (id: Id<"people">, visited: Set<Id<"people">>): number => {
      if (visited.has(id)) return 0;
      visited.add(id);
      let n = owned.get(id) ?? 0;
      for (const child of org.childrenOf.get(id) ?? []) {
        n += count(child._id, visited);
      }
      rollup.set(id, n);
      return n;
    };
    for (const r of org.roots) count(r._id, new Set());
    return rollup;
  }, [projects, org]);

  const peopleById = useMemo(
    () => new Map((overview?.people ?? []).map((p) => [p._id, p.name])),
    [overview],
  );
  // Triage list: root projects nobody owns, plus ones owned by a roster
  // person who isn't in the org chart — otherwise those vanish from every
  // Team surface (no OrgNode rolls them up).
  const unassigned = useMemo(
    () =>
      (projects ?? []).filter(
        (p) =>
          !p.parentProjectId &&
          (!p.ownerPersonId || !org.includedIds.has(p.ownerPersonId)),
      ),
    [projects, org],
  );
  const projectTree = useMemo(
    () => buildProjectTree(projects ?? []),
    [projects],
  );

  if (overview === undefined || projects === undefined) {
    return <Screen loading />;
  }

  if (!overview.canManage) {
    return (
      <Screen>
        <Narrow>
          <EmptyState
            title="Nothing to manage yet"
            message="This view unlocks when people report to you — ask a chapter admin to set the Manager column in the People tab."
          />
        </Narrow>
      </Screen>
    );
  }

  const hasHierarchy = org.childrenOf.size > 0;

  return (
    <Screen>
      <Narrow>
        <View
          style={{
            flexDirection: "row",
            alignItems: "baseline",
            justifyContent: "space-between",
            marginBottom: spacing.md,
          }}
        >
          <Text className="font-display text-2xl text-ink">Team</Text>
          <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
            {org.included.length} people
          </Text>
        </View>

        {org.included.length === 0 ? (
          <EmptyState
            title="No team yet"
            message="Flag your core team in the People tab (the Team column), then set each person's Manager to build the hierarchy."
          />
        ) : (
          <>
            {!hasHierarchy && overview.isAdmin ? (
              <Text className="mb-4 text-sm text-muted">
                Set the Manager column in the People tab to nest reports under
                their manager — tap anyone to see their projects.
              </Text>
            ) : null}
            <View className="overflow-hidden rounded-lg border border-border bg-raised px-2 py-1.5">
              {org.roots.map((p) => (
                <OrgNode
                  key={p._id}
                  person={p}
                  childrenOf={org.childrenOf}
                  teamSize={org.teamSize}
                  projectCount={projectCount}
                  onOpen={(id) => router.push(`/team/${id}` as any)}
                />
              ))}
            </View>
          </>
        )}

        {/* Org-level triage (admins only): work nobody owns yet. */}
        {overview.isAdmin && unassigned.length > 0 ? (
          <>
            <SectionHeader
              title="Unassigned projects"
              count={unassigned.length}
              right={
                <Button
                  title="New project"
                  icon="plus"
                  size="sm"
                  variant="secondary"
                  onPress={() =>
                    void createProject({ name: "New project" }).catch(alertError)
                  }
                />
              }
            />
            <View style={{ gap: spacing.sm }}>
              {unassigned.map((p) => (
                <ProjectCard
                  key={p._id}
                  project={p}
                  childrenOf={projectTree}
                  peopleById={peopleById}
                  showOwner
                />
              ))}
            </View>
          </>
        ) : overview.isAdmin && org.included.length > 0 ? (
          <View className="mt-4 flex-row justify-end">
            <Button
              title="New project"
              icon="plus"
              size="sm"
              variant="secondary"
              onPress={() =>
                    void createProject({ name: "New project" }).catch(alertError)
                  }
            />
          </View>
        ) : null}
      </Narrow>
    </Screen>
  );
}

/** One person in the tree: row + (collapsible) nested reports. */
function OrgNode({
  person,
  childrenOf,
  teamSize,
  projectCount,
  onOpen,
}: {
  person: Person;
  childrenOf: Map<Id<"people">, Person[]>;
  teamSize: Map<Id<"people">, number>;
  projectCount: Map<Id<"people">, number>;
  onOpen: (id: Id<"people">) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const children = childrenOf.get(person._id) ?? [];
  const reports = teamSize.get(person._id) ?? 0;
  const activeProjects = projectCount.get(person._id) ?? 0;

  return (
    <View>
      <Pressable
        onPress={() => onOpen(person._id)}
        className="flex-row items-center gap-2.5 rounded-md px-1.5 py-2 active:bg-sunken web:hover:bg-sunken"
      >
        {children.length > 0 ? (
          <Pressable
            onPress={(e) => {
              // Keep the toggle from also firing the row's navigate on web.
              e.stopPropagation?.();
              setExpanded((cur) => !cur);
            }}
            hitSlop={6}
            accessibilityLabel={expanded ? "Collapse reports" : "Expand reports"}
            className="rounded p-0.5 active:bg-sunken"
          >
            <Icon
              name={expanded ? "chevron-down" : "chevron-right"}
              size={15}
              color={colors.muted}
            />
          </Pressable>
        ) : (
          <View style={{ width: 20 }} />
        )}
        <Avatar name={person.name || "?"} size={30} uri={person.imageUrl} />
        <View className="flex-1">
          <Text className="text-sm font-medium text-ink" numberOfLines={1}>
            {person.name}
          </Text>
          {person.role ? (
            <Text className="text-xs text-muted" numberOfLines={1}>
              {person.role}
            </Text>
          ) : null}
        </View>
        {reports > 0 ? (
          <Text className="text-xs font-semibold text-muted">
            {reports} {reports === 1 ? "report" : "reports"}
          </Text>
        ) : null}
        {activeProjects > 0 ? (
          <Text className="text-xs font-semibold text-accent">
            {activeProjects} {activeProjects === 1 ? "project" : "projects"}
          </Text>
        ) : null}
        <Icon name="chevron-right" size={15} color={colors.faint} />
      </Pressable>

      {expanded && children.length > 0 ? (
        <View
          style={{ marginLeft: 19 }}
          className="border-l border-border pl-1.5"
        >
          {children.map((child) => (
            <OrgNode
              key={child._id}
              person={child}
              childrenOf={childrenOf}
              teamSize={teamSize}
              projectCount={projectCount}
              onOpen={onOpen}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}
