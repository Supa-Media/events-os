/**
 * Service Catalog management screen — rename / deactivate / restore / merge,
 * reached via `ServiceOptionsPicker`'s "Manage services…" link. Anyone can
 * manage the catalog today (`lib/servicesAccess.ts`'s "gate it behind a
 * power, even when it's open today" doc); the backend still enforces its own
 * gate on every mutation here regardless of what this screen shows.
 *
 * A rename PATCHES the row in place — every `people.serviceIds` reference and
 * every saved `has_service` audience condition holds this row's id, never its
 * name, so the new name is instantly visible everywhere that id is used. The
 * header copy says so up front because that blast radius isn't obvious from
 * a screen that looks like a simple rename field.
 *
 * Merge is the one truly destructive action (folds one option into another
 * and soft-deletes the loser) — it's a two-step confirm: pick a target, see
 * exactly how many people move, THEN confirm.
 */
import { useMemo, useState } from "react";
import { Modal, View, Text, Pressable, ScrollView, TextInput } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Icon } from "./Icon";
import { Badge } from "./Badge";
import { Button } from "./Button";
import { colors } from "../../lib/theme";
import { errorMessage } from "../../lib/errors";
import { flattenServiceCatalog, type FlatServiceOption } from "../../lib/serviceCatalog";

