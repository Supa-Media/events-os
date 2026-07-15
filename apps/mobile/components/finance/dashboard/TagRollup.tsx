/**
 * "By tag" rollup — the interactive tag-spend section shared by the chapter and
 * central dashboards (the "spent on Fundraisers" flow). Each tag row shows its
 * rolled-up spent-of-allocated (from `dashboardChapter`/`dashboardCentral`'s
 * `tagRollups`) and is tappable → a detail sheet that names the total spend on
 * that tag and lists the budgets carrying it (one-time vs recurring), derived by
 * filtering `listBudgets` client-side.
 *
 * The chapter dashboard's rollup rows carry a real `tagId`, so the detail sheet
 * matches budgets on tag id (`matchMode="id"`). The central rollup aggregates
 * same-named tags across chapters and leaves `tagId` null, so it matches by name
 * (`matchMode="name"`) over the caller-visible (chapter + central) budgets.
 */
import { useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import { formatCents } from "@events-os/shared";
import { Badge, EmptyState, Icon, SectionHeader } from "../../ui";
import { colors } from "../../../lib/theme";
import { BudgetBar } from "./parts";

type ChapterDash = FunctionReturnType<typeof api.finances.dashboardChapter>;
export type TagRollup = ChapterDash["tagRollups"][number];
/** Per-budget actuals keyed by budget id, sourced from the dashboard cards. */
export type BudgetSpend = { spentCents: number; budgetCents: number };

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

/**
 * The "By tag" dashboard section: a tappable row per tag rollup, plus the
 * detail sheet that opens on tap.
 */
export function TagRollupSection({
  rollups,
  spentByBudgetId,
  matchMode = "id",
}: {
  rollups: TagRollup[];
  spentByBudgetId: Map<string, BudgetSpend>;
  matchMode?: "id" | "name";
}) {
  const [selected, setSelected] = useState<TagRollup | null>(null);

  return (
    <>
      <SectionHeader title="By tag" count={rollups.length || undefined} />
      {rollups.length === 0 ? (
        <EmptyState
          title="No tagged spend yet"
          message="Tag budgets (e.g. a “Fundraisers” tag) to roll their spend up here."
        />
      ) : (
        <View className="gap-3">
          {rollups.map((r, i) => (
            <TagRollupRow
              key={r.tagId ?? `${r.tagName}:${i}`}
              r={r}
              onPress={() => setSelected(r)}
            />
          ))}
        </View>
      )}

      {selected ? (
        <TagDetailModal
          rollup={selected}
          matchMode={matchMode}
          spentByBudgetId={spentByBudgetId}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </>
  );
}

function TagRollupRow({ r, onPress }: { r: TagRollup; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      className="rounded-lg border border-border bg-raised p-4 shadow-card active:bg-sunken web:hover:border-border-strong"
    >
      <View className="mb-2 flex-row items-center justify-between gap-3">
        <View className="flex-1 flex-row items-center gap-2">
          <Text className="font-display text-base text-ink" numberOfLines={1}>
            {r.tagName}
          </Text>
          <Badge label={tagKindLabel(r.kind)} tone="neutral" />
        </View>
        <View className="flex-row items-center gap-2">
          <Text className="text-sm text-muted" style={TABULAR}>
            {formatCents(r.spentCents)} / {formatCents(r.budgetCents)}
          </Text>
          <Icon name="chevron-right" size={16} color={colors.muted} />
        </View>
      </View>
      <BudgetBar pct={r.pct} status={r.status} />
      <Text className="mt-1.5 text-xs text-muted">{r.pct}% spent</Text>
    </Pressable>
  );
}

// ── Tag detail sheet ─────────────────────────────────────────────────────────
type BudgetRow = FunctionReturnType<typeof api.finances.listBudgets>[number];

function TagDetailModal({
  rollup,
  matchMode,
  spentByBudgetId,
  onClose,
}: {
  rollup: TagRollup;
  matchMode: "id" | "name";
  spentByBudgetId: Map<string, BudgetSpend>;
  onClose: () => void;
}) {
  const budgets = useQuery(api.finances.listBudgets) ?? [];

  const { oneTime, recurring } = useMemo(() => {
    const carrying = budgets.filter((b) =>
      b.tags.some((t) =>
        matchMode === "id" ? t.id === rollup.tagId : t.name === rollup.tagName,
      ),
    );
    return {
      oneTime: carrying.filter((b) => b.type === "one_time"),
      recurring: carrying.filter((b) => b.type !== "one_time"),
    };
  }, [budgets, rollup.tagId, rollup.tagName, matchMode]);

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

            <BudgetGroup
              title="One-time"
              budgets={oneTime}
              spentByBudgetId={spentByBudgetId}
            />
            <BudgetGroup
              title="Recurring"
              budgets={recurring}
              spentByBudgetId={spentByBudgetId}
            />

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

function BudgetGroup({
  title,
  budgets,
  spentByBudgetId,
}: {
  title: string;
  budgets: BudgetRow[];
  spentByBudgetId: Map<string, BudgetSpend>;
}) {
  if (budgets.length === 0) return null;
  return (
    <View className="mt-3">
      <Text className="mb-1 text-2xs font-bold uppercase tracking-wider text-muted">
        {title}
      </Text>
      {budgets.map((b) => (
        <BudgetLine key={b.id} b={b} spend={spentByBudgetId.get(b.id)} />
      ))}
    </View>
  );
}

function BudgetLine({ b, spend }: { b: BudgetRow; spend: BudgetSpend | undefined }) {
  const name =
    b.label?.trim() ||
    (b.type === "one_time" ? "One-time budget" : "Recurring budget");
  const allocatedCents = b.amountCents;
  const spentCents = spend?.spentCents;
  const pct =
    spentCents != null && allocatedCents > 0
      ? Math.round((spentCents / allocatedCents) * 100)
      : 0;
  return (
    <View className="gap-1 border-t border-border py-2.5">
      <View className="flex-row items-center justify-between gap-3">
        <Text className="flex-1 text-sm text-ink" numberOfLines={1}>
          {name}
        </Text>
        <Text className="text-sm text-muted" style={TABULAR}>
          {spentCents != null ? formatCents(spentCents) : "—"} /{" "}
          {formatCents(allocatedCents)}
        </Text>
      </View>
      {spentCents != null ? (
        <BudgetBar pct={pct} status={pct >= 80 ? "warn" : "ok"} />
      ) : null}
    </View>
  );
}
