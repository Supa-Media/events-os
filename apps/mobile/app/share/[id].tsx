import { View, Text, ScrollView } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { Icon } from "../../components/ui";
import { SiteMapView } from "../../components/event/SiteMapView";
import { BriefingView } from "../../components/crew/BriefingView";
import { colors } from "../../lib/theme";
import type { Id } from "@events-os/convex/_generated/dataModel";

/**
 * PUBLIC, read-only volunteer briefing — reachable at `/share/<eventId>`.
 *
 * This route lives under `app/` OUTSIDE the `(app)`/`(auth)` route groups, so it
 * is NOT behind the auth guard; the root layout just renders `<Slot/>` inside the
 * Convex provider. It reads the no-auth `api.events.publicCrew` query and renders
 * a warm, scannable briefing of teams, their expectations, and who's on each
 * team via the shared `BriefingView`. No edit controls, no pickers, no money.
 */
export default function ShareCrewScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const eventId = id as Id<"events">;
  const data = useQuery(api.events.publicCrew, { eventId });
  const map = useQuery(api.siteMap.publicSiteMap, { eventId });

  // Loading.
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

  // Unavailable / not found.
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

  // Only show the site map section when there's something to draw.
  const hasMap =
    !!map &&
    (map.imageUrl !== null ||
      map.markers.length > 0 ||
      map.shapes.length > 0 ||
      map.placements.length > 0);

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <ScrollView
        style={{ flex: 1, backgroundColor: colors.surface }}
        contentContainerStyle={{
          flexGrow: 1,
          alignItems: "center",
          paddingVertical: 32,
          paddingHorizontal: 20,
        }}
      >
        <BriefingView
          crew={data}
          subtitle="Volunteer briefing · who's serving and what each team is doing."
          siteMap={
            hasMap ? (
              <View className="gap-3">
                <View className="gap-0.5">
                  <Text className="font-display text-xl text-ink">
                    Where everyone is
                  </Text>
                  <Text className="text-sm text-faint">
                    Site map · where each team and supply is set up.
                  </Text>
                </View>
                <SiteMapView
                  imageUrl={map.imageUrl}
                  markers={map.markers}
                  shapes={map.shapes}
                  placements={map.placements}
                />
              </View>
            ) : undefined
          }
        />
      </ScrollView>
    </>
  );
}
