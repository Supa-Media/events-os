/**
 * The card's status + channel affordances: the leading status glyph (planning),
 * the trailing status pill, a status option row for the picker, and the channel
 * multiselect editor (comms). All open the same option data the table uses.
 */
import { useRef, useState } from "react";
import { View, Text, Pressable } from "react-native";
import { Icon, type IconName } from "../../ui/Icon";
import { Popover } from "../../ui/Popover";
import type { AnchorRect } from "../../ui/useAnchor";
import { colors } from "../../../lib/theme";
import { optionColor } from "../../../lib/optionColor";
import { statusIcon, type CalendarColumn, type SelectOption } from "./config";
import { ChannelBadge } from "./badges";

/** Fallback lead when there are no badges — the status glyph, tap to change. */
export function StatusIconBadge({
  option,
  onPress,
}: {
  option?: SelectOption;
  onPress: (node: any) => void;
}) {
  const ref = useRef<any>(null);
  const c = optionColor(option?.color);
  return (
    <Pressable
      ref={ref}
      onPress={() => onPress(ref.current)}
      hitSlop={6}
      className="h-[22px] w-[22px] items-center justify-center rounded-md active:opacity-70"
      style={{ backgroundColor: c.bg }}
    >
      <Icon name={statusIcon(option?.value)} size={13} color={c.text} />
    </Pressable>
  );
}

/** Tappable status chip; opens the status picker (same options as the table). */
export function StatusPill({
  option,
  onPress,
}: {
  option?: SelectOption;
  onPress: (node: any) => void;
}) {
  const ref = useRef<any>(null);
  const c = optionColor(option?.color);
  return (
    <Pressable
      ref={ref}
      onPress={() => onPress(ref.current)}
      hitSlop={6}
      className="active:opacity-70"
    >
      <View
        className="flex-row items-center gap-1 rounded-pill px-2.5 py-1"
        style={{ backgroundColor: c.bg }}
      >
        <Icon name={statusIcon(option?.value)} size={12} color={c.text} />
        <Text className="text-2xs font-bold" style={{ color: c.text }}>
          {option?.label ?? "Set status"}
        </Text>
      </View>
    </Pressable>
  );
}

/** A status option row — glyph in the option's color, check when current. */
export function StatusRow({
  label,
  color,
  icon,
  selected,
  muted,
  onPress,
}: {
  label: string;
  color?: string | null;
  icon?: IconName;
  selected?: boolean;
  muted?: boolean;
  onPress: () => void;
}) {
  const c = optionColor(color ?? undefined);
  return (
    <Pressable
      onPress={onPress}
      className="flex-row items-center justify-between gap-3 px-3 py-2 active:bg-sunken web:hover:bg-sunken"
    >
      {muted ? (
        <Text className="text-sm text-muted">{label}</Text>
      ) : (
        <View
          className="flex-row items-center gap-1.5 self-start rounded-pill px-2.5 py-1"
          style={{ backgroundColor: c.bg }}
        >
          {icon ? <Icon name={icon} size={12} color={c.text} /> : null}
          <Text className="text-2xs font-bold" style={{ color: c.text }}>
            {label}
          </Text>
        </View>
      )}
      {selected ? <Icon name="check" size={15} color={colors.accent} /> : null}
    </Pressable>
  );
}

/** Channel multiselect for the badge cluster; commits when the popover closes. */
export function BadgeEditor({
  column,
  initial,
  anchor,
  onSave,
  onClose,
}: {
  column: CalendarColumn;
  initial: string[];
  anchor?: AnchorRect;
  onSave: (value: unknown) => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<string[]>(initial);
  const opts = (column.options ?? []) as SelectOption[];

  const commit = () => {
    const changed =
      selected.length !== initial.length ||
      selected.some((v) => !initial.includes(v));
    if (changed) onSave(selected.length > 0 ? selected : null);
    else onClose();
  };

  return (
    <Popover visible onClose={commit} anchor={anchor} width={220}>
      <View className="py-1">
        {opts.map((o) => (
          <Pressable
            key={o.value}
            onPress={() =>
              setSelected((cur) =>
                cur.includes(o.value)
                  ? cur.filter((v) => v !== o.value)
                  : [...cur, o.value],
              )
            }
            className="flex-row items-center justify-between gap-3 px-3 py-2 active:bg-sunken web:hover:bg-sunken"
          >
            <View className="flex-row items-center gap-2">
              <ChannelBadge value={o.value} option={o} size={20} />
              <Text className="text-sm text-ink">{o.label}</Text>
            </View>
            {selected.includes(o.value) ? (
              <Icon name="check" size={15} color={colors.accent} />
            ) : null}
          </Pressable>
        ))}
      </View>
    </Popover>
  );
}
