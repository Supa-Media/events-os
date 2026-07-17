/**
 * Money views (WP-3.3) — "what's this thing costing?"
 *
 * A read-only rollup for a SINGLE event/project ref: its budget (the v2
 * `budgets` row, budget-first world per WP-U/WP-U2 — `budgetId` is the only
 * pointer; the row IS the plan), its planned side, and its actual spend
 * (`transactions`, budget-first via `by_ref` → `by_budget`, mirroring
 * `finances.ts#actualsForRef`) — the planned-vs-actual deltas that answer
 * "what's this event/project costing?" split by people / location / gear /
 * whatever categories the plan uses.
 *
 * PLANNED SIDE (WP-money-unify PR2): for an EVENT ref, "planned" is the
 * READ-TIME VIRTUAL UNION of every cost-bearing row on the event —
 * `eventItems` currency cells, paid `engagements` (vendors), and `budgetLines`
 * — via the shared `collectEventPlannedRows` sweep (also used by
 * `eventCostGrid` below). This is an intentional user-visible fix: an event
 * whose only "plan" is cost-inventory items (no `budgetLines` at all) used to
 * report `lineCount: 0` and show "No plan yet" — it now reports the union's
 * row count and a real category breakdown. A PROJECT ref has no
 * `eventItems`/`engagements` (schema-level — those tables are `eventId`-only),
 * so the union degenerates to `budgetLines` alone: byte-identical to the
 * pre-PR2 behavior.
 *
 * OWNERSHIP: this file is intentionally separate from `finances.ts` (whose
 * budget-mutation region + schema are owned by a parallel WP) — every read
 * here either re-derives its own bounded index scan or imports an already-
 * exported, stable READ helper (`getBudgetForRef` is NOT imported; we need
 * every by_ref budget, not just the first, mirroring `actualsForRef`'s own
 * multi-budget reasoning — see `#171`).
 *
 * AUTHZ mirrors `finances.dashboardChapter`'s central drill-down /
 * `events.ts#resolvePeekChapterId`: the caller needs at least a viewer
 * finance role in the REF's own chapter; a caller from a DIFFERENT chapter
 * needs central (org-wide) reach, checked through their OWN home chapter
 * (central is scope-wide regardless of which chapterId it's checked
 * against — `getFinanceRole`'s `viewerPerson` lookup just needs a chapter to
 * resolve the caller's roster row through). Unlike `events.ts`'s peek
 * queries, there's no separate `chapterId` arg here — the ref itself names
 * its own chapter, so "foreign" is detected by comparing it to the caller's
 * home chapter directly. A foreign ref WITHOUT central reach returns the same
 * quiet empty shape as a nonexistent ref — matching `events.get`'s uniform
 * not-found pattern — rather than throwing FORBIDDEN, which would let an
 * authenticated prober learn cross-chapter record existence just by
 * comparing throw-vs-empty across refIds.
 *
 * Training events NEVER get a budget row (the #172 invariant enforced by
 * every budget-creation path) — a training ref simply reads back a null
 * budget / all-zero totals, exactly like a real event that hasn't been
 * budgeted yet. `isTraining` is still surfaced so the client can skip
 * rendering the Money tab entirely rather than showing a permanently-empty one.
 */
