/**
 * Chapter perspective of the finance dashboard — one chapter's money this month:
 * KPI tiles, the AI auto-coding banner, event/project budget cards, recurring
 * buckets (with a "New budget" action), the recent-transactions table (with an
 * "Add transaction" action and AI-suggestion Accept), and the attention queue.
 *
 * All figures come straight from `api.finances.dashboardChapter` — this view is
 * pure presentation over that contract.
 */
import { Text, View } from "react-native";
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import { formatCents } from "@events-os/shared";
import {
  Badge,
  Button,
  Cell,
  EmptyState,
  HeaderCell,
  Row,
  SectionHeader,
  Table,
  TableHeader,
} from "../../ui";
import {
  AiCodingBanner,
  BudgetBar,
  Chip,
  MiniBar,
  Money,
  SignedMoney,
  Tile,
  TileRow,
  txnStatusTone,
} from "./parts";

type ChapterDash = FunctionReturnType<typeof api.finances.dashboardChapter>;
type ProjectBudget = ChapterDash["projectBudgets"][number];
type RecurringBudget = ChapterDash["recurringBudgets"][number];
type RecentTxn = ChapterDash["recentTransactions"][number];
// The backend always returns `attention: []` today (populated in Phases 3+5),
// so its inferred element type collapses to `never` — pin it to the contract.
type Attention = {
  kind: string;
  title: string;
  badgeCount: number;
  detail: string;
  actionLabel: string;
};

export function ChapterView({
  data,
  onNewBudget,
  onEditBudget,
  onAddTransaction,
}: {
  data: ChapterDash;
  onNewBudget: () => void;
  onEditBudget: (budgetId: string) => void;
  onAddTransaction: () => void;
}) {
  const needsReview = data.recentTransactions.filter(
    (t) => txnStatusTone(t.status).label === "Needs review",
  ).length;

  return (
    <View>
      {/* KPI tiles */}
      <TileRow>
        {data.tiles.map((t, i) => (
          <Tile key={i} label={t.label} value={t.value} meta={t.meta} />
        ))}
      </TileRow>

      <View className="mt-3">
        <AiCodingBanner />
      </View>

      {/* Events & projects */}
      <SectionHeader title="Events & projects" count={data.projectBudgets.length} />
      {data.projectBudgets.length === 0 ? (
        <EmptyState
          title="No event or project budgets yet"
          message="Budget an event or project to track its spend against a plan."
        />
      ) : (
        <View className="gap-3">
          {data.projectBudgets.map((b) => (
            <ProjectBudgetCard key={b.id} b={b} onPress={() => onEditBudget(b.id)} />
          ))}
        </View>
      )}

      {/* Recurring buckets */}
      <SectionHeader
        title="Recurring buckets"
        count="monthly · quarterly · yearly"
        right={
          <Button title="New budget" icon="plus" size="sm" onPress={onNewBudget} />
        }
      />
      {data.recurringBudgets.length === 0 ? (
        <EmptyState
          title="No recurring buckets"
          message="Create a monthly, quarterly, or yearly budget for a team or category."
          action={<Button title="New budget" icon="plus" size="sm" onPress={onNewBudget} />}
        />
      ) : (
        <View className="flex-row flex-wrap gap-3">
          {data.recurringBudgets.map((b) => (
            <RecurringBudgetCard key={b.id} b={b} onPress={() => onEditBudget(b.id)} />
          ))}
        </View>
      )}

      {/* Recent transactions */}
      <SectionHeader
        title="Recent transactions"
        count={needsReview > 0 ? `${needsReview} need review` : undefined}
        right={
          <Button
            title="Add transaction"
            icon="plus"
            size="sm"
            variant="secondary"
            onPress={onAddTransaction}
          />
        }
      />
      {data.recentTransactions.length === 0 ? (
        <EmptyState
          title="No transactions yet"
          message="Charges and manual entries show up here as they land."
          action={
            <Button title="Add transaction" icon="plus" size="sm" onPress={onAddTransaction} />
          }
        />
      ) : (
        <TransactionsTable rows={data.recentTransactions} />
      )}

      {/* Needs your attention */}
      <SectionHeader title="Needs your attention" count={data.attention.length || undefined} />
      {data.attention.length === 0 ? (
        <EmptyState
          icon="check-circle"
          title="All clear"
          message="No reimbursements to approve or cards nearing a receipt lock."
        />
      ) : (
        <View className="gap-3">
          {(data.attention as Attention[]).map((a, i) => (
            <AttentionCard key={i} a={a} />
          ))}
        </View>
      )}
    </View>
  );
}

