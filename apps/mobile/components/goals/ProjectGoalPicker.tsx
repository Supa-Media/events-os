/**
 * The "Goal" row on a project page: which ONE key result this project moves.
 * A project is the work and the key result is the score, so the link lives
 * here and the key result's sheet lists the projects pointing at it. Anyone
 * who can edit the project can change it (`projectGoals.setKeyResult`).
 */
import { Text, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Select, SectionHeader } from "../ui";
import { alertError } from "../../lib/errors";

export function ProjectGoalPicker({
  projectId,
  keyResultId,
}: {
  projectId: Id<"projects">;
  keyResultId: Id<"goalKeyResults"> | undefined;
}) {
  const options = useQuery(api.goals.keyResultOptions);
  const setKeyResult = useMutation(api.projectGoals.setKeyResult);
  if (options === undefined) return null;
  if (options.length === 0 && !keyResultId) return null;
  return (
    <View className="mt-6">
      <SectionHeader title="Goal" />
      <Select
        value={keyResultId ?? ""}
        searchable
        options={[{ value: "", label: "Not tied to a goal" }, ...options.map((o) => ({ value: o._id, label: o.label }))]}
        onChange={(id) =>
          setKeyResult({
            projectId,
            keyResultId: id ? (id as Id<"goalKeyResults">) : null,
          }).catch(alertError)
        }
      />
      <Text className="mt-1.5 text-xs text-muted">
        The one key result this project moves. Its progress shows on the Goals page.
      </Text>
    </View>
  );
}
