import { Pressable, Text, View } from "react-native";
import { SwitchTrack } from "../../ui";
import { spaceToggleProps } from "../../ui/spaceToggle";

/**
 * A labelled switch row for the page-setup toggles. The whole row is the
 * switch, so it renders the UI kit's bare `SwitchTrack` rather than a nested
 * `Switch` — a pressable inside a pressable would be a second tab stop for one
 * control.
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
  const toggle = () => onToggle(!value);
  return (
    <Pressable
      {...spaceToggleProps(toggle, disabled)}
      accessibilityRole="switch"
      // `aria-checked` is the prop that survives to the DOM on web; the
      // `accessibilityState` beside it is what native reads.
      aria-checked={value}
      accessibilityState={{ checked: value, disabled }}
      accessibilityLabel={label}
      disabled={disabled}
      onPress={toggle}
      className={`flex-row items-center justify-between gap-3 py-2 ${
        disabled ? "opacity-50" : "active:opacity-80"
      }`}
    >
      <View className="flex-1">
        <Text className="text-base font-medium text-ink">{label}</Text>
        {hint ? <Text className="mt-0.5 text-xs text-muted">{hint}</Text> : null}
      </View>
      <SwitchTrack value={value} />
    </Pressable>
  );
}
