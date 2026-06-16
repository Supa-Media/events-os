import { View, Text, ScrollView } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { Card, Icon, OptionTag } from "../../components/ui";
import { SiteMapView } from "../../components/event/SiteMapView";
import { colors } from "../../lib/theme";
import { formatDateTime } from "../../lib/format";
import type { FunctionReturnType } from "convex/server";
import type { Id } from "@events-os/convex/_generated/dataModel";

/**
 * PUBLIC, read-only volunteer briefing — reachable at `/share/<eventId>`.
 *
 * This route lives under `app/` OUTSIDE the `(app)`/`(auth)` route groups, so it
 * is NOT behind the auth guard; the root layout just renders `<Slot/>` inside the
 * Convex provider. It reads the no-auth `api.events.publicCrew` query and renders
 * a warm, scannable briefing of teams, their expectations, and who's on each
 * team. No edit controls, no pickers, no money — read-only by design.
 */

// Person/Expectation are PROJECTIONS from the `publicCrew` query, not the
// `people`/`eventItems` documents — `status`/`callTime` come off the volunteer
// ENGAGEMENT, not the people row — so we derive the row types from the query's
// own return type rather than from `Doc<"people">` (a different shape).
type PublicCrew = NonNullable<FunctionReturnType<typeof api.events.publicCrew>>;
type Person = PublicCrew["teams"][number]["people"][number];
type Expectation = PublicCrew["teams"][number]["expectations"][number];

/** A single bulleted expectation: check glyph + title + optional details. */
function ExpectationRow({ item }: { item: Expectation }) {
  return (
    <View className="flex-row gap-2">
      <View className="pt-0.5">
        <Icon name="check" size={15} color={colors.success} />
      </View>
      <View className="flex-1">
        <Text className="text-base font-semibold text-ink">{item.title}</Text>
        {item.details ? (
          <Text className="mt-0.5 text-sm text-muted">{item.details}</Text>
        ) : null}
      </View>
    </View>
  );
}

/** First letters of the first two words of a name, uppercase. */
function initials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.charAt(0).toUpperCase();
  return (words[0]!.charAt(0) + words[1]!.charAt(0)).toUpperCase();
}

/** A single person on a team, as a clean card: avatar + name + call time + status. */
function PersonCard({ person }: { person: Person }) {
  return (
    <View className="flex-row items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2.5">
      <View
        className="h-9 w-9 items-center justify-center rounded-pill"
        style={{ backgroundColor: colors.sunken }}
      >
        <Text className="text-xs font-bold text-muted">
          {initials(person.name)}
        </Text>
      </View>
      <View className="flex-1">
        <Text className="text-base font-semibold text-ink" numberOfLines={1}>
          {person.name}
        </Text>
        {person.callTime ? (
          <View className="mt-0.5 flex-row items-center gap-1">
            <Icon name="clock" size={12} color={colors.faint} />
            <Text className="text-sm text-muted">Call time {person.callTime}</Text>
          </View>
        ) : null}
      </View>
      {person.status ? (
        <View
          className="flex-row items-center gap-1 rounded-pill border border-border bg-sunken px-2 py-0.5"
          accessibilityLabel={`Status: ${person.status}`}
        >
          <View
            className="h-1.5 w-1.5 rounded-pill"
            style={{ backgroundColor: colors.muted }}
          />
          <Text className="text-xs font-semibold capitalize text-muted">
            {person.status}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/** One team's card: label tag + people count, expectations, then people. */
function TeamCard({
  label,
  color,
  expectations,
  people,
}: {
  label: string;
  color?: string | null;
  expectations: Expectation[];
  people: Person[];
}) {
  return (
    <Card padding="lg">
      <View className="mb-3 flex-row items-center justify-between gap-2">
        <OptionTag label={label} color={color} />
        <View className="flex-row items-center gap-1.5">
          <Icon name="users" size={14} color={colors.muted} />
          <Text className="text-sm font-bold text-muted">{people.length}</Text>
        </View>
      </View>

      {expectations.length > 0 ? (
        <View className="gap-2.5">
          {expectations.map((e, i) => (
            <ExpectationRow key={i} item={e} />
          ))}
        </View>
      ) : (
        <Text className="text-sm italic text-faint">
          No expectations listed yet.
        </Text>
      )}

      {people.length > 0 ? (
        <View className="mt-4 border-t border-border pt-3">
          <Text className="mb-2 text-xs font-bold uppercase tracking-wide text-faint">
            On this team
          </Text>
          <View className="gap-2">
            {people.map((p, i) => (
              <PersonCard key={i} person={p} />
            ))}
          </View>
        </View>
      ) : null}
    </Card>
  );
}

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

  const hasUnassigned =
    data.unassigned.expectations.length > 0 ||
    data.unassigned.people.length > 0;

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
        <View style={{ width: "100%", maxWidth: 720 }} className="gap-6">
          {/* Header */}
          <View className="gap-1">
            <Text className="font-display text-3xl text-ink">{data.name}</Text>
            <View className="flex-row flex-wrap items-center gap-x-4 gap-y-1">
              <View className="flex-row items-center gap-1.5">
                <Icon name="calendar" size={14} color={colors.muted} />
                <Text className="text-sm text-muted">
                  {formatDateTime(data.eventDate)}
                </Text>
              </View>
              {data.location ? (
                <View className="flex-row items-center gap-1.5">
                  <Icon name="map-pin" size={14} color={colors.muted} />
                  <Text className="text-sm text-muted">{data.location}</Text>
                </View>
              ) : null}
            </View>
            <Text className="mt-1 text-sm text-faint">
              Volunteer briefing · who's serving and what each team is doing.
            </Text>
          </View>

          {/* Site map — where everyone & everything is placed. */}
          {hasMap ? (
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
          ) : null}

          {/* Teams */}
          <View className="gap-4">
            {data.teams.map((team) => (
              <TeamCard
                key={team.value}
                label={team.label}
                color={team.color}
                expectations={team.expectations}
                people={team.people}
              />
            ))}

            {hasUnassigned ? (
              <TeamCard
                label="Unassigned"
                color="gray"
                expectations={data.unassigned.expectations}
                people={data.unassigned.people}
              />
            ) : null}
          </View>
        </View>
      </ScrollView>
    </>
  );
}
