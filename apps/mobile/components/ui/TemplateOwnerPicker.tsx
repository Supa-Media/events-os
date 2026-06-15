import { Modal, View, Text, Pressable, ScrollView } from "react-native";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Icon } from "./Icon";
import { Avatar } from "./Avatar";
import { colors } from "../../lib/theme";

type Props = {
  visible: boolean;
  eventTypeId?: string;
  selectedId?: string | null;
  onPick: (templatePersonId: string, name: string) => void;
  onClear?: () => void;
  onClose: () => void;
};

/**
 * Owner picker for TEMPLATE Expectations — lists the template's PLACEHOLDER crew
 * (templatePeople), not chapter people. Picking reports the chosen id + name so
 * the cell can cache the display name. Crew is authored in the Template Crew
 * card; this picker is read-only over that list.
 */
export function TemplateOwnerPicker({
  visible,
  eventTypeId,
  selectedId,
  onPick,
  onClear,
  onClose,
}: Props) {
  const crew = useQuery(
    api.templatePeople.list,
    eventTypeId ? { eventTypeId: eventTypeId as Id<"eventTypes"> } : "skip",
  );

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        className="flex-1 items-center justify-center bg-ink/30 p-6"
      >
        <Pressable
          onPress={() => {}}
          className="w-full max-w-md overflow-hidden rounded-xl border border-border bg-raised shadow-pop"
        >
          <View className="flex-row items-center justify-between border-b border-border px-5 py-4">
            <Text className="font-display text-lg text-ink">Assign placeholder crew</Text>
            <Pressable onPress={onClose} hitSlop={8} className="rounded-md p-1">
              <Icon name="x" size={18} color={colors.muted} />
            </Pressable>
          </View>

          <ScrollView className="max-h-96">
            {onClear ? (
              <Row label="Clear owner" muted icon="user-x" onPress={onClear} />
            ) : null}

            {crew === undefined ? (
              <Text className="px-5 py-6 text-center text-base text-muted">Loading…</Text>
            ) : crew.length === 0 ? (
              <Text className="px-5 py-6 text-center text-base text-muted">
                No placeholder crew yet. Add some in the Crew card first.
              </Text>
            ) : (
              crew.map((c: any) => (
                <Row
                  key={c._id}
                  label={c.name}
                  sub={c.team}
                  selected={c._id === selectedId}
                  onPress={() => onPick(c._id, c.name)}
                />
              ))
            )}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function Row({
  label,
  sub,
  selected,
  muted,
  icon,
  onPress,
}: {
  label: string;
  sub?: string;
  selected?: boolean;
  muted?: boolean;
  icon?: "user-x";
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      className="flex-row items-center justify-between border-b border-border px-5 py-3 active:bg-sunken web:hover:bg-sunken"
    >
      <View className="flex-row items-center gap-3">
        {muted ? (
          <View className="h-7 w-7 items-center justify-center rounded-pill bg-sunken">
            <Icon name={icon ?? "user"} size={14} color={colors.muted} />
          </View>
        ) : (
          <Avatar name={label} size={28} />
        )}
        <View>
          <Text
            className={`text-base ${
              muted
                ? "text-muted"
                : selected
                  ? "font-semibold text-accent"
                  : "text-ink"
            }`}
          >
            {label}
          </Text>
          {sub ? <Text className="text-xs text-muted">{sub}</Text> : null}
        </View>
      </View>
      {selected ? <Icon name="check" size={16} color={colors.accent} /> : null}
    </Pressable>
  );
}
