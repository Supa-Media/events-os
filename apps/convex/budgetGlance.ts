/**
 * BUDGETS AT A GLANCE · THE DROP-DOWN — the expense lines behind one budget's
 * number, readable by any chapter member.
 *
 * Founder, 2026-08-14: "the budgeting section leaves a lot to be desired. It
 * just gives an amount. Doesn't give details… we should just be able to drop
 * down and see the different expenses per budget."
 *
 * `finances.budgetsGlance` answers "how much of X is left" for the whole team.
 * It could not answer "left after WHAT", and the only surface that could —
 * `budgetDetail.getBudgetDetail` — is finance-viewer gated, so the ~16
 * volunteers holding cards (exactly the people the glance screen was built
 * for) had no door to it at all. This file is that door: the SAME numbers,
 * one budget at a time, with the charges that produced them.
 *
 * Deliberately a NEW file rather than more surface on `finances.ts`, following
 * `budgetDetail.ts`/`dashboardCharts.ts`'s own precedent — built from
 * `finances.ts`'s EXPORTED primitives (`isSpend`, `effectiveType`,
 * `effectiveCapCents`, `effectiveRefKind`, `isAttributableBudget`,
 * `txnCountsTowardBudget`, `ROLLUP_SCAN_LIMIT`) so the drill-down can never
 * disagree with the card above it about what counts.
 *
 * WINDOWING MATCHES THE CARD, NOT THE DETAIL PAGE. `budgetDetail` deliberately
 * reports LIFETIME spend for its "whole story of this budget" framing; this
 * query is the expansion OF A GLANCE CARD, so it reuses the card's own rule
 * exactly: a one-time (event/project) budget sums every linked charge ever, a
 * recurring bucket narrows to its CURRENT cadence window (this month /
 * quarter / year) via `txnCountsTowardBudget`. Anything else and the lines
 * would visibly fail to add up to the total two pixels above them.
 *
 * Gate: `lib/budgetGlanceAccess.ts#requireBudgetExpenses` — membership today,
 * with a named power reserved for the day it needs restricting (see that
 * file). Refusals degrade to `null`, never a throw, mirroring
 * `budgetsGlance`'s own contract: this screen must never show a member a
 * permission wall.
 */
