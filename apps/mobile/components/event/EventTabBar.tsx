import { useRef, useState } from "react";
import { View, Text, Pressable, ScrollView, Platform } from "react-native";
import { ContextMenu, MiniRing, measureAnchor, type ContextMenuAnchor } from "../ui";
import type { PhaseKey } from "@events-os/shared";
import { colors, phaseColors } from "../../lib/theme";
import { AddModuleTab, type AddModuleConfig } from "./EventAddModuleTab";

type PhaseHue = (typeof phaseColors)[PhaseKey];

export type { AddModuleConfig };

export type EventTab = {
  key: string;
  label: string;
  /**
   * When present, right-click (web) / long-press (native) on the tab offers to
   * disable a core module or remove a custom one — module management lives on
   * the tab itself, so the Overview no longer needs a separate Modules list.
   */
  remove?: { isCore: boolean; onRemove: () => void };
  /**
   * Which readiness ring this tab feeds. The tab wears the phase's identity
   * hue (mini ring, active underline, label) so it visibly belongs to the
   * header ring of the same color.
   */
  phase?: PhaseKey;
  /** 0..1 module progress shown as a mini ring; null/undefined hides it. */
  progress?: number | null;
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
  highlightPhase,
  trailing,
}: {
  tabs: EventTab[];
  activeKey: string;
  onSelect: (key: string) => void;
  addModule?: AddModuleConfig;
  /**
   * Set (briefly) when a header phase ring is tapped — every tab feeding that
   * phase pulses in its hue, making the ring↔tab link explicit.
   */
  highlightPhase?: PhaseKey | null;
  /**
   * Right-aligned tools pinned to the tab rail (Day-of / Me view / ⋯). Tabs
   * are NAVIGATION and tools are ACTIONS, but they share the one rail so the
   * header above stays pure event vitals. The tab strip scrolls under the
   * pinned tools on narrow screens.
   */
  trailing?: React.ReactNode;
}) {
  return (
    <View className="mb-6 border-b border-border">
      <View className="flex-row items-center gap-3">
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ flexGrow: 1, flexShrink: 1 }}
          contentContainerStyle={{ gap: 4, alignItems: "center" }}
        >
          {tabs.map((t) => (
            <TabButton
              key={t.key}
              tab={t}
              active={t.key === activeKey}
              highlighted={t.phase != null && t.phase === highlightPhase}
              onSelect={() => onSelect(t.key)}
            />
          ))}
          {addModule ? <AddModuleTab config={addModule} /> : null}
        </ScrollView>
        {trailing ? (
          <View className="flex-row items-center gap-1.5 pb-1.5">{trailing}</View>
        ) : null}
      </View>
    </View>
  );
}

/** Ring-tap pulse: a hue wash plus (web) two quick scale beats. */
function pulseStyle(hue: PhaseHue): any {
  const base = {
    backgroundColor: hue.soft,
    borderTopLeftRadius: 8,
    borderTopRightRadius: 8,
  };
  if (Platform.OS !== "web") return base;
  return {
    ...base,
    animationKeyframes: {
      "0%": { transform: [{ scale: 1 }] },
      "50%": { transform: [{ scale: 1.08 }] },
      "100%": { transform: [{ scale: 1 }] },
    },
    animationDuration: "550ms",
    animationIterationCount: 2,
    animationTimingFunction: "ease-in-out",
  };
}

/** The tab's lineage marker: a filled mini ring, or a dim dot pre-measurement. */
function TabPhaseIndicator({ hue, pct }: { hue: PhaseHue; pct: number | null }) {
  if (pct != null) return <MiniRing value={pct} size={13} color={hue.main} />;
  return (
    <View
      style={{
        width: 6,
        height: 6,
        borderRadius: 3,
        backgroundColor: hue.main,
        opacity: 0.4,
      }}
    />
  );
}

/** One tab; owns its own remove context menu when the tab is a removable module. */
function TabButton({
  tab,
  active,
  highlighted,
  onSelect,
}: {
  tab: EventTab;
  active: boolean;
  highlighted: boolean;
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

  const hue = tab.phase ? phaseColors[tab.phase] : null;
  const pct = tab.progress == null ? null : Math.round(Math.min(1, tab.progress) * 100);
  // Phase tabs underline + label in their hue; phase-less tabs keep accent.
  const activeColor = hue?.main ?? colors.accent;

  return (
    <View ref={ref} {...webProps} style={highlighted && hue ? pulseStyle(hue) : null}>
      <Pressable
        onPress={onSelect}
        onLongPress={tab.remove ? openMenu : undefined}
        delayLongPress={300}
        className="border-b-2 border-transparent px-3 py-2.5 active:opacity-80"
        style={active ? { borderBottomColor: activeColor } : undefined}
      >
        <View className="flex-row items-center gap-1.5">
          {hue ? <TabPhaseIndicator hue={hue} pct={pct} /> : null}
          <Text
            className={`text-sm ${active ? "font-semibold" : "text-muted"}`}
            style={active ? { color: activeColor } : undefined}
          >
            {tab.label}
          </Text>
        </View>
      </Pressable>

      {tab.remove ? (
        <ContextMenu
          anchor={anchor}
          onClose={() => setAnchor(undefined)}
          actions={[
            {
              label: tab.remove.isCore ? "Disable area" : "Remove area",
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
