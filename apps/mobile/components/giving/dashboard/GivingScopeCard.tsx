/**
 * Giving-dashboard v2 — one fleet card per scope (Central's own book + each
 * active chapter), the giving analogue of finance's `ChapterFleet` rows.
 * Tapping switches the giving desk INTO that scope (central `chooseSeat` /
 * chapter `enterPeek`, wired by the screen) so the rest of the desk follows
 * along via `useGivingScope`, exactly like the finance fleet's drill-down.
 *
 * Money uses the shared compact format (`compactCents`) and the neutral
 * proportion bar (`MiniBar` from finance `parts`) — NOT `Meter`, whose tone
 * rule (gold→amber→red as a spend bar fills) inverts for a progress-toward-
 * GOAL bar, where fuller is better. Backer progress is a plain accent bar.
 */
import { Text, View, Pressable } from "react-native";
import type { FunctionReturnType } from "convex/server";
import type { api } from "@events-os/convex/_generated/api";
import { compactCents } from "../../finance/dashboard/compactCents";
import { MiniBar } from "../../finance/dashboard/parts";

type FleetData = FunctionReturnType<typeof api.givingPlatform.dashboardFleet>;
export type FleetScopeRow = FleetData["scopes"][number];

const TABULAR = { fontVariant: ["tabular-nums" as const] };

export function GivingScopeCard({
  row,
  onPress,
}: {
  row: FleetScopeRow;
  onPress: () => void;
}) {
  const hasTarget = row.targetBackers != null && row.targetBackers > 0;
  const backerPct =
    hasTarget && row.backerCount != null
      ? Math.round((row.backerCount / (row.targetBackers as number)) * 100)
      : null;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      className="min-w-[160px] flex-1 gap-2 rounded-lg border border-border bg-raised p-4 shadow-card active:bg-sunken web:hover:bg-sunken"
    >
      <Text className="font-display text-base text-ink" numberOfLines={1}>
        {row.name}
      </Text>

      <View className="flex-row items-baseline justify-between">
        <Text className="font-display text-xl text-ink" style={TABULAR}>
          {compactCents(row.lifetimeCents)}
        </Text>
        <Text className="text-2xs uppercase tracking-wider text-muted">
          lifetime
        </Text>
      </View>

      <Text className="text-xs text-muted" style={TABULAR}>
        {compactCents(row.last30Cents)} · last 30 days
      </Text>

      <View className="flex-row flex-wrap items-center gap-x-2 gap-y-0.5">
        <Text className="text-xs font-semibold text-ink" style={TABULAR}>
          {row.donorCount} {row.donorCount === 1 ? "donor" : "donors"}
        </Text>
        {row.activeCount > 0 ? (
          <Text className="text-2xs text-success" style={TABULAR}>
            {row.activeCount} active
          </Text>
        ) : null}
        {row.lapsedCount > 0 ? (
          <Text className="text-2xs text-warn" style={TABULAR}>
            {row.lapsedCount} lapsed
          </Text>
        ) : null}
      </View>

      {row.backerCount != null && hasTarget ? (
        <View className="mt-0.5 gap-1">
          <MiniBar barPct={backerPct ?? 0} />
          <Text className="text-2xs text-muted" style={TABULAR}>
            {row.backerCount}/{row.targetBackers} backers
            {row.backersBelowTarget ? " · below goal" : ""}
          </Text>
        </View>
      ) : row.backerCount != null ? (
        <Text className="text-2xs text-muted" style={TABULAR}>
          {row.backerCount} backers
        </Text>
      ) : row.scope !== "central" ? (
        <Text className="text-2xs text-faint">Backers not set</Text>
      ) : null}
    </Pressable>
  );
}
