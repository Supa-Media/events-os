import { useState } from "react";
import { View, Text, ActivityIndicator, Pressable } from "react-native";
import { useMutation, useQuery } from "convex/react";
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
  // Ticket id whose team picker is open, or null. One at a time.
  const [moving, setMoving] = useState<string | null>(null);

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
            <TeamStandingChip key={s.teamId} standing={s} />
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
              <View key={a._id}>
                <AttendeeRow
                  attendee={a}
                  isLast={i === shown.length - 1 && moving !== a._id}
                  // Only a guest who's actually been placed can be moved —
                  // before they arrive there's no wristband to correct.
                  onPress={
                    a.teamId
                      ? () => setMoving(moving === a._id ? null : a._id)
                      : undefined
                  }
                />
                {moving === a._id ? (
                  <TeamPicker
                    eventId={eventId}
                    attendee={a}
                    onDone={() => setMoving(null)}
                  />
                ) : null}
              </View>
            ))
          )}
        </Card>
      )}
    </View>
  );
}

/**
 * The move-this-guest-to-another-team control, opened by tapping a checked-in
 * guest's row.
 *
 * The door's only escape hatch: assignment hands out a PHYSICAL wristband, so
 * a mis-scan, a wrong band, or a family that wants to be together can't be
 * undone any other way (nothing in this app un-checks-in a ticket). Gated
 * server-side on check-in access, not on manage access, because the person who
 * needs it is whoever is standing at the door when it goes wrong.
 *
 * Moving someone leaves one team a head over and another a head under; the
 * balancing rule absorbs that over the next few arrivals rather than needing a
 * rebalance, so there's deliberately no "even them out" button here.
 */
function TeamPicker({
  eventId,
  attendee,
  onDone,
}: {
  eventId: Id<"events">;
  attendee: DoorAttendee;
  onDone: () => void;
}) {
  const data = useQuery(api.guestTeams.listForEvent, { eventId });
  const setTicketTeam = useMutation(api.guestTeams.setTicketTeam);
  const [busy, setBusy] = useState(false);
  const teams = (data?.teams ?? []).filter((t) => t.isActive);

  if (teams.length === 0) return null;

  async function move(teamId: string) {
    if (teamId === attendee.teamId) return onDone();
    setBusy(true);
    try {
      await setTicketTeam({
        ticketId: attendee._id as Id<"tickets">,
        teamId: teamId as Id<"guestTeams">,
      });
      onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <View className="border-b border-border bg-sunken px-4 py-3">
      <Text className="mb-2 text-2xs font-bold uppercase tracking-wider text-muted">
        Move {attendee.attendeeName} to
      </Text>
      <View className="flex-row flex-wrap gap-1.5">
        {teams.map((t) => {
          const c = teamColor(t.color);
          const current = t._id === attendee.teamId;
          return (
            <Pressable
              key={t._id}
              disabled={busy}
              onPress={() => void move(t._id)}
              accessibilityRole="button"
              accessibilityState={{ selected: current, disabled: busy }}
              className={`rounded-pill px-3 py-1.5 active:opacity-70 ${busy ? "opacity-50" : ""}`}
              style={{
                backgroundColor: current ? c.solid : c.chipBg,
                borderWidth: 1,
                borderColor: c.solid,
              }}
            >
              <Text
                className="text-xs font-bold"
                style={{ color: current ? c.onSolid : c.chipText }}
              >
                {t.name}
                {current ? " ✓" : ""}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <Pressable onPress={onDone} className="mt-2 active:opacity-70">
        <Text className="text-xs text-muted">Cancel</Text>
      </Pressable>
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
  onPress,
}: {
  attendee: DoorAttendee;
  isLast: boolean;
  /** Present only when this guest can be moved (checked in, on a team). */
  onPress?: () => void;
}) {
  const c = attendee.teamName ? teamColor(attendee.teamColor) : null;
  return (
    <Pressable
      disabled={!onPress}
      onPress={onPress}
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityLabel={
        onPress ? `Change ${attendee.attendeeName}'s team` : undefined
      }
      className={`flex-row items-center gap-3 px-4 py-3 ${
        onPress ? "active:opacity-70" : ""
      } ${isLast ? "" : "border-b border-border"}`}
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
    </Pressable>
  );
}
