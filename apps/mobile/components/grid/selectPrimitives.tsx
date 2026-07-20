/**
 * Shared primitives for select-style grid cells (anchored popover, option rows,
 * in-dropdown option management). Extracted from cells.tsx so bespoke cells
 * outside that file (e.g. the supplies Source/Status cells) can compose the
 * same pieces without a circular import.
 */
import { useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  ActivityIndicator,
} from "react-native";
import { colors } from "../../lib/theme";
import { Icon } from "../ui/Icon";
import { OptionTag } from "../ui/OptionTag";

// ── Anchored-popover helper for select-style cells ────────────────────────────
export function useAnchor() {
  const ref = useRef<any>(null);
  const [anchor, setAnchor] = useState<
    { x: number; y: number; width: number; height: number } | undefined
  >();
  const [visible, setVisible] = useState(false);
  const open = () => {
    const node = ref.current;
    if (node && typeof node.measureInWindow === "function") {
      node.measureInWindow((x: number, y: number, width: number, height: number) => {
        setAnchor({ x, y, width, height });
        setVisible(true);
      });
    } else {
      setVisible(true);
    }
  };
  return { ref, anchor, visible, open, close: () => setVisible(false) };
}

export function OptionRow({
  label,
  color,
  selected,
  muted,
  onPress,
}: {
  label: string;
  color?: string;
  selected?: boolean;
  muted?: boolean;
  onPress: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      className={`flex-row items-center justify-between gap-3 px-3 py-2 ${
        hovered ? "bg-sunken" : "bg-raised"
      }`}
    >
      {color !== undefined || !muted ? (
        <OptionTag label={label} color={color} />
      ) : (
        <Text className="text-sm text-muted">{label}</Text>
      )}
      {selected ? <Icon name="check" size={15} color={colors.accent} /> : null}
    </Pressable>
  );
}

/**
 * In-dropdown option management for select/status/multiselect value pickers.
 * Renders, when editable and the column-update callbacks are wired, an inline
 * "+ Add option" quick-add and an "Edit options…" row at the bottom of the
 * option list. The quick-add persists a new option via `onAddOption` and then
 * `onSelect`s its value; "Edit options…" hands off to the full
 * ColumnOptionsEditor (rename/remove/recolor) through `onEditOptions`.
 */
export function OptionEditFooter({
  columnId,
  onAddOption,
  onEditOptions,
  onSelect,
  closePopover,
}: {
  columnId: string;
  onAddOption?: (columnId: string, label: string) => Promise<string>;
  onEditOptions?: (columnId: string) => void;
  /** Select the newly-added option's value (single-select) or toggle it (multi). */
  onSelect: (value: string) => void;
  closePopover: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);

  if (!onAddOption && !onEditOptions) return null;

  const submit = async () => {
    const text = label.trim();
    if (!text || !onAddOption || busy) return;
    setBusy(true);
    try {
      const value = await onAddOption(columnId, text);
      onSelect(value);
    } finally {
      setBusy(false);
      setLabel("");
      setAdding(false);
    }
  };

  return (
    <View className="border-t border-border/60">
      {onAddOption ? (
        adding ? (
          <View className="flex-row items-center gap-2 px-3 py-2">
            <TextInput
              value={label}
              onChangeText={setLabel}
              autoFocus
              placeholder="New option"
              placeholderTextColor={colors.faint}
              onSubmitEditing={submit}
              className="flex-1 rounded-md border border-border bg-raised px-2 py-1.5 text-sm text-ink"
            />
            <Pressable
              onPress={submit}
              disabled={!label.trim() || busy}
              hitSlop={6}
              className={`rounded p-1 active:bg-sunken ${
                !label.trim() || busy ? "opacity-40" : ""
              }`}
            >
              {busy ? (
                <ActivityIndicator size="small" color={colors.accent} />
              ) : (
                <Icon name="check" size={16} color={colors.accent} />
              )}
            </Pressable>
          </View>
        ) : (
          <Pressable
            onPress={() => setAdding(true)}
            className="flex-row items-center gap-2 px-3 py-2 active:bg-sunken web:hover:bg-sunken"
          >
            <Icon name="plus" size={14} color={colors.muted} />
            <Text className="text-sm font-medium text-muted">Add option</Text>
          </Pressable>
        )
      ) : null}
      {onEditOptions ? (
        <Pressable
          onPress={() => {
            closePopover();
            onEditOptions(columnId);
          }}
          className="flex-row items-center gap-2 px-3 py-2 active:bg-sunken web:hover:bg-sunken"
        >
          <Icon name="edit-2" size={14} color={colors.muted} />
          <Text className="text-sm font-medium text-muted">Edit options…</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
