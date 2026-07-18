/**
 * MilestoneLadderModal — the dev-director-editable backer milestone ladder
 * (`docs/plans/giving-platform.md` §3): "at N backers, the chapter commits to
 * X." Reachable from the central finance desk (`CentralView`) for central
 * finance-manager rank; `saveMilestones` re-checks the gate server-side
 * regardless of whether the affordance is shown, mirroring
 * `BackerCountModal`.
 *
 * Replace-all save: this modal always sends the WHOLE edited list to
 * `saveMilestones` (never a per-row patch) — a ladder tops out at
 * `MAX_MILESTONES` rows and is edited as one ordered list, matching the
 * backend's replace-all mutation.
 */
import { useState } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { Button, Icon, TextField } from "../../ui";
import { colors } from "../../../lib/theme";
import { alertError } from "../../../lib/errors";

/** Mirrors `apps/convex/backerMilestones.ts#MAX_MILESTONES`. */
const MAX_MILESTONES = 10;

type DraftRow = {
  // A stable client-only key so React can track rows across add/remove
  // independent of their (mutable, re-orderable) minBackers value.
  key: string;
  minBackers: string;
  label: string;
  commitment: string;
  description: string;
};

let nextKey = 0;
function newRow(): DraftRow {
  nextKey += 1;
  return { key: `new-${nextKey}`, minBackers: "", label: "", commitment: "", description: "" };
}

export function MilestoneLadderModal({ onClose }: { onClose: () => void }) {
  const milestones = useQuery(api.backerMilestones.listMilestones, {});
  const saveMilestones = useMutation(api.backerMilestones.saveMilestones);
  const [rows, setRows] = useState<DraftRow[] | null>(null);
  const [saving, setSaving] = useState(false);

  // Seed the draft from the loaded query exactly once (not on every refetch —
  // that would clobber in-progress edits while the mutation's optimistic
  // update round-trips).
  if (rows === null && milestones !== undefined) {
    setRows(
      milestones.length > 0
        ? milestones.map((m) => ({
            key: m._id,
            minBackers: String(m.minBackers),
            label: m.label,
            commitment: m.commitment,
            description: m.description ?? "",
          }))
        : [newRow()],
    );
  }

  function updateRow(key: string, patch: Partial<DraftRow>) {
    setRows((prev) => (prev ? prev.map((r) => (r.key === key ? { ...r, ...patch } : r)) : prev));
  }

  function removeRow(key: string) {
    setRows((prev) => (prev ? prev.filter((r) => r.key !== key) : prev));
  }

  function addRow() {
    setRows((prev) => (prev ? [...prev, newRow()] : prev));
  }

  async function submit() {
    if (!rows) return;
    if (rows.length > MAX_MILESTONES) {
      alertError(new Error(`A ladder may have at most ${MAX_MILESTONES} rungs.`));
      return;
    }

    const parsed: Array<{
      minBackers: number;
      label: string;
      commitment: string;
      description?: string;
    }> = [];
    for (const row of rows) {
      const minBackers = parseInt(row.minBackers, 10);
      if (!Number.isInteger(minBackers) || minBackers <= 0 || String(minBackers) !== row.minBackers.trim()) {
        alertError(new Error("Each rung's backer threshold must be a positive whole number."));
        return;
      }
      if (row.label.trim().length === 0) {
        alertError(new Error("Every rung needs a label."));
        return;
      }
      if (row.commitment.trim().length === 0) {
        alertError(new Error("Every rung needs a commitment."));
        return;
      }
      parsed.push({
        minBackers,
        label: row.label.trim(),
        commitment: row.commitment.trim(),
        description: row.description.trim() || undefined,
      });
    }

    // Sort by threshold ascending before sending — the backend requires
    // strictly increasing order, and this lets rows be added out of order
    // in the editor without the save failing on ordering alone.
    parsed.sort((a, b) => a.minBackers - b.minBackers);
    for (let i = 1; i < parsed.length; i++) {
      if (parsed[i].minBackers === parsed[i - 1].minBackers) {
        alertError(new Error("Backer thresholds must be unique."));
        return;
      }
    }

    setSaving(true);
    try {
      await saveMilestones({ rows: parsed });
      onClose();
    } catch (err) {
      alertError(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        className="flex-1 items-center justify-center bg-ink/30 p-6"
      >
        <Pressable
          onPress={() => {}}
          className="w-full max-w-lg overflow-hidden rounded-xl border border-border bg-raised shadow-pop"
        >
          <View className="flex-row items-center justify-between border-b border-border px-5 py-4">
            <Text className="font-display text-lg text-ink">Milestone ladder</Text>
            <Pressable onPress={onClose} hitSlop={8} className="rounded-md p-1">
              <Icon name="x" size={18} color={colors.muted} />
            </Pressable>
          </View>

          <ScrollView className="max-h-[70vh] px-5 py-4">
            <Text className="mb-3 text-xs text-muted">
              At each backer threshold, the chapter commits to something new —
              shown on the affordability header and (soon) the public city
              page. Thresholds must be unique and will be saved in ascending
              order.
            </Text>

            {rows === null ? (
              <Text className="text-sm text-muted">Loading…</Text>
            ) : (
              rows.map((row, i) => (
                <View
                  key={row.key}
                  className="mb-3 rounded-lg border border-border bg-sunken p-3"
                >
                  <View className="mb-2 flex-row items-center justify-between">
                    <Text className="text-xs font-semibold uppercase tracking-wider text-muted">
                      Rung {i + 1}
                    </Text>
                    <Pressable onPress={() => removeRow(row.key)} hitSlop={8}>
                      <Icon name="trash-2" size={16} color={colors.danger} />
                    </Pressable>
                  </View>
                  <View className="flex-row gap-2">
                    <View className="w-28">
                      <TextField
                        label="Backers"
                        value={row.minBackers}
                        onChangeText={(v) => updateRow(row.key, { minBackers: v })}
                        keyboardType="number-pad"
                        placeholder="20"
                      />
                    </View>
                    <View className="flex-1">
                      <TextField
                        label="Label"
                        value={row.label}
                        onChangeText={(v) => updateRow(row.key, { label: v })}
                        placeholder="WWS"
                      />
                    </View>
                  </View>
                  <TextField
                    label="Commitment"
                    value={row.commitment}
                    onChangeText={(v) => updateRow(row.key, { commitment: v })}
                    placeholder="Worship With Strangers, monthly"
                  />
                  <TextField
                    label="Description (optional, public-facing)"
                    value={row.description}
                    onChangeText={(v) => updateRow(row.key, { description: v })}
                    placeholder="Shown on the city page"
                  />
                </View>
              ))
            )}

            {rows !== null && rows.length < MAX_MILESTONES ? (
              <Button title="Add rung" icon="plus" size="sm" variant="secondary" onPress={addRow} />
            ) : null}
          </ScrollView>

          <View className="flex-row justify-end gap-2 border-t border-border px-5 py-4">
            <Button title="Cancel" variant="secondary" onPress={onClose} />
            <Button title="Save" onPress={submit} loading={saving} disabled={rows === null} />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
