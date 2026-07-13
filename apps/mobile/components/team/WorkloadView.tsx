/**
 * WorkloadView — everything one person (and their subtree) is driving.
 *
 * Rendered by the /team/[id] drill-in AND by the Team tab itself for people
 * with no reports (their "my work" view). Shows the person's projects as
 * fully-editable cards, their responsibilities (role fan-out + direct), the
 * events they own and event roles they hold, then the same rollup for every
 * report under them — plus the 1:1 layer: managers log check-ins/skips per
 * report and the reporting chain reads the history.
 */
import { useMemo, useState } from "react";
import { View, Text, Pressable, Linking, Modal, ScrollView } from "react-native";
import { useRouter, usePathname } from "expo-router";
import { useQuery, useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import type { Doc, Id } from "@events-os/convex/_generated/dataModel";
import {
  EVENT_STATUS_LABELS,
  RESPONSIBILITY_CADENCE_LABELS,
  CHECKIN_ACTION_LABELS,
  responsibilityAppliesTo,
  responsibilityDueForReview,
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
  OptionTag,
  SectionHeader,
  statusTone,
} from "../ui";
import { ProjectCard, buildProjectTree, type ProjectDoc } from "./ProjectCard";
import { CheckInModal } from "./CheckInModal";
import { AddResponsibilityModal } from "./AddResponsibilityModal";
import { colors, spacing } from "../../lib/theme";
import { formatDate } from "../../lib/format";
import { alertError } from "../../lib/errors";
import { confirmAction } from "../event/ticketing/helpers";

type Workload = NonNullable<FunctionReturnType<typeof api.org.workload>>;
type Member = Workload["members"][number];
type Responsibility = FunctionReturnType<
  typeof api.responsibilities.list
>[number];
type CheckInRow = NonNullable<
  FunctionReturnType<typeof api.checkIns.listForSubtree>
>["entries"][number];

export function WorkloadView({
  personId,
  showBack = true,
}: {
  personId: Id<"people">;
  /** Hide the "← Team" affordance when embedded as someone's own view. */
  showBack?: boolean;
}) {
  const router = useRouter();
  const workload = useQuery(api.org.workload, { personId });
  const projects = useQuery(api.projects.list);
  const responsibilities = useQuery(api.responsibilities.list);
  const checkIns = useQuery(api.checkIns.listForSubtree, { personId });
  const createProject = useMutation(api.projects.create);

  const [checkInFor, setCheckInFor] = useState<{
    _id: Id<"people">;
    name: string;
  } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [addDutyFor, setAddDutyFor] = useState<{
    _id: Id<"people">;
    name: string;
    role: string | null;
  } | null>(null);
  // The full-project modal target — stored as an id and resolved live, so
  // edits made inside the modal (or elsewhere) never render a stale snapshot.
  const [fullProjectId, setFullProjectId] = useState<Id<"projects"> | null>(
    null,
  );

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
   * Each person's top-level cards, grouped once per data change. A project is
   * a root for its owner UNLESS its nearest owned ancestor belongs to the SAME
   * person — then it already renders nested inside their own root card, and
   * listing it again would duplicate it within one section. A sub-project
   * assigned to someone ELSE always lists under its assignee too (with a
   * "part of" chip back to the full project), so cross-assigned work never
   * hides from the person on the hook for it.
   */
  const rootsByOwner = useMemo(() => {
    const nearestAncestorOwner = (p: ProjectDoc): Id<"people"> | undefined => {
      let cur = p.parentProjectId ? projectById.get(p.parentProjectId) : undefined;
      for (let hops = 0; cur && hops < 100; hops++) {
        if (cur.ownerPersonId) return cur.ownerPersonId;
        cur = cur.parentProjectId ? projectById.get(cur.parentProjectId) : undefined;
      }
      return undefined;
    };
    const map = new Map<Id<"people">, ProjectDoc[]>();
    for (const p of projects ?? []) {
      if (!p.ownerPersonId) continue;
      const ancestorOwner = nearestAncestorOwner(p);
      if (ancestorOwner && ancestorOwner === p.ownerPersonId) continue;
      const list = map.get(p.ownerPersonId) ?? [];
      list.push(p);
      map.set(p.ownerPersonId, list);
    }
    return map;
  }, [projects, projectById]);

  /** Everyone's responsibilities (role fan-out + direct), one pass. */
  const respByPerson = useMemo(() => {
    const map = new Map<Id<"people">, Responsibility[]>();
    const people = [
      ...(workload?.members ?? []).map((m) => ({ _id: m._id, role: m.role })),
    ];
    if (workload && !workload.members.some((m) => m.isSelf)) {
      people.push({ _id: workload.person._id, role: workload.person.role });
    }
    for (const p of people) {
      map.set(
        p._id,
        (responsibilities ?? []).filter((r) => responsibilityAppliesTo(r, p)),
      );
    }
    return map;
  }, [responsibilities, workload]);
  const respFor = (id: Id<"people">) => respByPerson.get(id) ?? [];

  /**
   * "Part of {parent}" chip for a sub-project shown standalone under its
   * assignee: names the immediate parent, opens the TOPMOST ancestor so the
   * modal shows the whole project. Undefined for true roots (and when the
   * parent is outside the caller's scope, where there's nothing to open).
   */
  const partOfFor = (p: ProjectDoc) => {
    if (!p.parentProjectId) return undefined;
    const parent = projectById.get(p.parentProjectId);
    if (!parent) return undefined;
    let root = parent;
    for (let hops = 0; root.parentProjectId && hops < 100; hops++) {
      const up = projectById.get(root.parentProjectId);
      if (!up) break;
      root = up;
    }
    const rootId = root._id;
    return {
      name: parent.name || "Untitled project",
      onPress: () => setFullProjectId(rootId),
    };
  };

  /** Who's accountable for a project — its owner or nearest ancestor's. */
  const effectiveOwnerOf = (p: ProjectDoc): Id<"people"> | undefined => {
    let cur: ProjectDoc | undefined = p;
    for (let hops = 0; cur && hops < 100; hops++) {
      if (cur.ownerPersonId) return cur.ownerPersonId;
      cur = cur.parentProjectId ? projectById.get(cur.parentProjectId) : undefined;
    }
    return undefined;
  };

  const checkInsByPerson = useMemo(() => {
    const map = new Map<Id<"people">, CheckInRow[]>();
    for (const c of checkIns?.entries ?? []) {
      const list = map.get(c.personId) ?? [];
      list.push(c);
      map.set(c.personId, list);
    }
    return map;
  }, [checkIns]);

  /**
   * Last-reviewed times for the person about to be checked in — fetched from
   * their OWN full history (not the 10-capped subtree feed), so a slow-cadence
   * duty's last review isn't lost past the feed's window and wrongly treated
   * as never-reviewed. Skipped until a 1:1 is actually being logged.
   */
  const checkInReviews = useQuery(
    api.checkIns.reviewTimesForPerson,
    checkInFor ? { personId: checkInFor._id } : "skip",
  );

  // Managers log 1:1s about others — never about themselves.
  const canLogFor = (memberId: Id<"people">) =>
    workload?.caller.personId != null &&
    memberId !== workload.caller.personId;

  // Responsibilities gate the check-in modal's seed list — wait for them.
  // (The 1:1 history and cadence review-times load async and don't block
  // first paint.)
  if (
    workload === undefined ||
    projects === undefined ||
    responsibilities === undefined
  ) {
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
          {showBack ? (
            <View className="mt-4 items-start">
              <Button
                title="Back to Team"
                variant="secondary"
                size="sm"
                icon="chevron-left"
                onPress={() => router.navigate("/team" as any)}
              />
            </View>
          ) : null}
        </Narrow>
      </Screen>
    );
  }

  const { person, caller, manager, reports, members } = workload;
  const self = members.find((m) => m.isSelf);
  const team = members.filter((m) => !m.isSelf);
  const ownRoots = rootsByOwner.get(person._id) ?? [];
  const ownResponsibilities = respFor(person._id);
  const ownCheckIns = checkInsByPerson.get(person._id) ?? [];
  // Owner reassignment is a manager/admin capability — plain members get
  // read-only chips (the server rejects their reassignments anyway).
  const showOwner = caller.canManage;

  return (
    <Screen>
      <Narrow>
        {showBack ? (
          <Pressable
            onPress={() => router.navigate("/team" as any)}
            className="mb-4 flex-row items-center gap-1 self-start active:opacity-70"
          >
            <Icon name="chevron-left" size={16} color={colors.muted} />
            <Text className="text-sm font-medium text-muted">Team</Text>
          </Pressable>
        ) : null}

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
                // Only link when the caller may open the manager's page —
                // a non-admin can't inspect their own boss's workload.
                manager.viewable ? (
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
                ) : (
                  <Text className="text-sm text-muted">
                    {person.role ? "· " : ""}Reports to{" "}
                    <Text className="font-semibold">{manager.name}</Text>
                  </Text>
                )
              ) : null}
            </View>
          </View>
          {ownCheckIns.length > 0 || canLogFor(person._id) ? (
            <Button
              title="1:1 history"
              icon="clock"
              size="sm"
              variant="secondary"
              onPress={() => setHistoryOpen(true)}
            />
          ) : null}
          {canLogFor(person._id) ? (
            <Button
              title="Log 1:1"
              icon="message-circle"
              size="sm"
              onPress={() =>
                setCheckInFor({ _id: person._id, name: person.name })
              }
            />
          ) : null}
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
                void createProject({
                  name: "New project",
                  ownerPersonId: person._id,
                }).catch(alertError)
              }
            />
          }
        />
        {ownRoots.length === 0 ? (
          <Text className="text-sm text-faint">
            No projects tracked yet — add one to start following this person's
            work.
          </Text>
        ) : (
          <View style={{ gap: spacing.sm }}>
            {ownRoots.map((p) => (
              <ProjectCard
                key={p._id}
                project={p}
                childrenOf={projectTree}
                peopleById={peopleById}
                showOwner={showOwner}
                partOf={partOfFor(p)}
              />
            ))}
          </View>
        )}

        {/* Their responsibilities (recurring duties). Managers always get the
            section — it carries the quick-add — while plain members only see
            it once something applies (the server rejects their edits anyway). */}
        {ownResponsibilities.length > 0 || caller.canManage ? (
          <>
            <SectionHeader
              title="Duties"
              count={ownResponsibilities.length}
              right={
                caller.canManage ? (
                  <Button
                    title="Add duty"
                    icon="plus"
                    size="sm"
                    variant="secondary"
                    onPress={() =>
                      setAddDutyFor({
                        _id: person._id,
                        name: person.name,
                        role: person.role,
                      })
                    }
                  />
                ) : undefined
              }
            />
            {ownResponsibilities.length === 0 ? (
              <Text className="text-sm text-faint">
                No recurring duties yet — add one to them or their role.
              </Text>
            ) : (
              <ResponsibilityRows items={ownResponsibilities} />
            )}
          </>
        ) : null}

        {/* Events they own + roles they hold (auto-attached from event data) */}
        {self && (self.events.length > 0 || self.roles.length > 0) ? (
          <>
            <SectionHeader title="Events" count={self.events.length} />
            <EventsAndRoles member={self} />
          </>
        ) : null}

        {/* Their 1:1 history (visible to the chain above them) */}
        {ownCheckIns.length > 0 ? (
          <>
            <SectionHeader
              title="1:1 log"
              count={ownCheckIns.length}
              right={
                <Pressable
                  onPress={() => setHistoryOpen(true)}
                  className="active:opacity-70"
                >
                  <Text className="text-xs font-semibold text-accent">
                    See full history
                  </Text>
                </Pressable>
              }
            />
            <CheckInList
              items={ownCheckIns}
              limit={5}
              callerPersonId={checkIns?.callerPersonId ?? null}
            />
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
                  roots={rootsByOwner.get(m._id) ?? []}
                  responsibilities={respFor(m._id)}
                  checkIns={checkInsByPerson.get(m._id) ?? []}
                  projectTree={projectTree}
                  peopleById={peopleById}
                  showOwner={showOwner}
                  partOfFor={partOfFor}
                  callerPersonId={checkIns?.callerPersonId ?? null}
                  canLog={canLogFor(m._id)}
                  onLog={() => setCheckInFor({ _id: m._id, name: m.name })}
                  onOpen={() => router.push(`/team/${m._id}` as any)}
                  onAddProject={() =>
                    void createProject({
                      name: "New project",
                      ownerPersonId: m._id,
                    }).catch(alertError)
                  }
                  onAddDuty={
                    caller.canManage
                      ? () =>
                          setAddDutyFor({
                            _id: m._id,
                            name: m.name,
                            role: m.role,
                          })
                      : undefined
                  }
                />
              ))}
            </View>
          </>
        ) : null}
        <View style={{ height: spacing.xl }} />
      </Narrow>

      {historyOpen ? (
        <CheckInHistoryModal
          person={{ _id: person._id, name: person.name }}
          onClose={() => setHistoryOpen(false)}
        />
      ) : null}

      {checkInFor && checkInReviews !== undefined ? (
        <CheckInModal
          key={checkInFor._id}
          visible
          person={checkInFor}
          responsibilities={respFor(checkInFor._id).map((r) => ({
            _id: r._id,
            title: r.title,
            cadence: r.cadence,
            dueForReview: responsibilityDueForReview(
              r.cadence,
              (checkInReviews ?? {})[r._id] ?? null,
              Date.now(),
            ),
          }))}
          projects={(projects ?? [])
            .filter(
              (p) =>
                // Active work they're accountable for: finished projects
                // shouldn't collect on-track attestations forever, and an
                // unowned sub-project inherits its parent's owner.
                p.status !== "done" &&
                effectiveOwnerOf(p) === checkInFor._id,
            )
            .map((p) => ({ _id: p._id, name: p.name }))}
          onClose={() => setCheckInFor(null)}
        />
      ) : null}

      {addDutyFor ? (
        <AddResponsibilityModal
          key={addDutyFor._id}
          person={addDutyFor}
          responsibilities={responsibilities ?? []}
          onClose={() => setAddDutyFor(null)}
        />
      ) : null}

      {fullProjectId ? (
        <FullProjectModal
          project={projectById.get(fullProjectId) ?? null}
          childrenOf={projectTree}
          peopleById={peopleById}
          showOwner={showOwner}
          onClose={() => setFullProjectId(null)}
        />
      ) : null}
    </Screen>
  );
}

