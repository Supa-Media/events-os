/**
 * CheckInModal — the 1:1 logging form, built for first-time managers.
 *
 * One pass through the conversation: did the 1:1 happen (or was it skipped),
 * is each responsibility being fulfilled (and if not, pick the course of
 * action — warning, reduce, transfer, take it on, reassign, remove), any
 * prayer requests / personal updates the chain should know, and two 1-10
 * pulses (workload amount, right-work interest) with notes. Saves one
 * `checkIns` row; history renders on the workload page.
 */
import { useState } from "react";
import {
  Modal,
  View,
  Text,
  Pressable,
  ScrollView,
  TextInput,
} from "react-native";
import { useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  CHECKIN_ACTIONS,
  CHECKIN_ACTION_LABELS,
  type CheckInAction,
  type CheckInType,
} from "@events-os/shared";
import { Button, Icon, SelectCell, type SelectOption } from "../ui";
import { colors, spacing } from "../../lib/theme";
import { alertError } from "../../lib/errors";

const ACTION_OPTIONS: SelectOption<CheckInAction>[] = CHECKIN_ACTIONS.map(
  (a) => ({
    value: a,
    label: CHECKIN_ACTION_LABELS[a],
    color: a === "remove_from_team" ? "red" : a === "warning" ? "amber" : "gray",
  }),
);

type RespInput = {
  responsibilityId?: Id<"responsibilities">;
  title: string;
  fulfilling: boolean;
  action?: CheckInAction;
  note?: string;
};

