/**
 * EventsCalendarView — the month-grid + day-agenda body shared by the
 * standalone `/calendar` route and the Events tab's `Calendar` toggle.
 *
 * Two coordinated surfaces that mirror how people actually read a calendar:
 *
 *   Month grid   — every event as a status-toned chip in its day cell, with
 *                  today ringed and the selected day filled. Tap a chip to open
 *                  the event; tap a day to focus it in the agenda.
 *   Day agenda    — the selected day's events as rich, tappable rows, or a calm
 *                  empty state that offers to start an event ON that day.
 *
 * Pulls EVERY event (`scope: "all"`) so past months stay populated; past days
 * read dimmer than upcoming ones. Pure month math (no date libs) lives in
 * `calendarMonthGrid`, matching the shared day-picker's Sunday-first 6×7 grid.
 *
 * `isPeeking`/`chapterId` mirror the Events tab's list view peek guards
 * (`ChapterContext.tsx`'s documented invariant): while peeking a different
 * chapter, "New event" is hidden and event-detail taps are disabled.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  Pressable,
  ActivityIndicator,
  useWindowDimensions,
} from "react-native";
import { useRouter } from "expo-router";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  startOfDay,
  calendarMonthGrid,
  groupByDay,
  soonestUpcoming,
  EVENT_STATUS_LABELS,
  type EventStatus,
} from "@events-os/shared";
import {
  Card,
  Button,
  Badge,
  Icon,
  EmptyState,
  statusTone,
} from "../ui";
import { colors } from "../../lib/theme";
import { formatTime, toDateInput } from "../../lib/format";

type EventRow = FunctionReturnType<typeof api.events.list>[number];

const WIDE = 900;

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAYS_LONG = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
];

/**
 * Per-status chip styling for the grid. Soft fill + a saturated dot/label so a
 * month's worth of events stays scannable by colour alone. Mirrors the semantic
 * tones used by `statusTone`/Badge so the calendar reads like the rest of the app.
 */
const STATUS_CHIP: Record<
  EventStatus,
  { dot: string; chip: string; text: string }
> = {
  planning: { dot: colors.warn, chip: "bg-warn-bg", text: "text-warn" },
  ready: { dot: colors.accent, chip: "bg-accent-soft", text: "text-accent" },
  completed: { dot: colors.success, chip: "bg-success-bg", text: "text-success" },
  cancelled: { dot: colors.faint, chip: "bg-sunken", text: "text-faint" },
};

