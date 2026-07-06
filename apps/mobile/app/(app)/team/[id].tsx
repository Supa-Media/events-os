/**
 * PERSON WORKLOAD — everything one person (and their subtree) is driving.
 *
 * The drill-in from the Team org view. Shows the person's own projects as
 * fully-editable cards (status, note, deadline, blocker, next steps — the
 * manager updates these without a meeting), the events they own and the event
 * roles they hold, then the same rollup for every report under them, so a
 * manager reads the state of the whole team's work top-to-bottom.
 */
import { useMemo } from "react";
import { View, Text, Pressable } from "react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import { useQuery, useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  EVENT_STATUS_LABELS,
  type EventStatus,
} from "@events-os/shared";
import {
  Screen,
  Narrow,
  Avatar,
  Badge,
  Button,
  Icon,
  EmptyState,
  SectionHeader,
  statusTone,
} from "../../../components/ui";
import {
  ProjectCard,
  buildProjectTree,
  type ProjectDoc,
} from "../../../components/team/ProjectCard";
import { colors, spacing } from "../../../lib/theme";
import { formatDate } from "../../../lib/format";

type Workload = NonNullable<FunctionReturnType<typeof api.org.workload>>;
type Member = Workload["members"][number];

export default function PersonWorkloadScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const personId = id as Id<"people">;

  const workload = useQuery(api.org.workload, id ? { personId } : "skip");
  const projects = useQuery(api.projects.list);
  const createProject = useMutation(api.projects.create);

  const peopleById = useMemo(() => {
    const map = new Map<Id<"people">, string>();
    for (const m of workload?.members ?? []) map.set(m._id, m.name);
    if (workload?.manager) map.set(workload.manager._id, workload.manager.name);
    return map;
  }, [workload]);

  const projectById = useMemo(
    () => new Map((projects ?? []).map((p) => [p._id, p])),
    [projects],
  );
  const projectTree = useMemo(
    () => buildProjectTree(projects ?? []),
    [projects],
  );

  /**
   * A person's top-level cards: projects they own that don't nest under
   * another project of theirs (children render inside the parent's card).
   */
  function rootsFor(ownerId: Id<"people">): ProjectDoc[] {
    return (projects ?? []).filter((p) => {
      if (p.ownerPersonId !== ownerId) return false;
      if (!p.parentProjectId) return true;
      const parent = projectById.get(p.parentProjectId);
      return !parent || parent.ownerPersonId !== ownerId;
    });
  }

  if (workload === undefined || projects === undefined) {
    return <Screen loading />;
  }

  if (workload === null) {
    return (
      <Screen>
        <Narrow>
          <EmptyState
            title="Person not found"
            message="They may have been removed from the roster."
          />
          <View className="mt-4 items-start">
            <Button
              title="Back to Team"
              variant="secondary"
              size="sm"
              icon="chevron-left"
              onPress={() => router.navigate("/team" as any)}
            />
          </View>
        </Narrow>
      </Screen>
    );
  }

  const { person, manager, reports, members } = workload;
  const self = members.find((m) => m.isSelf);
  const team = members.filter((m) => !m.isSelf);
  const ownRoots = rootsFor(person._id);

  return (
    <Screen>
      <Narrow>
          {/* Back to the org view */}
          <Pressable
            onPress={() => router.navigate("/team" as any)}
            className="mb-4 flex-row items-center gap-1 self-start active:opacity-70"
          >
            <Icon name="chevron-left" size={16} color={colors.muted} />
            <Text className="text-sm font-medium text-muted">Team</Text>
          </Pressable>

          {/* Identity */}
          <View className="mb-2 flex-row items-center gap-3">
            <Avatar name={person.name || "?"} size={44} />
            <View className="flex-1">
              <Text className="font-display text-2xl text-ink" numberOfLines={1}>
                {person.name}
              </Text>
              <View className="flex-row flex-wrap items-center gap-x-2">
                {person.role ? (
                  <Text className="text-sm text-muted">{person.role}</Text>
                ) : null}
                {manager ? (
                  <Pressable
                    onPress={() => router.push(`/team/${manager._id}` as any)}
                    className="active:opacity-70"
                  >
                    <Text className="text-sm text-muted">
                      {person.role ? "· " : ""}Reports to{" "}
                      <Text className="font-semibold text-accent">
                        {manager.name}
                      </Text>
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            </View>
          </View>

          {/* Direct reports */}
          {reports.length > 0 ? (
            <View className="mb-2 flex-row flex-wrap items-center gap-2">
              <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
                Reports
              </Text>
              {reports.map((r) => (
                <Pressable
                  key={r._id}
                  onPress={() => router.push(`/team/${r._id}` as any)}
                  className="flex-row items-center gap-1.5 rounded-pill border border-border bg-raised px-2.5 py-1 active:bg-sunken web:hover:bg-sunken"
                >
                  <Avatar name={r.name || "?"} size={18} />
                  <Text className="text-sm text-ink">{r.name}</Text>
                  {r.reportCount > 0 ? (
                    <Text className="text-xs text-faint">+{r.reportCount}</Text>
                  ) : null}
                </Pressable>
              ))}
            </View>
          ) : null}

          {/* Their own projects */}
          <SectionHeader
            title="Projects"
            count={ownRoots.length}
            right={
              <Button
                title="Add project"
                icon="plus"
                size="sm"
                variant="secondary"
                onPress={() =>
                  createProject({
                    name: "New project",
                    ownerPersonId: person._id,
                  })
                }
              />
            }
          />
          {ownRoots.length === 0 ? (
            <Text className="text-sm text-faint">
              No projects tracked yet — add one to start following this
              person's work.
            </Text>
          ) : (
            <View style={{ gap: spacing.sm }}>
              {ownRoots.map((p) => (
                <ProjectCard
                  key={p._id}
                  project={p}
                  childrenOf={projectTree}
                  peopleById={peopleById}
                />
              ))}
            </View>
          )}

          {/* Events they own + roles they hold (auto-attached from event data) */}
          {self && (self.events.length > 0 || self.roles.length > 0) ? (
            <>
              <SectionHeader title="Events" count={self.events.length} />
              <EventsAndRoles member={self} />
            </>
          ) : null}

          {/* The rollup: every report's work, deepest levels included. */}
          {team.length > 0 ? (
            <>
              <SectionHeader title="Their team's work" count={team.length} />
              <View style={{ gap: spacing.lg }}>
                {team.map((m) => (
                  <TeamMemberBlock
                    key={m._id}
                    member={m}
                    roots={rootsFor(m._id)}
                    projectTree={projectTree}
                    peopleById={peopleById}
                    onOpen={() => router.push(`/team/${m._id}` as any)}
                    onAddProject={() =>
                      createProject({
                        name: "New project",
                        ownerPersonId: m._id,
                      })
                    }
                  />
                ))}
              </View>
            </>
          ) : null}
          <View style={{ height: spacing.xl }} />
      </Narrow>
    </Screen>
  );
}

/** One report's slice of the rollup: projects, owned events, roles held. */
function TeamMemberBlock({
  member,
  roots,
  projectTree,
  peopleById,
  onOpen,
  onAddProject,
}: {
  member: Member;
  roots: ProjectDoc[];
  projectTree: Map<Id<"projects">, ProjectDoc[]>;
  peopleById: Map<Id<"people">, string>;
  onOpen: () => void;
  onAddProject: () => void;
}) {
  const idle =
    roots.length === 0 && member.events.length === 0 && member.roles.length === 0;
  return (
    <View>
      <View className="mb-2 flex-row items-center gap-2">
        <Pressable
          onPress={onOpen}
          className="flex-row items-center gap-2 active:opacity-70"
        >
          <Avatar name={member.name || "?"} size={24} />
          <Text className="text-sm font-semibold text-ink">{member.name}</Text>
          {member.role ? (
            <Text className="text-xs text-muted">{member.role}</Text>
          ) : null}
        </Pressable>
        <View className="flex-1" />
        <Pressable
          onPress={onAddProject}
          hitSlop={6}
          accessibilityLabel={`Add project for ${member.name}`}
          className="flex-row items-center gap-1 rounded p-1 active:bg-sunken web:hover:bg-sunken"
        >
          <Icon name="plus" size={13} color={colors.muted} />
          <Text className="text-xs font-medium text-muted">Project</Text>
        </Pressable>
      </View>
      {idle ? (
        <Text className="text-sm text-faint">Nothing tracked yet.</Text>
      ) : (
        <View style={{ gap: spacing.sm }}>
          {roots.map((p) => (
            <ProjectCard
              key={p._id}
              project={p}
              childrenOf={projectTree}
              peopleById={peopleById}
            />
          ))}
          {member.events.length > 0 || member.roles.length > 0 ? (
            <EventsAndRoles member={member} />
          ) : null}
        </View>
      )}
    </View>
  );
}

/** Compact rows for the event data we already have: owned events + roles. */
function EventsAndRoles({ member }: { member: Member }) {
  const router = useRouter();
  return (
    <View style={{ gap: spacing.xs }}>
      {member.events.map((e) => (
        <Pressable
          key={e._id}
          onPress={() => router.push(`/event/${e._id}` as any)}
          className="flex-row items-center gap-2 rounded-md border border-border bg-raised px-3 py-2 active:bg-sunken web:hover:bg-sunken"
        >
          <Icon name="calendar" size={14} color={colors.muted} />
          <Text className="flex-1 text-sm font-medium text-ink" numberOfLines={1}>
            {e.name}
          </Text>
          <Text className="text-xs text-muted">{formatDate(e.eventDate)}</Text>
          <Badge
            label={EVENT_STATUS_LABELS[e.status as EventStatus]}
            tone={statusTone(e.status as EventStatus)}
          />
        </Pressable>
      ))}
      {member.roles.map((r, i) => (
        <Pressable
          key={`${r.eventId}-${i}`}
          onPress={() => router.push(`/event/${r.eventId}` as any)}
          className="flex-row items-center gap-2 rounded-md border border-border bg-raised px-3 py-2 active:bg-sunken web:hover:bg-sunken"
        >
          <Icon name="tag" size={14} color={colors.muted} />
          <Text className="flex-1 text-sm text-ink" numberOfLines={1}>
            <Text className="font-medium">{r.roleLabel}</Text>
            <Text className="text-muted"> · {r.eventName}</Text>
          </Text>
          <Text className="text-xs text-muted">{formatDate(r.eventDate)}</Text>
        </Pressable>
      ))}
    </View>
  );
}
