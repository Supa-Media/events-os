/**
 * GIVING · Backers — the recurring-pledge desk (F-6 P2). Lists the scope's
 * pledges grouped by lifecycle (active · past due · imported-awaiting-resignup ·
 * canceled), each with its monthly amount and a link to the donor. Shows the
 * derived backer-count summary (active pledges at/above the $50 unit — the
 * number the affordability header now reads).
 *
 * Reads `listPledges` (gated by `requireGivingView`). Territories P6: bulk
 * recurring-pledge import (the old inline Givebutter form here) moved to the
 * desk's own `Import` tab (`import.tsx`) — see that screen for the canonical
 * preview/commit flow that now covers `recurring` rows alongside gifts,
 * tickets, and contacts.
 */
import { useMemo } from "react";
import { ActivityIndicator, View, Text, Pressable } from "react-native";
import { useQuery } from "convex/react";
import { useRouter } from "expo-router";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { BACKER_UNIT_CENTS, formatCents } from "@events-os/shared";
import {
  Badge,
  type BadgeTone,
  EmptyState,
  Narrow,
  Screen,
  SectionHeader,
} from "../../../components/ui";
import { colors } from "../../../lib/theme";

type GivingScope = "central" | Id<"chapters">;

type PledgeRow = {
  _id: Id<"pledges">;
  donorId: Id<"donors">;
  donorName: string;
  donorEmail: string | null;
  amountCents: number;
  status: "incomplete" | "active" | "past_due" | "canceled";
  origin: "stripe" | "imported";
};

/** Pledge lifecycle → chip tone. */
function pledgeStatusTone(status: string): BadgeTone {
  if (status === "active") return "success";
  if (status === "past_due") return "warn";
  if (status === "canceled") return "danger";
  return "neutral";
}

export default function BackersScreen() {
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
  return <BackersBody scope={access.scope} />;
}

function BackersBody({ scope }: { scope: GivingScope }) {
  const router = useRouter();
  const pledges = useQuery(api.givingPledges.listPledges, { scope }) as
    | PledgeRow[]
    | undefined;

  const groups = useMemo(() => {
    const active: PledgeRow[] = [];
    const pastDue: PledgeRow[] = [];
    const imported: PledgeRow[] = [];
    const canceled: PledgeRow[] = [];
    for (const p of pledges ?? []) {
      if (p.status === "canceled") canceled.push(p);
      else if (p.origin === "imported") imported.push(p);
      else if (p.status === "active") active.push(p);
      else pastDue.push(p); // past_due / incomplete on our rails
    }
    // Backers = active pledges at/above the $50 unit (the derived count the
    // affordability header reads; PRD Appendix C#2).
    const backerCount = active.filter(
      (p) => p.amountCents >= BACKER_UNIT_CENTS,
    ).length;
    const monthlyCents = active.reduce((sum, p) => sum + p.amountCents, 0);
    return { active, pastDue, imported, canceled, backerCount, monthlyCents };
  }, [pledges]);

  if (pledges === undefined) {
    return (
      <View className="items-center justify-center py-16">
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <Screen>
      <Narrow>
        <View className="mb-4 flex-row flex-wrap gap-3">
          <Stat label="Backers" value={String(groups.backerCount)} />
          <Stat
            label="Active pledges"
            value={String(groups.active.length)}
          />
          <Stat
            label="Monthly recurring"
            value={formatCents(groups.monthlyCents)}
          />
        </View>

        {pledges.length === 0 ? (
          <EmptyState
            title="No pledges yet"
            message="Backers appear here once they subscribe, or import recurring donors from the Import tab."
          />
        ) : (
          <>
            <PledgeGroup
              title="Active"
              rows={groups.active}
              onOpen={(donorId) =>
                router.navigate(`/giving/donor/${donorId}` as never)
              }
            />
            <PledgeGroup
              title="Past due"
              rows={groups.pastDue}
              onOpen={(donorId) =>
                router.navigate(`/giving/donor/${donorId}` as never)
              }
            />
            <PledgeGroup
              title="Imported · awaiting re-signup"
              rows={groups.imported}
              onOpen={(donorId) =>
                router.navigate(`/giving/donor/${donorId}` as never)
              }
            />
            <PledgeGroup
              title="Canceled"
              rows={groups.canceled}
              onOpen={(donorId) =>
                router.navigate(`/giving/donor/${donorId}` as never)
              }
            />
          </>
        )}
      </Narrow>
    </Screen>
  );
}

function PledgeGroup({
  title,
  rows,
  onOpen,
}: {
  title: string;
  rows: PledgeRow[];
  onOpen: (donorId: Id<"donors">) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <View className="mb-4">
      <SectionHeader title={`${title} (${rows.length})`} />
      <View className="gap-2">
        {rows.map((p) => (
          <Pressable key={p._id} onPress={() => onOpen(p.donorId)}>
            <View className="flex-row items-center justify-between rounded-lg border border-border bg-raised p-3">
              <View className="flex-1 pr-3">
                <Text
                  className="text-base font-semibold text-ink"
                  numberOfLines={1}
                >
                  {p.donorName}
                </Text>
                {p.donorEmail ? (
                  <Text className="text-xs text-muted" numberOfLines={1}>
                    {p.donorEmail}
                  </Text>
                ) : null}
              </View>
              <View className="items-end gap-1">
                <Text className="text-base font-semibold text-ink">
                  {formatCents(p.amountCents)}
                  <Text className="text-xs text-muted"> /mo</Text>
                </Text>
                <Badge label={p.status} tone={pledgeStatusTone(p.status)} />
              </View>
            </View>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View className="min-w-[110px] flex-1 rounded-lg border border-border bg-raised p-3">
      <Text className="text-xs text-muted">{label}</Text>
      <Text className="mt-1 text-lg font-bold text-ink">{value}</Text>
    </View>
  );
}
