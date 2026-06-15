import { useState } from "react";
import { View, Text } from "react-native";
import { useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import type { ResolvedModule } from "@events-os/shared";
import { Card, Button, Pill, TextField, SectionHeader } from "../ui";

type CustomRow = { _id: string; key: string; label: string };

/**
 * Event-level module controls: re-enable a core module the template disabled, or
 * add an event-only custom module. Editing the active modules (rename, owner,
 * delete) happens per-section; this card is the "add a module" surface.
 */
export function EventModulesCard({
  eventId,
  disabledCore,
  customRows,
}: {
  eventId: string;
  disabledCore: ResolvedModule[];
  customRows: CustomRow[];
}) {
  const toggleCore = useMutation(api.modules.toggleCoreForEvent);
  const createCustom = useMutation(api.modules.createCustomForEvent);
  const deleteCustom = useMutation(api.modules.deleteCustomForEvent);

  const [newLabel, setNewLabel] = useState("");
  const [adding, setAdding] = useState(false);

  async function handleAdd() {
    const trimmed = newLabel.trim();
    if (!trimmed) return;
    await createCustom({ eventId: eventId as any, label: trimmed });
    setNewLabel("");
    setAdding(false);
  }

  return (
    <Card className="mb-6">
      <SectionHeader title="Add modules" />
      <Text className="mb-3 text-sm text-muted">
        Re-enable a core module or add an event-only one.
      </Text>

      {disabledCore.length > 0 ? (
        <View className="mb-3 flex-row flex-wrap gap-2">
          {disabledCore.map((m) => (
            <Pill
              key={m.key}
              label={`+ ${m.label}`}
              onPress={() =>
                toggleCore({ eventId: eventId as any, key: m.key, enabled: true })
              }
            />
          ))}
        </View>
      ) : null}

      {customRows.length > 0 ? (
        <View className="mb-3 gap-2">
          {customRows.map((r) => (
            <View key={r._id} className="flex-row items-center gap-2">
              <Text className="flex-1 text-sm font-medium text-ink">{r.label}</Text>
              <Button
                title=""
                icon="trash-2"
                size="sm"
                variant="ghost"
                onPress={() =>
                  deleteCustom({ moduleId: r._id as Id<"eventModules"> })
                }
              />
            </View>
          ))}
        </View>
      ) : null}

      {adding ? (
        <View className="mt-1">
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
        <View className="flex-row">
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