/**
 * The whole project a cross-assigned sub-project belongs to, opened in place
 * from its "part of" chip — the full tree from the topmost ancestor, live and
 * editable, without leaving the page you were scanning.
 */
function FullProjectModal({
  project,
  childrenOf,
  peopleById,
  showOwner,
  onClose,
}: {
  project: ProjectDoc | null;
  childrenOf: Map<Id<"projects">, ProjectDoc[]>;
  peopleById: Map<Id<"people">, string>;
  showOwner: boolean;
  onClose: () => void;
}) {
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        className="flex-1 items-center justify-center bg-ink/30 p-6"
      >
        <Pressable
          onPress={() => {}}
          className="max-h-full w-full max-w-xl overflow-hidden rounded-xl border border-border bg-raised shadow-pop"
        >
          <View className="flex-row items-center justify-between border-b border-border px-5 py-4">
            <Text className="font-display text-lg text-ink" numberOfLines={1}>
              {project?.name || "Full project"}
            </Text>
            <Pressable onPress={onClose} hitSlop={8} className="rounded-md p-1">
              <Icon name="x" size={18} color={colors.muted} />
            </Pressable>
          </View>
          <ScrollView
            style={{ maxHeight: 560 }}
            contentContainerStyle={{ padding: spacing.lg }}
          >
            {project ? (
              <ProjectCard
                key={project._id}
                project={project}
                childrenOf={childrenOf}
                peopleById={peopleById}
                showOwner={showOwner}
                defaultExpanded
              />
            ) : (
              <Text className="text-sm text-faint">
                This project is gone — it may have just been deleted.
              </Text>
            )}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/** One report's slice of the rollup: projects, duties, events, 1:1s. */
function TeamMemberBlock({
  member,
  roots,
  responsibilities,
  checkIns,
  projectTree,
  peopleById,
  showOwner,
  partOfFor,
  callerPersonId,
  canLog,
  onLog,
  onOpen,
  onAddProject,
  onAddDuty,
}: {
  member: Member;
  roots: ProjectDoc[];
  responsibilities: Responsibility[];
  checkIns: CheckInRow[];
  projectTree: Map<Id<"projects">, ProjectDoc[]>;
  peopleById: Map<Id<"people">, string>;
  showOwner: boolean;
  /** "Part of {parent}" chip data for cross-assigned sub-project roots. */
  partOfFor: (
    p: ProjectDoc,
  ) => { name: string; onPress: () => void } | undefined;
  callerPersonId: Id<"people"> | null;
  canLog: boolean;
  onLog: () => void;
  onOpen: () => void;
  onAddProject: () => void;
  /** Present only when the caller may edit duty assignments. */
  onAddDuty?: () => void;
}) {
  const idle =
    roots.length === 0 &&
    responsibilities.length === 0 &&
    member.events.length === 0 &&
    member.roles.length === 0;
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
        {canLog ? (
          <Pressable
            onPress={onLog}
            hitSlop={6}
            accessibilityLabel={`Log 1:1 with ${member.name}`}
            className="flex-row items-center gap-1 rounded p-1 active:bg-sunken web:hover:bg-sunken"
          >
            <Icon name="message-circle" size={13} color={colors.accent} />
            <Text className="text-xs font-medium text-accent">1:1</Text>
          </Pressable>
        ) : null}
        <Pressable
          onPress={onAddProject}
          hitSlop={6}
          accessibilityLabel={`Add project for ${member.name}`}
          className="flex-row items-center gap-1 rounded p-1 active:bg-sunken web:hover:bg-sunken"
        >
          <Icon name="plus" size={13} color={colors.muted} />
          <Text className="text-xs font-medium text-muted">Project</Text>
        </Pressable>
        {onAddDuty ? (
          <Pressable
            onPress={onAddDuty}
            hitSlop={6}
            accessibilityLabel={`Add duty for ${member.name}`}
            className="flex-row items-center gap-1 rounded p-1 active:bg-sunken web:hover:bg-sunken"
          >
            <Icon name="plus" size={13} color={colors.muted} />
            <Text className="text-xs font-medium text-muted">Duty</Text>
          </Pressable>
        ) : null}
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
              showOwner={showOwner}
              partOf={partOfFor(p)}
            />
          ))}
          {responsibilities.length > 0 ? (
            <ResponsibilityRows items={responsibilities} />
          ) : null}
          {member.events.length > 0 || member.roles.length > 0 ? (
            <EventsAndRoles member={member} />
          ) : null}
          {checkIns.length > 0 ? (
            <CheckInList
              items={checkIns}
              limit={2}
              callerPersonId={callerPersonId}
            />
          ) : null}
        </View>
      )}
    </View>
  );
}

