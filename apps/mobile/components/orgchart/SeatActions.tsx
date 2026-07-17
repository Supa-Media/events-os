/**
 * Seat panel actions — the two ways a seat's OCCUPANCY can change from the
 * chart: a two-party PROPOSAL (any seat holder may propose a change to a
 * seat strictly below one of their own — `seatProposals.propose`), and, for
 * a superuser only, a DIRECT assignment that skips the proposal flow
 * entirely (`seats.assignSeat`).
 *
 * Both surfaces surface `ConvexError` messages VERBATIM (`alertError`) —
 * they're written in plain language for the person seeing them (SoD
 * violations, seat-full, not-a-holder, etc.), so there's no local
 * re-wording to keep in sync with the backend's copy.
 *
 * KNOWN GAP (reported, not hacked around): "Assign directly" only ever
 * calls `assignSeat` — it has no standalone "unassign a specific holder
 * without replacing them" action for a MULTI-holder seat. `unassignSeat`
 * takes an `assignmentId`, and neither `seats.chart` nor `seats.seatDetail`
 * expose one for an arbitrary holder (only `mySeatAssignments` — the
 * CALLER's own rows — does). A single-holder seat doesn't need this (picking
 * a new person REPLACES the incumbent inside `assignSeatImpl` itself, no
 * `assignmentId` required), but removing one holder from a "*" seat without
 * replacing them currently has no direct-assign path — only the two-party
 * proposal flow (propose a "vacate" for that holder) can do it. Flagged for
 * a follow-up: expose `assignmentId` on `seatDetail`'s holder rows.
 *
 * SECOND KNOWN GAP: the person picker here is `people.list`, per this PR's
 * spec — but that query is scoped to the CALLER's own chapter
 * (`lib/context.ts#getChapterIdOrNull`), not the seat's `scope`. Proposing
 * or directly assigning into a chapter other than the caller's home chapter
 * (or into central) offers the caller's OWN roster, not the target scope's.
 * A cross-chapter-aware roster read is a backend change outside this PR.
 *
 * CHAIN-TOP AUTO-EXECUTION: when the proposer has no OCCUPIED seat above
 * them in the tree (e.g. the ED — nobody outranks them), `propose` may
 * execute the change immediately instead of leaving it pending (a parallel
 * backend PR). Rather than assume "pending" from the mutation's own return
 * value (whose exact shape either side of that change isn't this PR's to
 * pin down), `submit()` re-reads the CREATED proposal's row via
 * `myProposals` right after the write and branches on its `status` — which
 * has been a stable field on every proposal row since the original merge,
 * true whether or not chain-top auto-execution has landed yet.
 */
import { useEffect, useMemo, useState } from "react";
import { Alert, Modal, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useConvex, useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Avatar, Button, Icon, PersonPicker } from "../ui";
import { colors } from "../../lib/theme";
import { alertError } from "../../lib/errors";
import { confirmAction } from "../event/ticketing/helpers";
import type { NodeScope } from "./treeUtils";

type HolderLite = { personId: Id<"people">; name: string; imageUrl: string | null };

/** Cross-platform info alert — mirrors `alertError`'s Platform branch, for
 *  a SUCCESS message rather than a failure (no shared success-toast
 *  primitive exists in the `ui` kit today — see `Toast.tsx`'s doc comment,
 *  which is failure-only). */
function alertInfo(title: string, message: string): void {
  if (Platform.OS === "web") {
    if (typeof window !== "undefined") window.alert(`${title}\n\n${message}`);
    return;
  }
  Alert.alert(title, message);
}

// ── Propose a change ────────────────────────────────────────────────────────

