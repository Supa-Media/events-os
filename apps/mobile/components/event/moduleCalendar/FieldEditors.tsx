/**
 * The one live editor a field chip opens, dispatched on the column's type.
 * People/roles use the same centered modal pickers as the table; option and
 * inline-text columns use an anchored popover so the edit happens visually "on"
 * the chip. Seeding + parsing goes through COLUMN_TYPE_REGISTRY so a value like
 * "$250" round-trips exactly like the grid cell.
 */
import { useState } from "react";
import { View, Text, Pressable, TextInput } from "react-native";
import { Icon } from "../../ui/Icon";
import { CopyButton } from "../../ui/CopyButton";
import { Popover } from "../../ui/Popover";
import { PersonPicker } from "../../ui/PersonPicker";
import { RolePicker } from "../../ui/RolePicker";
import type { AnchorRect } from "../../ui/useAnchor";
import { colors } from "../../../lib/theme";
import { optionColor } from "../../../lib/optionColor";
import { COLUMN_TYPE_REGISTRY } from "../../grid/columnRegistry";
import { asArray, type CalendarColumn, type ScheduleItem, type SelectOption } from "./config";
import { valueOf, type EditTarget, type EventRole } from "./fieldChips.helpers";

export function FieldEditor({
  item,
  target,
  roles,
  onSave,
  onClose,
}: {
  item: ScheduleItem;
  target: EditTarget;
  roles: EventRole[];
  onSave: (value: unknown) => void;
  onClose: () => void;
}) {
  const { column, anchor } = target;
  const value = valueOf(item, column);

  if (column.type === "person") {
    return (
      <PersonPicker
        visible
        title={column.label}
        selectedId={(value as string | null) ?? item.owner?._id ?? null}
        onPick={(id) => onSave(id)}
        onClear={() => onSave(null)}
        onClose={onClose}
      />
    );
  }

  if (column.type === "role") {
    return (
      <RolePicker
        visible
        title={column.label}
        roles={roles}
        selectedId={(value as string | null) ?? null}
        onPick={(id) => onSave(id)}
        onClear={() => onSave(null)}
        onClose={onClose}
      />
    );
  }

  if (column.type === "select") {
    const opts = (column.options ?? []) as SelectOption[];
    return (
      <Popover visible onClose={onClose} anchor={anchor} width={220}>
        <View className="py-1">
          {value != null ? (
            <OptionRow label="Clear" muted onPress={() => onSave(null)} />
          ) : null}
          {opts.map((o) => (
            <OptionRow
              key={o.value}
              label={o.label}
              color={o.color}
              selected={o.value === value}
              onPress={() => onSave(o.value)}
            />
          ))}
        </View>
      </Popover>
    );
  }

  if (column.type === "multiselect") {
    return (
      <MultiSelectEditor
        column={column}
        initial={asArray(value)}
        anchor={anchor}
        onSave={onSave}
        onClose={onClose}
      />
    );
  }

  // Inline-text family (text/longtext/number/currency/date/url).
  return (
    <TextFieldEditor
      column={column}
      value={value}
      anchor={anchor}
      onSave={onSave}
      onClose={onClose}
    />
  );
}

/** Toggle options in place; the result is saved when the popover closes. */
function MultiSelectEditor({
  column,
  initial,
  anchor,
  onSave,
  onClose,
}: {
  column: CalendarColumn;
  initial: string[];
  anchor?: AnchorRect;
  onSave: (value: unknown) => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<string[]>(initial);
  const opts = (column.options ?? []) as SelectOption[];

  const commit = () => {
    const changed =
      selected.length !== initial.length ||
      selected.some((v) => !initial.includes(v));
    if (changed) onSave(selected.length > 0 ? selected : null);
    else onClose();
  };

  return (
    <Popover visible onClose={commit} anchor={anchor} width={220}>
      <View className="py-1">
        {opts.map((o) => (
          <OptionRow
            key={o.value}
            label={o.label}
            color={o.color}
            selected={selected.includes(o.value)}
            onPress={() =>
              setSelected((cur) =>
                cur.includes(o.value)
                  ? cur.filter((v) => v !== o.value)
                  : [...cur, o.value],
              )
            }
          />
        ))}
      </View>
    </Popover>
  );
}

/** Anchored one-field editor for the inline-text column family. */
function TextFieldEditor({
  column,
  value,
  anchor,
  onSave,
  onClose,
}: {
  column: CalendarColumn;
  value: unknown;
  anchor?: AnchorRect;
  onSave: (value: unknown) => void;
  onClose: () => void;
}) {
  const cfg =
    COLUMN_TYPE_REGISTRY[column.type as keyof typeof COLUMN_TYPE_REGISTRY]
      ?.inlineText;
  const [text, setText] = useState(() =>
    cfg?.format ? cfg.format(value) : value != null ? String(value) : "",
  );

  const commit = () => {
    const parsed = cfg?.parse ? cfg.parse(text, column as any) : text.trim() || null;
    onSave(parsed);
  };

  const placeholder =
    typeof cfg?.placeholder === "function"
      ? cfg.placeholder(column as any)
      : cfg?.placeholder ?? "—";

  return (
    <Popover visible onClose={commit} anchor={anchor} width={240}>
      <View className="p-2">
        <Text className="mb-1.5 px-1 text-2xs font-bold uppercase tracking-wide text-faint">
          {column.label}
        </Text>
        <TextInput
          value={text}
          onChangeText={setText}
          autoFocus
          multiline={!!cfg?.multiline}
          keyboardType={cfg?.numeric ? "numeric" : "default"}
          placeholder={placeholder}
          placeholderTextColor={colors.faint}
          onSubmitEditing={cfg?.multiline ? undefined : commit}
          textAlignVertical="top"
          className="rounded-md border border-border bg-raised px-2.5 py-2 text-sm text-ink"
          style={cfg?.multiline ? { minHeight: 72 } : undefined}
        />
        <View className="mt-2 flex-row items-center justify-end gap-2">
          {text.trim() ? <CopyButton text={text} label /> : null}
          <View className="flex-1" />
          {value != null ? (
            <Pressable
              onPress={() => onSave(null)}
              className="rounded-md px-2.5 py-1.5 active:bg-sunken"
            >
              <Text className="text-xs font-semibold text-muted">Clear</Text>
            </Pressable>
          ) : null}
          <Pressable
            onPress={commit}
            className="rounded-md bg-accent px-3 py-1.5 active:opacity-80"
          >
            <Text className="text-xs font-bold text-white">Save</Text>
          </Pressable>
        </View>
      </View>
    </Popover>
  );
}

/** A pick-one row: colored option tag (or muted label), check when selected. */
function OptionRow({
  label,
  color,
  selected,
  muted,
  onPress,
}: {
  label: string;
  color?: string | null;
  selected?: boolean;
  muted?: boolean;
  onPress: () => void;
}) {
  const c = optionColor(color ?? undefined);
  return (
    <Pressable
      onPress={onPress}
      className="flex-row items-center justify-between gap-3 px-3 py-2 active:bg-sunken web:hover:bg-sunken"
    >
      {muted ? (
        <Text className="text-sm text-muted">{label}</Text>
      ) : (
        <View className="self-start rounded-sm px-2 py-0.5" style={{ backgroundColor: c.bg }}>
          <Text className="text-xs font-semibold" style={{ color: c.text }}>
            {label}
          </Text>
        </View>
      )}
      {selected ? <Icon name="check" size={15} color={colors.accent} /> : null}
    </Pressable>
  );
}