/** Compact recurring-duty rows: title · cadence · how-to (doc-aware). */
function ResponsibilityRows({ items }: { items: Responsibility[] }) {
  const router = useRouter();
  const pathname = usePathname();
  return (
    <View style={{ gap: spacing.xs }}>
      {items.map((r) => {
        const doc = r.howToDoc;
        const openDoc = doc
          ? () => {
              if ((doc.kind === "link" || doc.kind === "video") && doc.url) {
                void Linking.openURL(doc.url);
              } else {
                router.push(
                  `/doc/${doc._id}?from=${encodeURIComponent(pathname)}` as any,
                );
              }
            }
          : null;
        return (
          <View
            key={r._id}
            className="rounded-md border border-border bg-raised px-3 py-2"
          >
            <View className="flex-row items-center gap-2">
              <Icon name="repeat" size={13} color={colors.muted} />
              <Text
                className="flex-1 text-sm font-medium text-ink"
                numberOfLines={1}
              >
                {r.title}
              </Text>
              {doc && doc.kind !== "note" && openDoc ? (
                <Pressable
                  onPress={openDoc}
                  hitSlop={6}
                  className="flex-row items-center gap-1 rounded px-1 py-0.5 active:bg-sunken web:hover:bg-sunken"
                >
                  <Icon
                    name={
                      doc.kind === "video"
                        ? "video"
                        : doc.kind === "markdown"
                          ? "book-open"
                          : "external-link"
                    }
                    size={13}
                    color={colors.accent}
                  />
                  <Text className="text-xs font-medium text-accent">
                    How-To
                  </Text>
                </Pressable>
              ) : null}
              <OptionTag
                label={RESPONSIBILITY_CADENCE_LABELS[r.cadence]}
                color={r.cadence === "ad_hoc" ? "gray" : "teal"}
              />
            </View>
            {doc?.kind === "note" && doc.body ? (
              <Text className="mt-0.5 text-xs text-muted" numberOfLines={2}>
                {doc.body}
              </Text>
            ) : r.description ? (
              <Text className="mt-0.5 text-xs text-muted" numberOfLines={2}>
                {r.description}
              </Text>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

/** 1:1 history rows: newest first, scores + flags + updates at a glance. */
function CheckInList({
  items,
  limit,
  callerPersonId,
}: {
  items: CheckInRow[];
  limit?: number;
  /** The caller's roster id — authors get a delete (mis-log correction). */
  callerPersonId: Id<"people"> | null;
}) {
  const removeCheckIn = useMutation(api.checkIns.remove);
  const shown = limit ? items.slice(0, limit) : items;
  return (
    <View style={{ gap: spacing.xs }}>
      {shown.map((c) => {
        const flagged = (c.responsibilities ?? []).filter((r) => !r.fulfilling);
        return (
          <View
            key={c._id}
            className="rounded-md border border-border bg-raised px-3 py-2"
            style={{ gap: 3 }}
          >
            <View className="flex-row flex-wrap items-center gap-2">
              <Badge
                label={c.type === "skip" ? "Skipped" : "1:1"}
                tone={c.type === "skip" ? "neutral" : "accent"}
              />
              <Text className="text-xs text-muted">
                {formatDate(c.createdAt)}
                {c.managerName ? ` · by ${c.managerName}` : ""}
              </Text>
              <View className="flex-1" />
              {callerPersonId != null && c.managerPersonId === callerPersonId ? (
                <Pressable
                  onPress={() =>
                    confirmAction({
                      title: "Delete this 1:1 entry?",
                      message: "Use this to correct a mis-logged check-in.",
                      confirmLabel: "Delete",
                      destructive: true,
                      onConfirm: () => {
                        void removeCheckIn({ checkInId: c._id }).catch(
                          alertError,
                        );
                      },
                    })
                  }
                  hitSlop={6}
                  accessibilityLabel="Delete check-in"
                  className="rounded p-0.5 active:bg-sunken web:hover:bg-sunken"
                >
                  <Icon name="trash-2" size={12} color={colors.faint} />
                </Pressable>
              ) : null}
              {c.workloadScore != null ? (
                <OptionTag
                  label={`Load ${c.workloadScore}/10`}
                  color={
                    c.workloadScore >= 8
                      ? "red"
                      : c.workloadScore <= 3
                        ? "amber"
                        : "green"
                  }
                />
              ) : null}
              {c.interestScore != null ? (
                <OptionTag
                  label={`Work ${c.interestScore}/10`}
                  color={c.interestScore <= 4 ? "amber" : "green"}
                />
              ) : null}
            </View>
            {flagged.length > 0 ? (
              <Text className="text-xs text-danger">
                Duties off track:{" "}
                {flagged
                  .map(
                    (r) =>
                      `${r.title}${r.action ? ` → ${CHECKIN_ACTION_LABELS[r.action]}` : ""}`,
                  )
                  .join(" · ")}
              </Text>
            ) : null}
            {(c.projects ?? []).some((p) => !p.onTrack) ? (
              <Text className="text-xs text-danger">
                Projects off track:{" "}
                {(c.projects ?? [])
                  .filter((p) => !p.onTrack)
                  .map((p) => `${p.name}${p.note ? ` — ${p.note}` : ""}`)
                  .join(" · ")}
              </Text>
            ) : null}
            {c.feedbackWell ? (
              <Text className="text-xs text-ink">
                <Text className="font-semibold text-success">Doing well: </Text>
                {c.feedbackWell}
              </Text>
            ) : null}
            {c.feedbackImprove ? (
              <Text className="text-xs text-ink">
                <Text className="font-semibold text-warn">Can improve: </Text>
                {c.feedbackImprove}
              </Text>
            ) : null}
            {c.feedbackAboveBeyond ? (
              <Text className="text-xs text-ink">
                <Text className="font-semibold text-accent">
                  Above & beyond:{" "}
                </Text>
                {c.feedbackAboveBeyond}
              </Text>
            ) : null}
            {c.personalUpdate ? (
              <Text className="text-xs text-ink">
                <Text className="font-semibold text-muted">Personal: </Text>
                {c.personalUpdate}
              </Text>
            ) : null}
            {c.workloadNote || c.interestNote || c.notes ? (
              <Text className="text-xs text-muted" numberOfLines={3}>
                {[c.workloadNote, c.interestNote, c.notes]
                  .filter(Boolean)
                  .join(" · ")}
              </Text>
            ) : null}
          </View>
        );
      })}
      {limit && items.length > limit ? (
        <Text className="text-2xs font-semibold text-faint">
          Showing {limit} of the {items.length} most recent — the full record
          is under “1:1 history” on their page
        </Text>
      ) : null}
    </View>
  );
}

/**
 * The complete 1:1 record for one person, in a same-page modal — every
 * check-in and skip ever logged, newest first, so the reporting chain can
 * read the arc of someone's progress in one scroll. Mounted only while open,
 * so the uncapped query costs nothing until asked for.
 */
function CheckInHistoryModal({
  person,
  onClose,
}: {
  person: { _id: Id<"people">; name: string };
  onClose: () => void;
}) {
  const history = useQuery(api.checkIns.historyForPerson, {
    personId: person._id,
  });
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        className="flex-1 items-center justify-center bg-ink/30 p-6"
      >
        <Pressable
          onPress={() => {}}
          className="max-h-full w-full max-w-xl overflow-hidden rounded-xl border border-border bg-raised shadow-pop"
        >
          <View className="flex-row items-center justify-between border-b border-border px-5 py-4">
            <Text className="font-display text-lg text-ink" numberOfLines={1}>
              1:1 history — {person.name}
            </Text>
            <Pressable onPress={onClose} hitSlop={8} className="rounded-md p-1">
              <Icon name="x" size={18} color={colors.muted} />
            </Pressable>
          </View>
          <ScrollView
            style={{ maxHeight: 560 }}
            contentContainerStyle={{ padding: spacing.lg }}
          >
            {history === undefined ? (
              <Text className="text-sm text-faint">Loading history…</Text>
            ) : history === null ? (
              <Text className="text-sm text-faint">
                This record is only visible to {person.name}'s reporting chain.
              </Text>
            ) : history.entries.length === 0 ? (
              <Text className="text-sm text-faint">
                No 1:1s logged yet — the history builds as their manager logs
                check-ins.
              </Text>
            ) : (
              <>
                <Text className="mb-2 text-xs font-semibold text-muted">
                  {history.entries.length}{" "}
                  {history.entries.length === 1 ? "entry" : "entries"}, newest
                  first
                </Text>
                <CheckInList
                  items={history.entries}
                  callerPersonId={history.callerPersonId}
                />
              </>
            )}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
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