import { v } from "convex/values";
import { query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import {
  BUDGET_TYPE_LABELS,
  CENTRAL,
  TRANSACTION_FLOWS,
  TRANSACTION_STATUSES,
  easternParts,
} from "@events-os/shared";
import { requireBudgetExpenses } from "./lib/budgetGlanceAccess";
import { getFinanceRole } from "./lib/finance";
import { readSandbox } from "./financeSettings";
import {
  isSpend,
  isAttributableBudget,
  txnMatchesMode,
  txnCountsTowardBudget,
  effectiveCapCents,
  effectiveType,
  effectiveRefKind,
  nameCache,
  ROLLUP_SCAN_LIMIT,
} from "./finances";

/** How many charge lines the drop-down renders. A budget with more says so
 *  ("N of M") and points at the full, finance-gated detail page. */
const GLANCE_LINE_CAP = 50;

const glanceLine = v.object({
  id: v.id("transactions"),
  postedAt: v.number(),
  description: v.union(v.string(), v.null()),
  merchantName: v.union(v.string(), v.null()),
  amountCents: v.number(),
  flow: v.union(...TRANSACTION_FLOWS.map((f) => v.literal(f))),
  status: v.union(...TRANSACTION_STATUSES.map((s) => v.literal(s))),
  categoryName: v.union(v.string(), v.null()),
  personName: v.union(v.string(), v.null()),
  hasReceipt: v.boolean(),
});

const glanceCategory = v.object({
  name: v.string(),
  spentCents: v.number(),
  barPct: v.number(),
});

const budgetLinesResult = v.object({
  id: v.id("budgets"),
  /** The linked event/project's name when live, else the budget's own label. */
  name: v.string(),
  /** `null` for a recurring bucket or a budget whose ref no longer resolves —
   *  the client gates its "Open event/project" links on this being non-null. */
  refKind: v.union(v.literal("event"), v.literal("project"), v.null()),
  scopeRefId: v.union(v.string(), v.null()),
  capCents: v.number(),
  spentCents: v.number(),
  remainingCents: v.number(),
  /** "this month" / "this quarter" / "this year" for a recurring bucket;
   *  `null` for a one-time budget (whose window is its whole life). */
  windowLabel: v.union(v.string(), v.null()),
  categories: v.array(glanceCategory),
  lines: v.array(glanceLine),
  lineTotalCount: v.number(),
  /** Whether THIS caller can open `/finances/budgets/[id]` — that page's query
   *  (`budgetDetail.getBudgetDetail`) is finance-viewer gated, so offering the
   *  link to a no-seat member would be a link straight into a permission wall.
   *  Resolved here rather than by a second client-side copy of the rule. */
  canOpenDetail: v.boolean(),
});

const CADENCE_WINDOW_LABELS: Record<string, string> = {
  monthly: "this month",
  quarterly: "this quarter",
  yearly: "this year",
};

/**
 * One budget's charges — the expansion behind a `budgetsGlance` card.
 *
 * Returns `null` (never throws) when the caller has no chapter, when the id
 * doesn't resolve, when the budget belongs to another chapter, or when it
 * isn't a budget the glance screen advertises in the first place (an
 * unapproved draft — see `budgetsGlance`'s own in-force-cap rule). The client
 * renders "nothing to show" for all four; distinguishing them would leak the
 * existence of budgets the caller can't see.
 */
export const expenses = query({
  args: { budgetId: v.id("budgets") },
  returns: v.union(budgetLinesResult, v.null()),
  handler: async (ctx, { budgetId }) => {
    const budget = await ctx.db.get(budgetId);
    if (!budget) return null;
    // A central budget has no chapter roster to be a member of; the glance
    // screen only ever lists the caller's own chapter's budgets, so this is
    // also the tenancy check.
    if (budget.chapterId === CENTRAL) return null;
    const chapterId = budget.chapterId;
    if (!(await requireBudgetExpenses(ctx, chapterId))) return null;

    // Same in-force-cap rule the card list applies: approved, or previously
    // approved with an increase mid-review (`approvedCents` — the old cap
    // still governs). A never-approved draft isn't advertised, so it has no
    // drop-down either.
    if (budget.approvedCents == null && !isAttributableBudget(budget)) return null;

    const type = effectiveType(budget);
    const isOneTime = type === "one_time";
    const now = easternParts(Date.now());

    const sandboxMode = await readSandbox(ctx);
    const linked = await ctx.db
      .query("transactions")
      .withIndex("by_budget", (q) => q.eq("budgetId", budgetId))
      .take(ROLLUP_SCAN_LIMIT);
    if (linked.length === ROLLUP_SCAN_LIMIT) {
      console.warn(
        `[budgetGlance] expenses hit ROLLUP_SCAN_LIMIT (${ROLLUP_SCAN_LIMIT}) for budget ${budgetId}; totals truncated.`,
      );
    }

    // THE card's own rule, not the detail page's — see this file's module doc.
    const counted = linked
      .filter((tr) => txnMatchesMode(tr, sandboxMode))
      .filter((tr) =>
        isOneTime ? isSpend(tr) : txnCountsTowardBudget(tr, budget, now.month),
      );

    const spentCents = counted.reduce((sum, tr) => sum + tr.amountCents, 0);
    const capCents = effectiveCapCents(budget);

    // Category names, resolved through the budget's own chapter (bounded
    // chapter-wide read — the same convention `budgetDetail.ts` uses).
    const categoryDocs = await ctx.db
      .query("budgetCategories")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .take(ROLLUP_SCAN_LIMIT);
    const catName = new Map(categoryDocs.map((c) => [c._id, c.name] as const));

    const byCat = new Map<string, number>();
    for (const tr of counted) {
      const key = tr.categoryId
        ? catName.get(tr.categoryId) ?? "Uncategorized"
        : "Uncategorized";
      byCat.set(key, (byCat.get(key) ?? 0) + tr.amountCents);
    }
    // Bars are drawn against the cap when there is one, else against the
    // biggest slice — mirrors `budgetDetail`'s `denom`, so a category's bar
    // means the same thing on both surfaces.
    const denom = capCents > 0 ? capCents : spentCents;
    const categories = [...byCat.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, cents]) => ({
        name,
        spentCents: cents,
        barPct: denom > 0 ? Math.min(100, Math.round((cents / denom) * 100)) : 0,
      }));

    counted.sort((a, b) => b.postedAt - a.postedAt);
    const page = counted.slice(0, GLANCE_LINE_CAP);

    const getPerson = nameCache(ctx, "people");
    const getCard = nameCache(ctx, "cards");
    const lines: (typeof glanceLine.type)[] = [];
    for (const tr of page) {
      // Who spent it: the transaction's own person, else the cardholder of the
      // card it was swiped on — the same fallback `budgetDetail` uses.
      let personId: Id<"people"> | null = tr.personId ?? null;
      if (!personId && tr.cardId) {
        personId = (await getCard(tr.cardId))?.cardholderPersonId ?? null;
      }
      const person = personId ? await getPerson(personId) : null;
      lines.push({
        id: tr._id,
        postedAt: tr.postedAt,
        description: tr.description ?? null,
        merchantName: tr.merchantName ?? null,
        amountCents: tr.amountCents,
        flow: tr.flow,
        status: tr.status,
        categoryName: tr.categoryId
          ? catName.get(tr.categoryId) ?? "Uncategorized"
          : null,
        personName: person?.name ?? null,
        hasReceipt: tr.receiptStorageId != null,
      });
    }

    const { name, refKind, scopeRefId } = await resolveLiveRef(ctx, budget, type);

    // The detail page's own gate, resolved server-side (see `canOpenDetail`).
    const access = await getFinanceRole(ctx, chapterId);
    const canOpenDetail = access.role != null || access.isCentral;

    return {
      id: budget._id,
      name,
      refKind,
      scopeRefId,
      capCents,
      spentCents,
      remainingCents: capCents - spentCents,
      windowLabel: isOneTime
        ? null
        : CADENCE_WINDOW_LABELS[budget.cadence] ?? null,
      categories,
      lines,
      lineTotalCount: counted.length,
      canOpenDetail,
    };
  },
});

