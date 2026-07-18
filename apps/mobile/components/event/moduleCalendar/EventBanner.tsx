/**
 * The event anchor — a compact, tappable chip naming the event's date with a
 * live countdown. Everything on this calendar is timed relative to this one day,
 * so the chip sits in the month-nav row (and jumps to the day on tap) no matter
 * which month you're browsing. Deliberately quiet: a small accent flag marks it
 * as THE event day, while the grid carries the louder day-of highlight.
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
      className={`flex-row items-center gap-2 rounded-pill border border-accent/40 px-3 py-1.5 active:opacity-80 ${
        hovered ? "bg-accent-soft/80" : "bg-accent-soft"
      }`}
    >
      <Icon name="flag-solid" size={13} color={colors.accent} />
      <Text className="text-xs font-bold text-accent" numberOfLines={1}>
        {WEEKDAYS_LONG[d.getDay()].slice(0, 3)}, {MONTHS[d.getMonth()].slice(0, 3)}{" "}
        {d.getDate()}
      </Text>
      <View className="h-3 w-px bg-accent/25" />
      <Text className="text-2xs font-semibold text-muted" numberOfLines={1}>
        {eventCountdownLabel(daysAway)}
      </Text>
    </Pressable>
  );
}
