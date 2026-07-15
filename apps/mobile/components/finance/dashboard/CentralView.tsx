/**
 * Central perspective of the finance dashboard — the org-wide roll-up: global
 * KPI tiles, a "By template" breakdown (each event template's month total split
 * per chapter), and a "By chapter" list (each chapter's month spend against its
 * budget). Pure presentation over `api.finances.dashboardCentral`.
 */
import { Text, View } from "react-native";
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import { formatCents } from "@events-os/shared";
import { EmptyState, SectionHeader } from "../../ui";
import { BudgetBar, MiniBar, Money, Tile, TileRow } from "./parts";

type CentralDash = FunctionReturnType<typeof api.finances.dashboardCentral>;
type TemplateRollup = CentralDash["templateRollup"][number];
type ChapterRollup = CentralDash["chapterRollup"][number];

export function CentralView({ data }: { data: CentralDash }) {
  return (
    <View>
      <TileRow>
        {data.tiles.map((t, i) => (
          <Tile key={i} label={t.label} value={t.value} meta={t.meta} />
        ))}
      </TileRow>

      {/* By template, across chapters */}
      <SectionHeader title="By template" count="across all chapters" />
      {data.templateRollup.length === 0 ? (
        <EmptyState
          title="No template spend this month"
          message="Charges linked to an event roll up here by the event's template."
        />
      ) : (
        <View className="gap-3">
          {data.templateRollup.map((r, i) => (
            <TemplateCard key={i} r={r} />
          ))}
        </View>
      )}

      {/* By chapter */}
      <SectionHeader title="By chapter" count={data.chapterRollup.length} />
      {data.chapterRollup.length === 0 ? (
        <EmptyState title="No chapters yet" />
      ) : (
        <View className="gap-3">
          {data.chapterRollup.map((c) => (
            <ChapterRollupCard key={c.chapterId} c={c} />
          ))}
        </View>
      )}
    </View>
  );
}

function TemplateCard({ r }: { r: TemplateRollup }) {
  return (
    <View className="rounded-lg border border-border bg-raised p-4 shadow-card">
      <View className="mb-3 flex-row items-center justify-between gap-3">
        <View className="flex-1">
          <Text className="font-display text-base text-ink" numberOfLines={1}>
            {r.templateName}
          </Text>
          <Text className="text-xs text-muted">
            {r.scopeLabel} · {r.perChapter.length} chapters
          </Text>
        </View>
        <Money cents={r.monthTotalCents} className="text-base font-semibold text-ink" />
      </View>
      <View className="gap-2">
        {r.perChapter.map((pc, i) => (
          <View key={i} className="gap-1">
            <View className="flex-row items-center justify-between">
              <Text className="text-xs text-ink" numberOfLines={1}>
                {pc.chapterName}
              </Text>
              <Money cents={pc.amountCents} className="text-xs text-muted" />
            </View>
            <MiniBar barPct={pc.barPct} />
          </View>
        ))}
      </View>
    </View>
  );
}

function ChapterRollupCard({ c }: { c: ChapterRollup }) {
  return (
    <View className="rounded-lg border border-border bg-raised p-4 shadow-card">
      <View className="mb-2 flex-row items-start justify-between gap-3">
        <View className="flex-1">
          <Text className="font-display text-base text-ink" numberOfLines={1}>
            {c.chapterName}
          </Text>
          {c.subtitle ? <Text className="text-xs text-muted">{c.subtitle}</Text> : null}
        </View>
        <Text className="text-sm text-muted" style={{ fontVariant: ["tabular-nums"] }}>
          {formatCents(c.spentCents)} / {formatCents(c.budgetCents)}
        </Text>
      </View>
      <BudgetBar pct={c.barPct} status={c.status} />
    </View>
  );
}