export function EventsCalendarView({
  isPeeking = false,
  chapterId,
}: {
  isPeeking?: boolean;
  chapterId?: Id<"chapters">;
}) {
  const router = useRouter();
  const { width } = useWindowDimensions();
  const wide = width >= WIDE;
  const events = useQuery(api.events.list, { scope: "all", chapterId });

  const today = startOfDay(Date.now());
  const [view, setView] = useState(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  });
  const [selected, setSelected] = useState<number>(today);

  // Opens on the soonest upcoming event and highlights it, rather than a
  // possibly-empty current month. Runs once, the first time events resolve;
  // manual nav afterward is never overridden.
  const didInit = useRef(false);
  useEffect(() => {
    if (didInit.current || events === undefined) return;
    didInit.current = true;
    const next = soonestUpcoming(events, (e) => e.eventDate, Date.now());
    if (next) {
      const d = new Date(next.eventDate);
      setView({ year: d.getFullYear(), month: d.getMonth() });
      setSelected(startOfDay(next.eventDate));
    }
  }, [events]);

  // day-ms → events on that day, date-sorted. One pass over the full list.
  const byDay = useMemo(() => {
    const m = groupByDay(events ?? [], (e) => e.eventDate);
    for (const arr of m.values()) arr.sort((a, b) => a.eventDate - b.eventDate);
    return m;
  }, [events]);

  if (events === undefined) {
    return (
      <View className="items-center justify-center py-12">
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  const cells = calendarMonthGrid(view.year, view.month);
  const selectedEvents = byDay.get(selected) ?? [];

  const step = (delta: number) => {
    const m = view.month + delta;
    setView({
      year: view.year + Math.floor(m / 12),
      month: ((m % 12) + 12) % 12,
    });
  };

  const goToday = () => {
    const d = new Date();
    setView({ year: d.getFullYear(), month: d.getMonth() });
    setSelected(today);
  };

  const onOpenEvent = isPeeking
    ? undefined
    : (id: string) => router.push(`/event/${id}`);
  const onNewOnDay = isPeeking
    ? undefined
    : () => router.push(`/event/new?date=${toDateInput(selected)}`);

  return (
    <View>
      {/* Month nav: prev · serif month · next, with a Today reset. */}
      <View className="mb-4 flex-row items-center gap-3">
        <NavButton icon="chevron-left" onPress={() => step(-1)} />
        <Text className="font-display text-2xl text-ink">
          {MONTHS[view.month]} {view.year}
        </Text>
        <NavButton icon="chevron-right" onPress={() => step(1)} />
        <View className="flex-1" />
        <Button title="Today" variant="secondary" size="sm" onPress={goToday} />
      </View>

      <View className={wide ? "flex-row items-start gap-5" : "gap-5"}>
        {/* ── Month grid ─────────────────────────────────────────────────── */}
        <View className="flex-1">
          <Card padding="none" className="overflow-hidden">
            {/* Weekday header */}
            <View className="flex-row border-b border-border bg-sunken">
              {WEEKDAYS.map((w, i) => (
                <View key={i} className="flex-1 items-center py-2">
                  <Text className="text-2xs font-bold uppercase tracking-wider text-faint">
                    {w}
                  </Text>
                </View>
              ))}
            </View>

            {/* 6 weeks */}
            {Array.from({ length: 6 }, (_, wk) => (
              <View key={wk} className="flex-row">
                {cells.slice(wk * 7, wk * 7 + 7).map((c) => (
                  <DayCell
                    key={c.ms}
                    day={c.day}
                    inMonth={c.inMonth}
                    isToday={c.ms === today}
                    isSelected={c.ms === selected}
                    isPast={c.ms < today}
                    events={byDay.get(c.ms) ?? []}
                    compact={!wide}
                    onPress={() => setSelected(c.ms)}
                    onOpenEvent={onOpenEvent}
                  />
                ))}
              </View>
            ))}
          </Card>

          {/* Legend — what the chip colours mean. */}
          <View className="mt-3 flex-row flex-wrap gap-x-4 gap-y-1.5 px-1">
            {(Object.keys(STATUS_CHIP) as EventStatus[]).map((s) => (
              <View key={s} className="flex-row items-center gap-1.5">
                <View
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: STATUS_CHIP[s].dot }}
                />
                <Text className="text-xs text-muted">
                  {EVENT_STATUS_LABELS[s]}
                </Text>
              </View>
            ))}
          </View>
        </View>

        {/* ── Day agenda ─────────────────────────────────────────────────── */}
        <View style={wide ? { width: 340 } : undefined}>
          <DayAgenda
            day={selected}
            events={selectedEvents}
            isToday={selected === today}
            onOpenEvent={onOpenEvent}
            onNewOnDay={onNewOnDay}
          />
        </View>
      </View>
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
      className={`h-9 w-9 items-center justify-center rounded-md border border-border ${
        hovered ? "bg-sunken" : "bg-raised"
      }`}
    >
      <Icon name={icon} size={18} color={colors.ink} />
    </Pressable>
  );
}

