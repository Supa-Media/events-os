import { useState } from "react";
import { View, Text } from "react-native";
import { useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { Card, Button, TextField, SectionHeader } from "../ui";

/**
 * The event OWNS its roles (cloned from its template, then edited freely). A
 * single editable list — rename inline, delete, add — so an event can diverge
 * from its template. Mirrors the template RolesCard.
 */
export function EventRolesCard({
  eventId,
  roles,
}: {
  eventId: string;
  roles: Array<{ _id: string; label: string }>;
}) {
  const updateRole = useMutation(api.roles.updateEventRole);
  const createRole = useMutation(api.roles.createForEvent);
  const deleteRole = useMutation(api.roles.deleteEventRole);

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
    if (trimmed) updateRole({ roleId: roleId as any, label: trimmed });
    setEditingId(null);
    setEditLabel("");
  }

  async function handleAdd() {
    const trimmed = newLabel.trim();
    if (!trimmed) return;
    await createRole({ eventId: eventId as any, label: trimmed });
    setNewLabel("");
    setAdding(false);
  }

  return (
    <Card className="mb-6">
      <SectionHeader title="Roles" count={roles.length || undefined} />
      <Text className="mb-3 text-sm text-muted">
        This event's roles. Rename inline, remove, or add event-only roles.
      </Text>
      {roles.length === 0 ? (
        <Text className="mb-3 text-sm text-faint">No roles yet — add one below.</Text>
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
                    <Text className="text-sm font-medium text-ink">{r.label}</Text>
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
                    onPress={() => deleteRole({ roleId: r._id as any })}
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
