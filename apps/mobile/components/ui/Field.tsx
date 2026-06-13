import { ReactNode, useState } from "react";
import { View, Text, TextInput, Pressable, TextInputProps } from "react-native";
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
};

/** A labelled text input with hover/focus ring. */
export function TextField({ label, hint, ...inputProps }: TextFieldProps) {
  const [focused, setFocused] = useState(false);
  const border = focused ? "border-accent" : "border-border-strong";
  return (
    <Field label={label} hint={hint}>
      <TextInput
        placeholderTextColor={colors.faint}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        className={`rounded-md border ${border} bg-raised px-3 py-2.5 text-base text-ink`}
        {...inputProps}
      />
    </Field>
  );
}

type Option = { value: string; label: string };

/**
 * A lightweight select. RN-web has no native `<select>`, so this is a labelled
 * trigger that expands an inline option list. Class-driven hover/selected
 * states keep it web-safe.
 */
export function Select({
  label,
  value,
  options,
  onChange,
  placeholder = "Select…",
}: {
  label?: string;
  value: string | null;
  options: Option[];
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const current = options.find((o) => o.value === value);

  return (
    <Field label={label}>
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
          {options.map((o) => (
            <SelectRow
              key={o.value}
              label={o.label}
              selected={o.value === value}
              onPress={() => {
                onChange(o.value);
                setOpen(false);
              }}
            />
          ))}
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
