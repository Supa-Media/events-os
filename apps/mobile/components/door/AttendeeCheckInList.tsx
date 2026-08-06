import { useState } from "react";
import { View, Text, ActivityIndicator } from "react-native";
import { useQuery, useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Card, Button, TextField, Icon } from "../ui";
import type { ActionRunner } from "../../lib/useActionToast";
import { colors } from "../../lib/theme";
import { checkInProgress, filterAttendees, type DoorAttendee } from "./attendeeList";
import { formatDateTime } from "../../lib/format";

/**
 * The event's guest list for the door — every issued ticket with a manual
 * "Check in" button, so a guest whose QR won't scan (cracked screen, paper
 * printout left at home) can be admitted by name. Reads
 * `listCheckInAttendees` (door-gated, same `requireCheckInAccess` as the
 * scanner) and replays the row's ticket code through the SAME `checkInTicket`
 * mutation — the list is purely another input path, like manual code entry.
 * Reactive: a check-in from the scanner or another door volunteer flips the
 * row live.
 */
export function AttendeeCheckInList({
  eventId,
  run,
}: {
  eventId: Id<"events">;
  run: ActionRunner["run"];
}) {
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
              placeholder="Search name or ticket code"
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
              <AttendeeRow
                key={a._id}
                attendee={a}
                isLast={i === shown.length - 1}
                eventId={eventId}
                run={run}
              />
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
  eventId,
  run,
}: {
  attendee: DoorAttendee & { _id: Id<"tickets"> };
  isLast: boolean;
  eventId: Id<"events">;
  run: ActionRunner["run"];
}) {
  const checkIn = useMutation(api.ticketing.checkInTicket);
  const [busy, setBusy] = useState(false);

  async function handleCheckIn() {
    setBusy(true);
    try {
      await run(() => checkIn({ eventId, code: attendee.code }), {
        errorTitle: "Couldn't check in",
      });
    } finally {
      setBusy(false);
    }
  }

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
          {attendee.ticketTypeName} · {attendee.code}
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
        <Button
          title="Check in"
          size="sm"
          variant="secondary"
          loading={busy}
          onPress={handleCheckIn}
        />
      )}
    </View>
  );
}
