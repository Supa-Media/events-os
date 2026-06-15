import { View, Text, Pressable } from "react-native";
import { Card, Avatar, Icon } from "../ui";
import { colors } from "../../lib/theme";
import { formatDate } from "../../lib/format";

export type ModuleOwnerInfo = {
  roleId: string;
  roleLabel: string;
  person: { _id: string; name: string } | null;
} | null;

/**
 * The owning role for a module, rendered as "ROLE → person" (or an Assign
 * affordance). Tapping opens the same role PersonPicker used elsewhere, so
 * setting a module's owner just assigns that role on the event.
 */
export function OwnerChip({
  owner,
  onPress,
}: {
  owner: ModuleOwnerInfo;
  onPress: () => void;
}) {
  if (!owner) {
    return <Text className="text-2xs text-faint">No owning role</Text>;
  }
  return (
    <Pressable
      onPress={onPress}
      className="flex-row items-center gap-2 active:opacity-70"
    >
      <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
        {owner.roleLabel}
      </Text>
      {owner.person ? (
        <View className="flex-row items-center gap-1.5">
          <Avatar name={owner.person.name} size={18} />
          <Text className="text-sm text-ink">{owner.person.name}</Text>
        </View>
      ) : (
        <View className="flex-row items-center gap-1">
          <Icon name="user-plus" size={13} color={colors.muted} />
          <Text className="text-sm text-faint">Assign</Text>
        </View>
      )}
    </Pressable>
  );
}

/** The owner banner shown above a single module's grid. */
export function ModuleOwnerBar({
  owner,
  onPress,
}: {
  owner: ModuleOwnerInfo;
  onPress: () => void;
}) {
  if (!owner) return null;
  return (
    <Card padding="sm" className="mt-2">
      <View className="flex-row items-center gap-2">
        <Icon name="shield" size={14} color={colors.muted} />
        <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
          Owner
        </Text>
        <View className="flex-1" />
        <OwnerChip owner={owner} onPress={onPress} />
      </View>
    </Card>
  );
}

/** One row in the overview's per-module rollup. */
export function ModuleRollupRow({
  label,
  ready,
  owner,
  summary,
  first,
  onOpen,
  onAssignOwner,
}: {
  label: string;
  ready: boolean;
  owner: ModuleOwnerInfo;
  summary: { total: number; done: number; hasStatus: boolean; nextDueDate: number | null } | undefined;
  first: boolean;
  onOpen: () => void;
  onAssignOwner: () => void;
}) {
  const total = summary?.total ?? 0;
  const done = summary?.done ?? 0;
  const hasStatus = summary?.hasStatus ?? false;
  const nextDueDate = summary?.nextDueDate ?? null;
  return (
    <View
      className={`flex-row items-center gap-3 px-4 py-3 ${
        first ? "" : "border-t border-border"
      }`}
    >
      <Pressable onPress={onOpen} className="flex-1 active:opacity-70">
        <View className="flex-row items-center gap-1.5">
          <Text className="text-sm font-semibold text-ink">{label}</Text>
          {ready ? (
            <Icon name="check-circle" size={13} color={colors.success} />
          ) : null}
        </View>
        <View className="mt-0.5 flex-row flex-wrap items-center gap-x-3 gap-y-0.5">
          <Text className="text-2xs text-muted">
            {hasStatus
              ? `${done}/${total} done`
              : `${total} item${total === 1 ? "" : "s"}`}
          </Text>
          {nextDueDate ? (
            <Text className="text-2xs text-faint">
              Next due {formatDate(nextDueDate)}
            </Text>
          ) : null}
        </View>
      </Pressable>
      <OwnerChip owner={owner} onPress={onAssignOwner} />
      <Pressable onPress={onOpen} className="active:opacity-70">
        <Icon name="chevron-right" size={16} color={colors.faint} />
      </Pressable>
    </View>
  );
}
