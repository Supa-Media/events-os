/**
 * GOALS — the org's year plans. One page with two views of the same plan:
 * Objectives (mission, targets, objectives and their key results) and
 * Deadlines (every dated key result in order). A team filter narrows both.
 *
 * Everything is editable in place for whoever may edit plans
 * (`goals.overview.canEdit`, see `apps/convex/lib/goalsAccess.ts`): copy,
 * targets, objectives, key results, owners, order, and the plan's status.
 * Anyone may post an update on a key result. The 2027 One Pager is offered
 * as starting data when no plan exists yet.
 */
import { useMemo, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Button, EmptyState, Narrow, PageHeader, Pill, Screen, SectionHeader, Select } from "../ui";
import { PlanHeader, type PlanData } from "./PlanHeader";
import { KeyResultLine, ObjectiveList, type KeyResultRow } from "./ObjectiveList";
import { KeyResultSheet } from "./KeyResultSheet";
import { formatDue } from "./goalsFormat";
import { alertError } from "../../lib/errors";
import { confirmAction } from "../event/ticketing/helpers";

type View_ = "objectives" | "deadlines";

export function GoalsScreen() {
  const overview = useQuery(api.goals.overview);
  const [pickedPlanId, setPickedPlanId] = useState<Id<"goalPlans"> | null>(null);

  if (overview === undefined) return <Screen loading />;
  if (overview === null) {
    return (
      <Screen>
        <Narrow>
          <EmptyState icon="lock" title="Goals aren't available" message="You need an approved account to see the year plan." />
        </Narrow>
      </Screen>
    );
  }

  const plans = [...overview.plans].sort((a, b) => a.year - b.year);
  const fallback =
    [...plans].reverse().find((p) => p.status === "active") ?? plans[plans.length - 1] ?? null;
  const planId = plans.some((p) => p._id === pickedPlanId) ? pickedPlanId : (fallback?._id ?? null);

  return (
    <Screen>
      <Narrow width={960}>
        <GoalsHeader canEdit={overview.canEdit} plans={plans} onCreated={setPickedPlanId} />
        {plans.length > 1 ? (
          <View className="mb-4 flex-row flex-wrap gap-2">
            {plans.map((p) => (
              <Pill key={p._id} label={`${p.year}`} selected={p._id === planId} onPress={() => setPickedPlanId(p._id)} />
            ))}
          </View>
        ) : null}
        {planId ? (
          <PlanView planId={planId} canEdit={overview.canEdit} canUpdate={overview.canUpdate} />
        ) : (
          <NoPlan canEdit={overview.canEdit} onCreated={setPickedPlanId} />
        )}
      </Narrow>
    </Screen>
  );
}

function GoalsHeader({
  canEdit,
  plans,
  onCreated,
}: {
  canEdit: boolean;
  plans: { year: number }[];
  onCreated: (id: Id<"goalPlans">) => void;
}) {
  const router = useRouter();
  const createPlan = useMutation(api.goalsEdit.createPlan);
  const nextYear = plans.length
    ? Math.max(...plans.map((p) => p.year)) + 1
    : new Date().getFullYear() + 1;
  return (
    <PageHeader
      title="Goals"
      subtitle="The year plan: what we're aiming for and how we'll know."
      actions={
        <View className="flex-row gap-2">
          <Button title="Teams" variant="secondary" icon="users" onPress={() => router.push("/goals/teams" as any)} />
          {canEdit && plans.length > 0 ? (
            <Button
              title={`Start ${nextYear}`}
              variant="ghost"
              icon="plus"
              onPress={() => createPlan({ year: nextYear }).then(onCreated).catch(alertError)}
            />
          ) : null}
        </View>
      }
    />
  );
}

function NoPlan({ canEdit, onCreated }: { canEdit: boolean; onCreated: (id: Id<"goalPlans">) => void }) {
  const importOnePager = useMutation(api.goalsImport.importOnePager);
  const createPlan = useMutation(api.goalsEdit.createPlan);
  const [busy, setBusy] = useState(false);
  const run = (fn: () => Promise<Id<"goalPlans">>) => {
    setBusy(true);
    fn()
      .then(onCreated)
      .catch(alertError)
      .finally(() => setBusy(false));
  };
  return (
    <EmptyState
      icon="target"
      title="No year plan yet"
      message={
        canEdit
          ? "Start from the 2027 One Pager (mission, targets, 5 objectives and 47 key results, all editable after), or start blank."
          : "When the Executive Director adds the year plan, it shows up here."
      }
      action={
        canEdit ? (
          <View className="flex-row flex-wrap justify-center gap-2">
            <Button title="Start from the 2027 One Pager" loading={busy} onPress={() => run(() => importOnePager())} />
            <Button
              title="Start blank"
              variant="secondary"
              disabled={busy}
              onPress={() => run(() => createPlan({ year: new Date().getFullYear() + 1 }))}
            />
          </View>
        ) : undefined
      }
    />
  );
}

