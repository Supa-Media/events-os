/**
 * The four-branch check-in outcome banner — extracted from `CheckInCard` so
 * `TicketScanner` (the QR scanner's result view) renders the EXACT same
 * ok/already/void/not_found copy the manual-entry flow already used, off the
 * exact same `checkInTicket` mutation's return shape.
 */
import { Text } from "react-native";
import { formatTime } from "../../../lib/format";

export type CheckInOutcome =
  | { result: "ok"; attendeeName: string; ticketTypeName: string }
  | { result: "already"; attendeeName: string; checkedInAt: number | null }
  | { result: "not_found" }
  | { result: "void" };

export function CheckInResultBanner({ outcome }: { outcome: CheckInOutcome }) {
  if (outcome.result === "ok") {
    return (
      <Text className="mt-3 text-base font-semibold text-success">
        ✓ {outcome.attendeeName} checked in · {outcome.ticketTypeName}
      </Text>
    );
  }
  if (outcome.result === "already") {
    return (
      <Text className="mt-3 text-base font-semibold text-warn">
        {outcome.attendeeName} already checked in
        {outcome.checkedInAt != null ? ` at ${formatTime(outcome.checkedInAt)}` : ""}
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
