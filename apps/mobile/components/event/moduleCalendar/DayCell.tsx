/**
 * A single day in the month grid. Renders each item that lands on this day as a
 * status-toned chip; when the module has a badge field (comms channels) the chip
 * leads with a logo cluster, otherwise a status dot. The EVENT's own day carries
 * an unmistakable "EVENT" marker, and a hover "+" (web) drops an item onto it.
 */
import { useState } from "react";
import { View, Text, Pressable } from "react-native";
import { Icon } from "../../ui/Icon";
import { colors } from "../../../lib/theme";
import { optionColor } from "../../../lib/optionColor";
import { asArray, type ScheduleItem, type SelectOption } from "./config";
import { ChannelCluster } from "./badges";

export function DayCell({
  day,
  inMonth,
  isToday,
  isSelected,
  isEventDay,
  isPast,
  items,
  badgeField,
  badgeMap,
  statusMap,
  compact,
  onPress,
  onAdd,
}: {
  day: number;
  inMonth: boolean;
  isToday: boolean;
  isSelected: boolean;
  isEventDay: boolean;
  isPast: boolean;
  items: ScheduleItem[];
  badgeField: string | null;
  badgeMap?: Map<string, SelectOption>;
  statusMap: Map<string, SelectOption>;
  compact: boolean;
  onPress: () => void;
  onAdd: () => void;
}) {
  const [hovered, setHovered] = useState(false);

  // The event day gets a solid brand wash so the schedule reads relative to it;
  // otherwise the selected day fills and hover hints interactivity.
  const cellBg = isEventDay
    ? "bg-accent-soft"
    : isSelected
      ? "bg-accent-soft/70"
      : hovered
        ? "bg-sunken"
        : "";

  const badgesOf = (item: ScheduleItem): string[] =>
    badgeField ? asArray(item.fields?.[badgeField]) : [];

  const MAX_CHIPS = compact ? 0 : 3;
  const shown = items.slice(0, MAX_CHIPS);
  const overflow = items.length - shown.length;

  // Compact (phone): a strip of the unique badge logos used that day.
  const compactBadges =
    compact && badgeField && badgeMap
      ? Array.from(new Set(items.flatMap(badgesOf)))
      : [];

  return (
    <Pressable
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={{ width: `${100 / 7}%`, minHeight: compact ? 58 : 112 }}
      className={`border-b border-r border-border px-1.5 py-1.5 ${cellBg}`}
    >
      {/* Date number — today is a filled brand pip; the event day flies a flag. */}
      <View className="mb-1 flex-row items-center justify-between">
        {isToday ? (
          <View className="h-6 w-6 items-center justify-center rounded-full bg-accent">
            <Text className="text-xs font-bold text-white">{day}</Text>
          </View>
        ) : (
          <View className="flex-row items-center gap-1">
            <Text
              className={`px-1 text-xs font-semibold ${
                !inMonth
                  ? "text-faint"
                  : isEventDay
                    ? "text-accent"
                    : isPast
                      ? "text-muted"
                      : "text-ink"
              }`}
            >
              {day}
            </Text>
            {isEventDay ? <Icon name="flag" size={11} color={colors.accent} /> : null}
          </View>
        )}
        {compact && items.length > 0 ? (
          <View className="h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1">
            <Text className="text-2xs font-bold text-white">{items.length}</Text>
          </View>
        ) : null}
        {/* Web: a quick "+" to drop an item onto this exact day, on hover. */}
        {!compact && hovered ? (
          <Pressable
            onPress={(e) => {
              e.stopPropagation?.();
              onAdd();
            }}
            hitSlop={6}
            className="h-5 w-5 items-center justify-center rounded-full bg-accent active:opacity-80"
          >
            <Icon name="plus" size={12} color={colors.raised} />
          </Pressable>
        ) : null}
      </View>

      {compact ? (
        compactBadges.length > 0 && badgeMap ? (
          <ChannelCluster
            channels={compactBadges}
            channelMap={badgeMap}
            size={16}
            max={4}
            ring={colors.raised}
          />
        ) : null
      ) : (
        <View className="gap-1">
          {/* The event itself — an unmistakable solid marker above the items. */}
          {isEventDay ? (
            <View className="flex-row items-center gap-1 self-start rounded bg-accent px-1.5 py-0.5">
              <Icon name="flag" size={9} color={colors.raised} />
              <Text className="text-2xs font-bold text-white">EVENT</Text>
            </View>
          ) : null}
          {shown.map((item) => {
            const st = optionColor(statusMap.get(item.status ?? "")?.color);
            const badges = badgesOf(item);
            return (
              <View
                key={item._id}
                className={`flex-row items-center gap-1.5 rounded px-1 py-0.5 ${
                  isPast ? "opacity-60" : ""
                }`}
                style={{ backgroundColor: st.bg }}
              >
                {badges.length > 0 && badgeMap ? (
                  <ChannelCluster
                    channels={badges}
                    channelMap={badgeMap}
                    size={15}
                    max={3}
                    ring={st.bg}
                  />
                ) : (
                  <View
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ backgroundColor: st.text }}
                  />
                )}
                <Text
                  className="flex-1 text-2xs font-semibold"
                  style={{ color: st.text }}
                  numberOfLines={1}
                >
                  {item.title || "Untitled"}
                </Text>
              </View>
            );
          })}
          {overflow > 0 ? (
            <Text className="pl-1 text-2xs font-semibold text-muted">
              +{overflow} more
            </Text>
          ) : null}
        </View>
      )}
    </Pressable>
  );
}
