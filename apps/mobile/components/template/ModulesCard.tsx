import { useRef, useState } from "react";
import { View, Text, Pressable, TextInput, Platform, Alert } from "react-native";
import { useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import type { ResolvedModule } from "@events-os/shared";
import {
  Card,
  Icon,
  SectionHeader,
  RolePicker,
  ContextMenu,
  measureAnchor,
  type ContextMenuAnchor,
} from "../ui";
import { colors } from "../../lib/theme";

type Role = { _id: string; label: string; key: string };
type CustomRow = { _id: string; key: string; label: string; ownerRoleKey?: string };

/**
 * TEMPLATE MODULES editor — Core (platform built-ins) and Custom (author-created)
 * modules, both shown as compact chips. Right-click (web) / long-press (native)
 * a chip to open its menu: Rename, Set owner, and Disable (core) / Delete
 * (custom). The owning role is shown inline as a "· Owner" suffix. The bottom
 * "Add module" button re-enables a disabled core module or creates a new custom
 * one — mirroring the event overview.
 */
export function ModulesCard({
  eventTypeId,
  active,
  disabledCore,
  customRows,
  roles,
}: {
  eventTypeId: Id<"eventTypes">;
  active: ResolvedModule[];
  disabledCore: ResolvedModule[];
  customRows: CustomRow[];
  roles: Role[];
}) {
  const toggleCore = useMutation(api.modules.toggleCoreForTemplate);
  const renameCore = useMutation(api.modules.renameCoreForTemplate);
  const setOwner = useMutation(api.modules.setOwnerForTemplate);
  const createCustom = useMutation(api.modules.createCustomForTemplate);
  const updateCustom = useMutation(api.modules.updateCustomForTemplate);
  const deleteCustom = useMutation(api.modules.deleteCustomForTemplate);

  const customById = new Map(customRows.map((r) => [r.key, r]));

  // The chip whose menu is open, plus its measured anchor rect.
  const [menu, setMenu] = useState<{ key: string; anchor: ContextMenuAnchor } | null>(
    null,
  );
  // The chip currently being renamed inline.
  const [editingKey, setEditingKey] = useState<string | null>(null);
  // The module whose owner role we're picking.
  const [ownerKey, setOwnerKey] = useState<string | null>(null);

  const menuModule = active.find((m) => m.key === menu?.key) ?? null;
  const ownerModule = active.find((m) => m.key === ownerKey) ?? null;

  function rename(module: ResolvedModule, label: string) {
    if (module.isCore) {
      void renameCore({ eventTypeId, key: module.key, label });
    } else {
      const row = customById.get(module.key);
      if (row) void updateCustom({ moduleId: row._id as Id<"templateModules">, label });
    }
  }

  function removeModule(module: ResolvedModule) {
    if (module.isCore) {
      void toggleCore({ eventTypeId, key: module.key, enabled: false });
    } else {
      const row = customById.get(module.key);
      if (row)
        confirmRemoveModule(() =>
          void deleteCustom({ moduleId: row._id as Id<"templateModules"> }),
        );
    }
  }

  return (
    <Card className="mb-2">
      <SectionHeader title="Modules" />
      <Text className="mb-3 text-sm text-muted">
        Right-click a chip to rename, set its owner, or disable it; use Add module
        to re-enable a core module or create a custom one.
      </Text>

      <View className="flex-row flex-wrap items-center gap-2">
        {active.map((m) => {
          const ownerRole = roles.find((r) => r.key === m.ownerRoleKey);
          return (
            <ModuleChip
              key={m.key}
              label={m.label}
              ownerLabel={ownerRole?.label}
              editing={editingKey === m.key}
              onOpenMenu={(anchor) => setMenu({ key: m.key, anchor })}
              onCommitRename={(label) => {
                const trimmed = label.trim();
                if (trimmed && trimmed !== m.label) rename(m, trimmed);
                setEditingKey(null);
              }}
            />
          );
        })}
      </View>

      <AddModuleButton
        disabledCore={disabledCore}
        onEnableCore={(key) => toggleCore({ eventTypeId, key, enabled: true })}
        onCreateCustom={(label) => createCustom({ eventTypeId, label })}
      />

      {/* Chip context menu: Rename / Set owner / Disable|Delete. */}
      <ContextMenu
        anchor={menu?.anchor}
        onClose={() => setMenu(null)}
        actions={
          menuModule
            ? [
                {
                  label: "Rename",
                  icon: "edit-2",
                  onPress: () => setEditingKey(menuModule.key),
                },
                {
                  label: "Set owner",
                  icon: "shield",
                  onPress: () => setOwnerKey(menuModule.key),
                },
                {
                  label: menuModule.isCore ? "Disable" : "Delete",
                  icon: menuModule.isCore ? "slash" : "trash-2",
                  destructive: !menuModule.isCore,
                  onPress: () => removeModule(menuModule),
                },
              ]
            : []
        }
      />

      {/* Owner role picker. */}
      <RolePicker
        visible={ownerModule !== null}
        title="Set owning role"
        roles={roles}
        selectedId={
          ownerModule
            ? (roles.find((r) => r.key === ownerModule.ownerRoleKey)?._id ?? null)
            : null
        }
        onPick={(roleId) => {
          const role = roles.find((r) => r._id === roleId);
          if (ownerModule && role)
            void setOwner({
              eventTypeId,
              key: ownerModule.key,
              ownerRoleKey: role.key,
            });
          setOwnerKey(null);
        }}
        onClear={
          ownerModule?.ownerRoleKey
            ? () => {
                void setOwner({
                  eventTypeId,
                  key: ownerModule.key,
                  ownerRoleKey: null,
                });
                setOwnerKey(null);
              }
            : undefined
        }
        onClose={() => setOwnerKey(null)}
      />
    </Card>
  );
}

/** One module chip: tap is inert, right-click/long-press opens the menu. */
function ModuleChip({
  label,
  ownerLabel,
  editing,
  onOpenMenu,
  onCommitRename,
}: {
  label: string;
  ownerLabel?: string;
  editing: boolean;
  onOpenMenu: (anchor: ContextMenuAnchor) => void;
  onCommitRename: (label: string) => void;
}) {
  const ref = useRef<any>(null);
  const [draft, setDraft] = useState(label);

  function open() {
    measureAnchor(ref.current, onOpenMenu);
  }

  if (editing) {
    return (
      <View
        ref={ref}
        className="rounded-pill border border-accent bg-raised px-3 py-1.5"
      >
        <TextInput
          value={draft}
          onChangeText={setDraft}
          autoFocus
          placeholderTextColor={colors.faint}
          onBlur={() => onCommitRename(draft)}
          onSubmitEditing={() => onCommitRename(draft)}
          blurOnSubmit
          className="text-sm font-semibold text-ink"
          style={{ minWidth: 100, outlineWidth: 0 } as any}
        />
      </View>
    );
  }

  // Web right-click opens the menu; native long-press is the fallback.
  const webProps =
    Platform.OS === "web"
      ? ({
          onContextMenu: (e: any) => {
            e?.preventDefault?.();
            open();
          },
        } as any)
      : {};

  return (
    <Pressable onLongPress={open} delayLongPress={300}>
      <View
        ref={ref}
        {...webProps}
        className="flex-row items-center gap-1.5 rounded-pill border border-border bg-sunken px-3 py-1.5 web:hover:border-border-strong"
      >
        <Text className="text-sm font-semibold text-ink">{label}</Text>
        {ownerLabel ? (
          <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
            · {ownerLabel}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

/**
 * Bottom "Add module" button: opens an anchored menu of disabled core modules
 * (each re-enables on press) plus a "New custom module" option that reveals a
 * tiny inline input.
 */
function AddModuleButton({
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
    <View className="mt-3">
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
            accessibilityLabel="Add module"
            className="flex-row items-center gap-1.5 rounded-pill border border-dashed border-border-strong bg-raised px-3 py-1.5 active:opacity-80 web:hover:border-accent"
          >
            <Icon name="plus" size={14} color={colors.muted} />
            <Text className="text-sm font-medium text-muted">Add module</Text>
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
            label: "New custom module",
            icon: "edit-2" as const,
            onPress: () => setAdding(true),
          },
        ]}
      />
    </View>
  );
}

/** Tiny inline input to name a new custom module. */
function AddCustomModuleInput({
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
        placeholder="Module name"
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

/** Confirm removing a custom template module (web `confirm`, native `Alert`). */
function confirmRemoveModule(onConfirm: () => void) {
  if (Platform.OS === "web") {
    if (
      typeof window !== "undefined" &&
      window.confirm("Delete this module and all its items?")
    ) {
      onConfirm();
    }
    return;
  }
  Alert.alert("Delete module?", "This removes the module and its items.", [
    { text: "Cancel", style: "cancel" },
    { text: "Delete", style: "destructive", onPress: onConfirm },
  ]);
}
