/**
 * Central perspective of the finance dashboard — the org-wide roll-up: global
 * KPI tiles, central budgets, an interactive "By tag" breakdown (each tag's
 * org-wide spend, tappable to the contributing budgets), and a "By chapter"
 * list (each chapter's month spend against its budget). Pure presentation over
 * `api.finances.dashboardCentral`.
 */
import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import {
  BUDGET_CADENCE_LABELS,
  BUDGET_SCOPE_LABELS,
  formatCents,
} from "@events-os/shared";
import { EmptyState, Icon, SectionHeader } from "../../ui";
import { colors } from "../../../lib/theme";
import { BudgetBar, Chip, Tile, TileRow } from "./parts";
import { TagRollupSection, type BudgetSpend } from "./TagRollup";

type CentralDash = FunctionReturnType<typeof api.finances.dashboardCentral>;
type ChapterRollup = CentralDash["chapterRollup"][number];
type CentralBudget = CentralDash["centralBudgets"][number];

export function CentralView({
  data,
  onViewChapter,
}: {
  data: CentralDash;
  /** Drill into one chapter's chapter-perspective dashboard (central-only —
   *  the backend re-checks central reach via `dashboardChapter({chapterId})`). */
  onViewChapter: (chapterId: ChapterRollup["chapterId"], chapterName: string) => void;
}) {
  // Per-central-budget actuals for the tag-detail sheet, keyed by budget id.
  const spentByBudgetId = useMemo(() => {
    const m = new Map<string, BudgetSpend>();
    for (const b of data.centralBudgets)
      m.set(b.id, { spentCents: b.spentCents, budgetCents: b.budgetCents });
    return m;
  }, [data.centralBudgets]);

  return (
    <View>
      <TileRow>
        {data.tiles.map((t, i) => (
          <Tile key={i} label={t.label} value={t.value} meta={t.meta} />
        ))}
      </TileRow>

      {/* Org-wide Unattributed: this period's spend across every chapter with
          no explicit budget link — every central budget card below is BLIND
          to it (no derive-matching fallback exists — see WP-0.1). Read-only
          (no tap-through: Reconcile is chapter-scoped, and this sum spans
          every chapter, so there's no single destination to jump to). */}
      {data.orgUnattributedCents > 0 ? (
        <View className="mb-3 flex-row items-center gap-3 rounded-lg border border-warn bg-warn-bg p-4 shadow-card">
          <View className="flex-1">
            <Text className="text-sm font-semibold text-ink">
              Unattributed: {formatCents(data.orgUnattributedCents)}
            </Text>
            <Text className="text-xs text-muted">
              Org-wide spend this period with no budget attached — chase each
              chapter's Treasurer to code it in Reconcile.
            </Text>
          </View>
        </View>
      ) : null}

      {/* Org-wide (central) budgets — spend across every chapter. */}
      {data.centralBudgets.length > 0 ? (
        <>
          <SectionHeader title="Central budgets" count="org-wide" />
          <View className="flex-row flex-wrap gap-3">
            {data.centralBudgets.map((b) => (
              <CentralBudgetCard key={b.id} b={b} />
            ))}
          </View>
        </>
      ) : null}

      {/* By tag, across chapters — interactive rollup */}
      <TagRollupSection
        rollups={data.tagRollups}
        spentByBudgetId={spentByBudgetId}
        matchMode="name"
      />

      {/* By chapter */}
      <SectionHeader title="By chapter" count={data.chapterRollup.length} />
      {data.chapterRollup.length === 0 ? (
        <EmptyState title="No chapters yet" />
      ) : (
        <View className="gap-3">
          {data.chapterRollup.map((c) => (
            <ChapterRollupCard
              key={c.chapterId}
              c={c}
              onView={() => onViewChapter(c.chapterId, c.chapterName)}
            />
          ))}
        </View>
      )}
    </View>
  );
}

function CentralBudgetCard({ b }: { b: CentralBudget }) {
  // `scope` is a nullable legacy column on v2 budgets — fall back when absent.
  const name =
    b.label?.trim() || (b.scope ? BUDGET_SCOPE_LABELS[b.scope] : "Central budget");
  return (
    <View className="min-w-[260px] flex-1 rounded-lg border border-border bg-raised p-4 shadow-card">
      <View className="mb-2 flex-row items-start justify-between gap-2">
        <View className="flex-1">
          <Text className="font-display text-base text-ink" numberOfLines={1}>
            {name}
          </Text>
          <View className="mt-1">
            <Chip label={BUDGET_CADENCE_LABELS[b.cadence]} />
          </View>
        </View>
        <Text
          className="text-sm text-muted"
          style={{ fontVariant: ["tabular-nums"] }}
        >
          {formatCents(b.spentCents)} / {formatCents(b.budgetCents)}
        </Text>
      </View>
      <BudgetBar pct={b.pct} status={b.status} />
      <Text className="mt-1.5 text-xs text-muted">{b.pct}% spent</Text>
    </View>
  );
}

function ChapterRollupCard({ c, onView }: { c: ChapterRollup; onView: () => void }) {
  return (
    <Pressable
      onPress={onView}
      accessibilityRole="button"
      className="rounded-lg border border-border bg-raised p-4 shadow-card active:bg-sunken web:hover:border-border-strong"
    >
      <View className="mb-2 flex-row items-start justify-between gap-3">
        <View className="flex-1">
          <Text className="font-display text-base text-ink" numberOfLines={1}>
            {c.chapterName}
          </Text>
          {c.subtitle ? <Text className="text-xs text-muted">{c.subtitle}</Text> : null}
        </View>
        <View className="flex-row items-center gap-2">
          <Text className="text-sm text-muted" style={{ fontVariant: ["tabular-nums"] }}>
            {formatCents(c.spentCents)} / {formatCents(c.budgetCents)}
          </Text>
          <Icon name="chevron-right" size={16} color={colors.muted} />
        </View>
      </View>
      <BudgetBar pct={c.barPct} status={c.status} />
    </Pressable>
  );
}
