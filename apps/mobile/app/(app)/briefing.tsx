import { View, Text } from "react-native";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import { Screen, PageHeader, EmptyState } from "../../components/ui";
import { BriefingView } from "../../components/crew/BriefingView";

type Briefing = FunctionReturnType<typeof api.events.myBriefing>["events"][number];

/**
 * The volunteer lobby — every upcoming event this person is on, each rendered
 * as the same read-only briefing the public share link shows (via BriefingView),
 * led by a "You're on: … · Call time …" line. Read-only: one query, no edits.
 * Non-volunteers can reach it too and simply get the empty state.
 */
export default function BriefingScreen() {
  const data = useQuery(api.events.myBriefing);
  if (data === undefined) return <Screen loading />;

  const events = data.events;

  return (
    <Screen maxWidth={760}>
      <PageHeader
        eyebrow="Your schedule"
        title="Briefing"
        subtitle="Where you're serving and what each team is doing."
      />

      {events.length === 0 ? (
        <View className="mt-6">
          <EmptyState
            icon="clipboard"
            title="Nothing on your schedule yet"
            message="When you're added to an event's crew, its briefing shows up here."
          />
        </View>
      ) : (
        <View className="mt-4 items-center gap-10">
          {events.map((ev) => (
            <BriefingView
              key={ev.eventId}
              crew={ev.crew}
              myTeams={ev.myTeams}
              subtitle={briefingSubtitle(ev)}
            />
          ))}
        </View>
      )}
    </Screen>
  );
}

/** "You're on: Ushering, Media · Call time 8:00 AM" — team VALUES resolved to
 *  their labels from the crew payload, call time appended when set. */
function briefingSubtitle(ev: Briefing): string {
  const labelByValue = new Map(ev.crew.teams.map((t) => [t.value, t.label]));
  const teams = ev.myTeams.map((v) => labelByValue.get(v) ?? v);
  const parts: string[] = [];
  if (teams.length > 0) parts.push(`You're on: ${teams.join(", ")}`);
  if (ev.myCallTime) parts.push(`Call time ${ev.myCallTime}`);
  return parts.join(" · ") || "You're on the crew for this event.";
}
