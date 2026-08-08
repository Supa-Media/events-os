import { useState } from "react";
import { View, Text, ActivityIndicator } from "react-native";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { teamColor } from "@events-os/shared";
import { Card, TextField, Icon } from "../ui";
import { colors } from "../../lib/theme";
import {
  checkInProgress,
  filterAttendees,
  teamStandings,
  type DoorAttendee,
  type TeamStanding,
} from "./attendeeList";
import { formatDateTime } from "../../lib/format";

/**
 * The event's guest list for the door — VIEW-ONLY. Shows who's expected and
 * who's already in (name, ticket type, status, when), searchable by name,
 * with a checked-in tally. There is deliberately NO check-in action here and
 * no ticket code on the rows: admitting a guest requires the code from THEIR
 * ticket (scanned by the camera or typed into the code field), proving the
 * ticket is present — the server (`listCheckInAttendees`) withholds codes
 * for the same reason. Reactive: check-ins from any door volunteer flip the
 * rows live.
 */
export function AttendeeCheckInList({ eventId }: { eventId: Id<"events"> }) {
  const attendees = useQuery(api.ticketing.listCheckInAttendees, { eventId });
  const [query, setQuery] = useState("");

  if (attendees === undefined) {
    return (
      <View className="items-center py-8">
        <ActivityIndicator color={colors.muted} />
      </View>
    );
  }

  const progress = checkInProgress(attendees);
  const shown = filterAttendees(attendees, query);
  const standings = teamStandings(attendees);

  return (
    <View className="mt-4">
      <View className="mb-2 flex-row items-baseline justify-between">
        <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
          Guest list
        </Text>
        <Text className="text-xs text-muted">
          {progress.checkedIn} of {progress.total} checked in
        </Text>
      </View>

      {standings.length > 0 ? (
        <View className="mb-2 flex-row flex-wrap gap-1.5">
          {standings.map((s) => (
            <TeamStandingChip key={s.name} standing={s} />
          ))}
        </View>
      ) : null}

      {attendees.length === 0 ? (
        <Card>
          <Text className="text-sm text-muted">
            No tickets issued yet — guests will appear here as they get tickets.
          </Text>
        </Card>
      ) : (
        <Card padding="none">
          <View className="border-b border-border px-4 pt-3">
            <TextField
              value={query}
              onChangeText={setQuery}
              placeholder={
                standings.length > 0 ? "Search names or teams" : "Search names"
              }
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>
          {shown.length === 0 ? (
            <View className="px-4 py-6">
              <Text className="text-center text-sm text-muted">
                Nobody matches "{query.trim()}".
              </Text>
            </View>
          ) : (
            shown.map((a, i) => (
              <AttendeeRow key={a._id} attendee={a} isLast={i === shown.length - 1} />
            ))
          )}
        </Card>
      )}
    </View>
  );
}

/** "Blue 11" — one team's running headcount above the list. */
function TeamStandingChip({ standing }: { standing: TeamStanding }) {
  const c = teamColor(standing.color);
  return (
    <View
      className="flex-row items-center gap-1.5 rounded-pill px-2.5 py-1"
      style={{ backgroundColor: c.chipBg }}
    >
      <View
        className="h-2 w-2 rounded-pill"
        style={{ backgroundColor: c.solid }}
      />
      <Text className="text-2xs font-bold" style={{ color: c.chipText }}>
        {standing.name} {standing.count}
      </Text>
    </View>
  );
}

function AttendeeRow({
  attendee,
  isLast,
}: {
  attendee: DoorAttendee;
  isLast: boolean;
}) {
  const c = attendee.teamName ? teamColor(attendee.teamColor) : null;
  return (
    <View
      className={`flex-row items-center gap-3 px-4 py-3 ${
        isLast ? "" : "border-b border-border"
      }`}
    >
      <View className="flex-1">
        <View className="flex-row items-center gap-2">
          <Text className="shrink text-sm font-medium text-ink" numberOfLines={1}>
            {attendee.attendeeName}
          </Text>
          {c && attendee.teamName ? (
            <View
              className="rounded-pill px-2 py-0.5"
              style={{ backgroundColor: c.chipBg }}
            >
              <Text className="text-2xs font-bold" style={{ color: c.chipText }}>
                {attendee.teamName}
              </Text>
            </View>
          ) : null}
        </View>
        <Text className="mt-0.5 text-xs text-muted" numberOfLines={1}>
          {attendee.ticketTypeName}
        </Text>
      </View>
      {attendee.status === "checked_in" ? (
        <View className="flex-row items-center gap-1.5">
          <Icon name="check-circle" size={14} color={colors.success} />
          <Text className="text-xs text-muted">
            {attendee.checkedInAt ? formatDateTime(attendee.checkedInAt) : "Checked in"}
          </Text>
        </View>
      ) : attendee.status === "void" ? (
        <Text className="text-xs text-muted line-through">Void</Text>
      ) : (
        <Text className="text-xs text-muted">Not arrived</Text>
      )}
    </View>
  );
}
