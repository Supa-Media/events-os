/**
 * DateTimeField — an on-brand date + time picker.
 *
 * Replaces the browser's native `datetime-local` control: a field trigger that
 * opens a popover pairing the shared {@link Calendar} (day selection) with a
 * scrolling time column (hour / minute / AM·PM). Selecting a day keeps the time
 * of day; changing the time keeps the day. Emits a single epoch-ms timestamp.
 */
import { useEffect, useRef, useState } from "react";
import { View, Text, Pressable, ScrollView } from "react-native";
import { formatDateTime } from "../../lib/format";
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

/** Replace the date of `prev` with the calendar day `dayMs`, keeping the time. */
function withDay(prev: number, dayMs: number): number {
  const d = new Date(dayMs);
  const p = new Date(prev);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), p.getHours(), p.getMinutes()).getTime();
}

export function DateTimeField({
  value,
  onChange,
}: {
  value: number;
  onChange: (ts: number) => void;
}) {
  const { ref, anchor, visible, open, close } = useAnchor();

  return (
    <>
      <Pressable
        ref={ref}
        onPress={open}
        className="flex-row items-center justify-between gap-3 rounded-md border border-border bg-raised px-3 py-2 active:opacity-80"
        style={{ minWidth: 210 }}
      >
        <Text className="text-sm text-ink">{formatDateTime(value)}</Text>
        <Icon name="calendar" size={15} color={colors.muted} />
      </Pressable>

      <Popover visible={visible} onClose={close} anchor={anchor} width={388}>
        <View className="flex-row">
          <View className="flex-1 border-r border-border">
            <Calendar
              selected={value}
              seed={value}
              onSelect={(dayMs) => onChange(withDay(value, dayMs))}
            />
          </View>
          <TimeColumns value={value} onChange={onChange} />
        </View>
      </Popover>
    </>
  );
}

function TimeColumns({
  value,
  onChange,
}: {
  value: number;
  onChange: (ts: number) => void;
}) {
  const d = new Date(value);
  const h24 = d.getHours();
  const pm = h24 >= 12;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const min = d.getMinutes();

  const set = (nh12: number, nmin: number, npm: boolean) => {
    const h = (nh12 % 12) + (npm ? 12 : 0);
    onChange(new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, nmin).getTime());
  };

  return (
    <View className="flex-row gap-1 p-2.5">
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

function MeridiemButton({
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
