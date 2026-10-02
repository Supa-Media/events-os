/**
 * Text that turns into a field when the viewer may edit it. Tap it (or its
 * pencil) to edit, then Save or Cancel. Every piece of plan copy on the Goals
 * screen — mission, objective names, key-result titles — uses this, so
 * changing any of it is one tap wherever it appears.
 */
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Button, Icon, TextField } from "../ui";
import { colors } from "../../lib/theme";
import { alertError } from "../../lib/errors";

type Props = {
  value: string;
  onSave: (next: string) => Promise<unknown>;
  canEdit: boolean;
  placeholder?: string;
  multiline?: boolean;
  /** Tailwind classes for the read-only text. */
  textClassName?: string;
  label?: string;
};

export function EditableText({
  value,
  onSave,
  canEdit,
  placeholder,
  multiline,
  textClassName = "text-base text-ink",
  label,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);

  if (!editing) {
    const shown = value || placeholder || "";
    const body = (
      <Text className={`${textClassName} ${value ? "" : "text-muted"}`}>{shown}</Text>
    );
    if (!canEdit) return value ? body : null;
    return (
      <Pressable
        onPress={() => {
          setDraft(value);
          setEditing(true);
        }}
        accessibilityRole="button"
        accessibilityLabel={label ? `Edit ${label}` : "Edit"}
        className="flex-row items-start gap-2"
      >
        <View className="flex-1">{body}</View>
        <View className="pt-1">
          <Icon name="edit-2" size={14} color={colors.muted} />
        </View>
      </Pressable>
    );
  }

  const save = async () => {
    setSaving(true);
    try {
      await onSave(draft);
      setEditing(false);
    } catch (err) {
      alertError(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <View className="gap-2">
      <TextField
        label={label}
        value={draft}
        onChangeText={setDraft}
        multiline={multiline}
        autoFocus
        placeholder={placeholder}
        onSubmitEditing={multiline ? undefined : save}
      />
      <View className="flex-row gap-2">
        <Button title="Save" size="sm" onPress={save} loading={saving} />
        <Button title="Cancel" size="sm" variant="ghost" onPress={() => setEditing(false)} />
      </View>
    </View>
  );
}
