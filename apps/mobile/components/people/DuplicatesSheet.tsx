/**
 * DuplicatesSheet — the chapter-admin "Duplicates" review + merge flow for the
 * People roster (Attendance C). Opens from the People tab, lists suspect
 * duplicate groups (same email / phone / name), drills into a group for a
 * side-by-side field comparison, lets the admin pick the SURVIVOR, and — after
 * a confirm dialog spelling out what moves — merges every other record in the
 * group into it. Merging is irreversible and re-points every reference across
 * the app, so the survivor pick + confirm are deliberate, never one-tap.
 *
 * All the real work is server-side (`dataHygiene.mergePeople`, admin-gated); the
 * list refreshes automatically as each merge deletes a row.
 */
import { useState } from "react";
import { Modal, View, Text, Pressable, ScrollView } from "react-native";
import { useQuery, useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Icon, Badge, Button, EmptyState, type BadgeTone } from "../ui";
import { colors, spacing } from "../../lib/theme";
import { alertError } from "../../lib/errors";

type PersonCandidate = {
  _id: Id<"people">;
  name: string;
  email: string | null;
  phone: string | null;
  userId: Id<"users"> | null;
  isTeamMember: boolean;
  notes: string | null;
  status: string | null;
  role: string | null;
  company: string | null;
  createdAt: number;
};
type MatchKind = "email" | "phone" | "name";
type Group = { matchKind: MatchKind; people: PersonCandidate[] };

const MATCH_LABEL: Record<MatchKind, string> = {
  email: "Same email",
  phone: "Same phone",
  name: "Same name (lower confidence)",
};
const MATCH_TONE: Record<MatchKind, BadgeTone> = {
  email: "accent",
  phone: "accent",
  name: "warn",
};

