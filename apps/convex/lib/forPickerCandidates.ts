/**
 * The "For" picker's shared candidate scan — used by BOTH `finances.
 * forPickerOptions` (the base grouped list) and `reconcileSuggest.
 * rankForPicker` (the ranked list) so the events/projects/budgets scan +
 * one-budget-per-ref dedup that decides "what can this transaction be
 * attributed to" lives in exactly one place.
 *
 * HISTORY: #217 had `reconcileSuggest.ts` RE-DERIVE this scan (byte-for-byte,
 * per that PR's review) because `finances.ts` was owned by a parallel worker
 * at the time — not a design choice, a scheduling one. Wave 4 then evolved
 * both copies together (approved-only filtering via `isAttributableBudget`,
 * `resolveBudgetRef`'s live ref-name/date derivation) without ever drifting —
 * re-verified byte-for-byte semantically identical immediately before this
 * extraction (see the PR body that introduced this file). This module is
 * that reconciliation: the ONE scan both surfaces now call.
 *
 * SCOPE: gathering + shaping candidates only. This does NOT filter by
 * `isAttributableBudget` — every candidate is returned, including a
 * budget-less ref (`budget: null`) or one whose budget isn't approved yet.
 * Each CALLER applies that filter itself (both already did, independently,
 * before this extraction) — keeping the attribution *policy* (what counts as
 * "approved enough to attach a charge to") out of the *scan*.
 */
import type { QueryCtx } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";
import {
  CENTRAL,
  BUDGET_TYPE_LABELS,
  easternParts,
  type BudgetType,
} from "@events-os/shared";

export type PickerCandidate = {
  refKind: "event" | "project" | "recurring";
  refId: string;
  label: string;
  /** The ref's own date for date-proximity ranking — an event's `eventDate`,
   *  a project's `deadline` ONLY (never a fallback like `startDate` or
   *  `createdAt` — see the "NO FABRICATED DATES" note below). `null` for a
   *  recurring budget (no ref date) or a deadline-less project. */
  tier3Ts: number | null;
  budget: Doc<"budgets"> | null;
  level: "chapter" | "central" | null;
};

// ── Label formatting ─────────────────────────────────────────────────────
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/** `name + date` — the "For" picker's row label, always dated so a match
 *  reads unambiguously among same-named siblings ("Mon D, YYYY", Eastern
 *  time). */
export function pickerRefLabel(name: string, ts: number): string {
  const p = easternParts(ts);
  const monthName = MONTH_NAMES[p.month - 1].slice(0, 3);
  return `${name} · ${monthName} ${p.day}, ${p.year}`;
}

/** A budget's v2 `type`, tolerant of un-migrated legacy rows (derives from
 *  legacy `scope` when `type` is unset). Exported so callers that need to
 *  assert a specific type (e.g. `reimbursements.ts#createReimbursement`
 *  requiring `budgetId` to name a RECURRING budget) don't re-derive this. */
export function effectiveBudgetType(b: Doc<"budgets">): BudgetType {
  if (b.type) return b.type;
  return b.scope === "event" || b.scope === "project" ? "one_time" : "recurring";
}

/** A budget's display name: its own label, else its type word — used for a
 *  recurring candidate's row label. */
export function budgetDisplayNameFor(b: Doc<"budgets">): string {
  return b.label?.trim() || BUDGET_TYPE_LABELS[effectiveBudgetType(b)];
}

// ── Candidate gather ──────────────────────────────────────────────────────
/**
 * Every event/project/recurring-budget candidate in `homeChapterId` (plus
 * every central recurring/project budget reachable from it), each carrying
 * its currently-linked budget (or `null` if it has none). `scanLimit` bounds
 * all four underlying index scans identically — pass the SAME constant
 * (`finances.ROLLUP_SCAN_LIMIT`) from both call sites so neither surface's
 * candidate set can ever be a subset/superset of the other's.
 */
