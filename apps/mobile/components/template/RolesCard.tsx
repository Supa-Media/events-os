import { useState } from "react";
import { View, Text } from "react-native";
import { useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Card, Button, Pill, TextField, SectionHeader } from "../ui";

/* ── Roles ──────────────────────────────────────────────────────────────── */

/**
 * The template OWNS its roles — a single editable list (rename inline, delete,
 * add). No active-vs-pool distinction. An event clones these and edits its own
 * copy independently.
 */
export function RolesCard({
  eventTypeId,
  roles,
}: {
  eventTypeId: Id<"eventTypes">;
  roles: Array<{ _id: string; label: string }>;
}) {
  const updateRole = useMutation(api.roles.updateTemplateRole);
  const createRole = useMutation(api.roles.createForTemplate);
  const deleteRole = useMutation(api.roles.deleteTemplateRole);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [adding, setAdding] = useState(false);

  function startEdit(role: { _id: string; label: string }) {
    setEditingId(role._id);
    setEditLabel(role.label);
  }

  function saveEdit(roleId: string) {
    const trimmed = editLabel.trim();
    if (trimmed) updateRole({ roleId: roleId as Id<"templateRoles">, label: trimmed });
    setEditingId(null);
    setEditLabel("");
  }

  async function handleAdd() {
    const trimmed = newLabel.trim();
    if (!trimmed) return;
    await createRole({ eventTypeId, label: trimmed });
    setNewLabel("");
    setAdding(false);
  }

  return (
    <Card className="mb-2">
      <SectionHeader title="Roles" />
      <Text className="mb-3 text-sm text-muted">
        Roles for this template. Rename inline, remove, or add your own.
      </Text>
      {roles.length === 0 ? (
        <Text className="mb-3 text-sm text-faint">
          No roles yet — add one below.
        </Text>
      ) : (
        <View className="gap-2">
          {roles.map((r) => {
            const editing = editingId === r._id;
            return (
              <View key={r._id} className="flex-row items-center gap-2">
                <View className="flex-1">
                  {editing ? (
                    <TextField
                      value={editLabel}
                      onChangeText={setEditLabel}
                      onBlur={() => saveEdit(r._id)}
                      autoFocus
                    />
                  ) : (
                    <Pill label={r.label} />
                  )}
                </View>
                <Button
                  title={editing ? "Save" : "Rename"}
                  size="sm"
                  variant="ghost"
                  onPress={() => (editing ? saveEdit(r._id) : startEdit(r))}
                />
                {!editing ? (
                  <Button
                    title=""
                    icon="trash-2"
                    size="sm"
                    variant="ghost"
                    onPress={() =>
                      deleteRole({ roleId: r._id as Id<"templateRoles"> })
                    }
                  />
                ) : null}
              </View>
            );
          })}
        </View>
      )}

      {adding ? (
        <View className="mt-3">
          <TextField
            label="New role"
            placeholder="Role name"
            value={newLabel}
            onChangeText={setNewLabel}
            onBlur={handleAdd}
            autoFocus
          />
          <Button title="Add role" size="sm" onPress={handleAdd} disabled={!newLabel.trim()} />
        </View>
      ) : (
        <View className="mt-3 flex-row">
          <Button title="Add role" size="sm" variant="secondary" icon="plus" onPress={() => setAdding(true)} />
        </View>
      )}
    </Card>
  );
}
