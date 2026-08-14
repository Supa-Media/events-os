/**
 * One-time: delete "Love Thy Neighbor 2026", a $6,000 New York budget whose
 * event no longer exists.
 *
 * ── WHAT IT IS ──────────────────────────────────────────────────────────────
 * `th7d5gksmzxpp6bxs6yn3m6gkx8aqrst` — a `one_time`, `refKind:"event"` budget
 * created 2026-07-17 and approved the next morning, whose `scopeRefId`
 * (`m57eh9q156zs3hvjbq4e5v9x3x8a0m7j`) does not resolve to any row in `events`.
 * That dead ref is why the detail page renders the raw `label` as its title and
 * offers no event link: `budgetDetail.ts` reports `refLive:false` and falls
 * back to `budget.label`.
 *
 * It was superseded rather than retired. "2026 Love Thy Neighbor" ($5,000,
 * created 2026-08-06, approved 2026-08-12) points at the LIVE event
 * `m572sm778z3r660kvvy56998b58b0rdq`, and "Love Thy Neighbor 2025" ($5,000)
 * carries the actual 2025 spend. Three budgets, one of them attached to
 * nothing.
 *
 * ── IT ONLY BECAME SAFE TO DELETE ON 2026-08-14 ─────────────────────────────
 * Until 03:27 UTC that morning this budget held a real charge: $325.00 to
 * Paypal, "Love Thy Neighbor Recap Video from Josh Adriano", receipt attached,
 * on Seyi's PW card ••2702. `financeAuditLog` records the `recode` that moved
 * it onto "Love Thy Neighbor 2025". Deleting the budget before that would have
 * dropped $325 of coded, receipted spend back into Unattributed — recoverable,
 * loud by design (`deleteBudget` unlinks rather than orphans), but not what
 * anyone wanted.
 *
 * That is the whole reason this module re-derives its preconditions instead of
 * trusting the snapshot it was written from: the ledger moved once between
 * "this looks like a relic" and "delete it", and it can move again between this
 * merging and this running.
 *
 * ── WHY A ONE-OFF AND NOT A BUTTON ──────────────────────────────────────────
 * `finances.deleteBudget` already does exactly the right thing — audit entry,
 * unlink linked transactions, cascade tag links and plan lines, delete — and
 * NOTHING in the app calls it. There is no Delete anywhere on the budget
 * detail page (Copy and Edit only), and it is an auth-gated public mutation, so
 * it cannot be reached from `npx convex run` either.
 *
 * Adding the button is the better product answer and remains open; the owner
 * chose the one-off for this row (2026-08-14). Note the consequence if the
 * button never lands: the NEXT orphaned budget needs another one of these.
 *
 * `removeEmptyAutoBudgets` is not an alternative — it refuses any budget with a
 * nonzero `amountCents`, and this one is $6,000.
 *
 * ── NO AUDIT ENTRY, DELIBERATELY ────────────────────────────────────────────
 * `deleteBudget` writes a `budget_delete` row to `financeAuditLog`; this does
 * not. `logFinanceAudit` resolves `actorUserId` through `requireUserId` — the
 * trail's integrity anchor — and an `internalMutation` has no authenticated
 * caller to resolve. Borrowing the owner's user id would put a person's name on
 * an action they did not take, which is worse than an absent row. The record of
 * this deletion is this module, its PR, and the two `budgetApprovalLog` rows
 * the cascade deliberately leaves standing (a budget's history outlives the
 * row — see `schema/finances.ts`).
 *
 * ── WHAT SURVIVES ───────────────────────────────────────────────────────────
 * Deleted: the budget, and its two `budgetTagLinks` (tags "Love Thy Neighbor"
 * and "Events") via {@link cascadeDeleteBudget}. Kept: its two
 * `budgetApprovalLog` rows (sent + approved), which nothing cascades and
 * nothing reads expecting the parent to exist.
 *
 * Delete this module once run.
 */
import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { CENTRAL } from "@events-os/shared";
import { ROLLUP_SCAN_LIMIT, cascadeDeleteBudget } from "./finances";

const BUDGET_ID = "th7d5gksmzxpp6bxs6yn3m6gkx8aqrst" as Id<"budgets">;
const CHAPTER = "kh73xrr66rxt2wzr3ny5c2c4kh88n06n" as Id<"chapters">; // New York
const EXPECTED_LABEL = "Love Thy Neighbor 2026";
const EXPECTED_CENTS = 600_000;
/** The event this budget was created against, gone from `events` since. */
const EXPECTED_DEAD_EVENT = "m57eh9q156zs3hvjbq4e5v9x3x8a0m7j";

/**
 * Everything about the budget's CURRENT state that must still hold for deleting
 * it to be a cleanup rather than a data loss. Split from the identity checks in
 * the runner (which compare against hard-coded production values and so can't
 * be exercised in a fixture) precisely so these CAN be: every one of them is a
 * claim about live rows that were true when this was written and need not stay
 * true until it runs.
 *
 * Returns one human-readable line per failed claim, empty when it is safe.
 * Exported for its test.
 */
