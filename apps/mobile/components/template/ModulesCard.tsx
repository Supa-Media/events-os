import { View, Text } from "react-native";
import {
  MODULE_LABELS,
  CORE_MODULE_KEYS,
  type ModuleKey,
} from "@events-os/shared";
import { Card, Pill, SectionHeader } from "../ui";

/* ── Modules ───────────────────────────────────────────────────────────── */

export function ModulesCard({
  activeComponents,
  onToggle,
}: {
  activeComponents: string[];
  onToggle: (module: string) => void;
}) {
  return (
    <Card className="mb-2">
      <SectionHeader title="Modules" />
      <ModuleGroup
        heading="Core"
        keys={CORE_MODULE_KEYS}
        activeComponents={activeComponents}
        onToggle={onToggle}
      />
      {/* Custom modules (author-created, full grid) arrive in a later phase. */}
    </Card>
  );
}

function ModuleGroup({
  heading,
  keys,
  activeComponents,
  onToggle,
}: {
  heading: string;
  keys: ModuleKey[];
  activeComponents: string[];
  onToggle: (module: string) => void;
}) {
  return (
    <View>
      <Text className="mb-2 text-2xs font-bold uppercase tracking-wider text-faint">{heading}</Text>
      <View className="flex-row flex-wrap gap-2">
        {keys.map((c) => (
          <Pill
            key={c}
            label={MODULE_LABELS[c]}
            selected={activeComponents.includes(c)}
            onPress={() => onToggle(c)}
          />
        ))}
      </View>
    </View>
  );
}
