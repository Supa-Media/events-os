/**
 * GIVING · Dashboard — the development desk's home. Reads the caller's giving
 * lens (`myGivingAccess`: central or their chapter) and renders the scope's
 * totals from `givingDashboard` (denormalized rollups): lifetime, last-30-days,
 * donor count, lapsed (reactivation) count, plus the top donors by lifetime.
 *
 * Sub-nav tabs + app chrome come from the giving `_layout`; this screen renders
 * only the Dashboard body. The real gate is the backend `requireGivingView`;
 * this screen degrades to a friendly "access needed" state if the caller lacks
 * the desk.
 */
import { ActivityIndicator, View, Text, Pressable } from "react-native";
import { useQuery } from "convex/react";
import { useRouter } from "expo-router";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { formatCents } from "@events-os/shared";
import {
  Card,
  EmptyState,
  Narrow,
  Screen,
  SectionHeader,
} from "../../../components/ui";
import { colors } from "../../../lib/theme";

type GivingScope = "central" | Id<"chapters">;

export default function GivingDashboardScreen() {
  const access = useQuery(api.givingPlatform.myGivingAccess, {});

  if (access === undefined) return <Screen loading />;
  if (!access.canView || access.scope === null) {
    return (
      <Screen>
        <Narrow>
          <EmptyState
            icon="lock"
            title="Development desk access needed"
            message="Ask a development director to grant you access to the giving desk."
          />
        </Narrow>
      </Screen>
    );
  }
  return (
    <DashboardBody
      scope={access.scope}
      lensLabel={access.scope === "central" ? "Central" : access.chapterName ?? "Chapter"}
    />
  );
}

function DashboardBody({
  scope,
  lensLabel,
}: {
  scope: GivingScope;
  lensLabel: string;
}) {
  const router = useRouter();
  const data = useQuery(api.givingPlatform.givingDashboard, { scope });

  if (data === undefined) {
    return (
      <View className="items-center justify-center py-16">
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <Screen>
      <Narrow>
        <Text className="mb-3 text-sm font-semibold text-muted">
          {lensLabel} · Development
        </Text>

        <View className="mb-4 flex-row flex-wrap gap-3">
          <Stat label="Lifetime giving" value={formatCents(data.lifetimeCents)} />
          <Stat label="Last 30 days" value={formatCents(data.last30Cents)} />
          <Stat label="Donors" value={String(data.donorCount)} />
          <Stat
            label="Lapsed"
            value={String(data.lapsedCount)}
            tone={data.lapsedCount > 0 ? "warn" : "neutral"}
          />
        </View>

        <SectionHeader title="Top donors" />
        {data.topDonors.length === 0 ? (
          <EmptyState
            title="No donors yet"
            message="Record a gift or import your Givebutter history to get started."
          />
        ) : (
          <View className="gap-2">
            {data.topDonors.map((d) => (
              <Pressable
                key={d._id}
                onPress={() => router.navigate(`/giving/donor/${d._id}` as never)}
              >
                <Card>
                  <View className="flex-row items-center justify-between">
                    <View className="flex-1 pr-3">
                      <Text className="text-base font-semibold text-ink" numberOfLines={1}>
                        {d.name}
                      </Text>
                      <Text className="text-xs text-muted">
                        {d.giftCount} {d.giftCount === 1 ? "gift" : "gifts"} · {d.status}
                      </Text>
                    </View>
                    <Text className="text-base font-semibold text-ink">
                      {formatCents(d.lifetimeCents)}
                    </Text>
                  </View>
                </Card>
              </Pressable>
            ))}
          </View>
        )}
      </Narrow>
    </Screen>
  );
}

function Stat({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "neutral" | "warn";
}) {
  return (
    <View className="min-w-[140px] flex-1 rounded-lg border border-border bg-raised p-3">
      <Text className="text-xs text-muted">{label}</Text>
      <Text
        className={`mt-1 text-xl font-bold ${tone === "warn" ? "text-warn" : "text-ink"}`}
      >
        {value}
      </Text>
    </View>
  );
}
