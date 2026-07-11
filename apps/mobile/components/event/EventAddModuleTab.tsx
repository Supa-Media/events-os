import { useRef, useState } from "react";
import { View, Text, Pressable } from "react-native";
import {
  Icon,
  ContextMenu,
  measureAnchor,
  type ContextMenuAnchor,
} from "../ui";
import type { ResolvedModule } from "@events-os/shared";
import { colors } from "../../lib/theme";
import { AddCustomModuleInput } from "./EventModuleRollup";

export type AddModuleConfig = {
  /** Core modules currently disabled — each re-enables on press. */
  disabledCore: ResolvedModule[];
  onEnableCore: (key: string) => void;
  onCreateCustom: (label: string) => void;
};

/** Trailing "＋" that adds a module — re-enable a core one or name a new custom one. */
export function AddModuleTab({ config }: { config: AddModuleConfig }) {
  const ref = useRef<any>(null);
  const [anchor, setAnchor] = useState<ContextMenuAnchor | undefined>(undefined);
  const [adding, setAdding] = useState(false);

  if (adding) {
    return (
      <View className="pl-1 pr-2">
        <AddCustomModuleInput
          onCommit={(label) => {
            const trimmed = label.trim();
            if (trimmed) config.onCreateCustom(trimmed);
            setAdding(false);
          }}
          onCancel={() => setAdding(false)}
        />
      </View>
    );
  }

  return (
    <View ref={ref} className="pl-1 pr-2">
      <Pressable
        onPress={() => measureAnchor(ref.current, setAnchor)}
        accessibilityRole="button"
        accessibilityLabel="Add area"
        className="flex-row items-center gap-1 rounded-pill border border-dashed border-border-strong px-2.5 py-1 active:opacity-80 web:hover:border-accent"
      >
        <Icon name="plus" size={13} color={colors.muted} />
        <Text className="text-xs font-medium text-muted">Area</Text>
      </Pressable>

      <ContextMenu
        anchor={anchor}
        onClose={() => setAnchor(undefined)}
        actions={[
          ...config.disabledCore.map((m) => ({
            label: m.label,
            icon: "plus" as const,
            onPress: () => config.onEnableCore(m.key),
          })),
          {
            label: "New custom area",
            icon: "edit-2" as const,
            onPress: () => setAdding(true),
          },
        ]}
      />
    </View>
  );
}
