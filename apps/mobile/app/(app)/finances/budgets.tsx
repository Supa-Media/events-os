/**
 * FINANCES · BUDGETS — "budgets at a glance", readable by EVERY team member.
 *
 * The FM's top ask: cardholders should see "this is how much has been spent
 * on X and how much room is left" without asking her. Backed by
 * `api.finances.budgetsGlance` — the one finance read that is DELIBERATELY not
 * finance-role gated (membership only, read-only), so this screen needs none
 * of the seat/boundary scaffolding the other finance tabs carry.
 *
 * WHOSE SCREEN THIS IS. The cardholder's, not the treasurer's. There are ~16
 * of the former and one of the latter, and the question being answered is
 * "have I got room on the thing I'm about to swipe for" — which is why the
 * default view is THIS YEAR, expanded, in agenda order. The treasurer has a
 * dashboard.
 *
 * ── ONE YEAR PER PAGE, ONE BOOK AT A TIME (founder, 2026-08-14) ─────────────
 * "Maybe budgets should be shown year by year, so every year is a new page,
 * and then some type of dropdown to select the book/chapter — all, central,
 * NYC."
 *
 * That instruction arrived after the query was widened from one year to every
 * year the chapter has ever had, which turned this screen into a flat list of
 * everything with an over-budget block bolted on top — and a 2024 overage
 * shouting at somebody who opened the tab to check 2026. Four things follow:
 *
 *  1. THE PAGE IS A YEAR. A stepper picks it; the list shows that year and
 *     nothing else. "Still load everything" stays true — every year is loaded,
 *     which is where the picker's own options come from — the page just
 *     renders one.
 *  2. THE PAGE IS A BOOK. A picker chooses it, and it only appears for a
 *     caller who actually holds more than one (`budgetsGlanceScopes` computes
 *     that server-side from real reach). A member sees no picker and exactly
 *     what they saw before.
 *  3. THE OVER-BUDGET SECTION IS GONE, replaced by a filter chip. It rendered
 *     its rows and then the list below rendered them AGAIN — the same three
 *     budgets twice on one screen, with both headers counting them. A filter
 *     cannot duplicate anything.
 *  4. THE TOTALS STRIP DESCRIBES THE PAGE — see below for what that came to
 *     mean, and what it now means instead.
 *
 * ── ONE HEADLINE, ANNUALISED (founder, 2026-08-14) ──────────────────────────
 * "The numbers do not add up… Love Thy Neighbor 5,000, Field Day 2,000, that's
 * 7,000 already. The operating expenses alone is 500 a month, so this year
 * that's 6,000 dollars. We're not adding up all the budgeted items, and same
 * thing for how much we spent. The top is just false."
 *
 * This screen got that wrong TWICE, in opposite directions, and both attempts
 * are worth remembering because the second looked like a fix.
 *
 * FIRST the strip summed one-time caps (lifetime plans) and recurring caps
 * (one cadence window) into a single figure — genuinely meaningless. That was
 * removed, leaving the strip covering one-time budgets only: honest about its
 * own arithmetic, but a headline that silently meant "some of your budgets"
 * while looking like "your budgets".
 *
 * SECOND came a separate per-cadence strip over the recurring section. It also
 * refused to convert, so it just restated the cards underneath it — every
 * figure in it was already on screen two inches below.
 *
 * The actual answer is that THE PAGE IS ALREADY A YEAR, so the year is the
 * common unit and the caps should be CONVERTED, not dropped and not walled
 * off. A $500-a-month bucket is $6,000 committed for 2026, the same kind of
 * number as a $5,000 event cap. One strip, every budget in it. Spend is never
 * annualised — see `annualBudgetTotals.ts`, which owns the arithmetic and the
 * projection trap underneath it.
 *
 * Search still matches the event's own name (`refName`) as well as the title,
 * because titles are template-derived now and typing what you actually called
 * the event otherwise found nothing. It searches WITHIN the chosen year and
 * book, like every other control here — a search that silently jumped years
 * would make the year picker a lie.
 *
 * RECURRING buckets only appear on the CURRENT year's page. Their cap governs
 * a cadence window (this month / quarter), and a past year has no live window
 * to report against; showing "$0.00 of $500.00" for 2024's coffee budget would
 * be worse than absent. Said out loud on the page rather than left as a gap.
 */
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import { formatCents } from "@events-os/shared";
import {
  EmptyState,
  FilterSelect,
  Icon,
  Narrow,
  Pill,
  Screen,
  SectionHeader,
  TextField,
} from "../../../components/ui";
import { colors } from "../../../lib/theme";
import { BudgetGlanceCard } from "../../../components/finance/budgets/BudgetGlanceCard";
import { annualBudgetTotals } from "../../../components/finance/budgets/annualBudgetTotals";

