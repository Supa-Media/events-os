import { useState } from "react";
import { View, Text, Pressable } from "react-native";
import type { AcademyExchange } from "@events-os/shared";
import { Icon } from "../ui";
import { MessageRow } from "../ai/shared";
import { colors } from "../../lib/theme";

/**
 * A scripted assistant exchange, revealed bubble-by-bubble on tap. Bubbles
 * render through the assistant panel's own MessageRow, so the demo can never
 * drift from the tool it teaches. Local state only — no real assistant run.
 */
export function AgentDemo({ exchanges }: { exchanges: AcademyExchange[] }) {
  const [shown, setShown] = useState(1);
  const done = shown >= exchanges.length;

  return (
    <View>
      <View className="gap-2">
        {exchanges.slice(0, shown).map((m, i) => (
          <MessageRow
            key={i}
            m={{ kind: m.who === "you" ? "user" : "assistant", text: m.text }}
          />
        ))}
      </View>

      {done ? (
        <Pressable
          onPress={() => setShown(1)}
          accessibilityRole="button"
          className="mt-2.5 flex-row items-center gap-1.5 self-start rounded-md px-1 py-0.5 active:opacity-70"
        >
          <Icon name="rotate-ccw" size={12} color={colors.muted} />
          <Text className="text-xs font-semibold text-muted">Replay</Text>
        </Pressable>
      ) : (
        <Pressable
          onPress={() => setShown((s) => s + 1)}
          accessibilityRole="button"
          className="mt-2.5 flex-row items-center justify-center gap-1.5 rounded-md border border-border bg-raised px-3 py-2 active:bg-sunken web:hover:bg-sunken"
        >
          <Icon name="chevron-down" size={14} color={colors.muted} />
          <Text className="text-xs font-semibold text-muted">
            Tap to continue
          </Text>
        </Pressable>
      )}
    </View>
  );
}
