/**
 * The objectives of a plan, each with its key results. Numbering ("2.4") is
 * derived from order, so moving an objective or key result renumbers it.
 * Tapping a key result opens its sheet (details, updates, linked work).
 */
import { Pressable, Text, View } from "react-native";
import { useMutation } from "convex/react";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { api } from "@events-os/convex/_generated/api";
import { KEY_RESULT_STATUS_LABELS, formatGoalValue } from "@events-os/shared";
import { Badge, Button, Card, Icon, ProgressBar, Select } from "../ui";
import { EditableText } from "./EditableText";
import { formatDue, keyResultTone } from "./goalsFormat";
import type { PlanData } from "./PlanHeader";
import { colors } from "../../lib/theme";
import { alertError } from "../../lib/errors";
import { confirmAction } from "../event/ticketing/helpers";

export type Objective = PlanData["objectives"][number];
export type KeyResultRow = Objective["keyResults"][number];

type TeamOption = { _id: Id<"orgTeams">; name: string };

export function ObjectiveList({
  objectives,
  canEdit,
  teams,
  planId,
  onOpen,
}: {
  objectives: Objective[];
  canEdit: boolean;
  teams: TeamOption[];
  planId: Id<"goalPlans">;
  onOpen: (kr: KeyResultRow) => void;
}) {
  const createObjective = useMutation(api.goalsEdit.createObjective);
  return (
    <View className="gap-4">
      {objectives.map((o, i) => (
        <ObjectiveCard
          key={o._id}
          objective={o}
          canEdit={canEdit}
          teams={teams}
          first={i === 0}
          last={i === objectives.length - 1}
          onOpen={onOpen}
        />
      ))}
      {canEdit ? (
        <View className="items-start">
          <Button
            title="Add objective"
            icon="plus"
            variant="secondary"
            onPress={() => createObjective({ planId, title: "New objective" }).catch(alertError)}
          />
        </View>
      ) : null}
    </View>
  );
}

function ObjectiveCard({
  objective: o,
  canEdit,
  teams,
  first,
  last,
  onOpen,
}: {
  objective: Objective;
  canEdit: boolean;
  teams: TeamOption[];
  first: boolean;
  last: boolean;
  onOpen: (kr: KeyResultRow) => void;
}) {
  const updateObjective = useMutation(api.goalsEdit.updateObjective);
  const deleteObjective = useMutation(api.goalsEdit.deleteObjective);
  const moveObjective = useMutation(api.goalsEdit.moveObjective);
  const createKeyResult = useMutation(api.goalsEdit.createKeyResult);
  const done = o.keyResults.filter((k) => k.progress.displayStatus === "done").length;

  return (
    <Card padding="none">
      <View className="p-4 gap-2 border-b border-border">
        <View className="flex-row items-center gap-2 flex-wrap">
          <Text className="text-xs font-semibold uppercase tracking-wide text-accent">
            Objective {o.number}
          </Text>
          <Text className="text-xs text-muted">
            {done} of {o.keyResults.length} done
          </Text>
          {!canEdit && o.ownerTeamName ? <Badge label={o.ownerTeamName} tone="lavender" /> : null}
        </View>
        <EditableText
          label="objective"
          value={o.title}
          canEdit={canEdit}
          textClassName="font-display text-lg text-ink"
          onSave={(title) => updateObjective({ objectiveId: o._id, title })}
        />
        {canEdit ? (
          <View className="flex-row flex-wrap items-end gap-2">
            <View className="min-w-[200px] flex-1">
              <Select
                label="Owning team"
                value={o.ownerTeamId ?? ""}
                options={[{ value: "", label: "No team" }, ...teams.map((t) => ({ value: t._id, label: t.name }))]}
                onChange={(id) =>
                  updateObjective({
                    objectiveId: o._id,
                    ownerTeamId: id ? (id as Id<"orgTeams">) : null,
                  }).catch(alertError)
                }
              />
            </View>
            {!first ? (
              <Button title="Up" size="sm" variant="ghost" icon="arrow-up" onPress={() => moveObjective({ objectiveId: o._id, direction: "up" }).catch(alertError)} />
            ) : null}
            {!last ? (
              <Button title="Down" size="sm" variant="ghost" icon="arrow-down" onPress={() => moveObjective({ objectiveId: o._id, direction: "down" }).catch(alertError)} />
            ) : null}
            <Button
              title="Delete"
              size="sm"
              variant="ghost"
              icon="trash-2"
              onPress={() =>
                confirmAction({
                  title: `Delete objective ${o.number}?`,
                  message: `Its ${o.keyResults.length} key results and their updates go with it. Linked projects stay, unlinked.`,
                  confirmLabel: "Delete",
                  destructive: true,
                  onConfirm: () => deleteObjective({ objectiveId: o._id }).catch(alertError),
                })
              }
            />
          </View>
        ) : null}
      </View>
      {o.keyResults.map((k, i) => (
        <KeyResultLine key={k._id} kr={k} first={i === 0} onOpen={onOpen} />
      ))}
      {canEdit ? (
        <View className="p-3 items-start">
          <Button
            title="Add key result"
            size="sm"
            variant="ghost"
            icon="plus"
            onPress={() => createKeyResult({ objectiveId: o._id, title: "New key result" }).catch(alertError)}
          />
        </View>
      ) : null}
    </Card>
  );
}

