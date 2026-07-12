/**
 * CheckInModal — the 1:1 logging form, built for first-time managers.
 *
 * One pass through the conversation, in the order the conversation should
 * actually go: did the 1:1 happen (or was it skipped), how is the PERSON
 * doing first — personal/prayer updates and the two 1-10 pulses (workload
 * amount, right-work interest) — and only then the work: is each
 * responsibility being fulfilled (and if not, pick the course of action —
 * warning, reduce, transfer, take it on, reassign, remove), are projects on
 * track, and feedback. Saves one `checkIns` row; history renders on the
 * workload page.
 *
 * Duties respect their cadence: a quarterly duty reviewed three weeks ago
 * doesn't clutter a weekly 1:1 — it waits in a collapsed "not due yet" list
 * the manager can still pull from.
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
  RESPONSIBILITY_CADENCE_LABELS,
  type CheckInAction,
  type CheckInType,
  type ResponsibilityCadence,
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

type ProjectInput = {
  projectId?: Id<"projects">;
  name: string;
  onTrack: boolean;
  note?: string;
};

export type CheckInResponsibility = {
  _id: Id<"responsibilities">;
  title: string;
  cadence: ResponsibilityCadence;
  /** Cadence cycle elapsed since the last logged review (see shared helper). */
  dueForReview: boolean;
};

