/**
 * FINANCES · BUDGETS — "budgets at a glance", readable by EVERY team member.
 *
 * The FM's top ask: cardholders should see "this is how much has been spent
 * on X so far and how much room is left" without asking her. Backed by
 * `api.finances.budgetsGlance` — the one finance read that is DELIBERATELY
 * not finance-role gated (membership only, read-only; see the query's doc
 * comment), so this screen needs none of the seat/boundary scaffolding the
 * other finance tabs carry: the query degrades to an empty result for a
 * caller with no chapter, it never throws for a no-seat member.
 *
 * Two sections mirroring the dashboard's own grouping: one-time (event /
 * project) budgets — lifetime spent-of-cap — and recurring buckets, scoped to
 * their current cadence window (this month / quarter / year). Every number is
 * the SAME rule the FM's dashboard computes (the query reuses those helpers),
 * so a cardholder and the FM can never see two different answers. Read-only
 * on purpose: no editing, no drill-down into transactions — that stays on
 * the gated finance surfaces.
 */
import { Text, View } from "react-native";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import { formatCents } from "@events-os/shared";
import { EmptyState, Narrow, Screen, SectionHeader } from "../../../components/ui";
import { Meter } from "../../../components/finance/dashboard/Meter";

type GlanceRow = FunctionReturnType<
  typeof api.finances.budgetsGlance
>["oneTime"][number];

/** The recurring cadence window's plain-words label ("this month" etc.). */
const CADENCE_LABELS: Record<string, string> = {
  monthly: "this month",
  quarterly: "this quarter",
  yearly: "this year",
};

/** One budget's glance card: name, spent-of-cap, room left, and a meter. */
function GlanceCard({ row }: { row: GlanceRow }) {
  const over = row.remainingCents < 0;
  const window = row.type === "recurring" ? CADENCE_LABELS[row.cadence] : null;
  return (
    <View className="rounded-lg border border-border bg-raised p-3 shadow-card">
      <View className="mb-1 flex-row items-baseline gap-2">
        <Text className="flex-1 text-sm font-semibold text-ink" numberOfLines={1}>
          {row.name}
        </Text>
        {row.dateLabel ? (
          <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
            {row.dateLabel}
          </Text>
        ) : null}
      </View>
      <View className="mb-1.5 flex-row items-baseline justify-between gap-2">
        <Text className="text-sm text-muted">
          {formatCents(row.spentCents)} of {formatCents(row.capCents)}
          {window ? ` ${window}` : " spent"}
        </Text>
        <Text
          className={`text-sm font-semibold ${over ? "text-danger" : "text-success"}`}
        >
          {over
            ? `${formatCents(-row.remainingCents)} over`
            : `${formatCents(row.remainingCents)} left`}
        </Text>
      </View>
      <Meter pct={row.pct} size="sm" />
    </View>
  );
}

export default function BudgetsGlanceScreen() {
  const glance = useQuery(api.finances.budgetsGlance, {});

  if (glance === undefined) return <Screen loading />;

  const empty = glance.oneTime.length === 0 && glance.recurring.length === 0;

  return (
    <Screen maxWidth={1080}>
      <Narrow>
        <View className="mb-1">
          <Text className="font-display text-2xl text-ink">Budgets</Text>
        </View>
        <Text className="mb-4 text-sm text-muted">
          What's been spent and how much room is left, per budget — so you
          don't have to ask before you swipe. Live, read-only, same numbers
          the finance team sees.
        </Text>

        {empty ? (
          <EmptyState
            icon="pie-chart"
            title="No budgets to show yet"
            message="Approved budgets for this year show up here with their spend and room left."
          />
        ) : (
          <View className="gap-6">
            {glance.oneTime.length > 0 ? (
              <View>
                <SectionHeader title="Events & projects" />
                <View className="gap-2.5">
                  {glance.oneTime.map((row) => (
                    <GlanceCard key={row.id} row={row} />
                  ))}
                </View>
              </View>
            ) : null}
            {glance.recurring.length > 0 ? (
              <View>
                <SectionHeader title="Recurring" />
                <View className="gap-2.5">
                  {glance.recurring.map((row) => (
                    <GlanceCard key={row.id} row={row} />
                  ))}
                </View>
              </View>
            ) : null}
          </View>
        )}
      </Narrow>
    </Screen>
  );
}
