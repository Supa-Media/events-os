/**
 * PEOPLE · Volunteer signups — the light pipeline's inbox.
 *
 * Everything here is smaller than the team pipeline next door, on purpose:
 * no rubric, no stages worth a board, no decision. Somebody offered to help
 * carry speakers. The only two questions are whether a human has replied and
 * whether they're on the roster yet — so those are the only two numbers, and
 * "Add to roster" is the only real button.
 *
 * Same gate as the team pipeline (`hiring.view` / `hiring.edit`): one seat is
 * answerable for how the whole org gets its people. What feeds it is the
 * signup form on `/serve`.
 */
import { useState } from "react";
import { View, Text, Pressable, ScrollView } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  VOLUNTEER_AREAS,
  VOLUNTEER_STAGE_DEFS,
  VOLUNTEER_STAGES,
  type VolunteerStage,
} from "@events-os/shared";
import {
  Badge,
  type BadgeTone,
  Button,
  Card,
  EmptyState,
  Narrow,
  Pill,
  Screen,
  SectionHeader,
} from "../../../components/ui";
import { PipelineTabs } from "../../../components/people/PipelineTabs";

const AREA_LABELS: Record<string, string> = Object.fromEntries(
  VOLUNTEER_AREAS.map((a) => [a.id, a.label]),
);

function stageTone(stage: VolunteerStage): BadgeTone {
  switch (stage) {
    case "new":
      return "accent";
    case "contacted":
      return "info";
    case "rostered":
      return "success";
    default:
      return "neutral";
  }
}

function daysAgo(ts: number): string {
  const days = Math.floor((Date.now() - ts) / (24 * 60 * 60 * 1000));
  if (days <= 0) return "today";
  if (days === 1) return "1 day ago";
  return `${days} days ago`;
}

function Stat({
  label,
  value,
  alarming,
}: {
  label: string;
  value: number;
  alarming?: boolean;
}) {
  const loud = alarming && value > 0;
  return (
    <View className="min-w-[104px] flex-1 rounded-md border border-border bg-raised px-3 py-2.5">
      <Text
        className={`text-2xl font-semibold ${loud ? "text-danger" : "text-ink"}`}
      >
        {value}
      </Text>
      <Text className="mt-0.5 text-xs text-muted">{label}</Text>
    </View>
  );
}

export default function VolunteerSignupsScreen() {
  const access = useQuery(api.hiring.myHiringAccess, {});

  if (access === undefined) return <Screen loading />;
  if (!access.canView) {
    return (
      <Screen>
        <Narrow>
          <EmptyState
            icon="lock"
            title="People desk access needed"
            message="Ask the People Director or the ED for access to the volunteer pipeline."
          />
        </Narrow>
      </Screen>
    );
  }
  return <SignupsBody canManage={access.canManage} />;
}

