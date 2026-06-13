import { useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { useQuery, useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import {
  Screen,
  Card,
  Button,
  Badge,
  ReadinessBadge,
  EmptyState,
  statusTone,
} from "../../../components/ui";
import { colors, spacing } from "../../../lib/theme";
import { formatDate } from "../../../lib/format";
import { EVENT_STATUS_LABELS, type EventStatus } from "@events-os/shared";

/** PIPELINE / home: dashboard stats + upcoming event cards. */
export default function PipelineScreen() {
  const router = useRouter();
  const summary = useQuery(api.dashboard.summary);
  const pipeline = useQuery(api.events.pipeline);
  const templates = useQuery(api.eventTypes.list);

  const seed = useMutation(api.seed.seedDemoData);
  const [seeding, setSeeding] = useState(false);

  const loading =
    summary === undefined || pipeline === undefined || templates === undefined;

  if (loading) return <Screen loading />;

  const isEmpty = pipeline.length === 0;
  const noTemplates = templates.length === 0;

  async function handleSeed() {
    setSeeding(true);
    try {
      await seed({});
    } finally {
      setSeeding(false);
    }
  }

  return (
    <Screen>
      <StatRow summary={summary} />

      <View style={styles.actionRow}>
        <Button
          title="+ New event"
          onPress={() => router.push("/event/new")}
        />
      </View>

      {isEmpty ? (
        noTemplates ? (
          <EmptyState
            title="Nothing here yet"
            message="Seed some demo data to explore the pipeline, templates, and people."
            action={
              <Button
                title="Seed demo data"
                variant="secondary"
                loading={seeding}
                onPress={handleSeed}
              />
            }
          />
        ) : (
          <EmptyState
            title="No upcoming events"
            message="Start an event from one of your templates."
            action={
              <Button
                title="+ New event"
                onPress={() => router.push("/event/new")}
              />
            }
          />
        )
      ) : (
        <View style={styles.list}>
          {pipeline.map((e: any) => (
            <EventCard
              key={e._id}
              event={e}
              onPress={() => router.push(`/event/${e._id}`)}
            />
          ))}
        </View>
      )}
    </Screen>
  );
}

function StatRow({ summary }: { summary: any }) {
  return (
    <Card style={styles.statCard}>
      <Stat label="Upcoming" value={String(summary.upcomingCount)} />
      <Divider />
      <Stat label="Avg readiness" value={`${summary.avgReadiness}%`} />
      <Divider />
      <Stat label="People" value={String(summary.peopleCount)} />
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function Divider() {
  return <View style={styles.divider} />;
}

function EventCard({ event, onPress }: { event: any; onPress: () => void }) {
  return (
    <Card onPress={onPress}>
      <View style={styles.cardTop}>
        <Text style={styles.eventName} numberOfLines={1}>
          {event.name}
        </Text>
        <ReadinessBadge value={event.readiness} />
      </View>
      <Text style={styles.eventMeta}>
        {event.eventTypeName} · {formatDate(event.eventDate)}
      </Text>
      <View style={styles.cardBottom}>
        <Badge
          label={EVENT_STATUS_LABELS[event.status as EventStatus]}
          tone={statusTone(event.status as EventStatus)}
        />
        <Text style={styles.taskCount}>
          {event.taskDone}/{event.taskTotal} tasks
        </Text>
        {event.blockerCount > 0 ? (
          <Badge label={`${event.blockerCount} overdue`} tone="danger" />
        ) : null}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  statCard: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  stat: { flex: 1, alignItems: "center" },
  statValue: { fontSize: 22, fontWeight: "700", color: colors.text },
  statLabel: { fontSize: 12, color: colors.muted, marginTop: 2 },
  divider: { width: 1, height: 32, backgroundColor: colors.border },
  actionRow: { marginTop: spacing.lg },
  list: { marginTop: spacing.lg, gap: spacing.md },
  cardTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  eventName: { fontSize: 16, fontWeight: "700", color: colors.text, flex: 1 },
  eventMeta: { fontSize: 13, color: colors.muted, marginTop: spacing.xs },
  cardBottom: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  taskCount: { fontSize: 13, color: colors.muted },
});
