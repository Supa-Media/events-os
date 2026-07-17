/**
 * One phase of the launch flow, rendered as a collapsible card. Collapsed, it
 * still earns its space: the header shows the phase's purpose plus a status chip
 * (e.g. "Draft · not live", "0 guests") so you can scan progress without opening
 * anything. Expanded, its body holds that phase's real controls. Only one phase
 * is open at a time (the parent owns that), which is what keeps the surface calm
 * instead of an eight-section wall.
 */
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { Icon } from "../../ui";
import { colors } from "../../../lib/theme";
import type { LaunchPhaseDef, PhaseStatusTone } from "./launchPhases";

export function PhaseSection({
  phase,
  status,
  open,
  onToggleOpen,
  children,
}: {
  phase: LaunchPhaseDef;
  status: { label: string; tone: PhaseStatusTone };
  open: boolean;
  onToggleOpen: () => void;
  children: ReactNode;
}) {
  const chip =
    status.tone === "good"
      ? { bg: colors.successBg, fg: colors.success }
      : status.tone === "phase"
        ? { bg: phase.hue.soft, fg: phase.hue.main }
        : { bg: colors.sunken, fg: colors.muted };

  return (
    <View
      className={`overflow-hidden rounded-2xl border bg-raised ${
        open ? "border-border-strong shadow-raised" : "border-border shadow-card"
      }`}
    >
      <Pressable
        onPress={onToggleOpen}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${phase.label} — ${phase.purpose}`}
        className="flex-row items-center gap-3 px-4 py-3.5 active:bg-sunken"
      >
        {/* Phase-hued rail */}
        <View
          className="w-1 self-stretch rounded-pill"
          style={{ backgroundColor: phase.hue.main }}
        />
        {/* Icon tile */}
        <View
          className="h-9 w-9 items-center justify-center rounded-xl"
          style={{ backgroundColor: phase.hue.soft }}
        >
          <Icon name={phase.icon} size={17} color={phase.hue.main} />
        </View>
        {/* Name + purpose */}
        <View className="min-w-0 flex-1">
          <Text className="text-base font-extrabold text-ink" numberOfLines={1}>
            {phase.label === "Design"
              ? "Design the page"
              : phase.label === "Publish"
                ? "Publish & share"
                : phase.label === "Grow"
                  ? "Grow the guest list"
                  : "Run the door"}
          </Text>
          <Text className="mt-0.5 text-xs text-muted" numberOfLines={1}>
            {phase.purpose}
          </Text>
        </View>
        {/* Status chip */}
        <View
          className="rounded-pill px-2.5 py-1"
          style={{ backgroundColor: chip.bg }}
        >
          <Text
            className="text-2xs font-bold"
            style={{ color: chip.fg }}
            numberOfLines={1}
          >
            {status.label}
          </Text>
        </View>
        <Icon
          name={open ? "chevron-down" : "chevron-right"}
          size={16}
          color={colors.faint}
        />
      </Pressable>

      {open ? (
        <View className="border-t border-border px-4 pb-5 pt-1">{children}</View>
      ) : null}
    </View>
  );
}
