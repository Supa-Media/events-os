import { ConvexError } from "convex/values";
import { Doc, Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { CENTRAL, type BudgetRefKind } from "@events-os/shared";
import { ensureBudgetForRef } from "../budgetCrudHelpers";
import { budgetDisplayName } from "../budgetCore";

/** One flagged conflict row — see `migrateLinksToBudgetsConflict`'s doc
 *  comment for what each field means and why. */
export type MigrationConflict = {
  transactionId: Id<"transactions">;
  merchantName: string | null;
  postedAt: number;
  amountCents: number;
  refKind: BudgetRefKind;
  refId: string;
  refName: string;
  refBudgetId: Id<"budgets">;
  refBudgetLabel: string;
  currentBudgetId: Id<"budgets">;
  currentBudgetLabel: string;
  message: string;
};

/** The event/project's own display name for a conflict row — falls back to a
 *  placeholder for the rare case the ref itself was deleted after the FK was
 *  written (the migration still resolves+reports the conflict; it just can't
 *  name the ref). */
async function refDisplayName(
  ctx: MutationCtx,
  refKind: BudgetRefKind,
  scopeRefId: string,
): Promise<string> {
  if (refKind === "event") {
    const ev = await ctx.db.get(scopeRefId as Id<"events">);
    return ev && "name" in ev ? (ev as Doc<"events">).name : "(deleted event)";
  }
  const project = await ctx.db.get(scopeRefId as Id<"projects">);
  return project && "name" in project ? (project as Doc<"projects">).name : "(deleted project)";
}

/**
 * Migration body (WP-U phase A): backfill `transactions.budgetId` from the
 * vestigial `eventId`/`projectId` FKs — "one home per dollar" only holds once
 * every pre-existing transaction has its budget set, not just new ones. Reuses
 * `ensureBudgetForRef` (the SAME get-or-create the "For" picker's summon-on-
 * pick calls), so a migrated row's budget is indistinguishable from one a
 * human picked. Idempotent + PAGINATED (native `.paginate()`, one chapter via
 * `by_chapter` or the whole table) — unlike the other backfills in this file,
 * a migration can't settle for a bounded `.take()` that silently truncates;
 * the caller re-invokes with `continueCursor` until `isDone` to prove every
 * row was examined (see `docs/plans/link-migration-runbook.md`).
 * CLEARS NOTHING — the FKs stay put for the phase-B column drop; this phase
 * only ever ADDS a `budgetId` a transaction didn't already have.
 */
export async function runMigrateLinksToBudgets(
  ctx: MutationCtx,
  chapterId: Id<"chapters"> | undefined,
  paginationOpts: { cursor: string | null; numItems: number },
): Promise<{
  scanned: number;
  backfilled: number;
  alreadySet: number;
  conflictCount: number;
  conflicts: MigrationConflict[];
  budgetsSummoned: number;
  skipped: number;
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
    ? ctx.db.query("transactions").withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
    : ctx.db.query("transactions")
  ).paginate(paginationOpts);

  let scanned = 0;
  let backfilled = 0;
  let alreadySet = 0;
  const conflicts: MigrationConflict[] = [];
  let budgetsSummoned = 0;
  let skipped = 0;

  for (const tr of page.page) {
    if (!tr.eventId && !tr.projectId) continue;
    scanned++;
    // A central-owned txn never carries these FKs in practice
    // (`createManualTransaction`/`categorizeTransaction` always rejected the
    // combination) — skip defensively rather than assume.
    if (tr.chapterId === CENTRAL) {
      skipped++;
      continue;
    }
    const refKind: BudgetRefKind = tr.projectId ? "project" : "event";
    const scopeRefId = String(tr.projectId ?? tr.eventId);

    const before = await ctx.db
      .query("budgets")
      .withIndex("by_ref", (q) => q.eq("refKind", refKind).eq("scopeRefId", scopeRefId))
      .first();
    let refBudgetId: Id<"budgets">;
    try {
      refBudgetId = await ensureBudgetForRef(
        ctx,
        tr.chapterId,
        refKind,
        scopeRefId,
        undefined,
      );
    } catch {
      // The ref no longer exists / doesn't belong to the txn's chapter — the
      // FK is stale beyond repair. Skip rather than guess.
      skipped++;
      continue;
    }
    if (!before) budgetsSummoned++;

    if (tr.budgetId == null) {
      await ctx.db.patch(tr._id, { budgetId: refBudgetId });
      backfilled++;
    } else if (tr.budgetId === refBudgetId) {
      alreadySet++;
    } else {
      // A human already explicitly attributed this txn to a DIFFERENT budget
      // since the FK was written — keep their explicit choice, never clobber.
      // Report everything a reviewer needs to judge the conflict without a
      // follow-up query.
      const [refBudget, currentBudget, refName] = await Promise.all([
        ctx.db.get(refBudgetId),
        ctx.db.get(tr.budgetId),
        refDisplayName(ctx, refKind, scopeRefId),
      ]);
      const refBudgetLabel = refBudget ? budgetDisplayName(refBudget) : "(deleted budget)";
      const currentBudgetLabel = currentBudget
        ? budgetDisplayName(currentBudget)
        : "(deleted budget)";
      const dollars = (tr.amountCents / 100).toFixed(2);
      const merchant = tr.merchantName ? ` at ${tr.merchantName}` : "";
      const conflict = {
        transactionId: tr._id,
        merchantName: tr.merchantName ?? null,
        postedAt: tr.postedAt,
        amountCents: tr.amountCents,
        refKind,
        refId: scopeRefId,
        refName,
        refBudgetId,
        refBudgetLabel,
        currentBudgetId: tr.budgetId,
        currentBudgetLabel,
        message:
          `$${dollars}${merchant} (${new Date(tr.postedAt).toISOString().slice(0, 10)}) will ` +
          `no longer appear in ${refName}'s actuals — it's already attributed to ` +
          `"${currentBudgetLabel}" instead of "${refBudgetLabel}".`,
      };
      conflicts.push(conflict);
      console.log(`[finances] migrateLinksToBudgets conflict: ${JSON.stringify(conflict)}`);
    }
  }

  console.log(
    `[finances] migrateLinksToBudgets: scanned ${scanned}, backfilled ${backfilled}, ` +
      `already set ${alreadySet}, conflicts ${conflicts.length} (kept, not overwritten), ` +
      `budgets summoned ${budgetsSummoned}, skipped ${skipped}, isDone ${page.isDone}.`,
  );

  return {
    scanned,
    backfilled,
    alreadySet,
    conflictCount: conflicts.length,
    conflicts,
    budgetsSummoned,
    skipped,
    isDone: page.isDone,
    continueCursor: page.continueCursor,
  };
}
