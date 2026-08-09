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
import { View, Text, TextInput, Pressable, Platform } from "react-native";
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
  maxLength,
  autoFocus,
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
  /** Hard cap on typed length. Pass the SAME constant the server enforces so
   *  a cell can't accept text the mutation will then reject. */
  maxLength?: number;
  /** Focus on mount. Required by the TWO-STAGE cells (`RateCell`, `ListCell`)
   *  that swap a Pressable out for this input on activation: without it a
   *  mouse user just clicks a second time, but a keyboard user presses Enter,
   *  watches the Pressable unmount, and has focus fall back to `<body>` —
   *  ejected from the grid entirely, with no way back to the cell they opened.
   *  Cells that render this input unconditionally must NOT pass it, or every
   *  row would fight over the focus on mount. */
  autoFocus?: boolean;
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
      maxLength={maxLength}
      autoFocus={autoFocus}
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
  onResizeStart,
}: {
  label: string;
  width: number;
  /** Web-only drag-to-resize handle on the column's right edge — pass
   *  `useResizableColumns`'s `startResize(key)` to make this column
   *  resizable; omit for a fixed-width column (native, or one that
   *  shouldn't resize, e.g. a checkbox column). A raw DOM `onMouseDown`
   *  (RN-web forwards it) mirrors `SiteMapEditor`'s own drag-handle pattern —
   *  `mousemove`/`mouseup` are tracked on `window` by the hook itself so the
   *  drag keeps working once the cursor leaves this handle's few pixels. */
  onResizeStart?: (clientX: number) => void;
}) {
  return (
    <View style={{ width }} className="flex-row items-center px-2 py-2.5">
      <Text
        className="flex-1 text-2xs font-bold uppercase tracking-wider text-muted"
        numberOfLines={1}
      >
        {label}
      </Text>
      {onResizeStart && Platform.OS === "web" ? (
        // Web-only resize handle; RN has no draggable-edge primitive, and a
        // raw DOM node like this one isn't a valid native host component —
        // the `Platform.OS` gate is load-bearing, not just a UX nicety (this
        // renders only under react-native-web, mirroring `SiteMapEditor`'s
        // own raw-`div` drag handles) rather than a `View`.
        <div
          onMouseDown={(e) => {
            e.preventDefault();
            onResizeStart(e.clientX);
          }}
          style={{
            cursor: "col-resize",
            width: 10,
            marginRight: -6,
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <View className="h-4 w-px bg-border" />
        </div>
      ) : null}
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
