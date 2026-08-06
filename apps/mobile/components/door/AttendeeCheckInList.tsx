import { useState } from "react";
import { View, Text, ActivityIndicator } from "react-native";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Card, TextField, Icon } from "../ui";
import { colors } from "../../lib/theme";
import { checkInProgress, filterAttendees, type DoorAttendee } from "./attendeeList";
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
              placeholder="Search names"
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

function AttendeeRow({
  attendee,
  isLast,
}: {
  attendee: DoorAttendee;
  isLast: boolean;
}) {
  return (
    <View
      className={`flex-row items-center gap-3 px-4 py-3 ${
        isLast ? "" : "border-b border-border"
      }`}
    >
      <View className="flex-1">
        <Text className="text-sm font-medium text-ink" numberOfLines={1}>
          {attendee.attendeeName}
        </Text>
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
