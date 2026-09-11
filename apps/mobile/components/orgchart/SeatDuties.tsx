/**
 * The seat panel's DUTIES section — the real duties mapped to this seat in
 * Work → Duties, editable in place.
 *
 * Until now this was a read-only bullet list, and the org chart was where
 * people actually go to ask "what does this seat do?" — so the answer to
 * "that's wrong / that's missing" was "leave the chart, open Work → Duties,
 * find the row in a grid of every duty in the org, edit it there". This makes
 * the chart the place you FIX it too: rename a duty, change its cadence, add
 * one to the seat, or take one off the seat, without leaving the panel.
 *
 * WHAT IS EDITABLE IS EXACTLY WHAT THE SERVER WILL ACCEPT. Two independent
 * gates, both reported by the backend rather than guessed here:
 *  - `responsibilities.canManage` — may this caller shape the catalog at all
 *    (today: manager or admin, via `lib/dutiesAccess.ts`, the same resolver
 *    every duty mutation calls). Gates the "Add" affordance.
 *  - each row's own `canEdit` — the AND of that and AUTHORSHIP: a seat-mapped
 *    duty is an org-wide expectation visible from every chapter, but only its
 *    authoring chapter may write it (`requireOwned`, server-side). A foreign
 *    row renders read-only with a "Defined by {chapter}" note, exactly like
 *    `DutiesGrid` does — not decoration: an editable-looking foreign row would
 *    throw on every write.
 *
 * A DERIVED seat (today only Chapter Directors, whose holders are rolled up
 * from every chapter's real seat) can never carry a duty of its own — the
 * backend refuses to map one there, so that "one role, same expectations
 * everywhere" doesn't fork into two duty targets. It gets no editor at all,
 * and says where its duties actually live instead of an empty list that looks
 * like an oversight.
 *
 * Removing a duty DETACHES it from this seat (`removeSeat`) rather than
 * deleting the definition — the duty may well be mapped to other seats, and
 * deleting one from a seat panel is not what "remove from this seat" should
 * mean. The confirmation says so, and says where the definition still lives.
 */
import { useState } from "react";
import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  RESPONSIBILITY_CADENCES,
  RESPONSIBILITY_CADENCE_LABELS,
  type ResponsibilityCadence,
} from "@events-os/shared";
import { Button, Icon, Pill, SectionHeader } from "../ui";
import { colors } from "../../lib/theme";
import { alertError } from "../../lib/errors";
import { confirmAction } from "../../lib/confirmAction";

export type SeatDuty = FunctionReturnType<
  typeof api.responsibilities.dutiesForSeat
>[number];

