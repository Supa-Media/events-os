import { useEffect, useState } from "react";
import { View, Text } from "react-native";
import { Button, Badge, TextField } from "../ui";

/* ── Name + version + start ─────────────────────────────────────────────── */

export function NameEditor({
  name,
  version,
  onSave,
  onStart,
}: {
  name: string;
  version: number;
  onSave: (name: string) => Promise<unknown>;
  onStart: () => void;
}) {
  const [local, setLocal] = useState(name);
  useEffect(() => setLocal(name), [name]);

  function save() {
    const trimmed = local.trim();
    if (trimmed && trimmed !== name) onSave(trimmed);
    else if (!trimmed) setLocal(name);
  }

  return (
    <View className="mb-6 flex-row items-start justify-between gap-4">
      <View className="flex-1">
        <Text className="mb-1 text-xs font-bold uppercase tracking-wider text-accent">
          Template
        </Text>
        <TextField value={local} onChangeText={setLocal} onBlur={save} placeholder="Template name" />
      </View>
      <View className="flex-row items-center gap-3 pt-1">
        <Badge label={`v${version}`} />
        <Button title="Start an event" icon="play" onPress={onStart} />
      </View>
    </View>
  );
}