export function ServiceCatalogManageModal({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const tree = useQuery(api.serviceOptions.list, visible ? { includeInactive: true } : "skip");
  const rows = useMemo(() => (tree ? flattenServiceCatalog(tree) : []), [tree]);

  const renameOption = useMutation(api.serviceOptions.rename);
  const setActiveOption = useMutation(api.serviceOptions.setActive);
  const mergeOptions = useMutation(api.serviceOptions.merge);

  const [editingId, setEditingId] = useState<Id<"serviceOptions"> | null>(null);
  const [draftName, setDraftName] = useState("");
  const [mergingId, setMergingId] = useState<Id<"serviceOptions"> | null>(null);
  const [mergeTargetId, setMergeTargetId] = useState<Id<"serviceOptions"> | "">("");
  const [busyId, setBusyId] = useState<Id<"serviceOptions"> | null>(null);
  const [rowError, setRowError] = useState<{ id: Id<"serviceOptions">; message: string } | null>(
    null,
  );

  function resetTransientState() {
    setEditingId(null);
    setMergingId(null);
    setMergeTargetId("");
    setRowError(null);
  }

  function handleClose() {
    resetTransientState();
    onClose();
  }

  function startRename(row: FlatServiceOption) {
    setRowError(null);
    setMergingId(null);
    setEditingId(row._id);
    setDraftName(row.name);
  }

  async function commitRename(row: FlatServiceOption) {
    const name = draftName.trim();
    if (!name || name === row.name) {
      setEditingId(null);
      return;
    }
    setBusyId(row._id);
    setRowError(null);
    try {
      await renameOption({ serviceOptionId: row._id, name });
      setEditingId(null);
    } catch (err) {
      setRowError({ id: row._id, message: errorMessage(err, "Couldn't rename that option.") });
    } finally {
      setBusyId(null);
    }
  }

  async function toggleActive(row: FlatServiceOption) {
    setBusyId(row._id);
    setRowError(null);
    try {
      await setActiveOption({ serviceOptionId: row._id, isActive: !row.isActive });
    } catch (err) {
      setRowError({ id: row._id, message: errorMessage(err, "Couldn't update that option.") });
    } finally {
      setBusyId(null);
    }
  }

  function startMerge(row: FlatServiceOption) {
    setRowError(null);
    setEditingId(null);
    setMergingId(row._id);
    setMergeTargetId("");
  }

  async function confirmMerge(row: FlatServiceOption) {
    if (!mergeTargetId) return;
    setBusyId(row._id);
    setRowError(null);
    try {
      await mergeOptions({ fromId: row._id, toId: mergeTargetId });
      setMergingId(null);
      setMergeTargetId("");
    } catch (err) {
      setRowError({ id: row._id, message: errorMessage(err, "Couldn't merge those options.") });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={handleClose}>
      <Pressable onPress={handleClose} className="flex-1 items-center justify-center bg-ink/30 p-6">
        <Pressable
          onPress={() => {}}
          className="w-full max-w-lg overflow-hidden rounded-xl border border-border bg-raised shadow-pop"
        >
          <View className="border-b border-border px-5 py-4">
            <View className="flex-row items-center justify-between">
              <Text className="font-display text-lg text-ink">Manage services</Text>
              <Pressable onPress={handleClose} hitSlop={8} className="rounded-md p-1">
                <Icon name="x" size={18} color={colors.muted} />
              </Pressable>
            </View>
            <Text className="mt-1 text-xs text-muted">
              Renaming updates every person and saved audience that uses this option —
              instantly, everywhere — since they store its id, not its name.
            </Text>
          </View>

          <ScrollView className="max-h-96">
            {tree === undefined ? (
              <Text className="px-5 py-6 text-center text-base text-muted">Loading…</Text>
            ) : rows.length === 0 ? (
              <Text className="px-5 py-6 text-center text-base text-muted">No services yet.</Text>
            ) : (
              rows.map((row) => (
                <ManageRow
                  key={row._id}
                  row={row}
                  // Merge targets: any OTHER active option at the same scope
                  // (org-wide vs. this chapter) — the backend rejects a
                  // cross-scope merge outright, so don't even offer one.
                  otherOptions={rows.filter(
                    (r) => r._id !== row._id && r.isActive && r.isCentral === row.isCentral,
                  )}
                  editing={editingId === row._id}
                  draftName={draftName}
                  onDraftNameChange={setDraftName}
                  onStartRename={() => startRename(row)}
                  onCancelRename={() => setEditingId(null)}
                  onCommitRename={() => void commitRename(row)}
                  onToggleActive={() => void toggleActive(row)}
                  merging={mergingId === row._id}
                  mergeTargetId={mergeTargetId}
                  onStartMerge={() => startMerge(row)}
                  onCancelMerge={() => {
                    setMergingId(null);
                    setMergeTargetId("");
                  }}
                  onMergeTargetChange={setMergeTargetId}
                  onConfirmMerge={() => void confirmMerge(row)}
                  busy={busyId === row._id}
                  error={rowError?.id === row._id ? rowError.message : null}
                />
              ))
            )}
          </ScrollView>

          <View className="border-t border-border px-5 py-3">
            <Button title="Done" variant="secondary" onPress={handleClose} className="self-end" />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function ManageRow({
  row,
  otherOptions,
  editing,
  draftName,
  onDraftNameChange,
  onStartRename,
  onCancelRename,
  onCommitRename,
  onToggleActive,
  merging,
  mergeTargetId,
  onStartMerge,
  onCancelMerge,
  onMergeTargetChange,
  onConfirmMerge,
  busy,
  error,
}: {
  row: FlatServiceOption;
  otherOptions: FlatServiceOption[];
  editing: boolean;
  draftName: string;
  onDraftNameChange: (v: string) => void;
  onStartRename: () => void;
  onCancelRename: () => void;
  onCommitRename: () => void;
  onToggleActive: () => void;
  merging: boolean;
  mergeTargetId: Id<"serviceOptions"> | "";
  onStartMerge: () => void;
  onCancelMerge: () => void;
  onMergeTargetChange: (id: Id<"serviceOptions"> | "") => void;
  onConfirmMerge: () => void;
  busy: boolean;
  error: string | null;
}) {
  const target = otherOptions.find((o) => o._id === mergeTargetId);
  return (
    <View className={`border-b border-border px-5 py-3 ${row.parentId ? "pl-9" : ""}`}>
      <View className="flex-row items-center gap-2">
        {editing ? (
          <TextInput
            value={draftName}
            onChangeText={onDraftNameChange}
            autoFocus
            className="flex-1 rounded-md border border-accent bg-raised px-2 py-1 text-sm text-ink"
          />
        ) : (
          <Text
            className={`flex-1 text-sm ${row.isActive ? "text-ink" : "text-faint line-through"}`}
            numberOfLines={1}
          >
            {row.label}
          </Text>
        )}
        <Badge label={row.isCentral ? "Org-wide" : "This chapter"} tone="neutral" />
        {!row.isActive ? <Badge label="Inactive" tone="warn" /> : null}
        <Text className="text-xs text-muted">
          {row.usageCount} {row.usageCount === 1 ? "person" : "people"}
        </Text>
      </View>

      <View className="mt-2 flex-row flex-wrap items-center gap-2">
        {editing ? (
          <>
            <Button
              title="Save"
              size="sm"
              onPress={onCommitRename}
              disabled={busy || !draftName.trim()}
            />
            <Button title="Cancel" size="sm" variant="ghost" onPress={onCancelRename} disabled={busy} />
          </>
        ) : merging ? null : (
          <>
            <Button
              title="Rename"
              size="sm"
              variant="secondary"
              icon="edit-2"
              onPress={onStartRename}
              disabled={busy}
            />
            <Button
              title={row.isActive ? "Deactivate" : "Restore"}
              size="sm"
              variant={row.isActive ? "danger" : "secondary"}
              icon={row.isActive ? "eye-off" : "rotate-ccw"}
              onPress={onToggleActive}
              disabled={busy}
            />
            {row.isActive && otherOptions.length > 0 ? (
              <Button
                title="Merge into…"
                size="sm"
                variant="ghost"
                icon="git-merge"
                onPress={onStartMerge}
                disabled={busy}
              />
            ) : null}
          </>
        )}
      </View>

      {merging ? (
        <View className="mt-2 gap-2 rounded-md border border-border bg-sunken p-2">
          <Text className="text-xs text-muted">Merge "{row.label}" into:</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View className="flex-row gap-1.5">
              {otherOptions.map((o) => (
                <Pressable
                  key={o._id}
                  onPress={() => onMergeTargetChange(o._id)}
                  className={`rounded-pill border px-2.5 py-1 ${
                    mergeTargetId === o._id
                      ? "border-accent bg-accent-soft"
                      : "border-border-strong bg-raised"
                  }`}
                >
                  <Text
                    className={`text-xs ${
                      mergeTargetId === o._id ? "font-semibold text-accent" : "text-ink"
                    }`}
                  >
                    {o.label}
                  </Text>
                </Pressable>
              ))}
            </View>
          </ScrollView>
          {target ? (
            <Text className="text-xs text-warn">
              Moves {row.usageCount} {row.usageCount === 1 ? "person" : "people"} from "
              {row.label}" onto "{target.label}" and deactivates "{row.label}". This can't be
              undone.
            </Text>
          ) : null}
          <View className="flex-row gap-2">
            <Button
              title="Confirm merge"
              size="sm"
              variant="danger"
              onPress={onConfirmMerge}
              disabled={busy || !target}
            />
            <Button title="Cancel" size="sm" variant="ghost" onPress={onCancelMerge} disabled={busy} />
          </View>
        </View>
      ) : null}

      {error ? <Text className="mt-2 text-xs text-danger">{error}</Text> : null}
    </View>
  );
}