import { query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { Doc, Id } from "./_generated/dataModel";
import {
  BUDGET_REF_KINDS,
  BUDGET_APPROVAL_STATUSES,
  CENTRAL,
  countsAsSpend,
  effectiveBudgetApprovalStatus,
  financeRoleAtLeast,
  MODULE_DEFAULT_CATEGORY_NAMES,
  VENDOR_DEFAULT_CATEGORY_NAME,
  type BudgetRefKind,
} from "@events-os/shared";
import { getChapterIdOrNull } from "./lib/context";
import { requireFinanceRole, getFinanceRole, type FinanceAccess } from "./lib/finance";
import { effectiveCapCents } from "./finances";
import { callerHasEventEditRights } from "./lib/org";

// A generous bound on budgets-per-ref / lines-per-budget / txns-per-budget —
// human-authored plans and a single event/project's spend, never a synced
// feed. Mirrors the scan limits used throughout `finances.ts`.
const SCAN_LIMIT = 2000;

// Bound on eventColumns/eventModules/eventItems/engagements/budgets/
// budgetLines per event swept by `collectEventPlannedRows` (shared by
// `refMoney`'s planned union and `eventCostGrid`) — same generous human-scale
// bound as `SCAN_LIMIT` above, kept as its own named constant since it scopes
// a different (per-EVENT, not per-ref-budget) sweep.
const GRID_SCAN_LIMIT = 2000;

const refKindValidator = v.union(...BUDGET_REF_KINDS.map((k) => v.literal(k)));
const approvalStatusValidator = v.union(
  ...BUDGET_APPROVAL_STATUSES.map((s) => v.literal(s)),
);

/**
 * Resolve + authorize a single event/project ref for a Money read. Returns
 * `null` when the ref doesn't exist (quiet 404, matching `events.get`'s /
 * `projects.get`'s "not found" shape) — AND when it exists in a foreign
 * chapter the caller can't see (no central reach). The two cases are
 * deliberately indistinguishable to the caller: an authenticated prober must
 * not be able to enumerate cross-chapter record existence by comparing
 * throw-vs-empty across refIds (see the module doc comment). A caller with NO
 * finance role at all in their OWN chapter still gets a genuine `ConvexError`
 * — that's an access denial on a ref they can already see exists (via every
 * other event/project surface), not an existence leak.
 *
 * Also returns the caller's own `chapterId` + resolved `FinanceAccess` (not
 * just a pass/fail) so `refMoney` can compute a precise `canEditPlan` gate
 * once it knows which chapter/level the ref's budget actually lives at —
 * see that computation's own comment below for why a coarse "!isDrilldown"
 * gate (the dashboard's own "Edit budget" affordance) isn't safe to copy
 * verbatim here: a foreign ref's budget can still be chapter-owned (never
 * moved to central), which `budgetLines.ts#loadOwningBudget` would 404 on.
 */
async function resolveRefAuthz(
  ctx: QueryCtx,
  refKind: BudgetRefKind,
  refId: string,
): Promise<
  | { chapterId: Id<"chapters">; isTraining: boolean; ownChapterId: Id<"chapters">; access: FinanceAccess }
  | null
> {
  let ref: Doc<"events"> | Doc<"projects"> | null = null;
  if (refKind === "event") {
    const id = ctx.db.normalizeId("events", refId);
    ref = id ? await ctx.db.get(id) : null;
  } else {
    const id = ctx.db.normalizeId("projects", refId);
    ref = id ? await ctx.db.get(id) : null;
  }
  if (!ref) return null;
  const refChapterId = ref.chapterId;

  const ownChapterId = (await getChapterIdOrNull(ctx)) as Id<"chapters"> | null;
  if (!ownChapterId) {
    throw new ConvexError({
      code: "NO_CHAPTER",
      message: "You don't belong to a chapter yet.",
    });
  }
  let access: FinanceAccess;
  if (refChapterId !== ownChapterId) {
    // Foreign chapter: central (org-wide) reach required, checked through the
    // CALLER'S OWN chapter (never the target ref's chapter — mirrors
    // `dashboardChapter`'s central drill-down gate exactly). Checked via
    // `getFinanceRole` (not `requireFinanceCentral`) so a failed check can
    // return the same quiet `null` as a nonexistent ref instead of throwing —
    // closes the existence oracle. Central-reach callers still get real data.
    access = await getFinanceRole(ctx, ownChapterId);
    if (!access.isCentral) return null;
  } else {
    access = await requireFinanceRole(ctx, ownChapterId, "viewer");
  }

  const isTraining =
    refKind === "event" ? (ref as Doc<"events">).isTraining === true : false;
  return { chapterId: refChapterId, isTraining, ownChapterId, access };
}

/**
 * Whether the caller can write this ref's budget PLAN (add/update/remove/
 * reorder `budgetLines`, or summon a first budget row) — mirrors
 * `budgetLines.ts#loadOwningBudget` + `#requireLineWriteAccess` EXACTLY so
 * the "Edit plan" affordance never appears for a caller whose first tap would
 * 403. Deliberately tighter than the finance dashboard's own "Edit budget"
 * button (gated there by a coarse `!isDrilldown`): unlike a dashboard budget
 * card — which a caller only ever reaches already scoped to their own chapter
 * or a genuine central desk — `refMoney` also serves a REF in a FOREIGN
 * chapter to a central-reach viewer, and that ref's budget can still be
 * chapter-owned by the FOREIGN chapter (never moved to central) — a case
 * `loadOwningBudget` 404s on regardless of the caller's central reach.
 *
 *  - No budget row yet: writable only when the ref is in the caller's OWN
 *    chapter (summon always lands there — `ensureBudgetForRef` inserts under
 *    `event.chapterId`, never central) and the caller is bookkeeper+.
 *  - A chapter-owned budget: writable only when that chapter IS the caller's
 *    own chapter (else `loadOwningBudget` 404s) and bookkeeper+.
 *  - A central-owned budget: writable when the caller holds central reach at
 *    bookkeeper+, regardless of whose ref it's attached to.
 */
function canEditBudgetPlan(
  authz: { ownChapterId: Id<"chapters">; chapterId: Id<"chapters">; access: FinanceAccess },
  budgetChapterId: Id<"chapters"> | "central" | null,
): boolean {
  const bookkeeperPlus = financeRoleAtLeast(authz.access.role, "bookkeeper");
  if (budgetChapterId === null) {
    // No budget row yet — summon-then-edit, only possible on the caller's own
    // chapter's own ref.
    return authz.chapterId === authz.ownChapterId && bookkeeperPlus;
  }
  if (budgetChapterId === CENTRAL) {
    return authz.access.isCentral && bookkeeperPlus;
  }
  return budgetChapterId === authz.ownChapterId && bookkeeperPlus;
}

/** True iff a transaction contributes to category/budget SPEND — mirrors
 *  `finances.ts#isSpend` exactly (kept local since that one isn't exported):
 *  outflow, non-transfer (`countsAsSpend`), not excluded, not a personal charge. */
function isSpend(tr: Doc<"transactions">): boolean {
  return (
    tr.flow === "outflow" &&
    countsAsSpend(tr.flow) &&
    tr.status !== "excluded" &&
    tr.isPersonal !== true
  );
}

const moneyTxnSummary = v.object({
  id: v.id("transactions"),
  postedAt: v.number(),
  amountCents: v.number(),
  flow: v.union(v.literal("outflow"), v.literal("inflow"), v.literal("transfer")),
  status: v.union(
    v.literal("unreviewed"),
    v.literal("categorized"),
    v.literal("reconciled"),
    v.literal("excluded"),
  ),
  merchantName: v.union(v.string(), v.null()),
  description: v.union(v.string(), v.null()),
  categoryId: v.union(v.id("budgetCategories"), v.null()),
  // Note/receipt state — surfaced so the Money tab's "Recent transactions"
  // section (a reconcile-lite view, owner decision 2026-07-17) can render
  // the current note + receipt status without a second round-trip. Mirrors
  // `finances.ts#toTxnSummary`'s own fields exactly.
  note: v.union(v.string(), v.null()),
  hasReceipt: v.boolean(),
  reminderStage: v.union(v.literal("none"), v.literal("flagged"), v.literal("escalated")),
});

function toMoneyTxnSummary(tr: Doc<"transactions">) {
  return {
    id: tr._id,
    postedAt: tr.postedAt,
    amountCents: tr.amountCents,
    flow: tr.flow,
    status: tr.status,
    merchantName: tr.merchantName ?? null,
    description: tr.description ?? null,
    categoryId: tr.categoryId ?? null,
    note: tr.note ?? null,
    hasReceipt: tr.receiptStorageId != null,
    reminderStage: tr.receiptReminderStage ?? ("none" as const),
  };
}

// ── Shared planned-row union (items ∪ vendors ∪ budgetLines) ────────────────
/**
 * `collectEventPlannedRows` (WP-money-unify PR2) sweeps EVERY cost-bearing
 * row on a single event — `eventItems` currency cells, paid `engagements`
 * (vendors), and `budgetLines` — into one de-duplicated list, shared by
 * `refMoney`'s planned side (below) AND `eventCostGrid` (further down): the
 * exact same "what does this event plan to cost" answer, read-time-merged so
 * both surfaces agree by construction rather than by two independently
 * hand-tuned sweeps drifting apart.
 *
 * MERGE (not new — lifted verbatim from `eventCostGrid`'s pre-PR2 logic): a
 * `budgetLines` row with `sourceRef` pointing at an `eventItems`/`engagements`
 * row ALSO present in this sweep is folded into that row (category only —
 * the module/vendor row's own cost/status/link wins) and does NOT appear as
 * its own entry — so summing `plannedCents` across the returned rows never
 * double-counts a linked pair. A DANGLING `sourceRef` (target not swept, e.g.
 * deleted or its module lost its currency column) falls back to a normal
 * unlinked `budget_line` row so its plan data doesn't vanish.
 *
 * CATEGORY RESOLUTION per row: an explicit override
 * (`eventItems`/`engagements.budgetCategoryId`, or `budgetLines.categoryId`
 * — already explicit, no override concept) wins; otherwise the row's default
 * category NAME (`MODULE_DEFAULT_CATEGORY_NAMES[module]` for an item,
 * `VENDOR_DEFAULT_CATEGORY_NAME` for a vendor) is matched EXACTLY against
 * this event's own chapter's `budgetCategories` (loaded once, up front) —
 * unresolvable (no override, no name match — e.g. a chapter renamed/deleted
 * the default category) resolves to `categoryId: null` /
 * `categoryIsDefault: false` (nothing was actually resolved), which reads as
 * the existing "Uncategorized" bucket at every consumer. `categoryName` here
 * is always a real category's name when `categoryId` resolves (an override
 * can point anywhere — its OWN category's real name, not necessarily the
 * default), falling back to the caller-supplied label (a module's own
 * display label for `event_item`/`vendor` rows, "Uncategorized" for a
 * `budget_line` row) only when nothing resolves — this is UNCHANGED display
 * behavior for the common (no chapter categories seeded / no default match)
 * case, matching every pre-PR2 `eventCostGrid` fixture.
 *
 * Every read here is `.take(GRID_SCAN_LIMIT)`-bounded, mirroring the rest of
 * this file's scan limits.
 */
type PlannedRowSourceKind = "event_item" | "vendor" | "budget_line";

type PlannedRow = {
  id: string;
  sourceKind: PlannedRowSourceKind;
  // `eventItems.module` for an `event_item` row; `null` for `vendor` /
  // `budget_line` (neither has real module semantics).
  module: string | null;
  typeLabel: string;
  label: string;
  plannedCents: number;
  // Vendor actual-if-paid only (mirrors `eventCostGrid`'s pre-PR2 field) —
  // NEVER folded into `refMoney`'s `actualByCategory`, which stays
  // `transactions`-only (money invariant #2: Estimated is never summed with
  // Actuals).
  actualCents: number | null;
  status: string | null;
  editable: boolean;
  sourceLink: string | null;
  // True when this row absorbed a linked `budgetLines` row's category via
  // `sourceRef` (see the module doc above) — always `false` on a
  // `budget_line` row itself (a TRULY linked line is folded away, never
  // returned as its own row).
  linked: boolean;
  categoryId: Id<"budgetCategories"> | null;
  // True only when `categoryId` came from the DEFAULT-name match, never from
  // an explicit override or a `sourceRef` merge.
  categoryIsDefault: boolean;
  categoryName: string;
  /** The `eventItems`/`engagements` doc id this row was sourced from (as a
   *  string), for `sourceRef` link matching — `null` for a `budget_line` row
   *  (never itself a link TARGET). Internal join key; callers that return
   *  rows to the client strip this field. */
  refId: string | null;
};

/** Round a whole-dollar figure (`eventItems.fields[key]` / `engagements.
 *  amountUsd`) to integer cents — mirrors `events.ts#budgetSpent`'s own
 *  `Number(...)` + finite guard, then converts to the finance side's unit. */
function dollarsToCents(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

async function collectEventPlannedRows(
  ctx: QueryCtx,
  eventId: Id<"events">,
  eventChapterId: Id<"chapters">,
  authz: { ownChapterId: Id<"chapters">; chapterId: Id<"chapters">; access: FinanceAccess },
): Promise<PlannedRow[]> {
  // The event's own chapter's categories, loaded ONCE — feeds the
  // default-name-match table below AND (for ids already in this set) saves a
  // redundant `ctx.db.get` when resolving an explicit override's name.
  const chapterCategories = await ctx.db
    .query("budgetCategories")
    .withIndex("by_chapter", (q) => q.eq("chapterId", eventChapterId))
    .take(GRID_SCAN_LIMIT);
  const categoryNameById = new Map<Id<"budgetCategories">, string>();
  const categoryIdByDefaultName = new Map<string, Id<"budgetCategories">>();
  for (const cat of chapterCategories) {
    categoryNameById.set(cat._id, cat.name);
    if (!categoryIdByDefaultName.has(cat.name)) categoryIdByDefaultName.set(cat.name, cat._id);
  }

  /** Resolve an EXPLICIT override id's name via `ctx.db.get` — unrestricted
   *  by chapter (mirrors the pre-PR2 by-id lookups in both `refMoney` and
   *  `eventCostGrid`, which never chapter-filtered an explicit category
   *  link), memoizing into `categoryNameById` so a repeat id is one lookup. */
  async function nameForExplicitId(id: Id<"budgetCategories">): Promise<string | undefined> {
    const cached = categoryNameById.get(id);
    if (cached !== undefined) return cached;
    const doc = await ctx.db.get(id);
    if (doc) categoryNameById.set(id, doc.name);
    return doc?.name;
  }

  /** Explicit override wins; else match the default NAME against this
   *  chapter's categories; else unresolved. */
  async function resolveCategory(
    explicitId: Id<"budgetCategories"> | undefined,
    defaultName: string | undefined,
  ): Promise<{ categoryId: Id<"budgetCategories"> | null; categoryIsDefault: boolean; categoryName: string | undefined }> {
    if (explicitId) {
      return {
        categoryId: explicitId,
        categoryIsDefault: false,
        categoryName: await nameForExplicitId(explicitId),
      };
    }
    const byName = defaultName ? categoryIdByDefaultName.get(defaultName) : undefined;
    if (byName) {
      return { categoryId: byName, categoryIsDefault: true, categoryName: defaultName };
    }
    return { categoryId: null, categoryIsDefault: false, categoryName: undefined };
  }

  const rows: PlannedRow[] = [];

  // ── eventItems (every module with a currency column) ───────────────────
  const [eventColumnRows, eventModuleRows] = await Promise.all([
    ctx.db
      .query("eventColumns")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .take(GRID_SCAN_LIMIT),
    ctx.db
      .query("eventModules")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .take(GRID_SCAN_LIMIT),
  ]);
  const moduleLabel = new Map<string, string>(eventModuleRows.map((m) => [m.key, m.label]));
  const currencyColumnsByModule = new Map<string, { key: string; label: string }[]>();
  for (const col of eventColumnRows) {
    if (col.type !== "currency") continue;
    const entry = { key: col.key, label: col.label };
    const bucket = currencyColumnsByModule.get(col.module);
    if (bucket) bucket.push(entry);
    else currencyColumnsByModule.set(col.module, [entry]);
  }

  const items = await ctx.db
    .query("eventItems")
    .withIndex("by_event", (q) => q.eq("eventId", eventId))
    .take(GRID_SCAN_LIMIT);
  if (items.length === GRID_SCAN_LIMIT) {
    console.warn(
      `[moneyViews] collectEventPlannedRows hit GRID_SCAN_LIMIT (${GRID_SCAN_LIMIT}) reading eventItems for event ${eventId}; rows may be truncated.`,
    );
  }
  for (const item of items) {
    const currencyCols = currencyColumnsByModule.get(item.module);
    if (!currencyCols || currencyCols.length === 0) continue;
    const typeLabel = moduleLabel.get(item.module) ?? item.module;
    const multiCol = currencyCols.length > 1;
    for (const col of currencyCols) {
      const cents = dollarsToCents(item.fields?.[col.key]);
      if (cents === null) continue;
      const title = item.title || "(untitled)";
      const resolved = await resolveCategory(
        item.budgetCategoryId,
        MODULE_DEFAULT_CATEGORY_NAMES[item.module],
      );
      rows.push({
        id: `event_item:${item._id}:${col.key}`,
        sourceKind: "event_item",
        module: item.module,
        typeLabel,
        // Disambiguate only when a module genuinely has more than one
        // currency column (rare) — keeps the common case's label clean.
        label: multiCol ? `${title} — ${col.label}` : title,
        plannedCents: cents,
        actualCents: null,
        status: item.status ?? null,
        editable: true, // same native chapter-member gate `items.ts` already enforces
        sourceLink: `/event/${eventId}?tab=${item.module}`,
        linked: false,
        categoryId: resolved.categoryId,
        categoryIsDefault: resolved.categoryIsDefault,
        categoryName: resolved.categoryName ?? typeLabel,
        refId: String(item._id),
      });
    }
  }

  // ── Paid vendors (Crew & Duties) ────────────────────────────────────────
  const paidEngagements = await ctx.db
    .query("engagements")
    .withIndex("by_event_type", (q) => q.eq("eventId", eventId).eq("type", "paid"))
    .take(GRID_SCAN_LIMIT);
  const vendorPeople = await Promise.all(paidEngagements.map((e) => ctx.db.get(e.personId)));
  for (let i = 0; i < paidEngagements.length; i++) {
    const eng = paidEngagements[i];
    const cents = dollarsToCents(eng.amountUsd);
    if (cents === null) continue;
    const person = vendorPeople[i];
    const resolved = await resolveCategory(eng.budgetCategoryId, VENDOR_DEFAULT_CATEGORY_NAME);
    rows.push({
      id: `vendor:${eng._id}`,
      sourceKind: "vendor",
      module: null,
      typeLabel: "Vendors",
      label: person?.name ?? "(unknown)",
      plannedCents: cents,
      // Vendors: the same figure once `paymentStatus === "paid"`, else null
      // (not yet actually spent). This is a display/committed figure only —
      // never summed into `refMoney`'s `transactions`-based actuals.
      actualCents: eng.paymentStatus === "paid" ? cents : null,
      status: eng.paymentStatus ?? null,
      editable: true, // same native chapter-member gate `engagements.ts` already enforces
      sourceLink: `/event/${eventId}?tab=crew`,
      linked: false,
      categoryId: resolved.categoryId,
      categoryIsDefault: resolved.categoryIsDefault,
      categoryName: resolved.categoryName ?? "Vendors",
      refId: String(eng._id),
    });
  }

  // ── Budget lines (the finance plan, WP-3.1) — merge linked, else a row ──
  const budgets = await ctx.db
    .query("budgets")
    .withIndex("by_ref", (q) => q.eq("refKind", "event").eq("scopeRefId", eventId))
    .take(GRID_SCAN_LIMIT);
  const budgetLineRows: PlannedRow[] = [];
  for (const budget of budgets) {
    const lines = await ctx.db
      .query("budgetLines")
      .withIndex("by_budget", (q) => q.eq("budgetId", budget._id))
      .take(GRID_SCAN_LIMIT);
    const canEdit = canEditBudgetPlan(authz, budget.chapterId);
    for (const line of lines) {
      const lineCategoryName = line.categoryId
        ? ((await nameForExplicitId(line.categoryId)) ?? "Uncategorized")
        : "Uncategorized";

      // LINKED: fold this line's category into every row sourced from
      // `sourceRef.id`, and don't give the line its own row at all — "module
      // row wins for display" (its cost/status/link are untouched; only the
      // category is upgraded to the line's REAL category).
      if (line.sourceRef) {
        const targets = rows.filter((r) => r.refId === line.sourceRef!.id);
        if (targets.length > 0) {
          for (const target of targets) {
            target.linked = true;
            target.categoryId = line.categoryId ?? null;
            target.categoryIsDefault = false;
            target.categoryName = lineCategoryName;
          }
          continue; // merged — no separate budget_line row, no double count.
        }
        // Dangling sourceRef — fall through and show the line as a normal
        // unlinked row so its plan data doesn't just vanish.
      }

      budgetLineRows.push({
        id: `budget_line:${line._id}`,
        sourceKind: "budget_line",
        module: null,
        typeLabel: "Budget lines",
        label: line.description,
        plannedCents: line.plannedCents,
        actualCents: null,
        status: null,
        editable: canEdit,
        sourceLink: null,
        linked: false,
        categoryId: line.categoryId ?? null,
        categoryIsDefault: false,
        categoryName: lineCategoryName,
        refId: null,
      });
    }
  }
  rows.push(...budgetLineRows);

  return rows;
}

const moneyCategoryRow = v.object({
  categoryId: v.union(v.id("budgetCategories"), v.null()),
  categoryName: v.string(),
  plannedCents: v.number(),
  actualCents: v.number(),
});

/**
 * The event/project Money view: budget header + planned-vs-actual by
 * category + the unplanned-spend bucket + a recent linked-transactions list.
 * "What's this thing costing?" — people / location / gear / whatever
 * categories the plan breaks the budget into.
 */
export const refMoney = query({
  args: {
    refKind: refKindValidator,
    refId: v.string(),
  },
  returns: v.object({
    refKind: refKindValidator,
    refId: v.string(),
    isTraining: v.boolean(),
    budget: v.union(
      v.object({
        id: v.id("budgets"),
        // The EFFECTIVE cap (`finances.ts#effectiveCapCents`, B1) — a budget
        // currently `"submitted"`/`"changes_requested"` WITH a recorded
        // `approvedCents` reports that still-in-force cap, never the pending
        // (not-yet-approved) `amountCents` increase. Every other case reports
        // the plain `amountCents`. Matches every other numeric budget surface
        // (dashboard cards, `finances.ts`'s own pct/remaining/status math).
        amountCents: v.number(),
        label: v.union(v.string(), v.null()),
        // Always the EFFECTIVE status (`effectiveBudgetApprovalStatus`) — a
        // grandfathered legacy row with no stored `approvalStatus` reads as
        // `"approved"`, never a bare `null` (WP-3.2 has merged; this is no
        // longer a "lights up later" placeholder).
        approvalStatus: approvalStatusValidator,
        // Alongside the effective cap above, for `BudgetApprovalChip`'s "approved
        // at $X, requested $Y" pending-increase copy (mirrors
        // `finances.ts#budgetApprovalCardFields` exactly).
        approvedCents: v.union(v.number(), v.null()),
        requestedCents: v.number(),
        reviewNote: v.union(v.string(), v.null()),
        // WP-wave4 (item 8): which SoD path the last approval decision took
        // (mirrors `finances.ts#budgetApprovalCardFields`).
        approvalParty: v.union(v.literal("single"), v.literal("two_party"), v.null()),
        // Whether the CALLER can write this budget's plan (`budgetLines`) —
        // see `canEditBudgetPlan`'s own doc comment for the exact gate.
        canEditPlan: v.boolean(),
      }),
      v.null(),
    ),
    categories: v.array(moneyCategoryRow),
    unplannedCents: v.number(),
    // Planned but not broken into any planned row yet — the effective cap
    // (`totalPlannedCents`) minus the sum of the planned side (WP-money-unify
    // PR2: the `eventItems` ∪ `engagements` ∪ `budgetLines` union for an
    // EVENT ref; `budgetLines` alone for a PROJECT ref, which has no items/
    // engagements), floored at 0. Keeps the header total and the category-row
    // sum visibly reconciling: category rows alone can undercount the header
    // amount when a budget hasn't been fully allocated to a planned row.
    unallocatedPlannedCents: v.number(),
    transactions: v.array(moneyTxnSummary),
    totalPlannedCents: v.number(),
    totalActualCents: v.number(),
    totalRemainingCents: v.number(),
    // The planned-row count — gates the client's "No plan yet" empty state
    // (`lineCount === 0`). WP-money-unify PR2: for an EVENT ref this is the
    // UNION row count (`eventItems` ∪ paid `engagements` ∪ `budgetLines`,
    // post `sourceRef`-merge dedup), not the raw `budgetLines` count — an
    // event whose only plan is cost-inventory items now reports a nonzero
    // count here. Unchanged (raw `budgetLines.length`) for a PROJECT ref.
    lineCount: v.number(),
    // Money IN (tickets + donations, from `eventPages`) — a summary-only
    // read alongside the spend-side view above. See the module doc's income
    // section for why this is a conscious, narrow addition (not a full
    // recreation of Budget v1's net-reconciliation math).
    incomeCents: v.number(),
    // Whether the caller can SUMMON a first ($0) budget row when none exists
    // yet — same gate as `canEditPlan`, exposed even in the `budget: null`
    // empty shape so the "Add budget" affordance can render before any
    // budget row is created.
    canSummonBudget: v.boolean(),
    // Whether the caller can act on `transactions` below — note/receipt/
    // category ONLY, never reattribution/amount/status (owner decision,
    // 2026-07-17). True for bookkeeper+ (mirrors `budget.canEditPlan`'s own
    // gate) OR — new — a caller with EVENT EDIT rights on THIS event
    // (`callerHasEventEditRights`, event refKind only; always `false` for a
    // project ref, which has no "lead" concept). A client-side DISPLAY hint
    // only — the real boundary is each mutation's own server-side gate
    // (`finances.ts#requireTxnNoteReceiptCategoryAccess`).
    canEditTransactions: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const empty = {
      refKind: args.refKind,
      refId: args.refId,
      isTraining: false,
      budget: null,
      categories: [] as never[],
      unplannedCents: 0,
      unallocatedPlannedCents: 0,
      transactions: [] as never[],
      totalPlannedCents: 0,
      totalActualCents: 0,
      totalRemainingCents: 0,
      lineCount: 0,
      incomeCents: 0,
      canSummonBudget: false,
      canEditTransactions: false,
    };

    const authz = await resolveRefAuthz(ctx, args.refKind, args.refId);
    if (!authz) return empty;

    // Money IN — same reconciliation source Budget v1's `budgetSummary` read
    // (`eventPages.revenueCents` + `donationsCents`, one page per event).
    // Projects have no `eventPages` row, so this is 0 for `refKind:"project"`.
    const page =
      args.refKind === "event"
        ? await ctx.db
            .query("eventPages")
            .withIndex("by_event", (q) => q.eq("eventId", args.refId as Id<"events">))
            .unique()
        : null;
    const incomeCents = (page?.revenueCents ?? 0) + (page?.donationsCents ?? 0);

    // Every one_time budget attached to this ref, wherever it currently
    // lives (a budget's LEVEL can move — WP-2.2's `transferProjectScope` —
    // while the ref's own `chapterId` never changes). The D8 invariant means
    // this is normally exactly one row; `by_ref` still unions every match so
    // a legacy duplicate never silently undercounts (mirrors
    // `finances.ts#actualsForRef`'s reasoning verbatim).
    const budgets = await ctx.db
      .query("budgets")
      .withIndex("by_ref", (q) =>
        q.eq("refKind", args.refKind).eq("scopeRefId", args.refId),
      )
      .take(SCAN_LIMIT);
    if (budgets.length === SCAN_LIMIT) {
      console.warn(
        `[moneyViews] refMoney hit SCAN_LIMIT (${SCAN_LIMIT}) reading budgets for ${args.refKind} ${args.refId}; sums may be truncated.`,
      );
    }

    if (budgets.length === 0) {
      return {
        ...empty,
        isTraining: authz.isTraining,
        incomeCents,
        canSummonBudget: canEditBudgetPlan(authz, null),
      };
    }

    // The primary/header budget: earliest-created wins when a legacy
    // duplicate exists, so the header is stable across reloads.
    const primary = [...budgets].sort((a, b) => a.createdAt - b.createdAt)[0];

    const [linesByBudget, txnsByBudget] = await Promise.all([
      Promise.all(
        budgets.map(async (b) => {
          const rows = await ctx.db
            .query("budgetLines")
            .withIndex("by_budget", (q) => q.eq("budgetId", b._id))
            .take(SCAN_LIMIT);
          if (rows.length === SCAN_LIMIT) {
            console.warn(
              `[moneyViews] refMoney hit SCAN_LIMIT (${SCAN_LIMIT}) reading budgetLines for budget ${b._id}; planned totals may be truncated.`,
            );
          }
          return rows;
        }),
      ),
      Promise.all(
        budgets.map(async (b) => {
          const rows = await ctx.db
            .query("transactions")
            .withIndex("by_budget", (q) => q.eq("budgetId", b._id))
            .take(SCAN_LIMIT);
          if (rows.length === SCAN_LIMIT) {
            console.warn(
              `[moneyViews] refMoney hit SCAN_LIMIT (${SCAN_LIMIT}) reading transactions for budget ${b._id}; actuals may be truncated.`,
            );
          }
          return rows;
        }),
      ),
    ]);
    const lines = linesByBudget.flat();
    // SCOPE-AWARE (fixes a Central project under-reporting $0 actuals): filter
    // each budget's transactions down to THAT BUDGET's own current `chapterId`
    // — never `authz.chapterId` (the REF's home chapter, which never becomes
    // `"central"` — projects have no central union on the row itself, WP-2.2).
    // Once `transferProjectScope` moves a project's budget to `"central"`, its
    // linked transactions move with it (same patch); anchoring the filter to
    // each budget's OWN chapterId instead of the ref's fixed home chapter
    // means this view's actuals follow the money to wherever the "Belongs to"
    // row says it now lives, rather than silently zeroing out.
    //
    // This is DIFFERENT from `finances.ts#actualsForRef` (`projectActuals`/
    // `eventActuals`) on purpose: those are keyed to the CALLER'S OWN chapter
    // (a chapter-dashboard read — "how much does MY copy of this cost", which
    // correctly drops to zero once the money leaves), not to the ref. This
    // view answers "what does this project/event cost, period" for whoever is
    // already authorized to see it (visibility is unchanged — `resolveRefAuthz`
    // above still gates who gets here at all) — the ONE-HOME-PER-DOLLAR
    // invariant still holds: each transaction's `chapterId` is a single value,
    // so it's counted here (the ref's own money view) and, separately, in
    // whichever finance dashboard (chapter or central) currently owns it —
    // never both `refMoney` AND `actualsForRef` for the SAME level, and never
    // twice within `refMoney` itself, since a transaction belongs to exactly
    // one budget. Defense-in-depth is preserved too: a stale/duplicate
    // transaction whose `chapterId` doesn't match ITS OWN budget's current
    // scope is still dropped, just anchored to the right value.
    const refChapterTxns = budgets.flatMap((b, i) =>
      txnsByBudget[i].filter((tr) => tr.chapterId === b.chapterId),
    );
    const spendTxns = refChapterTxns.filter(isSpend);

    // ── Plan (ESTIMATED-side, invariant #2 — never mixed with actuals below) ──
    // WP-money-unify PR2: for an EVENT ref, "planned" is the read-time
    // virtual UNION of `eventItems` ∪ paid `engagements` ∪ `budgetLines`
    // (`collectEventPlannedRows`, shared with `eventCostGrid` below) — the
    // intentional user-visible fix (an event whose only "plan" is cost-
    // inventory items stops reporting `lineCount: 0`). A PROJECT ref has no
    // `eventItems`/`engagements` (schema-level), so it keeps reading straight
    // off `lines` (the by_ref `budgetLines` sweep above) — byte-identical to
    // pre-PR2 behavior.
    type CatKey = Id<"budgetCategories"> | null;
    const plannedEntries: { categoryId: CatKey; plannedCents: number }[] =
      args.refKind === "event"
        ? (
            await collectEventPlannedRows(
              ctx,
              args.refId as Id<"events">,
              authz.chapterId,
              authz,
            )
          ).map((row) => ({ categoryId: row.categoryId, plannedCents: row.plannedCents }))
        : lines.map((line) => ({ categoryId: line.categoryId ?? null, plannedCents: line.plannedCents }));

    const plannedByCategory = new Map<CatKey, number>();
    for (const entry of plannedEntries) {
      const key: CatKey = entry.categoryId;
      plannedByCategory.set(key, (plannedByCategory.get(key) ?? 0) + entry.plannedCents);
    }

    // ── Actual (the ONE table summed for actuals — transfers/excluded/
    //    personal already dropped by `isSpend`) ──
    const actualByCategory = new Map<CatKey, number>();
    for (const tr of spendTxns) {
      const key: CatKey = tr.categoryId ?? null;
      actualByCategory.set(key, (actualByCategory.get(key) ?? 0) + tr.amountCents);
    }

    // Resolve category names for every category that appears on EITHER side.
    const categoryIds = new Set<Id<"budgetCategories">>();
    for (const key of plannedByCategory.keys()) if (key) categoryIds.add(key);
    for (const key of actualByCategory.keys()) if (key) categoryIds.add(key);
    const categoryIdList = [...categoryIds];
    const categoryDocs = await Promise.all(
      categoryIdList.map((id) => ctx.db.get(id)),
    );
    const categoryName = new Map<Id<"budgetCategories">, string>();
    categoryIdList.forEach((id, i) => {
      const doc = categoryDocs[i];
      if (doc) categoryName.set(id, doc.name);
    });

    // Per-category planned-vs-actual: one row per PLANNED category (the plan
    // decides which categories exist here) plus its matching actual, if any.
    const categories = [...plannedByCategory.entries()].map(([key, plannedCents]) => ({
      categoryId: key,
      categoryName: key ? (categoryName.get(key) ?? "Uncategorized") : "Uncategorized",
      plannedCents,
      actualCents: actualByCategory.get(key) ?? 0,
    }));

    // Unplanned-spend bucket: actual spend in a category with NO planned
    // line at all — loud, never silently folded into a planned category's row.
    let unplannedCents = 0;
    for (const [key, cents] of actualByCategory.entries()) {
      if (!plannedByCategory.has(key)) unplannedCents += cents;
    }

    // The EFFECTIVE cap (B1, `finances.ts#effectiveCapCents`) — a pending,
    // not-yet-approved increase never inflates the planned/remaining math a
    // step ahead of the actual approval. Summed across every by_ref budget,
    // same as the raw sum it replaces.
    const totalPlannedCents = budgets.reduce((sum, b) => sum + effectiveCapCents(b), 0);
    const totalActualCents = spendTxns.reduce((sum, tr) => sum + tr.amountCents, 0);

    // Planned but not yet broken into any planned row (union, PR2) — keeps
    // the header total and the sum of category rows visibly reconciling (see
    // the field's own doc comment on the return validator above). For a
    // project ref `plannedEntries` IS `lines`, so this is the exact
    // pre-PR2 `totalLinesCents` computation under a new name.
    const totalPlannedEntriesCents = plannedEntries.reduce((sum, e) => sum + e.plannedCents, 0);
    const unallocatedPlannedCents = Math.max(0, totalPlannedCents - totalPlannedEntriesCents);

    const approvalStatus = effectiveBudgetApprovalStatus(primary.approvalStatus);

    const transactions = [...refChapterTxns]
      .sort((a, b) => b.postedAt - a.postedAt)
      .slice(0, 50)
      .map(toMoneyTxnSummary);

    const canEditPlanValue = canEditBudgetPlan(authz, primary.chapterId);
    // `canEditTransactions`: bookkeeper+ (same gate as the plan above) OR —
    // new, owner decision 2026-07-17 — event edit rights on THIS event. Only
    // resolved via the (extra) event-edit lookup when the finance-role gate
    // already failed, so a bookkeeper+ caller never pays for it.
    let canEditTransactions = canEditPlanValue;
    if (!canEditTransactions && args.refKind === "event") {
      const event = await ctx.db.get(args.refId as Id<"events">);
      if (event) canEditTransactions = await callerHasEventEditRights(ctx, event);
    }

    return {
      refKind: args.refKind,
      refId: args.refId,
      isTraining: authz.isTraining,
      budget: {
        id: primary._id,
        amountCents: effectiveCapCents(primary),
        label: primary.label ?? null,
        approvalStatus,
        approvedCents: primary.approvedCents ?? null,
        requestedCents: primary.amountCents,
        reviewNote: primary.reviewNote ?? null,
        approvalParty: primary.approvalParty ?? null,
        canEditPlan: canEditPlanValue,
      },
      categories,
      unplannedCents,
      unallocatedPlannedCents,
      transactions,
      totalPlannedCents,
      totalActualCents,
      totalRemainingCents: totalPlannedCents - totalActualCents,
      // The unified planned-ROW count (PR2) — gates the client's "No plan
      // yet" empty state, so it must reflect `plannedEntries` (the union for
      // an event ref), not the raw `budgetLines` count.
      lineCount: plannedEntries.length,
      incomeCents,
      canSummonBudget: false,
      canEditTransactions,
    };
  },
});

// ── Event cost grid (phase 2 of "one money surface") ────────────────────────
/**
 * "Everything with a cost line item" — EVERY cost-bearing row on a single
 * event in ONE flat list, not just the finance plan (`budgetLines`) `refMoney`
 * above covers: `eventItems.fields[currencyColumnKey]` (Tasks/Supplies/
 * Comms/Permits/etc — ANY module with a `type:"currency"` column, built-in
 * or chapter-custom), paid-vendor `engagements.amountUsd`
 * (`engagements.ts#paidTotalForEvent`), and `budgetLines` (WP-3.1). Owner
 * spec: a database-style grid — Type / Label / Category / Planned $ /
 * Actual-or-status / source-link — editable in place, writing back to each
 * row's OWN home mutation (source of truth stays in the home table; this is
 * a rollup + inline-edit view, not a new ledger).
 *
 * THE MODEL (Opus review, PR #216, 2026-07-17):
 *   - Grid rows ARE the plan for anything with a home module (Task/Supply/
 *     Comms/any custom currency column, or a paid Vendor) — their cost lives
 *     on the module's own record, edited there or here, never duplicated
 *     into a `budgetLines` row.
 *   - `budgetLines` rows are for costs with NO home module (an AV rental
 *     that isn't a Task, a permit fee before Permits had a currency column,
 *     a category-level allocation) — the free-form finance-plan fallback.
 *   - LINKED pairs are MERGED, not summed: a `budgetLines` row with
 *     `sourceRef` pointing at the module row it represents contributes only
 *     its category (plan metadata the module side has no field for) — the
 *     module row's own cost/status/link still wins for display, and the
 *     line does NOT get a separate row or count toward the total twice.
 *     Nothing creates a link yet (no mutation sets `sourceRef` today) — this
 *     is forward-looking infrastructure for a future "plan this task's cost
 *     in Finances" flow.
 *   - UNLINKED duplicates are FLAGGED, not merged: since nothing proves two
 *     unlinked rows represent the same expense, a same-ish-label collision
 *     between a `budgetLines` row and a module row (e.g. Task "Sound tech"
 *     + budget line "Sound tech deposit") sets `possibleDuplicate` on BOTH
 *     rows — a human catches what the system can't yet prove, but neither
 *     row's amount is dropped from the total (silently hiding a real cost
 *     would be worse than a visible over-count warning).
 *
 * MODULE COVERAGE: dynamically swept from THIS EVENT's own `eventColumns`
 * (cloned per-event at instantiation, `lib/templates.ts` — includes every
 * custom `currency`-type column a chapter added via `columns.ts#addColumn`,
 * on ANY module, not a hardcoded 3-module allowlist). For the common case
 * (an unmodified template, only a `cost` key on Tasks/Supplies/Comms) this
 * sweep finds exactly those 3 modules — so the grid's per-item figures agree
 * with `events.ts#get`'s `budgetSpent` rollup (which sums `fields.cost`
 * across every module, key-oblivious) BY CONSTRUCTION whenever the item's
 * own module actually has a `cost`-keyed currency column. A currency column
 * with a DIFFERENT key (e.g. a custom Permits "fee" column) is invisible to
 * the OLD `budgetSpent` gauge (which only ever reads the literal `cost` key)
 * but IS captured here — a deliberate completeness improvement over the
 * header gauge, not a regression against it.
 *
 * MONEY UNIT NOTE: `eventItems.fields[key]` and `engagements.amountUsd` are
 * whole ESTIMATED USD DOLLARS (mirrors `events.budget`) — NOT integer cents
 * like every `finances.ts`/`budgetLines` figure. Every dollar figure here is
 * `Math.round(dollars * 100)` before it joins `plannedCents` so the grid's
 * rollup is apples-to-apples with the finance side.
 *
 * TYPE → CATEGORY (WP-money-unify PR2, updated): an unlinked module row's
 * `categoryId` is resolved via `collectEventPlannedRows` — an explicit
 * `eventItems`/`engagements.budgetCategoryId` override (WP-money-unify PR1)
 * if set, else a DEFAULT category matched by name
 * (`MODULE_DEFAULT_CATEGORY_NAMES`/`VENDOR_DEFAULT_CATEGORY_NAME`) against
 * the event's own chapter's `budgetCategories`. `categoryName` shows that
 * REAL category's name when one resolves; only an unresolved row (no
 * override, no default-name match) falls back to the module's own display
 * label (Tasks / Supplies & Logistics / Permits / Vendors — whatever
 * `eventModules.label` says). A LINKED module row instead always shows the
 * linked line's REAL category (`sourceRef` merge wins over both).
 *
 * TWO TOTALS — DIFFERENT AXES (WP-money-unify PR2, updated): `refMoney`
 * above no longer stays scoped to `budgetLines` alone — its planned side is
 * NOW this SAME `collectEventPlannedRows` union (a caller-side `refMoney`
 * has no `sourceLink`/`editable`/duplicate-flagging use for, so it only
 * consumes `categoryId`/`plannedCents`). The two totals can still read
 * differently for a reason that's unrelated to the union itself:
 * `refMoney.totalPlannedCents` is the budget's EFFECTIVE APPROVAL CAP
 * (`effectiveCapCents`, independent of how much has actually been broken
 * into planned rows — see its own `unallocatedPlannedCents` reconciliation),
 * while THIS grid's `totalPlannedCents` is "everything that costs money,
 * full stop," summed straight off the union rows with no cap involved. They
 * are not merged into one number here; see the PR body.
 *
 * WRITE-BACK gating: each row is editable under its OWN home table's
 * EXISTING rule, never a new one — `eventItems`/`engagements` are editable by
 * any of the event's own chapter members today (`requireEvent` ==
 * `requireOwned`, no stronger role exists yet), `budgetLines` rows keep
 * `canEditBudgetPlan`'s bookkeeper+ gate from `refMoney` above. The READ
 * itself is gated the same as `refMoney` (finance viewer+ in the ref's own
 * chapter, or central reach for a foreign one) — so only someone who can
 * already see the Money tab sees the grid, but editability within it still
 * follows each row's native rule, not a finance role.
 */

const gridSourceKindValidator = v.union(
  v.literal("event_item"),
  v.literal("vendor"),
  v.literal("budget_line"),
);

const gridRow = v.object({
  id: v.string(),
  sourceKind: gridSourceKindValidator,
  // `eventItems.module` for an `event_item` row; `null` for `vendor` /
  // `budget_line` (WP-money-unify PR2, additive — neither has real module
  // semantics).
  module: v.union(v.string(), v.null()),
  typeLabel: v.string(),
  label: v.string(),
  categoryName: v.string(),
  // The row's resolved `budgetCategories` link (WP-money-unify PR2,
  // additive) — an explicit override or a default-name match (see
  // `collectEventPlannedRows`'s doc comment); `null` when unresolved, which
  // is when `categoryName` falls back to `typeLabel` (module rows) or
  // "Uncategorized" (`budget_line` rows) below.
  categoryId: v.union(v.id("budgetCategories"), v.null()),
  // True only when `categoryId` came from the module/vendor DEFAULT-name
  // match, never an explicit override or a linked budget line's category.
  categoryIsDefault: v.boolean(),
  plannedCents: v.number(),
  // Vendors: the same figure once `paymentStatus === "paid"`, else null (not
  // yet actually spent). Tasks/Supplies/Comms/BudgetLines have no separate
  // actual concept — always null here (their `plannedCents` figure IS the
  // committed cost; `refMoney`'s `transactions`-based actuals are the real
  // "money that moved" side for the finance plan).
  actualCents: v.union(v.number(), v.null()),
  status: v.union(v.string(), v.null()),
  editable: v.boolean(),
  // Deep link to the row's home surface (`?tab=<module>` / `?tab=crew`) —
  // `null` for a `budget_line` row, which is edited right here via
  // `MoneyView`'s own "Edit plan" modal, not a separate screen.
  sourceLink: v.union(v.string(), v.null()),
  // True when this (module) row absorbed a `budgetLines` row's category via
  // `sourceRef` — the line itself never became a separate row (see the
  // module doc's "THE MODEL"). Always `false` on a `budget_line` row: a
  // TRULY linked line is folded away entirely, never surfaced as its own row.
  linked: v.boolean(),
  // True when this row's normalized label overlaps an UNLINKED row of a
  // DIFFERENT sourceKind (module vs. budget_line) — a possible same-expense
  // collision the system can't prove, flagged for a human. Never set on a
  // linked row (already provably not a duplicate — it's the SAME expense,
  // by construction, not a suspected one).
  possibleDuplicate: v.boolean(),
});

/** `eventCostGrid`'s own working shape: every `collectEventPlannedRows` field
 *  plus the grid-only `possibleDuplicate` flag (computed here, AFTER the
 *  shared sweep — a display-only signal `refMoney`'s union has no use for). */
type GridWorkingRow = PlannedRow & { possibleDuplicate: boolean };

// A short, generic English stopword list — enough to keep "the AV budget" and
// "the AV rental" from colliding on "the", without pulling in an NLP library.
const DUPLICATE_STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "this", "that", "cost", "cents", "fee",
]);

/** Normalize a row label into its SIGNIFICANT lowercase word-tokens (>= 4
 *  chars, not a stopword) — a deliberately simple, conservative "does this
 *  look like the same expense" signal: two labels are flagged as a possible
 *  duplicate when they share at least one significant token, never on a
 *  bare/short/common word alone. Reused consistently for every row (module
 *  and budget-line alike) so the comparison is symmetric. */
function significantTokens(label: string): Set<string> {
  return new Set(
    label
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 4 && !DUPLICATE_STOPWORDS.has(t)),
  );
}

