/**
 * The timing line as an editor: a date-first pill ("Jul 14 · 12 days before ▾")
 * that opens a menu. Leads with the primary path — point at a day on the month
 * grid — and keeps the relative T-offset controls (presets + stepper) tucked
 * behind a toggle, since most edits just want a date. The relative editor runs
 * in draft mode (a live commit would move the card to another day and unmount
 * this popover mid-edit).
 */
import { useState } from "react";
import { View, Text, Pressable } from "react-native";
import { commsTimingLabel } from "@events-os/shared";
import { Icon } from "../../ui/Icon";
import { Popover } from "../../ui/Popover";
import { useAnchor } from "../../ui/useAnchor";
import { colors } from "../../../lib/theme";
import { formatDate } from "../../../lib/format";
import { TimingPanel } from "../../grid/TimingCell";
import type { ScheduleItem } from "./config";

export function TimingChip({
  item,
  eventDate,
  onSetOffset,
  onPickOnCalendar,
}: {
  item: ScheduleItem;
  eventDate: number;
  onSetOffset: (offsetDays: number | null) => void;
  onPickOnCalendar: () => void;
}) {
  const { ref, anchor, visible, open, close } = useAnchor();
  // Relative controls collapse again each time the menu reopens — picking an
  // exact day is the default, so the offset editor starts hidden.
  const [showRelative, setShowRelative] = useState(false);
  const openMenu = () => {
    setShowRelative(false);
    open();
  };

  const scheduled = item.offsetDays != null;
  const relativeLabel = commsTimingLabel(item.offsetDays);

  return (
    <>
      {/* Date-first pill button: a leading calendar glyph, the concrete date in
          ink, the relative offset as faint context, and a split chevron that
          reads as "opens a menu". Fill + border make it clearly tappable. */}
      <Pressable
        ref={ref}
        onPress={openMenu}
        hitSlop={4}
        className="mt-1.5 flex-row items-center gap-1.5 self-start rounded-lg border border-border bg-sunken py-1.5 pl-2.5 pr-1.5 active:opacity-80 web:hover:border-faint web:hover:bg-accent-soft"
      >
        <Icon
          name="calendar"
          size={12}
          color={scheduled ? colors.accent : colors.faint}
        />
        {scheduled ? (
          <Text className="text-xs" numberOfLines={1}>
            <Text className="font-semibold text-ink">
              {item.dueDate != null ? formatDate(item.dueDate) : relativeLabel}
            </Text>
            {item.dueDate != null ? (
              <Text className="font-medium text-faint">{`   ${relativeLabel}`}</Text>
            ) : null}
          </Text>
        ) : (
          <Text className="text-xs font-semibold text-accent">Schedule…</Text>
        )}
        <View className="ml-0.5 h-4 justify-center border-l border-border pl-1.5">
          <Icon name="chevron-down" size={13} color={colors.faint} />
        </View>
      </Pressable>

      <Popover visible={visible} onClose={close} anchor={anchor} width={280}>
        <View className="py-1">
          {/* 1 — the primary path: point at a day on the month grid. */}
          <Pressable
            onPress={() => {
              close();
              onPickOnCalendar();
            }}
            className="flex-row items-center gap-2.5 px-3 py-2.5 active:bg-sunken web:hover:bg-sunken"
          >
            <Icon name="calendar" size={15} color={colors.accent} />
            <Text className="text-sm font-semibold text-accent">
              Pick a day on the calendar
            </Text>
          </Pressable>

          <View className="h-px bg-border" />

          {/* 2 — relative timing (T-offset), tucked behind a toggle. */}
          <Pressable
            onPress={() => setShowRelative((v) => !v)}
            className="flex-row items-center gap-2.5 px-3 py-2.5 active:bg-sunken web:hover:bg-sunken"
          >
            <Icon name="clock" size={15} color={colors.muted} />
            <Text className="flex-1 text-sm font-medium text-ink">
              Set timing before or after the event
            </Text>
            <Icon
              name={showRelative ? "chevron-up" : "chevron-down"}
              size={15}
              color={colors.faint}
            />
          </Pressable>

          {showRelative ? (
            <View className="border-t border-border/60">
              <TimingPanel
                value={item.offsetDays ?? null}
                eventDate={eventDate}
                live={false}
                commit={(offset) => onSetOffset(offset)}
                close={close}
              />
            </View>
          ) : null}

          {/* 3 — clear the date entirely. */}
          {item.offsetDays != null ? (
            <>
              <View className="h-px bg-border" />
              <Pressable
                onPress={() => {
                  close();
                  onSetOffset(null);
                }}
                className="flex-row items-center gap-2.5 px-3 py-2.5 active:bg-sunken web:hover:bg-sunken"
              >
                <Icon name="x-circle" size={15} color={colors.muted} />
                <Text className="text-sm font-medium text-muted">Unschedule</Text>
              </Pressable>
            </>
          ) : null}
        </View>
      </Popover>
    </>
  );
}
