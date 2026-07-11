import { useState } from "react";
import { View, Text, Pressable } from "react-native";
import { Icon, Badge } from "../ui";
import { DemoRow } from "./DemoRow";
import { colors } from "../../lib/theme";

const LINKS = [
  "Row owner",
  "Row's role",
  "Role's person",
  "Area owner",
  "Event owner",
];

// The link the toggle unassigns (the role's person).
const BREAK_AT = 2;

/**
 * The accountability chain, rendered as connected chips with one link you can
 * break: unassign the role's person and watch the row below go Unowned — the
 * "unowned work silently fails" lesson, hands-on. Local state only.
 */
export function TryChain() {
  const [broken, setBroken] = useState(false);

  return (
    <View>
      {/* The chain */}
      <View className="flex-row flex-wrap items-center gap-1.5">
        {LINKS.map((label, i) => {
          const isBroken = broken && i === BREAK_AT;
          return (
            <View key={label} className="flex-row items-center gap-1.5">
              {i > 0 ? (
                <Icon
                  name="chevron-right"
                  size={13}
                  color={broken && i === BREAK_AT ? colors.danger : colors.faint}
                />
              ) : null}
              <View
                className={`rounded-pill border px-2.5 py-1 ${
                  isBroken
                    ? "border-dashed border-border-strong bg-surface"
                    : "border-border bg-sunken"
                }`}
              >
                <Text
                  className={`text-xs font-semibold ${
                    isBroken ? "text-faint line-through" : "text-ink"
                  }`}
                >
                  {isBroken ? "nobody" : label}
                </Text>
              </View>
            </View>
          );
        })}
      </View>

      {/* The row the chain resolves (or fails to) */}
      <DemoRow title="Book porta-potty vendor" className="mt-3">
        {broken ? (
          <Badge label="Unowned" tone="danger" icon="alert-circle" />
        ) : (
          <Badge label="Jordan · Logistics Lead" tone="success" />
        )}
      </DemoRow>

      {/* Toggle */}
      <Pressable
        onPress={() => setBroken((b) => !b)}
        accessibilityRole="button"
        className="mt-2.5 flex-row items-center gap-1.5 self-start rounded-md border border-border px-2.5 py-1.5 active:bg-sunken web:hover:bg-sunken"
      >
        <Icon
          name={broken ? "user-plus" : "user-x"}
          size={13}
          color={colors.muted}
        />
        <Text className="text-xs font-semibold text-muted">
          {broken ? "Reassign the role" : "Unassign the role"}
        </Text>
      </Pressable>

      {broken ? (
        <Text className="mt-2 text-xs leading-4 text-danger">
          Nobody decided to drop this row — it just stopped having a human.
          Unowned work silently fails; that's why "zero unowned rows by T-10"
          is a hard rule.
        </Text>
      ) : (
        <Text className="mt-2 text-xs text-faint">
          Every row resolves to a human down this chain. Try unassigning the
          role.
        </Text>
      )}
    </View>
  );
}
