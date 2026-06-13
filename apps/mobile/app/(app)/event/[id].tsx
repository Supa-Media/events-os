import { useState } from "react";
import { View, Text, StyleSheet, Pressable, Alert } from "react-native";
import {
  Stack,
  useRouter,
  useLocalSearchParams,
} from "expo-router";
import { useQuery, useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import {
  Screen,
  Card,
  Button,
  Badge,
  Pill,
  ReadinessBadge,
  TextField,
  SectionHeader,
  PersonPicker,
  statusTone,
} from "../../../components/ui";
import { colors, radius, spacing } from "../../../lib/theme";
import { formatDate, isOverdue, parseDateInput, toDateInput } from "../../../lib/format";
import {
  EVENT_STATUSES,
  EVENT_STATUS_LABELS,
  ROLE_LABELS,
  TASK_STATUSES,
  type EventStatus,
  type RoleKey,
  type TaskStatus,
} from "@events-os/shared";

/** Cycle a task status forward: not_started → in_progress → done → not_started. */
function nextStatus(s: TaskStatus): TaskStatus {
  const i = TASK_STATUSES.indexOf(s);
  return TASK_STATUSES[(i + 1) % TASK_STATUSES.length];
}

export default function EventDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const eventId = id as any;

  const data = useQuery(api.events.get, { eventId });
  const taskData = useQuery(api.tasks.listForEvent, { eventId });
  const roles = useQuery(api.roles.listForEvent, { eventId });

  const reschedule = useMutation(api.events.reschedule);
  const setStatus = useMutation(api.events.setStatus);
  const removeEvent = useMutation(api.events.remove);
  const setTaskStatus = useMutation(api.tasks.setStatus);
  const assignTask = useMutation(api.tasks.assign);
  const assignRole = useMutation(api.roles.assign);
  const unassignRole = useMutation(api.roles.unassign);

  const [dateInput, setDateInput] = useState<string | null>(null);
  // picker target: { kind: "task", id } | { kind: "role", role }
  const [picker, setPicker] = useState<
    | { kind: "task"; taskId: string; selectedId: string | null }
    | { kind: "role"; role: string; selectedId: string | null }
    | null
  >(null);

  const loading =
    data === undefined || taskData === undefined || roles === undefined;

  if (loading) {
    return (
      <>
        <Stack.Screen options={{ headerShown: true, title: "Event" }} />
        <Screen loading />
      </>
    );
  }

  if (data === null) {
    return (
      <>
        <Stack.Screen options={{ headerShown: true, title: "Event" }} />
        <Screen>
          <Text style={styles.notFound}>This event no longer exists.</Text>
          <Button title="Back" variant="secondary" onPress={() => router.back()} />
        </Screen>
      </>
    );
  }

  const { event, eventTypeName } = data;
  const readiness = taskData.summary.readiness;
  const dateValue =
    dateInput !== null ? dateInput : toDateInput(event.eventDate);

  async function handleReschedule() {
    const ts = parseDateInput(dateValue);
    if (ts === null) return;
    await reschedule({ eventId, eventDate: ts });
    setDateInput(null);
  }

  function confirmDelete() {
    Alert.alert("Delete event?", "This removes the event and all its tasks.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          await removeEvent({ eventId });
          router.back();
        },
      },
    ]);
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: event.name }} />
      <Screen>
        {/* Header */}
        <Card>
          <View style={styles.headerTop}>
            <Text style={styles.eventName}>{event.name}</Text>
            <ReadinessBadge value={readiness} size="lg" />
          </View>
          <Text style={styles.eventMeta}>
            {eventTypeName} · {formatDate(event.eventDate)}
          </Text>
          {event.location ? (
            <Text style={styles.eventMeta}>{event.location}</Text>
          ) : null}
          <View style={styles.headerBottom}>
            <Badge
              label={EVENT_STATUS_LABELS[event.status as EventStatus]}
              tone={statusTone(event.status as EventStatus)}
            />
            <Text style={styles.taskCount}>
              {taskData.summary.done}/{taskData.summary.total} tasks done
            </Text>
          </View>
        </Card>

        <Button
          title="Day-of mode"
          variant="secondary"
          style={styles.dayOfBtn}
          onPress={() => router.push(`/event/${event._id}/day-of`)}
        />

        {/* Status control */}
        <SectionHeader title="Status" />
        <View style={styles.statusRow}>
          {EVENT_STATUSES.map((s) => (
            <Pill
              key={s}
              label={EVENT_STATUS_LABELS[s]}
              selected={event.status === s}
              onPress={() => setStatus({ eventId, status: s })}
            />
          ))}
        </View>

        {/* Reschedule */}
        <SectionHeader title="Reschedule" />
        <Card>
          <TextField
            label="Event date"
            value={dateValue}
            onChangeText={setDateInput}
            placeholder="YYYY-MM-DD"
            autoCapitalize="none"
            hint="Moving the date shifts every task's due date."
          />
          <Button
            title="Save date"
            onPress={handleReschedule}
            disabled={parseDateInput(dateValue) === null}
          />
        </Card>

        {/* Roles */}
        <SectionHeader title="Roles" />
        <View style={styles.list}>
          {roles.length === 0 ? (
            <Text style={styles.muted}>This event type has no roles.</Text>
          ) : (
            roles.map((r: any) => (
              <Card key={r.role}>
                <View style={styles.roleRow}>
                  <Text style={styles.roleLabel}>
                    {ROLE_LABELS[r.role as RoleKey] ?? r.role}
                  </Text>
                  {r.person ? (
                    <View style={styles.roleAssigned}>
                      <Text style={styles.personName}>{r.person.name}</Text>
                      <Button
                        title="Clear"
                        size="sm"
                        variant="ghost"
                        onPress={() =>
                          unassignRole({ eventId, role: r.role })
                        }
                      />
                    </View>
                  ) : (
                    <Button
                      title="Assign"
                      size="sm"
                      variant="secondary"
                      onPress={() =>
                        setPicker({
                          kind: "role",
                          role: r.role,
                          selectedId: null,
                        })
                      }
                    />
                  )}
                </View>
              </Card>
            ))
          )}
        </View>

        {/* Tasks */}
        <SectionHeader title="Tasks" />
        <View style={styles.list}>
          {taskData.tasks.length === 0 ? (
            <Text style={styles.muted}>No tasks on this event.</Text>
          ) : (
            taskData.tasks.map((t: any) => (
              <TaskRow
                key={t._id}
                task={t}
                onToggle={() =>
                  setTaskStatus({
                    taskId: t._id,
                    status: nextStatus(t.status),
                  })
                }
                onAssign={() =>
                  setPicker({
                    kind: "task",
                    taskId: t._id,
                    selectedId: t.assignee?._id ?? null,
                  })
                }
              />
            ))
          )}
        </View>

        {/* Delete */}
        <View style={styles.deleteWrap}>
          <Button title="Delete event" variant="danger" onPress={confirmDelete} />
        </View>
      </Screen>

      <PersonPicker
        visible={picker !== null}
        title={picker?.kind === "role" ? "Assign role" : "Assign task"}
        selectedId={picker?.selectedId ?? null}
        onPick={async (personId) => {
          if (!picker) return;
          if (picker.kind === "task") {
            await assignTask({ taskId: picker.taskId as any, personId: personId as any });
          } else {
            await assignRole({
              eventId,
              role: picker.role,
              personId: personId as any,
            });
          }
          setPicker(null);
        }}
        onClear={
          picker?.kind === "task"
            ? async () => {
                await assignTask({ taskId: picker.taskId as any });
                setPicker(null);
              }
            : undefined
        }
        onClose={() => setPicker(null)}
      />
    </>
  );
}

