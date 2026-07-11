import { useState } from "react";
import { View, Text } from "react-native";
import type { AcademyStatusOption } from "@events-os/shared";
import { Icon, OptionTag } from "../ui";
import { colors } from "../../lib/theme";

const DEFAULT_CAPTION =
  "That's what done looks like — readiness math runs on this.";

/**
 * A mini grid row with a tappable status chip — the exact interaction of a
 * real workstream row (OptionTag chips, same color vocabulary), with local
 * state only. Reaching the terminal status shows the teaching line.
 */
export function TryStatus({
  title,
  options,
  terminal,
  caption,
}: {
  title: string;
  options: AcademyStatusOption[];
  terminal: string;
  caption?: string;
}) {
  const [idx, setIdx] = useState(0);
  const current = options[idx];
  const done = current?.value === terminal;

  return (
    <View>
      <View className="flex-row items-center gap-3 rounded-md border border-border bg-raised px-3 py-2.5">
        <Text className="flex-1 text-sm font-medium text-ink" numberOfLines={2}>
          {title}
        </Text>
        <OptionTag
          label={current?.label ?? ""}
          color={current?.color}
          onPress={() => setIdx((i) => (i + 1) % options.length)}
        />
      </View>
      {done ? (
        <View className="mt-2 flex-row items-start gap-2">
          <View className="mt-0.5">
            <Icon name="check-circle" size={13} color={colors.success} />
          </View>
          <Text className="flex-1 text-xs leading-4 text-success">
            {caption ?? DEFAULT_CAPTION}
          </Text>
        </View>
      ) : (
        <Text className="mt-2 text-xs text-faint">
          Tap the status chip — it cycles, exactly like a real row.
        </Text>
      )}
    </View>
  );
}