function ProposeChangeModal({
  visible,
  seatDefId,
  scope,
  seatTitle,
  holders,
  onClose,
}: {
  visible: boolean;
  seatDefId: Id<"seatDefs">;
  scope: NodeScope;
  seatTitle: string;
  holders: HolderLite[];
  onClose: () => void;
}) {
  const propose = useMutation(api.seatProposals.propose);
  const convex = useConvex();
  // NOTE (reported gap, not hacked around): `people.list` is scoped to the
  // CALLER's own chapter (`lib/context.ts#getChapterIdOrNull`), not the
  // seat's `scope` — so proposing into a DIFFERENT chapter (or central) than
  // the caller's home chapter offers the wrong roster here. This is the
  // exact query the task spec names ("person picker (people.list,
  // non-placeholder)"); a cross-chapter-aware roster read would need a
  // backend change out of this PR's scope.
  const people = useQuery(api.people.list, {});
  const [action, setAction] = useState<"fill" | "vacate">("fill");
  const [subjectPersonId, setSubjectPersonId] = useState<Id<"people"> | null>(null);
  const [note, setNote] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (visible) {
      setAction("fill");
      setSubjectPersonId(null);
      setNote("");
    }
  }, [visible]);

  async function submit() {
    if (!subjectPersonId) return;
    setSubmitting(true);
    try {
      const proposalId = await propose({
        seatDefId,
        scope,
        action,
        subjectPersonId,
        note: note.trim() || undefined,
      });

      // See this file's header doc comment ("CHAIN-TOP AUTO-EXECUTION") —
      // re-read the row we just created rather than assume "pending".
      const mine = await convex.query(api.seatProposals.myProposals, {});
      const created = mine.find((p) => p.proposalId === proposalId);
      if (created?.status === "approved") {
        alertInfo(
          "Done",
          `${created.seatTitle} was updated immediately — there was no one above you to approve it.`,
        );
      } else {
        alertInfo("Sent", "Your proposal is awaiting approval.");
      }
      onClose();
    } catch (err) {
      alertError(err);
    } finally {
      setSubmitting(false);
    }
  }

  const chosenFillName = useMemo(
    () => (people ?? []).find((p) => p._id === subjectPersonId)?.name,
    [people, subjectPersonId],
  );

  return (
    <>
      <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
        <Pressable onPress={onClose} className="flex-1 items-center justify-center bg-ink/30 p-6">
          <Pressable
            onPress={() => {}}
            className="w-full max-w-md overflow-hidden rounded-xl border border-border bg-raised shadow-pop"
          >
            <View className="flex-row items-center justify-between border-b border-border px-5 py-4">
              <Text className="flex-1 font-display text-lg text-ink" numberOfLines={1}>
                Propose a change — {seatTitle}
              </Text>
              <Pressable onPress={onClose} hitSlop={8} className="rounded-md p-1">
                <Icon name="x" size={18} color={colors.muted} />
              </Pressable>
            </View>

            <ScrollView className="max-h-[28rem]">
              <View className="gap-4 px-5 py-4">
                <View className="flex-row gap-2">
                  <ActionTab
                    label="Fill"
                    selected={action === "fill"}
                    onPress={() => {
                      setAction("fill");
                      setSubjectPersonId(null);
                    }}
                  />
                  <ActionTab
                    label="Vacate"
                    selected={action === "vacate"}
                    disabled={holders.length === 0}
                    onPress={() => {
                      setAction("vacate");
                      setSubjectPersonId(null);
                    }}
                  />
                </View>

                {action === "fill" ? (
                  <Button
                    title={chosenFillName ?? "Choose a person…"}
                    variant="secondary"
                    icon="user"
                    onPress={() => setPickerOpen(true)}
                  />
                ) : (
                  <View className="gap-2">
                    <Text className="text-sm text-muted">
                      Who should be proposed to vacate this seat?
                    </Text>
                    {holders.map((h) => (
                      <Pressable
                        key={h.personId}
                        onPress={() => setSubjectPersonId(h.personId)}
                        className={`flex-row items-center justify-between rounded-md border px-3 py-2.5 ${
                          subjectPersonId === h.personId
                            ? "border-accent bg-accent-soft"
                            : "border-border bg-raised"
                        }`}
                      >
                        <View className="flex-row items-center gap-2.5">
                          <Avatar name={h.name} uri={h.imageUrl} size={26} />
                          <Text className="text-sm text-ink">{h.name}</Text>
                        </View>
                        {subjectPersonId === h.personId ? (
                          <Icon name="check" size={16} color={colors.accent} />
                        ) : null}
                      </Pressable>
                    ))}
                  </View>
                )}

                <View>
                  <Text className="mb-1.5 text-sm font-semibold text-ink">
                    Note (optional)
                  </Text>
                  <TextInput
                    value={note}
                    onChangeText={setNote}
                    placeholder="Why you're proposing this…"
                    placeholderTextColor={colors.faint}
                    multiline
                    numberOfLines={3}
                    className="min-h-[76px] rounded-md border border-border-strong bg-raised px-3 py-2.5 text-base text-ink"
                  />
                </View>
              </View>
            </ScrollView>

            <View className="flex-row justify-end gap-2 border-t border-border px-5 py-4">
              <Button title="Cancel" variant="ghost" onPress={onClose} />
              <Button
                title={action === "fill" ? "Propose fill" : "Propose vacate"}
                onPress={() => void submit()}
                disabled={!subjectPersonId}
                loading={submitting}
              />
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      <PersonPicker
        visible={pickerOpen}
        title="Propose filling with…"
        selectedId={subjectPersonId}
        onPick={(personId) => {
          setSubjectPersonId(personId as Id<"people">);
          setPickerOpen(false);
        }}
        onClose={() => setPickerOpen(false)}
      />
    </>
  );
}