export function CheckInModal({
  visible,
  person,
  responsibilities,
  projects,
  onClose,
}: {
  visible: boolean;
  person: { _id: Id<"people">; name: string };
  /** The person's derived responsibilities (role fan-out + direct). */
  responsibilities: CheckInResponsibility[];
  /** The projects they own — checked in the same pass as the duties. */
  projects: { _id: Id<"projects">; name: string }[];
  onClose: () => void;
}) {
  // The caller mounts this fresh per open (conditional render keyed by the
  // person), so plain initializers ARE the reset — no re-seeding logic. Pass
  // key={person._id} at the call site if the instance is ever kept mounted.
  const log = useMutation(api.checkIns.log);
  const [type, setType] = useState<CheckInType>("checkin");
  // Only duties due this cadence cycle seed the form; the rest wait in a
  // collapsed list the manager can pull from ("we ended up discussing it").
  const [resp, setResp] = useState<RespInput[]>(() =>
    responsibilities
      .filter((r) => r.dueForReview)
      .map((r) => ({
        responsibilityId: r._id,
        title: r.title,
        fulfilling: true,
      })),
  );
  const [deferredOpen, setDeferredOpen] = useState(false);
  // Derived, not a second source of truth: a duty is deferred until it's in
  // `resp`. Pulling one in is a single append — the two lists can't diverge.
  const deferred = responsibilities.filter(
    (r) => !resp.some((x) => x.responsibilityId === r._id),
  );

  function pullDeferred(dutyId: Id<"responsibilities">) {
    const duty = responsibilities.find((d) => d._id === dutyId);
    if (!duty || resp.some((x) => x.responsibilityId === dutyId)) return;
    setResp((cur) => [
      ...cur,
      { responsibilityId: duty._id, title: duty.title, fulfilling: true },
    ]);
  }
  const [proj, setProj] = useState<ProjectInput[]>(() =>
    projects.map((p) => ({ projectId: p._id, name: p.name, onTrack: true })),
  );
  const [feedbackWell, setFeedbackWell] = useState("");
  const [feedbackImprove, setFeedbackImprove] = useState("");
  const [feedbackAboveBeyond, setFeedbackAboveBeyond] = useState("");
  const [personalUpdate, setPersonalUpdate] = useState("");
  const [workloadScore, setWorkloadScore] = useState<number | null>(null);
  const [workloadNote, setWorkloadNote] = useState("");
  const [interestScore, setInterestScore] = useState<number | null>(null);
  const [interestNote, setInterestNote] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  function patchResp(i: number, patch: Partial<RespInput>) {
    setResp((cur) => cur.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }

  function patchProj(i: number, patch: Partial<ProjectInput>) {
    setProj((cur) => cur.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  }

  async function save() {
    setSaving(true);
    try {
      await log({
        personId: person._id,
        type,
        // A skipped 1:1 assessed nothing — don't record attestations for it.
        responsibilities:
          type === "skip"
            ? undefined
            : resp.map((r) => ({
                responsibilityId: r.responsibilityId,
                title: r.title,
                fulfilling: r.fulfilling,
                action: r.fulfilling ? undefined : r.action,
                note: r.note?.trim() || undefined,
              })),
        // Same rule as duties: a skipped 1:1 assessed nothing.
        projects:
          type === "skip"
            ? undefined
            : proj.map((p) => ({
                projectId: p.projectId,
                name: p.name,
                onTrack: p.onTrack,
                note: p.note?.trim() || undefined,
              })),
        feedbackWell: feedbackWell.trim() || undefined,
        feedbackImprove: feedbackImprove.trim() || undefined,
        feedbackAboveBeyond: feedbackAboveBeyond.trim() || undefined,
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

            {/* How are THEY doing — before any of the work. */}
            <View style={{ gap: spacing.xs }}>
              <FieldLabel>
                How are they doing — prayer requests / personal updates
              </FieldLabel>
              <NoteInput
                placeholder="Start here: life, faith, anything the reporting chain should know & pray for…"
                value={personalUpdate}
                onChangeText={setPersonalUpdate}
                tall
              />
            </View>

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

            {/* Responsibilities check (a skipped 1:1 assesses nothing) */}
            {type === "skip" ? null : resp.length > 0 || deferred.length > 0 ? (
              <View style={{ gap: spacing.sm }}>
                <FieldLabel>Duties — on track?</FieldLabel>
                {resp.length === 0 ? (
                  <Text className="text-sm text-faint">
                    Nothing due this cycle — every duty was reviewed recently.
                  </Text>
                ) : null}
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
                        onChange={(fulfilling) =>
                          patchResp(i, {
                            fulfilling,
                            // Seed the displayed default so what the manager
                            // SEES selected is what actually gets saved.
                            action: fulfilling
                              ? undefined
                              : (r.action ?? "warning"),
                          })
                        }
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
                {deferred.length > 0 ? (
                  <View style={{ gap: spacing.xs }}>
                    <Pressable
                      onPress={() => setDeferredOpen((o) => !o)}
                      className="flex-row items-center gap-1 py-0.5 active:opacity-70"
                    >
                      <Icon
                        name={deferredOpen ? "chevron-down" : "chevron-right"}
                        size={14}
                        color={colors.faint}
                      />
                      <Text className="text-xs font-medium text-faint">
                        {deferred.length} not due this cycle — reviewed
                        recently
                      </Text>
                    </Pressable>
                    {deferredOpen
                      ? deferred.map((d) => (
                          <View
                            key={d._id}
                            className="flex-row items-center gap-2 rounded-lg border border-border bg-sunken px-3 py-2"
                          >
                            <Text
                              className="flex-1 text-sm text-muted"
                              numberOfLines={1}
                            >
                              {d.title}
                            </Text>
                            <Text className="text-2xs text-faint">
                              {RESPONSIBILITY_CADENCE_LABELS[d.cadence]}
                            </Text>
                            <Pressable
                              onPress={() => pullDeferred(d._id)}
                              hitSlop={4}
                              className="rounded-pill bg-raised px-2 py-0.5 active:opacity-70"
                            >
                              <Text className="text-xs font-semibold text-accent">
                                Review anyway
                              </Text>
                            </Pressable>
                          </View>
                        ))
                      : null}
                  </View>
                ) : null}
              </View>
            ) : (
              <Text className="text-sm text-faint">
                No duties assigned yet — add them in the
                Duties tab.
              </Text>
            )}

            {/* Projects check — same pass as the duties */}
            {type === "skip" ? null : proj.length > 0 ? (
              <View style={{ gap: spacing.sm }}>
                <FieldLabel>Projects — on track?</FieldLabel>
                {proj.map((p, i) => (
                  <View
                    key={`${p.projectId ?? p.name}-${i}`}
                    className="rounded-lg border border-border px-3 py-2"
                    style={{ gap: spacing.xs }}
                  >
                    <View className="flex-row items-center gap-2">
                      <Text className="flex-1 text-sm font-medium text-ink">
                        {p.name}
                      </Text>
                      <YesNo
                        value={p.onTrack}
                        onChange={(onTrack) => patchProj(i, { onTrack })}
                      />
                    </View>
                    {!p.onTrack ? (
                      <NoteInput
                        placeholder="What's off, and what was agreed…"
                        value={p.note ?? ""}
                        onChangeText={(note) => patchProj(i, { note })}
                      />
                    ) : null}
                  </View>
                ))}
              </View>
            ) : null}

            {/* Feedback — name it while it's fresh */}
            <View style={{ gap: spacing.xs }}>
              <FieldLabel>Feedback — doing well</FieldLabel>
              <NoteInput
                placeholder="Where they're strong right now…"
                value={feedbackWell}
                onChangeText={setFeedbackWell}
              />
              <FieldLabel>Feedback — can improve</FieldLabel>
              <NoteInput
                placeholder="Where to grow, and how…"
                value={feedbackImprove}
                onChangeText={setFeedbackImprove}
              />
              <FieldLabel>Feedback — above & beyond</FieldLabel>
              <NoteInput
                placeholder="Moments worth naming up the chain…"
                value={feedbackAboveBeyond}
                onChangeText={setFeedbackAboveBeyond}
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

          <View className="flex-row items-center justify-between gap-2 border-t border-border px-5 py-3">
            <Text className="flex-1 text-2xs text-faint">
              Visible to the managers above {person.name} — not to{" "}
              {person.name}.
            </Text>
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
