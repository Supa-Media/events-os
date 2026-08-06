/**
 * Door check-in — type a ticket code or scan its QR, get an inline verdict.
 * The mutation is idempotent-safe server-side: "already" reports the prior
 * check-in time instead of double-admitting.
 *
 * Gated on `myCheckInAccess` (`lib/ticketingAccess.ts#requireCheckInAccess`
 * backs both `checkInTicket` and this query) — a caller without door access
 * sees a locked message instead of the manual field or the scan button; the
 * scan-tickets route independently re-checks the same query rather than
 * trusting this card's gate.
 */
import { useState } from "react";
import { Text } from "react-native";
import { useQuery } from "convex/react";
import { useRouter } from "expo-router";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Button, Card } from "../../ui";
import type { ActionRunner } from "../../../lib/useActionToast";
import { CheckInResultBanner, type CheckInOutcome } from "./CheckInResultBanner";
import { ManualCheckInEntry } from "./ManualCheckInEntry";

export function CheckInCard({
  eventId,
  run,
}: {
  eventId: Id<"events">;
  run: ActionRunner["run"];
}) {
  const access = useQuery(api.ticketing.myCheckInAccess, { eventId });
  const router = useRouter();
  const [outcome, setOutcome] = useState<CheckInOutcome | null>(null);

  if (access === undefined) {
    return (
      <Card>
        <Text className="text-base text-muted">Loading…</Text>
      </Card>
    );
  }

  if (!access.allowed) {
    return (
      <Card>
        <Text className="text-base text-muted">
          Door access needed — ask an event lead to add you to this event's
          team, or grant your seat check-in access.
        </Text>
      </Card>
    );
  }

  return (
    <Card>
      <ManualCheckInEntry
        eventId={eventId}
        run={run}
        onResult={setOutcome}
        trailing={
          <Button
            title="Scan QR code"
            icon="camera"
            variant="secondary"
            onPress={() => router.push(`/event/${eventId}/scan-tickets`)}
          />
        }
      />
      {outcome ? <CheckInResultBanner outcome={outcome} /> : null}
    </Card>
  );
}
