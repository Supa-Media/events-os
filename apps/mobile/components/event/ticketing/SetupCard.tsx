/**
 * One collapsible row in the Design phase's setup checklist. Collapsed, it shows
 * an icon, a name, and a status chip (its filled/empty state) so the phase reads
 * as a short checklist rather than a wall of inputs. Optional-feature cards
 * (tickets, giving) carry a switch in the header that both enables the feature
 * and reveals its controls. Only one card is open at a time (owned by the
 * parent). The header switch sits outside the expand target, so tapping it
 * toggles the feature without also collapsing the card.
 */
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { Icon, type IconName } from "../../ui";
import { colors, phaseColors } from "../../../lib/theme";

export type SetupStatusTone = "done" | "opt" | "off";

const DESIGN_HUE = phaseColors.prePlan; // Design phase amber

function StatusChip({
  label,
  tone,
}: {
  label: string;
  tone: SetupStatusTone;
}) {
  const c =
    tone === "done"
      ? { bg: colors.successBg, fg: colors.success }
      : { bg: colors.sunken, fg: tone === "off" ? colors.faint : colors.muted };
  return (
    <View className="rounded-pill px-2.5 py-1" style={{ backgroundColor: c.bg }}>
      <Text className="text-2xs font-bold" style={{ color: c.fg }}>
        {label}
      </Text>
    </View>
  );
}

/** The bare header switch for opt-in feature cards (tickets, giving). */
function HeaderSwitch({
  value,
  onToggle,
}: {
  value: boolean;
  onToggle: (next: boolean) => void;
}) {
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      onPress={() => onToggle(!value)}
      className="active:opacity-80"
    >
      <View
        className={`h-6 w-10 justify-center rounded-pill px-0.5 ${
          value ? "bg-accent" : "bg-border-strong"
        }`}
      >
        <View
          className={`h-5 w-5 rounded-pill bg-white ${value ? "self-end" : "self-start"}`}
        />
      </View>
    </Pressable>
  );
}

export function SetupCard({
  icon,
  title,
  status,
  open,
  onToggleOpen,
  toggle,
  children,
}: {
  icon: IconName;
  title: string;
  status: { label: string; tone: SetupStatusTone };
  open: boolean;
  onToggleOpen: () => void;
  /** Present on opt-in feature cards — a switch shown in the header. */
  toggle?: { value: boolean; onToggle: (next: boolean) => void };
  children: ReactNode;
}) {
  return (
    <View
      // The open card floats above the cards below it so an overflowing child
      // (e.g. the location autocomplete dropdown) overlays them instead of
      // rendering behind. Only one card is open at a time, so this is safe.
      style={{ position: "relative", zIndex: open ? 20 : undefined }}
      className={`rounded-xl border bg-raised ${
        open
          ? "border-border-strong shadow-card"
          : "overflow-hidden border-border"
      }`}
    >
      <View className="flex-row items-center gap-3 px-3.5 py-3">
        {/* The expand target — everything except the switch/chevron. */}
        <Pressable
          onPress={onToggleOpen}
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          accessibilityLabel={title}
          className="min-w-0 flex-1 flex-row items-center gap-3 active:opacity-80"
        >
          <View
            className="h-7 w-7 items-center justify-center rounded-lg"
            style={{ backgroundColor: DESIGN_HUE.soft }}
          >
            <Icon name={icon} size={14} color={DESIGN_HUE.main} />
          </View>
          <Text
            className="min-w-0 flex-1 text-sm font-bold text-ink"
            numberOfLines={1}
          >
            {title}
          </Text>
          <StatusChip label={status.label} tone={status.tone} />
        </Pressable>
        {toggle ? (
          <HeaderSwitch value={toggle.value} onToggle={toggle.onToggle} />
        ) : null}
        <Pressable onPress={onToggleOpen} hitSlop={8} className="active:opacity-70">
          <Icon
            name={open ? "chevron-down" : "chevron-right"}
            size={15}
            color={colors.faint}
          />
        </Pressable>
      </View>

      {open ? (
        <View className="border-t border-border px-3.5 pb-4 pt-3">{children}</View>
      ) : null}
    </View>
  );
}
