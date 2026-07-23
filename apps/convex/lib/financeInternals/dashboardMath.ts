import { Doc, Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import { quarterOfMonth, easternParts } from "@events-os/shared";
import {
  effectiveCapCents,
  effectiveType,
  effectiveRefKind,
  budgetDisplayName,
  txnCountsTowardBudget,
} from "./budgetCore";
import { isSpend, inPeriod } from "./txnGuards";

/**
 * The dashboard's selected period. `month` is always the THROUGH-month (the one
 * the stepper selects). In `"month"` mode the dashboard reports only that month;
 * in `"ytd"` mode it reports the cumulative Jan..throughMonth range of the year.
 * Every spend/actual aggregation reads this so the two modes stay in lock-step.
 */
// `PeriodMode` is unused dead code (never referenced elsewhere) — moved as-is,
// no-behavior-change rule.
export type PeriodMode = "month" | "ytd";
export type DashPeriod = { year: number; month: number; ytd: boolean };

/** True iff a timestamp falls in the dashboard's period: one month, or Jan..throughMonth (YTD). */
export function inDashRange(postedAt: number, dp: DashPeriod): boolean {
  const p = easternParts(postedAt);
  if (p.year !== dp.year) return false;
  if (!dp.ytd) return p.month === dp.month;
  return p.month >= 1 && p.month <= dp.month;
}

/**
 * The YTD window for a budget's spend: the txn is in the budget's year, on or
 * before the through-month, and honors the budget's OWN fixed narrowers (a
 * fixed-month or fixed-quarter budget only matches its month/quarter). This
 * widens the single-month/quarter window that `budgetEffectivePeriod` +
 * `inPeriod` apply in month mode to the cumulative 1..throughMonth range for
 * period-scoped (month-null / quarter-null / yearly) budgets, without ever
 * double-counting a fixed-period budget.
 */
function inYtdBudgetWindow(postedAt: number, b: Doc<"budgets">, throughMonth: number): boolean {
  const p = easternParts(postedAt);
  if (p.year !== b.year) return false;
  if (p.month > throughMonth) return false;
  if (b.month != null && p.month !== b.month) return false;
  if (b.quarter != null && quarterOfMonth(p.month) !== b.quarter) return false;
  return true;
}

/**
 * The single budget-attribution rule, period-aware for the dashboard: in
 * `"month"` mode it defers to `txnCountsTowardBudget` (unchanged); in `"ytd"`
 * mode it keeps the exact same `isSpend` gate + explicit `budgetId` link but
 * widens the period window to Jan..throughMonth (`inYtdBudgetWindow`).
 */
export function txnCountsTowardBudgetDash(
  tr: Doc<"transactions">,
  b: Doc<"budgets">,
  dp: DashPeriod,
): boolean {
  if (!dp.ytd) return txnCountsTowardBudget(tr, b, dp.month);
  if (!isSpend(tr) || tr.budgetId !== b._id) return false;
  return inYtdBudgetWindow(tr.postedAt, b, dp.month);
}

/**
 * Whether a txn's spend counts toward a budget for a By-tag AGGREGATE (tag
 * rollups + the tag drill-down) — NOT the same rule as `txnCountsTowardBudgetDash`,
 * which is deliberately CARD-shaped: for a budget with its OWN declared
 * `month`/`quarter` (e.g. an event budget stamped to May at creation), it
 * narrows `inPeriod` to THAT fixed month/quarter regardless of `dp` — correct
 * for a card, whose own bar reports on the budget's declared period no matter
 * which month you're viewing, but wrong for an AGGREGATE: a July charge on a
 * May-fixed budget would never count toward July's tag total (it only matches
 * May), while that same May charge would count toward EVERY month's tag total
 * including July (nothing in the check compares against `dp` at all once
 * `b.month` is set). That's the mis-scoping bug — a tag's "by month" total
 * silently tracked the budget's own fixed month instead of the viewed one, so
 * a July dashboard could show May's spend under "Events" while missing July's.
 *
 * A tag AGGREGATE needs the opposite rule: sum whatever this budget's linked
 * spend actually POSTED in the dashboard's OWN period (`inDashRange`), full
 * stop — ignoring the budget's own month/quarter narrowers entirely. This is
 * also what keeps a 12-month sum of a tag's aggregate exactly equal to its
 * whole-year (YTD) total: every linked spend txn is posted in exactly one
 * month, so it's counted in exactly one month's aggregate, never dropped or
 * double-counted regardless of which month the underlying budget declares.
 */
export function txnCountsTowardTagAgg(
  tr: Doc<"transactions">,
  b: Doc<"budgets">,
  dp: DashPeriod,
): boolean {
  return isSpend(tr) && tr.budgetId === b._id && inDashRange(tr.postedAt, dp);
}

/** Is a recurring budget active anywhere in the dashboard period (any month for YTD)? */
export function recurringAppliesToDash(b: Doc<"budgets">, dp: DashPeriod): boolean {
  if (!dp.ytd) return recurringAppliesToMonth(b, dp.year, dp.month);
  for (let m = 1; m <= dp.month; m++) {
    if (recurringAppliesToMonth(b, dp.year, m)) return true;
  }
  return false;
}

/** Is a recurring budget active for the dashboard's {year, month}? */
function recurringAppliesToMonth(
  b: Doc<"budgets">,
  year: number,
  month: number,
): boolean {
  if (b.year !== year) return false;
  if (b.month != null && b.month !== month) return false;
  if (b.quarter != null && quarterOfMonth(month) !== b.quarter) return false;
  return true;
}

/**
 * DASH-2.1 (bug 2): a recurring budget's YTD denominator, cadence-aware — NOT
 * a per-month sum (see `monthEquivForDash`'s doc comment for why the naive
 * per-month sum is wrong for `quarterly`/`yearly`). Only reached for
 * `b.year === dp.year` in `"ytd"` mode by a genuinely recurring cadence
 * (`monthly`/`quarterly`/`yearly` — `effectiveType(b) !== "recurring"` budgets
 * never reach `monthEquivForDash`'s ytd branch at all, so `per_instance`/
 * `one_off` never hit this function).
 *
 * Owner rule (the exact bug report): "$978.78/$1,000 · 98%" for a YEARLY
 * budget stayed identical from Feb through Apr because the OLD denominator
 * was `capCents/12 * monthsElapsed` (a calendar pot prorated as if it were a
 * monthly allowance) — by April that's `$1,000/12×5 = $416.65`, so genuine
 * cumulative spend of $978.78 reads as "235% · Over", which is absurd for a
 * POT that's fully available the whole year. Fixed semantics, mirroring
 * `monthly`'s (unchanged, already-correct) "cap × months elapsed":
 *  - `monthly`   → cap × months elapsed (unchanged, falls through below).
 *  - `quarterly` → cap × QUARTERS elapsed (`Math.ceil(throughMonth / 3)`,
 *    the same "the current, in-progress period's full cap is already
 *    counted" rule `monthly` uses — by May, Q1 is fully elapsed AND Q2 has
 *    started, so 2 quarters' worth is due, not 5/3). A budget fixed to ONE
 *    specific quarter (`b.quarter` set) instead gets its cap once that
 *    quarter has started, 0 before it — never a fractional quarter.
 *  - `yearly`    → the FULL cap, unconditionally — a yearly budget is a pot
 *    available all year, not something that accrues month by month.
 */
function ytdCadenceAllocationCents(b: Doc<"budgets">, dp: DashPeriod): number | null {
  const capCents = effectiveCapCents(b);
  if (b.cadence === "yearly") return capCents;
  if (b.cadence === "quarterly") {
    if (b.quarter != null) {
      const quarterStartMonth = (b.quarter - 1) * 3 + 1;
      return quarterStartMonth <= dp.month ? capCents : 0;
    }
    const quartersElapsed = Math.ceil(dp.month / 3);
    return capCents * quartersElapsed;
  }
  // `monthly` (and any other cadence that reaches here) falls through to the
  // caller's unchanged per-month-sum loop.
  return null;
}

/**
 * A budget's month-equivalent allocation for the dashboard period: one month in
 * `"month"` mode (identical to `monthEquivalentBudgetCents` — a deliberately
 * DIFFERENT, comparison-normalized semantic from this function's own YTD
 * branch, used e.g. by the central chapter roll-up to compare one month of
 * mixed-cadence budgets; see that function's doc comment), or the cadence-aware
 * YTD allocation in `"ytd"` mode (`ytdCadenceAllocationCents` for
 * `quarterly`/`yearly` — DASH-2.1 bug 2; the sum across months 1..throughMonth
 * for `monthly`/`per_instance`/`one_off`, UNCHANGED — "spent vs allocated"
 * stays comparable when spend is accumulated YTD).
 */
export function monthEquivForDash(b: Doc<"budgets">, dp: DashPeriod): number {
  if (!dp.ytd) return monthEquivalentBudgetCents(b, dp.year, dp.month);
  if (b.year === dp.year) {
    const cadenceAllocation = ytdCadenceAllocationCents(b, dp);
    if (cadenceAllocation != null) return cadenceAllocation;
  }
  let sum = 0;
  for (let m = 1; m <= dp.month; m++) sum += monthEquivalentBudgetCents(b, dp.year, m);
  return sum;
}

/**
 * A budget's allocation NORMALIZED to one month, so a single month of actual
 * spend compares apples-to-apples: monthly → full amount, quarterly → ÷3,
 * yearly → ÷12, per-instance / one-off → the full amount only when the budget's
 * own period includes this month (else 0). Used by the central chapter roll-up
 * to avoid comparing one month of spend against a full year of mixed budgets.
 * Normalizes the EFFECTIVE cap (B1 — `effectiveCapCents`), never the raw
 * `amountCents`, so the org-wide rollup can't advertise an unapproved increase
 * either.
 */
function monthEquivalentBudgetCents(
  b: Doc<"budgets">,
  year: number,
  month: number,
): number {
  if (b.year !== year) return 0;
  if (b.quarter != null && quarterOfMonth(month) !== b.quarter) return 0;
  const capCents = effectiveCapCents(b);
  switch (b.cadence) {
    case "monthly":
      if (b.month != null && b.month !== month) return 0;
      return capCents;
    case "quarterly":
      return Math.round(capCents / 3);
    case "yearly":
      return Math.round(capCents / 12);
    case "per_instance":
    case "one_off":
    default:
      if (b.month != null && b.month !== month) return 0;
      return capCents;
  }
}

/**
 * A recurring/tag budget's ALLOCATION for the dashboard period. Month mode keeps
 * the EFFECTIVE cap (B1 — `effectiveCapCents`, never the raw `amountCents`, so a
 * pending unapproved increase is never advertised); YTD sums the per-month
 * allocation across months 1..throughMonth (per-period budgets scale, a fixed
 * one_time lump does not). Feeds the recurring cards' + tag rollups' +
 * central cards' `budgetCents`.
 */
export function budgetAllocationForDash(b: Doc<"budgets">, dp: DashPeriod): number {
  if (!dp.ytd) return effectiveCapCents(b);
  if (effectiveType(b) !== "recurring") return effectiveCapCents(b);
  return monthEquivForDash(b, dp);
}

/**
 * A budget's ALLOCATION for a By-tag AGGREGATE (tag rollups + the tag
 * drill-down) — `budgetAllocationForDash` (above) is CARD-shaped: in month
 * mode it hands back a one-time budget's full effective cap unconditionally,
 * with no check that the budget is even relevant to the viewed month. That's
 * fine for the one-time CARD itself (its OWN visibility is separately
 * month-gated by `oneTimeCardAppliesToDash`, and once visible its bar is
 * deliberately lifetime-cumulative — see `oneTimeCardBreakdown`'s doc
 * comment), but an AGGREGATE has no per-budget visibility gate of its own: it
 * just sums `budgetAllocationForDash` over every budget carrying the tag, so
 * an irrelevant month's one-time cap silently inflated the denominator (a
 * June $500 + July $1,000 same-tag pair made BOTH months' tag row report
 * against $1,500). This reuses `oneTimeCardAppliesToDash`'s existing
 * relevance rule (own month matches / linked ref date in month / spend
 * posted that month) as a GATE on the allocation itself, rather than forking
 * a third relevance rule: a one-time budget's allocation counts toward a
 * tag's month-mode denominator only when it's relevant to that month, exactly
 * mirroring when its own card would be visible. YTD/year mode is unchanged
 * (matches `oneTimeCardAppliesToDash`'s `dp.ytd` early return — every
 * one-time budget counts, full stop). A recurring budget's
 * `budgetAllocationForDash` is already period-correct via `monthEquivForDash`
 * — this passes it through unconditionally, so this function is a strict
 * narrowing of `budgetAllocationForDash`, never a wider figure.
 */
export function tagAllocationForDash(
  b: Doc<"budgets">,
  dp: DashPeriod,
  refDate: number | null,
  relevantTxns: Doc<"transactions">[],
): number {
  if (effectiveType(b) === "one_time" && !oneTimeCardAppliesToDash(b, dp, refDate, relevantTxns)) {
    return 0;
  }
  return budgetAllocationForDash(b, dp);
}

/**
 * WP-wave4 (item 2 — ref name/date sync): a one_time budget's LIVE display
 * fields, resolved from its linked event/project at READ TIME rather than a
 * stale mirrored `budget.label` — a rename or date change on the ref follows
 * everywhere this is called without a separate write-through step. `name` is
 * the ref's current `name` (event or project); `dateLabel`/`refDate` are the
 * event's `eventDate`, or the project's `deadline` (a project with no
 * deadline gets no date claim — see `forPickerOptions`'s "NO FABRICATED
 * DATES" doc comment for why `startDate`/`createdAt` are never substituted).
 * Falls back to the budget's OWN stored `label`/type-word
 * (`budgetDisplayName`) when the budget carries no ref, OR the ref has
 * vanished (a deleted event/project doesn't cascade to its budget) — the
 * fallback is never a raw "null"/blank card.
 *
 * The SINGLE resolver for every dashboard/tag/picker surface that shows a
 * one-time budget's name (`dashboardChapter`'s one-time cards,
 * `dashboardCentral`'s central one-time cards, `tagDrilldown`'s budget rows)
 * — before this, `dashboardChapter` had its own inline copy and
 * `dashboardCentral`/`tagDrilldown` didn't resolve live refs at all (still
 * exposing the stale stored `label`). `getEvent`/`getProject` are the
 * caller's own `nameCache`s (bounded read-through caches), so repeat lookups
 * of the same ref — a budget can carry more than one tag, or appear under
 * more than one call site in a single query — cost no extra reads.
 *
 * `live` (review fix — dead-link parity): true only when a ref was actually
 * resolved from a real event/project doc, false for the no-ref AND the
 * vanished-ref fallback alike (`events.remove` doesn't cascade to a linked
 * budget, so a deleted event's budget keeps a dead `scopeRefId` forever).
 * Callers that offer an "open ref" link (`oneTimeBudgets`/`centralBudgets`
 * cards) gate `refKind`/`scopeRefId` on this — never show a link for a ref
 * that doesn't (or no longer) resolves, same rule `dashboardChapter`'s
 * `codedTo.refKind` already applies to the recent-transactions digest.
 */
export async function resolveBudgetRef(
  b: Doc<"budgets">,
  getEvent: (id: Id<"events">) => Promise<Doc<"events"> | null>,
  getProject: (id: Id<"projects">) => Promise<Doc<"projects"> | null>,
): Promise<{ name: string; dateLabel: string | null; refDate: number | null; live: boolean }> {
  const refKind = effectiveRefKind(b);
  if (refKind === "event" && b.scopeRefId) {
    const ev = await getEvent(b.scopeRefId as Id<"events">);
    if (ev) {
      return {
        name: ev.name,
        dateLabel: easternDateStr(ev.eventDate),
        refDate: ev.eventDate,
        live: true,
      };
    }
  } else if (refKind === "project" && b.scopeRefId) {
    const pr = await getProject(b.scopeRefId as Id<"projects">);
    if (pr) {
      return {
        name: pr.name,
        dateLabel: pr.deadline ? easternDateStr(pr.deadline) : null,
        refDate: pr.deadline ?? pr.startDate ?? null,
        live: true,
      };
    }
  }
  return { name: budgetDisplayName(b), dateLabel: null, refDate: null, live: false };
}

/**
 * Resolve a one-time budget's linked event/project ref date alone, for
 * relevance checks that don't need the display name (`tagAllocationForDash`'s
 * gate, consulted by the tag rollups) — a thin wrapper over
 * `resolveBudgetRef` so those call sites don't build a name/dateLabel string
 * they never use.
 */
export async function refDateForBudget(
  b: Doc<"budgets">,
  getEvent: (id: Id<"events">) => Promise<Doc<"events"> | null>,
  getProject: (id: Id<"projects">) => Promise<Doc<"projects"> | null>,
): Promise<number | null> {
  return (await resolveBudgetRef(b, getEvent, getProject)).refDate;
}

/** `YYYY-MM-DD` in America/New_York (the finance timezone). */
export function easternDateStr(ts: number): string {
  return new Date(ts).toLocaleDateString("en-CA", {
    timeZone: "America/New_York",
  });
}

/**
 * Integer percent spent-of-budget. An unfunded budget (`budget <= 0`, e.g. a
 * $0/never-approved cap) with real spend against it is NOT "0% spent" —
 * that reads as healthy when it's actually unfunded overspend — so it reports
 * 100 (the client's `BudgetBar` already goes danger-red at `pct >= 100`,
 * purely off this field — no separate "over" status is needed). An unfunded
 * budget with NO spend yet stays a quiet 0 (nothing wrong to flag yet).
 */
export function pctOf(spent: number, budget: number): number {
  if (budget <= 0) return spent > 0 ? 100 : 0;
  return Math.round((spent / budget) * 100);
}

/**
 * A budget is "warn" once ≥80% spent, else "ok". There is no separate "over"
 * literal — an unfunded-and-overspent budget already reports `pct: 100` (see
 * `pctOf`), which is ≥80 ("warn") AND trips the client `BudgetBar`'s own
 * `pct >= 100` danger-red rule, so the loud state is carried by `pct` alone.
 */
export function statusFor(pct: number): "ok" | "warn" {
  return pct >= 80 ? "warn" : "ok";
}

/** A capped 0–100 bar percentage for a part of a whole. */
export function barPctOf(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.min(100, Math.round((part / whole) * 100));
}

/** Sum the SPEND amount of a list of transactions. */
export function sumSpend(txns: Doc<"transactions">[]): number {
  return txns.reduce((s, tr) => (isSpend(tr) ? s + tr.amountCents : s), 0);
}

/** Shared spend + per-category breakdown body for an already-narrowed list of
 *  a budget's matching transactions — factored out of `budgetSpendBreakdown`
 *  so `oneTimeCardBreakdown` (a DIFFERENT period narrowing, see below) doesn't
 *  duplicate the category-grouping/bar-normalizing logic. */
function spendBreakdownFor(
  b: Doc<"budgets">,
  matching: Doc<"transactions">[],
  catName: Map<Id<"budgetCategories">, string>,
): {
  spentCents: number;
  categories: { name: string; spentCents: number; barPct: number }[];
} {
  const spentCents = matching.reduce((s, tr) => s + tr.amountCents, 0);
  const byCat = new Map<string, number>();
  for (const tr of matching) {
    const key = tr.categoryId ? catName.get(tr.categoryId) ?? "Uncategorized" : "Uncategorized";
    byCat.set(key, (byCat.get(key) ?? 0) + tr.amountCents);
  }
  // B1: the mini category bars normalize against the EFFECTIVE cap too, not
  // the raw (possibly pending-increase) `amountCents`.
  const capCents = effectiveCapCents(b);
  const denom = capCents > 0 ? capCents : spentCents;
  const categories = [...byCat.entries()]
    .sort((a, c) => c[1] - a[1])
    .map(([name, cents]) => ({
      name,
      spentCents: cents,
      barPct: barPctOf(cents, denom),
    }));
  return { spentCents, categories };
}

/**
 * The spent total + per-category breakdown for one budget, from an already-
 * loaded year of transactions. `catName` resolves category ids to names. `dp`
 * scopes recurring (monthly/quarterly) budgets to the dashboard's period: a
 * single month (so a "$2,000/mo" budget reports one month's spend) in month
 * mode, or the cumulative Jan..throughMonth range in YTD mode. Also used for
 * MONTH-MODE AGGREGATES that fold in one-time budgets (tag rollups, central
 * budget cards) — those must NOT double-count a month-less one-time budget's
 * spend into every month, which `txnCountsTowardBudgetDash` now guards via
 * `budgetEffectivePeriod`'s `contextMonth` fallback. The one-time dashboard
 * CARD itself does NOT use this — see `oneTimeCardBreakdown`.
 */
export function budgetSpendBreakdown(
  b: Doc<"budgets">,
  yearTxns: Doc<"transactions">[],
  catName: Map<Id<"budgetCategories">, string>,
  dp: DashPeriod,
): {
  spentCents: number;
  categories: { name: string; spentCents: number; barPct: number }[];
} {
  const matching = yearTxns.filter((tr) => txnCountsTowardBudgetDash(tr, b, dp));
  return spendBreakdownFor(b, matching, catName);
}

/**
 * DASH-2.1 (bug 1): a recurring budget's spend in the dashboard's SELECTED
 * MONTH specifically (`dp.year`/`dp.month`) — regardless of the budget's own
 * cadence or the dashboard's period mode (month vs YTD). Feeds the recurring
 * card's new `periodSpendCents` field, from `yearTxns` already loaded for the
 * dashboard (no extra scan).
 *
 * For a `monthly` cadence card in month mode this is identical to
 * `spentCents` (`budgetSpendBreakdown`'s own cumulative figure already IS one
 * month — see its doc comment). The gap this closes is `quarterly`/`yearly`:
 * `budgetSpendBreakdown` in month mode widens to the whole quarter/year (via
 * `budgetEffectivePeriod`), so a yearly bucket's `spentCents` reads as the
 * SAME cumulative number in every month of the year (the exact owner report —
 * "$978.78/$1,000 · 98%" unchanged from Feb through Apr). This function
 * narrows to the one calendar month regardless.
 */
export function monthOnlySpendCentsForBudget(
  b: Doc<"budgets">,
  yearTxns: Doc<"transactions">[],
  dp: DashPeriod,
): number {
  let sum = 0;
  for (const tr of yearTxns) {
    if (tr.budgetId !== b._id || !isSpend(tr)) continue;
    if (inPeriod(tr.postedAt, dp.year, dp.month)) sum += tr.amountCents;
  }
  return sum;
}

/**
 * A one-time budget CARD's own actuals — genuinely LIFETIME, not just
 * un-sliced from the dashboard's viewed month: an event/project budget is a
 * total plan, not a per-month allocation, so its own bar/pct/remaining must
 * stay stable as the viewer steps through months — only the card's
 * VISIBILITY is month-gated (see `oneTimeCardAppliesToDash`), never its own
 * numbers. Matches purely on the explicit `budgetId` link + `isSpend` — the
 * SAME no-period rule `actualsForRef` (`eventActuals`/`projectActuals`) uses
 * — deliberately bypassing `budgetEffectivePeriod`/`txnCountsTowardBudget`
 * entirely, so a budget WITH a stored `month`/`quarter` no longer narrows the
 * card to just that period either (an earlier version of this fix still
 * applied the budget's own declared month, which left a coherence gap: a
 * fixed-month budget's card could be made VISIBLE in an off month by an
 * out-of-period charge — `oneTimeCardAppliesToDash`'s "has spend this month"
 * signal — while its own bar still reported $0, hiding the very charge that
 * made it show up; matching `actualsForRef`'s rule closes that gap).
 */
export function oneTimeCardBreakdown(
  b: Doc<"budgets">,
  yearTxns: Doc<"transactions">[],
  catName: Map<Id<"budgetCategories">, string>,
): {
  spentCents: number;
  categories: { name: string; spentCents: number; barPct: number }[];
} {
  const matching = yearTxns.filter((tr) => tr.budgetId === b._id && isSpend(tr));
  return spendBreakdownFor(b, matching, catName);
}

/**
 * True iff a one-time budget CARD belongs on the dashboard for the viewed
 * period (Bug 1a — one-time budgets used to render on EVERY month regardless
 * of relevance, e.g. a May event budget showing up in July). YTD/year mode
 * always shows every one-time card (unchanged). Month mode shows a card only
 * when it's actually relevant to THAT month:
 *  - a resolvable `refDate` (the linked event/project's real date) DECIDES
 *    relevance on its own — budget identity & dates fix: this used to be
 *    OR'd with the stored `month` check below, so a budget whose stored
 *    `month` happened to match the viewed month (e.g. its CREATION month,
 *    before the write-through sync existed) would short-circuit true even
 *    when its entity's real date said otherwise — a March-due project's card
 *    could show up in July just because that's when someone entered its
 *    budget. Now the stored `month` is a FALLBACK, consulted only when there
 *    is no `refDate` to resolve (a budget with no ref, or whose ref has
 *    vanished);
 *  - OR it already has spend posted in that month (covers a month-less
 *    budget with real activity this month even before either signal above
 *    applies) — unaffected by this fix, still an independent OR.
 */
export function oneTimeCardAppliesToDash(
  b: Doc<"budgets">,
  dp: DashPeriod,
  refDate: number | null,
  yearTxns: Doc<"transactions">[],
): boolean {
  if (dp.ytd) return true;
  if (refDate != null) {
    if (inPeriod(refDate, dp.year, dp.month)) return true;
  } else if (b.month != null && b.month === dp.month) {
    return true;
  }
  return yearTxns.some(
    (tr) => tr.budgetId === b._id && isSpend(tr) && inPeriod(tr.postedAt, dp.year, dp.month),
  );
}

/** A tiny read-through name cache for a table's display name. */
export function nameCache<
  T extends
    | "events"
    | "projects"
    | "people"
    | "cards"
    | "eventTypes"
    | "funds"
    | "budgetCategories"
    | "budgets",
>(
  ctx: QueryCtx,
  table: T,
) {
  const cache = new Map<string, Doc<T> | null>();
  return async (id: Id<T>): Promise<Doc<T> | null> => {
    const hit = cache.get(id);
    if (hit !== undefined) return hit;
    const doc = (await ctx.db.get(id)) as Doc<T> | null;
    cache.set(id, doc);
    return doc;
  };
}
