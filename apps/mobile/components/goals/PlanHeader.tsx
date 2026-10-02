/**
 * The top of a year plan: its name and status, the mission, the
 * retrospective that led to it, and the headline targets with their
 * breakdowns. Every piece is editable in place for whoever may edit plans.
 */
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  GOAL_PLAN_STATUSES,
  GOAL_PLAN_STATUS_LABELS,
  GOAL_UNITS,
  GOAL_UNIT_LABELS,
  formatGoalValue,
  type GoalPlanStatus,
  type GoalUnit,
} from "@events-os/shared";
import { Badge, Button, Card, Icon, ProgressBar, SectionHeader, Select, TextField } from "../ui";
import { EditableText } from "./EditableText";
import { parseNumber } from "./goalsFormat";
import { colors } from "../../lib/theme";
import { alertError } from "../../lib/errors";
import { confirmAction } from "../event/ticketing/helpers";

export type PlanData = NonNullable<FunctionReturnType<typeof api.goals.plan>>;
type Target = PlanData["targets"][number];
type ChildTarget = Target["children"][number];

const linesOf = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);

export function PlanHeader({ data, canEdit }: { data: PlanData; canEdit: boolean }) {
  const updatePlan = useMutation(api.goalsEdit.updatePlan);
  const createTarget = useMutation(api.goalsEdit.createTarget);
  const { plan } = data;

  return (
    <View className="gap-4">
      <View className="gap-2">
        <View className="flex-row items-center gap-2 flex-wrap">
          <Badge
            label={GOAL_PLAN_STATUS_LABELS[plan.status]}
            tone={plan.status === "active" ? "success" : plan.status === "draft" ? "warn" : "neutral"}
          />
          {canEdit ? (
            <View className="w-40">
              <Select
                value={plan.status}
                options={GOAL_PLAN_STATUSES.map((s) => ({ value: s, label: GOAL_PLAN_STATUS_LABELS[s] }))}
                onChange={(s) =>
                  updatePlan({ planId: plan._id, status: s as GoalPlanStatus }).catch(alertError)
                }
              />
            </View>
          ) : null}
        </View>
        <EditableText
          label="plan name"
          value={plan.title}
          canEdit={canEdit}
          textClassName="font-display text-2xl text-ink"
          onSave={(title) => updatePlan({ planId: plan._id, title })}
        />
      </View>

      <Card>
        <Text className="text-xs font-semibold uppercase tracking-wide text-muted mb-2">Mission</Text>
        <EditableText
          label="mission"
          value={plan.mission ?? ""}
          placeholder="Add the mission"
          multiline
          canEdit={canEdit}
          textClassName="text-base text-ink leading-6"
          onSave={(mission) => updatePlan({ planId: plan._id, mission: mission.trim() || null })}
        />
      </Card>

      <View className="flex-row flex-wrap gap-4">
        <RetroList
          title="What went well"
          items={plan.retroWins}
          canEdit={canEdit}
          onSave={(retroWins) => updatePlan({ planId: plan._id, retroWins })}
        />
        <RetroList
          title="What we'll do better"
          items={plan.retroGaps}
          canEdit={canEdit}
          onSave={(retroGaps) => updatePlan({ planId: plan._id, retroGaps })}
        />
      </View>

      <View>
        <SectionHeader
          title="Targets"
          count={data.targets.length}
          right={
            canEdit ? (
              <Button
                title="Add target"
                size="sm"
                variant="ghost"
                icon="plus"
                onPress={() =>
                  createTarget({ planId: plan._id, label: "New target", target: 1, unit: "count" }).catch(
                    alertError,
                  )
                }
              />
            ) : null
          }
        />
        <View className="flex-row flex-wrap gap-3">
          {data.targets.map((t) => (
            <TargetCard key={t._id} target={t} planId={plan._id} canEdit={canEdit} />
          ))}
        </View>
      </View>
    </View>
  );
}

function RetroList({
  title,
  items,
  canEdit,
  onSave,
}: {
  title: string;
  items: string[];
  canEdit: boolean;
  onSave: (items: string[]) => Promise<unknown>;
}) {
  if (!canEdit && items.length === 0) return null;
  return (
    <Card className="flex-1 min-w-[280px]">
      <Text className="text-xs font-semibold uppercase tracking-wide text-muted mb-2">{title}</Text>
      <EditableText
        label={title}
        value={items.join("\n")}
        placeholder="One per line"
        multiline
        canEdit={canEdit}
        textClassName="text-sm text-ink leading-6"
        onSave={(text) => onSave(linesOf(text))}
      />
    </Card>
  );
}

