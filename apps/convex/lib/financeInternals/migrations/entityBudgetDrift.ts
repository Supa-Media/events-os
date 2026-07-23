import { ConvexError } from "convex/values";
import { Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { type BudgetRefKind } from "@events-os/shared";
import { effectiveRefKind } from "../budgetCore";
import {
  createEventBudget,
  createProjectBudget,
  hasBudgetForRef,
  getBudgetForRef,
} from "../budgetRefLifecycle";

/**
 * Migration body (WP-U2): "the budgets row is the single source of truth" —
 * `setBudgetAmount` keeps new edits in sync going forward, but pre-existing
 * rows may already have drifted (a post-creation edit to `projects.budgetUsd`/
 * `events.budget` before this PR, made directly against the entity field,
 * never touched the budget row). For every one_time event/project budget
 * whose ref's own field disagrees with `amountCents`, the ROW WINS — the
 * entity field is overwritten to match (mirrors `setBudgetAmount`'s own
 * dollar-conversion rule: `amountCents === 0` → the entity field is cleared
 * to `undefined`, not written as a literal `$0`).
 *
 * Paginates over `budgets` (not `events`/`projects`) — every money-carrying
 * ref has at most one budget row (the D8 invariant), so this is the smaller,
 * more targeted table to scan. Idempotent: a settled re-run counts everything
 * as `alreadySynced` and writes nothing.
 */
export async function runReconcileEntityBudgetDrift(
  ctx: MutationCtx,
  chapterId: Id<"chapters"> | undefined,
  paginationOpts: { cursor: string | null; numItems: number },
): Promise<{
  scanned: number;
  fixed: number;
  alreadySynced: number;
  skipped: number;
  drifts: {
    refKind: BudgetRefKind;
    refId: string;
    refName: string;
    budgetId: Id<"budgets">;
    entityValueUsd: number | null;
    rowAmountUsd: number | null;
  }[];
  isDone: boolean;
  continueCursor: string;
}> {
  if (chapterId) {
    const chapter = await ctx.db.get(chapterId);
    if (!chapter) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Chapter not found." });
    }
  }

  const page = await (chapterId
    ? ctx.db.query("budgets").withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
    : ctx.db.query("budgets")
  ).paginate(paginationOpts);

  let scanned = 0;
  let fixed = 0;
  let alreadySynced = 0;
  let skipped = 0;
  const drifts: {
    refKind: BudgetRefKind;
    refId: string;
    refName: string;
    budgetId: Id<"budgets">;
    entityValueUsd: number | null;
    rowAmountUsd: number | null;
  }[] = [];

  for (const b of page.page) {
    const refKind = effectiveRefKind(b);
    if (!refKind || !b.scopeRefId) continue; // recurring/central — nothing to mirror
    scanned++;
    const rowUsd = b.amountCents > 0 ? b.amountCents / 100 : undefined;

    if (refKind === "event") {
      const ev = await ctx.db.get(b.scopeRefId as Id<"events">);
      if (!ev) {
        skipped++;
        continue;
      }
      const entityUsd = ev.budget ?? undefined;
      if (entityUsd === rowUsd) {
        alreadySynced++;
        continue;
      }
      await ctx.db.patch(ev._id, { budget: rowUsd });
      fixed++;
      drifts.push({
        refKind,
        refId: String(ev._id),
        refName: ev.name,
        budgetId: b._id,
        entityValueUsd: entityUsd ?? null,
        rowAmountUsd: rowUsd ?? null,
      });
      console.log(
        `[finances] reconcileEntityBudgetDrift: event "${ev.name}" (${ev._id}) budget ` +
          `${entityUsd ?? "unset"} -> ${rowUsd ?? "unset"} (row ${b._id} wins)`,
      );
    } else {
      const project = await ctx.db.get(b.scopeRefId as Id<"projects">);
      if (!project) {
        skipped++;
        continue;
      }
      const entityUsd = project.budgetUsd ?? undefined;
      if (entityUsd === rowUsd) {
        alreadySynced++;
        continue;
      }
      await ctx.db.patch(project._id, { budgetUsd: rowUsd });
      fixed++;
      drifts.push({
        refKind,
        refId: String(project._id),
        refName: project.name,
        budgetId: b._id,
        entityValueUsd: entityUsd ?? null,
        rowAmountUsd: rowUsd ?? null,
      });
      console.log(
        `[finances] reconcileEntityBudgetDrift: project "${project.name}" (${project._id}) ` +
          `budgetUsd ${entityUsd ?? "unset"} -> ${rowUsd ?? "unset"} (row ${b._id} wins)`,
      );
    }
  }

  console.log(
    `[finances] reconcileEntityBudgetDrift: scanned ${scanned}, fixed ${fixed}, ` +
      `already synced ${alreadySynced}, skipped ${skipped}, isDone ${page.isDone}.`,
  );

  return {
    scanned,
    fixed,
    alreadySynced,
    skipped,
    drifts,
    isDone: page.isDone,
    continueCursor: page.continueCursor,
  };
}

