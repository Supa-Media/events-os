/**
 * Inline composer — add an item WITHOUT leaving the calendar. Targeted at the
 * selected day (its timing offset is derived by the caller), it captures the
 * title, any multiselect groups the module declares (comms: channels + audience;
 * planning: none), and the body copy. Everything else stays in the table.
 */
import { useState } from "react";
import { View, Text, Pressable, TextInput } from "react-native";
import { Card, Button, TextField } from "../../ui";
import { Icon, type IconName } from "../../ui/Icon";
import { colors } from "../../../lib/theme";
import { optionColor } from "../../../lib/optionColor";
import { channelIcon, type SelectOption } from "./config";

export type ComposerGroup = {
  field: string;
  label: string;
  options: SelectOption[];
  /** Show each option's channel logo (comms channels only). */
  withIcons: boolean;
};

export type ComposerPayload = {
  title: string;
  copy: string;
  groups: Record<string, string[]>;
};

export function Composer({
  timing,
  itemNoun,
  copyLabel,
  copyPlaceholder,
  groups,
  onCancel,
  onSubmit,
}: {
  timing: string;
  itemNoun: string;
  copyLabel: string;
  copyPlaceholder: string;
  groups: ComposerGroup[];
  onCancel: () => void;
  onSubmit: (payload: ComposerPayload) => Promise<void> | void;
}) {
  const [title, setTitle] = useState("");
  const [copy, setCopy] = useState("");
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [saving, setSaving] = useState(false);

  const toggle = (field: string, value: string) =>
    setSelected((prev) => {
      const cur = prev[field] ?? [];
      const next = cur.includes(value)
        ? cur.filter((v) => v !== value)
        : [...cur, value];
      return { ...prev, [field]: next };
    });

  const canSave = title.trim().length > 0 && !saving;
  const submit = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      await onSubmit({ title, copy, groups: selected });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card padding="md" className="mb-4 border border-accent-soft">
      <View className="mb-1 flex-row items-center justify-between">
        <View className="flex-row items-center gap-1.5">
          <Icon name="send" size={14} color={colors.accent} />
          <Text className="font-display text-base text-ink">New {itemNoun}</Text>
        </View>
        <Pressable onPress={onCancel} hitSlop={6} className="active:opacity-70">
          <Icon name="x" size={16} color={colors.muted} />
        </Pressable>
      </View>
      <View className="mb-3 flex-row items-center gap-1">
        <Icon name="clock" size={11} color={colors.faint} />
        <Text className="text-xs text-muted">{timing}</Text>
      </View>

      <TextField
        label="Title"
        placeholder={`What's the ${itemNoun}?`}
        value={title}
        onChangeText={setTitle}
        autoFocus
        returnKeyType="done"
        onSubmitEditing={submit}
      />

      {groups.map((group) => (
        <View key={group.field}>
          <Text className="mb-1.5 text-sm font-semibold text-ink">
            {group.label}
          </Text>
          <View className="mb-3 flex-row flex-wrap gap-1.5">
            {group.options.map((o) => (
              <ToggleChip
                key={o.value}
                label={o.label}
                icon={group.withIcons ? channelIcon(o.value) : undefined}
                color={o.color}
                selected={(selected[group.field] ?? []).includes(o.value)}
                onPress={() => toggle(group.field, o.value)}
              />
            ))}
          </View>
        </View>
      ))}

      <Text className="mb-1.5 text-sm font-semibold text-ink">{copyLabel}</Text>
      <TextInput
        value={copy}
        onChangeText={setCopy}
        placeholder={copyPlaceholder}
        placeholderTextColor={colors.faint}
        multiline
        textAlignVertical="top"
        className="mb-4 rounded-md border border-border-strong bg-raised px-3 py-2.5 text-sm text-ink"
        style={{ minHeight: 60 }}
      />

      <View className="flex-row justify-end gap-2">
        <Button title="Cancel" variant="ghost" size="sm" onPress={onCancel} />
        <Button
          title={`Add ${itemNoun}`}
          icon="plus"
          size="sm"
          onPress={submit}
          loading={saving}
          disabled={!canSave}
        />
      </View>
    </Card>
  );
}

/** A tappable pill that toggles a multiselect value on or off. */
function ToggleChip({
  label,
  icon,
  color,
  selected,
  onPress,
}: {
  label: string;
  icon?: IconName;
  color?: string | null;
  selected: boolean;
  onPress: () => void;
}) {
  const c = optionColor(color);
  return (
    <Pressable onPress={onPress} className="active:opacity-80">
      <View
        className="flex-row items-center gap-1.5 rounded-pill border px-2.5 py-1"
        style={
          selected
            ? { backgroundColor: c.bg, borderColor: c.text }
            : { backgroundColor: colors.raised, borderColor: colors.border }
        }
      >
        {icon ? (
          <Icon name={icon} size={13} color={selected ? c.text : colors.muted} />
        ) : null}
        <Text
          className="text-xs font-semibold"
          style={{ color: selected ? c.text : colors.muted }}
        >
          {label}
        </Text>
      </View>
    </Pressable>
  );
}
