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
import { useEffect, useMemo, useState } from "react";
import { View, Text, Pressable, ScrollView, Modal } from "react-native";
import { useRouter } from "expo-router";
import { useQuery, useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  Screen,
  Narrow,
  FULL_WIDTH,
  Avatar,
  Icon,
  type IconName,
  Button,
  EmptyState,
  SectionHeader,
} from "../../../components/ui";
import {
  ProjectCard,
  buildProjectTree,
} from "../../../components/team/ProjectCard";
import { OrgChart } from "../../../components/team/OrgChart";
import { buildOrgTree } from "../../../components/team/orgTree";
import { WorkloadView } from "../../../components/team/WorkloadView";
import {
  ScopeToggle,
  type ProjectScopeChoice,
} from "../../../components/team/ScopeToggle";
import { DutiesGrid } from "../../../components/work/DutiesGrid";
import { MineSection } from "../../../components/work/MineSection";
import { colors, spacing } from "../../../lib/theme";
import { alertError } from "../../../lib/errors";

type Overview = FunctionReturnType<typeof api.org.overview>;
type Person = Overview["people"][number];
/** A roster person plus the tree/chart display title — seat titles first
 *  (mirrors People tab's #188 `TitleCell` pattern), muted legacy
 *  `person.role` fallback for anyone who holds no seat. */
type OrgPerson = Person & { title: string | null; hasSeatTitle: boolean };

export default function TeamScreen() {
  const router = useRouter();
  const nav = useQuery(api.org.nav);
  const overview = useQuery(api.org.overview);
  // Seat titles held, by person — same query/shape People tab's Title column
  // mirrors (see `people.tsx`'s `seatTitlesByPerson`). Chapter-scoped, gated
  // server-side on `canViewChapterWork` — empty for a caller with no access.
  const seatHoldings = useQuery(api.responsibilities.chapterSeatHoldings);
  // Work's org-hierarchy view isn't peek-scoped (see ChapterContext's file
  // doc) — always the caller's own chapter, so no chapterId arg is passed.
  const projects = useQuery(api.projects.list, {});
  const createProject = useMutation(api.projects.create);
  // Creation-time money-attribution picker (owner spec: "creator's highest
  // hat" default, editable). `isCentral` is false (no picker) for every
  // caller without central WRITE reach — a chapter-only creator's "New
  // project" tap stays the same one-tap instant create it always was; nothing
  // changes for them.
  const scopeOptions = useQuery(api.projects.scopeOptions);
  const [scopePickerOpen, setScopePickerOpen] = useState(false);
  const [view, setView] = useState<"list" | "chart">("list");
  // Top-level Work segments: the org's Projects vs the chapter's Duties catalog
  // (leads/admins only — this whole branch is gated on teamView === "org").
  const [section, setSection] = useState<"projects" | "duties">("projects");

  // Seat titles held, by person — the tree's row-title mirror of the People
  // tab's Title column (#188).
  const seatTitlesByPerson = useMemo(() => {
    const map = new Map<Id<"people">, string[]>();
    for (const h of seatHoldings ?? []) {
      map.set(h.personId, [...(map.get(h.personId) ?? []), h.seatTitle]);
    }
    return map;
  }, [seatHoldings]);

  // The org chart covers team members plus anyone wired into a manager
  // relationship (so a report who isn't flagged Team yet still shows up).
  // `overview.people` is already scoped server-side (chapter for admins,
  // the caller's subtree for managers). The tree's PARENT/CHILD edges come
  // from `effectiveManagerIds` (seat-derived ∪ `managerId` fallback, the
  // same derivation `org.overview`'s `hasReports`/`canManage` and
  // `org.workload` use) — never raw `managerId` directly.
  const org = useMemo(() => {
    const roster: OrgPerson[] = (overview?.people ?? []).map((p) => {
      const seatTitles = seatTitlesByPerson.get(p._id) ?? [];
      return {
        ...p,
        title: seatTitles.length > 0 ? seatTitles.join(", ") : (p.role ?? null),
        hasSeatTitle: seatTitles.length > 0,
      };
    });
    return buildOrgTree(roster);
  }, [overview, seatTitlesByPerson]);

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

  // "New project" — instant one-tap create for everyone, EXCEPT a caller with
  // central finance write reach gets the scope picker first (owner spec: the
  // multi-hat creator explicitly wants to choose at creation time). The
  // picker itself just gathers `scope`; `projects.create` resolves the
  // ("creator's highest hat") default server-side regardless, so this is only
  // ever an override, never the sole place the default is enforced.
  function handleNewProject() {
    if (scopeOptions?.isCentral) {
      setScopePickerOpen(true);
      return;
    }
    void createProject({ name: "New project" }).catch(alertError);
  }
  function handleCreateWithScope(scope: ProjectScopeChoice) {
    setScopePickerOpen(false);
    void createProject({ name: "New project", scope }).catch(alertError);
  }

  if (nav === undefined || overview === undefined || projects === undefined) {
    return <Screen loading />;
  }

  // The server's three-way policy (org.nav.teamView) decides what this tab
  // is — the same field AppShell used to show the nav entry.
  if (nav.teamView !== "org") {
    // No reports to manage — but everyone on the roster still gets their OWN
    // work here: the projects assigned to them, their responsibilities, and
    // their events, fully editable.
    if (nav.teamView === "self" && nav.selfPersonId) {
      return (
        <WorkloadView
          personId={nav.selfPersonId}
          showBack={false}
          lead={<MineSection />}
        />
      );
    }
    return (
      <Screen>
        <Narrow>
          <EmptyState
            title="Nothing here yet"
            message="Your work shows up once your roster profile is linked — ask a chapter admin to connect your account on the People tab."
          />
        </Narrow>
      </Screen>
    );
  }

  const hasHierarchy = org.childrenOf.size > 0;

  return (
    <Screen maxWidth={section === "duties" ? FULL_WIDTH : undefined}>
      <Narrow>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: spacing.md,
          }}
        >
          <Text className="font-display text-2xl text-ink">Work</Text>
          {/* Top-level Projects ⇄ Duties segments — the Duties catalog is a
              management tool, so only managers/admins get the toggle. Everyone
              else sees the transparent org tree (Projects view). */}
          {nav.canManage ? (
            <Segmented
              options={[
                { key: "projects", icon: "git-branch", label: "Projects" },
                { key: "duties", icon: "check-square", label: "Duties" },
              ]}
              value={section}
              onChange={setSection}
            />
          ) : null}
        </View>
        {/* Every pillar leads with your slice — the caller's own due work and
            events, above the org-wide sections. */}
        <MineSection />
      </Narrow>

      {section === "duties" ? (
        // compact: this screen already owns the header — a second "Duties"
        // title block here is the founder-reported "overlaid screens" bug.
        <DutiesGrid header="compact" />
      ) : (
        <Narrow>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "flex-end",
              marginBottom: spacing.md,
            }}
          >
            <View className="flex-row items-center gap-3">
              {/* List ⇄ org-chart toggle */}
              <Segmented
                options={[
                  { key: "list", icon: "list", label: "List" },
                  { key: "chart", icon: "git-branch", label: "Chart" },
                ]}
                value={view}
                onChange={setView}
              />
              <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
                {org.included.length} people
              </Text>
            </View>
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
            {view === "chart" ? (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                className="rounded-lg border border-border bg-surface"
                contentContainerStyle={{ padding: spacing.lg }}
              >
                <OrgChart
                  roots={org.roots}
                  childrenOf={org.childrenOf}
                  teamSize={org.teamSize}
                  projectCount={projectCount}
                  onOpen={(id) => router.push(`/team/${id}` as any)}
                />
              </ScrollView>
            ) : (
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
            )}
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
                  onPress={handleNewProject}
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
              onPress={handleNewProject}
            />
          </View>
        ) : null}
        </Narrow>
      )}

      <NewProjectScopeModal
        visible={scopePickerOpen}
        chapterName={scopeOptions?.chapterName ?? "This chapter"}
        defaultScope={scopeOptions?.defaultScope ?? "chapter"}
        onCancel={() => setScopePickerOpen(false)}
        onCreate={handleCreateWithScope}
      />
    </Screen>
  );
}