export function DuplicatesSheet({
  chapterId,
  visible,
  onClose,
}: {
  chapterId: Id<"chapters">;
  visible: boolean;
  onClose: () => void;
}) {
  const data = useQuery(
    api.dataHygiene.listPeopleDuplicates,
    visible ? { chapterId } : "skip",
  );
  const merge = useMutation(api.dataHygiene.mergePeople);
  const [openGroup, setOpenGroup] = useState<number | null>(null);
  const [survivorId, setSurvivorId] = useState<Id<"people"> | null>(null);
  const [busy, setBusy] = useState(false);

  const groups: Group[] = (data?.groups as Group[] | undefined) ?? [];
  const group = openGroup !== null ? groups[openGroup] ?? null : null;

  function close() {
    setOpenGroup(null);
    setSurvivorId(null);
    onClose();
  }
  function backToList() {
    setOpenGroup(null);
    setSurvivorId(null);
  }

  async function doMerge() {
    if (!group || !survivorId) return;
    const survivor = group.people.find((p) => p._id === survivorId);
    if (!survivor) return;
    const dups = group.people.filter((p) => p._id !== survivorId);
    const ok =
      typeof window !== "undefined" && typeof window.confirm === "function"
        ? window.confirm(
            `Merge ${dups.length} record${dups.length === 1 ? "" : "s"} into ${survivor.name}?\n\n` +
              `Every event, role, card, giving link, duty and reference moves onto ${survivor.name}, ` +
              `and the other record${dups.length === 1 ? " is" : "s are"} deleted. This can't be undone.`,
          )
        : true;
    if (!ok) return;
    setBusy(true);
    try {
      for (const d of dups) {
        await merge({ chapterId, survivorId, duplicateId: d._id });
      }
      backToList();
    } catch (e) {
      alertError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={close}>
      <View className="flex-1 items-center justify-center bg-ink/30 p-4">
        <View className="w-full max-w-2xl overflow-hidden rounded-xl border border-border bg-raised shadow-pop">
          {/* Header */}
          <View className="flex-row items-center justify-between border-b border-border px-5 py-4">
            <View className="flex-row items-center gap-2">
              {group ? (
                <Pressable onPress={backToList} hitSlop={8} className="rounded-md p-1 active:bg-sunken">
                  <Icon name="chevron-left" size={18} color={colors.muted} />
                </Pressable>
              ) : null}
              <Text className="font-display text-lg text-ink">
                {group ? "Compare & merge" : "Duplicate people"}
              </Text>
            </View>
            <Pressable onPress={close} hitSlop={8} className="rounded-md p-1 active:bg-sunken">
              <Icon name="x" size={18} color={colors.muted} />
            </Pressable>
          </View>

          <ScrollView style={{ maxHeight: 520 }} contentContainerStyle={{ padding: spacing.lg }}>
            {data === undefined ? (
              <Text className="text-sm text-muted">Scanning the roster…</Text>
            ) : group ? (
              <GroupDetail
                group={group}
                survivorId={survivorId}
                onPickSurvivor={setSurvivorId}
              />
            ) : groups.length === 0 ? (
              <EmptyState
                icon="check-circle"
                title="No duplicates found"
                message="Every roster record looks distinct. Rows without an email or phone aren't matched."
              />
            ) : (
              <View className="gap-2">
                <Text className="mb-1 text-sm text-muted">
                  {groups.length} suspected duplicate group{groups.length === 1 ? "" : "s"}. Tap
                  one to compare and merge.
                </Text>
                {groups.map((g, i) => (
                  <Pressable
                    key={`${g.matchKind}-${i}`}
                    onPress={() => setOpenGroup(i)}
                    className="flex-row items-center justify-between rounded-lg border border-border bg-raised p-3 active:bg-sunken web:hover:bg-sunken"
                  >
                    <View className="flex-1 pr-3">
                      <Text className="text-base font-semibold text-ink" numberOfLines={1}>
                        {g.people.map((p) => p.name).join(" · ")}
                      </Text>
                      <View className="mt-1 flex-row items-center gap-2">
                        <Badge label={MATCH_LABEL[g.matchKind]} tone={MATCH_TONE[g.matchKind]} />
                        <Text className="text-xs text-muted">{g.people.length} records</Text>
                      </View>
                    </View>
                    <Icon name="chevron-right" size={16} color={colors.muted} />
                  </Pressable>
                ))}
              </View>
            )}
          </ScrollView>

          {/* Footer — only in group detail */}
          {group ? (
            <View className="flex-row items-center justify-between gap-3 border-t border-border px-5 py-3">
              <Text className="flex-1 text-xs text-muted">
                {survivorId
                  ? "The selected record is kept; the rest merge into it."
                  : "Pick which record to keep."}
              </Text>
              <Button
                title={busy ? "Merging…" : "Merge"}
                variant="danger"
                onPress={doMerge}
                disabled={!survivorId || busy}
                loading={busy}
              />
            </View>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

/** Side-by-side comparison of a group's candidates; tap a column to keep it. */
function GroupDetail({
  group,
  survivorId,
  onPickSurvivor,
}: {
  group: Group;
  survivorId: Id<"people"> | null;
  onPickSurvivor: (id: Id<"people">) => void;
}) {
  return (
    <View className="gap-3">
      <View className="flex-row items-center gap-2">
        <Badge label={MATCH_LABEL[group.matchKind]} tone={MATCH_TONE[group.matchKind]} />
        <Text className="text-sm text-muted">Keep one — the others merge into it.</Text>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: spacing.sm }}>
        {group.people.map((p) => {
          const selected = survivorId === p._id;
          return (
            <Pressable
              key={p._id}
              onPress={() => onPickSurvivor(p._id)}
              style={{ width: 240 }}
              className={`rounded-lg border p-3 ${
                selected ? "border-accent bg-brand-100" : "border-border bg-raised"
              }`}
            >
              <View className="mb-2 flex-row items-center justify-between">
                <Text className="flex-1 text-base font-semibold text-ink" numberOfLines={1}>
                  {p.name || "Untitled"}
                </Text>
                <Icon
                  name={selected ? "check-circle" : "circle"}
                  size={18}
                  color={selected ? colors.accent : colors.faint}
                />
              </View>
              {selected ? (
                <View className="mb-2 self-start">
                  <Badge label="Keep this one" tone="accent" />
                </View>
              ) : null}
              <Field label="Email" value={p.email} />
              <Field label="Phone" value={p.phone} />
              <Field label="Account" value={p.userId ? "Has sign-in" : "—"} />
              <Field label="Team" value={p.isTeamMember ? "Team member" : "—"} />
              <Field label="Status" value={p.status} />
              <Field label="Title" value={p.role} />
              <Field label="Company" value={p.company} />
              <Field label="Notes" value={p.notes} />
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <View className="border-t border-border/60 py-1">
      <Text className="text-2xs font-bold uppercase tracking-wider text-faint">{label}</Text>
      <Text className="text-sm text-ink" numberOfLines={2}>
        {value && value.trim() ? value : "—"}
      </Text>
    </View>
  );
}
