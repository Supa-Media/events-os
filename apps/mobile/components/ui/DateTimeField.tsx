/**
 * DateTimeField — an on-brand date + time picker.
 *
 * Replaces the browser's native `datetime-local` control: a field trigger that
 * opens a popover pairing the shared {@link Calendar} (day selection) with a
 * scrolling time column (hour / minute / AM·PM). Selecting a day keeps the time
 * of day; changing the time keeps the day. Emits a single epoch-ms timestamp.
 *
 * ## Whose clock is being picked
 *
 * Optional `timeZone`. Pass one and the panel READS AND WRITES wall clock in
 * that zone, and prints its name so the person picking can see whose clock they
 * are setting. Every EVENT surface passes `eventTimeZone(event)`: a time picked
 * for an event is the time *at the event*, not on the phone. Before that, a
 * leader on a Pacific phone picking "7:00 PM" for a New York event stored
 * 10:00 PM Eastern — the event moved, silently, and invisibly to anyone in the
 * org's own timezone.
 *
 * Omit it and the panel stays device-local, which is deliberate for the
 * timestamps that are genuinely about the person and their moment rather than
 * about a place: when a gift was received, when a transaction posted, the ends
 * of a card's validity window, an export range. Those callers pass nothing and
 * get no zone label — a label would be claiming a pin that isn't in effect.
 */
import { useEffect, useRef, useState } from "react";
import { View, Text, Pressable, ScrollView } from "react-native";
import { zonedParts } from "@events-os/shared";
import {
  calendarMsToZonedTs,
  formatDateTime,
  formatDateTimeInZone,
  withZonedTime,
  zonedDayToCalendarMs,
  zoneAbbreviation,
} from "../../lib/format";
import { colors } from "../../lib/theme";
import { Icon } from "./Icon";
import { Popover } from "./Popover";
import { useAnchor } from "./useAnchor";
import { Calendar } from "./Calendar";

const pad = (n: number) => String(n).padStart(2, "0");
const HOURS = Array.from({ length: 12 }, (_, i) => i + 1); // 1–12
const MINUTES = Array.from({ length: 60 }, (_, i) => i); // 0–59
const ITEM_H = 32;
const COL_H = 224;

/**
 * The wall-clock hour/minute of `ts` — in `timeZone` when one is given, on the
 * device otherwise. One reader for both modes so the columns and the commit can
 * never disagree about what "the current value" is.
 */
function wallClock(ts: number, timeZone?: string): { hour: number; minute: number } {
  if (timeZone) {
    const p = zonedParts(ts, timeZone);
    return { hour: p.hour, minute: p.minute };
  }
  const d = new Date(ts);
  return { hour: d.getHours(), minute: d.getMinutes() };
}

/** Replace the date of `prev` with the calendar day `dayMs`, keeping the time
 *  of day as read in `timeZone` (or on the device when unzoned). */
function withDay(prev: number, dayMs: number, timeZone?: string): number {
  const { hour, minute } = wallClock(prev, timeZone);
  if (timeZone) return calendarMsToZonedTs(dayMs, hour, minute, timeZone);
  const d = new Date(dayMs);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, minute).getTime();
}

/** Replace the time of day of `prev`, keeping its calendar day in `timeZone`
 *  (or on the device when unzoned). */
function withTime(
  prev: number,
  hour: number,
  minute: number,
  timeZone?: string,
): number {
  if (timeZone) return withZonedTime(prev, hour, minute, timeZone);
  const d = new Date(prev);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, minute).getTime();
}

export function DateTimeField({
  value,
  onChange,
  timeZone,
}: {
  value: number;
  onChange: (ts: number) => void;
  /** Read/write wall clock in this IANA zone instead of the device's. */
  timeZone?: string;
}) {
  const { ref, anchor, visible, open, close } = useAnchor();
  const zoneLabel = timeZone ? zoneAbbreviation(value, timeZone) : "";

  return (
    <>
      <Pressable
        ref={ref}
        onPress={open}
        className="flex-row items-center justify-between gap-3 rounded-md border border-border bg-raised px-3 py-2 active:opacity-80"
        style={{ minWidth: 210 }}
      >
        <Text className="text-sm text-ink">
          {timeZone ? formatDateTimeInZone(value, timeZone) : formatDateTime(value)}
          {zoneLabel ? ` ${zoneLabel}` : ""}
        </Text>
        <Icon name="calendar" size={15} color={colors.muted} />
      </Pressable>

      <Popover visible={visible} onClose={close} anchor={anchor} width={388}>
        <DateTimePanel value={value} onChange={onChange} timeZone={timeZone} />
      </Popover>
    </>
  );
}

