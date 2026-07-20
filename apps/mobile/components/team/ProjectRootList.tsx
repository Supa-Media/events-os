/**
 * ProjectRootList — a person's root projects, current-first, with a
 * collapsed "Past projects" dropdown for anything marked done. Mirrors
 * EventsAndRoles' "Past events" pattern (WorkloadView.tsx) so project and
 * event history read the same way across the Work page. Shared by the
 * person section and TeamMemberBlock's per-report rollup so both stay in
 * lockstep.
 *
 * The split happens ONLY at the root level — a done sub-project under a
 * still-live root stays nested inside that root's card, wherever the root
 * lands (current or past).
 */
import { useState } from "react";
import { View, Text, Pressable } from "react-native";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Icon } from "../ui";
import { colors, spacing } from "../../lib/theme";
import { ProjectCard, type ProjectDoc } from "./ProjectCard";

export function ProjectRootList({
  roots,
  projectTree,
  peopleById,
  showOwner,
  canManage,
  partOfFor,
}: {
  roots: ProjectDoc[];
  projectTree: Map<Id<"projects">, ProjectDoc[]>;
  peopleById: Map<Id<"people">, string>;
  showOwner: boolean;
  canManage: boolean;
  /** "Part of {parent}" chip data for cross-assigned sub-project roots. */
  partOfFor: (
    p: ProjectDoc,
  ) => { name: string; onPress: () => void } | undefined;
}) {
  const [showPast, setShowPast] = useState(false);

  const current = roots.filter((p) => p.status !== "done");
  const past = roots.filter((p) => p.status === "done");

  const card = (p: ProjectDoc) => (
    <ProjectCard
      key={p._id}
      project={p}
      childrenOf={projectTree}
      peopleById={peopleById}
      showOwner={showOwner}
      canManage={canManage}
      showOpenPage
      partOf={partOfFor(p)}
    />
  );

  return (
    <View style={{ gap: spacing.sm }}>
      {current.map(card)}
      {past.length > 0 ? (
        <View style={{ gap: spacing.sm }}>
          <Pressable
            onPress={() => setShowPast((v) => !v)}
            accessibilityRole="button"
            accessibilityState={{ expanded: showPast }}
            className="flex-row items-center gap-1.5 rounded-md px-1 py-1 active:bg-sunken web:hover:bg-sunken"
          >
            <Icon
              name={showPast ? "chevron-down" : "chevron-right"}
              size={14}
              color={colors.muted}
            />
            <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
              Past projects
            </Text>
            <Text className="text-2xs font-bold text-faint">
              {past.length}
            </Text>
          </Pressable>
          {showPast ? (
            <View style={{ gap: spacing.sm }}>{past.map(card)}</View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
