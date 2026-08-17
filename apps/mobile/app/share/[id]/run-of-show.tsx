import { View, Text, ScrollView } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { Icon } from "../../../components/ui";
import { RunOfShowView } from "../../../components/crew/RunOfShowView";
import { colors } from "../../../lib/theme";
import type { Id } from "@events-os/convex/_generated/dataModel";

/**
 * PUBLIC, read-only run-of-show preview — reachable at
 * `/share/<eventId>/run-of-show`. Outside the `(app)`/`(auth)` route
 * groups (not behind the auth guard), same public zone as `/share/[id]`
 * (the full crew briefing) — this is the narrower, run-of-show-only sibling
 * for a share link that should point at just the schedule. Renders via the
 * SAME `RunOfShowView` the bundled briefing uses: a single-column, vertical
 * timeline (no side-to-side scrolling, unlike the in-app editing grid).
 */
export default function ShareRunOfShowScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const eventId = id as Id<"events">;
  const data = useQuery(api.events.publicRunOfShow, { eventId });

  if (data === undefined) {
    return (
      <>
        <Stack.Screen options={{ headerShown: false }} />
        <View
          className="flex-1 items-center justify-center"
          style={{ backgroundColor: colors.surface }}
        >
          <Text className="text-base text-muted">Loading…</Text>
        </View>
      </>
    );
  }

  if (data === null) {
    return (
      <>
        <Stack.Screen options={{ headerShown: false }} />
        <View
          className="flex-1 items-center justify-center px-6"
          style={{ backgroundColor: colors.surface }}
        >
          <Icon name="calendar" size={28} color={colors.faint} />
          <Text className="mt-3 text-center text-base text-muted">
            This event link isn't available.
          </Text>
        </View>
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <ScrollView
        style={{ flex: 1, backgroundColor: colors.surface }}
        contentContainerStyle={{
          flexGrow: 1,
          paddingVertical: 32,
          paddingHorizontal: 20,
        }}
      >
        <View className="w-full max-w-[560px] self-center gap-6">
          <Text className="font-display text-2xl text-ink">{data.name}</Text>
          <RunOfShowView eventDate={data.eventDate} runOfShow={data.runOfShow} />
        </View>
      </ScrollView>
    </>
  );
}
