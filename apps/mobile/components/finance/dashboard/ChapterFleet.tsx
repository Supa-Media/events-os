/**
 * DASH-3 "Chapters at a glance" — a full-width fleet panel below the central
 * dashboard's two-column grid, one row per `api.dashboardCharts.chapterHealth`
 * row (the synthetic "Central" row leads, then every real chapter, in the
 * server's own order). Pure presentation; the health-chip VERDICT itself is
 * derived CLIENT-side from the row's raw signals via `fleetHealth.ts` —
 * mirrors DASH-2's `meterTone.ts` precedent (server sends numbers, the
 * client picks the verdict/tone).
 *
 * Built on `components/ui`'s existing `Table`/`Row`/`Cell` dense-table
 * primitives (used elsewhere in the app already) rather than a new grid
 * component.
 */
import { Text, View } from "react-native";
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { CENTRAL } from "@events-os/shared";
import { Badge, Cell, HeaderCell, Row, SectionHeader, Table, TableHeader } from "../../ui";
import { SparkLine } from "./SparkLine";
import { Meter } from "./Meter";
import { compactCents } from "./compactCents";
import { FLEET_HEALTH_TONE, fleetBudgetPct, fleetHealthKind, type FleetHealthKind } from "./fleetHealth";

type ChapterHealthRow = FunctionReturnType<typeof api.dashboardCharts.chapterHealth>[number];

function healthLabel(kind: FleetHealthKind, row: ChapterHealthRow): string {
  if (kind === "under_water") return `Under water ${compactCents(row.underWaterCents ?? 0)}`;
  if (kind === "needs_attention") return "Needs attention";
  return "Healthy";
}

export function ChapterFleet({
  rows,
  onViewChapter,
}: {
  rows: ChapterHealthRow[];
  onViewChapter: (chapterId: Id<"chapters">, chapterName: string) => void;
}) {
  if (rows.length === 0) return null;

  // Decorative only (the "in-progress" bar in each row's trend sparkline) —
  // `chapterHealth` always views YTD-through-the-CURRENT-month (see its own
  // doc comment), so every row shares the same through-month; this is a
  // client-local approximation of that (not the server's own Eastern-time
  // `now.month`), acceptable since it only affects which bar renders hollow.
  const partialMonth = new Date().getMonth() + 1;

  return (
    <View className="mt-2">
      <SectionHeader title="Chapters at a glance" count={rows.length} />
      <Table>
        <TableHeader>
          <HeaderCell flex={1.6}>Chapter</HeaderCell>
          <HeaderCell flex={1.1}>Backers</HeaderCell>
          <HeaderCell width={64}>Trend</HeaderCell>
          <HeaderCell flex={1.3}>Budget</HeaderCell>
          <HeaderCell width={56} align="center">
            Unattr
          </HeaderCell>
          <HeaderCell width={56} align="center">
            Review
          </HeaderCell>
          <HeaderCell width={70} align="center">
            Approvals
          </HeaderCell>
          <HeaderCell flex={1.3} align="right">
            Health
          </HeaderCell>
        </TableHeader>
        {rows.map((row, i) => (
          <FleetRow
            key={row.chapterId}
            row={row}
            partialMonth={partialMonth}
            last={i === rows.length - 1}
            onPress={
              row.chapterId === CENTRAL
                ? undefined
                : // Safe cast: this branch only runs when `row.chapterId !==
                  // CENTRAL` above, but that narrowing doesn't persist into a
                  // nested closure (a TS limitation, not a runtime one —
                  // same precedent as `CentralView`'s drilldown rows).
                  () => onViewChapter(row.chapterId as Id<"chapters">, row.name)
            }
          />
        ))}
      </Table>
    </View>
  );
}

function FleetRow({
  row,
  partialMonth,
  last,
  onPress,
}: {
  row: ChapterHealthRow;
  partialMonth: number;
  last: boolean;
  onPress?: () => void;
}) {
  const months = row.monthlySpendCents.map((spendCents, i) => ({ month: i + 1, spendCents }));
  const pct = fleetBudgetPct(row.spendYtdCents, row.budgetYtdCents);
  const kind = fleetHealthKind(row);

  return (
    <Row onPress={onPress} last={last}>
      <Cell flex={1.6}>
        <Text className="font-display text-sm text-ink" numberOfLines={1}>
          {row.name}
        </Text>
      </Cell>
      <Cell flex={1.1}>
        {row.chapterId === CENTRAL ? (
          <Text className="text-xs text-faint">—</Text>
        ) : row.backers == null ? (
          <Text className="text-xs text-faint">Not set</Text>
        ) : (
          <Text className="text-xs text-muted" numberOfLines={1}>
            {row.backers} · {row.tierLabel}
          </Text>
        )}
      </Cell>
      <Cell width={64}>
        <SparkLine months={months} partialMonth={partialMonth} />
      </Cell>
      <Cell flex={1.3}>
        <View className="max-w-[140px] gap-1">
          <Meter pct={pct} size="sm" />
          <Text className="text-2xs text-muted" style={{ fontVariant: ["tabular-nums"] }}>
            {compactCents(row.spendYtdCents)}/{compactCents(row.budgetYtdCents)}
          </Text>
        </View>
      </Cell>
      <Cell width={56} align="center">
        <CountChip count={row.unattributedCount} tone={row.unattributedCount > 0 ? "danger" : "neutral"} />
      </Cell>
      <Cell width={56} align="center">
        <CountChip count={row.toReviewCount} tone="neutral" />
      </Cell>
      <Cell width={70} align="center">
        <CountChip
          count={row.pendingApprovalsCount}
          tone={row.pendingApprovalsCount > 0 ? "warn" : "neutral"}
        />
      </Cell>
      <Cell flex={1.3} align="right">
        <Badge label={healthLabel(kind, row)} tone={FLEET_HEALTH_TONE[kind]} />
      </Cell>
    </Row>
  );
}

function CountChip({ count, tone }: { count: number; tone: "danger" | "warn" | "neutral" }) {
  const bg = tone === "danger" ? "bg-danger-bg" : tone === "warn" ? "bg-warn-bg" : "bg-sunken";
  const text = tone === "danger" ? "text-danger" : tone === "warn" ? "text-warn" : "text-muted";
  return (
    <View className={`h-5 min-w-[22px] items-center justify-center rounded-pill px-1 ${bg}`}>
      <Text className={`text-2xs font-bold ${text}`} style={{ fontVariant: ["tabular-nums"] }}>
        {count}
      </Text>
    </View>
  );
}