export async function gatherForPickerCandidates(
  ctx: QueryCtx,
  // `null` means "the ORG level" — there is no chapter of events or projects to
  // scan there, so only central's own budgets come back. Every existing caller
  // passes a real chapter and is unaffected.
  homeChapterId: Id<"chapters"> | null,
  scanLimit: number,
): Promise<{ candidates: PickerCandidate[]; truncated: boolean }> {
  const [events, projects, chapterBudgets, centralBudgets] = await Promise.all([
    homeChapterId
      ? ctx.db
          .query("events")
          .withIndex("by_chapter", (q) => q.eq("chapterId", homeChapterId))
          .take(scanLimit)
      : Promise.resolve([]),
    homeChapterId
      ? ctx.db
          .query("projects")
          .withIndex("by_chapter", (q) => q.eq("chapterId", homeChapterId))
          .take(scanLimit)
      : Promise.resolve([]),
    homeChapterId
      ? ctx.db
          .query("budgets")
          .withIndex("by_chapter", (q) => q.eq("chapterId", homeChapterId))
          .take(scanLimit)
      : Promise.resolve([]),
    ctx.db
      .query("budgets")
      .withIndex("by_chapter", (q) => q.eq("chapterId", CENTRAL))
      .take(scanLimit),
  ]);
  const truncated =
    events.length === scanLimit ||
    projects.length === scanLimit ||
    chapterBudgets.length === scanLimit ||
    centralBudgets.length === scanLimit;

  const projectIds = new Set(projects.map((p) => p._id as string));
  const orgLevel = homeChapterId === null;

  const eventBudgetByRef = new Map<string, Doc<"budgets">>();
  const projectBudgetByRef = new Map<string, Doc<"budgets">>();
  const recurring: { budget: Doc<"budgets">; level: "chapter" | "central" }[] = [];

  // A ref should only ever have one budget (the D8 invariant, enforced at
  // creation by `createBudget`'s dedup guard), but legacy data can still
  // carry a duplicate one_time budget for the same ref. Rule: keep the
  // OLDEST (lowest `createdAt`) — the auto-created/backfilled one, not
  // whichever happened to sort last in the scan — so a ref shows ONE
  // deterministic budget/candidate instead of flapping between duplicates.
  const setPreferOldest = (
    map: Map<string, Doc<"budgets">>,
    key: string,
    candidate: Doc<"budgets">,
  ) => {
    const existing = map.get(key);
    if (!existing || candidate.createdAt < existing.createdAt) {
      map.set(key, candidate);
    }
  };

  for (const b of chapterBudgets) {
    if (b.type === "one_time" && b.refKind === "event" && b.scopeRefId) {
      setPreferOldest(eventBudgetByRef, b.scopeRefId, b);
    } else if (b.type === "one_time" && b.refKind === "project" && b.scopeRefId) {
      setPreferOldest(projectBudgetByRef, b.scopeRefId, b);
    } else {
      recurring.push({ budget: b, level: "chapter" });
    }
  }
  for (const b of centralBudgets) {
    // AT THE ORG LEVEL a central one_time budget is one of central's own
    // events or projects (`transferEventScope` / `transferProjectScope` moved
    // it there), so it is offered as that event or project — by its name and
    // date — never as a cadence line. Lumping these into `recurring` is how the
    // central contract picker came to list "Reach out to Top 5 Donors · Per
    // instance" under BUDGETS: real central project budgets, mislabelled as
    // standing ones. The refs are loaded below.
    if (orgLevel && b.type === "one_time" && b.refKind && b.scopeRefId) {
      setPreferOldest(
        b.refKind === "event" ? eventBudgetByRef : projectBudgetByRef,
        b.scopeRefId,
        b,
      );
      continue;
    }
    // A central one_time PROJECT budget only belongs to this chapter's
    // groups when it's THIS chapter's project (post-`transferProjectScope`)
    // — a central budget for some other chapter's project stays invisible
    // here.
    if (
      b.type === "one_time" &&
      b.refKind === "project" &&
      b.scopeRefId &&
      projectIds.has(b.scopeRefId)
    ) {
      setPreferOldest(projectBudgetByRef, b.scopeRefId, b);
    } else {
      recurring.push({ budget: b, level: "central" });
    }
  }

  // There is no chapter to scan at the org level, so the events and projects
  // are exactly the ones central's own budgets point at. A ref that no longer
  // exists is dropped rather than offered as a name nobody can find.
  const allEvents: Doc<"events">[] = orgLevel
    ? await loadRefs(ctx, "events", eventBudgetByRef.keys())
    : events;
  const allProjects: Doc<"projects">[] = orgLevel
    ? await loadRefs(ctx, "projects", projectBudgetByRef.keys())
    : projects;

  const candidates: PickerCandidate[] = [];
  for (const e of allEvents) {
    if (e.isTraining) continue;
    // `events.eventDate` is a REQUIRED field (`v.number()`, not optional) —
    // every event row always has a real date, so there is no fallback to
    // audit here (unlike a project's `deadline`, which is optional).
    candidates.push({
      refKind: "event",
      refId: e._id,
      label: pickerRefLabel(e.name, e.eventDate),
      tier3Ts: e.eventDate,
      budget: eventBudgetByRef.get(e._id as string) ?? null,
      level: null,
    });
  }
  for (const p of allProjects) {
    // NO FABRICATED DATES: the label's date must come from the exact same
    // field date-proximity ranking uses (`projects.deadline` — the one real,
    // directly-editable field the app's own Project screen reads/writes; it
    // is NOT derived from `startDate`/`createdAt`). A project with no
    // `deadline` shows its bare name — no date claim — and (via
    // `tier3Ts: null`) never qualifies for date-proximity matching either.
    const dateTs = p.deadline ?? null;
    candidates.push({
      refKind: "project",
      refId: p._id,
      label: dateTs != null ? pickerRefLabel(p.name, dateTs) : p.name,
      tier3Ts: dateTs,
      budget: projectBudgetByRef.get(p._id as string) ?? null,
      level: null,
    });
  }
  for (const r of recurring) {
    candidates.push({
      refKind: "recurring",
      refId: r.budget._id,
      label: budgetDisplayNameFor(r.budget),
      tier3Ts: null,
      budget: r.budget,
      level: r.level,
    });
  }
  return { candidates, truncated };
}

async function loadRefs<T extends "events" | "projects">(
  ctx: QueryCtx,
  table: T,
  ids: Iterable<string>,
): Promise<Doc<T>[]> {
  const docs: Doc<T>[] = [];
  for (const raw of ids) {
    const id = ctx.db.normalizeId(table, raw);
    const doc = id ? ((await ctx.db.get(id)) as Doc<T> | null) : null;
    if (doc) docs.push(doc);
  }
  return docs;
}
