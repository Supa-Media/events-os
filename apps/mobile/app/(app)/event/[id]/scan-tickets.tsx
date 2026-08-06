import { Text } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Screen, Card } from "../../../../components/ui";
import { TicketScanner } from "../../../../components/event/ticketing/TicketScanner";
import { useActionRunner } from "../../../../lib/useActionToast";

/**
 * SCAN TICKETS — the door check-in camera screen. Independently re-checks
 * `myCheckInAccess` rather than trusting `CheckInCard`'s gate (the entry
 * point that links here) — a direct deep link, or access revoked mid-session,
 * must never reach the camera without a fresh check.
 */
export default function ScanTicketsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const eventId = id as Id<"events">;
  const { run } = useActionRunner();
  const access = useQuery(api.ticketing.myCheckInAccess, { eventId });

  if (access === undefined) {
    return (
      <>
        <Stack.Screen options={{ headerShown: true, title: "Scan tickets" }} />
        <Screen loading />
      </>
    );
  }

  if (!access.allowed) {
    return (
      <>
        <Stack.Screen options={{ headerShown: true, title: "Scan tickets" }} />
        <Screen>
          <Card>
            <Text className="text-base text-muted">
              Door access needed — ask an event lead to add you to this
              event's team, or grant your seat check-in access.
            </Text>
          </Card>
        </Screen>
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: "Scan tickets" }} />
      <Screen>
        <TicketScanner eventId={eventId} run={run} />
      </Screen>
    </>
  );
}