function TargetCard({
  target,
  planId,
  canEdit,
}: {
  target: Target;
  planId: Id<"goalPlans">;
  canEdit: boolean;
}) {
  const createTarget = useMutation(api.goalsEdit.createTarget);
  return (
    <Card className="flex-1 min-w-[260px]">
      <TargetRow row={target} unit={target.unit} canEdit={canEdit} headline />
      {target.children.length > 0 ? (
        <View className="mt-3 gap-2 border-t border-border pt-3">
          {target.children.map((c) => (
            <TargetRow key={c._id} row={c} unit={target.unit} canEdit={canEdit} />
          ))}
        </View>
      ) : null}
      {canEdit ? (
        <View className="mt-2 items-start">
          <Button
            title="Add breakdown"
            size="sm"
            variant="ghost"
            icon="plus"
            onPress={() =>
              createTarget({
                planId,
                label: "New line",
                target: 1,
                unit: target.unit,
                parentTargetId: target._id,
              }).catch(alertError)
            }
          />
        </View>
      ) : null}
    </Card>
  );
}

function TargetRow({
  row,
  unit,
  canEdit,
  headline,
}: {
  row: Target | ChildTarget;
  unit: GoalUnit;
  canEdit: boolean;
  headline?: boolean;
}) {
  const updateTarget = useMutation(api.goalsEdit.updateTarget);
  const deleteTarget = useMutation(api.goalsEdit.deleteTarget);
  const moveTarget = useMutation(api.goalsEdit.moveTarget);
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(row.label);
  const [target, setTarget] = useState(String(row.target));
  const [current, setCurrent] = useState(row.current != null ? String(row.current) : "");
  const [rowUnit, setRowUnit] = useState<GoalUnit>(row.unit);

  const fraction = row.current != null && row.target > 0 ? Math.min(1, row.current / row.target) : null;

  if (editing) {
    const save = async () => {
      const t = parseNumber(target);
      const c = parseNumber(current);
      if (t == null || t === undefined || c === undefined) {
        alertError(new Error("Targets and progress need to be numbers."));
        return;
      }
      try {
        await updateTarget({
          targetId: row._id,
          label,
          target: t,
          current: c,
          ...(headline ? { unit: rowUnit } : {}),
        });
        setEditing(false);
      } catch (err) {
        alertError(err);
      }
    };
    return (
      <View className="gap-2">
        <TextField label="Name" value={label} onChangeText={setLabel} />
        <View className="flex-row gap-2">
          <View className="flex-1">
            <TextField label="Target" value={target} onChangeText={setTarget} keyboardType="numeric" />
          </View>
          <View className="flex-1">
            <TextField label="So far" value={current} onChangeText={setCurrent} keyboardType="numeric" />
          </View>
        </View>
        {headline ? (
          <Select
            label="Unit"
            value={rowUnit}
            options={GOAL_UNITS.map((u) => ({ value: u, label: GOAL_UNIT_LABELS[u] }))}
            onChange={(u) => setRowUnit(u as GoalUnit)}
          />
        ) : null}
        <View className="flex-row flex-wrap gap-2">
          <Button title="Save" size="sm" onPress={save} />
          <Button title="Cancel" size="sm" variant="ghost" onPress={() => setEditing(false)} />
          <Button title="Up" size="sm" variant="ghost" icon="arrow-up" onPress={() => moveTarget({ targetId: row._id, direction: "up" }).catch(alertError)} />
          <Button title="Down" size="sm" variant="ghost" icon="arrow-down" onPress={() => moveTarget({ targetId: row._id, direction: "down" }).catch(alertError)} />
          <Button
            title="Delete"
            size="sm"
            variant="danger"
            onPress={() =>
              confirmAction({
                title: "Delete this target?",
                message: headline ? "Its breakdown lines go with it." : "This removes the line.",
                confirmLabel: "Delete",
                destructive: true,
                onConfirm: () => deleteTarget({ targetId: row._id }).catch(alertError),
              })
            }
          />
        </View>
      </View>
    );
  }

  const body = (
    <View className="gap-1">
      <View className="flex-row items-baseline justify-between gap-2">
        <Text className={headline ? "text-sm font-semibold text-ink flex-1" : "text-sm text-ink flex-1"}>
          {row.label}
        </Text>
        <Text className={headline ? "font-display text-xl text-ink" : "text-sm font-semibold text-ink"}>
          {row.current != null ? `${formatGoalValue(row.current, unit)} / ` : ""}
          {formatGoalValue(row.target, unit)}
        </Text>
        {canEdit ? <Icon name="edit-2" size={12} color={colors.muted} /> : null}
      </View>
      {headline && fraction != null ? <ProgressBar fraction={fraction} /> : null}
    </View>
  );
  if (!canEdit) return body;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Edit ${row.label}`}
      onPress={() => {
        setLabel(row.label);
        setTarget(String(row.target));
        setCurrent(row.current != null ? String(row.current) : "");
        setRowUnit(row.unit);
        setEditing(true);
      }}
    >
      {body}
    </Pressable>
  );
}
