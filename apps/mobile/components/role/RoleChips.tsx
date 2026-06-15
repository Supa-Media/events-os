import { useRef, useState } from "react";
import { View, Text, Pressable, TextInput, Platform, Alert } from "react-native";
import { Icon, Popover } from "../ui";
import { colors } from "../../lib/theme";

/**
 * A compact, single-row chip editor for a list of roles — used identically on
 * the event page and the template editor.
 *
 * Each role is a chip. Right-click (web) / long-press (native) opens a small
 * Popover menu with Rename and Delete. Rename swaps the chip into an inline
 * text field (commit on blur/Enter). Delete confirms first (web `window.confirm`
 * / native `Alert.alert`). A trailing "＋" chip adds a new role via a tiny inline
 * input. All mutations are routed back through the `onRename` / `onDelete` /
 * `onAdd` callbacks so the event/template sides can wire their own Convex
 * mutations without duplicating the menu logic.
 */

export type RoleChipItem = { _id: string; label: string };

export type ChipAnchor = { x: number; y: number; width: number; height: number };

/**
 * Measure a node into window coords and hand the rect to `cb`. Shared by the
 * chip context-menu openers on both the event and template sides. Falls back to
 * a zero rect (centered popover) when measurement isn't available.
 */
export function measureAnchor(node: any, cb: (anchor: ChipAnchor) => void) {
  if (node && typeof node.measureInWindow === "function") {
    node.measureInWindow((x: number, y: number, width: number, height: number) =>
      cb({ x, y, width, height }),
    );
  } else {
    cb({ x: 0, y: 0, width: 0, height: 0 });
  }
}

export function RoleChips({
  roles,
  onRename,
  onDelete,
  onAdd,
}: {
  roles: RoleChipItem[];
  onRename: (roleId: string, label: string) => void;
  onDelete: (roleId: string) => void;
  onAdd: (label: string) => void;
}) {
  // The chip whose context menu is open (id + measured anchor rect).
  const [menu, setMenu] = useState<{
    roleId: string;
    anchor: ChipAnchor;
  } | null>(null);
  // The chip currently being renamed inline.
  const [editingId, setEditingId] = useState<string | null>(null);
  // The trailing add-input, when open.
  const [adding, setAdding] = useState(false);

  const menuRole = roles.find((r) => r._id === menu?.roleId) ?? null;

  return (
    <View className="flex-row flex-wrap items-center gap-2">
      {roles.map((r) => (
        <RoleChip
          key={r._id}
          role={r}
          editing={editingId === r._id}
          onOpenMenu={(anchor) => setMenu({ roleId: r._id, anchor })}
          onCommitRename={(label) => {
            const trimmed = label.trim();
            if (trimmed && trimmed !== r.label) onRename(r._id, trimmed);
            setEditingId(null);
          }}
        />
      ))}

      {adding ? (
        <AddRoleInput
          onCommit={(label) => {
            const trimmed = label.trim();
            if (trimmed) onAdd(trimmed);
            setAdding(false);
          }}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <Pressable
          onPress={() => setAdding(true)}
          accessibilityRole="button"
          accessibilityLabel="Add role"
          className="flex-row items-center gap-1 rounded-pill border border-dashed border-border-strong bg-raised px-2.5 py-1.5 active:opacity-80 web:hover:border-accent"
        >
          <Icon name="plus" size={14} color={colors.muted} />
        </Pressable>
      )}

      {/* Right-click / long-press menu for the active chip. */}
      <RoleChipMenu
        anchor={menu?.anchor}
        onClose={() => setMenu(null)}
        onRename={() => {
          if (menuRole) setEditingId(menuRole._id);
          setMenu(null);
        }}
        onDelete={() => {
          setMenu(null);
          if (menuRole) confirmDeleteRole(() => onDelete(menuRole._id));
        }}
      />
    </View>
  );
}

/**
 * The shared Rename/Delete popover menu for a role chip. Reused by both the
 * generic `RoleChips` (template) and the event overview's role chips.
 */
export function RoleChipMenu({
  anchor,
  onClose,
  onRename,
  onDelete,
}: {
  anchor?: { x: number; y: number; width: number; height: number };
  onClose: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  return (
    <Popover visible={anchor !== undefined} anchor={anchor} width={160} onClose={onClose}>
      <MenuRow icon="edit-2" label="Rename" onPress={onRename} />
      <MenuRow icon="trash-2" label="Delete" danger onPress={onDelete} />
    </Popover>
  );
}

/** Confirm a role delete (web `window.confirm`, native `Alert.alert`). */
export function confirmDeleteRole(onConfirm: () => void) {
  if (Platform.OS === "web") {
    if (typeof window !== "undefined" && window.confirm("Delete this role?")) {
      onConfirm();
    }
    return;
  }
  Alert.alert("Delete role?", "This removes the role from this list.", [
    { text: "Cancel", style: "cancel" },
    { text: "Delete", style: "destructive", onPress: onConfirm },
  ]);
}

/** One role chip: tap is inert, right-click/long-press opens the menu. */
function RoleChip({
  role,
  editing,
  onOpenMenu,
  onCommitRename,
}: {
  role: RoleChipItem;
  editing: boolean;
  onOpenMenu: (anchor: ChipAnchor) => void;
  onCommitRename: (label: string) => void;
}) {
  const ref = useRef<any>(null);
  const [draft, setDraft] = useState(role.label);

  function open() {
    measureAnchor(ref.current, onOpenMenu);
  }

  if (editing) {
    return (
      <View
        ref={ref}
        className="rounded-pill border border-accent bg-raised px-2.5 py-1.5"
      >
        <TextInput
          value={draft}
          onChangeText={setDraft}
          autoFocus
          placeholderTextColor={colors.faint}
          onBlur={() => onCommitRename(draft)}
          onSubmitEditing={() => onCommitRename(draft)}
          blurOnSubmit
          className="text-2xs font-bold uppercase tracking-wider text-ink"
          style={{ minWidth: 70, outlineWidth: 0 } as any}
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
        className="rounded-pill border border-border bg-sunken px-2.5 py-1.5 web:hover:border-border-strong"
      >
        <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
          {role.label}
        </Text>
      </View>
    </Pressable>
  );
}

/** Tiny inline input shown by the "＋" chip to name a new role. */
function AddRoleInput({
  onCommit,
  onCancel,
}: {
  onCommit: (label: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState("");
  return (
    <View className="rounded-pill border border-accent bg-raised px-2.5 py-1.5">
      <TextInput
        value={draft}
        onChangeText={setDraft}
        autoFocus
        placeholder="Role name"
        placeholderTextColor={colors.faint}
        onBlur={() => (draft.trim() ? onCommit(draft) : onCancel())}
        onSubmitEditing={() => onCommit(draft)}
        blurOnSubmit
        className="text-2xs font-bold uppercase tracking-wider text-ink"
        style={{ minWidth: 80, outlineWidth: 0 } as any}
      />
    </View>
  );
}

/** A row inside the context-menu popover. */
function MenuRow({
  icon,
  label,
  danger,
  onPress,
}: {
  icon: "edit-2" | "trash-2";
  label: string;
  danger?: boolean;
  onPress: () => void;
}) {
  const tint = danger ? colors.danger : colors.ink;
  return (
    <Pressable
      onPress={onPress}
      className="flex-row items-center gap-2 px-3 py-2.5 active:bg-sunken web:hover:bg-sunken"
    >
      <Icon name={icon} size={14} color={danger ? colors.danger : colors.muted} />
      <Text className="text-sm" style={{ color: tint }}>
        {label}
      </Text>
    </Pressable>
  );
}