type Glance = FunctionReturnType<typeof api.finances.budgetsGlance>;
type GlanceRow = Glance["oneTime"][number];

/** The row filters. `warn` reuses the server's own 80%-of-cap threshold
 *  (`statusFor`), so "nearly out" means the same thing here as on the meter. */
type FilterKey = "all" | "over" | "warn";
const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "over", label: "Over budget" },
  { key: "warn", label: "Nearly out" },
];

function matchesFilter(row: GlanceRow, filter: FilterKey): boolean {
  if (filter === "over") return row.remainingCents < 0;
  if (filter === "warn") return row.status === "warn" && row.remainingCents >= 0;
  return true;
}

/** Case-insensitive match on the display title OR the event/project's own
 *  name — since titles became template-derived, the second is often what
 *  somebody actually remembers typing. */
function matchesSearch(row: GlanceRow, needle: string): boolean {
  if (!needle) return true;
  const q = needle.toLowerCase();
  return (
    row.name.toLowerCase().includes(q) ||
    (row.refName?.toLowerCase().includes(q) ?? false)
  );
}

/**
 * Agenda order for the CURRENT year: what's coming up first (soonest first),
 * then what's already happened (most recent first), then anything dateless.
 *
 * A cardholder opening this tab is usually about to spend on something ahead
 * of them, so strict newest-first buries the useful half under a year of
 * history. Past years keep plain descending — nothing there is upcoming.
 */
function sortCurrentYear(rows: GlanceRow[], now: number): GlanceRow[] {
  const upcoming = rows
    .filter((r) => r.refDate != null && r.refDate >= now)
    .sort((a, b) => (a.refDate ?? 0) - (b.refDate ?? 0));
  const past = rows
    .filter((r) => r.refDate != null && r.refDate < now)
    .sort((a, b) => (b.refDate ?? 0) - (a.refDate ?? 0));
  const undated = rows
    .filter((r) => r.refDate == null)
    .sort((a, b) => a.name.localeCompare(b.name));
  return [...upcoming, ...past, ...undated];
}

