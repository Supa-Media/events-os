/**
 * The organizer's door roster — every ticket for the event WITH its code.
 *
 * The deliberate opposite of the door-mode guest list
 * (`components/door/AttendeeCheckInList`), which hides codes so a volunteer
 * can't admit people who aren't standing there. This list is only reachable
 * from inside Chapter OS by a chapter member on their own event page, where
 * the job it exists for — "a guest turned up and can't find their
 * confirmation email" — was previously impossible: nothing in the app showed
 * a ticket code anywhere.
 *
 * Tapping a row fills the code into the check-in field rather than admitting
 * on the spot. One more deliberate press keeps "look up a code" and "let
 * someone in" as two different actions.
 */
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { teamColor } from "@events-os/shared";
import { Card, Icon, TextField } from "../../ui";
import { colors } from "../../../lib/theme";
import { formatDateTime } from "../../../lib/format";

type AdminAttendee = {
  _id: string;
  attendeeName: string;
  attendeeEmail: string;
  ticketTypeName: string;
  code: string;
  status: "valid" | "checked_in" | "void";
  checkedInAt: number | null;
  teamId: string | null;
  teamName: string | null;
  teamColor: string | null;
};

/** Name, email OR code — looking someone up by the code they read out loud is
 *  half the point of this list. */
function matches(a: AdminAttendee, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    a.attendeeName.toLowerCase().includes(q) ||
    a.attendeeEmail.toLowerCase().includes(q) ||
    a.code.toLowerCase().includes(q.replace(/\s/g, "")) ||
    (a.teamName ?? "").toLowerCase().includes(q)
  );
}

export function AdminCheckInRoster({
  eventId,
  onPickCode,
}: {
  eventId: Id<"events">;
  /** Fill this code into the check-in field above. */
  onPickCode: (code: string) => void;
}) {
  const attendees = useQuery(api.ticketing.listCheckInAttendeesAdmin, {
    eventId,
  }) as AdminAttendee[] | undefined;
  const [query, setQuery] = useState("");

  if (attendees === undefined) {
    return (
      <Text className="mt-3 text-sm text-muted">Loading guest list…</Text>
    );
  }
  if (attendees.length === 0) return null;

  const shown = attendees.filter((a) => matches(a, query));
  const admittable = attendees.filter((a) => a.status !== "void");
  const checkedIn = admittable.filter((a) => a.status === "checked_in").length;

  return (
    <View className="mt-4">
      <View className="mb-2 flex-row items-baseline justify-between">
        <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
          Ticket holders
        </Text>
        <Text className="text-xs text-muted">
          {checkedIn} of {admittable.length} checked in
        </Text>
      </View>

      <Card padding="none">
        <View className="border-b border-border px-4 pt-3">
          <TextField
            value={query}
            onChangeText={setQuery}
            placeholder="Search name, email or code"
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
            <Pressable
              key={a._id}
              onPress={() => onPickCode(a.code)}
              accessibilityRole="button"
              accessibilityLabel={`Use ${a.attendeeName}'s ticket code`}
              className={`flex-row items-center gap-3 px-4 py-3 active:opacity-70 ${
                i === shown.length - 1 ? "" : "border-b border-border"
              }`}
            >
              <View className="min-w-0 flex-1">
                <View className="flex-row items-center gap-2">
                  <Text
                    className="shrink text-sm font-medium text-ink"
                    numberOfLines={1}
                  >
                    {a.attendeeName}
                  </Text>
                  <TeamChip name={a.teamName} color={a.teamColor} />
                </View>
                <Text className="mt-0.5 font-mono text-xs text-muted">
                  {a.code}
                </Text>
              </View>
              {a.status === "checked_in" ? (
                <View className="flex-row items-center gap-1.5">
                  <Icon name="check-circle" size={14} color={colors.success} />
                  <Text className="text-xs text-muted">
                    {a.checkedInAt ? formatDateTime(a.checkedInAt) : "In"}
                  </Text>
                </View>
              ) : a.status === "void" ? (
                <Text className="text-xs text-muted line-through">Void</Text>
              ) : (
                <Text className="text-xs text-muted">Not arrived</Text>
              )}
            </Pressable>
          ))
        )}
      </Card>
      <Text className="mt-1.5 text-xs text-faint">
        Tap a guest to drop their code into the field above. The door-mode
        screen never shows codes — admitting there needs the guest's own ticket.
      </Text>
    </View>
  );
}

function TeamChip({
  name,
  color,
}: {
  name: string | null;
  color: string | null;
}) {
  if (!name) return null;
  const c = teamColor(color);
  return (
    <View
      className="rounded-pill px-2 py-0.5"
      style={{ backgroundColor: c.chipBg }}
    >
      <Text className="text-2xs font-bold" style={{ color: c.chipText }}>
        {name}
      </Text>
    </View>
  );
}