export function CheckInModal({
  visible,
  person,
  responsibilities,
  onClose,
}: {
  visible: boolean;
  person: { _id: Id<"people">; name: string };
  /** The person's derived responsibilities (role fan-out + direct). */
  responsibilities: { _id: Id<"responsibilities">; title: string }[];
  onClose: () => void;
}) {
  const log = useMutation(api.checkIns.log);
  const [type, setType] = useState<CheckInType>("checkin");
  const [resp, setResp] = useState<RespInput[]>(() =>
    responsibilities.map((r) => ({
      responsibilityId: r._id,
      title: r.title,
      fulfilling: true,
    })),
  );
  const [personalUpdate, setPersonalUpdate] = useState("");
  const [workloadScore, setWorkloadScore] = useState<number | null>(null);
  const [workloadNote, setWorkloadNote] = useState("");
  const [interestScore, setInterestScore] = useState<number | null>(null);
  const [interestNote, setInterestNote] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  // Re-seed the responsibility rows whenever the modal opens fresh.
  const [seededFor, setSeededFor] = useState<string | null>(null);
  if (visible && seededFor !== person._id) {
    setSeededFor(person._id);
    setResp(
      responsibilities.map((r) => ({
        responsibilityId: r._id,
        title: r.title,
        fulfilling: true,
      })),
    );
    setType("checkin");
    setPersonalUpdate("");
    setWorkloadScore(null);
    setWorkloadNote("");
    setInterestScore(null);
    setInterestNote("");
    setNotes("");
  }
  if (!visible && seededFor !== null) setSeededFor(null);

  function patchResp(i: number, patch: Partial<RespInput>) {
    setResp((cur) => cur.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }

  async function save() {
    setSaving(true);
    try {
      await log({
        personId: person._id,
        type,
        responsibilities: resp.map((r) => ({
          responsibilityId: r.responsibilityId,
          title: r.title,
          fulfilling: r.fulfilling,
          action: r.fulfilling ? undefined : r.action,
          note: r.note?.trim() || undefined,
        })),
        personalUpdate: personalUpdate.trim() || undefined,
        workloadScore: workloadScore ?? undefined,
        workloadNote: workloadNote.trim() || undefined,
        interestScore: interestScore ?? undefined,
        interestNote: interestNote.trim() || undefined,
        notes: notes.trim() || undefined,
      });
      onClose();
    } catch (err) {
      alertError(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        className="flex-1 items-center justify-center bg-ink/30 p-6"
      >
        <Pressable
          onPress={() => {}}
          className="max-h-full w-full max-w-xl overflow-hidden rounded-xl border border-border bg-raised shadow-pop"
        >
          <View className="flex-row items-center justify-between border-b border-border px-5 py-4">
            <Text className="font-display text-lg text-ink" numberOfLines={1}>
              1:1 with {person.name}
            </Text>
            <Pressable onPress={onClose} hitSlop={8} className="rounded-md p-1">
              <Icon name="x" size={18} color={colors.muted} />
            </Pressable>
          </View>

          <ScrollView
            style={{ maxHeight: 560 }}
            contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}
          >
            {/* Happened or skipped */}
            <View className="flex-row gap-2">
              {(
                [
                  { key: "checkin", label: "We met" },
                  { key: "skip", label: "Skipped this one" },
                ] as const
              ).map((t) => (
                <Pressable
                  key={t.key}
                  onPress={() => setType(t.key)}
                  className={`rounded-pill border px-3 py-1.5 ${
                    type === t.key
                      ? "border-accent bg-accent-soft"
                      : "border-border bg-raised"
                  }`}
                >
                  <Text
                    className={`text-sm font-semibold ${
                      type === t.key ? "text-accent" : "text-muted"
                    }`}
                  >
                    {t.label}
                  </Text>
                </Pressable>
              ))}
            </View>

            {/* Responsibilities check */}
            {resp.length > 0 ? (
              <View style={{ gap: spacing.sm }}>
                <FieldLabel>Responsibilities — on track?</FieldLabel>
                {resp.map((r, i) => (
                  <View
                    key={`${r.responsibilityId ?? r.title}-${i}`}
                    className="rounded-lg border border-border px-3 py-2"
                    style={{ gap: spacing.xs }}
                  >
                    <View className="flex-row items-center gap-2">
                      <Text className="flex-1 text-sm font-medium text-ink">
                        {r.title}
                      </Text>
                      <YesNo
                        value={r.fulfilling}
                        onChange={(fulfilling) => patchResp(i, { fulfilling })}
                      />
                    </View>
                    {!r.fulfilling ? (
                      <>
                        <View className="flex-row items-center gap-2">
                          <Text className="text-xs font-semibold text-muted">
                            Course of action
                          </Text>
                          <SelectCell
                            value={(r.action ?? "warning") as CheckInAction}
                            options={ACTION_OPTIONS}
                            onChange={(action) => patchResp(i, { action })}
                          />
                        </View>
                        <NoteInput
                          placeholder="What was agreed…"
                          value={r.note ?? ""}
                          onChangeText={(note) => patchResp(i, { note })}
                        />
                      </>
                    ) : null}
                  </View>
                ))}
              </View>
            ) : (
              <Text className="text-sm text-faint">
                No responsibilities assigned yet — add them in the
                Responsibilities tab.
              </Text>
            )}

            {/* Pulse: workload */}
            <View style={{ gap: spacing.xs }}>
              <FieldLabel>Workload — 1 far too little · 10 far too much</FieldLabel>
              <ScaleRow value={workloadScore} onChange={setWorkloadScore} />
              <NoteInput
                placeholder="Workload notes…"
                value={workloadNote}
                onChangeText={setWorkloadNote}
              />
            </View>

            {/* Pulse: right work */}
            <View style={{ gap: spacing.xs }}>
              <FieldLabel>
                Right work — 1 wrong/boring · 10 exactly right & interesting
              </FieldLabel>
              <ScaleRow value={interestScore} onChange={setInterestScore} />
              <NoteInput
                placeholder="Notes on the work itself…"
                value={interestNote}
                onChangeText={setInterestNote}
              />
            </View>

            {/* Prayer / personal */}
            <View style={{ gap: spacing.xs }}>
              <FieldLabel>Prayer requests / personal updates</FieldLabel>
              <NoteInput
                placeholder="Anything the reporting chain should know & pray for…"
                value={personalUpdate}
                onChangeText={setPersonalUpdate}
                tall
              />
            </View>

            {/* Anything else */}
            <View style={{ gap: spacing.xs }}>
              <FieldLabel>Other notes</FieldLabel>
              <NoteInput
                placeholder="Anything else from the 1:1…"
                value={notes}
                onChangeText={setNotes}
              />
            </View>
          </ScrollView>

          <View className="flex-row justify-end gap-2 border-t border-border px-5 py-3">
            <Button title="Cancel" variant="ghost" size="sm" onPress={onClose} />
            <Button
              title={type === "skip" ? "Log skip" : "Log check-in"}
              size="sm"
              loading={saving}
              onPress={save}
            />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
      {children}
    </Text>
  );
}

function YesNo({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <View className="flex-row gap-1">
      <Pressable
        onPress={() => onChange(true)}
        hitSlop={4}
        className={`rounded-pill px-2.5 py-1 ${
          value ? "bg-success-bg" : "bg-sunken"
        }`}
      >
        <Text
          className={`text-xs font-semibold ${
            value ? "text-success" : "text-faint"
          }`}
        >
          Yes
        </Text>
      </Pressable>
      <Pressable
        onPress={() => onChange(false)}
        hitSlop={4}
        className={`rounded-pill px-2.5 py-1 ${
          !value ? "bg-danger-bg" : "bg-sunken"
        }`}
      >
        <Text
          className={`text-xs font-semibold ${
            !value ? "text-danger" : "text-faint"
          }`}
        >
          No
        </Text>
      </Pressable>
    </View>
  );
}

/** Ten tap-targets, 1-10. Tap the current value again to clear. */
function ScaleRow({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
}) {
  return (
    <View className="flex-row flex-wrap gap-1">
      {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => {
        const selected = value === n;
        return (
          <Pressable
            key={n}
            onPress={() => onChange(selected ? null : n)}
            className={`h-8 w-8 items-center justify-center rounded-md border ${
              selected
                ? "border-accent bg-accent"
                : "border-border bg-raised web:hover:bg-sunken"
            }`}
          >
            <Text
              className={`text-sm font-semibold ${
                selected ? "text-white" : "text-muted"
              }`}
            >
              {n}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function NoteInput({
  value,
  onChangeText,
  placeholder,
  tall,
}: {
  value: string;
  onChangeText: (t: string) => void;
  placeholder: string;
  tall?: boolean;
}) {
  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={colors.faint}
      multiline
      className="rounded-md border border-border bg-raised px-3 py-2 text-sm text-ink"
      style={{ minHeight: tall ? 64 : 40, textAlignVertical: "top" }}
    />
  );
}
