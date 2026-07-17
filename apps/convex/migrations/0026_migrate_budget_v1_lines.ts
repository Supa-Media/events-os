import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { ensureBudgetForRef } from "../finances";
import type { Migration } from "./index";

/**
 * ONE money surface per event — retire Budget v1 (`budgetLineItems`, the
 * per-event typed line-item budget from `docs/plans/budget.md`) onto the v2
 * finance plan (`budgetLines`, WP-3.1), the same table Finances' "Plan this
 * budget" panel and the event Money tab's new "Edit plan" affordance both
 * write to. `budget.ts` + `schema/budget.ts` are deleted in this same PR — see
 * that PR's own body for the "Convex requires an empty table before its
 * definition is dropped" operational note (this migration is what empties it).
 *
 * For every event with `budgetLineItems` rows:
 *   1. Get-or-create the event's v2 finance `budgets` row (`ensureBudgetForRef`
 *      — the SAME get-or-create Finances' "For" picker summon-on-pick and
 *      `instantiateEvent`'s create-time hook use, so a migrated event's budget
 *      is indistinguishable from a natively-created one). SKIPPED for a
 *      training event — the #172 invariant ("training events NEVER get a
 *      budget row") is enforced by every v2 creation path, and Budget v1 had
 *      no such gate (`budget.ts#addLineItem` never checked `isTraining`), so a
 *      training event with leftover v1 lines is possible. Its rows are NOT
 *      migrated (no budget is ever summoned for a training event — the #172
 *      invariant is never violated) but ARE still DELETED (Opus review,
 *      PR #214, 2026-07-17): leaving them in place would mean the table
 *      doesn't always end up empty, and this same PR drops `budgetLineItems`
 *      from the schema right after this migration runs — Convex requires a
 *      table be empty before its definition is dropped, so a training
 *      event's leftover rows would silently break that precondition on any
 *      deployment that happens to have one. Counted (`trainingEventsSkipped`
 *      for the event, `trainingRowsDropped` for the rows) and
 *      `console.warn`-ed per event, so the drop is loud, not silent — see
 *      the module doc's "nothing silently vanishes" rule.
 *   2. Insert each v1 line as a `budgetLines` row, in `order`:
 *        label        -> description
 *        plannedCents -> plannedCents
 *        category     -> categoryId, via CATEGORY_NAME_HINT below (best-effort
 *                         name match against the event's OWN chapter's real
 *                         `budgetCategories` — categories are free-form and
 *                         chapter-authored, so v1's 7 generic literals have no
 *                         guaranteed v2 counterpart). No match -> `categoryId`
 *                         left unset (uncategorized) rather than fabricating a
 *                         new chapter category nobody asked for.
 *      `budgetLines.plannedCents` must be a POSITIVE integer (`addLine`'s
 *      `assertPlannedCents` invariant — "a $0 line plans nothing"), unlike
 *      v1's `assertNonNegativeCents` (0 allowed). A v1 line planned at exactly
 *      $0 has no v2 representation, so it's SKIPPED and counted
 *      (`zeroPlannedSkipped`), never inserted as a rule-violating 0.
 *   3. NOT migrated (counted, not silently dropped):
 *        - `actualCents` (`actualsSkipped`) — v1 tracked an actual PER LINE;
 *          v2's actual side is `transactions` (budget-first, no per-line
 *          linkage), an entirely different shape. A v1 line's actual dollar
 *          figure has no v2 destination; the underlying spend, if any, was
 *          never a real `transactions` row either (Budget v1 never touched
 *          Finances) so there's nothing to backfill it INTO.
 *        - `receiptStorageId` (`receiptsSkipped`) — same reasoning: v2 has no
 *          per-plan-line receipt concept (receipts live on `transactions`).
 *   4. DELETE the migrated event's `budgetLineItems` rows (drains the table so
 *      the schema can drop it — see the PR body's Convex-constraint note).
 *
 * Idempotent + ledgered: `schemaMigrations` is belt-and-suspenders (this run
 * body is also independently safe to re-run) — once an event's
 * `budgetLineItems` rows are deleted, a second pass finds nothing left for it.
 * This ALWAYS drains the table to empty in one pass (training events
 * included) — the schema-drop precondition in the same PR always holds.
 * `(ctx.db as any).query("budgetLineItems")` — the table is undeclared in
 * THIS PR's schema (deleted alongside `schema/budget.ts`), so this mirrors the
 * exact `guestAllowlist`/`cleanupLegacyRoles` precedent (`0017_purge_guest_
 * allowlist.ts`) for reading a table the current schema no longer names.
 */

// v1's 7 generic category literals -> a best-effort name hint to match
// against the event's own chapter's real `budgetCategories.name` (free-form,
// chapter-authored — never guaranteed to exist). Case-insensitive exact match
// only (no fuzzy/substring guessing) — a near-miss is safer left uncategorized
// than silently mis-filed under the wrong finance category. "other" has no
// hint at all: it was always v1's catch-all, so it stays uncategorized.
const CATEGORY_NAME_HINT: Record<string, string | null> = {
  venue: "venue",
  production: "production",
  food: "food",
  marketing: "marketing",
  permits: "permits",
  transport: "transport",
  other: null,
};

const EVENT_SCAN_LIMIT = 20000;
const LINES_PER_EVENT_LIMIT = 500;

