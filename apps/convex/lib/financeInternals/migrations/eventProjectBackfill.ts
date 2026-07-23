import { ConvexError } from "convex/values";
import { Doc, Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { easternParts } from "@events-os/shared";
import { eventBudgetLabel, projectBudgetLabel } from "../budgetRefLifecycle";
import { autoTagEventBudget, autoTagProjectBudget } from "../budgetTags";
import { ROLLUP_SCAN_LIMIT } from "../constants";

/**
 * Backfill body: give every existing EVENT a one_time budget so it appears in
 * the finance dashboard's "Events & Projects" section and charges can roll up
 * per event. Mirrors what `createBudget` writes for a one_time event budget
 * (`type:"one_time"`, `refKind:"event"`, `scopeRefId:<eventId>`,
 * `cadence:"per_instance"`) and reuses `autoTagEventBudget` for the eventType
 * `template` tag + the catch-all "events" tag.
 *
 * Bounded + idempotent:
 *  - Scans one chapter's events (via `by_chapter`) or a bounded slice of all
 *    events when `chapterId` is omitted.
 *  - SKIPS an event that already has an attached budget — v2 (`type:"one_time"`)
 *    OR legacy (`scope:"event"`) — with a matching `scopeRefId`, so re-runs are
 *    no-ops.
 *  - SKIPS `isTraining` events: training events must never pollute finance
 *    rollups (same invariant that excludes them from dashboard rollups).
 *  - Owner rule ("budgets only exist when money does"): SKIPS an event with no
 *    positive `budget` (unset, 0, or negative) — a budget object with nothing
 *    in it is dashboard clutter, not a useful planning row. `amountCents` =
 *    the event's `budget` (dollars) × 100 as an integer for the events this
 *    creates a budget for. `year`/`month` come from the event's `eventDate` in
 *    Eastern time so the budget lands in the event's month on the dashboard.
 */
export async function runBackfillEventBudgets(
  ctx: MutationCtx,
  chapterId?: Id<"chapters">,
): Promise<{ created: number; skipped: number; relabeled: number; tagsLinked: number }> {
  let created = 0;
  let skipped = 0;
  let relabeled = 0;
  let tagsLinked = 0;

  // Guard: a passed chapter must exist (ConvexError, not a silent no-op).
  if (chapterId) {
    const chapter = await ctx.db.get(chapterId);
    if (!chapter) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Chapter not found." });
    }
  }

  // Bounded event scan: one chapter via index, else a bounded full slice.
  const events = chapterId
    ? await ctx.db
        .query("events")
        .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
        .take(ROLLUP_SCAN_LIMIT)
    : await ctx.db.query("events").take(ROLLUP_SCAN_LIMIT);

  // Disambiguation counts over the scanned (non-training) events, keyed by
  // chapter so a name is only "repeated" within its own chapter: how many events
  // share a name, and how many share a name AND an Eastern year+month. Drives
  // `eventBudgetLabel` on both the create and the relabel path.
  const nameCounts = new Map<string, number>();
  const nameMonthCounts = new Map<string, number>();
  const NUL = " ";
  for (const ev of events) {
    if (ev.isTraining) continue; // training events never get a budget
    if (ev.budget == null || ev.budget <= 0) continue; // owner rule: no money, no budget
    const p = easternParts(ev.eventDate);
    const nk = `${ev.chapterId}${NUL}${ev.name}`;
    const mk = `${nk}${NUL}${p.year}-${p.month}`;
    nameCounts.set(nk, (nameCounts.get(nk) ?? 0) + 1);
    nameMonthCounts.set(mk, (nameMonthCounts.get(mk) ?? 0) + 1);
  }

  // Per-chapter cache of the existing event budget keyed by `scopeRefId`, so
  // dedup costs one bounded read per chapter instead of one per event. Holding
  // the doc (not just the id) lets the dedup path relabel an unlabeled budget.
  const eventBudgetByRefByChapter = new Map<string, Map<string, Doc<"budgets">>>();
  const eventBudgetsByRef = async (
    cid: Id<"chapters">,
  ): Promise<Map<string, Doc<"budgets">>> => {
    const key = cid as string;
    const cached = eventBudgetByRefByChapter.get(key);
    if (cached) return cached;
    const map = new Map<string, Doc<"budgets">>();
    const rows = await ctx.db
      .query("budgets")
      .withIndex("by_chapter", (q) => q.eq("chapterId", cid))
      .take(ROLLUP_SCAN_LIMIT);
    for (const b of rows) {
      // Already attached to an event: v2 one_time OR legacy scope:"event".
      if ((b.type === "one_time" || b.scope === "event") && b.scopeRefId && !map.has(b.scopeRefId)) {
        map.set(b.scopeRefId, b);
      }
    }
    eventBudgetByRefByChapter.set(key, map);
    return map;
  };

  for (const ev of events) {
    // Training events never pollute finance rollups (schema invariant).
    if (ev.isTraining) {
      skipped++;
      continue;
    }
    // Owner rule: no positive budget → no budget object. Existing zero-amount
    // budgets from before this rule aren't touched here — see
    // `removeEmptyAutoBudgets` for that cleanup.
    if (ev.budget == null || ev.budget <= 0) {
      skipped++;
      continue;
    }
    const cid = ev.chapterId;
    const existing = await eventBudgetsByRef(cid);
    // The disambiguated label for this event (name, name+month, or name+date).
    const parts = easternParts(ev.eventDate);
    const nk = `${cid}${NUL}${ev.name}`;
    const mk = `${nk}${NUL}${parts.year}-${parts.month}`;
    const label = eventBudgetLabel(
      ev.name,
      parts,
      nameCounts.get(nk) ?? 1,
      nameMonthCounts.get(mk) ?? 1,
    );
    // Dedup: skip if this event already has a budget. Backfill re-run: if that
    // existing budget has no label, name it after the event so the budgets
    // created before this fix get labeled (idempotent — a settled re-run finds
    // labels already set and relabels nothing).
    const existingBudget = existing.get(ev._id as string);
    if (existingBudget) {
      if (!existingBudget.label) {
        await ctx.db.patch(existingBudget._id, { label });
        relabeled++;
      }
      skipped++;
      continue;
    }

    // events.budget is ESTIMATED dollars; finance money is integer cents.
    const amountCents = ev.budget != null ? Math.round(ev.budget * 100) : 0;

    const budgetId = await ctx.db.insert("budgets", {
      chapterId: cid,
      amountCents,
      // Name the budget after its event (disambiguated) so the picker/tag-detail
      // shows the event name rather than falling back to the "One-time" type word.
      label,
      type: "one_time",
      refKind: "event",
      scopeRefId: ev._id,
      cadence: "per_instance",
      year: parts.year,
      month: parts.month,
      createdAt: Date.now(),
    });
    // Guard against a duplicate event id within the same run re-creating.
    existing.set(ev._id as string, (await ctx.db.get(budgetId))!);

    // Auto-tag: the eventType `template` tag + the catch-all "events" tag.
    const seen = new Set<string>();
    await autoTagEventBudget(ctx, budgetId, cid, ev._id as string, seen);
    tagsLinked += seen.size;
    created++;
  }

  return { created, skipped, relabeled, tagsLinked };
}