function TaskRow({
  task,
  onToggle,
  onAssign,
}: {
  task: any;
  onToggle: () => void;
  onAssign: () => void;
}) {
  const done = task.status === "done";
  const overdue = !done && isOverdue(task.dueDate);
  const checkboxStyle =
    task.status === "done"
      ? styles.checkDone
      : task.status === "in_progress"
        ? styles.checkProgress
        : styles.checkEmpty;

  return (
    <Card>
      <View style={styles.taskRow}>
        <Pressable onPress={onToggle} hitSlop={8} style={[styles.checkbox, checkboxStyle]}>
          <Text style={styles.checkMark}>
            {done ? "✓" : task.status === "in_progress" ? "…" : ""}
          </Text>
        </Pressable>

        <View style={styles.taskBody}>
          <Text style={[styles.taskTitle, done && styles.taskTitleDone]}>
            {task.title}
          </Text>
          <View style={styles.taskMetaRow}>
            <Pill label={`T-${task.tMinusOffsetDays}`} />
            <Text style={styles.taskMeta}>
              {ROLE_LABELS[task.owningRole as RoleKey] ?? task.owningRole}
            </Text>
            <Text style={[styles.taskMeta, overdue && styles.overdue]}>
              {formatDate(task.dueDate)}
            </Text>
          </View>
          <Pressable onPress={onAssign} hitSlop={6}>
            <Text style={styles.assignee}>
              {task.assignee ? task.assignee.name : "Unassigned · tap to assign"}
            </Text>
          </Pressable>
        </View>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  notFound: { fontSize: 15, color: colors.muted, marginBottom: spacing.lg },
  headerTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  eventName: { fontSize: 20, fontWeight: "800", color: colors.text, flex: 1 },
  eventMeta: { fontSize: 14, color: colors.muted, marginTop: spacing.xs },
  headerBottom: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    marginTop: spacing.md,
  },
  taskCount: { fontSize: 13, color: colors.muted },
  dayOfBtn: { marginTop: spacing.md },
  statusRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  list: { gap: spacing.sm },
  muted: { fontSize: 14, color: colors.muted },
  roleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  roleLabel: { fontSize: 15, fontWeight: "600", color: colors.text, flex: 1 },
  roleAssigned: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  personName: { fontSize: 15, color: colors.text },
  taskRow: { flexDirection: "row", gap: spacing.md, alignItems: "flex-start" },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: radius.sm,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 2,
  },
  checkEmpty: { borderColor: colors.border, backgroundColor: colors.card },
  checkProgress: { borderColor: colors.amber, backgroundColor: colors.amberBg },
  checkDone: { borderColor: colors.success, backgroundColor: colors.success },
  checkMark: { color: "#fff", fontSize: 13, fontWeight: "800", lineHeight: 16 },
  taskBody: { flex: 1, gap: spacing.xs },
  taskTitle: { fontSize: 15, fontWeight: "600", color: colors.text },
  taskTitleDone: {
    textDecorationLine: "line-through",
    color: colors.muted,
    fontWeight: "500",
  },
  taskMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  taskMeta: { fontSize: 13, color: colors.muted },
  overdue: { color: colors.danger, fontWeight: "700" },
  assignee: { fontSize: 13, color: colors.accent, marginTop: 2 },
  deleteWrap: { marginTop: spacing.xl },
});
