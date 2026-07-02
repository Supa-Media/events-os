/**
 * The event anchor — a persistent, high-contrast banner naming the event's date
 * with a live countdown. Everything on this calendar is timed relative to this
 * one day, so it stays pinned above the grid (and tappable to jump to it) no
 * matter which month you're browsing.
 */
import { useState } from "react";
import { View, Text, Pressable } from "react-native";
import { eventCountdownLabel } from "@events-os/shared";
import { Icon } from "../../ui/Icon";
import { colors } from "../../../lib/theme";
import { MONTHS, WEEKDAYS_LONG } from "./config";

export function EventBanner({
  eventDate,
  daysAway,
  onPress,
}: {
  eventDate: number;
  daysAway: number;
  onPress: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const d = new Date(eventDate);

  return (
    <Pressable
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      className="mb-4 active:opacity-90"
    >
      <View
        className={`flex-row items-center gap-3 rounded-lg border border-accent px-4 py-3 ${
          hovered ? "bg-accent-soft/80" : "bg-accent-soft"
        }`}
      >
        <View className="h-10 w-10 items-center justify-center rounded-full bg-accent">
          <Icon name="flag" size={18} color={colors.raised} />
        </View>
        <View className="flex-1">
          <Text className="text-2xs font-bold uppercase tracking-wider text-accent">
            Event day
          </Text>
          <Text className="font-display text-base text-ink" numberOfLines={1}>
            {WEEKDAYS_LONG[d.getDay()]}, {MONTHS[d.getMonth()]} {d.getDate()}
          </Text>
        </View>
        <View className="rounded-pill bg-accent px-3 py-1">
          <Text className="text-2xs font-bold text-white">
            {eventCountdownLabel(daysAway)}
          </Text>
        </View>
        <Icon name="chevron-right" size={16} color={colors.accent} />
      </View>
    </Pressable>
  );
}