function sortPastYear(rows: GlanceRow[]): GlanceRow[] {
  return [...rows].sort((a, b) => {
    if ((a.refDate == null) !== (b.refDate == null)) return a.refDate == null ? 1 : -1;
    return (b.refDate ?? 0) - (a.refDate ?? 0);
  });
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

/**
 * THE YEAR'S HEADLINE — every budget on the page, one-time and standing alike.
 *
 * Counts BOTH sections. A standing bucket's cap is annualised first (a
 * $500-a-month bucket is $6,000 committed for the year); its spend is not,
 * because spend is money that already moved. `annualBudgetTotals` owns that
 * arithmetic and the reasoning behind it.
 */
function TotalsStrip({
  rows,
  recurringRows,
  year,
}: {
  rows: GlanceRow[];
  recurringRows: GlanceRow[];
  year: number;
}) {
  const totals = annualBudgetTotals([...rows, ...recurringRows]);
  const over = totals.remainingCents < 0;
  return (
    <View className="mb-4 rounded-lg border border-border bg-raised p-3 shadow-card">
      <View className="mb-2 flex-row flex-wrap items-baseline gap-2">
        <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
          {year} · all budgets
        </Text>
        <Text className="text-2xs text-faint">
          {totals.count === 1 ? "1 budget" : `${totals.count} budgets`}
        </Text>
      </View>
      <View className="flex-row flex-wrap gap-3">
        <Stat label="Budgeted" value={formatCents(totals.capCents)} />
        <Stat label="Spent" value={formatCents(totals.spentCents)} />
        <Stat
          label={over ? "Over by" : "Left"}
          value={formatCents(Math.abs(totals.remainingCents))}
          tone={over ? "danger" : "success"}
        />
      </View>
      {recurringRows.length > 0 ? (
        // Say the conversion out loud. Without this the reader can't reconcile
        // the headline against the cards — a $500 bucket contributes $6,000
        // here and prints "$500.00 this month" below, and an unexplained gap
        // in a money figure reads as a bug (which is how this one was found).
        <Text className="mt-2 text-2xs text-faint">
          Standing budgets counted at their full-year amount.
        </Text>
      ) : null}
    </View>
  );
}

/** ‹ 2026 › — the page selector. Only offers years the data actually has, so
 *  stepping can never land on an empty page that looks like a bug. */
function YearStepper({
  year,
  years,
  onChange,
}: {
  year: number;
  years: number[];
  onChange: (next: number) => void;
}) {
  const index = years.indexOf(year);
  const older = index >= 0 && index < years.length - 1 ? years[index + 1] : null;
  const newer = index > 0 ? years[index - 1] : null;
  return (
    <View className="flex-row items-center gap-1 rounded-pill border border-border bg-raised px-1 py-0.5">
      <Pressable
        onPress={() => older != null && onChange(older)}
        disabled={older == null}
        accessibilityRole="button"
        accessibilityLabel={older != null ? `Show ${older}` : "No earlier years"}
        className={`px-2 py-1 ${older == null ? "opacity-30" : "active:opacity-70"}`}
      >
        <Icon name="chevron-left" size={16} color={colors.muted} />
      </Pressable>
      <Text
        className="min-w-[52px] text-center text-sm font-semibold text-ink"
        style={{ fontVariant: ["tabular-nums"] }}
      >
        {year}
      </Text>
      <Pressable
        onPress={() => newer != null && onChange(newer)}
        disabled={newer == null}
        accessibilityRole="button"
        accessibilityLabel={newer != null ? `Show ${newer}` : "No later years"}
        className={`px-2 py-1 ${newer == null ? "opacity-30" : "active:opacity-70"}`}
      >
        <Icon name="chevron-right" size={16} color={colors.muted} />
      </Pressable>
    </View>
  );
}

export default function BudgetsGlanceScreen() {
  const [year, setYear] = useState<number | null>(null);
  const [scope, setScope] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<FilterKey>("all");
  const now = Date.now();

  // Which books this caller may actually open. Server-computed from real
  // reach: a member gets exactly one entry and never sees the picker.
  const scopes = useQuery(api.finances.budgetsGlanceScopes, {});
  const glance = useQuery(api.finances.budgetsGlance, {
    ...(year != null ? { year } : {}),
    ...(scope != null ? { scope: scope as never } : {}),
  });

  // `?? []` inline would mint a fresh array on every render while the query is
  // in flight, which is a new dependency identity for both memos below — so
  // the fallbacks are memoized on `glance` itself.
  const oneTime = useMemo(() => glance?.oneTime ?? [], [glance]);
  const recurring = useMemo(() => glance?.recurring ?? [], [glance]);
  const viewYear = glance?.year ?? new Date().getFullYear();
  // The server's own Eastern year, never the browser's — see `currentYear`'s
  // validator comment. Defaults to "yes" while the query is in flight so the
  // loading state never briefly renders as a past year's page.
  const isCurrentYear = glance ? viewYear === glance.currentYear : true;

  const rows = useMemo(
    () =>
      oneTime.filter((r) => matchesFilter(r, filter) && matchesSearch(r, search)),
    [oneTime, filter, search],
  );
  const recurringRows = useMemo(
    () =>
      recurring.filter((r) => matchesFilter(r, filter) && matchesSearch(r, search)),
    [recurring, filter, search],
  );

  if (glance === undefined) return <Screen loading />;

  const showScopePicker = (scopes?.length ?? 0) > 1;
  const nothingThisYear = oneTime.length === 0 && recurring.length === 0;

  return (
    <Screen maxWidth={1080}>
      <Narrow>
        <View className="mb-3 flex-row flex-wrap items-center justify-between gap-2">
          <Text className="font-display text-2xl text-ink">Budgets</Text>
          <View className="flex-row flex-wrap items-center gap-2">
            {showScopePicker ? (
              <FilterSelect
                label="Book"
                value={scope ?? scopes![0].key}
                options={scopes!.map((o) => ({ value: o.key, label: o.label }))}
                onChange={(next) => setScope(next || null)}
              />
            ) : null}
            <YearStepper
              year={viewYear}
              years={glance.availableYears}
              onChange={setYear}
            />
          </View>
        </View>
        <Text className="mb-4 text-sm text-muted">
          What&apos;s been spent and how much room is left. Tap any budget to
          see the charges behind the number.
        </Text>

        <View className="mb-3">
          <TextField
            label="Find a budget"
            value={search}
            onChangeText={setSearch}
            placeholder="Search by name…"
          />
        </View>
        <View className="mb-4 flex-row flex-wrap gap-2">
          {FILTERS.map((f) => (
            <Pill
              key={f.key}
              label={f.label}
              selected={filter === f.key}
              onPress={() => setFilter(f.key)}
            />
          ))}
        </View>

        {nothingThisYear ? (
          <EmptyState
            icon="pie-chart"
            title={`No budgets for ${viewYear}`}
            message={
              glance.availableYears.length > 1
                ? "Use the year picker above to look at another year."
                : "Approved budgets show up here with their spend and room left."
            }
          />
        ) : (
          <View className="gap-6">
            <View>
              <TotalsStrip rows={rows} recurringRows={recurringRows} year={viewYear} />
              <SectionHeader
                title="Events & projects"
                count={rows.length || undefined}
              />
              {rows.length === 0 ? (
                <Text className="text-xs text-muted">
                  Nothing in {viewYear} matches this filter.
                </Text>
              ) : (
                <View className="gap-2.5">
                  {(isCurrentYear ? sortCurrentYear(rows, now) : sortPastYear(rows)).map(
                    (row) => (
                      <BudgetGlanceCard key={row.id} row={row} />
                    ),
                  )}
                </View>
              )}
            </View>

            {/* The section ALWAYS renders its header, and always says
                something under it. It used to render only when there were rows
                to show, with the explanatory line gated on a PAST year — so a
                current year with no standing buckets showed literally nothing
                below Events & projects, indistinguishable from the feature not
                existing. Every branch below is a sentence instead of a gap. */}
            <View>
              <SectionHeader
                title="Recurring"
                count={recurringRows.length || undefined}
              />
              {recurringRows.length > 0 ? (
                <View className="gap-2.5">
                  {recurringRows.map((row) => (
                    <BudgetGlanceCard key={row.id} row={row} />
                  ))}
                </View>
              ) : recurring.length > 0 ? (
                // There ARE buckets; the filter or the search box hid them.
                // Same wording the Events & projects section uses.
                <Text className="text-xs text-muted">
                  Nothing in {viewYear} matches this filter.
                </Text>
              ) : !isCurrentYear ? (
                // See the file header on why a past year has no live window.
                <Text className="text-xs text-muted">
                  Recurring budgets are only shown for the current year — their
                  caps cover a month or a quarter, and {viewYear} has none left
                  to report against.
                </Text>
              ) : (
                <Text className="text-xs text-muted">
                  No standing budgets for {viewYear}. These are the buckets that
                  reset every month, quarter, or year — operating expenses,
                  equipment — as opposed to the one-off plans above.
                </Text>
              )}
            </View>
          </View>
        )}
      </Narrow>
    </Screen>
  );
}
