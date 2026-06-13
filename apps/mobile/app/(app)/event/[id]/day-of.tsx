import { View, Text, StyleSheet, Pressable } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { useQuery, useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { Screen, Card, SectionHeader } from "../../../../components/ui";
import { colors, radius, spacing } from "../../../../lib/theme";
import { formatTime } from "../../../../lib/format";
import { TASK_STATUS_OPTIONS, computeRunTime } from "@events-os/shared";

/** The ordered planning-doc task status values (not_started → in_progress → done). */
const TASK_STATUSES = TASK_STATUS_OPTIONS.map((o) => o.value);

/** Cycle a task status forward through the task status option set. */
function nextStatus(s: string | undefined): string {
  const current = s ?? TASK_STATUSES[0];
  const i = TASK_STATUSES.indexOf(current);
  return TASK_STATUSES[(i + 1) % TASK_STATUSES.length];
}

/** Compute the wall-clock time of a run-of-show row from event start. */
function rowTime(eventDate: number, offsetMinutes: number): string {
  return formatTime(computeRunTime(eventDate, offsetMinutes));
}

/** DAY-OF MODE: big, scannable field view. */
export default function DayOfScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const eventId = id as any;
  const data = useQuery(api.events.dayOf, { eventId });
  const setTaskStatus = useMutation(api.items.setStatus);

  if (data === undefined) {
    return (
      <>
        <Stack.Screen options={{ headerShown: true, title: "Day-of" }} />
        <Screen loading />
      </>
    );
  }

  if (data === null) {
    return (
      <>
        <Stack.Screen options={{ headerShown: true, title: "Day-of" }} />
        <Screen>
          <Text style={styles.muted}>This event no longer exists.</Text>
        </Screen>
      </>
    );
  }

  const { event, eventTypeName, runOfShow, roles, tasks } = data;

  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: "Day-of" }} />
      <Screen>
        <Text style={styles.eventName}>{event.name}</Text>
        <Text style={styles.eventMeta}>{eventTypeName}</Text>

        {/* Run of show */}
        <SectionHeader title="Run of Show" />
        {runOfShow.length === 0 ? (
          <Text style={styles.muted}>No run-of-show rows.</Text>
        ) : (
          <View style={styles.list}>
            {runOfShow.map((r: any) => (
              <Card key={r._id}>
                <View style={styles.rosRow}>
                  <Text style={styles.rosTime}>
                    {rowTime(event.eventDate, r.offsetMinutes ?? 0)}
                  </Text>
                  <View style={styles.rosBody}>
                    <Text style={styles.rosSegment}>{r.title}</Text>
                    {r.roleLabel ? (
                      <Text style={styles.rosRole}>{r.roleLabel}</Text>
                    ) : null}
                    {r.fields?.notes ? (
                      <Text style={styles.rosNotes}>{r.fields.notes}</Text>
                    ) : null}
                  </View>
                </View>
              </Card>
            ))}
          </View>
        )}

        {/* Roles */}
        <SectionHeader title="Roles" />
        {roles.length === 0 ? (
          <Text style={styles.muted}>No roles on this event.</Text>
        ) : (
          <View style={styles.roleGrid}>
            {roles.map((r: any) => (
              <Card key={r.roleId} style={styles.roleCard}>
                <Text style={styles.roleLabel}>{r.roleLabel}</Text>
                <Text style={styles.rolePerson}>
                  {r.person ? r.person.name : "Unassigned"}
                </Text>
              </Card>
            ))}
          </View>
        )}

        {/* Today's tasks */}
        <SectionHeader title="Today's tasks" />
        {tasks.length === 0 ? (
          <Text style={styles.muted}>No tasks.</Text>
        ) : (
          <View style={styles.list}>
            {tasks.map((t: any) => {
              const done = t.status === "done";
              return (
                <Pressable
                  key={t._id}
                  onPress={() =>
                    setTaskStatus({ itemId: t._id, status: nextStatus(t.status) })
                  }
                >
                  <Card>
                    <View style={styles.taskRow}>
                      <View
                        style={[
                          styles.checkbox,
                          done
                            ? styles.checkDone
                            : t.status === "in_progress"
                              ? styles.checkProgress
                              : styles.checkEmpty,
                        ]}
                      >
                        <Text style={styles.checkMark}>
                          {done ? "✓" : t.status === "in_progress" ? "…" : ""}
                        </Text>
                      </View>
                      <Text
                        style={[styles.taskTitle, done && styles.taskTitleDone]}
                      >
                        {t.title}
                      </Text>
                    </View>
                  </Card>
                </Pressable>
              );
            })}
          </View>
        )}
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  eventName: { fontSize: 24, fontWeight: "800", color: colors.text },
  eventMeta: { fontSize: 15, color: colors.muted, marginTop: spacing.xs },
  muted: { fontSize: 15, color: colors.muted },
  list: { gap: spacing.sm },
  rosRow: { flexDirection: "row", gap: spacing.md, alignItems: "flex-start" },
  rosTime: {
    fontSize: 18,
    fontWeight: "800",
    color: colors.accent,
    minWidth: 56,
  },
  rosBody: { flex: 1, gap: 2 },
  rosSegment: { fontSize: 17, fontWeight: "700", color: colors.text },
  rosRole: { fontSize: 14, color: colors.muted },
  rosNotes: { fontSize: 14, color: colors.text, marginTop: spacing.xs },
  roleGrid: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  roleCard: { flexGrow: 1, minWidth: 150 },
  roleLabel: { fontSize: 13, color: colors.muted, fontWeight: "600" },
  rolePerson: { fontSize: 18, fontWeight: "700", color: colors.text, marginTop: 2 },
  taskRow: { flexDirection: "row", gap: spacing.md, alignItems: "center" },
  checkbox: {
    width: 28,
    height: 28,
    borderRadius: radius.sm,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  checkEmpty: { borderColor: colors.border, backgroundColor: colors.card },
  checkProgress: { borderColor: colors.amber, backgroundColor: colors.amberBg },
  checkDone: { borderColor: colors.success, backgroundColor: colors.success },
  checkMark: { color: "#fff", fontSize: 16, fontWeight: "800" },
  taskTitle: { fontSize: 17, fontWeight: "600", color: colors.text, flex: 1 },
  taskTitleDone: {
    textDecorationLine: "line-through",
    color: colors.muted,
    fontWeight: "500",
  },
});