/**
 * The picker body — shared {@link Calendar} paired with the scrolling time
 * column — without the field trigger or popover. Extracted so other surfaces
 * (e.g. grid time cells) can drop the same calendar + hour/minute/AM·PM UI into
 * their own popover. Selecting a day keeps the time; changing time keeps the day.
 *
 * `Calendar` is left speaking device-local day-midnights — it is a month grid,
 * not a clock, and other callers depend on that coordinate system — so the zone
 * translation happens here, at the boundary (`zonedDayToCalendarMs` /
 * `calendarMsToZonedTs`). Without it an 11 PM Eastern event highlights the
 * following day on a Tokyo phone.
 */
export function DateTimePanel({
  value,
  onChange,
  timeZone,
}: {
  value: number;
  onChange: (ts: number) => void;
  /** Read/write wall clock in this IANA zone instead of the device's. */
  timeZone?: string;
}) {
  const calendarDay = timeZone ? zonedDayToCalendarMs(value, timeZone) : value;
  return (
    <View className="flex-row">
      <View className="flex-1 border-r border-border">
        <Calendar
          selected={calendarDay}
          seed={calendarDay}
          onSelect={(dayMs) => onChange(withDay(value, dayMs, timeZone))}
        />
      </View>
      <TimeColumns value={value} onChange={onChange} timeZone={timeZone} />
    </View>
  );
}

function TimeColumns({
  value,
  onChange,
  timeZone,
}: {
  value: number;
  onChange: (ts: number) => void;
  timeZone?: string;
}) {
  const { hour: h24, minute: min } = wallClock(value, timeZone);
  const pm = h24 >= 12;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const zoneLabel = timeZone ? zoneAbbreviation(value, timeZone) : "";

  const set = (nh12: number, nmin: number, npm: boolean) => {
    const h = (nh12 % 12) + (npm ? 12 : 0);
    onChange(withTime(value, h, nmin, timeZone));
  };

  return (
    <View className="p-2.5">
      {zoneLabel ? (
        // Whose clock. A pinned "7:00 PM" is indistinguishable from the phone's
        // own 7:00 PM, so without this the fix is invisible to exactly the
        // person it protects — the leader who has travelled.
        <Text className="pb-1.5 text-center text-2xs font-semibold uppercase tracking-wide text-muted">
          {zoneLabel}
        </Text>
      ) : null}
      <View className="flex-row gap-1">
        <TimeScroller
          items={HOURS}
          selected={h12}
          render={(n) => pad(n)}
          onPick={(n) => set(n, min, pm)}
        />
        <TimeScroller
          items={MINUTES}
          selected={min}
          render={(n) => pad(n)}
          onPick={(n) => set(h12, n, pm)}
        />
        <View className="justify-center gap-1.5 pl-0.5">
          <MeridiemButton label="AM" active={!pm} onPress={() => set(h12, min, false)} />
          <MeridiemButton label="PM" active={pm} onPress={() => set(h12, min, true)} />
        </View>
      </View>
    </View>
  );
}

function TimeScroller({
  items,
  selected,
  render,
  onPick,
}: {
  items: number[];
  selected: number;
  render: (n: number) => string;
  onPick: (n: number) => void;
}) {
  const scrollRef = useRef<ScrollView>(null);

  // Center the selected value when the popover opens.
  useEffect(() => {
    const idx = items.indexOf(selected);
    if (idx >= 0) {
      scrollRef.current?.scrollTo({ y: idx * ITEM_H - COL_H / 2 + ITEM_H / 2, animated: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <ScrollView
      ref={scrollRef}
      style={{ height: COL_H, width: 40 }}
      showsVerticalScrollIndicator={false}
      contentContainerStyle={{ paddingVertical: COL_H / 2 - ITEM_H / 2 }}
    >
      {items.map((n) => (
        <TimeItem key={n} label={render(n)} selected={n === selected} onPress={() => onPick(n)} />
      ))}
    </ScrollView>
  );
}

function TimeItem({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const bg = selected ? "bg-accent" : hovered ? "bg-sunken" : "";
  const text = selected ? "text-white font-bold" : "text-ink";
  return (
    <Pressable
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      className={`items-center justify-center rounded-md ${bg}`}
      style={{ height: ITEM_H }}
    >
      <Text className={`text-sm ${text}`}>{label}</Text>
    </Pressable>
  );
}

/** The AM·PM toggle chip. Exported so time-entry surfaces reuse the aesthetic. */
export function MeridiemButton({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const cls = active
    ? "bg-accent border-accent"
    : hovered
      ? "bg-sunken border-border-strong"
      : "bg-raised border-border";
  return (
    <Pressable
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      className={`h-9 w-11 items-center justify-center rounded-md border ${cls}`}
    >
      <Text className={`text-xs font-bold ${active ? "text-white" : "text-muted"}`}>
        {label}
      </Text>
    </Pressable>
  );
}
