import { ConvexError } from "convex/values";
import { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import {
  CENTRAL,
  financeRoleAtLeast,
  FINANCE_ROLE_LABELS,
  type BudgetRefKind,
} from "@events-os/shared";
import { tagLevelAllowed } from "./budgetCore";
import { ROLLUP_SCAN_LIMIT } from "./constants";
import { requireChapterId, requireUserId } from "../context";
import { requireFinanceCentral, defaultFundId, type FinanceScope } from "../finance";

/**
 * Gate a CENTRAL bulk-write operation: central reach AND at least the `min`
 * write rank. `requireFinanceCentral` alone only checks REACH (any central
 * grant, including a viewer-only one), so — exactly like `requireReconcileTxn`
 * (#151) — we additionally clear the role rank so a central VIEWER can't perform
 * a write that a chapter viewer is correctly blocked from. Returns the caller's
 * roster person (may be null for a superuser without a `people` row) + userId.
 */
export async function requireCentralWrite(
  ctx: MutationCtx,
  min: "viewer" | "bookkeeper" | "manager",
): Promise<{ personId: Id<"people"> | null; userId: Id<"users"> }> {
  const homeChapterId = (await requireChapterId(ctx)) as Id<"chapters">;
  const userId = (await requireUserId(ctx)) as Id<"users">;
  const access = await requireFinanceCentral(ctx, homeChapterId);
  if (!financeRoleAtLeast(access.role, min)) {
    throw new ConvexError({
      code: "FORBIDDEN",
      message: `This action needs at least the ${FINANCE_ROLE_LABELS[min]} finance role.`,
    });
  }
  return { personId: access.personId, userId };
}

/** One `reattributionAudit.priorStates` entry — a txn's exact attribution
 *  right before a bulk move patches it. See the schema doc comment for why
 *  this exists (true undo vs. a swapped-target re-run). */
export type ReattributionPriorState = {
  transactionId: Id<"transactions">;
  chapterId: FinanceScope;
  budgetId?: Id<"budgets">;
  fundId?: Id<"funds">;
  categoryId?: Id<"budgetCategories">;
  projectId?: Id<"projects">;
  eventId?: Id<"events">;
  eventItemId?: Id<"eventItems">;
  teamId?: Id<"financeTeams">;
  personId?: Id<"people">;
};

/** Snapshot a txn's CURRENT attribution — called before its reassignment patch
 *  is computed/applied, so the audit row remembers exactly what to restore. */
export function snapshotPriorState(txn: Doc<"transactions">): ReattributionPriorState {
  return {
    transactionId: txn._id,
    chapterId: txn.chapterId as FinanceScope,
    budgetId: txn.budgetId,
    fundId: txn.fundId,
    categoryId: txn.categoryId,
    projectId: txn.projectId,
    eventId: txn.eventId,
    eventItemId: txn.eventItemId,
    teamId: txn.teamId,
    personId: txn.personId,
  };
}

/**
 * A chapter-only PERSON link survives a cross-boundary move ONLY when the
 * roster row belongs to the TARGET chapter. Moving to central always clears it
 * (a central txn carries no person link at all — `createManualTransaction`
 * enforces the same invariant at creation). Returns the id to keep, or
 * `undefined` to clear the field (a `patch` with an `undefined` value unsets it).
 */
async function keepTargetOwnedPerson(
  ctx: QueryCtx,
  id: Id<"people"> | undefined,
  target: FinanceScope,
): Promise<Id<"people"> | undefined> {
  if (id == null) return undefined;
  if (target === CENTRAL) return undefined;
  const person = (await ctx.db.get(id)) as { chapterId?: Id<"chapters"> } | null;
  return person && person.chapterId === target ? id : undefined;
}

/**
 * The field patch that moves ONE transaction to `target`, clearing every
 * chapter-scoped attribution that no longer makes sense across the boundary.
 * A same-scope "move" (`target` already owns the txn) is a no-op — attributions
 * are left untouched. Per-field rules (documented so the split is auditable):
 *
 *  - `chapterId`  → always set to `target` (the whole point).
 *  - `budgetId`   → KEEP only if the linked budget is owned by `target` (budgets
 *                   carry the same chapter|central union); a source-scope budget
 *                   no longer applies → clear.
 *  - `fundId`     → funds are chapter-scoped (NO central funds): → central clears
 *                   it; → chapter reassigns the TARGET chapter's General Fund
 *                   (never inherit the source chapter's fund).
 *  - `categoryId` → categories are chapter-scoped (source chapter's fund tree) →
 *                   ALWAYS clear (the receiving treasurer recodes).
 *  - `teamId`     → financeTeams MAY be central (absent chapterId): keep a
 *                   central team or a target-owned team; clear a source-chapter
 *                   team (a central txn carries no chapter-scoped link — the same
 *                   invariant `createManualTransaction` enforces at creation).
 *  - `personId`   → a roster person is chapter-scoped and a central txn carries
 *                   none (`createManualTransaction` rejects it): → central clears;
 *                   → chapter keeps only a target-roster person.
 *
 *  WP-U (one home per dollar): `projectId`/`eventId`/`eventItemId` are NEVER
 *  touched here anymore — those FKs are vestigial (`budgetId` is the only real
 *  attribution; actuals are budget-first), so a reassignment leaves whatever
 *  stale value was already on the row alone rather than clearing it. This also
 *  means `transferProjectScope` no longer needs a `preserveProjectId` escape
 *  hatch to keep a whole-project move's project link — nothing here ever
 *  touches `projectId`, so there's nothing to preserve.
 *
 *  Deliberately UNTOUCHED (provenance/reality of where the money physically
 *  moved — reassignment must never rewrite it): `externalId`, `sourceAccountId`,
 *  `cardId`, `cardLast4`, `reimbursementId`, `engagementId`, `repaymentId`,
 *  receipt, amount/flow/status.
 */
export async function computeReassignmentPatch(
  ctx: MutationCtx,
  txn: Doc<"transactions">,
  target: FinanceScope,
): Promise<Record<string, unknown>> {
  const patch: Record<string, unknown> = { chapterId: target };
  // Same-scope "move": nothing crossed the boundary — leave attributions as-is.
  if (txn.chapterId === target) return patch;

  if (txn.budgetId != null) {
    const budget = await ctx.db.get(txn.budgetId);
    patch.budgetId = budget && budget.chapterId === target ? txn.budgetId : undefined;
  }

  patch.fundId =
    target === CENTRAL ? undefined : ((await defaultFundId(ctx, target)) ?? undefined);

  patch.categoryId = undefined;

  if (txn.teamId != null) {
    const team = (await ctx.db.get(txn.teamId)) as { chapterId?: Id<"chapters"> } | null;
    const teamChapter = team?.chapterId; // undefined = a central/org team
    const keep = team != null && (teamChapter === undefined || teamChapter === target);
    patch.teamId = keep ? txn.teamId : undefined;
  }

  patch.personId = await keepTargetOwnedPerson(ctx, txn.personId, target);

  return patch;
}

/** A finance scope's display name ("Central" for the sentinel, else the
 *  chapter's name) — used to build the human-readable audit summary. */
export async function financeScopeName(ctx: QueryCtx, scope: FinanceScope): Promise<string> {
  if (scope === CENTRAL) return "Central";
  const chapter = await ctx.db.get(scope);
  return chapter?.name ?? "Unknown chapter";
}

/** A `"New York (12), Central (1) → Central"` from→to summary for the audit. */
export async function buildReassignSummary(
  ctx: QueryCtx,
  sourceCounts: Map<FinanceScope, number>,
  target: FinanceScope,
): Promise<string> {
  const parts: string[] = [];
  for (const [scope, count] of sourceCounts) {
    parts.push(`${await financeScopeName(ctx, scope)} (${count})`);
  }
  parts.sort();
  return `${parts.join(", ")} → ${await financeScopeName(ctx, target)}`;
}

/**
 * M1 (review): a budget that's `"approved"` or `"submitted"` at the SOURCE
 * scope carries a decision (or a pending one) from an approver who no longer
 * has any standing at the DESTINATION scope — a chapter manager's blessing
 * means nothing once the budget is central's, and vice versa. Crossing the
 * boundary resets provenance: status → `"submitted"` (the new scope's
 * approver — chapter manager, or central ED/FM — must bless it fresh) and the
 * stale `approvedByPersonId` is cleared. `approvedCents` is DELIBERATELY kept
 * as-is — it stays the in-force spending cap (mirrors the increase-retrigger
 * rule) rather than resetting to null and silently uncapping spend mid-move.
 * A `"draft"` or `"changes_requested"` budget has no blessed provenance to
 * invalidate, so it's left untouched. The caller (`transferProjectScope`)
 * only ever reaches here for a genuine scope change (`b.chapterId !==
 * args.target`), so every call here IS a boundary crossing.
 */
async function moveBudgetScope(
  ctx: MutationCtx,
  budget: Doc<"budgets">,
  target: FinanceScope,
): Promise<void> {
  const resetsProvenance =
    budget.approvalStatus === "approved" || budget.approvalStatus === "submitted";
  await ctx.db.patch(budget._id, {
    chapterId: target,
    fundId: target === CENTRAL ? undefined : ((await defaultFundId(ctx, target)) ?? undefined),
    // Category + team belong to the source chapter's tree — clear on any move.
    categoryId: undefined,
    teamId: undefined,
    ...(resetsProvenance
      ? {
          approvalStatus: "submitted" as const,
          approvedByPersonId: undefined,
          // WP-wave4 (item 8-LOW): a stale "single-party approved" record no
          // longer describes the CURRENT state once a decision is reset —
          // the budget needs re-approval at the new scope. The PERMANENT
          // `budgetApprovalLog` trail is untouched (never rewritten); this
          // only clears the last-decision-only field the chip reads.
          approvalParty: undefined,
        }
      : {}),
  });
  const links = await ctx.db
    .query("budgetTagLinks")
    .withIndex("by_budget", (q) => q.eq("budgetId", budget._id))
    .collect();
  for (const link of links) {
    const tag = await ctx.db.get(link.tagId);
    const valid = tag != null && tagLevelAllowed(tag.chapterId, target);
    if (!valid) {
      await ctx.db.delete(link._id);
      continue;
    }
    if (link.chapterId !== target) await ctx.db.patch(link._id, { chapterId: target });
  }

  const lines = await ctx.db
    .query("budgetLines")
    .withIndex("by_budget", (q) => q.eq("budgetId", budget._id))
    .take(ROLLUP_SCAN_LIMIT);
  for (const line of lines) {
    if (line.categoryId !== undefined) await ctx.db.patch(line._id, { categoryId: undefined });
  }
}

/**
 * Shared engine behind `transferProjectScope` AND `transferEventScope`: move
 * every budget linked to a single project/event ref (found via `by_ref`,
 * regardless of which scope currently owns it — see the REVERSE-transfer note
 * below) plus every transaction linked to those budgets, then write ONE
 * `reattributionAudit` row. Extracted (not duplicated) so both refs share the
 * exact same move semantics — a behavior-preserving refactor of the
 * project-only WP-2.2 code: `transferProjectScope`'s own test suite is
 * unchanged and still green, proving this split didn't alter its behavior.
 *
 * Neither a project's nor an event's ROW has a central scope / chapterId
 * union (WP-2.2 finding, reconfirmed for events — `schema/events.ts` has
 * `chapterId: v.id("chapters")`, no union): the ref ROW always stays
 * chapter-scoped, only its money moves. Callers report that back to their own
 * client as `projectScopeDeferred`/`eventScopeDeferred: true`.
 */
export async function transferRefScope(
  ctx: MutationCtx,
  args: {
    refKind: BudgetRefKind;
    refId: Id<"projects"> | Id<"events">;
    /** e.g. `Project "Music Recording"` / `Event "Sunday Gathering"` — the
     *  audit summary's subject line. */
    refLabel: string;
    sourceScope: FinanceScope;
    target: FinanceScope;
    note: string | undefined;
    actor: { personId: Id<"people"> | null; userId: Id<"users"> };
  },
): Promise<{
  budgetsMoved: number;
  txnsMoved: number;
  auditId: Id<"reattributionAudit">;
}> {
  const { refKind, refId, refLabel, sourceScope, target, note, actor } = args;

  // 1. Move the ref's BUDGETS (one_time budgets whose refKind/scopeRefId point
  //    at this project/event). Found via `by_ref` — NOT scoped to
  //    `sourceScope` — because the ref's own `chapterId` never changes
  //    (WP-2.2 finding). Scoping this lookup to the ref's home chapter meant a
  //    REVERSE transfer (chapter → central → back to chapter) couldn't find
  //    budgets that already moved to central: it queried the chapter, but the
  //    budgets lived at central by then, so they were silently stranded.
  //    `by_ref` finds them regardless of which scope currently owns them.
  const refBudgets = await ctx.db
    .query("budgets")
    .withIndex("by_ref", (q) => q.eq("refKind", refKind).eq("scopeRefId", refId))
    .take(ROLLUP_SCAN_LIMIT);
  let budgetsMoved = 0;
  for (const b of refBudgets) {
    if (b.chapterId === target) continue;
    await moveBudgetScope(ctx, b, target);
    budgetsMoved++;
  }

  // 2. Move the transactions ATTACHED TO those budgets (WP-U: one home per
  //    dollar — the money follows the BUDGET, discovered via `by_budget`,
  //    not the txn's own vestigial `projectId`/`eventId` FK, untouched by
  //    `computeReassignmentPatch`). A ref can carry more than one one_time
  //    budget over its life (rare, but possible), so this unions every
  //    budget's linked transactions.
  const linked: Doc<"transactions">[] = [];
  for (const b of refBudgets) {
    const rows = await ctx.db
      .query("transactions")
      .withIndex("by_budget", (q) => q.eq("budgetId", b._id))
      .take(ROLLUP_SCAN_LIMIT);
    if (rows.length === ROLLUP_SCAN_LIMIT) {
      console.warn(
        `[finances] transferRefScope hit ROLLUP_SCAN_LIMIT (${ROLLUP_SCAN_LIMIT}) reading transactions for budget ${b._id}; some linked transactions may not have moved.`,
      );
    }
    linked.push(...rows);
  }
  const priorStates: ReattributionPriorState[] = [];
  const movedTxnIds: Id<"transactions">[] = [];
  for (const txn of linked) {
    if (txn.chapterId === target) continue;
    priorStates.push(snapshotPriorState(txn));
    const patch = await computeReassignmentPatch(ctx, txn, target);
    await ctx.db.patch(txn._id, patch);
    movedTxnIds.push(txn._id);
  }

  const summary = `${refLabel}: ${await financeScopeName(
    ctx,
    sourceScope,
  )} → ${await financeScopeName(ctx, target)} (${budgetsMoved} budget(s), ${
    movedTxnIds.length
  } txn(s))`;
  const auditId = await ctx.db.insert("reattributionAudit", {
    kind: refKind === "project" ? "project_transfer" : "event_transfer",
    actorUserId: actor.userId,
    ...(actor.personId ? { actorPersonId: actor.personId } : {}),
    transactionIds: movedTxnIds,
    target,
    summary,
    priorStates,
    ...(refKind === "project"
      ? { projectId: refId as Id<"projects"> }
      : { eventId: refId as Id<"events"> }),
    budgetsMoved,
    ...(note ? { note } : {}),
    createdAt: Date.now(),
  });
  return { budgetsMoved, txnsMoved: movedTxnIds.length, auditId };
}
