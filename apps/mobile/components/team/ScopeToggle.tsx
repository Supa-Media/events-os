/**
 * ScopeToggle — the money-attribution picker for a project: Central, or the
 * project's home chapter. Exactly two options always — a project's one_time
 * budget can only ever sit at one of those two levels (see `finances.
 * transferProjectScope`, the tool this drives both at creation and
 * retroactively from the project page's "Belongs to" row).
 */
import { Text, View, Pressable } from "react-native";

export type ProjectScopeChoice = "central" | "chapter";

export function ScopeToggle({
  value,
  chapterName,
  onChange,
  disabled = false,
}: {
  value: ProjectScopeChoice;
  /** The project's home chapter's display name (the non-central option). */
  chapterName: string;
  onChange: (next: ProjectScopeChoice) => void;
  disabled?: boolean;
}) {
  const options: { key: ProjectScopeChoice; label: string }[] = [
    { key: "central", label: "Central" },
    { key: "chapter", label: chapterName },
  ];
  return (
    <View
      className="flex-row rounded-lg bg-sunken"
      style={{ padding: 3, gap: 4, opacity: disabled ? 0.5 : 1 }}
    >
      {options.map((opt) => {
        const active = value === opt.key;
        return (
          <Pressable
            key={opt.key}
            disabled={disabled || active}
            onPress={() => onChange(opt.key)}
            accessibilityRole="button"
            accessibilityLabel={`Attribute to ${opt.label}`}
            accessibilityState={{ selected: active, disabled }}
            className={`rounded-md px-2.5 py-1 active:opacity-80 web:hover:opacity-90 ${
              active ? "bg-raised shadow-sm" : ""
            }`}
          >
            <Text
              className={`text-xs font-semibold ${
                active ? "text-ink" : "text-muted"
              }`}
              numberOfLines={1}
            >
              {opt.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
