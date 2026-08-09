/**
 * The UI kit's switch — a class-driven track + knob (web-safe, no native
 * module), which the ticketing setup screens had each hand-rolled a copy of.
 *
 * Same two defects the shared `Checkbox` exists to fix apply to
 * `role="switch"`: react-native-web ignores Space for the role
 * (see `spaceToggle.ts`), and `accessibilityState={{ checked }}` reaches the
 * DOM as nothing at all, so `aria-checked` has to be passed explicitly.
 */
import { Pressable, View } from "react-native";
import { spaceToggleProps } from "./spaceToggle";

/**
 * The bare track + knob, with no press target of its own — for rows where the
 * WHOLE row is the switch (`ToggleRow`) and a nested pressable would be a
 * second, redundant tab stop inside the first.
 */
export function SwitchTrack({ value }: { value: boolean }) {
  return (
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
  );
}

export function Switch({
  value,
  onValueChange,
  accessibilityLabel,
  disabled = false,
}: {
  value: boolean;
  onValueChange: (next: boolean) => void;
  /** Always pass one — a bare track announces as "switch, on" with no clue
   *  WHAT is on. Required for exactly the reason `Checkbox`'s is. */
  accessibilityLabel: string;
  disabled?: boolean;
}) {
  const toggle = () => onValueChange(!value);
  return (
    <Pressable
      {...spaceToggleProps(toggle, disabled)}
      onPress={toggle}
      disabled={disabled}
      accessibilityRole="switch"
      aria-checked={value}
      accessibilityState={{ checked: value, disabled }}
      accessibilityLabel={accessibilityLabel}
      className={disabled ? "opacity-50" : "active:opacity-80"}
    >
      <SwitchTrack value={value} />
    </Pressable>
  );
}
