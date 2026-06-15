import { useRef, useState } from "react";
import { View, Text, Pressable, TextInput, Platform } from "react-native";
import { Card, Button, Avatar, Icon, statusTone } from "../ui";
import { colors } from "../../lib/theme";
import { parseDateInput } from "../../lib/format";
import {
  EVENT_STATUSES,
  EVENT_STATUS_LABELS,
  type EventStatus,
} from "@events-os/shared";
import { WebDateTimeInput } from "./EventHeader";
import {
  RoleChipMenu,
  confirmDeleteRole,
  measureAnchor,
  type ChipAnchor,
} from "../role/RoleChips";

type RoleRow = {
  roleId: string;
  roleLabel: string;
  person: { _id: string; name: string } | null;
};

/**
 * The overview's horizontal controls strip: roles, status, schedule, owner,
 * budget, and the delete affordance. Pure presentation — all edits are routed
 * back to the screen through callbacks.
 */
export function EventOverviewControls({
  event,
  roleRows,
  owner,
  dateValue,
  budgetValue,
  onPickRole,
  onSetStatus,
  onReschedule,
  onChangeDate,
  onSaveDate,
  onOpenOwner,
  onChangeBudget,
  onSaveBudget,
  onDelete,
  onRenameRole,
  onDeleteRole,
  onAddRole,
}: {
  event: any;
  roleRows: RoleRow[];
  owner: { _id: string; name: string } | null;
  dateValue: string;
  budgetValue: string;
  onPickRole: (role: RoleRow) => void;
  onSetStatus: (status: EventStatus) => void;
  onReschedule: (ts: number) => void;
  onChangeDate: (text: string) => void;
  onSaveDate: () => void;
  onOpenOwner: () => void;
  onChangeBudget: (text: string) => void;
  onSaveBudget: () => void;
  onDelete: () => void;
  onRenameRole: (roleId: string, label: string) => void;
  onDeleteRole: (roleId: string) => void;
  onAddRole: (label: string) => void;
}) {
  return (
    <Card padding="md" className="mb-6">
      <View className="flex-row flex-wrap items-start gap-x-6 gap-y-4">
        {/* Roles — inline chips: tap = assign, right-click/long-press = menu */}
        <ControlBlock label="Roles" count={roleRows.length || undefined}>
          <RolesControl
            roleRows={roleRows}
            onPickRole={onPickRole}
            onRenameRole={onRenameRole}
            onDeleteRole={onDeleteRole}
            onAddRole={onAddRole}
          />
        </ControlBlock>

        {/* Status — inline chips */}
        <ControlBlock label="Status">
          <View className="flex-row flex-wrap gap-2">
            {EVENT_STATUSES.map((s) => (
              <StatusChip
                key={s}
                label={EVENT_STATUS_LABELS[s]}
                tone={statusTone(s)}
                selected={event.status === s}
                onPress={() => onSetStatus(s)}
              />
            ))}
          </View>
        </ControlBlock>

        {/* Schedule — date + time picker (native datetime-local on web) */}
        <ControlBlock label="Schedule">
          {Platform.OS === "web" ? (
            <WebDateTimeInput value={event.eventDate} onChange={onReschedule} />
          ) : (
            <View className="flex-row items-center gap-2">
              <InlineInput
                value={dateValue}
                onChangeText={onChangeDate}
                onBlur={onSaveDate}
                placeholder="YYYY-MM-DD"
                autoCapitalize="none"
                width={120}
              />
              <Button
                title="Save"
                icon="calendar"
                size="sm"
                variant="secondary"
                onPress={onSaveDate}
                disabled={parseDateInput(dateValue) === null}
              />
            </View>
          )}
          <Text className="mt-1 text-2xs text-faint">Reflows due dates.</Text>
        </ControlBlock>

        {/* Owner — the single accountable person */}
        <ControlBlock label="Owner">
          <Pressable
            onPress={onOpenOwner}
            className="flex-row items-center gap-2 active:opacity-70"
          >
            {owner ? (
              <>
                <Avatar name={owner.name} size={22} />
                <Text className="text-sm font-medium text-ink">{owner.name}</Text>
              </>
            ) : (
              <>
                <Icon name="user-plus" size={15} color={colors.muted} />
                <Text className="text-sm text-muted">Assign owner</Text>
              </>
            )}
          </Pressable>
          <Text className="mt-1 text-2xs text-faint">Keeps details current.</Text>
        </ControlBlock>

        {/* Budget — inline numeric field */}
        <ControlBlock label="Budget">
          <View className="flex-row items-center gap-2">
            <InlineInput
              value={budgetValue}
              onChangeText={onChangeBudget}
              onBlur={onSaveBudget}
              placeholder="0"
              keyboardType="numeric"
              width={80}
            />
            <Button
              title="Save"
              icon="check"
              size="sm"
              variant="secondary"
              onPress={onSaveBudget}
            />
          </View>
          <Text className="mt-1 text-2xs text-faint">Blank clears.</Text>
        </ControlBlock>

        {/* Danger — delete affordance */}
        <ControlBlock label="Danger">
          <Button
            title="Delete"
            icon="trash-2"
            size="sm"
            variant="danger"
            onPress={onDelete}
          />
        </ControlBlock>
      </View>
    </Card>
  );
}

/** A compact labelled block in the horizontal controls strip. */
function ControlBlock({
  label,
  count,
  children,
}: {
  label: string;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <View className="gap-2">
      <View className="flex-row items-baseline gap-1.5">
        <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
          {label}
        </Text>
        {count !== undefined ? (
          <Text className="text-2xs font-semibold text-faint">{count}</Text>
        ) : null}
      </View>
      {children}
    </View>
  );
}

