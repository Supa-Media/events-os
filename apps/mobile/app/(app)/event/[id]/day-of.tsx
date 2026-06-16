import { useEffect, useState } from "react";
import { View, Text, StyleSheet, Pressable } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { useQuery, useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { Screen, Card, SectionHeader } from "../../../../components/ui";
import { ToastView } from "../../../../components/ui/Toast";
import { colors, radius, spacing } from "../../../../lib/theme";
import { formatTime } from "../../../../lib/format";
import { useActionRunner } from "../../../../lib/useActionToast";
import { TASK_STATUS_OPTIONS, computeRunTime } from "@events-os/shared";
import type { Id } from "@events-os/convex/_generated/dataModel";

/** The ordered planning-doc task status values (not_started → in_progress → done). */
const TASK_STATUSES = TASK_STATUS_OPTIONS.map((o) => o.value);

/** Human label for a task status (for a11y announcements). */
function statusLabel(s: string | undefined): string {
  return (
    TASK_STATUS_OPTIONS.find((o) => o.value === (s ?? TASK_STATUSES[0]))?.label ??
    "Not started"
  );
}

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

/** A live wall clock — re-renders every 30s. Anchors the now/next highlight. */
function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** DAY-OF MODE: big, scannable field view. */
export default function DayOfScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const eventId = id as Id<"events">;
  const data = useQuery(api.events.dayOf, { eventId });
  const setTaskStatus = useMutation(api.items.setStatus);
  const { run, toast, dismiss } = useActionRunner();
  const now = useNow();

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

  // The "now/next" block: the run-of-show row currently in progress (its start
  // has passed but the next row's start hasn't), or — before the event — the
  // first upcoming row. Used to highlight what the team should be doing now.
  const sorted = [...runOfShow].sort(
    (a, b) => (a.offsetMinutes ?? 0) - (b.offsetMinutes ?? 0),
  );
  let nowIndex = -1;
  for (let i = 0; i < sorted.length; i++) {
    const start = computeRunTime(event.eventDate, sorted[i].offsetMinutes ?? 0);
    const nextStart =
      i + 1 < sorted.length
        ? computeRunTime(event.eventDate, sorted[i + 1].offsetMinutes ?? 0)
        : Infinity;
    if (now >= start && now < nextStart) {
      nowIndex = i;
      break;
    }
  }
  // Before the first row starts, point "next" at the first upcoming row.
  if (nowIndex === -1 && sorted.length > 0) {
    const firstStart = computeRunTime(
      event.eventDate,
      sorted[0].offsetMinutes ?? 0,
    );
    if (now < firstStart) nowIndex = 0;
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: "Day-of" }} />
      <Screen>
        <ToastView toast={toast} onDismiss={dismiss} />
        <View style={styles.headerRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.eventName}>{event.name}</Text>
            <Text style={styles.eventMeta}>{eventTypeName}</Text>
          </View>
          {/* Live clock — anchors the now/next highlight below. */}
          <View
            style={styles.clock}
            accessibilityLabel={`Current time ${formatTime(now)}`}
          >
            <Text style={styles.clockTime}>{formatTime(now)}</Text>
            <Text style={styles.clockLabel}>now</Text>
          </View>
        </View>

        {/* Run of show */}
        <SectionHeader title="Run of Show" />
        {sorted.length === 0 ? (
          <Text style={styles.muted}>No run-of-show rows.</Text>
        ) : (
          <View style={styles.list}>
            {sorted.map((r, i) => {
              const isNow = i === nowIndex;
              const upcoming =
                isNow &&
                now <
                  computeRunTime(event.eventDate, r.offsetMinutes ?? 0);
              return (
                <Card
                  key={r._id}
                  style={isNow ? styles.rosCardNow : undefined}
                >
                  {isNow ? (
                    <View
                      style={styles.nowBadge}
                      accessibilityLabel={`${upcoming ? "Up next" : "Happening now"}: ${r.title} at ${rowTime(event.eventDate, r.offsetMinutes ?? 0)}`}
                    >
                      <Text style={styles.nowBadgeText}>
                        {upcoming ? "UP NEXT" : "NOW"}
                      </Text>
                    </View>
                  ) : null}
                  <View style={styles.rosRow}>
                    <Text style={styles.rosTime}>
                      {rowTime(event.eventDate, r.offsetMinutes ?? 0)}
                    </Text>
                    <View style={styles.rosBody}>
                      <Text style={styles.rosSegment}>{r.title}</Text>
                      {typeof r.fields?.notes === "string" &&
                      r.fields.notes ? (
                        <Text style={styles.rosNotes}>
                          {r.fields.notes}
                        </Text>
                      ) : null}
                    </View>
                  </View>
                </Card>
              );
            })}
          </View>
        )}

        {/* Roles */}
        <SectionHeader title="Roles" />
        {roles.length === 0 ? (
          <Text style={styles.muted}>No roles on this event.</Text>
        ) : (
          <View style={styles.roleGrid}>
            {roles.map((r) => (
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
            {tasks.map((t) => {
              const done = t.status === "done";
              const next = nextStatus(t.status ?? undefined);
              return (
                <Pressable
                  key={t._id}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: done }}
                  accessibilityLabel={`${t.title}. Status ${statusLabel(
                    t.status ?? undefined,
                  )}. Tap to mark ${statusLabel(next)}.`}
                  hitSlop={8}
                  onPress={() =>
                    run(
                      () =>
                        setTaskStatus({ itemId: t._id, status: next }),
                      { errorTitle: "Couldn't update task" },
                    )
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
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    marginBottom: spacing.sm,
  },
  eventName: { fontSize: 24, fontWeight: "800", color: colors.text },
  eventMeta: { fontSize: 15, color: colors.muted, marginTop: spacing.xs },
  clock: {
    alignItems: "center",
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.raised,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  clockTime: { fontSize: 20, fontWeight: "800", color: colors.accent },
  clockLabel: {
    fontSize: 10,
    fontWeight: "700",
    color: colors.faint,
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  muted: { fontSize: 15, color: colors.muted },
  list: { gap: spacing.sm },
  rosCardNow: {
    borderColor: colors.accent,
    borderWidth: 2,
    backgroundColor: colors.accentBg,
  },
  nowBadge: {
    alignSelf: "flex-start",
    backgroundColor: colors.accent,
    borderRadius: radius.sm,
    paddingHorizontal: 8,
    paddingVertical: 2,
    marginBottom: spacing.xs,
  },
  nowBadgeText: {
    fontSize: 11,
    fontWeight: "800",
    color: "#fff",
    letterSpacing: 1,
  },
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
  // ≥44px tall touch target for the whole task row.
  taskRow: {
    flexDirection: "row",
    gap: spacing.md,
    alignItems: "center",
    minHeight: 44,
  },
  checkbox: {
    width: 44,
    height: 44,
    borderRadius: radius.sm,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  checkEmpty: { borderColor: colors.border, backgroundColor: colors.card },
  checkProgress: { borderColor: colors.amber, backgroundColor: colors.amberBg },
  checkDone: { borderColor: colors.success, backgroundColor: colors.success },
  checkMark: { color: "#fff", fontSize: 20, fontWeight: "800" },
  taskTitle: { fontSize: 17, fontWeight: "600", color: colors.text, flex: 1 },
  taskTitleDone: {
    textDecorationLine: "line-through",
    color: colors.muted,
    fontWeight: "500",
  },
});