export function SeatDuties({
  seatDefId,
  seatTitle,
  duties,
  derived = false,
}: {
  seatDefId: Id<"seatDefs">;
  seatTitle: string;
  /** `undefined` while `responsibilities.dutiesForSeat` is in flight. */
  duties: SeatDuty[] | undefined;
  /** A computed seat — holders rolled up, duties impossible. Read-only. */
  derived?: boolean;
}) {
  const mayManage = useQuery(api.responsibilities.canManage, {}) ?? false;
  const canManage = mayManage && !derived;
  const createDuty = useMutation(api.responsibilities.create);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);

  const addDuty = async (title: string, cadence: ResponsibilityCadence) => {
    setSaving(true);
    try {
      await createDuty({ title, cadence, assigneeSeatIds: [seatDefId] });
      setAdding(false);
    } catch (err) {
      alertError(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <SectionHeader
        title="Duties"
        right={
          canManage && !adding ? (
            <Button
              title="Add"
              variant="secondary"
              size="sm"
              icon="plus"
              onPress={() => setAdding(true)}
            />
          ) : undefined
        }
      />

      {duties === undefined ? (
        <View className="items-start py-2">
          <ActivityIndicator size="small" color={colors.accent} />
        </View>
      ) : duties.length === 0 && !adding ? (
        <Text className="text-sm text-muted">
          {derived
            ? "This seat mirrors each chapter — its duties live on the chapter seat it rolls up."
            : canManage
              ? `No duties yet — add what whoever holds ${seatTitle} is expected to do.`
              : "No duties mapped yet — attach them in Work → Duties."}
        </Text>
      ) : (
        <View className="gap-1.5">
          {duties.map((duty) => (
            <DutyRow key={duty.id} duty={duty} seatDefId={seatDefId} seatTitle={seatTitle} />
          ))}
        </View>
      )}

      {adding ? (
        <View className="mt-2">
          <DutyForm
            initialTitle=""
            initialCadence="ad_hoc"
            saving={saving}
            submitLabel="Add duty"
            onCancel={() => setAdding(false)}
            onSubmit={addDuty}
          />
        </View>
      ) : null}
    </>
  );
}

/** One duty: read-only by default, swapping in place for the same form the
 *  "Add" affordance uses once the row is tapped (editable rows only). */
function DutyRow({
  duty,
  seatDefId,
  seatTitle,
}: {
  duty: SeatDuty;
  seatDefId: Id<"seatDefs">;
  seatTitle: string;
}) {
  const updateDuty = useMutation(api.responsibilities.update);
  const detachSeat = useMutation(api.responsibilities.removeSeat);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  const save = async (title: string, cadence: ResponsibilityCadence) => {
    setSaving(true);
    try {
      await updateDuty({ responsibilityId: duty.id, title, cadence });
      setEditing(false);
    } catch (err) {
      alertError(err);
    } finally {
      setSaving(false);
    }
  };

  const detach = () => {
    confirmAction({
      title: `Take "${duty.title}" off ${seatTitle}?`,
      message:
        "It stops applying to whoever holds this seat. The duty itself stays in Work → Duties, where it can be mapped to another seat.",
      confirmLabel: "Remove from seat",
      destructive: true,
      onConfirm: () => {
        setSaving(true);
        detachSeat({ responsibilityId: duty.id, seatDefId })
          .catch(alertError)
          .finally(() => setSaving(false));
      },
    });
  };

  if (editing) {
    return (
      <DutyForm
        initialTitle={duty.title}
        initialCadence={duty.cadence}
        saving={saving}
        submitLabel="Save"
        onCancel={() => setEditing(false)}
        onSubmit={save}
      />
    );
  }

  return (
    <View className="flex-row items-start gap-2">
      {/* The whole row is the edit target for a writable duty — with a pencil
          on it, since a line of text that happens to be tappable is not an
          affordance anyone finds. A read-only row is a plain, inert row. */}
      <Pressable
        disabled={!duty.canEdit}
        onPress={() => setEditing(true)}
        accessibilityRole={duty.canEdit ? "button" : undefined}
        accessibilityLabel={duty.canEdit ? `Edit duty ${duty.title}` : undefined}
        style={duty.canEdit ? ({ cursor: "pointer" } as any) : undefined}
        className="flex-1 flex-row items-start gap-2"
      >
        <Text className="mt-0.5 text-sm text-muted">·</Text>
        <View className="flex-1">
          <Text className="text-sm text-ink">{duty.title}</Text>
          {duty.authoredByChapterName ? (
            <Text className="text-2xs italic text-faint">
              Defined by {duty.authoredByChapterName}
            </Text>
          ) : null}
        </View>
        <Text className="mt-0.5 text-xs text-muted">
          {RESPONSIBILITY_CADENCE_LABELS[duty.cadence]}
        </Text>
        {duty.canEdit ? (
          <View className="mt-0.5">
            <Icon name="edit-2" size={11} color={colors.faint} />
          </View>
        ) : null}
      </Pressable>
      {duty.canEdit ? (
        <View className="mt-0.5">
          {saving ? (
            <ActivityIndicator size="small" color={colors.accent} />
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Remove ${duty.title} from ${seatTitle}`}
              onPress={detach}
              hitSlop={8}
              style={{ cursor: "pointer" } as any}
            >
              <Icon name="x" size={14} color={colors.faint} />
            </Pressable>
          )}
        </View>
      ) : null}
    </View>
  );
}

/** Title + cadence, the two fields a duty needs to exist. Everything else a
 *  duty can carry (how-to doc, people assignees, notes) stays in the Duties
 *  grid — this is the seat's own view of the work, not the whole record. */
function DutyForm({
  initialTitle,
  initialCadence,
  saving,
  submitLabel,
  onCancel,
  onSubmit,
}: {
  initialTitle: string;
  initialCadence: ResponsibilityCadence;
  saving: boolean;
  submitLabel: string;
  onCancel: () => void;
  onSubmit: (title: string, cadence: ResponsibilityCadence) => void;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [cadence, setCadence] = useState<ResponsibilityCadence>(initialCadence);
  const trimmed = title.trim();

  return (
    <View className="gap-2 rounded-md border border-border bg-sunken p-2.5">
      <TextInput
        value={title}
        onChangeText={setTitle}
        autoFocus
        placeholder="What has to happen, and how often"
        placeholderTextColor={colors.faint}
        onSubmitEditing={() => {
          if (trimmed) onSubmit(trimmed, cadence);
        }}
        className="rounded-md border border-border-strong bg-raised px-2.5 py-2 text-sm text-ink"
      />
      <View className="flex-row flex-wrap gap-1.5">
        {RESPONSIBILITY_CADENCES.map((c) => (
          <Pill
            key={c}
            size="sm"
            label={RESPONSIBILITY_CADENCE_LABELS[c]}
            selected={cadence === c}
            onPress={() => setCadence(c)}
          />
        ))}
      </View>
      <View className="flex-row items-center gap-2">
        <Button
          title={submitLabel}
          size="sm"
          loading={saving}
          disabled={trimmed.length === 0}
          onPress={() => onSubmit(trimmed, cadence)}
        />
        <Button title="Cancel" variant="ghost" size="sm" onPress={onCancel} />
      </View>
    </View>
  );
}
