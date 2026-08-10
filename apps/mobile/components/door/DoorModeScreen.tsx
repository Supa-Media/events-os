import { useState } from "react";
import { View, Text, Pressable, ActivityIndicator, ScrollView } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useQuery } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Card, Button, Icon, ToastView } from "../ui";
import { TicketScanner } from "../event/ticketing/TicketScanner";
import { ManualCheckInEntry } from "../event/ticketing/ManualCheckInEntry";
import {
  CheckInResultBanner,
  type CheckInOutcome,
} from "../event/ticketing/CheckInResultBanner";
import { loadCameraScanning } from "../../lib/cameraScanning";
import { AttendeeCheckInList } from "./AttendeeCheckInList";
import { useActionRunner, type ActionRunner } from "../../lib/useActionToast";
import { colors } from "../../lib/theme";
import { formatWeekdayDateInZone } from "../../lib/format";
import { eventTimeZone } from "@events-os/shared";

/**
 * DOOR MODE — the entire app surface for a door-only guest: an outside
 * volunteer granted per-event check-in access (`doorAccess.ts`) who has NO
 * chapter membership. Rendered by the `(app)` layout IN PLACE of the Stack
 * (like `OnboardingScreen`), so no member route — tabs, nav, events, people —
 * is even mounted for them; the backend enforces the same boundary via
 * `requireChapterId`. They see their granted events and the scanner. That's
 * the product.
 */
export function DoorModeScreen() {
  const { signOut } = useAuthActions();
  const events = useQuery(api.doorAccess.myDoorEvents, {});
  const [activeEventId, setActiveEventId] = useState<Id<"events"> | null>(null);
  const { run, toast, dismiss } = useActionRunner();

  const activeEvent = events?.find((e) => e.eventId === activeEventId) ?? null;

  return (
    <SafeAreaView className="flex-1 bg-surface">
      <View className="flex-1 items-center px-4 py-6">
        <View className="w-full max-w-md flex-1">
          <View className="mb-4 flex-row items-center justify-between">
            <Text className="font-display text-2xl text-ink">Door check-in</Text>
            <Button
              title="Sign out"
              variant="ghost"
              size="sm"
              icon="log-out"
              onPress={() => signOut()}
            />
          </View>

          {activeEvent ? (
            <ScrollView showsVerticalScrollIndicator={false}>
              <Pressable
                onPress={() => setActiveEventId(null)}
                accessibilityRole="button"
                accessibilityLabel="Back to your events"
                className="mb-3 flex-row items-center gap-1.5 self-start rounded-md px-1 py-1 active:opacity-70"
              >
                <Icon name="arrow-left" size={15} color={colors.muted} />
                <Text className="text-sm font-medium text-muted">
                  {activeEvent.name}
                </Text>
              </Pressable>
              <TicketScanner eventId={activeEvent.eventId} run={run} />
              {/* The scanner shows its own manual field when the camera is
                  unavailable — only add the standalone one when it doesn't. */}
              {loadCameraScanning() ? (
                <ManualEntryCard eventId={activeEvent.eventId} run={run} />
              ) : null}
              <AttendeeCheckInList eventId={activeEvent.eventId} />
            </ScrollView>
          ) : (
            <DoorEventList events={events} onOpen={setActiveEventId} />
          )}
        </View>
      </View>
      <ToastView toast={toast} onDismiss={dismiss} />
    </SafeAreaView>
  );
}

/** "Can't scan? Type the guest's code" — the manual input path when the
 *  camera IS available (the guest reads their code off their ticket). Same
 *  mutation and outcome banner as the scanner. */
function ManualEntryCard({
  eventId,
  run,
}: {
  eventId: Parameters<typeof ManualCheckInEntry>[0]["eventId"];
  run: ActionRunner["run"];
}) {
  const [outcome, setOutcome] = useState<CheckInOutcome | null>(null);
  return (
    <Card className="mt-3">
      <Text className="mb-3 text-sm text-muted">
        Can't scan? Ask the guest for the code on their ticket.
      </Text>
      <ManualCheckInEntry eventId={eventId} run={run} onResult={setOutcome} />
      {outcome ? <CheckInResultBanner outcome={outcome} /> : null}
    </Card>
  );
}

function DoorEventList({
  events,
  onOpen,
}: {
  events:
    | { eventId: Id<"events">; name: string; eventDate: number; chapterName: string }[]
    | undefined;
  onOpen: (eventId: Id<"events">) => void;
}) {
  if (events === undefined) {
    return (
      <View className="items-center py-12">
        <ActivityIndicator color={colors.muted} />
      </View>
    );
  }

  if (events.length === 0) {
    return (
      <Card padding="lg">
        <View className="mb-3 h-11 w-11 items-center justify-center rounded-full bg-sunken">
          <Icon name="key" size={20} color={colors.muted} />
        </View>
        <Text className="font-display text-xl text-ink">No door assignments yet</Text>
        <Text className="mt-2 text-sm text-muted">
          When an organizer adds your email to an event's door list, the event
          will show up here with its ticket scanner.
        </Text>
      </Card>
    );
  }

  return (
    <>
      <Text className="mb-2 text-2xs font-bold uppercase tracking-wider text-muted">
        Your events ({events.length})
      </Text>
      <Card padding="none">
        {events.map((e, i) => (
          <Pressable
            key={e.eventId}
            onPress={() => onOpen(e.eventId)}
            accessibilityRole="button"
            accessibilityLabel={`Open the scanner for ${e.name}`}
            className={`flex-row items-center gap-3 px-4 py-3 active:opacity-80 web:hover:bg-sunken ${
              i === events.length - 1 ? "" : "border-b border-border"
            }`}
          >
            <View className="flex-1">
              <Text className="text-sm font-medium text-ink" numberOfLines={1}>
                {e.name}
              </Text>
              <Text className="mt-0.5 text-xs text-muted" numberOfLines={1}>
                {/* Door mode is used AT the venue, where "tonight" means the
                    event's night — a device still on another zone's clock must
                    not offer yesterday's or tomorrow's event as today's. */}
                {formatWeekdayDateInZone(e.eventDate, eventTimeZone(e))}
                {e.chapterName ? ` · ${e.chapterName}` : ""}
              </Text>
            </View>
            <Icon name="chevron-right" size={16} color={colors.muted} />
          </Pressable>
        ))}
      </Card>
    </>
  );
}
