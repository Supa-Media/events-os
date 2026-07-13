/**
 * PROJECT — a project's own page, the detail route the reminder emails point
 * at. Thin composition over the same pieces the Work tab uses: `projects.list`
 * (the canonical scoped read — reusing it keeps this page's visibility exactly
 * the manager-subtree rule, with no second implementation to drift) and the
 * fully-editable ProjectCard (status, fields, sub-projects, comment thread).
 * Out-of-scope and deleted projects land on the same not-found state so a
 * denial never confirms existence.
 */
import { useMemo } from "react";
import { View, Text, Pressable } from "react-native";
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
} from "../../../components/ui";
import {
  ProjectCard,
  buildProjectTree,
} from "../../../components/team/ProjectCard";
import { colors } from "../../../lib/theme";

export default function ProjectScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const projects = useQuery(api.projects.list);
  const people = useQuery(api.people.list, {});

  const peopleById = useMemo(
    () => new Map((people ?? []).map((p) => [p._id, p.name])),
    [people],
  );
  const childrenOf = useMemo(
    () => buildProjectTree(projects ?? []),
    [projects],
  );

  if (!id || projects === undefined || people === undefined) {
    return <Screen loading />;
  }

  const project = projects.find((p) => p._id === (id as Id<"projects">));
  if (!project) {
    return (
      <Screen>
        <Narrow>
          <EmptyState
            title="Project not found"
            message="It may have been deleted, or it belongs to someone outside your team."
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

  const parent = project.parentProjectId
    ? projects.find((p) => p._id === project.parentProjectId)
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
        <ProjectCard
          project={project}
          childrenOf={childrenOf}
          peopleById={peopleById}
          showOwner
          defaultExpanded
          partOf={
            parent
              ? {
                  name: parent.name || "Untitled project",
                  onPress: () =>
                    router.push(`/project/${parent._id}` as any),
                }
              : undefined
          }
        />
      </Narrow>
    </Screen>
  );
}