/** A single day in the month grid. */
function DayCell({
  day,
  inMonth,
  isToday,
  isSelected,
  isPast,
  events,
  compact,
  onPress,
  onOpenEvent,
}: {
  day: number;
  inMonth: boolean;
  isToday: boolean;
  isSelected: boolean;
  isPast: boolean;
  events: EventRow[];
  compact: boolean;
  onPress: () => void;
  /** `undefined` while peeking — an event's detail screen isn't peek-safe. */
  onOpenEvent?: (id: string) => void;
}) {
  const [hovered, setHovered] = useState(false);

  // Selected day gets a soft brand wash; otherwise hover hints interactivity.
  const cellBg = isSelected ? "bg-accent-soft/60" : hovered ? "bg-sunken" : "";

  const MAX_CHIPS = compact ? 0 : 3;
  const shown = events.slice(0, MAX_CHIPS);
  const overflow = events.length - shown.length;

  return (
    <Pressable
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={{ width: `${100 / 7}%`, minHeight: compact ? 52 : 104 }}
      className={`border-b border-r border-border px-1.5 py-1.5 ${cellBg}`}
    >
      {/* Date number — today is a filled brand pip. */}
      <View className="mb-1 flex-row items-center justify-between">
        {isToday ? (
          <View className="h-6 w-6 items-center justify-center rounded-full bg-accent">
            <Text className="text-xs font-bold text-white">{day}</Text>
          </View>
        ) : (
          <Text
            className={`px-1 text-xs font-semibold ${
              !inMonth ? "text-faint" : isPast ? "text-muted" : "text-ink"
            }`}
          >
            {day}
          </Text>
        )}
        {/* Compact (phone): a count pip instead of chips. */}
        {compact && events.length > 0 ? (
          <View className="h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1">
            <Text className="text-2xs font-bold text-white">{events.length}</Text>
          </View>
        ) : null}
      </View>

      {/* Event chips (wide only). */}
      {!compact ? (
        <View className="gap-1">
          {shown.map((e) => {
            const s = STATUS_CHIP[e.status as EventStatus];
            return (
              <Pressable
                key={e._id}
                onPress={onOpenEvent ? () => onOpenEvent(e._id) : undefined}
                className={`flex-row items-center gap-1 rounded px-1.5 py-0.5 ${s.chip} ${
                  isPast ? "opacity-60" : ""
                } active:opacity-80 web:hover:opacity-90`}
              >
                <View
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: s.dot }}
                />
                <Text
                  className={`flex-1 text-2xs font-semibold ${s.text}`}
                  numberOfLines={1}
                >
                  {e.name}
                </Text>
              </Pressable>
            );
          })}
          {overflow > 0 ? (
            <Text className="pl-1 text-2xs font-semibold text-muted">
              +{overflow} more
            </Text>
          ) : null}
        </View>
      ) : null}
    </Pressable>
  );
}

/** The right-hand (or stacked) detail for the selected day. */
function DayAgenda({
  day,
  events,
  isToday,
  onOpenEvent,
  onNewOnDay,
}: {
  day: number;
  events: EventRow[];
  isToday: boolean;
  /** `undefined` while peeking — an event's detail screen isn't peek-safe. */
  onOpenEvent?: (id: string) => void;
  /** `undefined` while peeking — creating always targets the caller's own chapter. */
  onNewOnDay?: () => void;
}) {
  const d = new Date(day);
  return (
    <View>
      <View className="mb-3 px-1">
        <Text className="text-2xs font-bold uppercase tracking-wider text-accent">
          {isToday ? "Today" : WEEKDAYS_LONG[d.getDay()]}
        </Text>
        <Text className="font-display text-xl text-ink">
          {MONTHS[d.getMonth()]} {d.getDate()}
        </Text>
      </View>

      {events.length === 0 ? (
        <EmptyState
          icon="calendar"
          title="Nothing scheduled"
          message="This day is open. Start an event on it from a template."
          action={
            onNewOnDay ? (
              <Button
                title="New event"
                icon="plus"
                variant="secondary"
                onPress={onNewOnDay}
              />
            ) : undefined
          }
        />
      ) : (
        <View className="gap-2.5">
          {events.map((e) => (
            <AgendaRow
              key={e._id}
              event={e}
              onPress={onOpenEvent ? () => onOpenEvent(e._id) : undefined}
            />
          ))}
        </View>
      )}
    </View>
  );
}

/** One event in the day agenda — the rich, tappable representation. */
function AgendaRow({
  event,
  onPress,
}: {
  event: EventRow;
  /** `undefined` while peeking — an event's detail screen isn't peek-safe. */
  onPress?: () => void;
}) {
  const s = STATUS_CHIP[event.status as EventStatus];
  return (
    <Card onPress={onPress} padding="md">
      <View className="flex-row items-start gap-3">
        {/* Status spine */}
        <View
          className="mt-0.5 h-9 w-1 rounded-full"
          style={{ backgroundColor: s.dot }}
        />
        <View className="flex-1">
          <View className="flex-row items-start justify-between gap-2">
            <Text className="flex-1 text-base font-semibold text-ink" numberOfLines={2}>
              {event.name}
            </Text>
            <Badge
              label={EVENT_STATUS_LABELS[event.status as EventStatus]}
              tone={statusTone(event.status as EventStatus)}
            />
          </View>
          <Text className="mt-0.5 text-sm text-muted" numberOfLines={1}>
            {event.eventTypeName} · {formatTime(event.eventDate)}
          </Text>
          {event.location ? (
            <View className="mt-1 flex-row items-center gap-1">
              <Icon name="map-pin" size={12} color={colors.faint} />
              <Text className="text-xs text-muted" numberOfLines={1}>
                {event.location}
              </Text>
            </View>
          ) : null}
        </View>
      </View>
    </Card>
  );
}