function tokensOverlap(a: Set<string>, b: Set<string>): boolean {
  for (const t of a) if (b.has(t)) return true;
  return false;
}

export const eventCostGrid = query({
  args: { eventId: v.id("events") },
  returns: v.object({
    isTraining: v.boolean(),
    rows: v.array(gridRow),
    totalPlannedCents: v.number(),
  }),
  handler: async (ctx, args) => {
    const empty = { isTraining: false, rows: [] as never[], totalPlannedCents: 0 };
    const authz = await resolveRefAuthz(ctx, "event", args.eventId);
    if (!authz) return empty;
    if (authz.isTraining) return { ...empty, isTraining: true }; // #172

    // The full items ∪ vendors ∪ budgetLines sweep — sourceRef-merge already
    // applied (see `collectEventPlannedRows`'s doc comment). `possibleDuplicate`
    // (below) is the only thing left for this query to compute itself.
    const rows: GridWorkingRow[] = (
      await collectEventPlannedRows(ctx, args.eventId, authz.chapterId, authz)
    ).map((row) => ({ ...row, possibleDuplicate: false }));
    const budgetLineRows = rows.filter((r) => r.sourceKind === "budget_line");

    // ── Possible-duplicate flagging (unlinked rows only) ────────────────────
    // Conservative + symmetric: only compares a `budget_line` row against a
    // module row (`event_item`/`vendor`) — the double-count shape the review
    // actually flagged — never two rows of the SAME sourceKind (two Tasks
    // named similarly aren't a "same expense counted twice" concern).
    const moduleRows = rows.filter((r) => r.sourceKind !== "budget_line" && !r.linked);
    const moduleTokens = moduleRows.map((r) => significantTokens(r.label));
    for (const line of budgetLineRows) {
      if (line.linked) continue; // already provably the same expense, not "possible"
      const lineTokens = significantTokens(line.label);
      if (lineTokens.size === 0) continue;
      for (let i = 0; i < moduleRows.length; i++) {
        if (tokensOverlap(lineTokens, moduleTokens[i])) {
          line.possibleDuplicate = true;
          moduleRows[i].possibleDuplicate = true;
        }
      }
    }

    rows.sort((a, b) => {
      if (a.typeLabel !== b.typeLabel) return a.typeLabel.localeCompare(b.typeLabel);
      return a.label.localeCompare(b.label);
    });

    return {
      isTraining: false,
      rows: rows.map(({ refId: _refId, ...row }) => row),
      totalPlannedCents: rows.reduce((sum, r) => sum + r.plannedCents, 0),
    };
  },
});
