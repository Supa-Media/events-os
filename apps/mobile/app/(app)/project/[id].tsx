/**
 * PROJECT — a project's own standalone page: the detail view you can send
 * someone when talking about a project. `projects.get` is the transparent read
 * (any roster member can open it; `canManage` gates only deletion) plus the
 * header meta; `projects.list` supplies the sub-project tree the ProjectCard
 * recurses through; `projects.updateLog` is the audit trail rendered below.
 * Anyone on the roster can edit the project here — the update log keeps every
 * change accountable. Out-of-chapter and deleted projects land on the same
 * not-found state so a shared link never confirms existence to an outsider.
 */
import { useMemo } from "react";
import { View, Text, Pressable, Platform } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery, useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  Screen,
  Narrow,
  EmptyState,
  BackLink,
  Icon,
  Avatar,
  SectionHeader,
  CopyButton,
} from "../../../components/ui";
import {
  ProjectCard,
  buildProjectTree,
  type ProjectDoc,
} from "../../../components/team/ProjectCard";
import { ScopeToggle } from "../../../components/team/ScopeToggle";
import { MoneyView } from "../../../components/money/MoneyView";
import { colors, spacing } from "../../../lib/theme";
import { formatDate, formatDateTime } from "../../../lib/format";
import { alertError } from "../../../lib/errors";
import { confirmAction } from "../../../components/event/ticketing/helpers";

export default function ProjectScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const projectId = id ? (id as Id<"projects">) : undefined;
  const detail = useQuery(
    api.projects.get,
    projectId ? { projectId } : "skip",
  );
  const projects = useQuery(api.projects.list, {});
  const people = useQuery(api.people.list, {});
  const log = useQuery(
    api.projects.updateLog,
    projectId ? { projectId } : "skip",
  );
  const transferScope = useMutation(api.finances.transferProjectScope);

  // Move the project's money attribution — the SAME `transferProjectScope`
  // retroactive/creation flows both use (no second scope-move path). "chapter"
  // always means the project's own home chapter (`detail.chapterId`), the only
  // non-central level a project-scoped budget can sit at. Uses
  // `homeChapterName` (always concrete), NOT `scopeChapterName` (null while
  // the project currently sits at Central) — otherwise moving BACK from
  // Central would confirm/label the destination as generic "the chapter".
  function handleScopeChange(next: "central" | "chapter") {
    if (!projectId || !detail) return;
    const target = next === "central" ? "central" : detail.chapterId;
    const destLabel = next === "central" ? "Central" : detail.homeChapterName ?? "the chapter";
    confirmAction({
      title: `Move to ${destLabel}?`,
      message: `Moves the project and its budget/spend attribution to ${destLabel}.`,
      confirmLabel: "Move",
      onConfirm: () => {
        void transferScope({ projectId, target }).catch(alertError);
      },
    });
  }

  const peopleById = useMemo(
    () => new Map((people ?? []).map((p) => [p._id, p.name])),
    [people],
  );
  const childrenOf = useMemo(
    () => buildProjectTree(projects ?? []),
    [projects],
  );

  if (
    !projectId ||
    detail === undefined ||
    projects === undefined ||
    people === undefined
  ) {
    return <Screen loading />;
  }

  if (detail === null) {
    return (
      <Screen>
        <Narrow>
          <EmptyState
            title="Project not found"
            message="It may have been deleted, or it belongs to another chapter."
          />
          <View className="mt-4 items-start">
            <BackLink fallback="/team" />
          </View>
        </Narrow>
      </Screen>
    );
  }

  // The list copy carries the joined `lastComment`; fall back to the get
  // payload (already a superset of the project doc) if the list hasn't it.
  const project =
    projects.find((p) => p._id === projectId) ?? (detail as ProjectDoc);
  // On web the current URL IS the shareable link; native falls back gracefully.
  const shareUrl =
    Platform.OS === "web" && typeof window !== "undefined"
      ? window.location.href
      : undefined;

  return (
    <Screen>
      <Narrow>
        <BackLink fallback="/team" />

        {/* Page header — the title/owner/date you'd read out when sharing. */}
        <View className="mb-4">
          <View className="flex-row items-start justify-between gap-3">
            <Text className="flex-1 font-display text-2xl text-ink">
              {project.name || "Untitled project"}
            </Text>
            {shareUrl ? <CopyButton text={shareUrl} label /> : null}
          </View>
          <View className="mt-1 flex-row flex-wrap items-center gap-x-3 gap-y-1">
            {detail.ownerName ? (
              <Text className="text-sm text-muted">
                Owned by{" "}
                <Text className="font-semibold text-ink">
                  {detail.ownerName}
                </Text>
              </Text>
            ) : null}
            {project.deadline != null ? (
              <Text className="text-sm text-muted">
                Due {formatDate(project.deadline)}
              </Text>
            ) : null}
            {detail.parentName && project.parentProjectId ? (
              <Pressable
                onPress={() =>
                  router.push(`/project/${project.parentProjectId}` as any)
                }
                className="flex-row items-center gap-1 active:opacity-70"
              >
                <Icon name="corner-left-up" size={12} color={colors.accent} />
                <Text className="text-sm font-medium text-accent">
                  {detail.parentName}
                </Text>
              </Pressable>
            ) : null}
          </View>
        </View>

        <ProjectCard
          project={project}
          childrenOf={childrenOf}
          peopleById={peopleById}
          showOwner
          defaultExpanded
          canManage={detail.canManage}
        />

        {/* Money — what's this project costing? Planned vs actual by
            category, assembled from the v2 budget + its planned lines +
            linked transactions; a link through to the budget in Finances. */}
        <View className="mt-6">
          <SectionHeader
            title="Money"
            right={
              <View className="flex-row items-center gap-2">
                <Text className="text-xs font-semibold uppercase tracking-wider text-faint">
                  Belongs to
                </Text>
                {detail.canChangeScope ? (
                  <ScopeToggle
                    value={detail.scope === "central" ? "central" : "chapter"}
                    chapterName={detail.homeChapterName ?? "This chapter"}
                    onChange={handleScopeChange}
                  />
                ) : (
                  <Text className="text-xs font-semibold text-ink">
                    {detail.scope === "central" ? "Central" : detail.scopeChapterName ?? "This chapter"}
                  </Text>
                )}
              </View>
            }
          />
          <MoneyView refKind="project" refId={projectId} />
        </View>

        {/* Update log — the audit trail of every change, newest first. */}
        {log && log.length > 0 ? (
          <View className="mt-6">
            <SectionHeader title="Update log" count={log.length} />
            <View style={{ gap: spacing.xs }}>
              {log.map((e) => (
                <View
                  key={e._id}
                  className="flex-row items-start gap-2 rounded-md border border-border bg-raised px-3 py-2"
                >
                  <Avatar name={e.authorName || "?"} size={20} />
                  <View className="flex-1">
                    <Text className="text-sm text-ink">{e.summary}</Text>
                    <Text className="text-2xs text-faint">
                      {e.authorName ?? "An admin"} · {formatDateTime(e.createdAt)}
                    </Text>
                  </View>
                </View>
              ))}
            </View>
          </View>
        ) : null}
      </Narrow>
    </Screen>
  );
}
