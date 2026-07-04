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
 */
import { useState } from "react";
import { View, Text, Pressable, TextInput } from "react-native";
import { computeRunTime, formatOffsetMinutes, MINUTE_MS } from "@events-os/shared";
import { formatTime } from "../../lib/format";
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
  const label =
    value == null
      ? null
      : eventDate != null
        ? formatTime(computeRunTime(eventDate, value))
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
        <TimeEntryPanel value={value} eventDate={eventDate!} onChange={onChange} />
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

/** Typed hour : minute + AM·PM toggle. Commits a minute offset from T-0. */
function TimeEntryPanel({
  value,
  eventDate,
  onChange,
}: {
  value: number | null | undefined;
  eventDate: number;
  onChange: (offsetMinutes: number) => void;
}) {
  const seed = new Date(computeRunTime(eventDate, value ?? 0));
  const seedH12 = seed.getHours() % 12 === 0 ? 12 : seed.getHours() % 12;

  const [hourText, setHourText] = useState(pad(seedH12));
  const [minText, setMinText] = useState(pad(seed.getMinutes()));
  const [isPm, setIsPm] = useState(seed.getHours() >= 12);

  const commit = (hStr: string, mStr: string, pm: boolean) => {
    let h = parseInt(hStr, 10);
    let m = parseInt(mStr, 10);
    if (!Number.isFinite(h)) h = seedH12;
    if (!Number.isFinite(m)) m = seed.getMinutes();
    h = Math.min(12, Math.max(1, h));
    m = Math.min(59, Math.max(0, m));
    // Reflect the clamped/normalized values back into the fields.
    setHourText(pad(h));
    setMinText(pad(m));

    const h24 = (h % 12) + (pm ? 12 : 0);
    // Anchor to the segment's current time, then pick the occurrence of the
    // typed time nearest it so a run of show that crosses midnight stays put.
    const base = computeRunTime(eventDate, value ?? 0);
    const d = new Date(base);
    d.setHours(h24, m, 0, 0);
    let ts = d.getTime();
    while (ts - base > HALF_DAY_MS) ts -= DAY_MS;
    while (base - ts > HALF_DAY_MS) ts += DAY_MS;
    onChange(Math.round((ts - eventDate) / MINUTE_MS));
  };

  return (
    <View className="flex-row items-center justify-center gap-1.5 p-3">
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
