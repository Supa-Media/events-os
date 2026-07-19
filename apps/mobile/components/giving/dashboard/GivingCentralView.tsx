/**
 * Giving-dashboard v2 — the CENTRAL lens (development-director fleet view).
 * The giving analogue of finance's `CentralView`: an org-wide stat header, a
 * "Needs attention" rail (lapsed reactivation queues + backer gaps), then a
 * card rail — Central's own book + one card per active chapter.
 *
 * Data is `givingPlatform.dashboardFleet` (org totals + per-scope rows, all
 * rollups-only). Reuses the finance dashboard's genuinely-generic primitives
 * (`Tile`/`TileRow` from `parts`, `RailRow` from `AttentionRail`, `compactCents`)
 * rather than re-authoring them. Tapping a card / attention row switches the
 * desk into that scope (the screen wires central `chooseSeat` / chapter
 * `enterPeek`).
 */
import { Text, View } from "react-native";
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { formatCents } from "@events-os/shared";
import { Icon, SectionHeader } from "../../ui";
import { colors } from "../../../lib/theme";
import { Tile, TileRow } from "../../finance/dashboard/parts";
import { RailRow } from "../../finance/dashboard/AttentionRail";
import { GivingScopeCard } from "./GivingScopeCard";
import { deriveFleetAttention } from "./fleetAttention";

type FleetData = FunctionReturnType<typeof api.givingPlatform.dashboardFleet>;

export type GivingScopeKey = "central" | Id<"chapters">;

export function GivingCentralView({
  data,
  onSelectScope,
}: {
  data: FleetData;
  /** Switch the giving desk into a scope: `"central"` (own book) or a chapter. */
  onSelectScope: (scope: GivingScopeKey, name: string) => void;
}) {
  const { org, scopes } = data;
  const attention = deriveFleetAttention(scopes);

  const donorMeta =
    `${org.activeCount} active` +
    (org.lapsedCount > 0 ? ` · ${org.lapsedCount} lapsed` : "");
  const backerValue =
    org.targetBackers > 0
      ? `${org.backerCount} / ${org.targetBackers}`
      : String(org.backerCount);

  return (
    <View>
      <Text className="mb-3 text-sm font-semibold text-muted">
        Central · Development · all chapters
      </Text>

      {/* Org-wide stat header. */}
      <TileRow>
        <Tile label="Lifetime giving" value={formatCents(org.lifetimeCents)} />
        <Tile label="Last 30 days" value={formatCents(org.last30Cents)} />
      </TileRow>
      <TileRow>
        <Tile label="Donors" value={String(org.donorCount)} meta={donorMeta} />
        <Tile
          label="Backers"
          value={backerValue}
          meta={org.targetBackers > 0 ? "toward goal" : undefined}
        />
      </TileRow>

      {/* Needs attention. */}
      <View className="mt-2">
        <SectionHeader title="Needs your attention" />
        {attention.length === 0 ? (
          <View className="flex-row items-center gap-2 rounded-lg border border-border bg-raised p-3">
            <Icon name="check-circle" size={14} color={colors.success} />
            <Text className="text-xs text-muted">
              All clear — no lapsed queues or backer gaps across the fleet.
            </Text>
          </View>
        ) : (
          <View className="gap-2">
            {attention.map((item) => (
              <RailRow
                key={`${item.kind}:${item.scope}`}
                count={item.count}
                title={item.title}
                detail={item.detail}
                actionLabel="Open"
                onPress={() =>
                  onSelectScope(item.scope as GivingScopeKey, item.name)
                }
              />
            ))}
          </View>
        )}
      </View>

      {/* The fleet: central's own book + one card per active chapter. */}
      <View className="mt-4">
        <SectionHeader title="By chapter" count={scopes.length} />
        <View className="flex-row flex-wrap gap-3">
          {scopes.map((row) => (
            <GivingScopeCard
              key={row.scope}
              row={row}
              onPress={() => onSelectScope(row.scope, row.name)}
            />
          ))}
        </View>
      </View>
    </View>
  );
}