/**
 * Backfill body: give every existing PROJECT a one_time budget so it appears
 * in the finance dashboard's "Events & Projects" section and charges can roll
 * up per project. Mirrors what `runBackfillEventBudgets` writes for an event
 * (`type:"one_time"`, `cadence:"per_instance"`), swapping `refKind:"project"`
 * + `scopeRefId:<projectId>` and reusing `autoTagProjectBudget` for the
 * catch-all "Projects" tag instead of the event's template + "events" tags.
 *
 * Bounded + idempotent, same shape as the event backfill:
 *  - Scans one chapter's projects (via `by_chapter`) or a bounded slice of all
 *    projects when `chapterId` is omitted.
 *  - SKIPS a project that already has an attached budget — v2
 *    (`type:"one_time"`) OR legacy (`scope:"project"`) — with a matching
 *    `scopeRefId`, so re-runs are no-ops.
 *  - Projects have no `isTraining` flag (that's event-only), so there's no
 *    training skip here.
 *  - Owner rule ("budgets only exist when money does"): SKIPS a project with
 *    no positive `budgetUsd` (unset, 0, or negative) — many projects are
 *    work-tracking only and a budget object with nothing in it is dashboard
 *    clutter, not a useful planning row. `amountCents` = the project's
 *    `budgetUsd` (dollars, Estimated) × 100 as an integer for the projects
 *    this creates a budget for — `projects.budgetUsd` itself is left untouched
 *    (Estimated-vs-Actual invariant; the budgets table is the planning object
 *    going forward, but the legacy field isn't deleted in this PR). `year`/
 *    `month` come from the project's `startDate` (falling back to `createdAt`
 *    when unset — a project has no required instance date the way an event's
 *    `eventDate` is required) in Eastern time.
 *  - A project's budget always lands at the project's OWN chapter — projects
 *    can't be central yet (WP-2.2 finding). If `transferProjectScope` later
 *    moves the project's money to central, it discovers this budget via the
 *    `by_ref` index (`refKind:"project"` + `scopeRefId`), independent of which
 *    chapter currently owns it — see that mutation's comment.
 */