// ── Event / project budget card ──────────────────────────────────────────────
function ProjectBudgetCard({ b, onPress }: { b: ProjectBudget; onPress: () => void }) {
  const meta = [b.dateLabel, b.subtitle].filter(Boolean).join(" · ");
  return (
    <View className="rounded-lg border border-border bg-raised p-4 shadow-card">
      <View className="mb-2 flex-row items-start justify-between gap-3">
        <View className="flex-1">
          <View className="flex-row flex-wrap items-center gap-2">
            <Text className="font-display text-lg text-ink" numberOfLines={1}>
              {b.name}
            </Text>
            <Chip label={b.cadence === "per_instance" ? "Per instance" : "One-off"} />
            {b.sourceBadge ? <Badge label={b.sourceBadge} tone="info" /> : null}
          </View>
          {meta ? <Text className="mt-0.5 text-xs text-muted">{meta}</Text> : null}
        </View>
        <Text
          className="text-sm text-muted"
          style={{ fontVariant: ["tabular-nums"] }}
        >
          {formatCents(b.spentCents)} / {formatCents(b.budgetCents)}
        </Text>
      </View>

      <BudgetBar pct={b.pct} status={b.status} />

      <View className="mt-1.5 flex-row items-center justify-between">
        <Text className="text-xs text-muted">{b.pct}% spent</Text>
        <Text className="text-xs text-muted">
          <Money cents={b.remainingCents} className="text-xs text-muted" /> left
        </Text>
      </View>

      {b.categories.length > 0 ? (
        <View className="mt-3 gap-2 border-t border-border pt-3">
          {b.categories.map((c, i) => (
            <View key={i} className="gap-1">
              <View className="flex-row items-center justify-between">
                <Text className="text-xs text-ink" numberOfLines={1}>
                  {c.name}
                </Text>
                <Money cents={c.spentCents} className="text-xs text-muted" />
              </View>
              <MiniBar barPct={c.barPct} />
            </View>
          ))}
        </View>
      ) : null}

      <View className="mt-3">
        <Button title="Edit budget" variant="ghost" size="sm" onPress={onPress} />
      </View>
    </View>
  );
}

// ── Recurring bucket card ────────────────────────────────────────────────────
function RecurringBudgetCard({ b, onPress }: { b: RecurringBudget; onPress: () => void }) {
  const cadenceLabel =
    b.cadence === "monthly" ? "Monthly" : b.cadence === "quarterly" ? "Quarterly" : "Yearly";
  return (
    <View className="min-w-[260px] flex-1 rounded-lg border border-border bg-raised p-4 shadow-card">
      <View className="mb-2 flex-row items-start justify-between gap-2">
        <View className="flex-1">
          <Text className="font-display text-base text-ink" numberOfLines={1}>
            {b.name}
          </Text>
          <View className="mt-1">
            <Chip label={cadenceLabel} />
          </View>
        </View>
        <Text className="text-sm text-muted" style={{ fontVariant: ["tabular-nums"] }}>
          {formatCents(b.spentCents)} / {formatCents(b.budgetCents)}
        </Text>
      </View>

      <BudgetBar pct={b.pct} status={b.status} />
      <View className="mt-1.5 flex-row items-center justify-between">
        <Text className="text-xs text-muted">{b.pct}% spent</Text>
        {b.note ? <Text className="text-xs text-muted">{b.note}</Text> : null}
      </View>

      {b.categories && b.categories.length > 0 ? (
        <View className="mt-3 gap-2 border-t border-border pt-3">
          {b.categories.map((c, i) => (
            <View key={i} className="gap-1">
              <View className="flex-row items-center justify-between">
                <Text className="text-xs text-ink" numberOfLines={1}>
                  {c.name}
                </Text>
                <Money cents={c.spentCents} className="text-xs text-muted" />
              </View>
              <MiniBar barPct={c.barPct} />
            </View>
          ))}
        </View>
      ) : null}

      <View className="mt-3">
        <Button title="Edit budget" variant="ghost" size="sm" onPress={onPress} />
      </View>
    </View>
  );
}

