/**
 * TimeEntryPanel — the run-of-show TIME editor body: typed hour : minute fields
 * plus an AM·PM toggle, matching the app's date/time aesthetic (no calendar).
 *
 * TIME is stored as a signed minute offset from the event start (T-0). Typed
 * values are clamped (hour 1–12, minute 0–59, blank falls back) so nothing
 * invalid is stored, then converted to an offset by `offsetForClockTime`.
 */
import { useState } from "react";
import { View, Text, TextInput } from "react-native";
import { computeRunTime, offsetForClockTime } from "@events-os/shared";
import { MeridiemButton } from "../ui/DateTimeField";

const pad = (n: number) => String(n).padStart(2, "0");

function clampHour12(text: string, fallback: number): number {
  const n = parseInt(text, 10);
  return Number.isFinite(n) ? Math.min(12, Math.max(1, n)) : fallback;
}

function clampMinute(text: string, fallback: number): number {
  const n = parseInt(text, 10);
  return Number.isFinite(n) ? Math.min(59, Math.max(0, n)) : fallback;
}

const to24Hour = (hour12: number, pm: boolean) => (hour12 % 12) + (pm ? 12 : 0);

export function TimeEntryPanel({
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

  const applyTime = (hStr: string, mStr: string, pm: boolean) => {
    const hour = clampHour12(hStr, seedH12);
    const minute = clampMinute(mStr, seed.getMinutes());
    setHourText(pad(hour));
    setMinText(pad(minute));
    onChange(
      offsetForClockTime({
        eventStart: eventDate,
        currentOffset: value ?? 0,
        hour24: to24Hour(hour, pm),
        minute,
      }),
    );
  };

  const setMeridiem = (pm: boolean) => {
    setIsPm(pm);
    applyTime(hourText, minText, pm);
  };

  return (
    <View className="flex-row items-center justify-center gap-1.5 p-3">
      <TimeInput
        value={hourText}
        onChangeText={setHourText}
        onBlur={() => applyTime(hourText, minText, isPm)}
        autoFocus
      />
      <Text className="text-lg font-semibold text-muted">:</Text>
      <TimeInput
        value={minText}
        onChangeText={setMinText}
        onBlur={() => applyTime(hourText, minText, isPm)}
      />
      <View className="gap-1 pl-1">
        <MeridiemButton label="AM" active={!isPm} onPress={() => setMeridiem(false)} />
        <MeridiemButton label="PM" active={isPm} onPress={() => setMeridiem(true)} />
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
