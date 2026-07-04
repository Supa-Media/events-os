import { useRef, useState } from "react";
import { View, Text, Pressable, ScrollView, Platform } from "react-native";
import {
  Icon,
  ContextMenu,
  measureAnchor,
  type ContextMenuAnchor,
} from "../ui";
import type { ResolvedModule } from "@events-os/shared";
import { colors } from "../../lib/theme";
import { AddCustomModuleInput } from "./EventModuleRollup";

export type EventTab = {
  key: string;
  label: string;
  /**
   * When present, right-click (web) / long-press (native) on the tab offers to
   * disable a core module or remove a custom one — module management lives on
   * the tab itself, so the Overview no longer needs a separate Modules list.
   */
  remove?: { isCore: boolean; onRemove: () => void };
};

export type AddModuleConfig = {
  /** Core modules currently disabled — each re-enables on press. */
  disabledCore: ResolvedModule[];
  onEnableCore: (key: string) => void;
  onCreateCustom: (label: string) => void;
};

/**
 * Horizontal, scrollable tab bar — Overview, each active module, and Crew. Same
 * component on web and mobile; on a phone it scrolls sideways instead of
 * wrapping so the planning surfaces stay one tap apart. A trailing "＋" adds a
 * module (re-enable a core one, or create a custom one) right where the tabs
 * live, and each module tab can be removed from its own context menu.
 */
export function EventTabBar({
  tabs,
  activeKey,
  onSelect,
  addModule,
}: {
  tabs: EventTab[];
  activeKey: string;
  onSelect: (key: string) => void;
  addModule?: AddModuleConfig;
}) {
  return (
    <View className="mb-6 border-b border-border">
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 4, alignItems: "center" }}
      >
        {tabs.map((t) => (
          <TabButton
            key={t.key}
            tab={t}
            active={t.key === activeKey}
            onSelect={() => onSelect(t.key)}
          />
        ))}
        {addModule ? <AddModuleTab config={addModule} /> : null}
      </ScrollView>
    </View>
  );
}

/** One tab; owns its own remove context menu when the tab is a removable module. */
function TabButton({
  tab,
  active,
  onSelect,
}: {
  tab: EventTab;
  active: boolean;
  onSelect: () => void;
}) {
  const ref = useRef<any>(null);
  const [anchor, setAnchor] = useState<ContextMenuAnchor | undefined>(undefined);

  const openMenu = () => {
    if (tab.remove) measureAnchor(ref.current, setAnchor);
  };

  // Web right-click opens the menu; native long-press is the fallback.
  const webProps =
    tab.remove && Platform.OS === "web"
      ? ({
          onContextMenu: (e: any) => {
            e?.preventDefault?.();
            openMenu();
          },
        } as any)
      : {};

  return (
    <View ref={ref} {...webProps}>
      <Pressable
        onPress={onSelect}
        onLongPress={tab.remove ? openMenu : undefined}
        delayLongPress={300}
        className={`border-b-2 px-3 py-2.5 ${
          active ? "border-accent" : "border-transparent"
        } active:opacity-80`}
      >
        <Text
          className={`text-sm ${
            active ? "font-semibold text-accent" : "text-muted"
          }`}
        >
          {tab.label}
        </Text>
      </Pressable>

      {tab.remove ? (
        <ContextMenu
          anchor={anchor}
          onClose={() => setAnchor(undefined)}
          actions={[
            {
              label: tab.remove.isCore ? "Disable module" : "Remove module",
              icon: tab.remove.isCore ? "slash" : "trash-2",
              destructive: !tab.remove.isCore,
              onPress: tab.remove.onRemove,
            },
          ]}
        />
      ) : null}
    </View>
  );
}

/** Trailing "＋" that adds a module — re-enable a core one or name a new custom one. */
function AddModuleTab({ config }: { config: AddModuleConfig }) {
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
        accessibilityLabel="Add module"
        className="flex-row items-center gap-1 rounded-pill border border-dashed border-border-strong px-2.5 py-1 active:opacity-80 web:hover:border-accent"
      >
        <Icon name="plus" size={13} color={colors.muted} />
        <Text className="text-xs font-medium text-muted">Module</Text>
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
            label: "New custom module",
            icon: "edit-2" as const,
            onPress: () => setAdding(true),
          },
        ]}
      />
    </View>
  );
}
