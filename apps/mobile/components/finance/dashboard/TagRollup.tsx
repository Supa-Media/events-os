/**
 * "By tag" rollup detail sheet — a modal that names a tag's total spend and
 * lists the budgets carrying it, sourced from `api.finances.tagDrilldown` — a
 * dedicated, period-scoped, authz-aware query (see its doc comment in
 * `finances.ts` for the full "why"). Shared by the chapter and central
 * dashboards (the "spent on Fundraisers" flow).
 *
 * Replaces the old `listBudgets` (client-filtered, un-period-scoped) +
 * `budgetVsActual` (whole-year, caller's-own-chapter-only) backfill — that path
 * disagreed with the rollup header it sat under (numbers didn't reconcile) and,
 * for a central drill-down, went entirely blank ("—" on every row) for any
 * caller without a personal chapter-level finance grant. `tagDrilldown` fixes
 * both: its rows always sum exactly to the rollup row's own `spentCents`/
 * `budgetCents`, and its `scope: "central"` branch uses the caller's
 * already-verified central reach to read every chapter's contributing budgets
 * directly.
 *
 * The chapter dashboard's rollup rows carry a real `tagId` (`scope="chapter"`,
 * matched by id). The central rollup aggregates same-named + same-kind tags
 * across chapters and leaves `tagId` null (`scope="central"`, matched by
 * `tagName` + `kind`, mirroring `dashboardCentral`'s own `tagAgg` key).
 *
 * DASH-3: the old `TagRollupSection` (a tappable card per rollup + this
 * modal) is gone — `CentralView`'s "By tag" rows are now dense rows in the
 * combined budgets table (chip "tag", chevron opens THIS modal directly); the
 * modal itself is unchanged and now exported for that caller. `ChapterView`
 * doesn't consume this file at all (chapter tag rollups aren't in scope
 * here).
 */
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { formatCents } from "@events-os/shared";
import { Badge, Icon } from "../../ui";
import { colors } from "../../../lib/theme";
import { BudgetBar } from "./parts";

type ChapterDash = FunctionReturnType<typeof api.finances.dashboardChapter>;
export type TagRollup = ChapterDash["tagRollups"][number];

const TABULAR = { fontVariant: ["tabular-nums" as const] };

const KIND_LABEL: Record<string, string> = {
  team: "Team",
  template: "Template",
  events: "Events",
  custom: "Custom",
};

export function tagKindLabel(kind: string | null): string {
  return kind ? (KIND_LABEL[kind] ?? "Tag") : "Tag";
}

// ── Tag detail sheet ─────────────────────────────────────────────────────────
type DrilldownBudget = FunctionReturnType<typeof api.finances.tagDrilldown>["budgets"][number];

export function TagDetailModal({
  rollup,
  scope,
  year,
  month,
  period,
  chapterId,
  onClose,
}: {
  rollup: TagRollup;
  scope: "chapter" | "central";
  year: number;
  month: number;
  period: "month" | "ytd";
  chapterId?: Id<"chapters">;
  onClose: () => void;
}) {
  const budgets =
    useQuery(
      api.finances.tagDrilldown,
      scope === "chapter"
        ? { year, month, period, scope, chapterId, tagId: rollup.tagId ?? undefined }
        : { year, month, period, scope, tagName: rollup.tagName, tagKind: rollup.kind },
    )?.budgets ?? [];

  const oneTime = budgets.filter((b) => b.type === "one_time");
  const recurring = budgets.filter((b) => b.type !== "one_time");

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        className="flex-1 items-center justify-center bg-ink/30 p-6"
      >
        <Pressable
          onPress={() => {}}
          className="w-full max-w-lg overflow-hidden rounded-xl border border-border bg-raised shadow-pop"
        >
          <View className="flex-row items-start justify-between border-b border-border px-5 py-4">
            <View className="flex-1">
              <View className="flex-row items-center gap-2">
                <Text className="font-display text-lg text-ink" numberOfLines={1}>
                  {rollup.tagName}
                </Text>
                <Badge label={tagKindLabel(rollup.kind)} tone="neutral" />
              </View>
              <Text className="mt-1 text-sm text-muted">
                Spent on {rollup.tagName}:{" "}
                <Text className="font-semibold text-ink" style={TABULAR}>
                  {formatCents(rollup.spentCents)}
                </Text>{" "}
                of {formatCents(rollup.budgetCents)}
              </Text>
            </View>
            <Pressable onPress={onClose} hitSlop={8} className="rounded-md p-1">
              <Icon name="x" size={18} color={colors.muted} />
            </Pressable>
          </View>

          <ScrollView className="max-h-[440px] px-5 py-4">
            <BudgetBar pct={rollup.pct} status={rollup.status} />
            <Text className="mb-2 mt-1.5 text-xs text-muted">{rollup.pct}% spent</Text>

            <BudgetGroup title="One-time" budgets={oneTime} />
            <BudgetGroup title="Recurring" budgets={recurring} />

            {oneTime.length === 0 && recurring.length === 0 ? (
              <Text className="py-4 text-sm text-muted">
                No budgets carry this tag yet.
              </Text>
            ) : null}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function BudgetGroup({ title, budgets }: { title: string; budgets: DrilldownBudget[] }) {
  if (budgets.length === 0) return null;
  return (
    <View className="mt-3">
      <Text className="mb-1 text-2xs font-bold uppercase tracking-wider text-muted">
        {title}
      </Text>
      {budgets.map((b) => (
        <BudgetLine key={b.id} b={b} />
      ))}
    </View>
  );
}

function BudgetLine({ b }: { b: DrilldownBudget }) {
  const name = b.name;
  const pct = b.budgetCents > 0 ? Math.round((b.spentCents / b.budgetCents) * 100) : 0;
  return (
    <View className="gap-1 border-t border-border py-2.5">
      <View className="flex-row items-center justify-between gap-3">
        <Text className="flex-1 text-sm text-ink" numberOfLines={1}>
          {name}
          {/* A central drill-down spans chapters — disambiguate which one. */}
          {b.chapterName ? (
            <Text className="text-xs text-muted"> · {b.chapterName}</Text>
          ) : b.level === "central" ? (
            <Text className="text-xs text-muted"> · Central</Text>
          ) : null}
        </Text>
        <Text className="text-sm text-muted" style={TABULAR}>
          {formatCents(b.spentCents)} / {formatCents(b.budgetCents)}
        </Text>
      </View>
      <BudgetBar pct={pct} status={pct >= 80 ? "warn" : "ok"} />
    </View>
  );
}
