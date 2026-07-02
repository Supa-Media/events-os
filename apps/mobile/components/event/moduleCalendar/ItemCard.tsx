/**
 * One item in the day panel — the rich, badge-forward card, shared by every
 * calendar module (a comms send or a planning task). Leads with channel badges
 * (comms) or a status glyph (planning), then title, timing, meta tags, owner,
 * and a tappable status pill. Below, an ALWAYS-present editable box for the
 * item's copy/details, so the body can be written without opening the table.
 */
import { useState } from "react";
import { View, Text, Pressable, TextInput } from "react-native";
import { commsTimingLabel } from "@events-os/shared";
import { Card, OptionTag } from "../../ui";
import { Icon } from "../../ui/Icon";
import { colors } from "../../../lib/theme";
import { optionColor } from "../../../lib/optionColor";
import { asArray, statusIcon, type ScheduleItem, type SelectOption } from "./config";
import { ChannelBadge } from "./badges";

export type MetaField = { field: string; map: Map<string, SelectOption> };

export function ItemCard({
  item,
  statusMap,
  badgeField,
  badgeMap,
  metas,
  copyLabel,
  copyPlaceholder,
  initialCopy,
  onCycleStatus,
  onSaveCopy,
}: {
  item: ScheduleItem;
  statusMap: Map<string, SelectOption>;
  badgeField: string | null;
  badgeMap?: Map<string, SelectOption>;
  metas: MetaField[];
  copyLabel: string;
  copyPlaceholder: string;
  initialCopy: string;
  onCycleStatus: () => void;
  onSaveCopy: (copy: string) => void;
}) {
  const statusOpt = item.status ? statusMap.get(item.status) : undefined;
  const badges = badgeField ? asArray(item.fields?.[badgeField]) : [];

  return (
    <Card padding="md">
      <View className="flex-row items-start gap-3">
        {/* Leading badges — WHERE this goes (comms) or its status (planning). */}
        <View className="flex-row flex-wrap gap-1" style={{ maxWidth: 56 }}>
          {badges.length > 0 && badgeMap ? (
            badges.map((b) => (
              <ChannelBadge key={b} value={b} option={badgeMap.get(b)} />
            ))
          ) : (
            <StatusIconBadge option={statusOpt} />
          )}
        </View>

        <View className="flex-1">
          <Text className="text-sm font-semibold text-ink" numberOfLines={2}>
            {item.title || "Untitled"}
          </Text>

          {/* Timing relative to the event (day-granular). */}
          <View className="mt-1 flex-row items-center gap-1">
            <Icon name="clock" size={11} color={colors.faint} />
            <Text className="text-xs text-muted">
              {commsTimingLabel(item.offsetDays)}
            </Text>
          </View>

          {/* Meta tag chips (e.g. audience). */}
          {metas.map(({ field, map }) => {
            const values = asArray(item.fields?.[field]);
            if (values.length === 0) return null;
            return (
              <View key={field} className="mt-1.5 flex-row flex-wrap gap-1">
                {values.map((v) => (
                  <OptionTag
                    key={v}
                    label={map.get(v)?.label ?? v}
                    color={map.get(v)?.color}
                  />
                ))}
              </View>
            );
          })}

          {item.owner ? (
            <View className="mt-1.5 flex-row items-center gap-1">
              <Icon name="user" size={11} color={colors.faint} />
              <Text className="text-xs text-muted" numberOfLines={1}>
                {item.owner.name}
              </Text>
            </View>
          ) : null}
        </View>

        <StatusPill option={statusOpt} onPress={onCycleStatus} />
      </View>

      <CopyEditor
        label={copyLabel}
        placeholder={copyPlaceholder}
        initial={initialCopy}
        onSave={onSaveCopy}
      />
    </Card>
  );
}

/** Fallback lead when there are no badges — the item's status as a glyph badge. */
function StatusIconBadge({ option }: { option?: SelectOption }) {
  const c = optionColor(option?.color);
  return (
    <View
      className="h-[22px] w-[22px] items-center justify-center rounded-md"
      style={{ backgroundColor: c.bg }}
    >
      <Icon name={statusIcon(option?.value)} size={13} color={c.text} />
    </View>
  );
}

/** Tappable status chip; advancing wraps through the status column's values. */
function StatusPill({
  option,
  onPress,
}: {
  option?: SelectOption;
  onPress: () => void;
}) {
  const c = optionColor(option?.color);
  return (
    <Pressable onPress={onPress} hitSlop={6} className="active:opacity-70">
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

/**
 * The always-present copy/details box. Shows the body when set and a prompt when
 * empty; commits on blur so a stray tap never loses an edit. Seeded once from the
 * item — our own save keeps it in sync, which is all this fast path needs.
 */
function CopyEditor({
  label,
  placeholder,
  initial,
  onSave,
}: {
  label: string;
  placeholder: string;
  initial: string;
  onSave: (copy: string) => void;
}) {
  const [value, setValue] = useState(initial);
  const [focused, setFocused] = useState(false);

  const commit = () => {
    setFocused(false);
    const next = value.trim();
    if (next !== initial.trim()) onSave(next);
  };

  return (
    <View className="mt-2 border-t border-border pt-2">
      <View className="mb-1 flex-row items-center gap-1">
        <Icon name="edit-3" size={10} color={colors.faint} />
        <Text className="text-2xs font-bold uppercase tracking-wider text-faint">
          {label}
        </Text>
      </View>
      <TextInput
        value={value}
        onChangeText={setValue}
        onFocus={() => setFocused(true)}
        onBlur={commit}
        placeholder={placeholder}
        placeholderTextColor={colors.faint}
        multiline
        textAlignVertical="top"
        className={`rounded-md border bg-sunken px-2.5 py-2 text-xs text-ink ${
          focused ? "border-accent" : "border-border"
        }`}
        style={{ minHeight: 44 }}
      />
    </View>
  );
}
