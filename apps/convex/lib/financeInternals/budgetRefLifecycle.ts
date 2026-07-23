import { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { easternParts, type BudgetRefKind } from "@events-os/shared";
import { autoTagEventBudget, autoTagProjectBudget } from "./budgetTags";
import { MONTH_NAMES, ROLLUP_SCAN_LIMIT } from "./constants";

/**
 * The display label for an EVENT budget, disambiguating repeated event names so
 * two events called the same thing don't both read as "Field Day" in the picker:
 *  - unique name in the chapter        → just the name          (`Field Day`)
 *  - same name in DIFFERENT months     → name + month + year    (`Field Day · March 2026`)
 *  - same name in the SAME month       → name + full date       (`Field Day · Mar 15, 2026`)
 *
 * `nameCount` = how many of the chapter's (non-training) events share this exact
 * name (INCLUDING this one); `sameMonthCount` = how many of those also fall in
 * this event's Eastern year+month (INCLUDING this one). `parts` is the event's
 * `easternParts(eventDate)`. Shared by `createBudget` and the backfill.
 */
export function eventBudgetLabel(
  name: string,
  parts: { year: number; month: number; day: number },
  nameCount: number,
  sameMonthCount: number,
): string {
  if (nameCount <= 1) return name;
  const monthName = MONTH_NAMES[parts.month - 1];
  if (sameMonthCount > 1) {
    // Same name, same month → the full date pins down which occurrence.
    return `${name} · ${monthName.slice(0, 3)} ${parts.day}, ${parts.year}`;
  }
  return `${name} · ${monthName} ${parts.year}`;
}

/**
 * WP-wave4 (HIGH, opus review 2026-07-17): a budget with a real starting
 * amount must NEVER be born approved. Every auto-created budget (an entity's
 * create-time hook, its edit-path "dollar entry summons a row" trigger, or
 * `healRowlessEntityBudgets`' sweep) now starts in `"draft"` exactly like a
 * hand-created one via `finances.createBudget` — so item 5's approval gate
 * (`isAttributableBudget`) correctly blocks attribution until someone sends
 * it for review and it's approved (draft → send → approve, same as any
 * other budget; the owner's superuser one-party approve, item 8, makes a
 * solo backfill workable in three taps). A `$0` SUMMON (`ensureBudgetForRef`'s
 * get-or-create, no real allocation yet) is the one exception — it stays
 * unset/grandfathered-shaped exactly as before; there's nothing to gate
 * until a real amount is entered, at which point `setBudgetAmount`'s I1
 * retrigger rule (the grandfathered-row-first-increase case) already flips
 * it to a draft increase requiring an explicit send. EXISTING budgets
 * (already `undefined`/grandfathered before this PR) are UNTOUCHED — no
 * migration, no backfill; this only changes what a NEW row starts as.
 */
function autoCreatedBudgetApprovalStatus(amountCents: number): "draft" | undefined {
  return amountCents > 0 ? "draft" : undefined;
}

/**
 * Create a one_time EVENT budget for a single event — mirrors what
 * `runBackfillEventBudgets` writes (`type:"one_time"`, `refKind:"event"`,
 * `cadence:"per_instance"`) and reuses `eventBudgetLabel` (sibling
 * disambiguation against LIVE events, a single bounded query — same split
 * `createBudget`/`runBackfillEventBudgets` use) + `autoTagEventBudget` (the
 * eventType template tag + the catch-all "events" tag).
 *
 * Callers gate the "only when there's money" owner rule THEMSELVES (budgets
 * only exist when money does — see `instantiateEvent`'s create-time hook and
 * `events.updateDetails`'s edit-path trigger, both of which only call this
 * when `!isTraining && budget > 0`); this function always creates.
 */
export async function createEventBudget(
  ctx: MutationCtx,
  event: {
    _id: Id<"events">;
    chapterId: Id<"chapters">;
    name: string;
    eventDate: number;
    budget?: number;
  },
  // Optional — absent for a no-auth caller (the WP-U `migrateLinksToBudgets`
  // migration summons a budget with no authenticated user; mirrors
  // `autoTagEventBudget`'s already-optional `createdBy`).
  userId: Id<"users"> | undefined,
): Promise<void> {
  const parts = easternParts(event.eventDate);
  // Sibling (non-training) events sharing this exact name in the chapter
  // decide whether the bare name is ambiguous.
  const siblings = (
    await ctx.db
      .query("events")
      .withIndex("by_chapter", (q) => q.eq("chapterId", event.chapterId))
      .take(ROLLUP_SCAN_LIMIT)
  ).filter((e) => !e.isTraining && e.name === event.name);
  const sameMonthCount = siblings.filter((e) => {
    const ep = easternParts(e.eventDate);
    return ep.year === parts.year && ep.month === parts.month;
  }).length;
  const label = eventBudgetLabel(event.name, parts, siblings.length, sameMonthCount);

  // event.budget is ESTIMATED dollars; finance money is integer cents.
  const amountCents = event.budget != null ? Math.round(event.budget * 100) : 0;
  const budgetId = await ctx.db.insert("budgets", {
    chapterId: event.chapterId,
    amountCents,
    label,
    type: "one_time",
    refKind: "event",
    scopeRefId: event._id,
    cadence: "per_instance",
    year: parts.year,
    month: parts.month,
    createdBy: userId,
    createdAt: Date.now(),
    approvalStatus: autoCreatedBudgetApprovalStatus(amountCents),
  });
  const seen = new Set<string>();
  await autoTagEventBudget(ctx, budgetId, event.chapterId, event._id as string, seen, userId);
}

/**
 * Whether a one_time budget already exists for this event/project ref, via the
 * `by_ref` index — independent of which chapter/central level currently owns
 * it (a project's/event's own `chapterId` never changes, but its BUDGET can
 * move scope; `by_ref` finds it either way — see the schema comment on
 * `budgets.by_ref`). Used by the create-time hooks' edit-path triggers
 * (`projects.update`, `events.updateDetails`) to avoid summoning a duplicate
 * budget when one already exists (from the create-time hook or a backfill run).
 */
export async function hasBudgetForRef(
  ctx: QueryCtx,
  refKind: BudgetRefKind,
  scopeRefId: string,
): Promise<boolean> {
  const existing = await ctx.db
    .query("budgets")
    .withIndex("by_ref", (q) => q.eq("refKind", refKind).eq("scopeRefId", scopeRefId))
    .first();
  return existing != null;
}

/**
 * The one_time budget attached to this event/project ref, if any — same
 * `by_ref` lookup as `hasBudgetForRef`, returning the row itself. WP-U2 ("the
 * budgets row is the single source of truth"): callers use this to read the
 * ref's PLANNED amount instead of the entity's own `budgetUsd`/`budget` field,
 * which is now a transition-period MIRROR kept in sync by `setBudgetAmount`
 * (see that function's doc comment) — WP-U2 phase B breadcrumb: once every
 * reader is swept onto this, the mirrored field itself can be dropped.
 */
export async function getBudgetForRef(
  ctx: QueryCtx,
  refKind: BudgetRefKind,
  scopeRefId: string,
): Promise<Doc<"budgets"> | null> {
  return await ctx.db
    .query("budgets")
    .withIndex("by_ref", (q) => q.eq("refKind", refKind).eq("scopeRefId", scopeRefId))
    .first();
}

/**
 * WRITE-THROUGH identity sync (budget identity & dates, item 2): when a
 * linked event/project's NAME or PERIOD-DEFINING DATE changes, repoint the
 * budget's STORED `label`/`year`/`month` at the entity's new identity — a
 * no-op when no budget is linked (`getBudgetForRef` finds nothing).
 *
 * This is distinct from (and doesn't replace) `resolveBudgetRef`'s LIVE
 * read-time resolution (WP-wave4 item 2, PR #225), which already makes a
 * rename/date-change show up correctly on every dashboard/drilldown surface
 * with no write-through at all. What LIVE resolution can't fix: the stored
 * `year` is the ONLY thing `dashboardChapter`/`dashboardCentral` key their
 * `by_chapter_and_period` fetch on — a budget whose stored `year` has
 * drifted from its entity's real year is never even fetched into the right
 * year's dashboard, no matter how live the display resolver is. So this
 * sync keeps the STORED bucket correct, which the live resolver depends on
 * being correct in the first place.
 *
 * `name` is the entity's RAW name (no sibling-disambiguation re-run) —
 * matches `resolveBudgetRef`'s own established precedent of using
 * `ev.name`/`pr.name` directly for every live display surface, so the
 * stored fallback label never diverges from what's already shown live
 * everywhere. The disambiguated `eventBudgetLabel`/`projectBudgetLabel`
 * logic stays create-time-only, unchanged.
 *
 * Called from `events.updateDetails` (name changes) + `events.reschedule`
 * AND `ai.rescheduleEvent` (both change `eventDate` — `updateDetails`
 * doesn't touch it, and the AI `reschedule_event` tool patches the date via
 * its own separate mutation rather than calling `events.reschedule`, so it
 * carries its own identical call; keep both in sync if either changes) —
 * and from `projects.update` (name/startDate/deadline changes, one
 * mutation). NOT called from `updateBudget`'s own ref conversion path
 * (owner decision: keep it simple, no auto-derivation on conversion — see
 * that function's rejection check for the paired half of this decision).
 */
export async function syncBudgetIdentityForRef(
  ctx: MutationCtx,
  refKind: BudgetRefKind,
  scopeRefId: string,
  name: string,
  periodDate: number,
): Promise<void> {
  const budget = await getBudgetForRef(ctx, refKind, scopeRefId);
  if (!budget) return;
  const parts = easternParts(periodDate);
  const patch: Record<string, unknown> = {};
  if (budget.label !== name) patch.label = name;
  if (budget.year !== parts.year) patch.year = parts.year;
  if (budget.month !== parts.month) patch.month = parts.month;
  if (Object.keys(patch).length > 0) await ctx.db.patch(budget._id, patch);
}

/**
 * The display label for a PROJECT budget — same disambiguation shape as
 * `eventBudgetLabel`, keyed off the project's `startDate` (callers fall back
 * to `createdAt` when unset, since a project has no required instance date
 * the way an event has `eventDate`):
 *  - unique name in the chapter        → just the name        (`Merch Drop`)
 *  - same name in DIFFERENT months     → name + month + year  (`Merch Drop · March 2026`)
 *  - same name in the SAME month       → name + full date     (`Merch Drop · Mar 15, 2026`)
 *
 * `nameCount`/`sameMonthCount` are INCLUSIVE of this project, like the event
 * version. Shared by `projects.create` (the create-time hook) and the backfill.
 */
export function projectBudgetLabel(
  name: string,
  parts: { year: number; month: number; day: number },
  nameCount: number,
  sameMonthCount: number,
): string {
  if (nameCount <= 1) return name;
  const monthName = MONTH_NAMES[parts.month - 1];
  if (sameMonthCount > 1) {
    return `${name} · ${monthName.slice(0, 3)} ${parts.day}, ${parts.year}`;
  }
  return `${name} · ${monthName} ${parts.year}`;
}

/**
 * Create a one_time PROJECT budget for a single project — mirrors
 * `createEventBudget` (same shape: `type:"one_time"`, `cadence:"per_instance"`,
 * `autoTagProjectBudget`'s catch-all "Projects" tag), disambiguating the label
 * against LIVE sibling projects (a single bounded query). Relocated here from
 * `projects.ts` (WP-U) so BOTH "D8 creation helpers" live together in
 * `finances.ts` — `events.ts` already imports `createEventBudget` from here;
 * `projects.ts` now imports this instead of defining it locally, and the new
 * `ensureBudgetForRef`/`summonBudgetForRef` (WP-U's "For" picker summon-on-pick)
 * can call both without a circular import between `finances.ts`/`projects.ts`.
 *
 * Callers gate the "only when there's money" owner rule THEMSELVES (see
 * `projects.create`'s create-time hook and `projects.update`'s edit-path
 * trigger); this function always creates. `budget` is left `undefined` for a
 * $0 "plan" budget (the WP-U summon flow) — `amountCents` is then 0.
 */
export async function createProjectBudget(
  ctx: MutationCtx,
  project: {
    _id: Id<"projects">;
    chapterId: Id<"chapters">;
    name: string;
    startDate?: number;
    deadline?: number;
    createdAt: number;
    budgetUsd?: number;
  },
  // Optional — see `createEventBudget`'s twin comment.
  userId: Id<"users"> | undefined,
): Promise<void> {
  // `deadline` first — it's the project's one REAL, directly-editable date
  // (see `forPickerOptions`'s "NO FABRICATED DATES" doc comment); `startDate`/
  // `createdAt` are only here because `budgets.year`/`month` are REQUIRED
  // integers (schema) that must always resolve to something, unlike a picker
  // label's optional date suffix — this is a required-fallback chain, not a
  // second instance of the fabricated-date bug that fix addressed elsewhere.
  const parts = easternParts(project.deadline ?? project.startDate ?? project.createdAt);
  // Sibling projects sharing this exact name in the chapter (includes the
  // project just inserted, since this runs after that write in the same
  // transaction) decide whether the bare name is ambiguous.
  const siblings = (
    await ctx.db
      .query("projects")
      .withIndex("by_chapter", (q) => q.eq("chapterId", project.chapterId))
      .take(ROLLUP_SCAN_LIMIT)
  ).filter((p) => p.name === project.name);
  const sameMonthCount = siblings.filter((p) => {
    const sp = easternParts(p.deadline ?? p.startDate ?? p.createdAt);
    return sp.year === parts.year && sp.month === parts.month;
  }).length;
  const label = projectBudgetLabel(project.name, parts, siblings.length, sameMonthCount);

  // budgetUsd is ESTIMATED dollars; finance money is integer cents. Callers
  // only reach here when budgetUsd > 0 (the owner rule's gate) — EXCEPT the
  // WP-U summon flow, which always wants a $0 "plan" budget.
  const amountCents =
    project.budgetUsd != null ? Math.round(project.budgetUsd * 100) : 0;
  const budgetId = await ctx.db.insert("budgets", {
    chapterId: project.chapterId,
    amountCents,
    label,
    type: "one_time",
    refKind: "project",
    scopeRefId: project._id,
    cadence: "per_instance",
    year: parts.year,
    month: parts.month,
    createdBy: userId,
    createdAt: Date.now(),
    // WP-wave4 (HIGH, opus review): see `createEventBudget`'s twin doc
    // comment — never born approved when a real amount is entered.
    approvalStatus: autoCreatedBudgetApprovalStatus(amountCents),
  });
  const seen = new Set<string>();
  await autoTagProjectBudget(ctx, budgetId, project.chapterId, seen, userId);
}