function ActionTab({
  label,
  selected,
  disabled,
  onPress,
}: {
  label: string;
  selected: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      className={`rounded-pill border px-3 py-1.5 ${
        selected ? "border-accent bg-accent-soft" : "border-border bg-raised"
      } ${disabled ? "opacity-40" : ""}`}
    >
      <Text
        className={`text-sm font-semibold ${selected ? "text-accent" : "text-muted"}`}
      >
        {label}
      </Text>
    </Pressable>
  );
}

// ── Assign directly (superuser) ─────────────────────────────────────────────

function DirectAssignModal({
  visible,
  seatDefId,
  scope,
  seatTitle,
  maxHolders,
  holders,
  onClose,
}: {
  visible: boolean;
  seatDefId: Id<"seatDefs">;
  scope: NodeScope;
  seatTitle: string;
  maxHolders: number;
  holders: HolderLite[];
  onClose: () => void;
}) {
  const assignSeat = useMutation(api.seats.assignSeat);
  // Same cross-chapter caveat as `ProposeChangeModal` — see this file's
  // header doc comment.
  const people = useQuery(api.people.list, {});
  const [pickerOpen, setPickerOpen] = useState(false);
  const singleHolderReplace = maxHolders === 1 && holders.length > 0;
  const atCapacity = maxHolders > 1 && holders.length >= maxHolders;

  function pick(personId: string) {
    const personName = (people ?? []).find((p) => p._id === personId)?.name ?? "This person";
    setPickerOpen(false);
    const commit = async () => {
      try {
        await assignSeat({ seatDefId, scope, personId: personId as Id<"people"> });
        onClose();
      } catch (err) {
        alertError(err);
      }
    };
    confirmAction({
      title: singleHolderReplace ? "Replace the current holder?" : "Assign directly?",
      message: singleHolderReplace
        ? `${personName} will replace ${holders[0]!.name} in ${seatTitle}. This skips the proposal flow and takes effect immediately.`
        : `${personName} will be assigned to ${seatTitle} immediately — this skips the proposal flow.`,
      confirmLabel: "Assign",
      destructive: singleHolderReplace,
      onConfirm: () => void commit(),
    });
  }

  return (
    <>
      <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
        <Pressable onPress={onClose} className="flex-1 items-center justify-center bg-ink/30 p-6">
          <Pressable
            onPress={() => {}}
            className="w-full max-w-md overflow-hidden rounded-xl border border-border bg-raised shadow-pop"
          >
            <View className="flex-row items-center justify-between border-b border-border px-5 py-4">
              <Text className="flex-1 font-display text-lg text-ink" numberOfLines={1}>
                Assign directly — {seatTitle}
              </Text>
              <Pressable onPress={onClose} hitSlop={8} className="rounded-md p-1">
                <Icon name="x" size={18} color={colors.muted} />
              </Pressable>
            </View>

            <View className="gap-3 px-5 py-4">
              <Text className="text-sm text-muted">
                Skips the two-party proposal flow — the change is immediate.
              </Text>

              {holders.length > 0 ? (
                <View className="gap-2">
                  <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
                    Currently holds this seat
                  </Text>
                  {holders.map((h) => (
                    <View key={h.personId} className="flex-row items-center gap-2.5">
                      <Avatar name={h.name} uri={h.imageUrl} size={26} />
                      <Text className="text-sm text-ink">{h.name}</Text>
                    </View>
                  ))}
                </View>
              ) : null}

              {atCapacity ? (
                <Text className="text-sm italic text-faint">
                  This seat is at its maximum of {maxHolders} holders.
                </Text>
              ) : (
                <Button
                  title={singleHolderReplace ? "Choose a replacement…" : "Choose a person…"}
                  variant="secondary"
                  icon="user-plus"
                  onPress={() => setPickerOpen(true)}
                />
              )}

              {maxHolders > 1 && holders.length > 0 ? (
                <Text className="text-xs text-faint">
                  To remove one holder from this seat without replacing them, use
                  &quot;Propose a change&quot; (vacate) instead — a standalone unassign for a
                  multi-holder seat isn&apos;t available here yet.
                </Text>
              ) : null}
            </View>

            <View className="flex-row justify-end gap-2 border-t border-border px-5 py-4">
              <Button title="Close" variant="ghost" onPress={onClose} />
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      <PersonPicker
        visible={pickerOpen}
        title="Assign to…"
        onPick={(personId) => pick(personId)}
        onClose={() => setPickerOpen(false)}
      />
    </>
  );
}