// ── Recent transactions table ────────────────────────────────────────────────
function TransactionsTable({ rows }: { rows: RecentTxn[] }) {
  return (
    <Table>
      <TableHeader>
        <HeaderCell flex={2}>Transaction</HeaderCell>
        <HeaderCell flex={2}>Coded to</HeaderCell>
        <HeaderCell width={110} align="right">
          Amount
        </HeaderCell>
        <HeaderCell width={120} align="right">
          Status
        </HeaderCell>
      </TableHeader>
      {rows.map((t, i) => {
        const status = txnStatusTone(t.status);
        const spender = [t.spenderName, t.cardLast4 ? `•• ${t.cardLast4}` : null]
          .filter(Boolean)
          .join(" · ");
        return (
          <Row key={t.id} last={i === rows.length - 1}>
            <Cell flex={2}>
              <Text className="text-sm font-semibold text-ink" numberOfLines={1}>
                {t.merchant ?? "—"}
              </Text>
              <Text className="text-xs text-muted" numberOfLines={1}>
                {[t.date, spender || null, t.timeOrNote || null]
                  .filter(Boolean)
                  .join(" · ")}
              </Text>
            </Cell>
            <Cell flex={2}>
              {t.codedTo ? (
                <>
                  <Text className="text-sm text-ink" numberOfLines={1}>
                    {t.codedTo.fundOrProject || "—"}
                  </Text>
                  {t.codedTo.category ? (
                    <Text className="text-xs text-muted" numberOfLines={1}>
                      {t.codedTo.category}
                    </Text>
                  ) : null}
                </>
              ) : t.aiSuggestion ? (
                <View className="gap-1">
                  <Badge
                    label={`AI: ${[t.aiSuggestion.fund, t.aiSuggestion.category]
                      .filter(Boolean)
                      .join(" · ")}`}
                    tone="lavender"
                    icon="sparkles"
                  />
                </View>
              ) : (
                <Text className="text-xs text-faint">Uncoded</Text>
              )}
            </Cell>
            <Cell width={110} align="right">
              <SignedMoney cents={t.amountCents} flow={t.flow} className="text-sm font-semibold" />
            </Cell>
            <Cell width={120} align="right">
              <Badge label={status.label} tone={status.tone} />
            </Cell>
          </Row>
        );
      })}
    </Table>
  );
}

// ── Attention card ───────────────────────────────────────────────────────────
function AttentionCard({ a }: { a: Attention }) {
  return (
    <View className="flex-row items-center gap-3 rounded-lg border border-border bg-raised p-4 shadow-card">
      <View className="h-9 min-w-[36px] items-center justify-center rounded-pill bg-accent-soft px-2">
        <Text className="text-sm font-bold text-accent" style={{ fontVariant: ["tabular-nums"] }}>
          {a.badgeCount}
        </Text>
      </View>
      <View className="flex-1">
        <Text className="text-sm font-semibold text-ink">{a.title}</Text>
        <Text className="text-xs text-muted">{a.detail}</Text>
      </View>
      <Badge label={a.actionLabel} tone="accent" />
    </View>
  );
}