export async function orphanBudgetProblems(
  ctx: MutationCtx,
  budget: Doc<"budgets">,
): Promise<string[]> {
  const problems: string[] = [];

  // (1) THE CLAIM THAT MAKES IT A RELIC. A budget whose event came back — or
  // whose ref was repointed at a live one — is somebody's budget again.
  if (budget.refKind === "event" && budget.scopeRefId) {
    const ev = await ctx.db.get(budget.scopeRefId as Id<"events">);
    if (ev) {
      problems.push(
        `scopeRefId ${budget.scopeRefId} resolves to a live event ("${ev.name}") — ` +
          `this budget is attached to something, not orphaned`,
      );
    }
  } else {
    problems.push(
      `expected refKind "event" with a scopeRefId, found ${String(budget.refKind)}/` +
        `${String(budget.scopeRefId)}`,
    );
  }

  // (2) THE ONE THAT ALREADY CHANGED ONCE. `deleteBudget` unlinks linked spend
  // into Unattributed rather than orphaning it; this refuses instead, because a
  // budget with spend on it is not the row this module was written about.
  const linked = await ctx.db
    .query("transactions")
    .withIndex("by_budget", (q) => q.eq("budgetId", budget._id))
    .take(ROLLUP_SCAN_LIMIT);
  if (linked.length > 0) {
    const total = linked.reduce((sum, tr) => sum + tr.amountCents, 0);
    problems.push(
      `${linked.length} transaction(s) totalling ${total}¢ are still coded to this budget ` +
        `(e.g. ${linked[0]._id}) — recode them first, or this deletion loses their ` +
        `attribution`,
    );
  }

  // (3) A plan breakdown is real planning work, and $0 spent doesn't mean $0
  // thought about. Same guard `removeEmptyAutoBudgets` applies.
  const planLine = await ctx.db
    .query("budgetLines")
    .withIndex("by_budget", (q) => q.eq("budgetId", budget._id))
    .first();
  if (planLine) {
    problems.push(
      `budget carries budgetLines planning rows (e.g. ${planLine._id}) — deleting it ` +
        `would silently destroy them`,
    );
  }

  // (4) A reimbursement points at a budget by id and has no index for the
  // reverse lookup, so this scans the chapter. Cheap (single digits in prod)
  // and the alternative is a dangling `budgetId` on a live money request.
  //
  // Scoped to the BUDGET'S OWN chapter, not this module's `CHAPTER` constant:
  // a guard that reads a different chapter than the row it is guarding can
  // only ever return "all clear". (`reimbursementRequests.chapterId` is a real
  // chapter id — never the `"central"` sentinel — so a central budget has no
  // requests to find, and the check is skipped rather than mistyped.)
  if (budget.chapterId !== CENTRAL) {
    const budgetChapterId = budget.chapterId;
    const reimbursements = await ctx.db
      .query("reimbursementRequests")
      .withIndex("by_chapter", (q) => q.eq("chapterId", budgetChapterId))
      .take(ROLLUP_SCAN_LIMIT);
    const pointingHere = reimbursements.filter((r) => r.budgetId === budget._id);
    if (pointingHere.length > 0) {
      problems.push(
        `${pointingHere.length} reimbursement request(s) reference this budget ` +
          `(e.g. ${pointingHere[0]._id}) — they would be left pointing at a deleted row`,
      );
    }
  }

  return problems;
}

/**
 * Delete the orphaned "Love Thy Neighbor 2026" budget.
 *
 * `execute` omitted / false = a zero-write dry run reporting exactly what a real
 * run would do. Idempotent: once the budget is gone a second run reports
 * `deleted:false` with `alreadyGone:true` and no problems.
 *
 * Writes NOTHING if any identity or state check fails — `problems` says which.
 * A one-off that guesses is worse than one that stops.
 *
 * Run on prod (dry run first):
 *   npx convex run --prod deleteOrphanLtnBudget:deleteOrphanLtnBudget
 *   npx convex run --prod deleteOrphanLtnBudget:deleteOrphanLtnBudget '{"execute":true}'
 */
export const deleteOrphanLtnBudget = internalMutation({
  args: { execute: v.optional(v.boolean()) },
  returns: v.object({
    dryRun: v.boolean(),
    deleted: v.boolean(),
    alreadyGone: v.boolean(),
    tagLinksDeleted: v.number(),
    problems: v.array(v.string()),
  }),
  handler: async (ctx, { execute }) => {
    const write = execute ?? false;
    const budget = await ctx.db.get(BUDGET_ID);
    if (!budget) {
      return {
        dryRun: !write,
        deleted: false,
        alreadyGone: true,
        tagLinksDeleted: 0,
        problems: [],
      };
    }

    // Identity — is this still the row this module was written about? A
    // renamed or repriced budget is a decision someone made after this was
    // written, and it outranks the plan.
    const problems: string[] = [];
    if (budget.label !== EXPECTED_LABEL) {
      problems.push(`label is "${String(budget.label)}", expected "${EXPECTED_LABEL}"`);
    }
    if (budget.amountCents !== EXPECTED_CENTS) {
      problems.push(`amountCents is ${budget.amountCents}, expected ${EXPECTED_CENTS}`);
    }
    if (budget.chapterId !== CHAPTER) {
      problems.push(`chapterId is ${String(budget.chapterId)}, expected New York ${CHAPTER}`);
    }
    if (budget.type !== "one_time") {
      problems.push(`type is ${String(budget.type)}, expected one_time`);
    }
    if (budget.scopeRefId !== EXPECTED_DEAD_EVENT) {
      problems.push(
        `scopeRefId is ${String(budget.scopeRefId)}, expected ${EXPECTED_DEAD_EVENT}`,
      );
    }

    problems.push(...(await orphanBudgetProblems(ctx, budget)));
    if (problems.length > 0) {
      return {
        dryRun: !write,
        deleted: false,
        alreadyGone: false,
        tagLinksDeleted: 0,
        problems,
      };
    }

    // Counted before the cascade removes them, so the report says what went.
    const tagLinks = await ctx.db
      .query("budgetTagLinks")
      .withIndex("by_budget", (q) => q.eq("budgetId", budget._id))
      .take(ROLLUP_SCAN_LIMIT);

    if (write) await cascadeDeleteBudget(ctx, budget._id);

    return {
      dryRun: !write,
      deleted: true,
      alreadyGone: false,
      tagLinksDeleted: tagLinks.length,
      problems: [],
    };
  },
});
