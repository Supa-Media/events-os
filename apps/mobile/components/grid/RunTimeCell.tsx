/**
 * RunTimeCell — the run-of-show TIME column editor.
 *
 * TIME is stored as a signed minute offset from the event start (T-0), so a run
 * of show can legitimately span midnight. Clicking the cell opens a compact,
 * on-brand time panel where you TYPE the hour and minute and toggle AM·PM —
 * matching the app's date/time aesthetic (rounded fields + accent chips) but
 * without a calendar. We write back the offset (`round((typed - eventStart) /
 * MINUTE_MS)`).
 *
 * A bare wall-clock time is day-ambiguous across midnight, so the typed time is
 * placed on the occurrence nearest the segment's current time — nudging
 * 11:30 PM → 11:45 PM stays on the same night. Without an event date to anchor
 * against, the cell is read-only formatted text.
 *
 * Every clock here — the chip, the seeded fields, and the commit — is the
 * EVENT's, resolved once through `eventTimeZone(event)`. A run sheet is a fact
 * about the room the event happens in: two phones in that room must read the
 * same sheet, and a leader who types "5:00 PM" from a Pacific airport must set
 * the load-in her crew will actually turn up for, not 8:00 PM.
 */
import { useState } from "react";
import { View, Text, Pressable, TextInput } from "react-native";
import {
  computeRunTime,
  eventTimeZone,
  formatOffsetMinutes,
  MINUTE_MS,
  zonedParts,
} from "@events-os/shared";
import { formatTimeInZone, withZonedTime, zoneAbbreviation } from "../../lib/format";
import { colors } from "../../lib/theme";
import { Icon } from "../ui/Icon";
import { Popover } from "../ui/Popover";
import { useAnchor } from "../ui/useAnchor";
import { MeridiemButton } from "../ui/DateTimeField";

const pad = (n: number) => String(n).padStart(2, "0");
const HALF_DAY_MS = 12 * 60 * MINUTE_MS;
const DAY_MS = 24 * 60 * MINUTE_MS;

export function RunTimeCell({
  value,
  eventDate,
  editable,
  onChange,
}: {
  value: number | null | undefined;
  eventDate?: number;
  editable: boolean;
  onChange: (offsetMinutes: number) => void;
}) {
  const { ref, anchor, visible, open, close } = useAnchor();

  // Editing needs the event start to back-calculate the offset; without it (or
  // when read-only) the cell is just the formatted time chip.
  const canPick = editable && eventDate != null;
  const timeZone = eventTimeZone(eventDate != null ? { eventDate } : null);
  const label =
    value == null
      ? null
      : eventDate != null
        ? formatTimeInZone(computeRunTime(eventDate, value), timeZone)
        : formatOffsetMinutes(value);

  if (!canPick) {
    return (
      <View className="px-2 py-1.5">
        {label != null ? <Chip label={label} /> : <Text className="text-sm text-faint">—</Text>}
      </View>
    );
  }

  return (
    <>
      <Pressable
        ref={ref}
        onPress={open}
        className="flex-1 flex-row items-center gap-1.5 px-2 py-1.5 active:opacity-70"
      >
        {label != null ? (
          <Chip label={label} />
        ) : (
          <Text className="flex-1 text-sm text-faint">Set time</Text>
        )}
        <Icon name="clock" size={13} color={colors.faint} />
      </Pressable>

      <Popover visible={visible} onClose={close} anchor={anchor} width={196}>
        <TimeEntryPanel
          value={value}
          eventDate={eventDate!}
          timeZone={timeZone}
          onChange={onChange}
        />
      </Popover>
    </>
  );
}

function Chip({ label }: { label: string }) {
  return (
    <View className="self-start rounded-sm bg-sunken px-2 py-0.5">
      <Text className="text-xs font-semibold text-muted">{label}</Text>
    </View>
  );
}

/** Typed hour : minute + AM·PM toggle, in the event's timezone. Commits a
 *  minute offset from T-0. */
function TimeEntryPanel({
  value,
  eventDate,
  timeZone,
  onChange,
}: {
  value: number | null | undefined;
  eventDate: number;
  timeZone: string;
  onChange: (offsetMinutes: number) => void;
}) {
  const base = computeRunTime(eventDate, value ?? 0);
  const seed = zonedParts(base, timeZone);
  const seedH12 = seed.hour % 12 === 0 ? 12 : seed.hour % 12;
  const zoneLabel = zoneAbbreviation(base, timeZone);

  const [hourText, setHourText] = useState(pad(seedH12));
  const [minText, setMinText] = useState(pad(seed.minute));
  const [isPm, setIsPm] = useState(seed.hour >= 12);

  const commit = (hStr: string, mStr: string, pm: boolean) => {
    let h = parseInt(hStr, 10);
    let m = parseInt(mStr, 10);
    if (!Number.isFinite(h)) h = seedH12;
    if (!Number.isFinite(m)) m = seed.minute;
    h = Math.min(12, Math.max(1, h));
    m = Math.min(59, Math.max(0, m));
    // Reflect the clamped/normalized values back into the fields.
    setHourText(pad(h));
    setMinText(pad(m));

    const h24 = (h % 12) + (pm ? 12 : 0);
    // Anchor to the segment's current time, then pick the occurrence of the
    // typed time nearest it so a run of show that crosses midnight stays put.
    // "Same day, different time" is asked in the EVENT's zone — asked on the
    // device it lands on the wrong day whenever the two disagree about which
    // day it is, which is most of the evening for anyone west of the event.
    let ts = withZonedTime(base, h24, m, timeZone);
    while (ts - base > HALF_DAY_MS) ts -= DAY_MS;
    while (base - ts > HALF_DAY_MS) ts += DAY_MS;
    onChange(Math.round((ts - eventDate) / MINUTE_MS));
  };

  return (
    <View className="p-3">
      {zoneLabel ? (
        <Text className="pb-1.5 text-center text-2xs font-semibold uppercase tracking-wide text-muted">
          {zoneLabel}
        </Text>
      ) : null}
      <View className="flex-row items-center justify-center gap-1.5">
        <TimeInput
          value={hourText}
          onChangeText={setHourText}
          onBlur={() => commit(hourText, minText, isPm)}
          autoFocus
        />
        <Text className="text-lg font-semibold text-muted">:</Text>
        <TimeInput
          value={minText}
          onChangeText={setMinText}
          onBlur={() => commit(hourText, minText, isPm)}
        />
        <View className="gap-1 pl-1">
          <MeridiemButton
            label="AM"
            active={!isPm}
            onPress={() => {
              setIsPm(false);
              commit(hourText, minText, false);
            }}
          />
          <MeridiemButton
            label="PM"
            active={isPm}
            onPress={() => {
              setIsPm(true);
              commit(hourText, minText, true);
            }}
          />
        </View>
      </View>
    </View>
  );
}

function TimeInput({
  value,
  onChangeText,
  onBlur,
  autoFocus,
}: {
  value: string;
  onChangeText: (t: string) => void;
  onBlur: () => void;
  autoFocus?: boolean;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        onBlur();
      }}
      keyboardType="number-pad"
      maxLength={2}
      selectTextOnFocus
      autoFocus={autoFocus}
      className={`rounded-md border bg-raised px-1.5 py-1.5 text-center text-lg font-semibold text-ink ${
        focused ? "border-accent" : "border-border"
      }`}
      style={{ width: 46 }}
    />
  );
}
