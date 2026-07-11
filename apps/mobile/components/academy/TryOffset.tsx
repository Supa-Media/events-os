import { useState } from "react";
import { View, Text, Pressable } from "react-native";
import { Icon } from "../ui";
import { colors } from "../../lib/theme";

// A fixed sample Saturday — the demo teaches derivation, not calendars.
const BASE_DATE = new Date(2026, 5, 6);
const DAY = 24 * 60 * 60 * 1000;

const OFFSETS = [-14, -10, -7, -3, -1, 2];

// A few real checkpoints so a date move visibly shifts the WHOLE timeline.
const SAMPLE_TASKS = [
  { title: "Announce the event", offset: -14 },
  { title: "Volunteers locked", offset: -10 },
  { title: "Supplies packed", offset: -1 },
];

function offsetLabel(o: number): string {
  return o < 0 ? `T-${-o}` : o === 0 ? "T-0" : `T+${o}`;
}

function fmt(d: Date): string {
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/**
 * The T-offset sandbox: pick an offset and watch it become a real due date,
 * then move the event date and watch every derived date move together — the
 * "a date change is a plan change" lesson, hands-on. Local state only.
 */
export function TryOffset({ eventDateLabel }: { eventDateLabel?: string }) {
  const [offset, setOffset] = useState(-7);
  const [shift, setShift] = useState(0);

  const eventDate = new Date(BASE_DATE.getTime() + shift * DAY);
  const due = new Date(eventDate.getTime() + offset * DAY);

  return (
    <View>
      {/* The sample event + date movers */}
      <View className="flex-row flex-wrap items-center gap-2">
        <Icon name="calendar" size={14} color={colors.accent} />
        <Text className="text-sm font-semibold text-ink">
          {eventDateLabel ?? "Sample event"} · {fmt(eventDate)}
        </Text>
        <View className="flex-1" />
        <Pressable
          onPress={() => setShift((s) => s - 7)}
          accessibilityRole="button"
          accessibilityLabel="Move the event 7 days earlier"
          className="rounded-md border border-border px-2 py-1 active:bg-sunken web:hover:bg-sunken"
        >
          <Text className="text-xs font-semibold text-muted">−7 days</Text>
        </Pressable>
        <Pressable
          onPress={() => setShift((s) => s + 7)}
          accessibilityRole="button"
          accessibilityLabel="Move the event 7 days later"
          className="rounded-md border border-border px-2 py-1 active:bg-sunken web:hover:bg-sunken"
        >
          <Text className="text-xs font-semibold text-muted">+7 days</Text>
        </Pressable>
      </View>

      {/* Offset picker */}
      <View className="mt-3 flex-row flex-wrap gap-1.5">
        {OFFSETS.map((o) => {
          const selected = o === offset;
          return (
            <Pressable
              key={o}
              onPress={() => setOffset(o)}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              className={`rounded-pill border px-2.5 py-1 ${
                selected
                  ? "border-accent bg-accent"
                  : "border-border bg-raised active:bg-sunken web:hover:bg-sunken"
              }`}
            >
              <Text
                className={`text-xs font-bold ${
                  selected ? "text-white" : "text-muted"
                }`}
              >
                {offsetLabel(o)}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* The derived due date */}
      <View className="mt-3 rounded-md bg-sunken px-3 py-2.5">
        <Text className="text-sm text-ink">
          <Text className="font-bold">{offsetLabel(offset)}</Text> → due{" "}
          <Text className="font-bold">{fmt(due)}</Text>
        </Text>
      </View>

      {/* The rest of the timeline derives too */}
      <View className="mt-2.5 gap-1.5">
        {SAMPLE_TASKS.map((t) => (
          <View key={t.title} className="flex-row items-center gap-2">
            <Text className="w-10 text-xs font-bold text-accent">
              {offsetLabel(t.offset)}
            </Text>
            <Text className="flex-1 text-xs text-muted">{t.title}</Text>
            <Text className="text-xs font-semibold text-ink">
              {fmt(new Date(eventDate.getTime() + t.offset * DAY))}
            </Text>
          </View>
        ))}
      </View>

      {shift !== 0 ? (
        <View className="mt-2.5 flex-row items-start gap-2">
          <View className="mt-0.5">
            <Icon name="alert-triangle" size={13} color={colors.warn} />
          </View>
          <Text className="flex-1 text-xs leading-4 text-warn">
            You moved the event — every derived date moved with it. A date
            change is a plan change: permits and other lead times don't
            compress, so re-check feasibility.
          </Text>
        </View>
      ) : (
        <Text className="mt-2.5 text-xs text-faint">
          Pick an offset, then move the event date and watch the whole
          timeline re-derive.
        </Text>
      )}
    </View>
  );
}
