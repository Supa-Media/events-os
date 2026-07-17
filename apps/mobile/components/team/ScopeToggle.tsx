/**
 * ScopeToggle — the money-attribution picker for a project OR event: Central,
 * or the ref's home chapter. Exactly two options always — a project/event's
 * one_time budget can only ever sit at one of those two levels (see
 * `finances.transferProjectScope`/`transferEventScope`, the tools this drives
 * both at creation and retroactively from the project/event page's "Belongs
 * to" row). Shared verbatim between the two — no project/event-specific logic
 * lives in this component.
 */
import { Text, View, Pressable } from "react-native";

export type ScopeChoice = "central" | "chapter";
/** @deprecated Kept as an alias for existing project call sites — use
 *  `ScopeChoice` in new code (this component is shared with events too). */
export type ProjectScopeChoice = ScopeChoice;

export function ScopeToggle({
  value,
  chapterName,
  onChange,
  disabled = false,
}: {
  value: ScopeChoice;
  /** The ref's home chapter's display name (the non-central option). */
  chapterName: string;
  onChange: (next: ScopeChoice) => void;
  disabled?: boolean;
}) {
  const options: { key: ScopeChoice; label: string }[] = [
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
