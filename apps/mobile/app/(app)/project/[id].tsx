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
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  Screen,
  Narrow,
  EmptyState,
  Button,
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
import { colors, spacing } from "../../../lib/theme";
import { formatDate, formatDateTime } from "../../../lib/format";

export default function ProjectScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const projectId = id ? (id as Id<"projects">) : undefined;
  const detail = useQuery(
    api.projects.get,
    projectId ? { projectId } : "skip",
  );
  const projects = useQuery(api.projects.list);
  const people = useQuery(api.people.list, {});
  const log = useQuery(
    api.projects.updateLog,
    projectId ? { projectId } : "skip",
  );

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
            <Button
              title="Back to Work"
              variant="secondary"
              icon="arrow-left"
              onPress={() => router.navigate("/team" as any)}
            />
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
        <Pressable
          onPress={() => router.navigate("/team" as any)}
          className="mb-4 flex-row items-center gap-1 self-start active:opacity-70"
        >
          <Icon name="arrow-left" size={15} color={colors.muted} />
          <Text className="text-sm text-muted">Work</Text>
        </Pressable>

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
