import { useEffect, useState } from "react";
import { View, Text, StyleSheet, Pressable } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { useQuery, useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import {
  Screen,
  Card,
  SectionHeader,
  Button,
  Icon,
  Popover,
  useAnchor,
} from "../../../../components/ui";
import { ToastView } from "../../../../components/ui/Toast";
import { DateTimePanel } from "../../../../components/ui/DateTimeField";
import { colors, radius, spacing } from "../../../../lib/theme";
import { formatTime } from "../../../../lib/format";
import { useActionRunner } from "../../../../lib/useActionToast";
import {
  TASK_STATUS_OPTIONS,
  computeRunTime,
  isLocalMidnight,
  runOfShowSegmentEnd,
} from "@events-os/shared";
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

/**
 * Non-blocking nudge shown on Day-of when an event's start sits at local
 * midnight (it predates start-times, so every segment renders at 12:xx AM).
 * The "Set start time" button opens the shared calendar + time panel; picking a
 * time reschedules the event (the SAME path as the header), which re-anchors the
 * whole run of show. Dismissible and informational — it never blocks the view.
 */
function StartTimePrompt({
  eventDate,
  onReschedule,
}: {
  eventDate: number;
  onReschedule: (ts: number) => void;
}) {
  const { ref, anchor, visible, open, close } = useAnchor();
  const [dismissed, setDismissed] = useState(false);
  // A local DRAFT so the whole time can be dialed in (hour AND minute) before
  // committing — reschedule fires once, on "Set". Seeding the draft off the
  // midnight anchor keeps the day; the user just picks the time. (Committing on
  // every pick would unmount this prompt the instant the time left midnight,
  // dropping them mid-edit.)
  const [draft, setDraft] = useState(eventDate);
  if (dismissed) return null;
  return (
    <Card style={styles.promptCard}>
      <View style={styles.promptRow}>
        <Icon name="clock" size={18} color={colors.warn} />
        <View style={{ flex: 1 }}>
          <Text style={styles.promptTitle}>Set a start time</Text>
          <Text style={styles.promptBody}>
            This event has no start time, so every segment shows at 12:xx AM.
          </Text>
        </View>
        <Pressable
          onPress={() => setDismissed(true)}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Dismiss start-time prompt"
        >
          <Icon name="x" size={16} color={colors.faint} />
        </Pressable>
      </View>
      <View ref={ref} collapsable={false} style={styles.promptAction}>
        <Button
          title="Set start time"
          icon="clock"
          size="sm"
          variant="secondary"
          onPress={() => {
            setDraft(eventDate);
            open();
          }}
        />
      </View>
      <Popover visible={visible} anchor={anchor} width={388} onClose={close}>
        <DateTimePanel value={draft} onChange={setDraft} />
        <View style={styles.promptCommit}>
          <Text style={styles.promptDraft}>{formatTime(draft)}</Text>
          <Button
            title="Set"
            icon="check"
            size="sm"
            onPress={() => {
              close();
              onReschedule(draft);
            }}
          />
        </View>
      </Popover>
    </Card>
  );
}

/**
 * Non-blocking guardrail shown on Day-of when one or more permits are DENIED
 * with no fallback plan written. Denied-with-fallback permits don't appear here
 * (the contingency exists). Dismissible; the actual fix — writing the fallback —
 * happens in the Permits grid's editable `fallback` cell.
 */
function PermitFallbackPrompt({
  permits,
}: {
  permits: { _id: Id<"eventItems">; title: string }[];
}) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed || permits.length === 0) return null;
  return (
    <Card style={styles.promptCard}>
      <View style={styles.promptRow}>
        <Icon name="alert-triangle" size={18} color={colors.warn} />
        <View style={{ flex: 1 }}>
          <Text style={styles.promptTitle}>
            {permits.length === 1
              ? "Permit denied — write a fallback plan"
              : `${permits.length} permits denied — write fallback plans`}
          </Text>
          <Text style={styles.promptBody}>
            {permits.map((p) => p.title).join(", ")}. Add an "If denied
            (fallback)" plan in the Permits grid so this stops blocking the event.
          </Text>
        </View>
        <Pressable
          onPress={() => setDismissed(true)}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Dismiss permit fallback prompt"
        >
          <Icon name="x" size={16} color={colors.faint} />
        </Pressable>
      </View>
    </Card>
  );
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
  const reschedule = useMutation(api.events.reschedule);
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
  const permitsNeedingFallback = data.permitsNeedingFallback ?? [];

  // Each segment resolved to its wall-clock START and END. END = start +
  // duration when a positive `duration` (minutes, in the fields bag) is set,
  // else the next segment's start, else a 2h cap on the final row
  // (runOfShowSegmentEnd). `showEnd` is false only for a final row with no
  // duration — there we show a single time, not a bogus 2h range.
  const sorted = [...runOfShow].sort(
    (a, b) => (a.offsetMinutes ?? 0) - (b.offsetMinutes ?? 0),
  );
  const segments = sorted.map((r, i) => {
    const start = computeRunTime(event.eventDate, r.offsetMinutes ?? 0);
    const nextStart =
      i + 1 < sorted.length
        ? computeRunTime(event.eventDate, sorted[i + 1].offsetMinutes ?? 0)
        : null;
    const duration =
      typeof r.fields?.duration === "number" && r.fields.duration > 0
        ? r.fields.duration
        : null;
    return {
      row: r,
      start,
      end: runOfShowSegmentEnd(start, duration, nextStart),
      showEnd: duration != null || nextStart != null,
    };
  });

  // The "now/next" block: the segment currently in progress (its start has
  // passed but its END — the real end, honoring durations — hasn't), or, before
  // the event, the first upcoming row. Highlights what the team should be doing.
  let nowIndex = -1;
  for (let i = 0; i < segments.length; i++) {
    if (now >= segments[i].start && now < segments[i].end) {
      nowIndex = i;
      break;
    }
  }
  // Before the first row starts, point "next" at the first upcoming row.
  if (nowIndex === -1 && segments.length > 0 && now < segments[0].start) {
    nowIndex = 0;
  }

  // Old events created before start-times existed sit at local midnight, so
  // every segment renders at 12:xx AM. Prompt (non-blocking) to set a real one.
  const needsStartTime = isLocalMidnight(event.eventDate);

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

        {/* One-time nudge for events that never got a real start time. */}
        {needsStartTime ? (
          <StartTimePrompt
            eventDate={event.eventDate}
            onReschedule={(ts) =>
              run(() => reschedule({ eventId, eventDate: ts }), {
                errorTitle: "Couldn't set start time",
              })
            }
          />
        ) : null}

        {/* Denied permit with no fallback plan — a guardrail nudge. */}
        <PermitFallbackPrompt permits={permitsNeedingFallback} />

        {/* Run of show */}
        <SectionHeader title="Run of Show" />
        {segments.length === 0 ? (
          <Text style={styles.muted}>No run-of-show rows.</Text>
        ) : (
          <View style={styles.list}>
            {segments.map((seg, i) => {
              const r = seg.row;
              const isNow = i === nowIndex;
              const upcoming = isNow && now < seg.start;
              const startLabel = formatTime(seg.start);
              const timeLabel = seg.showEnd
                ? `${startLabel} – ${formatTime(seg.end)}`
                : startLabel;
              return (
                <Card
                  key={r._id}
                  style={isNow ? styles.rosCardNow : undefined}
                >
                  {isNow ? (
                    <View
                      style={styles.nowBadge}
                      accessibilityLabel={`${upcoming ? "Up next" : "Happening now"}: ${r.title} at ${timeLabel}`}
                    >
                      <Text style={styles.nowBadgeText}>
                        {upcoming ? "UP NEXT" : "NOW"}
                      </Text>
                    </View>
                  ) : null}
                  <View style={styles.rosRow}>
                    <View style={styles.rosTimeCol}>
                      <Text style={styles.rosTime}>{startLabel}</Text>
                      {seg.showEnd ? (
                        <Text style={styles.rosEnd}>
                          –{formatTime(seg.end)}
                        </Text>
                      ) : null}
                    </View>
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
  promptCard: {
    borderColor: colors.warn,
    borderWidth: 1,
    backgroundColor: colors.warnBg,
    marginBottom: spacing.sm,
    gap: spacing.sm,
  },
  promptRow: { flexDirection: "row", gap: spacing.sm, alignItems: "flex-start" },
  promptTitle: { fontSize: 15, fontWeight: "700", color: colors.text },
  promptBody: { fontSize: 13, color: colors.muted, marginTop: 2 },
  promptAction: { alignSelf: "flex-start" },
  promptCommit: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  promptDraft: { fontSize: 15, fontWeight: "700", color: colors.text },
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
  rosTimeCol: { minWidth: 64 },
  rosTime: {
    fontSize: 18,
    fontWeight: "800",
    color: colors.accent,
  },
  rosEnd: {
    fontSize: 12,
    fontWeight: "600",
    color: colors.muted,
    marginTop: 1,
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
