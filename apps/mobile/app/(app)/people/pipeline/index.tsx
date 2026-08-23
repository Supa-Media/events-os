/**
 * PEOPLE · Team applications — the seat pipeline on one screen.
 *
 * Deliberately one list with stage filters rather than a board: the question
 * this screen exists to answer is not "what's the shape of the funnel" but
 * "who is waiting on us?" — so the numbers along the top are the ones that
 * name a failure (past the reply promise, nobody's owner, a trial past its
 * midpoint, a decision nobody has made), and the default list is every open
 * file, newest first.
 *
 * CENTRAL-only, like Territories and Interest: the backend gates reads on
 * `hiring.view` and writes on `hiring.edit` / `hiring.approve`
 * (`apps/convex/lib/hiringAccess.ts`). This screen is a VIEW surface first —
 * a `hiring.view` holder browses everything and simply gets no actions.
 *
 * What feeds it is public: `/careers` and `/careers/apply` on the landing site
 * (`apps/landing/src/pages/careers/`).
 */
import { useState } from "react";
import { View, Text, Pressable, ScrollView } from "react-native";
import { useQuery } from "convex/react";
import { useRouter } from "expo-router";
import { api } from "@events-os/convex/_generated/api";
import {
  CLOSED_HIRING_STAGES,
  HIRING_STAGE_DEFS,
  OPEN_HIRING_STAGES,
  RESPONSE_PROMISE_DAYS,
  isStale,
  type HiringStage,
} from "@events-os/shared";
import { stageTone } from "../../../../lib/hiringStage";
import { PipelineTabs } from "../../../../components/people/PipelineTabs";
import {
  Badge,
  Card,
  EmptyState,
  Narrow,
  Pill,
  Screen,
  SectionHeader,
} from "../../../../components/ui";

function daysAgo(ts: number): string {
  const days = Math.floor((Date.now() - ts) / (24 * 60 * 60 * 1000));
  if (days <= 0) return "today";
  if (days === 1) return "1 day ago";
  return `${days} days ago`;
}

/** One number the desk is measured by. Zero is the good answer for three of
 *  the four, so a zero renders quiet and anything else renders loud. */
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

export default function TeamPipelineScreen() {
  const access = useQuery(api.hiring.myHiringAccess, {});

  if (access === undefined) return <Screen loading />;
  if (!access.canView) {
    return (
      <Screen>
        <Narrow>
          <EmptyState
            icon="lock"
            title="Hiring desk access needed"
            message="Ask the People Director or the ED for access to the hiring pipeline."
          />
        </Narrow>
      </Screen>
    );
  }
  return <PipelineBody />;
}

function PipelineBody() {
  const router = useRouter();
  // `null` = every open file (the default). A stage id filters to that column;
  // "closed" shows the four terminal stages together, because closed files are
  // browsed as a group ("who did we say not-now to?") rather than per outcome.
  const [filter, setFilter] = useState<HiringStage | "closed" | null>(null);

  const summary = useQuery(api.hiring.pipelineSummary, {});
  const rows = useQuery(api.hiring.listApplications, {
    ...(filter && filter !== "closed" ? { stage: filter } : {}),
    ...(filter === "closed" ? { includeClosed: true } : {}),
  });

  if (rows === undefined || summary === undefined) return <Screen loading />;

  const visible =
    filter === "closed"
      ? rows.filter((r) => CLOSED_HIRING_STAGES.includes(r.stage as HiringStage))
      : rows;

  return (
    <Screen>
      <Narrow>
        <PipelineTabs />
        <SectionHeader title="Team applications" count={`${summary.open} open`} />
        <Text className="mb-3 text-sm text-muted">
          Everyone applying for a SEAT comes through here — one funnel, one
          standard. We promise a human reply within {RESPONSE_PROMISE_DAYS}{" "}
          days. (Volunteers who just want to help at a gathering are the other
          tab.)
        </Text>

        <View className="mb-4 flex-row flex-wrap gap-2">
          <Stat label="Open files" value={summary.open} />
          <Stat label="Past our promise" value={summary.pastPromise} alarming />
          <Stat label="No owner" value={summary.unassigned} alarming />
          <Stat label="Trial reviews due" value={summary.trialReviewsDue} alarming />
          <Stat label="Awaiting the call" value={summary.awaitingDecision} alarming />
        </View>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 8, paddingBottom: 12 }}
        >
          <Pill
            label={`All open (${summary.open})`}
            selected={filter === null}
            onPress={() => setFilter(null)}
          />
          {OPEN_HIRING_STAGES.map((stage) => (
            <Pill
              key={stage}
              label={`${HIRING_STAGE_DEFS[stage].label} (${summary.byStage[stage] ?? 0})`}
              selected={filter === stage}
              onPress={() => setFilter(stage)}
            />
          ))}
          <Pill
            label="Closed"
            selected={filter === "closed"}
            onPress={() => setFilter("closed")}
          />
        </ScrollView>

        {visible.length === 0 ? (
          <EmptyState
            title="Nothing here"
            message="Applications from /team land in this pipeline. Nothing is sitting in this stage right now."
          />
        ) : (
          <View className="gap-2">
            {visible.map((row) => {
              const stage = row.stage as HiringStage;
              const overdue = isStale(stage, row.stageChangedAt, Date.now());
              return (
                <Pressable
                  key={row._id}
                  onPress={() => router.navigate(`/people/pipeline/${row._id}` as never)}
                >
                  <Card padding="md">
                    <View className="mb-1 flex-row items-center justify-between gap-2">
                      <Text
                        className="flex-1 text-sm font-semibold text-ink"
                        numberOfLines={1}
                      >
                        {row.name}
                      </Text>
                      <Badge
                        label={HIRING_STAGE_DEFS[stage].label}
                        tone={stageTone(stage)}
                      />
                    </View>
                    <Text className="text-xs text-muted" numberOfLines={1}>
                      {row.roleTitle}
                      {row.location ? ` · ${row.location}` : ""}
                    </Text>
                    <View className="mt-2 flex-row flex-wrap items-center gap-2">
                      {overdue ? (
                        <Badge label="Waiting on us" tone="danger" icon="clock" />
                      ) : null}
                      {!row.assignedTo ? (
                        <Badge label="No owner" tone="warn" />
                      ) : (
                        <Badge
                          label={row.assignedToName ?? "Owned"}
                          tone="neutral"
                          icon="user"
                        />
                      )}
                      {row.reviewCount > 0 ? (
                        <Badge
                          label={`${row.reviewCount} review${row.reviewCount === 1 ? "" : "s"}`}
                          tone="info"
                        />
                      ) : null}
                      {row.outcome === "not_now" && row.revisitAt ? (
                        <Badge
                          label={`Revisit ${new Date(row.revisitAt).toLocaleDateString()}`}
                          tone="lavender"
                        />
                      ) : null}
                      {row.outcome &&
                      row.outcome !== "withdrawn" &&
                      !row.outcomeMessageSentAt ? (
                        <Badge label="Owes them a message" tone="danger" />
                      ) : null}
                    </View>
                    <Text className="mt-2 text-xs text-faint">
                      Applied {daysAgo(row.createdAt)}
                    </Text>
                  </Card>
                </Pressable>
              );
            })}
          </View>
        )}
      </Narrow>
    </Screen>
  );
}
