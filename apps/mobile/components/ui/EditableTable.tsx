/**
 * Editable-table cell primitives — the spreadsheet-style cells copy-pasted
 * across `people.tsx` and `CrewSections.tsx`, extracted verbatim so consumers
 * share one implementation.
 *
 *  - `InlineText`  — an inline editable text cell, commits on blur (onEndEditing
 *    is unreliable on RN-web). Optional numeric keyboard + parse/format.
 *  - `GridHeaderCell` — a fixed-width uppercase column header (named to avoid the
 *    flex-based `HeaderCell` already exported from `./Table`).
 *  - `SelectCell`  — an `OptionTag` that opens a `Popover` of options; generic
 *    over the value type. Folds the near-identical VettingCell / StatusCell.
 *
 * RN-web: layout lives on inner Views with static className + active:/web:hover
 * variants (function-style Pressable `style` is ignored on web).
 */
import { useEffect, useState } from "react";
import { View, Text, TextInput, Pressable } from "react-native";
import { Icon } from "./Icon";
import { OptionTag } from "./OptionTag";
import { Popover } from "./Popover";
import { useAnchor } from "./useAnchor";
import { colors } from "../../lib/theme";

// ── Inline editable text cell ─────────────────────────────────────────────────
export function InlineText<T = string>({
  value,
  onCommit,
  placeholder,
  numeric,
  parse,
  format,
  weight,
}: {
  value: T;
  onCommit: (v: T) => void;
  placeholder?: string;
  numeric?: boolean;
  /** Map the raw text to the committed value (defaults to the text itself). */
  parse?: (t: string) => T;
  /** Map the value to its displayed text (defaults to String(value)). */
  format?: (v: T) => string;
  weight?: "normal" | "medium";
}) {
  const display = () =>
    format ? format(value) : value == null ? "" : String(value);
  const [text, setText] = useState(display);
  // Keep the field in sync when the underlying value changes from elsewhere.
  useEffect(() => {
    setText(display());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <TextInput
      value={text}
      onChangeText={setText}
      placeholder={placeholder}
      placeholderTextColor={colors.faint}
      keyboardType={numeric ? "numbers-and-punctuation" : "default"}
      autoCapitalize="none"
      onBlur={() => onCommit(parse ? parse(text) : (text as unknown as T))}
      className={`flex-1 px-2 py-1.5 text-sm leading-snug text-ink ${
        weight === "medium" ? "font-medium" : ""
      }`}
      style={{ minWidth: 40 }}
    />
  );
}

// ── Fixed-width uppercase column header ───────────────────────────────────────
export function GridHeaderCell({
  label,
  width,
}: {
  label: string;
  width: number;
}) {
  return (
    <View style={{ width }} className="px-2 py-2.5">
      <Text
        className="text-2xs font-bold uppercase tracking-wider text-muted"
        numberOfLines={1}
      >
        {label}
      </Text>
    </View>
  );
}

// ── Select cell: an OptionTag that opens a Popover of color-coded options ──────
export type SelectOption<T extends string> = {
  value: T;
  label: string;
  color?: string | null;
};

export function SelectCell<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: SelectOption<T>[];
  onChange: (v: T) => void;
}) {
  const { ref, anchor, visible, open, close } = useAnchor();
  const current = options.find((o) => o.value === value);

  return (
    <>
      <Pressable
        ref={ref}
        onPress={open}
        className="flex-1 px-2 py-1.5 active:opacity-70"
      >
        <OptionTag label={current?.label ?? value} color={current?.color} />
      </Pressable>
      <Popover visible={visible} onClose={close} anchor={anchor}>
        <View className="py-1">
          {options.map((o) => (
            <Pressable
              key={o.value}
              onPress={() => {
                onChange(o.value);
                close();
              }}
              className="flex-row items-center justify-between gap-3 px-3 py-2 active:bg-sunken web:hover:bg-sunken"
            >
              <OptionTag label={o.label} color={o.color} />
              {o.value === value ? (
                <Icon name="check" size={15} color={colors.accent} />
              ) : null}
            </Pressable>
          ))}
        </View>
      </Popover>
    </>
  );
}
