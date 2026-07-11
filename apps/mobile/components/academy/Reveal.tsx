import { useState } from "react";
import { View, Text, Pressable } from "react-native";
import { Icon } from "../ui";
import { colors } from "../../lib/theme";
import { Inline } from "./Inline";

/**
 * A scenario card: a "what would you do?" prompt with a tap-to-reveal
 * playbook answer — a mid-read intuition check. Local state only.
 */
export function Reveal({ prompt, answer }: { prompt: string; answer: string }) {
  const [open, setOpen] = useState(false);

  return (
    <View>
      <Text className="text-base font-semibold leading-6 text-ink">
        <Inline text={prompt} />
      </Text>
      {open ? (
        <View
          className="mt-3 rounded-md bg-sunken px-3 py-2.5"
          style={{ borderLeftWidth: 3, borderLeftColor: colors.accent }}
        >
          <Text className="text-sm leading-5 text-ink">
            <Inline text={answer} />
          </Text>
        </View>
      ) : (
        <Pressable
          onPress={() => setOpen(true)}
          accessibilityRole="button"
          className="mt-3 flex-row items-center gap-1.5 self-start rounded-md border border-border px-3 py-1.5 active:bg-sunken web:hover:bg-sunken"
        >
          <Icon name="eye" size={13} color={colors.accent} />
          <Text className="text-xs font-semibold text-accent">
            Reveal the playbook's answer
          </Text>
        </Pressable>
      )}
    </View>
  );
}
