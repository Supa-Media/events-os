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
import { Icon, Switch, type IconName } from "../../ui";
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
          // `accessibilityState` reaches the DOM as nothing on
          // react-native-web (see `ui/Checkbox`); `aria-expanded` is the prop
          // that survives.
          aria-expanded={open}
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
          // The card's title is the only thing that says WHICH feature this
          // switch turns on, and it lives in a sibling pressable — so it has
          // to be spelled out here or the switch announces anonymously.
          <Switch
            value={toggle.value}
            onValueChange={toggle.onToggle}
            accessibilityLabel={title}
          />
        ) : null}
        {/* A second, mouse-only affordance for the same expand target above.
            Out of the tab order and out of the tree so the card is one stop
            announcing once, not two identical ones. */}
        <Pressable
          onPress={onToggleOpen}
          tabIndex={-1}
          aria-hidden
          hitSlop={8}
          className="active:opacity-70"
        >
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