export async function runBackfillProjectBudgets(
  ctx: MutationCtx,
  chapterId?: Id<"chapters">,
): Promise<{ created: number; skipped: number; relabeled: number; tagsLinked: number }> {
  let created = 0;
  let skipped = 0;
  let relabeled = 0;
  let tagsLinked = 0;

  // Guard: a passed chapter must exist (ConvexError, not a silent no-op).
  if (chapterId) {
    const chapter = await ctx.db.get(chapterId);
    if (!chapter) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Chapter not found." });
    }
  }

  // Bounded project scan: one chapter via index, else a bounded full slice.
  const projects = chapterId
    ? await ctx.db
        .query("projects")
        .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
        .take(ROLLUP_SCAN_LIMIT)
    : await ctx.db.query("projects").take(ROLLUP_SCAN_LIMIT);

  // Disambiguation counts over the scanned projects, keyed by chapter so a
  // name is only "repeated" within its own chapter — mirrors the event
  // backfill's `nameCounts`/`nameMonthCounts`.
  const nameCounts = new Map<string, number>();
  const nameMonthCounts = new Map<string, number>();
  const NUL = " ";
  for (const p of projects) {
    if (p.budgetUsd == null || p.budgetUsd <= 0) continue; // owner rule: no money, no budget
    // `deadline` first — see `createProjectBudget`'s twin comment (budget
    // identity & dates fix): this loop duplicates that function's dating
    // logic rather than calling it, so it needs the same fix independently.
    const parts = easternParts(p.deadline ?? p.startDate ?? p.createdAt);
    const nk = `${p.chapterId}${NUL}${p.name}`;
    const mk = `${nk}${NUL}${parts.year}-${parts.month}`;
    nameCounts.set(nk, (nameCounts.get(nk) ?? 0) + 1);
    nameMonthCounts.set(mk, (nameMonthCounts.get(mk) ?? 0) + 1);
  }

  // Per-chapter cache of the existing project budget keyed by `scopeRefId`,
  // so dedup costs one bounded read per chapter instead of one per project.
  const projectBudgetByRefByChapter = new Map<string, Map<string, Doc<"budgets">>>();
  const projectBudgetsByRef = async (
    cid: Id<"chapters">,
  ): Promise<Map<string, Doc<"budgets">>> => {
    const key = cid as string;
    const cached = projectBudgetByRefByChapter.get(key);
    if (cached) return cached;
    const map = new Map<string, Doc<"budgets">>();
    const rows = await ctx.db
      .query("budgets")
      .withIndex("by_chapter", (q) => q.eq("chapterId", cid))
      .take(ROLLUP_SCAN_LIMIT);
    for (const b of rows) {
      // Already attached to a project: v2 one_time OR legacy scope:"project".
      if ((b.type === "one_time" || b.scope === "project") && b.scopeRefId && !map.has(b.scopeRefId)) {
        map.set(b.scopeRefId, b);
      }
    }
    projectBudgetByRefByChapter.set(key, map);
    return map;
  };

  for (const p of projects) {
    // Owner rule: no positive budgetUsd → no budget object. Existing
    // zero-amount budgets from before this rule aren't touched here — see
    // `removeEmptyAutoBudgets` for that cleanup.
    if (p.budgetUsd == null || p.budgetUsd <= 0) {
      skipped++;
      continue;
    }
    const cid = p.chapterId;
    const existing = await projectBudgetsByRef(cid);
    const parts = easternParts(p.deadline ?? p.startDate ?? p.createdAt);
    const nk = `${cid}${NUL}${p.name}`;
    const mk = `${nk}${NUL}${parts.year}-${parts.month}`;
    const label = projectBudgetLabel(
      p.name,
      parts,
      nameCounts.get(nk) ?? 1,
      nameMonthCounts.get(mk) ?? 1,
    );

    // Dedup: skip if this project already has a budget. Backfill re-run: if
    // that existing budget has no label, name it after the project.
    const existingBudget = existing.get(p._id as string);
    if (existingBudget) {
      if (!existingBudget.label) {
        await ctx.db.patch(existingBudget._id, { label });
        relabeled++;
      }
      skipped++;
      continue;
    }

    // projects.budgetUsd is ESTIMATED dollars; finance money is integer cents.
    const amountCents = p.budgetUsd != null ? Math.round(p.budgetUsd * 100) : 0;

    const budgetId = await ctx.db.insert("budgets", {
      chapterId: cid,
      amountCents,
      label,
      type: "one_time",
      refKind: "project",
      scopeRefId: p._id,
      cadence: "per_instance",
      year: parts.year,
      month: parts.month,
      createdAt: Date.now(),
    });
    // Guard against a duplicate project id within the same run re-creating.
    existing.set(p._id as string, (await ctx.db.get(budgetId))!);

    const seen = new Set<string>();
    await autoTagProjectBudget(ctx, budgetId, cid, seen);
    tagsLinked += seen.size;
    created++;
  }

  return { created, skipped, relabeled, tagsLinked };
}
