import { Pressable, Text, View } from "react-native";

/**
 * A labelled switch row for the page-setup toggles. The UI kit has no Switch,
 * so this is a small class-driven track + knob (web-safe, no native module).
 */
export function ToggleRow({
  label,
  hint,
  value,
  onToggle,
  disabled = false,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onToggle: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: value, disabled }}
      disabled={disabled}
      onPress={() => onToggle(!value)}
      className={`flex-row items-center justify-between gap-3 py-2 ${
        disabled ? "opacity-50" : "active:opacity-80"
      }`}
    >
      <View className="flex-1">
        <Text className="text-base font-medium text-ink">{label}</Text>
        {hint ? <Text className="mt-0.5 text-xs text-muted">{hint}</Text> : null}
      </View>
      <View
        className={`h-6 w-10 justify-center rounded-pill px-0.5 ${
          value ? "bg-accent" : "bg-border-strong"
        }`}
      >
        <View
          className={`h-5 w-5 rounded-pill bg-white ${
            value ? "self-end" : "self-start"
          }`}
        />
      </View>
    </Pressable>
  );
}