/**
 * The compact segmented toggle used across the Work tab (Projects⇄Duties and
 * List⇄Chart). Generic over its option keys so both callers reuse one pattern.
 */
function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { key: T; icon: IconName; label: string }[];
  value: T;
  onChange: (key: T) => void;
}) {
  return (
    <View
      className="flex-row rounded-lg bg-sunken"
      style={{ padding: 3, gap: spacing.xs }}
    >
      {options.map((v) => {
        const active = value === v.key;
        return (
          <Pressable
            key={v.key}
            onPress={() => onChange(v.key)}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            className={`flex-row items-center gap-1.5 rounded-md px-2.5 py-1 active:opacity-80 ${
              active ? "bg-raised shadow-sm" : ""
            }`}
          >
            <Icon
              name={v.icon}
              size={13}
              color={active ? colors.ink : colors.muted}
            />
            <Text
              className={`text-xs font-semibold ${
                active ? "text-ink" : "text-muted"
              }`}
            >
              {v.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
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
  person: OrgPerson;
  childrenOf: Map<Id<"people">, OrgPerson[]>;
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

/**
 * The "New project" creation-time scope picker — only ever shown to a caller
 * with central finance write reach (`projects.scopeOptions.isCentral`); a
 * chapter-only creator never sees this, their "New project" tap stays the
 * one-tap instant create it always was. `defaultScope` is the resolved
 * "creator's highest hat" default (always Central here, since this modal only
 * opens for a central-capable caller) — shown pre-selected but editable, so
 * it's never a silent guess.
 */
function NewProjectScopeModal({
  visible,
  chapterName,
  defaultScope,
  onCancel,
  onCreate,
}: {
  visible: boolean;
  chapterName: string;
  defaultScope: ProjectScopeChoice;
  onCancel: () => void;
  onCreate: (scope: ProjectScopeChoice) => void;
}) {
  const [scope, setScope] = useState<ProjectScopeChoice>(defaultScope);
  // Re-sync to the resolved default every time the picker opens (it can only
  // change between opens if the caller's own finance roles change).
  useEffect(() => {
    if (visible) setScope(defaultScope);
  }, [visible, defaultScope]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <Pressable
        onPress={onCancel}
        className="flex-1 items-center justify-center bg-ink/30 p-6"
      >
        <Pressable
          onPress={() => {}}
          className="w-full max-w-sm rounded-xl border border-border bg-raised p-4 shadow-pop"
          style={{ gap: spacing.md }}
        >
          <Text className="font-display text-lg text-ink">New project</Text>
          <View style={{ gap: spacing.xs }}>
            <Text className="text-xs font-bold uppercase tracking-wider text-faint">
              Belongs to
            </Text>
            <ScopeToggle value={scope} chapterName={chapterName} onChange={setScope} />
          </View>
          <View className="flex-row justify-end gap-2">
            <Button title="Cancel" variant="secondary" onPress={onCancel} />
            <Button title="Create" onPress={() => onCreate(scope)} />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
