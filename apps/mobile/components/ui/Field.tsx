import { ReactNode } from "react";
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  TextInputProps,
} from "react-native";
import { colors, radius, spacing } from "../../lib/theme";

type FieldProps = {
  label?: string;
  hint?: string;
  children?: ReactNode;
};

/** A labelled form row wrapper. Wrap any control (or a TextField). */
export function Field({ label, hint, children }: FieldProps) {
  return (
    <View style={styles.field}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      {children}
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

type TextFieldProps = TextInputProps & {
  label?: string;
  hint?: string;
};

/** A labelled text input row. */
export function TextField({ label, hint, style, ...inputProps }: TextFieldProps) {
  return (
    <Field label={label} hint={hint}>
      <TextInput
        placeholderTextColor={colors.muted}
        style={[styles.input, style]}
        {...inputProps}
      />
    </Field>
  );
}

const styles = StyleSheet.create({
  field: { marginBottom: spacing.md },
  label: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.text,
    marginBottom: spacing.xs,
  },
  hint: { fontSize: 12, color: colors.muted, marginTop: spacing.xs },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    fontSize: 15,
    color: colors.text,
  },
});
