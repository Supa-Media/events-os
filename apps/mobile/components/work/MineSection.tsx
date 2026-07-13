import { View, Text } from "react-native";
import { useRouter } from "expo-router";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import { Card, Icon, Badge, statusTone } from "../ui";
import { colors } from "../../lib/theme";
import { formatDate } from "../../lib/format";
import { EVENT_STATUS_LABELS, type EventStatus } from "@events-os/shared";

type MyWork = NonNullable<FunctionReturnType<typeof api.work.myOpenWork>>;
type WorkEntry = MyWork["overdue"][number];
type MyEvent = MyWork["myEvents"][number];

/** One dated work entry: name, where it lives, and its due date. */
function WorkRow({ entry, overdue }: { entry: WorkEntry; overdue?: boolean }) {
  return (
    <View className="flex-row items-center gap-2 py-1.5">
      <Icon
        name={entry.kind === "project" ? "folder" : "check-square"}
        size={14}
        color={overdue ? colors.danger : colors.muted}
      />
      <View className="flex-1">
        <Text className="text-sm font-medium text-ink" numberOfLines={1}>
          {entry.name}
        </Text>
        {entry.context ? (
          <Text className="text-xs text-faint" numberOfLines={1}>
            {entry.context}
          </Text>
        ) : null}
      </View>
      <Text
        className={`text-xs ${overdue ? "font-semibold text-danger" : "text-muted"}`}
      >
        {formatDate(entry.dueDate)}
      </Text>
    </View>
  );
}

function Bucket({
  title,
  entries,
  overdue,
}: {
  title: string;
  entries: WorkEntry[];
  overdue?: boolean;
}) {
  if (entries.length === 0) return null;
  return (
    <View className="gap-0.5">
      <Text className="mb-0.5 text-2xs font-bold uppercase tracking-wider text-faint">
        {title}
      </Text>
      {entries.map((e, i) => (
        <WorkRow key={i} entry={e} overdue={overdue} />
      ))}
    </View>
  );
}

/**
 * "Mine" — the signed-in person's own open work + the events they own or hold a
 * role on. Leads the Work tab (every pillar leads with your slice; moved here
 * from Events in the July 2026 IA pass). Renders NOTHING when the query returns
 * null (unlinked / admin with no roster row) or every bucket is empty, so
 * accounts with no personal items see the plain Work screen.
 */
export function MineSection() {
  const router = useRouter();
  const mine = useQuery(api.work.myOpenWork);
  if (mine == null) return null;
  const { overdue, dueThisWeek, myEvents } = mine;
  if (overdue.length === 0 && dueThisWeek.length === 0 && myEvents.length === 0) {
    return null;
  }

  return (
    <Card className="mb-6" padding="lg">
      <View className="mb-3 flex-row items-center gap-2">
        <Icon name="user" size={16} color={colors.ink} />
        <Text className="font-display text-lg text-ink">Mine</Text>
      </View>

      <View className="gap-4">
        <Bucket title="Overdue" entries={overdue} overdue />
        <Bucket title="Due this week" entries={dueThisWeek} />

        {myEvents.length > 0 ? (
          <View className="gap-0.5">
            <Text className="mb-0.5 text-2xs font-bold uppercase tracking-wider text-faint">
              My events
            </Text>
            {myEvents.map((e: MyEvent) => (
              <View
                key={e.eventId}
                className="flex-row items-center gap-2 py-1.5"
              >
                <Icon name="calendar" size={14} color={colors.muted} />
                <Text
                  className="flex-1 text-sm font-medium text-accent"
                  numberOfLines={1}
                  onPress={() => router.push(`/event/${e.eventId}`)}
                >
                  {e.name}
                </Text>
                <Text className="text-xs text-muted">
                  {formatDate(e.eventDate)}
                </Text>
                <Badge
                  label={EVENT_STATUS_LABELS[e.status as EventStatus]}
                  tone={statusTone(e.status as EventStatus)}
                />
              </View>
            ))}
          </View>
        ) : null}
      </View>
    </Card>
  );
}