/** Best-effort v1 category -> v2 `budgetCategories._id`, scoped to the
 *  event's own chapter (categories are always chapter-scoped, never central —
 *  mirrors `budgetLines.ts#verifyCategory`'s own rule). */
async function resolveCategoryId(
  ctx: MutationCtx,
  chapterId: Id<"chapters">,
  v1Category: string,
  cache: Map<string, Id<"budgetCategories"> | null>,
): Promise<Id<"budgetCategories"> | undefined> {
  const cacheKey = `${chapterId}:${v1Category}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey) ?? undefined;

  const hint = CATEGORY_NAME_HINT[v1Category] ?? null;
  if (!hint) {
    cache.set(cacheKey, null);
    return undefined;
  }
  const categories = await ctx.db
    .query("budgetCategories")
    .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
    .collect();
  const match = categories.find((c) => c.name.trim().toLowerCase() === hint);
  cache.set(cacheKey, match?._id ?? null);
  return match?._id;
}

export async function runMigrateBudgetV1Lines(ctx: MutationCtx) {
  let events = 0;
  let linesMigrated = 0;
  let zeroPlannedSkipped = 0;
  let actualsSkipped = 0;
  let receiptsSkipped = 0;
  let trainingEventsSkipped = 0;
  let trainingRowsDropped = 0;
  let budgetLineItemsDeleted = 0;

  // Group v1 lines by event — `budgetLineItems` has no `by_event`-then-all
  // shortcut other than scanning the whole (small, per-line-item-per-event)
  // table once and bucketing in memory, same scale class as the other
  // per-event backfills in this registry.
  const allLines = (await (ctx.db as any)
    .query("budgetLineItems")
    .take(EVENT_SCAN_LIMIT)) as Doc<any>[];
  if (allLines.length === EVENT_SCAN_LIMIT) {
    console.warn(
      `[0026_migrate_budget_v1_lines] hit EVENT_SCAN_LIMIT (${EVENT_SCAN_LIMIT}) reading budgetLineItems; a later run is needed to finish draining the table.`,
    );
  }

  const byEvent = new Map<string, Doc<any>[]>();
  for (const line of allLines) {
    const key = String(line.eventId);
    const bucket = byEvent.get(key);
    if (bucket) bucket.push(line);
    else byEvent.set(key, [line]);
  }

  const categoryCache = new Map<string, Id<"budgetCategories"> | null>();

  for (const [eventIdStr, lines] of byEvent) {
    const eventId = eventIdStr as Id<"events">;
    const event = await ctx.db.get(eventId);
    if (!event) {
      // Orphaned lines (event since deleted) — still drain them, nothing to
      // migrate them ONTO.
      for (const line of lines) {
        await ctx.db.delete(line._id);
        budgetLineItemsDeleted++;
      }
      continue;
    }
    if (event.isTraining === true) {
      // NOT migrated (no budget summoned — #172 stays inviolate) but ALWAYS
      // deleted so the table still ends up fully drained — see the module
      // doc's Opus-review note. Loud, not silent: a console.warn per event.
      trainingEventsSkipped++;
      for (const line of lines) {
        await ctx.db.delete(line._id);
        trainingRowsDropped++;
        budgetLineItemsDeleted++;
      }
      console.warn(
        `[0026_migrate_budget_v1_lines] dropped ${lines.length} budgetLineItems row(s) for training event ${eventId} (never migrated — training events never get a budget, #172).`,
      );
      continue;
    }

    const budgetId = await ensureBudgetForRef(
      ctx,
      event.chapterId,
      "event",
      eventId,
      undefined, // no-auth migration caller, mirrors `migrateLinksToBudgets`.
    );

    const existingLines = await ctx.db
      .query("budgetLines")
      .withIndex("by_budget", (q) => q.eq("budgetId", budgetId))
      .take(LINES_PER_EVENT_LIMIT);
    let nextSortOrder =
      existingLines.length === 0
        ? 0
        : Math.max(...existingLines.map((l) => l.sortOrder)) + 1;

    events++;
    const sorted = [...lines].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    for (const line of sorted) {
      if (line.actualCents != null) actualsSkipped++;
      if (line.receiptStorageId != null) receiptsSkipped++;

      if (line.plannedCents > 0) {
        const categoryId = await resolveCategoryId(
          ctx,
          event.chapterId,
          line.category,
          categoryCache,
        );
        await ctx.db.insert("budgetLines", {
          budgetId,
          description: line.label,
          categoryId,
          plannedCents: line.plannedCents,
          sortOrder: nextSortOrder,
          createdBy: line.createdBy,
          createdAt: line.createdAt,
        });
        nextSortOrder++;
        linesMigrated++;
      } else {
        zeroPlannedSkipped++;
      }

      await ctx.db.delete(line._id);
      budgetLineItemsDeleted++;
    }
  }

  return {
    events,
    linesMigrated,
    actualsSkipped,
    receiptsSkipped,
    zeroPlannedSkipped,
    trainingEventsSkipped,
    trainingRowsDropped,
    budgetLineItemsDeleted,
  };
}

export const migrateBudgetV1Lines: Migration = {
  name: "0026_migrate_budget_v1_lines",
  run: runMigrateBudgetV1Lines,
};