/** A small bordered text input for the controls strip (no label/hint chrome). */
function InlineInput({
  width,
  ...inputProps
}: React.ComponentProps<typeof TextInput> & { width: number }) {
  const [focused, setFocused] = useState(false);
  const border = focused ? "border-accent" : "border-border-strong";
  return (
    <TextInput
      placeholderTextColor={colors.faint}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        setFocused(false);
        inputProps.onBlur?.(e);
      }}
      style={{ width }}
      className={`rounded-md border ${border} bg-raised px-2.5 py-1.5 text-sm text-ink`}
      {...inputProps}
    />
  );
}

/**
 * The Roles control: a single row of role chips. Tapping a chip assigns its
 * owner; right-click (web) / long-press (native) opens a Rename/Delete menu;
 * the trailing "＋" chip adds an event role. The rename/delete/add + menu logic
 * is shared with the template editor via `../role/RoleChips`.
 */
function RolesControl({
  roleRows,
  onPickRole,
  onRenameRole,
  onDeleteRole,
  onAddRole,
}: {
  roleRows: RoleRow[];
  onPickRole: (role: RoleRow) => void;
  onRenameRole: (roleId: string, label: string) => void;
  onDeleteRole: (roleId: string) => void;
  onAddRole: (label: string) => void;
}) {
  const [menu, setMenu] = useState<{ roleId: string; anchor: ChipAnchor } | null>(
    null,
  );
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const menuRole = roleRows.find((r) => r.roleId === menu?.roleId) ?? null;

  return (
    <View className="flex-row flex-wrap items-center gap-2">
      {roleRows.map((r) => (
        <RoleChip
          key={r.roleId}
          role={r}
          editing={editingId === r.roleId}
          onPress={() => onPickRole(r)}
          onOpenMenu={(anchor) => setMenu({ roleId: r.roleId, anchor })}
          onCommitRename={(label) => {
            const trimmed = label.trim();
            if (trimmed && trimmed !== r.roleLabel) onRenameRole(r.roleId, trimmed);
            setEditingId(null);
          }}
        />
      ))}

      {adding ? (
        <AddRoleChip
          onCommit={(label) => {
            const trimmed = label.trim();
            if (trimmed) onAddRole(trimmed);
            setAdding(false);
          }}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <Pressable
          onPress={() => setAdding(true)}
          accessibilityRole="button"
          accessibilityLabel="Add role"
          className="flex-row items-center rounded-pill border border-dashed border-border-strong bg-raised px-2.5 py-1.5 active:opacity-80 web:hover:border-accent"
        >
          <Icon name="plus" size={14} color={colors.muted} />
        </Pressable>
      )}

      <RoleChipMenu
        anchor={menu?.anchor}
        onClose={() => setMenu(null)}
        onRename={() => {
          if (menuRole) setEditingId(menuRole.roleId);
          setMenu(null);
        }}
        onDelete={() => {
          setMenu(null);
          if (menuRole) confirmDeleteRole(() => onDeleteRole(menuRole.roleId));
        }}
      />
    </View>
  );
}

/**
 * A compact inline chip for one role: label + assigned person or "Assign".
 * Tap assigns; right-click/long-press opens the menu; `editing` swaps the label
 * for an inline rename field.
 */
function RoleChip({
  role,
  editing,
  onPress,
  onOpenMenu,
  onCommitRename,
}: {
  role: RoleRow;
  editing: boolean;
  onPress: () => void;
  onOpenMenu: (anchor: ChipAnchor) => void;
  onCommitRename: (label: string) => void;
}) {
  const ref = useRef<any>(null);
  const [draft, setDraft] = useState(role.roleLabel);

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

  const webProps =
    Platform.OS === "web"
      ? ({
          onContextMenu: (e: any) => {
            e?.preventDefault?.();
            measureAnchor(ref.current, onOpenMenu);
          },
        } as any)
      : {};

  return (
    <Pressable
      onPress={onPress}
      onLongPress={() => measureAnchor(ref.current, onOpenMenu)}
      delayLongPress={300}
    >
      <View
        ref={ref}
        {...webProps}
        className="flex-row items-center gap-2 rounded-pill border border-border bg-sunken px-2.5 py-1.5 active:opacity-80 web:hover:border-border-strong"
      >
        <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
          {role.roleLabel}
        </Text>
        {role.person ? (
          <View className="flex-row items-center gap-1.5">
            <Avatar name={role.person.name} size={18} />
            <Text className="text-sm text-ink">{role.person.name}</Text>
          </View>
        ) : (
          <View className="flex-row items-center gap-1">
            <Icon name="user-plus" size={13} color={colors.muted} />
            <Text className="text-sm text-faint">Assign</Text>
          </View>
        )}
      </View>
    </Pressable>
  );
}

/** Tiny inline input shown by the "＋" chip to name a new event role. */
function AddRoleChip({
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

function StatusChip({
  label,
  tone,
  selected,
  onPress,
}: {
  label: string;
  tone: ReturnType<typeof statusTone>;
  selected: boolean;
  onPress: () => void;
}) {
  const TONE_BORDER: Record<string, string> = {
    warn: "border-warn",
    accent: "border-accent",
    success: "border-success",
    danger: "border-danger",
    neutral: "border-border-strong",
  };
  return (
    <Pressable
      onPress={onPress}
      className={`rounded-pill border px-3 py-1.5 ${
        selected ? `bg-raised ${TONE_BORDER[tone]}` : "border-border bg-sunken"
      } active:opacity-80 web:hover:border-border-strong`}
    >
      <Text className={`text-sm ${selected ? "font-semibold text-ink" : "text-muted"}`}>
        {label}
      </Text>
    </Pressable>
  );
}
