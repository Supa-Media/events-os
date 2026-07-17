import { View, Text, Pressable } from "react-native";
import { Avatar, Icon, MiniRing } from "../ui";
import { AddModuleTab, type AddModuleConfig } from "./EventAddModuleTab";
import { colors, phaseColors } from "../../lib/theme";
import type { PhaseKey } from "@events-os/shared";

/**
 * One row in the vertical plan — the drill-in successor to a horizontal tab.
 * Everything the old tab could only hint at (phase, progress, owner, overdue)
 * reads at a glance here, and every section is visible at once with no
 * sideways scrolling.
 */
export type PlanSection = {
  key: string;
  label: string;
  /** Which readiness phase this section feeds (drives its hue). */
  phase?: PhaseKey;
  /** 0..1 completion; null when the section has nothing measurable yet. */
  progress?: number | null;
  done?: number;
  total?: number;
  hasStatus?: boolean;
  /** Marked ready by its owner — counts as a green "Ready", overriding progress. */
  ready?: boolean;
  /** Resolved owner's name (for the avatar); null when unassigned. */
  ownerName?: string | null;
  /** Soonest due date sits in the past and work remains — a quiet red flag. */
  overdue?: boolean;
};

/**
 * "The plan" — the event's sections as a scannable vertical list that replaces
 * the horizontally-scrolling tab rail. Tapping a row drills into that section;
 * the pinned tools (Day-of / Me view / ⋯) and the add-section control ride
 * above the list so navigation reads top-to-bottom on a phone.
 */
export function PlanSections({
  sections,
  activeKey,
  onSelect,
  tools,
  addModule,
}: {
  sections: PlanSection[];
  activeKey?: string;
  onSelect: (key: string) => void;
  /** The operational tools row (EventTools) — Day-of, Me view, ⋯. */
  tools?: React.ReactNode;
  /** Re-enable a core area or create a custom one (hidden in Me view). */
  addModule?: AddModuleConfig;
}) {
  return (
    <View className="mb-6">
      {tools ? (
        <View className="mb-4 flex-row flex-wrap items-center gap-2">{tools}</View>
      ) : null}

      <View className="mb-2.5 flex-row items-baseline gap-2">
        <Text className="font-display text-lg text-ink">The plan</Text>
        <Text className="ml-auto text-xs text-faint">
          {sections.length} {sections.length === 1 ? "section" : "sections"}
        </Text>
      </View>

      <View className="gap-2">
        {sections.map((s) => (
          <PlanRow
            key={s.key}
            section={s}
            active={s.key === activeKey}
            onPress={() => onSelect(s.key)}
          />
        ))}
        {addModule ? (
          <View className="mt-0.5 flex-row">
            <AddModuleTab config={addModule} />
          </View>
        ) : null}
      </View>
    </View>
  );
}

function PlanRow({
  section,
  active,
  onPress,
}: {
  section: PlanSection;
  active: boolean;
  onPress: () => void;
}) {
  const hue = section.phase ? phaseColors[section.phase] : null;
  const tint = hue?.main ?? colors.muted;
  const pct =
    section.ready
      ? 100
      : section.progress != null
        ? Math.round(Math.min(1, Math.max(0, section.progress)) * 100)
        : null;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Open ${section.label}`}
      className={`flex-row items-center gap-3 rounded-2xl border bg-raised px-3.5 py-3 active:opacity-90 ${
        active ? "border-border-strong" : "border-border"
      }`}
    >
      {/* Left indicator — the phase-hued mini ring, or a dim phase dot. */}
      <View className="h-10 w-10 items-center justify-center rounded-xl bg-sunken">
        {pct != null ? (
          <MiniRing value={pct} size={26} color={tint} />
        ) : (
          <View
            style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: tint, opacity: 0.45 }}
          />
        )}
      </View>

      {/* Body — name + a sub line of owner / progress / status. */}
      <View className="min-w-0 flex-1">
        <Text className="text-base font-bold text-ink" numberOfLines={1}>
          {section.label}
        </Text>
        <View className="mt-0.5 flex-row flex-wrap items-center gap-x-2 gap-y-0.5">
          {section.ownerName ? (
            <Avatar name={section.ownerName} size={16} />
          ) : null}
          {section.ready ? (
            <Badge tone="ready">Ready</Badge>
          ) : section.hasStatus && (section.total ?? 0) > 0 ? (
            <Text className="text-xs font-semibold text-ink">
              {section.done ?? 0}/{section.total ?? 0}
            </Text>
          ) : (
            <Badge tone="idle">Not started</Badge>
          )}
          {section.overdue && !section.ready ? (
            <View className="flex-row items-center gap-1">
              <Icon name="alert-triangle" size={11} color={colors.accent} />
              <Text className="text-xs font-bold text-accent">Overdue</Text>
            </View>
          ) : null}
        </View>
      </View>

      {/* Right — % + a slim progress track, then the chevron. */}
      {pct != null ? (
        <View className="items-end gap-1.5">
          <Text className="text-sm font-extrabold text-ink">{pct}%</Text>
          <View
            style={{
              width: 46,
              height: 5,
              borderRadius: 999,
              backgroundColor: colors.border,
              overflow: "hidden",
            }}
          >
            <View
              style={{
                height: "100%",
                width: `${Math.max(pct, 2)}%`,
                borderRadius: 999,
                backgroundColor: section.ready ? colors.success : tint,
              }}
            />
          </View>
        </View>
      ) : null}
      <Icon name="chevron-right" size={16} color={colors.faint} />
    </Pressable>
  );
}

function Badge({ tone, children }: { tone: "ready" | "idle"; children: string }) {
  const ready = tone === "ready";
  return (
    <View
      className="rounded-pill px-2 py-0.5"
      style={{ backgroundColor: ready ? colors.successBg : colors.sunken }}
    >
      <Text
        className="text-2xs font-extrabold"
        style={{ color: ready ? colors.success : colors.faint }}
      >
        {children}
      </Text>
    </View>
  );
}
