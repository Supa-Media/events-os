import { useRef, useState } from "react";
import { View, Text, Pressable, TextInput, Platform, Alert } from "react-native";
import {
  Card,
  Avatar,
  Icon,
  ContextMenu,
  measureAnchor,
  type ContextMenuAnchor,
} from "../ui";
import type { ResolvedModule } from "@events-os/shared";
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

/**
 * One row in the overview's per-module rollup. Normal tap navigates into the
 * module (`onOpen`); right-click (web) / long-press (native) opens a small menu
 * to Disable a core module or Remove a custom one (`onRemove`, confirmed for
 * custom modules).
 */
export function ModuleRollupRow({
  label,
  isCore,
  ready,
  owner,
  summary,
  first,
  onOpen,
  onAssignOwner,
  onRemove,
}: {
  label: string;
  isCore: boolean;
  ready: boolean;
  owner: ModuleOwnerInfo;
  summary: { total: number; done: number; hasStatus: boolean; nextDueDate: number | null } | undefined;
  first: boolean;
  onOpen: () => void;
  onAssignOwner: () => void;
  /** Disable (core) or remove (custom) this module. */
  onRemove: () => void;
}) {
  const total = summary?.total ?? 0;
  const done = summary?.done ?? 0;
  const hasStatus = summary?.hasStatus ?? false;
  const nextDueDate = summary?.nextDueDate ?? null;

  const ref = useRef<any>(null);
  const [anchor, setAnchor] = useState<ContextMenuAnchor | undefined>(undefined);

  function openMenu() {
    measureAnchor(ref.current, setAnchor);
  }

  function handleRemove() {
    if (isCore) {
      onRemove();
      return;
    }
    confirmRemoveModule(onRemove);
  }

  // Web right-click opens the menu; native long-press is the fallback.
  const webProps =
    Platform.OS === "web"
      ? ({
          onContextMenu: (e: any) => {
            e?.preventDefault?.();
            openMenu();
          },
        } as any)
      : {};

  return (
    <View
      ref={ref}
      {...webProps}
      className={`flex-row items-center gap-3 px-4 py-3 ${
        first ? "" : "border-t border-border"
      }`}
    >
      <Pressable
        onPress={onOpen}
        onLongPress={openMenu}
        delayLongPress={300}
        className="flex-1 active:opacity-70"
      >
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

      <ContextMenu
        anchor={anchor}
        onClose={() => setAnchor(undefined)}
        actions={[
          {
            label: isCore ? "Disable" : "Remove",
            icon: isCore ? "slash" : "trash-2",
            destructive: !isCore,
            onPress: handleRemove,
          },
        ]}
      />
    </View>
  );
}

/** Confirm removing a custom module (web `window.confirm`, native `Alert`). */
export function confirmRemoveModule(onConfirm: () => void) {
  if (Platform.OS === "web") {
    if (
      typeof window !== "undefined" &&
      window.confirm("Remove this area and all its items?")
    ) {
      onConfirm();
    }
    return;
  }
  Alert.alert("Remove area?", "This removes the area and its items.", [
    { text: "Cancel", style: "cancel" },
    { text: "Remove", style: "destructive", onPress: onConfirm },
  ]);
}

/**
 * The "＋ Add module" button shown at the bottom of the Modules card. Tapping it
 * opens an anchored menu listing the disabled core modules (each re-enables on
 * press) plus a "New custom module" option that reveals a tiny inline input.
 * Folds in what the old standalone "Add modules" card did.
 */
export function AddModuleButton({
  disabledCore,
  onEnableCore,
  onCreateCustom,
}: {
  disabledCore: ResolvedModule[];
  onEnableCore: (key: string) => void;
  onCreateCustom: (label: string) => void;
}) {
  const ref = useRef<any>(null);
  const [anchor, setAnchor] = useState<ContextMenuAnchor | undefined>(undefined);
  const [adding, setAdding] = useState(false);

  function openMenu() {
    measureAnchor(ref.current, setAnchor);
  }

  return (
    <View className="border-t border-border px-4 py-3">
      {adding ? (
        <AddCustomModuleInput
          onCommit={(label) => {
            const trimmed = label.trim();
            if (trimmed) onCreateCustom(trimmed);
            setAdding(false);
          }}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <View className="flex-row" ref={ref}>
          <Pressable
            onPress={openMenu}
            accessibilityRole="button"
            accessibilityLabel="Add area"
            className="flex-row items-center gap-1.5 rounded-pill border border-dashed border-border-strong bg-raised px-3 py-1.5 active:opacity-80 web:hover:border-accent"
          >
            <Icon name="plus" size={14} color={colors.muted} />
            <Text className="text-sm font-medium text-muted">Add area</Text>
          </Pressable>
        </View>
      )}

      <ContextMenu
        anchor={anchor}
        onClose={() => setAnchor(undefined)}
        actions={[
          ...disabledCore.map((m) => ({
            label: m.label,
            icon: "plus" as const,
            onPress: () => onEnableCore(m.key),
          })),
          {
            label: "New custom area",
            icon: "edit-2" as const,
            onPress: () => setAdding(true),
          },
        ]}
      />
    </View>
  );
}

/** Tiny inline input to name a new custom module. */
export function AddCustomModuleInput({
  onCommit,
  onCancel,
}: {
  onCommit: (label: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState("");
  return (
    <View className="self-start rounded-pill border border-accent bg-raised px-3 py-1.5">
      <TextInput
        value={draft}
        onChangeText={setDraft}
        autoFocus
        placeholder="Area name"
        placeholderTextColor={colors.faint}
        onBlur={() => (draft.trim() ? onCommit(draft) : onCancel())}
        onSubmitEditing={() => onCommit(draft)}
        blurOnSubmit
        className="text-sm text-ink"
        style={{ minWidth: 140, outlineWidth: 0 } as any}
      />
    </View>
  );
}
