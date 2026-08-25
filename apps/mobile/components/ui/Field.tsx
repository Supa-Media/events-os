import { ReactNode, useEffect, useState } from "react";
import { View, Text, TextInput, Pressable, ScrollView, TextInputProps } from "react-native";
import { Icon } from "./Icon";
import { colors } from "../../lib/theme";

type FieldProps = {
  label?: string;
  hint?: string;
  children?: ReactNode;
};

/** A labelled form-row wrapper. Wrap any control (or a TextField). */
export function Field({ label, hint, children }: FieldProps) {
  return (
    <View className="mb-3">
      {label ? (
        <Text className="mb-1.5 text-sm font-semibold text-ink">{label}</Text>
      ) : null}
      {children}
      {hint ? <Text className="mt-1.5 text-xs text-muted">{hint}</Text> : null}
    </View>
  );
}

type TextFieldProps = TextInputProps & {
  label?: string;
  hint?: string;
  /** Static text shown inside the field, after the input (e.g. an email domain). */
  suffix?: string;
};

// A multiline box's height is content-driven: it starts tall enough to read
// and grows to fit what's typed, so a paragraph of terms is never trapped in a
// two-line slit. These estimate a rendered line at the `text-base`/`py-2.5`
// metrics this component uses.
const MULTILINE_LINE_HEIGHT = 22;
const MULTILINE_VERTICAL_PADDING = 20;
/** Default starting height (≈4 lines) when a caller gives no `numberOfLines`. */
const MULTILINE_MIN_HEIGHT = 96;
/** Ceiling past which the box scrolls internally instead of pushing the rest of
 *  the form off-screen. */
const MULTILINE_MAX_HEIGHT = 360;

/** A labelled text input with hover/focus ring and an optional inline suffix.
 *  When `multiline`, the box auto-grows to fit what's typed and aligns text to
 *  the top. A caller's `numberOfLines` sets the STARTING height (so compact
 *  two-line notes stay compact); absent it, a generous default is used. Either
 *  way it grows with the text up to `MULTILINE_MAX_HEIGHT`. */
export function TextField({ label, hint, suffix, ...inputProps }: TextFieldProps) {
  const [focused, setFocused] = useState(false);
  const [contentHeight, setContentHeight] = useState(0);
  const border = focused ? "border-accent" : "border-border-strong";

  // Auto-grow only matters for multiline; single-line inputs keep their
  // padding-driven height and ignore all of this.
  const multiline = Boolean(inputProps.multiline);
  const minHeight = inputProps.numberOfLines
    ? inputProps.numberOfLines * MULTILINE_LINE_HEIGHT + MULTILINE_VERTICAL_PADDING
    : MULTILINE_MIN_HEIGHT;
  const multilineProps = multiline
    ? {
        textAlignVertical: "top" as const,
        onContentSizeChange: (e: {
          nativeEvent: { contentSize: { height: number } };
        }) => setContentHeight(e.nativeEvent.contentSize.height),
        // A style ARRAY so a caller's own `style` is preserved, not replaced —
        // RN merges arrays left-to-right, so the computed height layers on top
        // of (and, for `height`, wins over) whatever the caller passed.
        style: [
          inputProps.style,
          {
            height: Math.min(
              MULTILINE_MAX_HEIGHT,
              Math.max(minHeight, contentHeight),
            ),
          },
        ],
      }
    : null;

  if (suffix) {
    return (
      <Field label={label} hint={hint}>
        <View
          className={`flex-row items-center rounded-md border ${border} bg-raised px-3`}
        >
          <TextInput
            placeholderTextColor={colors.faint}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            className="flex-1 py-2.5 text-base text-ink"
            {...inputProps}
          />
          <Text className="text-base text-faint">{suffix}</Text>
        </View>
      </Field>
    );
  }

  return (
    <Field label={label} hint={hint}>
      <TextInput
        placeholderTextColor={colors.faint}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        className={`rounded-md border ${border} bg-raised px-3 py-2.5 text-base text-ink`}
        {...inputProps}
        {...(multilineProps ?? {})}
      />
    </Field>
  );
}

type Option = {
  value: string;
  label: string;
  /** Renders as a non-selectable section heading (for grouping options). */
  header?: boolean;
};

/**
 * A lightweight select. RN-web has no native `<select>`, so this is a labelled
 * trigger that expands an inline option list. Class-driven hover/selected
 * states keep it web-safe. Options flagged `header` render as inert group
 * headings rather than pickable rows. The option list scrolls internally
 * past `max-h-64` instead of growing unbounded — long lists (every event in
 * the org, etc.) used to push the rest of the form off-screen.
 */
export function Select({
  label,
  hint,
  value,
  options,
  onChange,
  placeholder = "Select…",
  searchable = false,
}: {
  label?: string;
  hint?: string;
  value: string | null;
  options: Option[];
  onChange: (value: string) => void;
  placeholder?: string;
  /** Adds an inline filter box above the option list for long option sets —
   *  opt-in so every other Select keeps its current look. */
  searchable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [filterText, setFilterText] = useState("");
  const current = options.find((o) => !o.header && o.value === value);

  // Start each open with a clean filter rather than whatever was left typed
  // from the last time this Select was opened.
  useEffect(() => {
    if (!open) setFilterText("");
  }, [open]);

  const q = filterText.trim().toLowerCase();
  const visibleOptions =
    searchable && q ? options.filter((o) => o.header || o.label.toLowerCase().includes(q)) : options;

  return (
    <Field label={label} hint={hint}>
      <Pressable
        onPress={() => setOpen((o) => !o)}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        className={`flex-row items-center justify-between rounded-md border bg-raised px-3 py-2.5 ${
          open || hovered ? "border-accent" : "border-border-strong"
        }`}
      >
        <Text className={`text-base ${current ? "text-ink" : "text-faint"}`}>
          {current?.label ?? placeholder}
        </Text>
        <Icon name={open ? "chevron-up" : "chevron-down"} size={16} color={colors.muted} />
      </Pressable>
      {open ? (
        <View className="mt-1 overflow-hidden rounded-md border border-border bg-raised shadow-raised">
          {searchable ? (
            <View className="border-b border-border px-3 py-2">
              <TextInput
                autoFocus
                value={filterText}
                onChangeText={setFilterText}
                placeholder="Filter…"
                placeholderTextColor={colors.faint}
                className="text-sm text-ink"
              />
            </View>
          ) : null}
          <ScrollView className="max-h-64" keyboardShouldPersistTaps="handled">
            {visibleOptions.map((o) =>
              o.header ? (
                <View key={`h:${o.label}`} className="bg-sunken px-3 py-1.5">
                  <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
                    {o.label}
                  </Text>
                </View>
              ) : (
                <SelectRow
                  key={o.value}
                  label={o.label}
                  selected={o.value === value}
                  onPress={() => {
                    onChange(o.value);
                    setOpen(false);
                  }}
                />
              ),
            )}
            {searchable && q && visibleOptions.every((o) => o.header) ? (
              <Text className="px-3 py-3 text-center text-xs text-muted">No matches.</Text>
            ) : null}
          </ScrollView>
        </View>
      ) : null}
    </Field>
  );
}

function SelectRow({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      className={`flex-row items-center justify-between px-3 py-2.5 ${
        hovered ? "bg-sunken" : "bg-raised"
      }`}
    >
      <Text className={`text-base ${selected ? "font-semibold text-accent" : "text-ink"}`}>
        {label}
      </Text>
      {selected ? <Icon name="check" size={15} color={colors.accent} /> : null}
    </Pressable>
  );
}
