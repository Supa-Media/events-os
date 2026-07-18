/**
 * GIVING · Donors — the scope's donor list, sorted by lifetime giving (the
 * "top donors" relationship workflow needs this ordering on day one, PRD §1).
 * Search-free in v1; status chips flag the reactivation queue (lapsed) at a
 * glance. Tapping a row opens the donor detail. The backend `listDonors` gates
 * on `requireGivingView`.
 */
import { ActivityIndicator, View, Text, Pressable } from "react-native";
import { useQuery } from "convex/react";
import { useRouter } from "expo-router";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { formatCents } from "@events-os/shared";
import {
  Badge,
  type BadgeTone,
  EmptyState,
  Narrow,
  Screen,
} from "../../../components/ui";
import { colors } from "../../../lib/theme";

type GivingScope = "central" | Id<"chapters">;

/** Donor status → chip tone: active reads calm, lapsed warns (reactivation
 *  queue), prospect is neutral (no gift yet). */
export function donorStatusTone(status: string): BadgeTone {
  if (status === "active") return "success";
  if (status === "lapsed") return "warn";
  return "neutral";
}

export default function DonorsScreen() {
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
  return <DonorsBody scope={access.scope} />;
}

function DonorsBody({ scope }: { scope: GivingScope }) {
  const router = useRouter();
  const donors = useQuery(api.givingPlatform.listDonors, { scope });

  if (donors === undefined) {
    return (
      <View className="items-center justify-center py-16">
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <Screen>
      <Narrow>
        {donors.length === 0 ? (
          <EmptyState
            title="No donors yet"
            message="Record a gift on a donor, or import your Givebutter history."
          />
        ) : (
          <View className="gap-2">
            {donors.map((d) => (
              <Pressable
                key={d._id}
                onPress={() => router.navigate(`/giving/donor/${d._id}` as never)}
              >
                <View className="flex-row items-center justify-between rounded-lg border border-border bg-raised p-3">
                  <View className="flex-1 pr-3">
                    <Text className="text-base font-semibold text-ink" numberOfLines={1}>
                      {d.name}
                    </Text>
                    <Text className="text-xs text-muted" numberOfLines={1}>
                      {d.email ?? "No email"} · {d.giftCount}{" "}
                      {d.giftCount === 1 ? "gift" : "gifts"}
                    </Text>
                  </View>
                  <View className="items-end gap-1">
                    <Text className="text-base font-semibold text-ink">
                      {formatCents(d.lifetimeCents)}
                    </Text>
                    <Badge label={d.status} tone={donorStatusTone(d.status)} />
                  </View>
                </View>
              </Pressable>
            ))}
          </View>
        )}
      </Narrow>
    </Screen>
  );
}