// ── Panel entry point ───────────────────────────────────────────────────────

/** The action buttons shown on a non-derived seat's detail panel. */
export function SeatActionsPanel({
  seatDefId,
  scope,
  seatTitle,
  maxHolders,
  holders,
  isSuperuser,
}: {
  seatDefId: Id<"seatDefs">;
  scope: NodeScope;
  seatTitle: string;
  maxHolders: number;
  holders: HolderLite[];
  isSuperuser: boolean;
}) {
  const [proposeOpen, setProposeOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);

  return (
    <View className="mt-1 flex-row flex-wrap gap-2">
      <Button
        title="Propose a change"
        variant="secondary"
        size="sm"
        icon="git-pull-request"
        onPress={() => setProposeOpen(true)}
      />
      {isSuperuser ? (
        <Button
          title="Assign directly"
          variant="secondary"
          size="sm"
          icon="zap"
          onPress={() => setAssignOpen(true)}
        />
      ) : null}

      <ProposeChangeModal
        visible={proposeOpen}
        seatDefId={seatDefId}
        scope={scope}
        seatTitle={seatTitle}
        holders={holders}
        onClose={() => setProposeOpen(false)}
      />
      {isSuperuser ? (
        <DirectAssignModal
          visible={assignOpen}
          seatDefId={seatDefId}
          scope={scope}
          seatTitle={seatTitle}
          maxHolders={maxHolders}
          holders={holders}
          onClose={() => setAssignOpen(false)}
        />
      ) : null}
    </View>
  );
}
