/**
 * DonorDuplicatesSheet — the Giving-desk "Duplicates" review + merge flow for
 * the donor CRM (Attendance C). Mirrors the People roster's `DuplicatesSheet`:
 * lists suspect duplicate donor groups (same email / phone / name) for the
 * caller's scope, drills into a group for a side-by-side comparison (lifetime,
 * gift count, status surfaced), lets a manage-level user pick the SURVIVOR, and
 * merges the rest into it after a confirm dialog.
 *
 * The server (`dataHygiene.mergeDonors`, `requireGivingManage`-gated) re-points
 * every gift / pledge / sponsorship, recomputes the survivor's rollups from its
 * actual gifts, and keeps the scope rollup exactly neutral (donor count −1).
 */
import { useState } from "react";
import { Modal, View, Text, Pressable, ScrollView } from "react-native";
import { useQuery, useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { formatCents } from "@events-os/shared";
import { Icon, Badge, Button, EmptyState, type BadgeTone } from "../ui";
import { colors, spacing } from "../../lib/theme";
import { alertError } from "../../lib/errors";

type GivingScope = "central" | Id<"chapters">;

/** Donor status → chip tone (mirrors the donors screen's own mapping): active
 *  reads calm, lapsed warns (reactivation queue), prospect is neutral. */
function donorStatusTone(status: string): BadgeTone {
  if (status === "active") return "success";
  if (status === "lapsed") return "warn";
  return "neutral";
}

type DonorCandidate = {
  _id: Id<"donors">;
  name: string;
  email: string | null;
  phone: string | null;
  status: string;
  lifetimeCents: number;
  giftCount: number;
  personId: Id<"people"> | null;
  ownerPersonId: Id<"people"> | null;
  userId: Id<"users"> | null;
  createdAt: number;
};
type MatchKind = "email" | "phone" | "name";
type Group = { matchKind: MatchKind; donors: DonorCandidate[] };

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

export function DonorDuplicatesSheet({
  scope,
  visible,
  onClose,
}: {
  scope: GivingScope;
  visible: boolean;
  onClose: () => void;
}) {
  const data = useQuery(
    api.dataHygiene.listDonorDuplicates,
    visible ? { scope } : "skip",
  );
  const merge = useMutation(api.dataHygiene.mergeDonors);
  const [openGroup, setOpenGroup] = useState<number | null>(null);
  const [survivorId, setSurvivorId] = useState<Id<"donors"> | null>(null);
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
    const survivor = group.donors.find((d) => d._id === survivorId);
    if (!survivor) return;
    const dups = group.donors.filter((d) => d._id !== survivorId);
    const ok =
      typeof window !== "undefined" && typeof window.confirm === "function"
        ? window.confirm(
            `Merge ${dups.length} donor${dups.length === 1 ? "" : "s"} into ${survivor.name}?\n\n` +
              `Every gift, pledge and sponsorship moves onto ${survivor.name}, its lifetime totals are ` +
              `recomputed, and the other record${dups.length === 1 ? " is" : "s are"} deleted. This can't be undone.`,
          )
        : true;
    if (!ok) return;
    setBusy(true);
    try {
      for (const d of dups) {
        await merge({ scope, survivorId, duplicateId: d._id });
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
          <View className="flex-row items-center justify-between border-b border-border px-5 py-4">
            <View className="flex-row items-center gap-2">
              {group ? (
                <Pressable onPress={backToList} hitSlop={8} className="rounded-md p-1 active:bg-sunken">
                  <Icon name="chevron-left" size={18} color={colors.muted} />
                </Pressable>
              ) : null}
              <Text className="font-display text-lg text-ink">
                {group ? "Compare & merge" : "Duplicate donors"}
              </Text>
            </View>
            <Pressable onPress={close} hitSlop={8} className="rounded-md p-1 active:bg-sunken">
              <Icon name="x" size={18} color={colors.muted} />
            </Pressable>
          </View>

          <ScrollView style={{ maxHeight: 520 }} contentContainerStyle={{ padding: spacing.lg }}>
            {data === undefined ? (
              <Text className="text-sm text-muted">Scanning donors…</Text>
            ) : group ? (
              <GroupDetail group={group} survivorId={survivorId} onPickSurvivor={setSurvivorId} />
            ) : groups.length === 0 ? (
              <EmptyState
                icon="check-circle"
                title="No duplicates found"
                message="Every donor in this scope looks distinct."
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
                        {g.donors.map((d) => d.name).join(" · ")}
                      </Text>
                      <View className="mt-1 flex-row items-center gap-2">
                        <Badge label={MATCH_LABEL[g.matchKind]} tone={MATCH_TONE[g.matchKind]} />
                        <Text className="text-xs text-muted">{g.donors.length} records</Text>
                      </View>
                    </View>
                    <Icon name="chevron-right" size={16} color={colors.muted} />
                  </Pressable>
                ))}
              </View>
            )}
          </ScrollView>

          {group ? (
            <View className="flex-row items-center justify-between gap-3 border-t border-border px-5 py-3">
              <Text className="flex-1 text-xs text-muted">
                {survivorId
                  ? "The selected donor is kept; gifts and pledges move onto it."
                  : "Pick which donor to keep."}
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

function GroupDetail({
  group,
  survivorId,
  onPickSurvivor,
}: {
  group: Group;
  survivorId: Id<"donors"> | null;
  onPickSurvivor: (id: Id<"donors">) => void;
}) {
  return (
    <View className="gap-3">
      <View className="flex-row items-center gap-2">
        <Badge label={MATCH_LABEL[group.matchKind]} tone={MATCH_TONE[group.matchKind]} />
        <Text className="text-sm text-muted">Keep one — the others merge into it.</Text>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: spacing.sm }}>
        {group.donors.map((d) => {
          const selected = survivorId === d._id;
          return (
            <Pressable
              key={d._id}
              onPress={() => onPickSurvivor(d._id)}
              style={{ width: 240 }}
              className={`rounded-lg border p-3 ${
                selected ? "border-accent bg-brand-100" : "border-border bg-raised"
              }`}
            >
              <View className="mb-2 flex-row items-center justify-between">
                <Text className="flex-1 text-base font-semibold text-ink" numberOfLines={1}>
                  {d.name || "Untitled"}
                </Text>
                <Icon
                  name={selected ? "check-circle" : "circle"}
                  size={18}
                  color={selected ? colors.accent : colors.faint}
                />
              </View>
              <View className="mb-2 flex-row items-center gap-2">
                {selected ? <Badge label="Keep this one" tone="accent" /> : null}
                <Badge label={d.status} tone={donorStatusTone(d.status)} />
              </View>
              <Field label="Lifetime" value={formatCents(d.lifetimeCents)} />
              <Field label="Gifts" value={String(d.giftCount)} />
              <Field label="Email" value={d.email} />
              <Field label="Phone" value={d.phone} />
              <Field label="Roster link" value={d.personId ? "Linked to a person" : "—"} />
              <Field label="Owner" value={d.ownerPersonId ? "Assigned" : "—"} />
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
