import { useState } from "react";
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
}) {
  return (
    <Card padding="md" className="mb-6">
      <View className="flex-row flex-wrap items-start gap-x-6 gap-y-4">
        {/* Roles — inline pills */}
        <ControlBlock label="Roles" count={roleRows.length || undefined}>
          {roleRows.length === 0 ? (
            <Text className="text-sm text-faint">No roles</Text>
          ) : (
            <View className="flex-row flex-wrap gap-2">
              {roleRows.map((r) => (
                <RoleChip key={r.roleId} role={r} onPress={() => onPickRole(r)} />
              ))}
            </View>
          )}
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

/** A compact inline pill for one role: label + assigned person or "Assign". */
function RoleChip({ role, onPress }: { role: RoleRow; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
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
    </Pressable>
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
