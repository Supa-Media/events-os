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
 * so a cardholder and the FM can never see two different answers.
 *
 * ── NO LONGER READ-ONLY-AND-INERT (founder, 2026-08-14) ──────────────────────
 * "The budgeting section leaves a lot to be desired. It just gives an amount…
 * you can't even click to the event, go to the money page for a project… we
 * should just be able to drop down and see the different expenses per budget.
 * It should just be a lot more interactable."
 *
 * She was describing this file exactly: every card was a `<View>` with a
 * number and a meter and no affordance of any kind. What changed:
 *
 *  · Each card is a DISCLOSURE (`BudgetGlanceCard`) — press to drop down the
 *    charges behind the number, the category breakdown, and links out to the
 *    linked event/project and its money surface. The old comment here said
 *    "no drill-down into transactions — that stays on the gated finance
 *    surfaces"; that was the bug, not the design. The drill-down is member-
 *    visible now, behind its own named power (`lib/budgetGlanceAccess.ts`), and
 *    the gated surfaces still own every WRITE.
 *  · A TOTALS strip: what the whole list adds up to, so "are we okay overall"
 *    is answerable without adding twenty cards up by hand.
 *  · A FILTER box, because the answer to "how much is left on Genesis" should
 *    not require scrolling past every recurring bucket in the chapter.
 *  · An OVER-BUDGET call-out at the top — the one thing on this screen that
 *    is genuinely urgent was previously indistinguishable from the rest,
 *    sitting in date order somewhere down the list.
 */
import { useState } from "react";
import { Text, View } from "react-native";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import { formatCents } from "@events-os/shared";
import {
  EmptyState,
  Narrow,
  Screen,
  SectionHeader,
  TextField,
} from "../../../components/ui";
import { BudgetGlanceCard } from "../../../components/finance/budgets/BudgetGlanceCard";

type Glance = FunctionReturnType<typeof api.finances.budgetsGlance>;
type GlanceRow = Glance["oneTime"][number];

/** Case-insensitive substring match on the budget's display name — the only
 *  text a reader has to go on, and the only thing they'd type. */
function matches(row: GlanceRow, needle: string): boolean {
  if (!needle) return true;
  return row.name.toLowerCase().includes(needle.toLowerCase());
}

/**
 * The list's headline numbers. Deliberately computed over the FILTERED rows,
 * so a search for "Genesis" reports Genesis's totals rather than the
 * chapter's — a summary that ignored the filter above it would be a number
 * that doesn't describe anything on screen.
 *
 * `over` counts rows, not dollars: "3 budgets are over" is the actionable
 * sentence; the dollars are already on each card.
 */
function totalsOf(rows: GlanceRow[]) {
  let capCents = 0;
  let spentCents = 0;
  let over = 0;
  for (const r of rows) {
    capCents += r.capCents;
    spentCents += r.spentCents;
    if (r.remainingCents < 0) over += 1;
  }
  return { capCents, spentCents, remainingCents: capCents - spentCents, over };
}

function TotalsStrip({
  totals,
}: {
  totals: { capCents: number; spentCents: number; remainingCents: number; over: number };
}) {
  const over = totals.remainingCents < 0;
  return (
    <View className="mb-4 flex-row flex-wrap gap-3 rounded-lg border border-border bg-raised p-3 shadow-card">
      <Stat label="Budgeted" value={formatCents(totals.capCents)} />
      <Stat label="Spent" value={formatCents(totals.spentCents)} />
      <Stat
        label={over ? "Over by" : "Left"}
        value={formatCents(Math.abs(totals.remainingCents))}
        tone={over ? "danger" : "success"}
      />
    </View>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "danger" | "success";
}) {
  const toneClass =
    tone === "danger" ? "text-danger" : tone === "success" ? "text-success" : "text-ink";
  return (
    <View className="min-w-[92px] flex-1">
      <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
        {label}
      </Text>
      <Text
        className={`text-lg font-semibold ${toneClass}`}
        style={{ fontVariant: ["tabular-nums"] }}
      >
        {value}
      </Text>
    </View>
  );
}

export default function BudgetsGlanceScreen() {
  const glance = useQuery(api.finances.budgetsGlance, {});
  const [filter, setFilter] = useState("");

  const oneTime = (glance?.oneTime ?? []).filter((r) => matches(r, filter));
  const recurring = (glance?.recurring ?? []).filter((r) => matches(r, filter));
  const all = [...oneTime, ...recurring];
  const totals = totalsOf(all);
  // Over-budget rows, surfaced above everything else — see the file header.
  const overRows = all.filter((r) => r.remainingCents < 0);

  if (glance === undefined) return <Screen loading />;

  const nothingAtAll =
    glance.oneTime.length === 0 && glance.recurring.length === 0;
  const nothingMatches = !nothingAtAll && all.length === 0;

  return (
    <Screen maxWidth={1080}>
      <Narrow>
        <View className="mb-1">
          <Text className="font-display text-2xl text-ink">Budgets</Text>
        </View>
        <Text className="mb-4 text-sm text-muted">
          What&apos;s been spent and how much room is left, per budget — so you
          don&apos;t have to ask before you swipe. Tap any budget to see the
          charges behind the number. Live, read-only, same numbers the finance
          team sees.
        </Text>

        {nothingAtAll ? (
          <EmptyState
            icon="pie-chart"
            title="No budgets to show yet"
            message="Approved budgets for this year show up here with their spend and room left."
          />
        ) : (
          <>
            <TotalsStrip totals={totals} />

            <View className="mb-4">
              <TextField
                label="Find a budget"
                value={filter}
                onChangeText={setFilter}
                placeholder="Search by name…"
              />
            </View>

            {nothingMatches ? (
              <EmptyState
                icon="search"
                title="No budget matches that"
                message="Try a shorter search, or clear it to see everything again."
              />
            ) : (
              <View className="gap-6">
                {/* Over budget first — the only genuinely urgent thing here,
                    and previously buried in date order somewhere below. Rows
                    still appear in their own section too, so nothing is moved
                    OUT of the place a reader learned to look for it. */}
                {overRows.length > 0 ? (
                  <View>
                    <SectionHeader title="Over budget" count={overRows.length} />
                    <View className="gap-2.5">
                      {overRows.map((row) => (
                        <BudgetGlanceCard key={`over-${row.id}`} row={row} />
                      ))}
                    </View>
                  </View>
                ) : null}

                {oneTime.length > 0 ? (
                  <View>
                    <SectionHeader
                      title="Events & projects"
                      count={oneTime.length}
                    />
                    <View className="gap-2.5">
                      {oneTime.map((row) => (
                        <BudgetGlanceCard key={row.id} row={row} />
                      ))}
                    </View>
                  </View>
                ) : null}

                {recurring.length > 0 ? (
                  <View>
                    <SectionHeader title="Recurring" count={recurring.length} />
                    <View className="gap-2.5">
                      {recurring.map((row) => (
                        <BudgetGlanceCard key={row.id} row={row} />
                      ))}
                    </View>
                  </View>
                ) : null}
              </View>
            )}
          </>
        )}
      </Narrow>
    </Screen>
  );
}