function PlanView({
  planId,
  canEdit,
  canUpdate,
}: {
  planId: Id<"goalPlans">;
  canEdit: boolean;
  canUpdate: boolean;
}) {
  const data = useQuery(api.goals.plan, { planId });
  const options = useQuery(api.goals.editorOptions);
  const deletePlan = useMutation(api.goalsEdit.deletePlan);
  const [view, setView] = useState<View_>("objectives");
  const [teamFilter, setTeamFilter] = useState("");
  const [openId, setOpenId] = useState<Id<"goalKeyResults"> | null>(null);

  const filtered = useMemo(() => (data ? filterByTeam(data, teamFilter) : null), [data, teamFilter]);
  if (data === undefined) return <ActivityIndicator className="mt-10" />;
  if (data === null || !filtered) return <EmptyState title="Plan not found" />;

  const allKrs = data.objectives.flatMap((o) => o.keyResults);
  const open = allKrs.find((k) => k._id === openId) ?? null;
  const onOpen = (kr: KeyResultRow) => setOpenId(kr._id);
  const teams = options?.teams ?? [];

  return (
    <View className="gap-6">
      <PlanHeader data={data} canEdit={canEdit} />

      <View className="gap-3">
        <View className="flex-row flex-wrap items-end justify-between gap-3">
          <View className="flex-row gap-2">
            <Pill label="Objectives" selected={view === "objectives"} onPress={() => setView("objectives")} />
            <Pill label="Deadlines" selected={view === "deadlines"} onPress={() => setView("deadlines")} />
          </View>
          <View className="w-60">
            <Select
              value={teamFilter}
              options={[{ value: "", label: "All teams" }, ...teams.map((t) => ({ value: t._id, label: t.name }))]}
              onChange={setTeamFilter}
            />
          </View>
        </View>

        {view === "objectives" ? (
          <ObjectiveList
            objectives={filtered.objectives}
            canEdit={canEdit && !teamFilter}
            teams={teams}
            planId={planId}
            onOpen={onOpen}
          />
        ) : (
          <Deadlines objectives={filtered.objectives} onOpen={onOpen} />
        )}
      </View>

      {canEdit ? (
        <View className="items-start border-t border-border pt-4">
          <Button
            title={`Delete the ${data.plan.year} plan`}
            variant="ghost"
            icon="trash-2"
            onPress={() =>
              confirmAction({
                title: `Delete the ${data.plan.year} plan?`,
                message: "Every objective, key result and update in it goes. Linked projects stay, unlinked.",
                confirmLabel: "Delete plan",
                destructive: true,
                onConfirm: () => deletePlan({ planId }).catch(alertError),
              })
            }
          />
        </View>
      ) : null}

      <KeyResultSheet
        kr={open}
        objectives={data.objectives}
        canEdit={canEdit}
        canUpdate={canUpdate}
        options={options}
        onClose={() => setOpenId(null)}
      />
    </View>
  );
}

/** Keep only key results the team owns or contributes to, and drop
 *  objectives left empty. No filter returns the plan as is. */
function filterByTeam(data: PlanData, teamId: string): PlanData {
  if (!teamId) return data;
  return {
    ...data,
    objectives: data.objectives
      .map((o) => ({
        ...o,
        keyResults: o.keyResults.filter(
          (k) => k.ownerTeamId === teamId || k.contributorTeamIds.some((c) => c === teamId),
        ),
      }))
      .filter((o) => o.keyResults.length > 0 || o.ownerTeamId === teamId),
  };
}

function Deadlines({
  objectives,
  onOpen,
}: {
  objectives: PlanData["objectives"];
  onOpen: (kr: KeyResultRow) => void;
}) {
  const rows = objectives.flatMap((o) => o.keyResults.map((k) => ({ k, objective: `Objective ${o.number}` })));
  const dated = rows.filter((r) => r.k.dueDate != null).sort((a, b) => a.k.dueDate! - b.k.dueDate!);
  const undated = rows.filter((r) => r.k.dueDate == null);
  const now = Date.now();
  const overdue = dated.filter((r) => r.k.dueDate! < now && r.k.progress.displayStatus !== "done");
  const months = new Map<string, typeof dated>();
  for (const r of dated) {
    if (overdue.includes(r)) continue;
    const label = new Date(r.k.dueDate!).toLocaleDateString("en-US", { timeZone: "UTC", month: "long", year: "numeric" });
    months.set(label, [...(months.get(label) ?? []), r]);
  }
  const group = (title: string, list: typeof rows, tone?: string) =>
    list.length === 0 ? null : (
      <View key={title} className="gap-2">
        <SectionHeader title={title} count={list.length} />
        <View className={`rounded-xl border bg-raised ${tone ?? "border-border"}`}>
          {list.map((r, i) => (
            <KeyResultLine key={r.k._id} kr={r.k} first={i === 0} onOpen={onOpen} showObjective={r.objective} />
          ))}
        </View>
      </View>
    );
  if (rows.length === 0) return <EmptyState title="No key results here" />;
  return (
    <View className="gap-5">
      {group("Overdue", overdue, "border-danger")}
      {[...months.entries()].map(([label, list]) => group(label, list))}
      {undated.length > 0 ? (
        <View className="gap-2">
          {group("Ongoing or no date", undated)}
          <Text className="text-xs text-muted">
            Rhythms like &quot;monthly&quot; or &quot;every event&quot; live as duties or template items; their timing shows on each row.
          </Text>
        </View>
      ) : null}
      {dated.length > 0 ? (
        <Text className="text-xs text-muted">Last deadline: {formatDue(dated[dated.length - 1].k.dueDate!)}</Text>
      ) : null}
    </View>
  );
}