function SignupsBody({ canManage }: { canManage: boolean }) {
  const [filter, setFilter] = useState<VolunteerStage | null>(null);
  const [busyId, setBusyId] = useState<Id<"volunteerSignups"> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const summary = useQuery(api.volunteers.signupSummary, {});
  const rows = useQuery(api.volunteers.listSignups, {
    ...(filter ? { stage: filter } : {}),
  });
  const setStage = useMutation(api.volunteers.setStage);
  const addToRoster = useMutation(api.volunteers.addToRoster);

  if (rows === undefined || summary === undefined) return <Screen loading />;

  async function guard(
    id: Id<"volunteerSignups">,
    run: () => Promise<unknown>,
  ): Promise<void> {
    if (busyId) return;
    setBusyId(id);
    setError(null);
    try {
      await run();
    } catch (err) {
      setError(
        (err as { data?: { message?: string } })?.data?.message ??
          "That didn't go through.",
      );
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Screen>
      <Narrow>
        <PipelineTabs />
        <SectionHeader
          title="Volunteer signups"
          count={`${summary.open} open`}
        />
        <Text className="mb-3 text-sm text-muted">
          People who want to help at a gathering, not hold a seat. Reply,
          then put them on the roster so they show up when an event needs
          those hands. We promise a reply within {summary.replyDays} days.
        </Text>

        <View className="mb-4 flex-row flex-wrap gap-2">
          <Stat label="Waiting" value={summary.open} />
          <Stat label="Unanswered" value={summary.unanswered} alarming />
          <Stat label="Past our promise" value={summary.pastPromise} alarming />
          <Stat label="On the roster" value={summary.rostered} />
        </View>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 8, paddingBottom: 12 }}
        >
          <Pill
            label="Waiting"
            selected={filter === null}
            onPress={() => setFilter(null)}
          />
          {VOLUNTEER_STAGES.map((stage) => (
            <Pill
              key={stage}
              label={VOLUNTEER_STAGE_DEFS[stage].label}
              selected={filter === stage}
              onPress={() => setFilter(stage)}
            />
          ))}
        </ScrollView>

        {error ? (
          <View className="mb-3 rounded-md border border-danger bg-danger-bg px-3 py-2">
            <Text className="text-sm text-danger">{error}</Text>
          </View>
        ) : null}

        {rows.length === 0 ? (
          <EmptyState
            title="Nothing waiting"
            message="Signups from the form on /serve land here."
          />
        ) : (
          <View className="gap-2">
            {rows.map((row) => {
              const stage = row.stage as VolunteerStage;
              return (
                <Card key={row._id} padding="md">
                  <View className="mb-1 flex-row items-center justify-between gap-2">
                    <Text
                      className="flex-1 text-sm font-semibold text-ink"
                      numberOfLines={1}
                    >
                      {row.name}
                    </Text>
                    <Badge
                      label={VOLUNTEER_STAGE_DEFS[stage].label}
                      tone={stageTone(stage)}
                    />
                  </View>
                  <Text className="text-xs text-muted">
                    {row.email}
                    {row.phone ? ` · ${row.phone}` : ""}
                    {row.location ? ` · ${row.location}` : ""}
                  </Text>

                  <View className="mt-2 flex-row flex-wrap gap-1">
                    {row.areas.map((area) => (
                      <Badge
                        key={area}
                        label={AREA_LABELS[area] ?? area}
                        tone="neutral"
                      />
                    ))}
                  </View>

                  {row.availability ? (
                    <Text className="mt-2 text-sm text-ink">
                      Free: {row.availability}
                    </Text>
                  ) : null}
                  {row.message ? (
                    <Text className="mt-1 text-sm text-ink">{row.message}</Text>
                  ) : null}

                  <Text className="mt-2 text-xs text-faint">
                    Signed up {daysAgo(row.createdAt)}
                  </Text>

                  {canManage && stage !== "rostered" ? (
                    <View className="mt-3 flex-row flex-wrap items-center gap-2">
                      {stage === "new" ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          title="Mark reached out"
                          disabled={busyId === row._id}
                          onPress={() =>
                            void guard(row._id, () =>
                              setStage({ signupId: row._id, stage: "contacted" }),
                            )
                          }
                        />
                      ) : null}
                      <Button
                        size="sm"
                        title="Add to roster"
                        disabled={busyId === row._id}
                        onPress={() =>
                          void guard(row._id, () =>
                            addToRoster({ signupId: row._id }),
                          )
                        }
                      />
                      {stage !== "archived" ? (
                        <Pressable
                          disabled={busyId === row._id}
                          onPress={() =>
                            void guard(row._id, () =>
                              setStage({ signupId: row._id, stage: "archived" }),
                            )
                          }
                        >
                          <Text className="px-2 py-1.5 text-xs text-muted">
                            Archive
                          </Text>
                        </Pressable>
                      ) : null}
                    </View>
                  ) : null}
                </Card>
              );
            })}
          </View>
        )}
      </Narrow>
    </Screen>
  );
}
