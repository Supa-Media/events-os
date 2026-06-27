/**
 * Calendar — the shared month-grid day picker.
 *
 * One source of truth for the app's calendar UI: the DUE-date cell, the event
 * schedule picker, and anywhere else that needs to choose a day all compose this
 * so the look (Corben month header, brand-red selected day, faint adjacent days)
 * stays identical and is changed in exactly one place. Callers layer their own
 * chrome around it — an offset footer, a time column, etc. — via `footer`.
 *
 * Pure presentation: it owns only the visible month; the selected value and the
 * commit live with the caller.
 */
import { useMemo, useState, type ReactNode } from "react";
import { View, Text, Pressable } from "react-native";
import { startOfDay } from "@events-os/shared";
import { colors } from "../../lib/theme";
import { Icon } from "./Icon";

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function Calendar({
  selected,
  onSelect,
  seed,
  footer,
  onHoverDay,
}: {
  /** Currently-selected day (ms), or null. */
  selected: number | null;
  /** Picked a day — receives that day at local midnight. */
  onSelect: (ms: number) => void;
  /** Month to open on when nothing is selected (defaults to today). */
  seed?: number;
  /** Optional content rendered beneath the grid (offset preview, actions…). */
  footer?: ReactNode;
  /** Hovered day (ms) or null on leave — lets a footer preview that day. */
  onHoverDay?: (ms: number | null) => void;
}) {
  const selectedDay = selected != null ? startOfDay(selected) : null;
  const today = startOfDay(Date.now());

  const init = new Date(selected ?? seed ?? Date.now());
  const [view, setView] = useState({ year: init.getFullYear(), month: init.getMonth() });

  // 6 weeks × 7 days, starting on the Sunday on/before the 1st.
  const days = useMemo(() => {
    const first = new Date(view.year, view.month, 1);
    const gridStart = new Date(view.year, view.month, 1 - first.getDay());
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
      return { ms: d.getTime(), day: d.getDate(), inMonth: d.getMonth() === view.month };
    });
  }, [view]);

  const step = (delta: number) => {
    const m = view.month + delta;
    setView({ year: view.year + Math.floor(m / 12), month: ((m % 12) + 12) % 12 });
  };

  return (
    <View className="p-3">
      {/* Month nav */}
      <View className="mb-2 flex-row items-center justify-between">
        <NavButton icon="chevron-left" onPress={() => step(-1)} />
        <Text className="font-display text-base text-ink">
          {MONTHS[view.month]} {view.year}
        </Text>
        <NavButton icon="chevron-right" onPress={() => step(1)} />
      </View>

      {/* Weekday header */}
      <View className="mb-1 flex-row">
        {WEEKDAYS.map((w, i) => (
          <View key={i} className="flex-1 items-center py-1">
            <Text className="text-2xs font-semibold uppercase tracking-wide text-faint">
              {w}
            </Text>
          </View>
        ))}
      </View>

      {/* Day grid */}
      <View className="flex-row flex-wrap">
        {days.map((d) => (
          <DayCell
            key={d.ms}
            day={d.day}
            inMonth={d.inMonth}
            isSelected={selectedDay === d.ms}
            isToday={today === d.ms}
            onPress={() => onSelect(d.ms)}
            onHoverIn={() => onHoverDay?.(d.ms)}
            onHoverOut={() => onHoverDay?.(null)}
          />
        ))}
      </View>

      {footer}
    </View>
  );
}

function NavButton({
  icon,
  onPress,
}: {
  icon: "chevron-left" | "chevron-right";
  onPress: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      hitSlop={6}
      className={`rounded-md p-1.5 ${hovered ? "bg-sunken" : ""}`}
    >
      <Icon name={icon} size={16} color={colors.muted} />
    </Pressable>
  );
}

function DayCell({
  day,
  inMonth,
  isSelected,
  isToday,
  onPress,
  onHoverIn,
  onHoverOut,
}: {
  day: number;
  inMonth: boolean;
  isSelected: boolean;
  isToday: boolean;
  onPress: () => void;
  onHoverIn: () => void;
  onHoverOut: () => void;
}) {
  const [hovered, setHovered] = useState(false);

  const circle = isSelected
    ? "bg-accent"
    : hovered
      ? "bg-sunken"
      : isToday
        ? "bg-accent-soft"
        : "";

  const textClass = isSelected
    ? "text-white font-bold"
    : isToday
      ? "text-accent font-semibold"
      : inMonth
        ? "text-ink"
        : "text-faint";

  return (
    <View className="items-center" style={{ width: `${100 / 7}%` }}>
      <Pressable
        onPress={onPress}
        onHoverIn={() => {
          setHovered(true);
          onHoverIn();
        }}
        onHoverOut={() => {
          setHovered(false);
          onHoverOut();
        }}
        className={`h-8 w-8 items-center justify-center rounded-full ${circle}`}
      >
        <Text className={`text-sm ${textClass}`}>{day}</Text>
      </Pressable>
    </View>
  );
}
