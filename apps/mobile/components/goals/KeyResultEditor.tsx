/**
 * Every editable field of one key result: who owns it, who helps, when it's
 * due, and how its progress is measured. One Save writes the lot. Shown in
 * the key result sheet to whoever may edit plans.
 */
import { useState } from "react";
import { Text, View } from "react-native";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  GOAL_UNITS,
  GOAL_UNIT_LABELS,
  KEY_RESULT_MEASURE_KINDS,
  KEY_RESULT_MEASURE_LABELS,
  type GoalUnit,
  type KeyResultMeasureKind,
} from "@events-os/shared";
import { Button, Pill, Select, TextField } from "../ui";
import { dueToInput, inputToDue, parseNumber } from "./goalsFormat";
import type { KeyResultRow, Objective } from "./ObjectiveList";
import { alertError } from "../../lib/errors";
import { confirmAction } from "../event/ticketing/helpers";

export type EditorOptions = FunctionReturnType<typeof api.goals.editorOptions>;

const SEAT_PREFIX = "seat:";
const TEAM_PREFIX = "team:";

export function KeyResultEditor({
  kr,
  objectives,
  options,
  onDeleted,
}: {
  kr: KeyResultRow;
  objectives: Objective[];
  options: EditorOptions;
  onDeleted: () => void;
}) {
  const updateKeyResult = useMutation(api.goalsEdit.updateKeyResult);
  const deleteKeyResult = useMutation(api.goalsEdit.deleteKeyResult);
  const moveKeyResult = useMutation(api.goalsEdit.moveKeyResult);

  const [owner, setOwner] = useState(
    kr.ownerTeamId ? TEAM_PREFIX + kr.ownerTeamId : kr.ownerSeatSlug ? SEAT_PREFIX + kr.ownerSeatSlug : "",
  );
  const [contributors, setContributors] = useState<Id<"orgTeams">[]>(kr.contributorTeamIds);
  const [timing, setTiming] = useState(kr.timing ?? "");
  const [due, setDue] = useState(dueToInput(kr.dueDate));
  const [objectiveId, setObjectiveId] = useState<string>(kr.objectiveId);
  const [kind, setKind] = useState<KeyResultMeasureKind>(kr.measureKind);
  const [target, setTarget] = useState(kr.target != null ? String(kr.target) : "");
  const [unit, setUnit] = useState<GoalUnit | "">(kr.unit ?? "");
  const [seatSlug, setSeatSlug] = useState(kr.seatSlug ?? "");
  const [seatScope, setSeatScope] = useState<string>(kr.seatScope ?? "central");
  const [eventTypeIds, setEventTypeIds] = useState<Id<"eventTypes">[]>(kr.eventTypeIds ?? []);
  const [eventChapterId, setEventChapterId] = useState<string>(kr.eventChapterId ?? "");
  const [saving, setSaving] = useState(false);

  const ownerOptions = [
    { value: "", label: "No owner yet" },
    { value: "h:teams", label: "Teams", header: true },
    ...options.teams.map((t) => ({
      value: TEAM_PREFIX + t._id,
      label: t.chapterName ? `${t.name} (${t.chapterName})` : t.name,
    })),
    { value: "h:seats", label: "A seat (every holder owns it)", header: true },
    ...options.seats.map((s) => ({
      value: SEAT_PREFIX + s.slug,
      label: `${s.title}${s.chart === "chapter" ? " (each chapter)" : ""}`,
    })),
  ];

  const toggle = <T,>(list: T[], id: T) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  const save = async () => {
    const dueMs = inputToDue(due);
    const targetNum = parseNumber(target);
    if (dueMs === undefined) return alertError(new Error("Write the due date as YYYY-MM-DD."));
    if (targetNum === undefined) return alertError(new Error("The target needs to be a number."));
    if (kind === "seat_filled" && !seatSlug) return alertError(new Error("Pick the seat to watch."));
    if (kind === "event_count" && eventTypeIds.length === 0) {
      return alertError(new Error("Pick at least one event template to count."));
    }
    setSaving(true);
    try {
      await updateKeyResult({
        keyResultId: kr._id,
        objectiveId: objectiveId as Id<"goalObjectives">,
        ownerTeamId: owner.startsWith(TEAM_PREFIX) ? (owner.slice(TEAM_PREFIX.length) as Id<"orgTeams">) : null,
        ownerSeatSlug: owner.startsWith(SEAT_PREFIX) ? owner.slice(SEAT_PREFIX.length) : null,
        contributorTeamIds: contributors,
        timing: timing.trim() || null,
        dueDate: dueMs,
        measureKind: kind,
        target: targetNum,
        unit: kind === "manual" ? unit || null : null,
        seatSlug: kind === "seat_filled" ? seatSlug : null,
        seatScope:
          kind === "seat_filled"
            ? seatScope === "central"
              ? "central"
              : (seatScope as Id<"chapters">)
            : null,
        eventTypeIds: kind === "event_count" ? eventTypeIds : [],
        eventChapterId: kind === "event_count" && eventChapterId ? (eventChapterId as Id<"chapters">) : null,
      });
    } catch (err) {
      alertError(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <View className="gap-3">
      <Select label="Accountable owner" value={owner} options={ownerOptions} onChange={setOwner} searchable />
      <View className="gap-1.5">
        <Text className="text-sm font-medium text-ink">Contributing teams</Text>
        <View className="flex-row flex-wrap gap-2">
          {options.teams.map((t) => (
            <Pill
              key={t._id}
              size="sm"
              label={t.name}
              selected={contributors.includes(t._id)}
              onPress={() => setContributors((c) => toggle(c, t._id))}
            />
          ))}
        </View>
      </View>
      <View className="flex-row gap-2">
        <View className="flex-1">
          <TextField label="Timing" value={timing} onChangeText={setTiming} placeholder="Q1 2027, Monthly…" />
        </View>
        <View className="flex-1">
          <TextField label="Due date" value={due} onChangeText={setDue} placeholder="YYYY-MM-DD" />
        </View>
      </View>
      <Select
        label="Objective"
        value={objectiveId}
        options={objectives.map((o) => ({ value: o._id, label: `${o.number}. ${o.title}` }))}
        onChange={setObjectiveId}
      />
      <Select
        label="Measured by"
        value={kind}
        options={KEY_RESULT_MEASURE_KINDS.map((k) => ({ value: k, label: KEY_RESULT_MEASURE_LABELS[k] }))}
        onChange={(k) => setKind(k as KeyResultMeasureKind)}
      />
      {kind === "seat_filled" ? (
        <View className="flex-row gap-2">
          <View className="flex-1">
            <Select
              label="Seat"
              value={seatSlug}
              options={options.seats.map((s) => ({ value: s.slug, label: s.title }))}
              onChange={setSeatSlug}
              searchable
            />
          </View>
          <View className="flex-1">
            <Select
              label="Where"
              value={seatScope}
              options={[
                { value: "central", label: "Central" },
                ...options.chapters.map((c) => ({ value: c._id, label: c.name })),
              ]}
              onChange={setSeatScope}
            />
          </View>
        </View>
      ) : null}
      {kind === "event_count" ? (
        <View className="gap-2">
          <Text className="text-sm font-medium text-ink">Count completed events from</Text>
          <View className="flex-row flex-wrap gap-2">
            {options.eventTypes.map((t) => (
              <Pill
                key={t._id}
                size="sm"
                label={`${t.name} · ${t.chapterName}`}
                selected={eventTypeIds.includes(t._id)}
                onPress={() => setEventTypeIds((ids) => toggle(ids, t._id))}
              />
            ))}
          </View>
          <Select
            label="Only in"
            value={eventChapterId}
            options={[{ value: "", label: "Every chapter" }, ...options.chapters.map((c) => ({ value: c._id, label: c.name }))]}
            onChange={setEventChapterId}
          />
        </View>
      ) : null}
      <View className="flex-row gap-2">
        <View className="flex-1">
          <TextField
            label={kind === "seat_filled" ? "People needed" : "Target"}
            value={target}
            onChangeText={setTarget}
            keyboardType="numeric"
            placeholder={kind === "seat_filled" ? "1" : "Optional"}
          />
        </View>
        {kind === "manual" ? (
          <View className="flex-1">
            <Select
              label="Unit"
              value={unit}
              options={[{ value: "", label: "Count" }, ...GOAL_UNITS.filter((u) => u !== "count").map((u) => ({ value: u, label: GOAL_UNIT_LABELS[u] }))]}
              onChange={(u) => setUnit(u as GoalUnit | "")}
            />
          </View>
        ) : null}
      </View>
      <View className="flex-row flex-wrap gap-2 pt-1">
        <Button title="Save changes" onPress={save} loading={saving} />
        <Button title="Up" variant="ghost" icon="arrow-up" onPress={() => moveKeyResult({ keyResultId: kr._id, direction: "up" }).catch(alertError)} />
        <Button title="Down" variant="ghost" icon="arrow-down" onPress={() => moveKeyResult({ keyResultId: kr._id, direction: "down" }).catch(alertError)} />
        <Button
          title="Delete"
          variant="danger"
          onPress={() =>
            confirmAction({
              title: `Delete key result ${kr.code}?`,
              message: "Its updates go with it. Linked projects stay, unlinked.",
              confirmLabel: "Delete",
              destructive: true,
              onConfirm: () =>
                deleteKeyResult({ keyResultId: kr._id })
                  .then(onDeleted)
                  .catch(alertError),
            })
          }
        />
      </View>
    </View>
  );
}
