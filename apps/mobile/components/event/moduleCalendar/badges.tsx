/**
 * Badge visuals shared across the calendar: a square logo badge, an overlapping
 * cluster of logos (for tight day cells), and a compact legend. Comms uses these
 * for channels; any module can pass its own entries to the legend.
 */
import { View, Text } from "react-native";
import { Icon, type IconName } from "../../ui/Icon";
import { colors } from "../../../lib/theme";
import { optionColor } from "../../../lib/optionColor";
import { channelIcon, type SelectOption } from "./config";

/** A small square channel badge — icon in the channel's option color. */
export function ChannelBadge({
  value,
  option,
  size = 22,
}: {
  value: string;
  option?: SelectOption;
  size?: number;
}) {
  const c = optionColor(option?.color);
  return (
    <View
      className="items-center justify-center rounded-md"
      style={{ width: size, height: size, backgroundColor: c.bg }}
    >
      <Icon name={channelIcon(value)} size={Math.round(size * 0.55)} color={c.text} />
    </View>
  );
}

/**
 * Overlapping stack of channel logos — the compact way to show EVERY channel a
 * send goes out on inside a narrow day cell. Each channel is a solid, brand-
 * colored pip with a ring that punches it out of its neighbour (avatar-stack
 * style). Past `max`, the tail collapses into a "+n" pip.
 */
export function ChannelCluster({
  channels,
  channelMap,
  size = 16,
  max = 4,
  ring = colors.raised,
}: {
  channels: string[];
  channelMap: Map<string, SelectOption>;
  size?: number;
  max?: number;
  ring?: string;
}) {
  if (channels.length === 0) return null;
  const shown = channels.slice(0, max);
  const overflow = channels.length - shown.length;
  const overlap = Math.round(size * 0.34);

  return (
    <View className="flex-row items-center">
      {shown.map((ch, i) => {
        const c = optionColor(channelMap.get(ch)?.color);
        return (
          <View
            key={ch}
            className="items-center justify-center rounded-full"
            style={{
              width: size,
              height: size,
              backgroundColor: c.text, // solid brand hue so the logo pops
              borderWidth: 1.5,
              borderColor: ring,
              marginLeft: i === 0 ? 0 : -overlap,
              zIndex: shown.length - i, // leftmost logo sits on top
            }}
          >
            <Icon
              name={channelIcon(ch)}
              size={Math.round(size * 0.5)}
              color={colors.raised}
            />
          </View>
        );
      })}
      {overflow > 0 ? (
        <View
          className="items-center justify-center rounded-full bg-sunken"
          style={{
            width: size,
            height: size,
            borderWidth: 1.5,
            borderColor: ring,
            marginLeft: -overlap,
          }}
        >
          <Text className="font-bold text-muted" style={{ fontSize: size * 0.42 }}>
            +{overflow}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

export type LegendEntry = { icon: IconName; color: string; label: string };

/** A compact key beneath the grid — what the leading glyphs/colours mean. */
export function Legend({ entries }: { entries: LegendEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <View className="mt-3 flex-row flex-wrap items-center gap-x-4 gap-y-1.5 px-1">
      {entries.map((e) => (
        <View key={e.label} className="flex-row items-center gap-1.5">
          <Icon name={e.icon} size={13} color={e.color} />
          <Text className="text-xs text-muted">{e.label}</Text>
        </View>
      ))}
    </View>
  );
}
