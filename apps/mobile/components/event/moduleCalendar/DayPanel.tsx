/**
 * The right-hand (or stacked) detail for the selected day: a date header with an
 * add button, then the day's items rendered by the caller's `renderItem` (so the
 * panel stays module-agnostic), or a calm empty state that offers to add one.
 */
import type { ReactNode } from "react";
import { View, Text } from "react-native";
import { Button, EmptyState } from "../../ui";
import { Icon } from "../../ui/Icon";
import { colors } from "../../../lib/theme";
import { MONTHS, WEEKDAYS_LONG, type ScheduleItem } from "./config";

export function DayPanel({
  day,
  isToday,
  isEventDay,
  items,
  itemNoun,
  onAdd,
  renderItem,
}: {
  day: number;
  isToday: boolean;
  isEventDay: boolean;
  items: ScheduleItem[];
  itemNoun: string;
  onAdd: () => void;
  renderItem: (item: ScheduleItem) => ReactNode;
}) {
  const d = new Date(day);
  const eyebrow = isEventDay
    ? "Event day"
    : isToday
      ? "Today"
      : WEEKDAYS_LONG[d.getDay()];

  return (
    <View>
      <View className="mb-3 flex-row items-center gap-2 px-1">
        <View className="flex-1">
          <View className="flex-row items-center gap-1.5">
            <Text className="text-2xs font-bold uppercase tracking-wider text-accent">
              {eyebrow}
            </Text>
            {isEventDay ? <Icon name="flag" size={12} color={colors.accent} /> : null}
          </View>
          <Text className="font-display text-xl text-ink">
            {MONTHS[d.getMonth()]} {d.getDate()}
          </Text>
        </View>
        <Button
          title={`Add ${itemNoun}`}
          icon="plus"
          size="sm"
          variant="secondary"
          onPress={onAdd}
        />
      </View>

      {items.length === 0 ? (
        <EmptyState
          icon="send"
          title={`No ${itemNoun}s this day`}
          message={`Nothing lands on this date. Tap another day, or add a ${itemNoun}.`}
          action={
            <Button
              title={`Add a ${itemNoun}`}
              icon="plus"
              variant="secondary"
              onPress={onAdd}
            />
          }
        />
      ) : (
        <View className="gap-2.5">{items.map(renderItem)}</View>
      )}
    </View>
  );
}
