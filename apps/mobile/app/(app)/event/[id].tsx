import { useMemo, useState } from "react";
import { View, Text, Pressable, Alert, TextInput } from "react-native";
import { Stack, useRouter, useLocalSearchParams } from "expo-router";
import { useQuery, useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import {
  Screen,
  Card,
  Button,
  Badge,
  ReadinessRing,
  TextField,
  SectionHeader,
  PersonPicker,
  Avatar,
  Icon,
  statusTone,
} from "../../../components/ui";
import { EditableGrid } from "../../../components/grid/EditableGrid";
import { AiPhotoFill } from "../../../components/ai/AiPhotoFill";
import { colors } from "../../../lib/theme";
import { formatDate, parseDateInput, toDateInput } from "../../../lib/format";
import {
  MODULE_KEYS,
  MODULE_LABELS,
  EVENT_STATUSES,
  EVENT_STATUS_LABELS,
  type EventStatus,
  type ModuleKey,
} from "@events-os/shared";

export default function EventDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const eventId = id as any;

  const data = useQuery(api.events.get, { eventId });
  const roleRows = useQuery(api.roleAssignments.listForEvent, { eventId });
  const chapterRolesRaw = useQuery(api.roles.list);

  const reschedule = useMutation(api.events.reschedule);
  const setStatus = useMutation(api.events.setStatus);
  const updateDetails = useMutation(api.events.updateDetails);
  const removeEvent = useMutation(api.events.remove);
  const assignRole = useMutation(api.roleAssignments.assign);
  const unassignRole = useMutation(api.roleAssignments.unassign);

  // Local edit buffers (null = mirror server value).
  const [nameInput, setNameInput] = useState<string | null>(null);
  const [dateInput, setDateInput] = useState<string | null>(null);
  const [budgetInput, setBudgetInput] = useState<string | null>(null);
  const [picker, setPicker] = useState<
    | { roleId: string; roleLabel: string; selectedId: string | null }
    | null
  >(null);

  // Chapter roles, shaped for the grid's role cells ({_id, label}).
  const chapterRoles = useMemo(
    () =>
      (chapterRolesRaw ?? []).map((r: any) => ({
        _id: r._id as string,
        label: r.label as string,
      })),
    [chapterRolesRaw],
  );

  const loading =
    data === undefined || roleRows === undefined || chapterRolesRaw === undefined;

  if (loading) {
    return (
      <>
        <Stack.Screen options={{ headerShown: false }} />
        <Screen loading />
      </>
    );
  }

  if (data === null) {
    return (
      <>
        <Stack.Screen options={{ headerShown: false }} />
        <Screen>
          <View className="items-start gap-4 py-10">
            <Text className="font-display text-xl text-ink">
              This event no longer exists.
            </Text>
            <Button
              title="Back to pipeline"
              icon="arrow-left"
              variant="secondary"
              onPress={() => router.replace("/")}
            />
          </View>
        </Screen>
      </>
    );
  }

  const {
    event,
    eventTypeName,
    activeComponents,
    readiness,
    taskTotal,
    taskDone,
    budgetSpent,
    budgetPct,
  } = data;

  const nameValue = nameInput !== null ? nameInput : event.name;
  const dateValue = dateInput !== null ? dateInput : toDateInput(event.eventDate);
  const budgetValue =
    budgetInput !== null
      ? budgetInput
      : event.budget != null
        ? String(event.budget)
        : "";

  // Only modules that the event type has switched on, in canonical order.
  const activeModules = MODULE_KEYS.filter((m) => activeComponents.includes(m));

  async function handleSaveName() {
    const trimmed = nameValue.trim();
    if (trimmed.length === 0 || trimmed === event.name) {
      setNameInput(null);
      return;
    }
    await updateDetails({ eventId, name: trimmed });
    setNameInput(null);
  }

  async function handleReschedule() {
    const ts = parseDateInput(dateValue);
    if (ts === null) return;
    await reschedule({ eventId, eventDate: ts });
    setDateInput(null);
  }

  async function handleSaveBudget() {
    const trimmed = budgetValue.trim();
    const parsed = trimmed === "" ? null : Number(trimmed);
    if (parsed !== null && Number.isNaN(parsed)) return;
    await updateDetails({ eventId, budget: parsed });
    setBudgetInput(null);
  }

  function confirmDelete() {
    Alert.alert("Delete event?", "This removes the event and all its items.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          await removeEvent({ eventId });
          router.replace("/");
        },
      },
    ]);
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <Screen maxWidth={1180}>
        {/* Breadcrumb / back */}
        <Pressable
          onPress={() => router.replace("/")}
          className="mb-4 flex-row items-center gap-1.5 self-start active:opacity-70"
        >
          <Icon name="arrow-left" size={15} color={colors.muted} />
          <Text className="text-sm font-medium text-muted">Pipeline</Text>
        </Pressable>

        {/* Workspace header */}
        <Card className="mb-4">
          <View className="flex-row items-center gap-5">
            <ReadinessRing value={readiness} size={84} />
            <View className="flex-1 gap-2">
              <Text className="text-xs font-bold uppercase tracking-wider text-accent">
                {eventTypeName}
              </Text>
              <TextField
                value={nameValue}
                onChangeText={setNameInput}
                onBlur={handleSaveName}
                placeholder="Event name"
              />
              <View className="flex-row flex-wrap items-center gap-x-4 gap-y-1">
                <Meta icon="calendar" text={formatDate(event.eventDate)} />
                {event.location ? <Meta icon="map-pin" text={event.location} /> : null}
                <Meta icon="check-circle" text={`${taskDone}/${taskTotal} tasks`} />
                {event.budget != null ? (
                  <Meta
                    icon="dollar-sign"
                    text={`$${budgetSpent} / $${event.budget}${
                      event.budget > 0 ? ` · ${budgetPct}%` : ""
                    }`}
                    danger={event.budget > 0 && budgetSpent > event.budget}
                  />
                ) : budgetSpent > 0 ? (
                  <Meta icon="dollar-sign" text={`$${budgetSpent} planned`} />
                ) : null}
              </View>
              <View className="mt-1 flex-row items-center gap-2">
                <Badge
                  label={EVENT_STATUS_LABELS[event.status as EventStatus]}
                  tone={statusTone(event.status as EventStatus)}
                />
                <Button
                  title="Day-of view"
                  icon="play"
                  size="sm"
                  variant="secondary"
                  onPress={() => router.push(`/event/${eventId}/day-of`)}
                />
              </View>
            </View>
          </View>
        </Card>

        {/* Compact horizontal controls strip */}
        <Card padding="md" className="mb-6">
          <View className="flex-row flex-wrap items-start gap-x-6 gap-y-4">
            {/* Roles — inline pills */}
            <ControlBlock label="Roles" count={roleRows.length || undefined}>
              {roleRows.length === 0 ? (
                <Text className="text-sm text-faint">No roles</Text>
              ) : (
                <View className="flex-row flex-wrap gap-2">
                  {roleRows.map((r) => (
                    <RoleChip
                      key={r.roleId}
                      role={r}
                      onPress={() =>
                        setPicker({
                          roleId: r.roleId,
                          roleLabel: r.roleLabel,
                          selectedId: r.person?._id ?? null,
                        })
                      }
                    />
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
                    onPress={() => setStatus({ eventId, status: s })}
                  />
                ))}
              </View>
            </ControlBlock>

            {/* Schedule — inline date field */}
            <ControlBlock label="Schedule">
              <View className="flex-row items-center gap-2">
                <InlineInput
                  value={dateValue}
                  onChangeText={setDateInput}
                  onBlur={handleReschedule}
                  placeholder="YYYY-MM-DD"
                  autoCapitalize="none"
                  width={120}
                />
                <Button
                  title="Save"
                  icon="calendar"
                  size="sm"
                  variant="secondary"
                  onPress={handleReschedule}
                  disabled={parseDateInput(dateValue) === null}
                />
              </View>
              <Text className="mt-1 text-2xs text-faint">Reflows due dates.</Text>
            </ControlBlock>

            {/* Budget — inline numeric field */}
            <ControlBlock label="Budget">
              <View className="flex-row items-center gap-2">
                <InlineInput
                  value={budgetValue}
                  onChangeText={setBudgetInput}
                  onBlur={handleSaveBudget}
                  placeholder="0"
                  keyboardType="numeric"
                  width={80}
                />
                <Button
                  title="Save"
                  icon="check"
                  size="sm"
                  variant="secondary"
                  onPress={handleSaveBudget}
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
                onPress={confirmDelete}
              />
            </ControlBlock>
          </View>
        </Card>

        {/* Module grids — full width */}
        {activeModules.length === 0 ? (
          <Card padding="lg">
            <Text className="text-base text-muted">
              This event type has no planning modules enabled.
            </Text>
          </Card>
        ) : (
          activeModules.map((m: ModuleKey) => (
            <View key={m}>
              <SectionHeader
                title={MODULE_LABELS[m]}
                right={
                  m === "supplies" ? (
                    <View className="flex-row items-start gap-2">
                      <AiPhotoFill eventId={eventId} />
                      <Button
                        title="Packing mode"
                        icon="package"
                        size="sm"
                        variant="secondary"
                        onPress={() => router.push(`/event/${eventId}/packing`)}
                      />
                    </View>
                  ) : undefined
                }
              />
              <EditableGrid
                mode="event"
                parentId={eventId}
                module={m}
                roles={chapterRoles}
                eventDate={event.eventDate}
                addLabel={`Add ${MODULE_LABELS[m].toLowerCase()} row`}
              />
            </View>
          ))
        )}
      </Screen>

      <PersonPicker
        visible={picker !== null}
        title={picker ? `Assign ${picker.roleLabel}` : "Assign role"}
        selectedId={picker?.selectedId ?? null}
        onPick={async (personId) => {
          if (!picker) return;
          await assignRole({
            eventId,
            roleId: picker.roleId as any,
            personId: personId as any,
          });
          setPicker(null);
        }}
        onClear={
          picker && picker.selectedId
            ? async () => {
                if (!picker) return;
                await unassignRole({ eventId, roleId: picker.roleId as any });
                setPicker(null);
              }
            : undefined
        }
        onClose={() => setPicker(null)}
      />
    </>
  );
}

// ── Pieces ───────────────────────────────────────────────────────────────────

function Meta({ icon, text, danger }: { icon: any; text: string; danger?: boolean }) {
  return (
    <View className="flex-row items-center gap-1.5">
      <Icon name={icon} size={14} color={danger ? colors.danger : colors.muted} />
      <Text className={`text-base ${danger ? "font-semibold text-danger" : "text-muted"}`}>
        {text}
      </Text>
    </View>
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

type RoleRow = {
  roleId: string;
  roleLabel: string;
  person: { _id: string; name: string } | null;
};

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
