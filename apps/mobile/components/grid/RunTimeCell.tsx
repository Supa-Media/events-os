/**
 * RunTimeCell — the run-of-show TIME column cell.
 *
 * Shows the segment's wall-clock time as a chip; clicking opens the on-brand
 * typed {@link TimeEntryPanel} in a popover. TIME is stored as a signed minute
 * offset from the event start, so without an event date to anchor against the
 * cell is read-only formatted text.
 */
import { View, Text, Pressable } from "react-native";
import { computeRunTime, formatOffsetMinutes } from "@events-os/shared";
import { formatTime } from "../../lib/format";
import { colors } from "../../lib/theme";
import { Icon } from "../ui/Icon";
import { Popover } from "../ui/Popover";
import { useAnchor } from "../ui/useAnchor";
import { TimeEntryPanel } from "./TimeEntryPanel";

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
