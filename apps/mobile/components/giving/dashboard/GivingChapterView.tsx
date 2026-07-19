/**
 * Giving-dashboard v2 — the CHAPTER lens, restyled in the finance dashboard's
 * component language (the giving analogue of finance's `ChapterView`). The
 * scope's own numbers as a stat header, a lapsed-reactivation attention row,
 * and the top-donors list — replacing the old bare `Stat` cards + inline list.
 *
 * Data is `givingPlatform.givingDashboard` (the scope's rollups + top donors).
 */
import { Text, View, Pressable } from "react-native";
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { formatCents } from "@events-os/shared";
import { Badge, type BadgeTone, EmptyState, SectionHeader } from "../../ui";
import { Tile, TileRow } from "../../finance/dashboard/parts";
import { RailRow } from "../../finance/dashboard/AttentionRail";

type DashData = FunctionReturnType<typeof api.givingPlatform.givingDashboard>;

const TABULAR = { fontVariant: ["tabular-nums" as const] };

/** Donor status → chip tone: active reads calm, lapsed warns, prospect neutral
 *  (mirrors the Donors screen's `donorStatusTone`). */
function statusTone(status: string): BadgeTone {
  if (status === "active") return "success";
  if (status === "lapsed") return "warn";
  return "neutral";
}

export function GivingChapterView({
  data,
  lensLabel,
  onDonor,
  onReactivate,
}: {
  data: DashData;
  lensLabel: string;
  onDonor: (id: Id<"donors">) => void;
  /** Jump to the Donors list to work the reactivation queue. */
  onReactivate: () => void;
}) {
  const donorMeta =
    `${data.activeCount} active` +
    (data.prospectCount > 0 ? ` · ${data.prospectCount} prospect` : "");

  return (
    <View>
      <Text className="mb-3 text-sm font-semibold text-muted">
        {lensLabel} · Development
      </Text>

      <TileRow>
        <Tile label="Lifetime giving" value={formatCents(data.lifetimeCents)} />
        <Tile label="Last 30 days" value={formatCents(data.last30Cents)} />
      </TileRow>
      <TileRow>
        <Tile label="Donors" value={String(data.donorCount)} meta={donorMeta} />
        <Tile
          label="Lapsed"
          value={String(data.lapsedCount)}
          valueClassName={data.lapsedCount > 0 ? "text-warn" : "text-ink"}
          meta="reactivation queue"
        />
      </TileRow>

      {data.lapsedCount > 0 ? (
        <View className="mt-2">
          <SectionHeader title="Needs your attention" />
          <RailRow
            count={data.lapsedCount}
            title="Lapsed donors to reactivate"
            detail="Reach out to donors who've gone quiet"
            actionLabel="Review"
            onPress={onReactivate}
          />
        </View>
      ) : null}

      <View className="mt-4">
        <SectionHeader title="Top donors" />
        {data.topDonors.length === 0 ? (
          <EmptyState
            title="No donors yet"
            message="Record a gift or bring in history from the Import tab to get started."
          />
        ) : (
          <View className="gap-2">
            {data.topDonors.map((d) => (
              <Pressable key={d._id} onPress={() => onDonor(d._id)}>
                <View className="flex-row items-center justify-between rounded-lg border border-border bg-raised p-3">
                  <View className="flex-1 pr-3">
                    <Text
                      className="text-base font-semibold text-ink"
                      numberOfLines={1}
                    >
                      {d.name}
                    </Text>
                    <Text className="text-xs text-muted">
                      {d.giftCount} {d.giftCount === 1 ? "gift" : "gifts"} ·{" "}
                      {d.status}
                    </Text>
                  </View>
                  <View className="items-end gap-1">
                    <Text
                      className="text-base font-semibold text-ink"
                      style={TABULAR}
                    >
                      {formatCents(d.lifetimeCents)}
                    </Text>
                    <Badge label={d.status} tone={statusTone(d.status)} />
                  </View>
                </View>
              </Pressable>
            ))}
          </View>
        )}
      </View>
    </View>
  );
}
