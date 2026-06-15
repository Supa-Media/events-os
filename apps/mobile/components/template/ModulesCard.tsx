import { useState } from "react";
import { View, Text, Pressable } from "react-native";
import { useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import type { ResolvedModule } from "@events-os/shared";
import { Card, Button, Pill, TextField, SectionHeader, Icon } from "../ui";
import { colors } from "../../lib/theme";

type Role = { _id: string; label: string; key: string };
type CustomRow = { _id: string; key: string; label: string; ownerRoleKey?: string };

/**
 * TEMPLATE MODULES editor — Core (platform built-ins, toggle on/off, rename +
 * owner-role override) and Custom (author-created, full grid, rename / delete /
 * owner). Owner is a role KEY chosen from the template's roles.
 */
export function ModulesCard({
  eventTypeId,
  active,
  disabledCore,
  customRows,
  roles,
}: {
  eventTypeId: Id<"eventTypes">;
  active: ResolvedModule[];
  disabledCore: ResolvedModule[];
  customRows: CustomRow[];
  roles: Role[];
}) {
  const toggleCore = useMutation(api.modules.toggleCoreForTemplate);
  const renameCore = useMutation(api.modules.renameCoreForTemplate);
  const setOwner = useMutation(api.modules.setOwnerForTemplate);
  const createCustom = useMutation(api.modules.createCustomForTemplate);
  const updateCustom = useMutation(api.modules.updateCustomForTemplate);
  const deleteCustom = useMutation(api.modules.deleteCustomForTemplate);

  const [newLabel, setNewLabel] = useState("");
  const [adding, setAdding] = useState(false);

  const activeCore = active.filter((m) => m.isCore);
  const customById = new Map(customRows.map((r) => [r.key, r]));

  async function handleAdd() {
    const trimmed = newLabel.trim();
    if (!trimmed) return;
    await createCustom({ eventTypeId, label: trimmed });
    setNewLabel("");
    setAdding(false);
  }

  return (
    <Card className="mb-2">
      <SectionHeader title="Modules" />

      {/* ── Core ─────────────────────────────────────────────────────────── */}
      <Text className="mb-2 mt-1 text-2xs font-bold uppercase tracking-wider text-faint">
        Core
      </Text>
      <View className="gap-2">
        {activeCore.map((m) => (
          <ModuleRow
            key={m.key}
            label={m.label}
            ownerRoleKey={m.ownerRoleKey}
            roles={roles}
            enabled
            onToggle={() =>
              toggleCore({ eventTypeId, key: m.key, enabled: false })
            }
            onRename={
              // site_map has no grid but is still renameable as a label.
              (label) => renameCore({ eventTypeId, key: m.key, label })
            }
            onSetOwner={(ownerRoleKey) =>
              setOwner({ eventTypeId, key: m.key, ownerRoleKey })
            }
          />
        ))}
        {disabledCore.length > 0 ? (
          <View className="mt-1 flex-row flex-wrap gap-2">
            {disabledCore.map((m) => (
              <Pill
                key={m.key}
                label={`+ ${m.label}`}
                onPress={() =>
                  toggleCore({ eventTypeId, key: m.key, enabled: true })
                }
              />
            ))}
          </View>
        ) : null}
      </View>

      {/* ── Custom ───────────────────────────────────────────────────────── */}
      <Text className="mb-2 mt-4 text-2xs font-bold uppercase tracking-wider text-faint">
        Custom
      </Text>
      <View className="gap-2">
        {active
          .filter((m) => !m.isCore)
          .map((m) => {
            const row = customById.get(m.key);
            return (
              <ModuleRow
                key={m.key}
                label={m.label}
                ownerRoleKey={m.ownerRoleKey}
                roles={roles}
                custom
                onRename={(label) =>
                  row
                    ? updateCustom({
                        moduleId: row._id as Id<"templateModules">,
                        label,
                      })
                    : undefined
                }
                onDelete={
                  row
                    ? () =>
                        deleteCustom({
                          moduleId: row._id as Id<"templateModules">,
                        })
                    : undefined
                }
                onSetOwner={(ownerRoleKey) =>
                  setOwner({ eventTypeId, key: m.key, ownerRoleKey })
                }
              />
            );
          })}
      </View>

      {adding ? (
        <View className="mt-3">
          <TextField
            label="New module"
            placeholder="Module name"
            value={newLabel}
            onChangeText={setNewLabel}
            onBlur={handleAdd}
            autoFocus
          />
          <Button title="Add module" size="sm" onPress={handleAdd} disabled={!newLabel.trim()} />
        </View>
      ) : (
        <View className="mt-3 flex-row">
          <Button
            title="Add module"
            size="sm"
            variant="secondary"
            icon="plus"
            onPress={() => setAdding(true)}
          />
        </View>
      )}
    </Card>
  );
}

/** One editable module row: name (rename inline), owner-role picker, toggle/delete. */
function ModuleRow({
  label,
  ownerRoleKey,
  roles,
  enabled,
  custom,
  onToggle,
  onRename,
  onDelete,
  onSetOwner,
}: {
  label: string;
  ownerRoleKey?: string;
  roles: Role[];
  enabled?: boolean;
  custom?: boolean;
  onToggle?: () => void;
  onRename?: (label: string) => void;
  onDelete?: () => void;
  onSetOwner: (ownerRoleKey: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(label);
  const [pickingOwner, setPickingOwner] = useState(false);

  const ownerRole = roles.find((r) => r.key === ownerRoleKey);

  function save() {
    const trimmed = text.trim();
    if (trimmed && trimmed !== label) onRename?.(trimmed);
    setEditing(false);
  }

  return (
    <View className="rounded-lg border border-border px-3 py-2">
      <View className="flex-row items-center gap-2">
        <View className="flex-1">
          {editing ? (
            <TextField
              value={text}
              onChangeText={setText}
              onBlur={save}
              autoFocus
            />
          ) : (
            <Text className="text-sm font-semibold text-ink">{label}</Text>
          )}
        </View>
        {onRename ? (
          <Button
            title={editing ? "Save" : "Rename"}
            size="sm"
            variant="ghost"
            onPress={() => (editing ? save() : (setText(label), setEditing(true)))}
          />
        ) : null}
        {custom && onDelete ? (
          <Button title="" icon="trash-2" size="sm" variant="ghost" onPress={onDelete} />
        ) : null}
        {!custom && onToggle ? (
          <Button title="Turn off" size="sm" variant="ghost" onPress={onToggle} />
        ) : null}
      </View>

      {/* Owner role picker — tap to cycle/clear via a small inline menu. */}
      <Pressable
        onPress={() => setPickingOwner((v) => !v)}
        className="mt-1 flex-row items-center gap-1.5 active:opacity-70"
      >
        <Icon name="shield" size={12} color={colors.muted} />
        <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
          {ownerRole ? ownerRole.label : "No owner role"}
        </Text>
        <Icon name="chevron-down" size={12} color={colors.faint} />
      </Pressable>
      {pickingOwner ? (
        <View className="mt-2 flex-row flex-wrap gap-1.5">
          {roles.map((r) => (
            <Pill
              key={r._id}
              label={r.label}
              selected={r.key === ownerRoleKey}
              onPress={() => {
                onSetOwner(r.key === ownerRoleKey ? null : r.key);
                setPickingOwner(false);
              }}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}
