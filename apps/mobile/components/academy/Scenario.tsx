import { useState } from "react";
import { View, Text, Pressable } from "react-native";
import { Icon } from "../ui";
import { colors } from "../../lib/theme";
import { Inline } from "./Inline";

type ScenarioOption = { text: string; correct?: boolean; feedback: string };

/**
 * A multiple-choice scenario: pick an option and read its feedback inline. A
 * wrong pick nudges and leaves every option tappable so the learner can try
 * again; the correct pick confirms and resolves the widget. Local state only —
 * nothing is reported outward (same rule as every Academy practice widget).
 */
export function Scenario({
  prompt,
  options,
}: {
  prompt: string;
  options: ScenarioOption[];
}) {
  // The index of the last-tapped option, or null before any pick.
  const [picked, setPicked] = useState<number | null>(null);
  const pickedOption = picked === null ? null : options[picked];
  const resolved = pickedOption?.correct === true;

  return (
    <View>
      <Text className="text-base font-semibold leading-6 text-ink">
        <Inline text={prompt} />
      </Text>
      <View className="mt-3 gap-2">
        {options.map((option, i) => {
          const isPicked = picked === i;
          const isCorrect = option.correct === true;
          return (
            <View key={i}>
              <Pressable
                onPress={() => setPicked(i)}
                disabled={resolved}
                accessibilityRole="button"
                className={`flex-row items-center gap-2 rounded-md border px-3 py-2.5 ${
                  isPicked && isCorrect
                    ? "border-success bg-success-bg"
                    : isPicked
                      ? "border-border-strong bg-sunken"
                      : "border-border active:bg-sunken web:hover:bg-sunken"
                }`}
              >
                {isPicked ? (
                  <Icon
                    name={isCorrect ? "check-circle" : "x-circle"}
                    size={14}
                    color={isCorrect ? colors.success : colors.muted}
                  />
                ) : (
                  <View className="h-3.5 w-3.5 rounded-pill border border-border-strong" />
                )}
                <Text className="flex-1 text-sm leading-5 text-ink">
                  <Inline text={option.text} />
                </Text>
              </Pressable>
              {isPicked && isCorrect ? (
                <View
                  className="mt-1.5 rounded-md bg-sunken px-3 py-2.5"
                  style={{ borderLeftWidth: 3, borderLeftColor: colors.success }}
                >
                  <Text className="text-sm leading-5 text-ink">
                    <Inline text={option.feedback} />
                  </Text>
                </View>
              ) : isPicked ? (
                <View className="mt-1.5 flex-row items-start gap-1.5 px-1">
                  <Text className="flex-1 text-xs leading-4 text-muted">
                    <Text className="font-semibold">Not quite</Text> ·{" "}
                    <Inline text={option.feedback} />
                  </Text>
                </View>
              ) : null}
            </View>
          );
        })}
      </View>
      {resolved ? null : (
        <Text className="mt-2 text-xs text-faint">
          Pick the move you'd make — tap to see how it plays out.
        </Text>
      )}
    </View>
  );
}