/**
 * Companion sweep to `reconcileEntityBudgetDrift` (WP-U2 review): that
 * migration can only fix an entity that ALREADY has a budget row — it
 * paginates `budgets`, so a ref with NO row is invisible to it. That's
 * exactly the "field set, no row" dead state the review flagged: a
 * non-training event/project with a POSITIVE `budget`/`budgetUsd` field and
 * no matching row (e.g. one summoned before the owner rule existed, or left
 * behind by the edit-path trigger's old transition-guard bug — see the fixed
 * guard in `events.updateDetails`/`projects.update`) had nothing that could
 * ever summon its row: the field-only branch always compared the incoming
 * amount against the entity's OWN already-positive field, so the "unset/0 ->
 * positive" transition could never re-fire once the field was already set.
 *
 * Paginates `events`/`projects` DIRECTLY (not `budgets` — there's nothing
 * there to find for a row-less ref), one `refKind` per call so the two entity
 * tables stay independently pageable. For each money-carrying, non-training
 * ref with no existing row, summons + mirrors one via the same D8 creation
 * helpers (`createEventBudget`/`createProjectBudget`) the create-time hook
 * uses, so a healed row is indistinguishable from one made any other way.
 * SKIPS `isTraining` events (the same invariant enforced everywhere else in
 * this file) and any ref with no positive field value (owner rule — nothing
 * to heal). Idempotent: a settled re-run finds every ref already has a row
 * and heals nothing.
 *
 * Run locally:  npx convex run finances:healRowlessEntityBudgets '{"refKind":"event"}'
 * Run on prod (first page):  npx convex run --prod finances:healRowlessEntityBudgets '{"refKind":"event"}'
 * Run on prod (next page):   npx convex run --prod finances:healRowlessEntityBudgets '{"refKind":"event","paginationOpts":{"numItems":500,"cursor":"<continueCursor>"}}'
 * Run on prod (projects):    npx convex run --prod finances:healRowlessEntityBudgets '{"refKind":"project"}'
 */
export async function runHealRowlessEntityBudgets(
  ctx: MutationCtx,
  refKind: BudgetRefKind,
  chapterId: Id<"chapters"> | undefined,
  paginationOpts: { cursor: string | null; numItems: number },
): Promise<{
  scanned: number;
  healed: number;
  isDone: boolean;
  continueCursor: string;
  healedRefs: {
    refKind: BudgetRefKind;
    refId: string;
    refName: string;
    budgetId: Id<"budgets">;
    amountUsd: number;
  }[];
}> {
  if (chapterId) {
    const chapter = await ctx.db.get(chapterId);
    if (!chapter) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Chapter not found." });
    }
  }

  let scanned = 0;
  let healed = 0;
  const healedRefs: {
    refKind: BudgetRefKind;
    refId: string;
    refName: string;
    budgetId: Id<"budgets">;
    amountUsd: number;
  }[] = [];

  if (refKind === "event") {
    const page = await (chapterId
      ? ctx.db.query("events").withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      : ctx.db.query("events")
    ).paginate(paginationOpts);

    for (const ev of page.page) {
      if (ev.isTraining) continue; // training events never get a budget row
      if (ev.budget == null || ev.budget <= 0) continue; // owner rule: no money, no row
      scanned++;
      if (await hasBudgetForRef(ctx, "event", ev._id)) continue; // already healthy
      await createEventBudget(ctx, ev, undefined);
      const created = await getBudgetForRef(ctx, "event", ev._id);
      healed++;
      healedRefs.push({
        refKind,
        refId: String(ev._id),
        refName: ev.name,
        budgetId: created!._id,
        amountUsd: ev.budget,
      });
      console.log(
        `[finances] healRowlessEntityBudgets: summoned + mirrored a budget for event ` +
          `"${ev.name}" (${ev._id}) at $${ev.budget} — was field-only, no row.`,
      );
    }
    return { scanned, healed, isDone: page.isDone, continueCursor: page.continueCursor, healedRefs };
  }

  const page = await (chapterId
    ? ctx.db.query("projects").withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
    : ctx.db.query("projects")
  ).paginate(paginationOpts);

  for (const project of page.page) {
    if (project.budgetUsd == null || project.budgetUsd <= 0) continue; // owner rule
    scanned++;
    if (await hasBudgetForRef(ctx, "project", project._id)) continue; // already healthy
    await createProjectBudget(ctx, project, undefined);
    const created = await getBudgetForRef(ctx, "project", project._id);
    healed++;
    healedRefs.push({
      refKind,
      refId: String(project._id),
      refName: project.name,
      budgetId: created!._id,
      amountUsd: project.budgetUsd,
    });
    console.log(
      `[finances] healRowlessEntityBudgets: summoned + mirrored a budget for project ` +
        `"${project.name}" (${project._id}) at $${project.budgetUsd} — was field-only, no row.`,
    );
  }
  return { scanned, healed, isDone: page.isDone, continueCursor: page.continueCursor, healedRefs };
}
