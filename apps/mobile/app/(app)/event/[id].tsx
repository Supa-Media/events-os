import { useMemo, useState } from "react";
import { View, Text, Pressable, Alert, useWindowDimensions } from "react-native";
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
  const { width } = useWindowDimensions();
  const desktop = width >= 960;

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

  const { event, eventTypeName, activeComponents, readiness, taskTotal, taskDone } =
    data;

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

  // ── Main column: per-module editable grids ─────────────────────────────────
  const grids = (
    <View>
      {activeModules.length === 0 ? (
        <Card padding="lg">
          <Text className="text-base text-muted">
            This event type has no planning modules enabled.
          </Text>
        </Card>
      ) : (
        activeModules.map((m: ModuleKey) => (
          <View key={m}>
            <SectionHeader title={MODULE_LABELS[m]} />
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
    </View>
  );

  // ── Side rail: roles, status, schedule, budget, danger ─────────────────────
  const sidePanel = (
    <View className="gap-5">
      <RolesPanel
        roles={roleRows}
        onAssign={(roleId, roleLabel, selectedId) =>
          setPicker({ roleId, roleLabel, selectedId })
        }
        onClear={(roleId) => unassignRole({ eventId, roleId: roleId as any })}
      />

      <View>
        <SectionHeader title="Status" />
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
      </View>

      <View>
        <SectionHeader title="Schedule" />
        <Card padding="md">
          <TextField
            label="Event date"
            value={dateValue}
            onChangeText={setDateInput}
            placeholder="YYYY-MM-DD"
            autoCapitalize="none"
            hint="Moving the date reflows every due date."
          />
          <Button
            title="Save date"
            icon="calendar"
            onPress={handleReschedule}
            disabled={parseDateInput(dateValue) === null}
          />
        </Card>
      </View>

      <View>
        <SectionHeader title="Budget" />
        <Card padding="md">
          <TextField
            label="Budget"
            value={budgetValue}
            onChangeText={setBudgetInput}
            placeholder="0"
            keyboardType="numeric"
            hint="Leave blank to clear."
          />
          <Button title="Save budget" icon="check" onPress={handleSaveBudget} />
        </Card>
      </View>

      <View>
        <SectionHeader title="Danger zone" />
        <Button
          title="Delete event"
          icon="trash-2"
          variant="danger"
          onPress={confirmDelete}
        />
      </View>
    </View>
  );

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
        <Card className="mb-6">
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
                  <Meta icon="dollar-sign" text={String(event.budget)} />
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

        {/* Body: module grids + side rail */}
        <View className={desktop ? "flex-row items-start gap-6" : "gap-6"}>
          <View className={desktop ? "flex-1" : ""}>{grids}</View>
          <View className={desktop ? "w-80" : ""}>{sidePanel}</View>
        </View>
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

function Meta({ icon, text }: { icon: any; text: string }) {
  return (
    <View className="flex-row items-center gap-1.5">
      <Icon name={icon} size={14} color={colors.muted} />
      <Text className="text-base text-muted">{text}</Text>
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

type RoleRow = {
  roleId: string;
  roleLabel: string;
  person: { _id: string; name: string } | null;
};

function RolesPanel({
  roles,
  onAssign,
  onClear,
}: {
  roles: RoleRow[];
  onAssign: (roleId: string, roleLabel: string, selectedId: string | null) => void;
  onClear: (roleId: string) => void;
}) {
  return (
    <View>
      <SectionHeader title="Roles" count={roles.length || undefined} />
      {roles.length === 0 ? (
        <Card padding="md">
          <Text className="text-base text-muted">This event type has no roles.</Text>
        </Card>
      ) : (
        <Card padding="none">
          {roles.map((r, i) => (
            <View
              key={r.roleId}
              className={`flex-row items-center justify-between px-4 py-3 ${
                i < roles.length - 1 ? "border-b border-border" : ""
              }`}
            >
              <View className="flex-1">
                <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
                  {r.roleLabel}
                </Text>
                <View className="mt-1.5 flex-row items-center gap-2">
                  {r.person ? (
                    <>
                      <Avatar name={r.person.name} size={22} />
                      <Text className="text-base text-ink">{r.person.name}</Text>
                    </>
                  ) : (
                    <Text className="text-base text-faint">Unassigned</Text>
                  )}
                </View>
              </View>
              {r.person ? (
                <Button
                  title="Clear"
                  size="sm"
                  variant="ghost"
                  onPress={() => onClear(r.roleId)}
                />
              ) : (
                <Button
                  title="Assign"
                  icon="user-plus"
                  size="sm"
                  variant="secondary"
                  onPress={() => onAssign(r.roleId, r.roleLabel, null)}
                />
              )}
            </View>
          ))}
        </Card>
      )}
    </View>
  );
}
