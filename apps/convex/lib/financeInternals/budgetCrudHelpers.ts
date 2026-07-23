import { ConvexError } from "convex/values";
import { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { type BudgetRefKind } from "@events-os/shared";
import { requireInCallerChapter, assertIntegerCents } from "./txnGuards";
import { effectiveCapCents, effectiveRefKind } from "./budgetCore";
import { createEventBudget, createProjectBudget } from "./budgetRefLifecycle";
import { ROLLUP_SCAN_LIMIT } from "./constants";

/**
 * Get-or-create the one_time budget for an event/project ref — the "For"
 * picker's summon-on-pick (WP-U): choosing a budget-less event/project
 * SUMMONS its budget at $0 (a real "plan $0" budget, not clutter — it
 * immediately has linked spend once the caller attributes a transaction to
 * it, which keeps `removeEmptyAutoBudgets` from ever touching it). Reuses the
 * exact D8 creation helpers (`createEventBudget`/`createProjectBudget`) so a
 * summoned budget is indistinguishable from one the create-time hook or a
 * backfill made. Idempotent: a second call for the same ref returns the
 * existing budget instead of creating a duplicate. `userId` is optional so
 * the no-auth `migrateLinksToBudgets` migration can reuse this too.
 *
 * Exported so the `0026_migrate_budget_v1_lines` migration can reuse the exact
 * same get-or-create (rather than re-deriving it) when it needs to ensure a
 * legacy Budget v1 event's finance budget row exists before inserting its
 * migrated `budgetLines`. This export is for other MUTATION-side callers
 * with a `MutationCtx` already in hand.
 *
 * WP-wave4 (item 5): RETIRED as the "For" transaction-attribution picker's
 * summon-on-pick trigger (owner decision 2026-07-17 — an unbudgeted ref must
 * never become silently attributable by picking it; only an APPROVED budget
 * is attributable now, see `isAttributableBudget`). The public
 * `summonBudgetForRef` mutation below still exists and is still called from
 * ONE place — the ref's own page (`MoneyView.tsx`'s "Add budget" button),
 * which starts a budget's lifecycle (draft → send → approve, WP-wave4 item
 * 3), not a transaction's.
 */
export async function ensureBudgetForRef(
  ctx: MutationCtx,
  chapterId: Id<"chapters">,
  refKind: BudgetRefKind,
  scopeRefId: string,
  userId: Id<"users"> | undefined,
): Promise<Id<"budgets">> {
  const existing = await ctx.db
    .query("budgets")
    .withIndex("by_ref", (q) => q.eq("refKind", refKind).eq("scopeRefId", scopeRefId))
    .first();
  if (existing) return existing._id;

  if (refKind === "event") {
    const event = await requireInCallerChapter(
      ctx,
      chapterId,
      "events",
      scopeRefId as Id<"events">,
      "Event",
    );
    await createEventBudget(ctx, event, userId);
  } else {
    const project = await requireInCallerChapter(
      ctx,
      chapterId,
      "projects",
      scopeRefId as Id<"projects">,
      "Project",
    );
    // Summon at $0 — never the project's own `budgetUsd` — this path is ONLY
    // reached when no budget exists yet, i.e. `budgetUsd` was never positive
    // (the owner rule's create-time hook would have already made one).
    await createProjectBudget(ctx, { ...project, budgetUsd: undefined }, userId);
  }
  const created = await ctx.db
    .query("budgets")
    .withIndex("by_ref", (q) => q.eq("refKind", refKind).eq("scopeRefId", scopeRefId))
    .first();
  if (!created) {
    throw new ConvexError({
      code: "INTERNAL",
      message: "Failed to summon a budget for this ref.",
    });
  }
  return created._id;
}

/**
 * Validate + verify tenancy of the optional narrowers on a budget write. The
 * one_time instance ref is verified against `events`/`projects` per `refKind`.
 */
export async function verifyBudgetRefs(
  ctx: MutationCtx,
  chapterId: Id<"chapters">,
  b: {
    refKind?: BudgetRefKind | null;
    scopeRefId?: string | null;
    fundId?: Id<"funds"> | null;
    categoryId?: Id<"budgetCategories"> | null;
    month?: number | null;
    quarter?: number | null;
  },
): Promise<void> {
  if (b.month != null && (b.month < 1 || b.month > 12)) {
    throw new ConvexError({ code: "INVALID_PERIOD", message: "Month must be 1–12." });
  }
  if (b.quarter != null && (b.quarter < 1 || b.quarter > 4)) {
    throw new ConvexError({ code: "INVALID_PERIOD", message: "Quarter must be 1–4." });
  }
  if (b.fundId) await requireInCallerChapter(ctx, chapterId, "funds", b.fundId, "Fund");
  if (b.categoryId)
    await requireInCallerChapter(ctx, chapterId, "budgetCategories", b.categoryId, "Category");
  if (b.scopeRefId) {
    if (b.refKind === "project") {
      await requireInCallerChapter(
        ctx,
        chapterId,
        "projects",
        b.scopeRefId as Id<"projects">,
        "Project",
      );
    } else {
      await requireInCallerChapter(ctx, chapterId, "events", b.scopeRefId as Id<"events">, "Event");
    }
  }
}

/**
 * WP-U2 ("the budgets row is the single source of truth"): the ONE place
 * that writes a one_time event/project budget's `amountCents` — used by BOTH
 * the finance-side edit (`updateBudget`, below) and the entity-side edit
 * (`events.updateDetails` / `projects.update`), so the two edit paths can
 * never drift apart from each other again. After patching the row, MIRRORS
 * the dollar amount back onto the entity's own field (`events.budget` /
 * `projects.budgetUsd`) for any reader not yet swept onto reading the row
 * directly (via `getBudgetForRef`) — WP-U2 phase B breadcrumb: drop the
 * mirrored field entirely once every reader is swept.
 *
 * `amountCents === 0` mirrors to `undefined` (the entity's own "no budget
 * entered" empty state) rather than a literal `$0` — the ROW itself is left
 * exactly as written; a real "plan $0" budget (see `ensureBudgetForRef`)
 * stays a real budget. A recurring or central budget (no `scopeRefId`) has
 * no entity to mirror onto, so this is a no-op past the row write.
 *
 * WP-3.2 · THE RETRIGGER (WP-wave4 item 3 UPDATE — no longer an
 * auto-RESUBMIT): an amount INCREASE past the approved cap on a budget whose
 * approval status is the LITERAL `"approved"` flips it back to `"draft"` — a
 * DRAFT INCREASE, fully editable, that does NOT notify anyone or enter the
 * approval queue until the caller deliberately calls
 * `submitBudgetForApproval` (which sends it for review AND notifies the
 * scope's approvers). `approvedCents` is left untouched, so `effectiveCapCents`
 * keeps enforcing the OLD, still-in-force cap the whole time the increase
 * sits unsent — an approver blessed a specific number; silently spending past
 * it without a second look (or without even a deliberate send) defeats the
 * point of approving at all. Decreases, and edits that don't cross the
 * approved cap, never retrigger — `approvedCents` is only ever refreshed by
 * `approveBudget` itself.
 *
 * I1 (review): a GRANDFATHERED legacy budget (`approvalStatus` absent, reads
 * as `effectiveBudgetApprovalStatus` `"approved"`) retriggers too, but only on
 * its FIRST increase — the moment it stops being untouched-since-migration.
 * That first increase stamps `approvedCents` at the OLD (pre-edit) amount and
 * flips it to `"draft"`, exactly like the literal-approved path, so it joins
 * the real workflow (as a draft increase awaiting an explicit send) from then
 * on. A decrease on a still-fully-legacy budget stays untouched (no stamp at
 * all) — see the tuple's doc comment in `@events-os/shared`.
 */
export async function setBudgetAmount(
  ctx: MutationCtx,
  budgetId: Id<"budgets">,
  amountCents: number,
): Promise<void> {
  assertIntegerCents(amountCents, "Budget amount");
  const budget = await ctx.db.get(budgetId);
  if (!budget) {
    throw new ConvexError({ code: "NOT_FOUND", message: "Budget not found." });
  }
  await ctx.db.patch(budgetId, { amountCents });

  /** Flip to `"draft"` for a retrigger (WP-wave4 item 3) — NOT an
   *  auto-resubmit; the caller must explicitly `submitBudgetForApproval` to
   *  send the increase for review + notify the scope's approvers. `extra`
   *  carries `approvedCents` for the grandfathered-first-increase branch
   *  below, keeping the OLD amount as the still-enforced cap
   *  (`effectiveCapCents`) until it's deliberately sent. No submitter/notify
   *  stamping happens here (unlike the old auto-`"submitted"` behavior) —
   *  `submitBudgetForApproval` stamps `submittedByPersonId`/`submittedAt` for
   *  real when that deliberate send happens. */
  async function retriggerDraft(extra: Record<string, unknown>): Promise<void> {
    await ctx.db.patch(budgetId, {
      approvalStatus: "draft",
      ...extra,
    });
  }

  if (
    budget.approvalStatus === "approved" &&
    amountCents > effectiveCapCents(budget)
  ) {
    // `approvedCents` is DELIBERATELY left untouched — it stays the
    // effective (old, still-in-force) spending cap while this increase sits
    // as an editable draft, unsent.
    await retriggerDraft({});
  } else if (budget.approvalStatus === undefined && amountCents > budget.amountCents) {
    // I1: the grandfathered budget's FIRST increase — stamp `approvedCents`
    // at the OLD amount (the cap it was silently "approved at") and join the
    // real workflow as a draft increase, same as a literally-approved budget
    // crossing its cap.
    await retriggerDraft({ approvedCents: budget.amountCents });
  }
  const refKind = effectiveRefKind(budget);
  if (!refKind || !budget.scopeRefId) return;
  const mirrorDollars = amountCents > 0 ? amountCents / 100 : undefined;
  if (refKind === "event") {
    const ev = await ctx.db.get(budget.scopeRefId as Id<"events">);
    // A budget row can outlive its ref (a deleted event doesn't cascade to
    // its budget) — nothing to mirror onto then; the row write above stands.
    if (ev) await ctx.db.patch(ev._id, { budget: mirrorDollars });
  } else {
    const project = await ctx.db.get(budget.scopeRefId as Id<"projects">);
    if (project) await ctx.db.patch(project._id, { budgetUsd: mirrorDollars });
  }
}

/**
 * Cascade-delete a budget's own dependent rows — its `budgetTagLinks` and its
 * WP-3.1 `budgetLines` plan breakdown — then the budget itself. Shared by
 * `deleteBudget` and `removeEmptyAutoBudgets` so the ops cleanup can't drift
 * from the user-facing delete and orphan `budgetLines` rows behind a budget
 * that no longer exists (a bug this fixed: the cleanup used to delete budgets
 * inline without this cascade). Does NOT touch `transactions` — callers that
 * need to unlink spend do that themselves first (only `deleteBudget` does;
 * `removeEmptyAutoBudgets` only ever reaches a budget with zero linked txns).
 */
export async function cascadeDeleteBudget(ctx: MutationCtx, budgetId: Id<"budgets">): Promise<void> {
  const links = await ctx.db
    .query("budgetTagLinks")
    .withIndex("by_budget", (q) => q.eq("budgetId", budgetId))
    .take(ROLLUP_SCAN_LIMIT);
  for (const link of links) await ctx.db.delete(link._id);

  const lines = await ctx.db
    .query("budgetLines")
    .withIndex("by_budget", (q) => q.eq("budgetId", budgetId))
    .take(ROLLUP_SCAN_LIMIT);
  for (const line of lines) await ctx.db.delete(line._id);

  await ctx.db.delete(budgetId);
}