/**
 * The budget's display name plus its ref — but ONLY when the ref still
 * resolves. A deleted event leaves its budget's `scopeRefId` dangling
 * (`events.remove` doesn't cascade), and a drop-down that offered "Open event"
 * for one would be a link that 404s; returning `null` for both fields is what
 * makes the client's link conditional correct by construction rather than by
 * remembering to check a separate `refLive` flag.
 */
async function resolveLiveRef(
  ctx: QueryCtx,
  budget: Doc<"budgets">,
  type: ReturnType<typeof effectiveType>,
): Promise<{
  name: string;
  refKind: "event" | "project" | null;
  scopeRefId: string | null;
}> {
  const refKind = effectiveRefKind(budget);
  // Same fallback chain `budgetDetail.getBudgetDetail` uses, so the two
  // surfaces never call the same budget by two different names.
  const fallbackName = budget.label?.trim() || BUDGET_TYPE_LABELS[type];
  if (refKind === "event" && budget.scopeRefId) {
    const ev = await ctx.db.get(budget.scopeRefId as Id<"events">);
    if (ev) return { name: ev.name, refKind: "event", scopeRefId: budget.scopeRefId };
  } else if (refKind === "project" && budget.scopeRefId) {
    const pr = await ctx.db.get(budget.scopeRefId as Id<"projects">);
    if (pr) return { name: pr.name, refKind: "project", scopeRefId: budget.scopeRefId };
  }
  return { name: fallbackName, refKind: null, scopeRefId: null };
}
