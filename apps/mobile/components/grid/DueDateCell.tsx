/**
 * DueDateCell — the DUE column's calendar day-picker.
 *
 * DUE is a derived field (`eventDate + offsetDays`), so picking a calendar day
 * doesn't write a date — it writes back the signed `offsetDays` (handled in
 * `due_date.set`), which reflows the DUE date and the TIMING (T-…) chip
 * together. This wraps the shared {@link Calendar} with a footer that previews
 * the resulting offset as you hover, making the DUE ↔ TIMING relationship
 * tangible at the moment of choosing.
 */
import { useState } from "react";
import { View, Text, Pressable } from "react-native";
import { formatOffsetDays, offsetDaysBetween } from "@events-os/shared";
import { formatDate } from "../../lib/format";
import { colors } from "../../lib/theme";
import { Icon } from "../ui/Icon";
import { Popover } from "../ui/Popover";
import { useAnchor } from "../ui/useAnchor";
import { Calendar } from "../ui/Calendar";

/** "T-21" → "21 days before the event" (and friends). */
function offsetCaption(offset: number): string {
  if (offset === 0) return "On the event day";
  const n = Math.abs(offset);
  return offset < 0
    ? `${n} day${n === 1 ? "" : "s"} before the event`
    : `${n} day${n === 1 ? "" : "s"} after the event`;
}

export function DueDateCell({
  value,
  eventDate,
  editable,
  onChange,
}: {
  value: number | null | undefined;
  eventDate?: number;
  editable: boolean;
  onChange: (value: number) => void;
}) {
  const { ref, anchor, visible, open, close } = useAnchor();

  // Editing needs the event date to back-calculate the offset; without it (or
  // when read-only) the cell is just the formatted day.
  const canPick = editable && eventDate != null;

  if (!canPick) {
    return (
      <Text className="px-2 py-1.5 text-sm text-muted">
        {value != null ? formatDate(value) : "—"}
      </Text>
    );
  }

  return (
    <>
      <Pressable
        ref={ref}
        onPress={open}
        className="flex-1 flex-row items-center gap-1.5 px-2 py-1.5 active:opacity-70"
      >
        <Text
          className={`flex-1 text-sm ${value != null ? "text-muted" : "text-faint"}`}
          numberOfLines={1}
        >
          {value != null ? formatDate(value) : "Set date"}
        </Text>
        <Icon name="calendar" size={13} color={colors.faint} />
      </Pressable>

      <Popover visible={visible} onClose={close} anchor={anchor} width={288}>
        <DueCalendar
          value={value ?? null}
          eventDate={eventDate!}
          onPick={(ms) => {
            onChange(ms);
            close();
          }}
        />
      </Popover>
    </>
  );
}

function DueCalendar({
  value,
  eventDate,
  onPick,
}: {
  value: number | null;
  eventDate: number;
  onPick: (ms: number) => void;
}) {
  // Day hovered for the footer offset preview; falls back to the selected day.
  const [hovered, setHovered] = useState<number | null>(null);
  const previewMs = hovered ?? value;
  const previewOffset =
    previewMs != null ? offsetDaysBetween(eventDate, previewMs) : null;

  return (
    <Calendar
      selected={value}
      seed={eventDate}
      onSelect={onPick}
      onHoverDay={setHovered}
      footer={
        <View className="mt-2 flex-row items-center gap-2 border-t border-border pt-2.5">
          {previewOffset != null ? (
            <>
              <View className="rounded-sm bg-sunken px-2 py-0.5">
                <Text className="text-xs font-semibold text-muted">
                  {formatOffsetDays(previewOffset)}
                </Text>
              </View>
              <Text className="flex-1 text-xs text-muted" numberOfLines={1}>
                {offsetCaption(previewOffset)}
              </Text>
            </>
          ) : (
            <Text className="text-xs text-faint">Pick a day to set the timing</Text>
          )}
        </View>
      }
    />
  );
}