export function KeyResultLine({
  kr,
  first,
  onOpen,
  showObjective,
}: {
  kr: KeyResultRow;
  first?: boolean;
  onOpen: (kr: KeyResultRow) => void;
  showObjective?: string;
}) {
  const p = kr.progress;
  return (
    <Pressable
      onPress={() => onOpen(kr)}
      accessibilityRole="button"
      accessibilityLabel={`Key result ${kr.code}: ${kr.title}`}
      className={`px-4 py-3 gap-1.5 active:bg-sunken ${first ? "" : "border-t border-border"}`}
    >
      <View className="flex-row items-start gap-3">
        <Text className="w-9 text-sm font-semibold text-muted">{kr.code}</Text>
        <View className="flex-1 gap-1">
          {showObjective ? <Text className="text-xs text-muted">{showObjective}</Text> : null}
          <Text className="text-sm text-ink">{kr.title}</Text>
          <View className="flex-row flex-wrap items-center gap-x-3 gap-y-1">
            {kr.ownerLabel ? <Text className="text-xs font-semibold text-ink">{kr.ownerLabel}</Text> : null}
            {kr.contributorNames.length > 0 ? (
              <Text className="text-xs text-muted">with {kr.contributorNames.join(", ")}</Text>
            ) : null}
            {kr.dueDate ? (
              <Text className="text-xs text-muted">Due {formatDue(kr.dueDate)}</Text>
            ) : kr.timing ? (
              <Text className="text-xs text-muted">{kr.timing}</Text>
            ) : null}
            {kr.linkedProjectCount > 0 ? (
              <View className="flex-row items-center gap-1">
                <Icon name="git-branch" size={11} color={colors.muted} />
                <Text className="text-xs text-muted">
                  {kr.linkedProjectCount} {kr.linkedProjectCount === 1 ? "project" : "projects"}
                </Text>
              </View>
            ) : null}
          </View>
          {p.fraction != null ? (
            <View className="flex-row items-center gap-2">
              <View className="flex-1">
                <ProgressBar fraction={p.fraction} />
              </View>
              <Text className="text-xs text-muted">
                {formatGoalValue(p.current ?? 0, kr.unit)} of {formatGoalValue(p.target ?? 0, kr.unit)}
              </Text>
            </View>
          ) : null}
        </View>
        <Badge label={KEY_RESULT_STATUS_LABELS[p.displayStatus]} tone={keyResultTone(p.displayStatus)} />
      </View>
    </Pressable>
  );
}
