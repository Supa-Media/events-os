import { useState } from "react";
import { View, Text, Pressable } from "react-native";
import { Icon, Button } from "../ui";
import { colors } from "../../lib/theme";

/**
 * The mark-ready simulator: check the criteria to earn the Mark ready button,
 * or take the override path and see why exceptions get named out loud.
 * Mirrors the real section-header ready flow; local state only.
 */
export function TryReady({ criteria }: { criteria: string[] }) {
  const [checked, setChecked] = useState<boolean[]>(() =>
    criteria.map(() => false),
  );
  // null = not marked; number = open items acknowledged at marking time.
  const [readyWith, setReadyWith] = useState<number | null>(null);

  const openCount = checked.filter((c) => !c).length;
  const allMet = openCount === 0;
  const marked = readyWith != null;

  function reset() {
    setChecked(criteria.map(() => false));
    setReadyWith(null);
  }

  return (
    <View>
      <View className="gap-1.5">
        {criteria.map((c, i) => (
          <Pressable
            key={i}
            disabled={marked}
            onPress={() =>
              setChecked((prev) => prev.map((v, j) => (j === i ? !v : v)))
            }
            accessibilityRole="checkbox"
            accessibilityState={{ checked: checked[i] }}
            className={`flex-row items-center gap-2.5 rounded-md border px-3 py-2 ${
              checked[i]
                ? "border-success bg-success-bg"
                : "border-border active:bg-sunken web:hover:bg-sunken"
            }`}
          >
            <Icon
              name={checked[i] ? "check-circle" : "circle"}
              size={15}
              color={checked[i] ? colors.success : colors.faint}
            />
            <Text
              className={`flex-1 text-sm ${
                checked[i] ? "font-semibold text-success" : "text-ink"
              }`}
            >
              {c}
            </Text>
          </Pressable>
        ))}
      </View>

      {marked ? (
        <View className="mt-3">
          {readyWith === 0 ? (
            <View className="flex-row items-start gap-2 rounded-md bg-success-bg px-3 py-2.5">
              <View className="mt-0.5">
                <Icon name="check-circle" size={14} color={colors.success} />
              </View>
              <Text className="flex-1 text-sm leading-5 text-success">
                Ready — earned, then declared. Your name is on it now.
              </Text>
            </View>
          ) : (
            <View className="flex-row items-start gap-2 rounded-md bg-warn-bg px-3 py-2.5">
              <View className="mt-0.5">
                <Icon name="alert-triangle" size={14} color={colors.warn} />
              </View>
              <Text className="flex-1 text-sm leading-5 text-warn">
                "Ready, with {readyWith} open item{readyWith === 1 ? "" : "s"}{" "}
                acknowledged" — say it out loud. Overrides are allowed; silent
                drift isn't.
              </Text>
            </View>
          )}
          <Pressable
            onPress={reset}
            accessibilityRole="button"
            className="mt-2 self-start rounded-md px-1 py-0.5 active:opacity-70"
          >
            <Text className="text-xs font-semibold text-accent">
              Reset and try again
            </Text>
          </Pressable>
        </View>
      ) : (
        <View className="mt-3 flex-row items-center gap-3">
          <Button
            title="Mark ready"
            icon="flag"
            size="sm"
            disabled={!allMet}
            onPress={() => setReadyWith(0)}
          />
          {!allMet ? (
            <Pressable
              onPress={() => setReadyWith(openCount)}
              accessibilityRole="button"
              className="rounded-md px-1 py-0.5 active:opacity-70"
            >
              <Text className="text-xs font-semibold text-muted underline">
                Override anyway
              </Text>
            </Pressable>
          ) : null}
        </View>
      )}
    </View>
  );
}
