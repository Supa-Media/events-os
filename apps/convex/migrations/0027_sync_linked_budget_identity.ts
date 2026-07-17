import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import {
  effectiveRefKind,
  effectiveType,
  syncBudgetIdentityForRef,
} from "../finances";
import type { Migration } from "./index";

/**
 * Budget identity & dates — one-time backfill of the STORED write-through
 * sync (`finances.ts#syncBudgetIdentityForRef`, added alongside
 * `events.updateDetails`/`events.reschedule`/`projects.update`'s new sync
 * hooks). Those hooks only fire on a FUTURE edit; every EXISTING linked
 * one_time budget whose label/year/month already drifted from its live
 * entity (a rename or date change that predates this PR, or a budget whose
 * `year`/`month` were simply wrong from creation — see the sibling
 * `createProjectBudget` dating fix) needs this one-off pass to catch up.
 *
 * For every effectively-linked one_time budget (`effectiveType`/
 * `effectiveRefKind`, tolerant of un-migrated legacy `scope`-only rows, same
 * as every other v2 reader in this file):
 *  - resolve the live event/project; if it no longer resolves (deleted, no
 *    cascade), SKIP it entirely — untouched, counted (`refNotFound`), never
 *    patched onto a stale label just because its ref vanished (matches
 *    `resolveBudgetRef`'s own "fallback to stored label" precedent for a
 *    dead ref).
 *  - otherwise reuse `syncBudgetIdentityForRef` (the SAME function the live
 *    hooks call) with the entity's raw name + real period date (an event's
 *    `eventDate`, or a project's `deadline ?? startDate ?? createdAt`) — so
 *    the migration and the live sync path are provably identical, never a
 *    second reimplementation that could drift from it.
 *
 * Idempotent by construction: `syncBudgetIdentityForRef` only patches on an
 * actual diff, so a second run finds nothing left to change.
 *
 * Run locally:   npx convex run migrations:runPending
 * Run on prod:   npx convex run --prod migrations:runPending
 */

// Honestly bounded, NOT paginated: `.take()` with no cursor always returns
// the SAME first BUDGET_SCAN_LIMIT rows in `_creationTime` order, so a
// re-run can NEVER reach further rows if this limit is ever hit — re-running
// would just reprocess this same page (harmless, since the sync is
// idempotent, but it makes zero additional progress). Prod is well under 1k
// budgets today, so this bound is not expected to ever bind; if it does, the
// warn below says so loudly rather than implying "run it again."
const BUDGET_SCAN_LIMIT = 20000;

export async function runSyncLinkedBudgetIdentity(ctx: MutationCtx) {
  let scanned = 0;
  let linked = 0;
  let synced = 0;
  let unchanged = 0;
  let refNotFound = 0;

  const budgets = (await ctx.db.query("budgets").take(BUDGET_SCAN_LIMIT)) as Doc<"budgets">[];
  if (budgets.length === BUDGET_SCAN_LIMIT) {
    console.warn(
      `[0027_sync_linked_budget_identity] hit BUDGET_SCAN_LIMIT (${BUDGET_SCAN_LIMIT}) — this run did NOT cover the whole budgets table. Re-running will NOT reach the remaining rows (no cursor/pagination — .take() with no cursor always returns this same first page). This migration needs a paginated rewrite before it can be trusted at this scale.`,
    );
  }

  for (const b of budgets) {
    scanned++;
    if (effectiveType(b) !== "one_time") continue;
    const refKind = effectiveRefKind(b);
    if (!refKind || !b.scopeRefId) continue;
    linked++;

    let name: string | null = null;
    let periodDate: number | null = null;
    if (refKind === "event") {
      const event = await ctx.db.get(b.scopeRefId as Id<"events">);
      if (event) {
        name = event.name;
        periodDate = event.eventDate;
      }
    } else {
      const project = await ctx.db.get(b.scopeRefId as Id<"projects">);
      if (project) {
        name = project.name;
        periodDate = project.deadline ?? project.startDate ?? project.createdAt;
      }
    }

    if (name == null || periodDate == null) {
      refNotFound++;
      continue;
    }

    const before = { label: b.label, year: b.year, month: b.month };
    await syncBudgetIdentityForRef(ctx, refKind, b.scopeRefId, name, periodDate);
    const after = await ctx.db.get(b._id);
    const changed =
      after != null &&
      (after.label !== before.label || after.year !== before.year || after.month !== before.month);
    if (changed) synced++;
    else unchanged++;
  }

  return { scanned, linked, synced, unchanged, refNotFound };
}

export const syncLinkedBudgetIdentity: Migration = {
  name: "0027_sync_linked_budget_identity",
  run: runSyncLinkedBudgetIdentity,
};
