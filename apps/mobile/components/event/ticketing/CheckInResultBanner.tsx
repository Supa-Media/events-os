/**
 * The four-branch check-in outcome banner — extracted from `CheckInCard` so
 * `TicketScanner` (the QR scanner's result view) renders the EXACT same
 * ok/already/void/not_found copy the manual-entry flow already used, off the
 * exact same `checkInTicket` mutation's return shape.
 *
 * When the event assigns guest teams, the successful branch stops being a line
 * of text and becomes a full-width block of the team's color. That's not
 * decoration: in team mode the volunteer's actual job is to read a color off
 * this screen and hand over the matching wristband, usually outdoors, at
 * arm's length, while holding something else. The team name is the largest
 * thing on the card and the guest's name moves under it.
 */
import { Text, View } from "react-native";
import { teamColor } from "@events-os/shared";
import { formatTime } from "../../../lib/format";

/** The team a guest was put on, as `checkInTicket` returns it. */
export type CheckInTeam = { teamId: string; name: string; color: string };

export type CheckInOutcome =
  | {
      result: "ok";
      attendeeName: string;
      ticketTypeName: string;
      guestTeam?: CheckInTeam | null;
    }
  | {
      result: "already";
      attendeeName: string;
      checkedInAt: number | null;
      guestTeam?: CheckInTeam | null;
    }
  | { result: "not_found" }
  | { result: "void" };

/** The team block — the wristband color, filled, with the name in it. */
function TeamPanel({
  team,
  caption,
}: {
  team: CheckInTeam;
  caption: string;
}) {
  const c = teamColor(team.color);
  return (
    <View
      className="mt-3 items-center rounded-xl px-4 py-5"
      style={{ backgroundColor: c.solid }}
      accessibilityRole="text"
      accessibilityLabel={`${caption} — ${team.name} team`}
    >
      <Text
        className="text-2xs font-bold uppercase tracking-widest"
        style={{ color: c.onSolid, opacity: 0.8 }}
      >
        {caption}
      </Text>
      <Text
        className="mt-1 text-center font-display text-3xl"
        style={{ color: c.onSolid }}
        numberOfLines={2}
      >
        {team.name}
      </Text>
    </View>
  );
}

export function CheckInResultBanner({ outcome }: { outcome: CheckInOutcome }) {
  if (outcome.result === "ok") {
    if (outcome.guestTeam) {
      return (
        <View>
          <TeamPanel team={outcome.guestTeam} caption="Checked in" />
          <Text
            className="mt-2 text-center text-base font-semibold text-ink"
            numberOfLines={1}
          >
            {outcome.attendeeName}
          </Text>
          <Text className="text-center text-xs text-muted">
            {outcome.ticketTypeName}
          </Text>
        </View>
      );
    }
    return (
      <Text className="mt-3 text-base font-semibold text-success">
        ✓ {outcome.attendeeName} checked in · {outcome.ticketTypeName}
      </Text>
    );
  }
  if (outcome.result === "already") {
    const when =
      outcome.checkedInAt != null ? ` at ${formatTime(outcome.checkedInAt)}` : "";
    // The team still shows on a re-scan — the guest is already wearing the
    // wristband, and "what team am I again?" is what re-scans are usually for.
    if (outcome.guestTeam) {
      return (
        <View>
          <TeamPanel team={outcome.guestTeam} caption="Already checked in" />
          <Text
            className="mt-2 text-center text-base font-semibold text-ink"
            numberOfLines={1}
          >
            {outcome.attendeeName}
          </Text>
          <Text className="text-center text-xs text-muted">
            Admitted{when || " earlier"}
          </Text>
        </View>
      );
    }
    return (
      <Text className="mt-3 text-base font-semibold text-warn">
        {outcome.attendeeName} already checked in{when}
      </Text>
    );
  }
  if (outcome.result === "void") {
    return (
      <Text className="mt-3 text-base font-semibold text-danger">
        This ticket was voided.
      </Text>
    );
  }
  return (
    <Text className="mt-3 text-base font-semibold text-danger">
      No such ticket for this event.
    </Text>
  );
}
