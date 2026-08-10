/**
 * Finance public API — Phase 1A (no-vendor core).
 *
 * The real backend behind `api.finances.*`: funds / categories / teams CRUD,
 * budgets (scope × cadence × category), the unified `transactions` record
 * (create / categorize / reconcile / receipt / flag-personal), and the read
 * rollups (chapter + central dashboards, budget-vs-actual, event / project /
 * team / person actuals).
 *
 * Gating (finance-role ladder viewer < bookkeeper < manager):
 *  - reads                          → requireFinanceRole(..., "viewer")
 *    (EXCEPTIONS, member-visible by design: `personTransactions`' own-rows
 *    path and `budgetsGlance` — see their doc comments)
 *  - transaction writes             → requireFinanceRole(..., "bookkeeper")
 *  - fund/category/team/budget CRUD → requireFinanceManager
 *  - central roll-up                → requireFinanceCentral
 *
 * INVARIANTS:
 *  - Money is ALWAYS a non-negative INTEGER number of cents. Direction is carried
 *    by `flow` (outflow/inflow/transfer), never a sign. `createManualTransaction`
 *    throws on floats/negatives (the arg validator can't).
 *  - Every function is chapter-scoped; every client-supplied id is verified to
 *    belong to the caller's chapter before use.
 *  - ANTI-DOUBLE-COUNT: `transfer`-flow rows (and `excluded`/personal rows) are
 *    excluded from all category/budget/actual SPEND totals (`countsAsSpend`).
 *    ESTIMATED money (budgets) is never summed with ACTUAL money (transactions).
 *  - Reads are bounded (`.take()` / paginate); rollups scope the index read to
 *    the period + chapter.
 */
import {
  query,
  mutation,
  internalMutation,
  internalQuery,
  internalAction,
} from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import {
  FUND_RESTRICTIONS,
  BUDGET_CATEGORY_KINDS,
  BUDGET_SCOPES,
  BUDGET_TYPES,
  BUDGET_REF_KINDS,
  BUDGET_TAG_KINDS,
  BUDGET_CADENCES,
  BUDGET_APPROVAL_STATUSES,
  BUDGET_APPROVAL_STATUS_LABELS,
  TRANSACTION_SOURCES,
  TRANSACTION_FLOWS,
  TRANSACTION_STATUSES,
  REPAYMENT_STATUSES,
  BUDGET_SCOPE_LABELS,
  BUDGET_TYPE_LABELS,
  CENTRAL,
  RECEIPT_GRACE_DAYS,
  MAX_NOTE_LENGTH,
  countsAsSpend,
  PAYOUT_PROCESSORS,
  PAYOUT_PROCESSOR_LABELS,
  easternParts,
  quarterOfMonth,
  formatCents,
  matchesMode,
  financeRoleAtLeast,
  FINANCE_ROLE_LABELS,
  CENTRAL_MERCHANT_KEYWORDS,
  CENTRAL_PROJECT_KEYWORDS,
  matchesAnyKeyword,
  REASSIGN_BATCH_CAP,
  chapterAffordability as chapterAffordabilityCalc,
  effectiveBudgetApprovalStatus,
  TRANSACTION_STATUS_LABELS,
  FINANCE_AUDIT_ACTIONS,
  type BudgetType,
  type BudgetRefKind,
  type BudgetApprovalStatus,
  type RepaymentStatus,
} from "@events-os/shared";
import { readSandbox } from "./financeSettings";
import { MAX_MILESTONES } from "./backerMilestones";
import { gatherForPickerCandidates } from "./lib/forPickerCandidates";
import {
  isMissingReceiptCharge,
  unlockCardIfReceiptsResolved,
  convertChargeToPersonalRepayment,
} from "./cards";
import { createReceipt, linkReceiptToTransaction } from "./lib/receiptLinks";
import { logFinanceAudit } from "./lib/financeAuditLog";
import {
  pendingExceptionForTransaction,
  retireApprovedExceptionOnAmountChange,
} from "./lib/receiptExceptions";
import { requireCorrectTransaction, isTransactionCorrectable } from "./lib/financeEditAccess";
import {
  getChapterIdOrNull,
  requireChapterId,
  requireUserId,
} from "./lib/context";
import {
  requireFinanceRole,
  requireFinanceManager,
  requireFinanceCentral,
  requireAllBooksReconcile,
  requireCrossBookAttribution,
  requireCentralFinanceRoleOrEdSeat,
  requireCentralEdOrFm,
  resolveCallerPersonId,
  assertSeparationOfDuties,
  getFinanceRole,
  defaultFundId,
  type FinanceScope,
} from "./lib/finance";
import { requireSuperuser, isSuperuser } from "./lib/superuser";
import {
  recordTransferPair,
  transferPairLegs,
  transferScopes,
  type TransferDirection,
} from "./lib/transferPair";
import { viewerPerson, callerHasEventEditRights } from "./lib/org";
import { codingPolicy } from "./lib/transactionCoding";
import { chargeOutstanding } from "./lib/codingReminders";
import { holdsApprovalSeatAt } from "./lib/seats";
import { listActiveChapters } from "./lib/chapters";
import {
  RECONCILE_FILTER_KEYS,
  TRANSACTION_CODING_STATUSES,
  countsTowardFacet,
  matchesReconcileFilters,
  reconcileFilterGroupOf,
  RECONCILE_ATTENTION_KEYS,
  reconcileSearchTerms,
  matchesReconcileSearch,
  RECEIPT_EXCEPTION_REASON_LABELS,
  isReconstructedHistory,
  MAX_MERCHANT_NAME_LENGTH,
  providerMerchantName,
  type ReconcileFilterKey,
} from "@events-os/shared";
import {
  ensureDefaultFunds,
  insertDefaultExpenseCategories,
} from "./lib/seed/finance";
import { sendEmail, emailShell } from "./ticketingEmails";
import { emailButtonRow, emailHeading, emailParagraph } from "./lib/emailShell";
import { escapeHtml } from "./lib/html";
import { appUrl } from "./lib/siteUrl";

// ── Enum validators (built from the shared tuples) ───────────────────────────
const restrictionValidator = v.union(
  ...FUND_RESTRICTIONS.map((r) => v.literal(r)),
);
const categoryKindValidator = v.union(
  ...BUDGET_CATEGORY_KINDS.map((k) => v.literal(k)),
);
const scopeValidator = v.union(...BUDGET_SCOPES.map((s) => v.literal(s)));
const typeValidator = v.union(...BUDGET_TYPES.map((t) => v.literal(t)));
const refKindValidator = v.union(...BUDGET_REF_KINDS.map((k) => v.literal(k)));
const tagKindValidator = v.union(...BUDGET_TAG_KINDS.map((k) => v.literal(k)));
const cadenceValidator = v.union(...BUDGET_CADENCES.map((c) => v.literal(c)));
const approvalStatusValidator = v.union(
  ...BUDGET_APPROVAL_STATUSES.map((s) => v.literal(s)),
);
const sourceValidator = v.union(...TRANSACTION_SOURCES.map((s) => v.literal(s)));
const flowValidator = v.union(...TRANSACTION_FLOWS.map((f) => v.literal(f)));
const statusValidator = v.union(
  ...TRANSACTION_STATUSES.map((s) => v.literal(s)),
);
const repaymentStatusValidator = v.union(
  ...REPAYMENT_STATUSES.map((s) => v.literal(s)),
);

// ── Row-shape validators (the read projections) ──────────────────────────────
const categorySummary = v.object({
  id: v.id("budgetCategories"),
  fundId: v.id("funds"),
  parentCategoryId: v.union(v.id("budgetCategories"), v.null()),
  name: v.string(),
  kind: categoryKindValidator,
  sortOrder: v.number(),
  isActive: v.boolean(),
});

const teamSummary = v.object({
  id: v.id("financeTeams"),
  name: v.string(),
  sortOrder: v.number(),
  isActive: v.boolean(),
});

// A tag as attached to a budget row (from its `budgetTagLinks`).
const budgetTagRef = v.object({
  id: v.id("budgetTags"),
  name: v.string(),
  kind: v.union(tagKindValidator, v.null()),
});

// WP-3.2: the approval-workflow fields every budget projection carries.
// `approvalStatus` is always the EFFECTIVE status (`effectiveBudgetApprovalStatus`
// — a grandfathered legacy row reads as `"approved"`, never `null`). `approvedCents`
// stays `null` until a budget has been through `approveBudget` at least once.
// `requestedCents` is the RAW `amountCents` (see `budgetApprovalCardFields`) —
// distinct from a card's own `budgetCents`, which is the EFFECTIVE cap (B1).
const budgetApprovalFields = {
  approvalStatus: approvalStatusValidator,
  approvedCents: v.union(v.number(), v.null()),
  reviewNote: v.union(v.string(), v.null()),
  requestedCents: v.number(),
  // WP-wave4 (item 8): which SoD path the last `approveBudget` decision took
  // — `null` until a budget has been approved at least once (mirrors
  // `approvedCents`'s own null-until-decided shape).
  approvalParty: v.union(v.literal("single"), v.literal("two_party"), v.null()),
};

const budgetSummary = v.object({
  id: v.id("budgets"),
  amountCents: v.number(),
  label: v.union(v.string(), v.null()),
  // v2 source of truth. `scope` is a nullable legacy column (absent on v2-native
  // budgets); prefer `type`.
  type: v.union(typeValidator, v.null()),
  refKind: v.union(refKindValidator, v.null()),
  scope: v.union(scopeValidator, v.null()),
  scopeRefId: v.union(v.string(), v.null()),
  cadence: cadenceValidator,
  year: v.number(),
  month: v.union(v.number(), v.null()),
  quarter: v.union(v.number(), v.null()),
  fundId: v.union(v.id("funds"), v.null()),
  categoryId: v.union(v.id("budgetCategories"), v.null()),
  teamId: v.union(v.id("financeTeams"), v.null()),
  // The budget's managed tags (many-to-many via `budgetTagLinks`).
  tags: v.array(budgetTagRef),
  // Whether this is a chapter budget or an org-level (central) budget. Feeds the
  // reconcile Budget picker's Chapter / Central grouping.
  level: v.union(v.literal("chapter"), v.literal("central")),
  ...budgetApprovalFields,
});

// A per-tag rollup row (chapter dashboard carries `tagId`; central aggregates
// same-named tags across chapters and leaves `tagId` null).
const tagRollupRow = v.object({
  tagId: v.union(v.id("budgetTags"), v.null()),
  tagName: v.string(),
  kind: v.union(tagKindValidator, v.null()),
  budgetCents: v.number(),
  spentCents: v.number(),
  pct: v.number(),
  status: v.union(v.literal("ok"), v.literal("warn")),
});

// Shared field map so the reconcile row can extend the summary without drift.
const txnSummaryFields = {
  id: v.id("transactions"),
  postedAt: v.number(),
  amountCents: v.number(),
  flow: flowValidator,
  // The flow this row was INGESTED with, kept when `markAsTransfer` rewrites
  // `flow` to "transfer". Sent to the client because the grid renders the sign
  // from `flow`, and a marked pair would otherwise show BOTH legs positive —
  // the money's direction survives only here (owner report, 2026-08-07).
  preMarkFlow: v.union(v.literal("inflow"), v.literal("outflow"), v.null()),
  status: statusValidator,
  description: v.union(v.string(), v.null()),
  merchantName: v.union(v.string(), v.null()),
  // The bookkeeper's readable RENAME of the merchant slot, or null when the
  // row has never been renamed (or the rename was cleared). Shipped ALONGSIDE
  // the provider's `merchantName`/`description` rather than folded into them:
  // the client resolves what to show through `displayMerchantName`
  // (`@events-os/shared`), and the original stays one field away for anyone
  // who needs to see what the statement actually said.
  merchantNameOverride: v.union(v.string(), v.null()),
  // True iff this row has ever been renamed — the ONLY thing the grid needs to
  // decide whether to offer the history affordance. Deliberately a boolean and
  // not the timestamp behind it: "when" belongs in the trail
  // (`financeAuditTrail`), which is where anyone who cares is about to look
  // anyway, and shipping a bare `renamedAt` invites a second, poorer rendering
  // of the same fact next to the real one.
  hasMerchantRenameHistory: v.boolean(),
  // R1a: the bookkeeper's own freeform note ("who was this for and why") —
  // distinct from `description` (provider-sourced). Null until set.
  note: v.union(v.string(), v.null()),
  fundId: v.union(v.id("funds"), v.null()),
  categoryId: v.union(v.id("budgetCategories"), v.null()),
  budgetId: v.union(v.id("budgets"), v.null()),
  // SOFT attribution warning: a spend txn with no budget still needs to be
  // rolled up. True iff `isSpend(tr) && budgetId == null` (transfers / excluded /
  // personal / inflow are never flagged). Drives the reconcile "needs budget"
  // badge + warning strip — never a hard block.
  needsBudget: v.boolean(),
  // True iff a receipt is attached (`receiptStorageId != null`) — the truthful
  // signal behind the reconcile chase filter + Documentation column.
  hasReceipt: v.boolean(),
  // True iff an APPROVED receipt exception stands in for the receipt
  // (`approvedReceiptExceptionId != null`). Paired with `hasReceipt` this is
  // everything `documentationState` (`@events-os/shared`) needs, so a client
  // can render the three-value documentation story from the payload alone.
  // Read off the denormalized pointer — no query into `receiptExceptions`.
  hasApprovedException: v.boolean(),
  // Where this row's substantiation record sits in review
  // (`transactionCodings`), or null when none has ever been submitted. Read
  // off the `transactions.codingState` denorm, which exists precisely so no
  // reader needs a per-row join.
  //
  // On `personTransactions` this is what lets the member's own "My
  // transactions" screen sort and filter its queue — "needs coding", "sent
  // back — needs your edit" — from ONE subscription instead of one per row.
  // The reviewer's send-back NOTE is deliberately not here: it's needed only
  // when a member opens a charge, so it stays a single `getForTransaction`
  // read on that one row rather than a string shipped for every row in the
  // list.
  codingState: v.union(
    ...TRANSACTION_CODING_STATUSES.map((s) => v.literal(s)),
    v.null(),
  ),
  // The personal-charge flag (`cards.flagPersonalCharge` / `flagPersonal`) —
  // an accidental personal charge, excluded from every SPEND total until
  // repaid. Surfaced (R1b follow-up) so the Reconcile grid + member "My
  // transactions" can SHOW the flag from the payload instead of tracking
  // "what did I just flag" in session-local state, which forgot the flag on
  // every reload and never showed a manager-flagged charge at all.
  isPersonal: v.boolean(),
  // Marking state, surfaced for the same reason `isPersonal` is: the grid must
  // SHOW what's been marked (badge + row action state) straight from the
  // payload, not from session-local memory of "what did I just mark".
  // `isMarkedTransfer` is the bookkeeper-marked internal transfer
  // (`finances.markAsTransfer`) — deliberately NOT true for an app-created
  // transfer leg, which has no un-mark action. `payoutProcessor` is the
  // processor-payout label (`markAsPayout`), null when unmarked.
  isMarkedTransfer: v.boolean(),
  payoutProcessor: v.union(
    ...PAYOUT_PROCESSORS.map((p) => v.literal(p)),
    v.null(),
  ),
  // The card's last-4 (parsed out of the sync description), for display.
  cardLast4: v.union(v.string(), v.null()),
  // Receipt-reminder timeline stage ("none" until a day-1/day-3 nudge fires;
  // see `cards.advanceReceiptReminders`). Drives the Reconcile grid's Receipt
  // column past the plain "missing" state.
  reminderStage: v.union(
    v.literal("none"),
    v.literal("flagged"),
    v.literal("escalated"),
  ),
};
const txnSummary = v.object(txnSummaryFields);

// `personTransactions`'s projection (the member's own "My transactions" view)
// is `txnSummary` itself — same shape, no field stripped. Owner decision: a
// member MAY see the bookkeeper's `note` ("who was this for and why") on
// THEIR OWN transactions (read-only), but never on anyone else's. Since the
// shape is uniform, that gate happens per-row in `toMemberTxnSummary` (nulling
// `note` rather than omitting the key) — see its doc comment.

// The resolved cardholder behind a charge: the `personId` on the txn, else the
// person who owns the `cardId`. Powers the reconcile Cardholder column.
const cardholderRef = v.object({
  personId: v.id("people"),
  name: v.string(),
  imageUrl: v.union(v.string(), v.null()),
});

// ── Books (the central/chapter split, made visible) ──────────────────────────
// Central and each chapter keep SEPARATE BOOKS. They're separate OPERATING
// entities under one legal entity, so merging them into one queue is a workflow
// choice, not a compliance one — but which book a charge belongs to is never
// ambiguous, and a merged queue that didn't say so per row would just relocate
// the confusion it set out to fix.
//
// `canEdit` mirrors `requireReconcileTxn`'s write rule EXACTLY: central-owned
// rows need central reach, chapter-owned rows must be the caller's OWN chapter.
// So in the merged queue a central holder can READ a foreign chapter's rows
// without being able to edit them — the grid renders exactly those read-only
// rather than offering an inline edit the server would reject. Today, with one
// chapter and a dual-hatted treasurer, every row comes back `canEdit: true`;
// the flag exists so the day a second chapter lands is a no-op here.
const reconcileBook = v.object({
  id: v.union(v.id("chapters"), v.literal(CENTRAL)),
  name: v.string(),
  canEdit: v.boolean(),
});

// One reconcile-grid row: the txn summary (which already carries `budgetId` —
// the "For" picker's current value) plus the resolved cardholder and any
// pending AI proposal. No separate project/event link field (WP-U).
const reconcileRow = v.object({
  ...txnSummaryFields,
  // What actually backs this row up, resolved server-side so the grid's
  // Documentation cell can render the whole story without a per-row query.
  // `state` mirrors `documentationState` (`@events-os/shared`): a receipt
  // outranks an approved exception, which outranks nothing.
  // `pendingReason` is set when an exception has been FILED but not yet
  // decided — deliberately NOT part of `state`, because asking to be let off
  // isn't being let off, and the cell has to be able to say "awaiting
  // approval" without claiming the row is documented.
  // True iff this row's SOURCE will accept a correction (`manual` only). The
  // server decides, so the grid never offers an edit button that would throw —
  // same discipline as `book.canEdit`.
  correctable: v.boolean(),
  // Reconstructed from a spreadsheet / export / document rather than observed
  // as it happened. A label, never a permission — see `isReconstructedHistory`.
  isReconstructed: v.boolean(),
  documentation: v.object({
    state: v.union(
      v.literal("receipt"),
      v.literal("exception"),
      v.literal("undocumented"),
    ),
    /** Human label of the APPROVED exception's reason, when `state` is
     *  `"exception"` — what the cell shows in place of "Attached". */
    reasonLabel: v.union(v.string(), v.null()),
    /** Human label of a PENDING exception's reason, if one is open. */
    pendingReason: v.union(v.string(), v.null()),
  }),
  cardholder: v.union(cardholderRef, v.null()),
  // Which book PAID for this charge — custody, i.e. whose card/account the
  // money actually left (see `reconcileBook`). Always populated, in every
  // scope: a single-book queue still labels its rows, so a screenshot of the
  // grid is unambiguous on its own (the same reasoning behind `ScopeBadge`).
  book: reconcileBook,
  // Which book this charge COUNTS AGAINST — the linked budget's owner. `null`
  // while unattributed (most of the "To review" queue).
  //
  // Custody and attribution are two different facts and the app needs both.
  // `book` is bank reality: it's what reconciles against a statement, and what
  // `requireReconcileTxn` gates writes on. `chargedTo` is programme reality:
  // it's what a budget's actuals count, and what the org rolls up. They agree
  // on almost every row; where they DIFFER, one book fronted money for another
  // and the difference is a receivable — netted into a settlement by
  // `transfers.ts#interScopeBalances` and shown per-row here so a treasurer can
  // see it at the point of coding, not only on the central dashboard's
  // balances panel.
  //
  // Deliberately NOT collapsed into one field: an unattributed row has no
  // budget (so a budget-derived book would be undefined for exactly the review
  // queue), `canEdit` would flip as a row is coded, and a book's rows would
  // stop summing to its bank statement.
  chargedTo: v.union(
    v.object({
      id: v.union(v.id("chapters"), v.literal(CENTRAL)),
      name: v.string(),
    }),
    v.null(),
  ),
  // The linked personal repayment's LIVE status (`personalRepayments` via
  // `repaymentId`) — `null` for an unflagged charge (or a flagged one whose
  // repayment row vanished). Lets the grid's Personal badge distinguish
  // "awaiting repayment" from "repaid" instead of one undated flag forever.
  repaymentStatus: v.union(repaymentStatusValidator, v.null()),
});

// The reconcile filter pills (server-side, correct across ALL rows).
// `spend` (no-dead-numbers): the exact predicate the "Spent" KPI tile sums
// (`isSpend` — outflow, not excluded, not personal) — the drill-down target
// for that tile, distinct from `all` (which keeps inflow/transfer/personal
// rows too, so it would NOT sum to the same figure).
// `personal_unpaid`: an unpaid personal expense — exactly the worklist a
// treasurer needs (founder ask: surface it "in the reconcile flow"). Reuses
// the SAME `isPersonal` + linked-repayment-status pair `repaymentStatus`
// already resolves per row (see `personalExpenseState` in
// `@events-os/shared`) — a row qualifies iff `isPersonal === true` AND its
// repayment isn't `"paid"` (a `"failed"` attempt still counts — the debt is
// still outstanding).
//
// NAMING (founder report — "it says review 80 but 80 is nowhere in Reconcile"):
// two of these keys used to lie about their own predicate, which is how a
// dashboard number could point at a grid that never showed it.
//   - `to_review` was `uncategorized`, but its predicate is and always was
//     `status === "unreviewed"` — nothing to do with whether a CATEGORY is
//     set. That word already means something else in this codebase
//     (`dashboardCharts.budgetTransactions`' `"uncategorized"` sentinel =
//     "no `categoryId`", the honest use), so the same term named two
//     different things one file apart. It's now spelled the same as the
//     dashboards' own "To review" tile — the tile and the pill it drills into
//     finally share one word for one predicate.
//   - `reconciled` was `ready`, which reads as "ready TO reconcile" — the
//     actionable backlog. It's the opposite: rows already CLEARED
//     (`status === "reconciled"`), the complement of the header's "N to
//     clear" (`all - reconciled`).
const reconcileFilterValidator = v.union(
  v.literal("all"),
  v.literal("spend"),
  v.literal("needs_budget"),
  v.literal("missing_receipt"),
  v.literal("uncoded"),
  v.literal("coding_review"),
  v.literal("to_review"),
  v.literal("reconciled"),
  v.literal("undocumented"),
  v.literal("personal_unpaid"),
  v.literal("transfers"),
  v.literal("payouts"),
  // The header roll-ups (`RECONCILE_HEADER_CHIPS`). Complements over the OPEN
  // set, so `needs_attention + ready_to_close === toClearCount` by
  // construction — see `flagsFor`.
  v.literal("needs_attention"),
  v.literal("ready_to_close"),
);

// Per-filter counts returned alongside the rows so each pill shows its number.
const reconcileCounts = v.object({
  all: v.number(),
  spend: v.number(),
  needs_budget: v.number(),
  missing_receipt: v.number(),
  uncoded: v.number(),
  coding_review: v.number(),
  to_review: v.number(),
  reconciled: v.number(),
  undocumented: v.number(),
  personal_unpaid: v.number(),
  transfers: v.number(),
  payouts: v.number(),
  needs_attention: v.number(),
  ready_to_close: v.number(),
});

// Per-fund SPEND for the dashboard period (period reads are naturally bounded;
// all-time balance is deferred to the Increase sync in Phase 4).
const fundPeriodSpend = v.object({
  id: v.id("funds"),
  name: v.string(),
  spentCents: v.number(),
});

// ── Enriched dashboard projections (prototype shapes) ────────────────────────
const okWarnValidator = v.union(v.literal("ok"), v.literal("warn"));

const categoryBreakdown = v.object({
  name: v.string(),
  spentCents: v.number(),
  barPct: v.number(),
});

const chapterTile = v.object({
  label: v.string(),
  value: v.string(),
  subValueCents: v.optional(v.number()),
  meta: v.string(),
});

const centralTile = v.object({
  label: v.string(),
  value: v.string(),
  meta: v.string(),
});

// One book's share of the org "to review" backlog (see `toReviewByBook` in
// `dashboardCentral`). The org total on its own is a DEAD NUMBER — Reconcile
// works one book at a time, or all books merged, so a bare "84" has no single
// destination and (before this) linked somewhere that never showed it. The
// breakdown gives every part of the total a place to go: each entry opens that
// book's queue filtered to `to_review`, and the headline opens the merged
// all-books queue on the same filter.
const toReviewBookCount = v.object({
  id: v.union(v.id("chapters"), v.literal(CENTRAL)),
  name: v.string(),
  count: v.number(),
});

// An org-level (central) budget rolled up org-wide: its allocation + its actual
// spend summed from EVERY chapter's transactions explicitly linked to it.
const centralBudgetCard = v.object({
  id: v.id("budgets"),
  // WP-wave4 (item 2 — ref name/date sync): the resolved display name — a
  // one-time card's linked event/project's LIVE name (falling back to the
  // budget's own stored label/type-word when unlinked or the ref vanished —
  // see `resolveBudgetRef`), or the recurring fallback for a bucket budget.
  // Replaces the old raw `label` field (its only consumer, `CentralView`'s
  // `CentralBudgetCard`, re-derived this exact fallback client-side).
  name: v.string(),
  dateLabel: v.union(v.string(), v.null()),
  // WP-wave4 (item 4 — deep links): the linked event/project (one-time
  // central budgets only — a recurring central budget carries neither).
  refKind: v.union(refKindValidator, v.null()),
  scopeRefId: v.union(v.string(), v.null()),
  // Legacy scope (nullable on v2-native central budgets).
  scope: v.union(scopeValidator, v.null()),
  cadence: cadenceValidator,
  year: v.number(),
  budgetCents: v.number(),
  spentCents: v.number(),
  pct: v.number(),
  status: okWarnValidator,
  // Projects-category-breakdown: the same per-category mini-bar shape the
  // chapter cards carry (`projectBudgetCard`/`recurringBudgetCard`), summed
  // from the SAME matched-txn set as this card's own `spentCents` — so the
  // org dashboard's expand-chevron can break a central budget down into
  // categories (and from there into transactions, via the already-central-
  // capable `dashboardCharts.budgetTransactions`).
  categories: v.array(categoryBreakdown),
  ...budgetApprovalFields,
});

const projectBudgetCard = v.object({
  id: v.id("budgets"),
  name: v.string(),
  cadence: v.union(v.literal("per_instance"), v.literal("one_off")),
  sourceBadge: v.optional(v.union(v.string(), v.null())),
  dateLabel: v.optional(v.union(v.string(), v.null())),
  subtitle: v.optional(v.union(v.string(), v.null())),
  // WP-wave4 (item 4 — deep links): the linked event/project, so the client
  // can offer an "open" button to `/event/[id]` or `/project/[id]`. Null for
  // a budget with no ref (shouldn't happen on a one-time card, but kept
  // nullable rather than asserted so a data anomaly degrades to "no button").
  refKind: v.union(refKindValidator, v.null()),
  scopeRefId: v.union(v.string(), v.null()),
  spentCents: v.number(),
  budgetCents: v.number(),
  pct: v.number(),
  remainingCents: v.number(),
  status: okWarnValidator,
  categories: v.array(categoryBreakdown),
  ...budgetApprovalFields,
});

const recurringBudgetCard = v.object({
  id: v.id("budgets"),
  name: v.string(),
  cadence: v.union(
    v.literal("monthly"),
    v.literal("quarterly"),
    v.literal("yearly"),
  ),
  spentCents: v.number(),
  budgetCents: v.number(),
  pct: v.number(),
  status: okWarnValidator,
  categories: v.optional(v.array(categoryBreakdown)),
  note: v.optional(v.union(v.string(), v.null())),
  // DASH-2.1 (bug 1): ADDITIVE fields, kept alongside the pre-existing
  // `spentCents`/`budgetCents`/`pct` triple (still the cadence-cumulative
  // figure — "$978.78 of $1,000 this year" — so the deployed UI keeps reading
  // correctly with zero changes) so a follow-up UI PR can render a
  // month-honest breakdown too: "clicking a month should show breakdowns
  // based on that month's transactions" (owner report — a yearly/quarterly
  // bucket showed the SAME cumulative figure in every month).
  //  - `periodSpendCents`: spend in the dashboard's SELECTED MONTH only,
  //    regardless of cadence or period mode (month vs YTD) — for a `monthly`
  //    cadence card in month mode this equals `spentCents` exactly (the
  //    cumulative figure already IS one month); for `quarterly`/`yearly` it's
  //    the narrower, actually-useful number.
  //  - `fullCapCents`: the cadence's own full cap (`effectiveCapCents`),
  //    invariant to cadence/period mode — always "$1,000", never a prorated
  //    slice.
  //  - `cadenceSpendCents`: alias of `spentCents` (named for clarity at the
  //    call site) — the cumulative spend over the card's own cadence window.
  periodSpendCents: v.optional(v.number()),
  fullCapCents: v.optional(v.number()),
  cadenceSpendCents: v.optional(v.number()),
  ...budgetApprovalFields,
});

const recentTxnCard = v.object({
  id: v.id("transactions"),
  date: v.string(),
  merchant: v.union(v.string(), v.null()),
  cardLast4: v.optional(v.union(v.string(), v.null())),
  spenderName: v.optional(v.union(v.string(), v.null())),
  timeOrNote: v.optional(v.union(v.string(), v.null())),
  codedTo: v.optional(
    v.union(
      v.object({
        projectOrEvent: v.string(),
        category: v.string(),
        // WP-wave4 (item 4 — deep links) restore: the digest row's own
        // budget ref, so `TransactionDetailModal`'s "lookup" entry (opened
        // from this card) can offer the same "Part of: <name> ›" link a
        // budget-scoped drill-down already carries. `null` for a recurring-
        // budget-coded txn, or one with no ref (mirrors `projectOrEvent`
        // itself, which is the SAME ref resolved to a display name below).
        refKind: v.union(refKindValidator, v.null()),
        scopeRefId: v.union(v.string(), v.null()),
      }),
      v.null(),
    ),
  ),
  amountCents: v.number(),
  flow: flowValidator,
  status: statusValidator,
});

const attentionItem = v.object({
  kind: v.string(),
  title: v.string(),
  badgeCount: v.number(),
  detail: v.string(),
  actionLabel: v.string(),
});

const chapterRollupRow = v.object({
  // A real chapter, or the CENTRAL sentinel for the "Central" row (WP-0.3) —
  // central-scoped spend rolled up alongside the chapter rows.
  chapterId: v.union(v.id("chapters"), v.literal(CENTRAL)),
  chapterName: v.string(),
  subtitle: v.optional(v.union(v.string(), v.null())),
  spentCents: v.number(),
  budgetCents: v.number(),
  barPct: v.number(),
  status: okWarnValidator,
});

// ── Bounds (keep every read + rollup bounded) ────────────────────────────────
export const ROLLUP_SCAN_LIMIT = 5000;
const RECENT_TXN_COUNT = 10;
// R1a: `MAX_NOTE_LENGTH` (a transaction note is a short "who/why"
// justification, not a document) is shared from `@events-os/shared` — the
// mobile `TransactionNoteModal` imports the same constant for its `maxLength`.
const DAY_MS = 24 * 60 * 60 * 1000;

// ── Projection helpers ───────────────────────────────────────────────────────
function toCategorySummary(c: Doc<"budgetCategories">) {
  return {
    id: c._id,
    fundId: c.fundId,
    parentCategoryId: c.parentCategoryId ?? null,
    name: c.name,
    kind: c.kind,
    sortOrder: c.sortOrder ?? 0,
    isActive: c.isActive ?? true,
  };
}

function toTeamSummary(tm: Doc<"financeTeams">) {
  return {
    id: tm._id,
    name: tm.name,
    sortOrder: tm.sortOrder,
    isActive: tm.isActive ?? true,
  };
}

/**
 * WP-3.2: the approval-workflow fields shared by every budget card projection
 * (`toBudgetSummary` + the dashboard's project/recurring/central cards). Always
 * the EFFECTIVE status (grandfathered legacy rows read as `"approved"`) — see
 * `effectiveBudgetApprovalStatus`. `requestedCents` is the RAW `amountCents` —
 * kept alongside the (now cap-driven) `budgetCents` a card computes for its own
 * pct/remaining/status, so `BudgetApprovalChip` can still show BOTH numbers
 * ("approved at $X, requested $Y") while an increase is pending.
 */
function budgetApprovalCardFields(b: Doc<"budgets">) {
  return {
    approvalStatus: effectiveBudgetApprovalStatus(b.approvalStatus),
    approvedCents: b.approvedCents ?? null,
    reviewNote: b.reviewNote ?? null,
    requestedCents: b.amountCents,
    approvalParty: b.approvalParty ?? null,
  };
}

/**
 * WP-3.2 review (B1): THE cap every numeric budget surface computes against —
 * pct, remaining, status, and every card/bar/rollup's `budgetCents`. A budget
 * currently `"submitted"`, `"changes_requested"`, OR (WP-wave4 item 3) a
 * DRAFT INCREASE (`"draft"` WITH a recorded `approvedCents` — see
 * `setBudgetAmount`'s retrigger doc) reports that still-in-force `approvedCents`
 * cap (an increase past it is pending review/send, never advertised as
 * already available); every other case (a brand-new draft with no prior
 * approval, plainly approved, or a grandfathered legacy row with no literal
 * status) reports the plain `amountCents`. A brand-new draft never has
 * `approvedCents` set (only `approveBudget`/the retrigger ever stamp it), so
 * the `b.approvedCents != null` guard is what tells the two `"draft"` cases
 * apart. Grandfathered rows need no special case here — they carry no
 * `approvalStatus` at all, so they never match until `setBudgetAmount`'s
 * retrigger rule (I1) stamps one explicitly on their first increase.
 *
 * Checks the RAW `approvalStatus` (not `effectiveBudgetApprovalStatus`) —
 * deliberately: the effective mapping only ever renames "absent" to
 * `"approved"`, so it can never itself equal `"submitted"`/`"changes_requested"`/
 * `"draft"`.
 */
export function effectiveCapCents(b: Doc<"budgets">): number {
  if (
    (b.approvalStatus === "submitted" ||
      b.approvalStatus === "changes_requested" ||
      b.approvalStatus === "draft") &&
    b.approvedCents != null
  ) {
    return b.approvedCents;
  }
  return b.amountCents;
}

/**
 * WP-wave4 (item 5 — owner addendum, 2026-07-17): "is there a reason why I
 * can attach a charge to a project with no budget yet? We should only be
 * able to add it for approved budgets." A budget is ATTRIBUTABLE — offerable
 * by the "For" picker (`forPickerOptions`, `reconcileSuggest.ts`'s
 * independent `rankForPicker` scan) and acceptable to
 * `categorizeTransaction`/`bulkCategorize`/`createManualTransaction` — only
 * once `effectiveBudgetApprovalStatus(b.approvalStatus) === "approved"`. A
 * GRANDFATHERED legacy budget (`approvalStatus` absent) counts as approved
 * per that function's own normalization (it maps "absent" to `"approved"`,
 * never anything else), so pre-WP-3.2 budgets attribute exactly as they
 * always could. A `"draft"`, `"submitted"`, or `"changes_requested"` budget —
 * including a DRAFT INCREASE (still `"draft"`, WP-wave4 item 3) — is NOT
 * attributable: draft → send → approve is now the only path to one.
 *
 * The SINGLE gate both the picker (read-side, filters silently) and the
 * write-side mutations (throw) share, so they can never drift on which refs
 * are offerable vs. acceptable.
 */
export function isAttributableBudget(b: Doc<"budgets"> | null | undefined): b is Doc<"budgets"> {
  return b != null && effectiveBudgetApprovalStatus(b.approvalStatus) === "approved";
}

/**
 * Assert `budgetId` is attributable (`isAttributableBudget`) — the WRITE-side
 * half of the item-5 gate. Every transaction-attribution mutation calls this
 * (`categorizeTransaction`, `bulkCategorize`, `createManualTransaction`) —
 * never a chapter/central-scope check (that's `requireInCallerChapter`'s job,
 * called separately at each site); this is purely the approval-status axis.
 * A rejected attribution leaves the transaction exactly where it was — still
 * in the loud "Needs budget" bucket (`unattributedCents`/`needs_budget`
 * filter), the intended holding state until its target budget clears review.
 */
async function assertBudgetApprovedForAttribution(
  ctx: QueryCtx,
  budgetId: Id<"budgets">,
): Promise<void> {
  const budget = await ctx.db.get(budgetId);
  if (!budget) {
    throw new ConvexError({ code: "NOT_FOUND", message: "Budget not found." });
  }
  if (!isAttributableBudget(budget)) {
    throw new ConvexError({
      code: "BUDGET_NOT_APPROVED",
      message: `"${budgetDisplayName(budget)}" isn't approved yet — only approved budgets can have charges attached. It'll stay in Needs Budget until it's approved.`,
    });
  }
}

function toBudgetSummary(
  b: Doc<"budgets">,
  tags: { id: Id<"budgetTags">; name: string; kind: (typeof BUDGET_TAG_KINDS)[number] | null }[],
) {
  return {
    id: b._id,
    amountCents: b.amountCents,
    label: b.label ?? null,
    type: effectiveType(b),
    refKind: effectiveRefKind(b),
    scope: b.scope ?? null,
    scopeRefId: b.scopeRefId ?? null,
    cadence: b.cadence,
    year: b.year,
    month: b.month ?? null,
    quarter: b.quarter ?? null,
    fundId: b.fundId ?? null,
    categoryId: b.categoryId ?? null,
    teamId: b.teamId ?? null,
    tags,
    level: b.chapterId === CENTRAL ? ("central" as const) : ("chapter" as const),
    ...budgetApprovalCardFields(b),
  };
}

/** A budget's display name: its own label, else its type word — the same
 *  fallback the mobile `budgetName()` helper uses (kept as one twinned rule,
 *  not two). Used by the "For" picker's Recurring group + the AI suggestion's
 *  resolved budget name. */
function budgetDisplayName(b: Doc<"budgets">): string {
  return b.label?.trim() || BUDGET_TYPE_LABELS[effectiveType(b)];
}

// ── financeAuditLog: recode (category/budget attribution) helper ────────────
/**
 * Log a `recode` row per attribution field that was EXPLICITLY changed by the
 * caller — never the silent fund-default fill-in (`defaultFundId`) that
 * `categorizeTransaction`/`bulkCategorize` apply when a client omits `fundId`
 * on a fund-less txn; that's not a human choice worth a trail entry. Shared by
 * `categorizeTransaction`, `bulkCategorize`, and `setTransactionCategory` (the
 * category-only editor) so all three attribution-change paths log identically.
 * A no-op "change" (before === after, e.g. re-picking the same category) is
 * skipped — nothing actually changed.
 */
async function logRecodeAudit(
  ctx: MutationCtx,
  params: {
    txn: Doc<"transactions">;
    scope: FinanceScope;
    actorPersonId: Id<"people"> | null;
    categoryChanged: boolean;
    budgetChanged: boolean;
    beforeCategoryId: Id<"budgetCategories"> | null;
    afterCategoryId: Id<"budgetCategories"> | null;
    beforeBudgetId: Id<"budgets"> | null;
    afterBudgetId: Id<"budgets"> | null;
  },
): Promise<void> {
  if (!params.categoryChanged && !params.budgetChanged) return;
  const getCategory = nameCache(ctx, "budgetCategories");
  const getBudget = nameCache(ctx, "budgets");
  const categoryLabel = async (id: Id<"budgetCategories"> | null): Promise<string> => {
    if (!id) return "None";
    const c = await getCategory(id);
    return c ? c.name : "Deleted category";
  };
  const budgetLabel = async (id: Id<"budgets"> | null): Promise<string> => {
    if (!id) return "None";
    const b = await getBudget(id);
    return b ? budgetDisplayName(b) : "Deleted budget";
  };
  if (
    params.categoryChanged &&
    params.beforeCategoryId !== params.afterCategoryId
  ) {
    await logFinanceAudit(ctx, {
      chapterId: params.scope,
      subjectType: "transaction",
      subjectId: params.txn._id,
      action: "recode",
      actorPersonId: params.actorPersonId,
      field: "category",
      before: await categoryLabel(params.beforeCategoryId),
      after: await categoryLabel(params.afterCategoryId),
      amountCents: params.txn.amountCents,
    });
  }
  if (params.budgetChanged && params.beforeBudgetId !== params.afterBudgetId) {
    await logFinanceAudit(ctx, {
      chapterId: params.scope,
      subjectType: "transaction",
      subjectId: params.txn._id,
      action: "recode",
      actorPersonId: params.actorPersonId,
      field: "budget",
      before: await budgetLabel(params.beforeBudgetId),
      after: await budgetLabel(params.afterBudgetId),
      amountCents: params.txn.amountCents,
    });
  }
}

function toTxnSummary(tr: Doc<"transactions">) {
  return {
    id: tr._id,
    postedAt: tr.postedAt,
    amountCents: tr.amountCents,
    flow: tr.flow,
    preMarkFlow: tr.preMarkFlow ?? null,
    status: tr.status,
    description: tr.description ?? null,
    merchantName: tr.merchantName ?? null,
    merchantNameOverride: tr.merchantNameOverride ?? null,
    hasMerchantRenameHistory: tr.merchantNameRenamedAt != null,
    note: tr.note ?? null,
    fundId: tr.fundId ?? null,
    categoryId: tr.categoryId ?? null,
    budgetId: tr.budgetId ?? null,
    needsBudget: needsBudget(tr),
    hasReceipt: tr.receiptStorageId != null,
    hasApprovedException: tr.approvedReceiptExceptionId != null,
    codingState: tr.codingState ?? null,
    isPersonal: tr.isPersonal === true,
    isMarkedTransfer: isMarkedTransfer(tr),
    payoutProcessor: tr.payoutProcessor ?? null,
    cardLast4: tr.cardLast4 ?? null,
    reminderStage: tr.receiptReminderStage ?? ("none" as const),
  };
}

/**
 * `personTransactions`'s per-row projection: `toTxnSummary`, with `note`
 * nulled out UNLESS `tr` belongs to the viewer's own person. `viewerPersonId`
 * is the CALLER's own resolved person (`self._id`), not the `personId` being
 * queried — `personTransactions` also serves the finance-role "look up a
 * different person's transactions" audit path (see its doc comment), and
 * that path must never leak the bookkeeper's note through this endpoint even
 * though every row in a given call shares one `personId`. Checked per-row
 * (not once for the whole response) so this stays correct if the query is
 * ever broadened to return rows for more than one person at a time.
 */
function toMemberTxnSummary(
  tr: Doc<"transactions">,
  viewerPersonId: Id<"people"> | null,
) {
  const summary = toTxnSummary(tr);
  const isOwn = viewerPersonId != null && tr.personId === viewerPersonId;
  return { ...summary, note: isOwn ? summary.note : null };
}

// ── Money / tenancy guards ───────────────────────────────────────────────────
/**
 * Enforce the non-negative-integer-cents invariant the validator can't.
 * Exported (review fix) so the entity-side no-row branches
 * (`events.updateDetails` / `projects.update`) can validate BEFORE writing
 * straight to the field — the same check the row branch already gets for
 * free via `setBudgetAmount`.
 */
export function assertIntegerCents(amountCents: number, label = "Amount"): void {
  if (!Number.isInteger(amountCents) || amountCents < 0) {
    throw new ConvexError({
      code: "INVALID_AMOUNT",
      message: `${label} must be a non-negative whole number of cents.`,
    });
  }
}

/**
 * Load a document by id and assert it belongs to the caller's chapter. When
 * `allowCentral`, an org-level doc passes too: a central budget (`chapterId ===
 * "central"`, the CENTRAL sentinel) or a central finance team (absent
 * `chapterId`, the legacy financeTeams convention, kept until its own PR).
 */
async function requireInCallerChapter<T extends "funds" | "budgetCategories" | "financeTeams" | "budgets" | "budgetTags" | "transactions" | "events" | "projects" | "people">(
  ctx: QueryCtx,
  // A real chapter, or the org level (`"central"`) for a central-scoped verify
  // (e.g. attributing a central-owned txn to a central budget) — WP-2.1.
  chapterId: FinanceScope,
  table: T,
  id: Id<T>,
  label: string,
  opts: { allowCentral?: boolean } = {},
): Promise<Doc<T>> {
  const doc = await ctx.db.get(id);
  const docChapter = (doc as { chapterId?: Id<"chapters"> | typeof CENTRAL } | null)?.chapterId;
  const isCentralDoc = docChapter === CENTRAL || docChapter === undefined;
  if (!doc || (docChapter !== chapterId && !(opts.allowCentral && isCentralDoc))) {
    throw new ConvexError({
      code: "NOT_FOUND",
      message: `${label} not found in your chapter.`,
    });
  }
  return doc as Doc<T>;
}

/**
 * Resolve + authorize the budget a CENTRAL-owned transaction is being charged
 * to. Two legitimate targets:
 *
 *  - A CENTRAL budget — central's own book paying for its own line item. The
 *    only case the app allowed until now.
 *  - A CHAPTER budget — CROSS-BOOK: central's card paid, but the spend belongs
 *    to that chapter's programme (the founder's case: a Public Worship card
 *    buying something for New York). Custody stays central — the money really
 *    did leave central's account, and `transactions.chapterId` is never
 *    rewritten — while the BUDGET decides whose programme it counts against.
 *    The gap between the two is a receivable, which
 *    `transfers.ts#interScopeBalances` already nets into a settlement as its
 *    direction (b); that term was computed generically for exactly this, and
 *    goes from always-zero to live the moment this branch is reachable.
 *
 * The cross-book branch goes through `requireCrossBookAttribution`
 * (`lib/finance.ts`) rather than an inline `isCentral`, so restricting who may
 * charge another book — or layering an acceptance step on top — is a one-file
 * change later. Today that resolver's body is the central-reach check, which
 * `requireReconcileTxn`/`requireFinanceCentral` already asserted before we get
 * here; re-checking is deliberate (the gate must be true at the point the
 * cross-book decision is actually made, not inferred from an earlier one).
 *
 * NOT relaxed into `requireInCallerChapter`'s `allowCentral` option: that
 * helper answers "does this doc belong to the caller's scope (or central)?",
 * and cross-book is precisely the case where the answer is NO and the write is
 * still correct. Widening it there would silently loosen every other caller
 * of that primitive — funds, categories, teams, events, projects, people.
 */
/**
 * CROSS-BOOK ROWS CHARGED TO A CHAPTER'S BUDGETS — the transactions another
 * book PAID for but that belong to `chapterId`'s programme.
 *
 * Every chapter-budget actual in this app was summed from the chapter's OWN
 * transactions (`loadPeriodTxns(ctx, chapterId, …)`), and `actualsForRef` even
 * filtered its `by_budget` read back down to `tr.chapterId === chapterId` as
 * defence-in-depth. That was CORRECT while cross-book attribution only ran one
 * way (a chapter fronting central, which lands on a CENTRAL budget and so was
 * never a chapter budget's problem). Central budgets have always summed via
 * `by_budget` across every chapter for exactly this reason.
 *
 * Opening the reverse direction (`requireBudgetForCentralTxn`) breaks that
 * assumption: a Public Worship card charged to a New York budget is a real
 * charge against New York's plan that no custody-scoped scan can see. Without
 * this helper the budget would silently under-report — the card would show
 * $500/$2,000 when $800 had actually been committed.
 *
 * Returns the mode-filtered central-owned rows whose `budgetId` resolves to one
 * of this chapter's budgets, ready to be UNIONED with the chapter's own txns
 * before any budget-actual math. Bounded by the chapter's budget count (one
 * `by_budget` read each), which is the same shape `actualsForRef` and the
 * central budget cards already use.
 *
 * DELIBERATELY NOT folded into `loadPeriodTxns`: that function answers "what
 * did this chapter's account do", which is the honest input for the "Spent"
 * tile, the recent-transactions digest, and anything reconciled against a bank
 * statement. Those must stay custody-scoped — the difference between them and
 * the budget view IS the receivable, and collapsing the two would hide it.
 */
async function loadCrossBookTxnsForChapterBudgets(
  ctx: QueryCtx,
  budgets: Doc<"budgets">[],
  chapterId: Id<"chapters">,
  sandboxMode: boolean,
): Promise<Doc<"transactions">[]> {
  const out: Doc<"transactions">[] = [];
  for (const b of budgets) {
    if (b.chapterId !== chapterId) continue;
    const linked = await ctx.db
      .query("transactions")
      .withIndex("by_budget", (q) => q.eq("budgetId", b._id))
      .take(ROLLUP_SCAN_LIMIT);
    for (const tr of linked) {
      // Only rows another book PAID for — the chapter's own are already in
      // the custody scan every caller unions this with, and double-counting
      // them would inflate every budget on the page.
      if (tr.chapterId === chapterId) continue;
      if (!txnMatchesMode(tr, sandboxMode)) continue;
      out.push(tr);
    }
  }
  return out;
}

/**
 * Resolve + authorize a CATEGORY on a central-owned transaction.
 *
 * Central has no categories of its own — `budgetCategories` is chapter-scoped —
 * so for most central rows the answer is still "no category". But a CROSS-BOOK
 * charge (central's card, a chapter's budget) is economically that chapter's
 * spend, and it lands on that chapter's budget card. Refusing a category there
 * produced a hole nobody could close:
 *
 *  - the central FM was refused outright by `categorizeTransaction`;
 *  - the receiving chapter's treasurer can't write the row at all, because it
 *    lives in CENTRAL's book and `requireReconcileTxn` scopes writes to the
 *    caller's own chapter.
 *
 * So the spend sat permanently in the "Uncategorized" bar of a budget belonging
 * to a chapter with no way to fix it. That's not a post-split hypothetical: the
 * refusal keys off the transaction's BOOK, not the person, so it bit even a
 * treasurer holding both seats.
 *
 * The category must belong to the BUDGET's chapter — not the caller's. Those
 * are the same chapter today (one chapter, dual-hatted treasurer) and will not
 * be after the split, so binding it to the budget is the rule that survives.
 * Deliberately narrower than `verifyTxnRefs`, which validates refs against the
 * TRANSACTION's own scope — exactly the assumption cross-book breaks.
 */
async function requireCategoryForCentralTxn(
  ctx: MutationCtx,
  categoryId: Id<"budgetCategories">,
  budgetId: Id<"budgets"> | null,
): Promise<void> {
  const unsupported = (message: string) =>
    new ConvexError({ code: "UNSUPPORTED", message });
  if (!budgetId) {
    throw unsupported(
      "Attribute this charge to a chapter's budget first — a central charge only takes a category when a chapter is absorbing it.",
    );
  }
  const budget = await ctx.db.get(budgetId);
  if (!budget || budget.chapterId === CENTRAL) {
    throw unsupported(
      "A charge on a central budget has no category — categories belong to chapters.",
    );
  }
  const category = await ctx.db.get(categoryId);
  if (!category || category.chapterId !== budget.chapterId) {
    throw new ConvexError({
      code: "NOT_FOUND",
      message: "Category not found in the chapter this charge is attributed to.",
    });
  }
}

async function requireBudgetForCentralTxn(
  ctx: MutationCtx,
  homeChapterId: Id<"chapters">,
  budgetId: Id<"budgets">,
): Promise<Doc<"budgets">> {
  const budget = await ctx.db.get(budgetId);
  if (!budget) {
    throw new ConvexError({ code: "NOT_FOUND", message: "Budget not found." });
  }
  if (budget.chapterId !== CENTRAL) {
    await requireCrossBookAttribution(ctx, homeChapterId);
  }
  return budget;
}

/** True iff a transaction contributes to category / budget / actual SPEND.
 *  Exported for `transfers.ts#interScopeBalances` (WP-4.5), which reuses this
 *  exact gate when summing cross-scope-attributed spend. */
export function isSpend(tr: Doc<"transactions">): boolean {
  return (
    tr.flow === "outflow" &&
    countsAsSpend(tr.flow) &&
    tr.status !== "excluded" &&
    tr.isPersonal !== true &&
    // A charge that was refunded in full is not spend. The money came back, so
    // counting it against a budget overstates what the budget consumed.
    //
    // Done HERE rather than at the ~30 call sites because every one of them —
    // budget totals, "needs budget", the dashboard drills, receipt chasing —
    // wants the same answer, and a predicate they all already share is the only
    // place to change it once. The refunding CREDIT needs no special case: it's
    // an inflow, and `isSpend` was never true for those.
    tr.refundedByTransactionId === undefined
  );
}

/**
 * True iff this row is a per-transaction processor or bank fee — a cost that
 * was CHARGED, not chosen.
 *
 * Written by `processorFees.ts` (sweeping Stripe's balance transactions) and,
 * on the Cash App rows, by a 2026-08 backfill since removed — and read here.
 * A POSITIVE MARKER, never an inference: the alternative was
 * matching on the `stripe-fees:` external-id prefix, which would silently miss
 * Cash App's rows (a different prefix) and would break the moment a key format
 * changed. Same rule `preMarkFlow` follows for transfers, and for the same
 * reason.
 *
 * DELIBERATELY NARROW. It marks the fee taken out of an individual payment,
 * nothing else. A monthly platform subscription, a paid Givebutter tier, an
 * accounting service — those are real decisions somebody makes, they belong to
 * whoever decided, and they stay budgeted. Being coded to "Bank & Fees" does
 * not exempt anything; carrying a `feeOrigin` does.
 */
export function isNonDiscretionaryFee(tr: Doc<"transactions">): boolean {
  return tr.feeOrigin != null;
}

/**
 * True iff a spend transaction still needs a budget attached — the Reconcile
 * "needs budget" soft-attribution signal (never a hard block).
 *
 * ── A FEE IS SPEND, BUT IT IS NOT A DECISION ────────────────────────────────
 * A budget is a control on CHOICE. Processor fees aren't one: they are
 * mechanically 2.9% + 30¢ of money the org already decided to accept, and you
 * cannot decline the fee without declining the gift. So a fee budget can never
 * cause anyone to spend less — it can only produce friction and false alarms.
 * It is also an INVERTED indicator: "over budget on fees" is what a record
 * fundraising month looks like. At $1M raised, Stripe's cut is ~$29,000 against
 * a $300 ceiling, and every fee row sits unreconciled until somebody manually
 * raises a number that was never a decision. (Owner, 2026-08-09.)
 *
 * Until now that produced 8 rows totalling $318.69 permanently reading "Needs
 * budget", waiting on approval of two draft budgets a cron had proposed to
 * itself.
 *
 * ── WHY HERE AND NOT IN `isSpend` ───────────────────────────────────────────
 * Because a fee IS spend. The money genuinely left, and it must keep counting
 * in book value, in category totals, in the "Spent" tile and in tag rollups —
 * putting the exemption in `isSpend` would quietly drop $318.69 of real cost
 * out of every one of those. The only thing that changes is whether anyone is
 * asked to attribute it to a budget. That is exactly one question, so it is
 * answered in exactly one predicate.
 *
 * This follows the grain `lib/bookBalance.ts#signedBookCents` already set:
 * rows that aren't decisions someone made (payout legs, engine transfers) are
 * recognised by a positive marker and treated differently, rather than being
 * wished away.
 */
export function needsBudget(tr: Doc<"transactions">): boolean {
  return isSpend(tr) && tr.budgetId == null && !isNonDiscretionaryFee(tr);
}

/**
 * True iff this row is an internal bank transfer a bookkeeper MARKED in
 * Reconcile (`markAsTransfer`), as opposed to a `flow:"transfer"` leg that got
 * there any other way. Both are excluded from spend; only a MARKED one owes a
 * receipt and can be un-marked.
 *
 * The tell is `preMarkFlow`, which ONLY `markAsTransfer` ever writes and only
 * `unmarkTransfer` ever clears. Deliberately NOT "`flow:"transfer"` with a
 * source other than `"transfer"`" — that reads as a reasonable discriminator
 * and is wrong on real data: the app writes transfer legs under several other
 * sources (`reimbursement`, `repayment`, and the retired `skim`/
 * `launch_grant`/`settlement` kinds still on historical prod rows). Treating
 * those as "marked" would drag years of settled history into the receipt
 * chase, and would offer an Un-mark button that rewrites a booked historical
 * leg to `outflow`. A positive marker can't make that mistake.
 */
export function isMarkedTransfer(tr: Doc<"transactions">): boolean {
  return tr.flow === "transfer" && tr.preMarkFlow != null;
}

/** True iff this row is a donation-processor settlement deposit a bookkeeper
 *  marked (`markAsPayout`). Deliberately still `flow:"inflow"` — see
 *  `PAYOUT_PROCESSORS` (`@events-os/shared`) for why marking one as a transfer
 *  would erase the org's revenue. */
export function isProcessorPayout(tr: Doc<"transactions">): boolean {
  return tr.payoutProcessor != null;
}

/**
 * True iff a row still owes a receipt / supporting document — the ONE
 * predicate behind the Reconcile `missing_receipt` pill AND the `receiptChase`
 * list (they're kept in lockstep on purpose; this function is that lockstep,
 * replacing the two hand-copied expressions that used to drift).
 *
 * Founder ask, with the marking feature: an internal transfer and a processor
 * payout "should still have receipts". Documentation obligation is therefore
 * NOT the same axis as spend:
 *  - a SPEND charge owes a receipt (the original rule, `isSpend`),
 *  - a MARKED INTERNAL TRANSFER owes one too — it's `flow:"transfer"`, so
 *    `isSpend` is false and it would otherwise vanish from the chase the
 *    instant someone marked it (the same disappearing act the Academy's old
 *    "just mark it Excluded" advice caused),
 *  - a MARKED PROCESSOR PAYOUT owes one as well — an `inflow` was NEVER in
 *    this bucket to begin with, so this is the first time a deposit can be
 *    chased for its settlement report at all.
 * A transfer/payout that was never marked is untouched: an unmarked inflow
 * still owes nothing, exactly as before.
 *
 * `reconciled` still ends the chase for every class (a treasurer who closed a
 * row document-less made a call — there's nobody left to chase), and
 * `excluded` never enters it.
 */
export function needsDocumentation(tr: Doc<"transactions">): boolean {
  if (tr.receiptStorageId != null) return false;
  // An APPROVED receipt exception is documentation — an attested, second-party
  // -approved statement of what this was for and why no receipt exists. It
  // closes the chase exactly like a receipt does (a pending one deliberately
  // does NOT: asking to be let off isn't being let off). See
  // `docs/plans/receipt-exceptions.md`.
  if (tr.approvedReceiptExceptionId != null) return false;
  if (tr.status === "reconciled" || tr.status === "excluded") return false;
  return isSpend(tr) || isMarkedTransfer(tr) || isProcessorPayout(tr);
}

/**
 * True iff a transaction has NOTHING backing it up — no receipt and no
 * approved exception — regardless of its status. The honest counterpart to
 * `needsDocumentation`, which stops chasing a `reconciled` row.
 *
 * This is the PUBLISHING predicate and the historical-cleanup worklist: a row
 * a treasurer closed document-less years ago is invisible to the chase and
 * loudly visible here, which is the whole point. Scoped to rows that OWE
 * documentation in the first place (`isSpend` / marked transfer / marked
 * payout, never `excluded`), so an ordinary donation inflow doesn't read as an
 * undocumented gap.
 *
 * Mirrors `documentationState(...) === "undocumented"` (`@events-os/shared`)
 * for the subset of rows that owe anything — that function is the one the
 * public ledger renders per row; this one is how the backlog is counted.
 */
export function isUndocumented(tr: Doc<"transactions">): boolean {
  if (tr.status === "excluded") return false;
  if (tr.receiptStorageId != null) return false;
  if (tr.approvedReceiptExceptionId != null) return false;
  return isSpend(tr) || isMarkedTransfer(tr) || isProcessorPayout(tr);
}

/**
 * True iff the CODING POLICY says this row owes a substantiation record
 * (`transactionCodings` — see `docs/plans/transaction-coding.md`): spend
 * posted at/after `sinceMs` (`lib/transactionCoding.ts#codingPolicy`, default
 * 2026-09-01, the owner-decided policy date). Deliberately narrower than the
 * documentation predicates above — transfers, payouts, inflows and personal
 * charges are exempt; coding is about SPEND substantiation. Pre-policy
 * history never lights up: that backlog is a separate, deliberate cleanup
 * (`historicalImportBatch`), not an ambient nag.
 */
export function requiresCoding(
  tr: Doc<"transactions">,
  sinceMs: number,
): boolean {
  if (tr.postedAt < sinceMs) return false;
  return isSpend(tr);
}

/**
 * True iff a row the policy gates is waiting on its AUTHOR: no coding ever
 * submitted, or the reviewer sent it back (`changes_requested`). A coding
 * sitting in review (`submitted`) is deliberately NOT uncoded — that row is
 * waiting on the treasurer, and it has its own facet (`coding_review`).
 */
export function isUncoded(tr: Doc<"transactions">, sinceMs: number): boolean {
  if (!requiresCoding(tr, sinceMs)) return false;
  // CHASE semantics, like `needsDocumentation`: a closed row has nobody left
  // to chase. Post-policy rows can't legitimately CLOSE uncoded (the
  // `CODING_REQUIRED` gate refuses), so the only rows this skips are
  // legacy/direct writes — visible to an audit, not to the nag.
  if (tr.status === "reconciled") return false;
  return tr.codingState == null || tr.codingState === "changes_requested";
}

// ── Period helpers (Eastern-time bucketing) ──────────────────────────────────
/** True iff a timestamp falls in the given Eastern year (+ optional month/quarter).
 *  Exported for `transfers.ts#interScopeBalances` (WP-4.5). */
export function inPeriod(
  postedAt: number,
  year: number,
  month?: number,
  quarter?: number,
): boolean {
  const p = easternParts(postedAt);
  if (p.year !== year) return false;
  if (month != null && p.month !== month) return false;
  if (quarter != null && quarterOfMonth(p.month) !== quarter) return false;
  return true;
}

/**
 * Read the chapter's transactions for a year (optionally a single month),
 * bounded via the `by_chapter_and_postedAt` range. The UTC window is padded a
 * day on each side to cover the Eastern offset; callers narrow precisely with
 * `inPeriod`.
 *
 * NOTE (scale): the read is capped at `ROLLUP_SCAN_LIMIT`. Past that many
 * transactions in one period the aggregate is truncated (a non-silent
 * `console.warn` fires). Accurate aggregation at high sync volume lands with the
 * Increase/Stripe sync phases (denormalized counters), not now.
 */
async function loadPeriodTxns(
  ctx: QueryCtx,
  // A real chapter, or `"central"` to read CENTRAL-owned txns (WP-2.1). The
  // `by_chapter_and_postedAt` index keys on the string, so the sentinel reads
  // back exactly the central-owned rows and nothing else.
  chapterId: FinanceScope,
  year: number,
  sandboxMode: boolean,
  month?: number,
): Promise<Doc<"transactions">[]> {
  const startUtc =
    (month != null ? Date.UTC(year, month - 1, 1) : Date.UTC(year, 0, 1)) -
    DAY_MS;
  const endUtc =
    (month != null ? Date.UTC(year, month, 1) : Date.UTC(year + 1, 0, 1)) +
    DAY_MS;
  const rows = await ctx.db
    .query("transactions")
    .withIndex("by_chapter_and_postedAt", (q) =>
      q.eq("chapterId", chapterId).gte("postedAt", startUtc).lt("postedAt", endUtc),
    )
    .take(ROLLUP_SCAN_LIMIT);
  if (rows.length === ROLLUP_SCAN_LIMIT) {
    console.warn(
      `[finances] period read hit ROLLUP_SCAN_LIMIT (${ROLLUP_SCAN_LIMIT}) for chapter ${chapterId} ${year}${month ? `-${month}` : ""}; aggregate truncated until sync-volume counters land.`,
    );
  }
  return rows.filter((tr) => txnMatchesMode(tr, sandboxMode));
}

/**
 * Defensive environment filter for transaction reads. Drops `increase_card` /
 * `increase_ach` txns whose Increase external/source id belongs to the OTHER
 * environment than the current mode (a `sandbox_` id while in production, or
 * vice-versa). A null id, or any non-Increase source (manual / reimbursement /
 * repayment / stripe_fc), is environment-NEUTRAL and always kept.
 *
 * `increase_*` rows are written by `increaseLedger.ts` (card charges as
 * `increase_card`, all other account activity as `increase_ach`), each
 * stamped with its Increase transaction id in `externalId` — the prefix this
 * gate reads.
 *
 * Exported for `transfers.ts#interScopeBalances` (WP-4.5), which applies this
 * same gate to the underlying card/ACH spend it cross-attributes.
 */
export function txnMatchesMode(tr: Doc<"transactions">, sandboxMode: boolean): boolean {
  if (tr.source !== "increase_card" && tr.source !== "increase_ach") return true;
  return matchesMode(tr.externalId ?? tr.sourceAccountId ?? null, sandboxMode);
}

/**
 * The period a budget's spend is measured over, resolved against the dashboard's
 * `contextMonth`. A MONTHLY budget stored as "$2,000/mo" carries no `month`, so
 * without this it would (wrongly) match all 12 months — its spend is scoped to
 * the queried month. Quarterly → the quarter of the queried month; yearly → the
 * whole year; per-instance / one-off use the budget's OWN declared month/quarter
 * when it has one — and otherwise ALSO fall back to `contextMonth`, exactly like
 * the monthly branch: a one-time budget with no stored `month` (a leader can
 * create one via `createBudget` without picking one) is not "every month, all
 * year" any more than a month-less recurring budget is — without this fallback
 * its spend would double-count into every month's aggregate (tag rollups,
 * `budgetVsActual`, central budget cards). NOT used at all for a one-time
 * dashboard CARD's own bar (chapter or central) — that's a genuinely lifetime
 * total, ignoring even the budget's OWN declared month/quarter; see
 * `oneTimeCardBreakdown`, which never calls this function.
 */
function budgetEffectivePeriod(
  b: Doc<"budgets">,
  contextMonth?: number,
): { year: number; month?: number; quarter?: number } {
  const year = b.year;
  switch (b.cadence) {
    case "monthly": {
      const month = b.month ?? contextMonth;
      return month != null ? { year, month } : { year };
    }
    case "quarterly": {
      const quarter =
        b.quarter ?? (contextMonth != null ? quarterOfMonth(contextMonth) : undefined);
      return quarter != null ? { year, quarter } : { year };
    }
    case "yearly":
      return { year };
    case "per_instance":
    case "one_off":
    default: {
      const month = b.month ?? contextMonth;
      return { year, month: month ?? undefined, quarter: b.quarter ?? undefined };
    }
  }
}

/**
 * A budget's v2 `type`, tolerant of un-migrated legacy rows: a row without a
 * `type` yet derives one from its legacy `scope` (event/project → one_time,
 * everything else → recurring), so dashboards keep working before the backfill.
 */
export function effectiveType(b: Doc<"budgets">): BudgetType {
  if (b.type) return b.type;
  return b.scope === "event" || b.scope === "project" ? "one_time" : "recurring";
}

/** A one_time budget's ref kind, deriving from legacy `scope` when unset.
 *  Exported for the `0027_sync_linked_budget_identity` migration, which
 *  needs to find every effectively-linked budget, tolerant of un-migrated
 *  legacy rows the same way every other v2 reader is. */
export function effectiveRefKind(b: Doc<"budgets">): BudgetRefKind | null {
  if (b.refKind) return b.refKind;
  if (b.scope === "event") return "event";
  if (b.scope === "project") return "project";
  return null;
}

/**
 * The single budget-attribution rule, used by EVERY actuals sum so a dollar is
 * counted the same way everywhere: a txn counts toward a budget IFF it is
 * EXPLICITLY linked to it (`budgetId === b._id`) — no derived (fund/category/
 * team/event/project) matching. An unlinked txn counts toward NO budget; it
 * shows up as "Unattributed" instead (see `dashboardChapter.unattributedCents`).
 *
 * This is a straight port of the linked-only rule tag rollups already used —
 * made universal so a broad recurring budget with no narrowers can no longer
 * vacuum up every uncategorized txn in its period (the "Education & Growth
 * eats everything" bug).
 *
 * The budget's own cadence still determines the period window: a March
 * purchase linked to a MONTHLY budget lands in March (not every month), a
 * project/one-off budget counts over its declared period, and an event/
 * per_instance budget only within that instance. Without this the central
 * roll-up (read across all time via `by_budget`) would sum lifetime spend
 * instead of the queried period.
 *
 * The `isSpend` gate applies here too, so `transfer` / `excluded` / personal
 * rows stay out of every budget total even when explicitly linked (the
 * flow-carries-direction + transfer-excluded invariants hold regardless of an
 * explicit link).
 */
function txnCountsTowardBudget(
  tr: Doc<"transactions">,
  b: Doc<"budgets">,
  contextMonth?: number,
): boolean {
  if (!isSpend(tr) || tr.budgetId !== b._id) return false;
  const period = budgetEffectivePeriod(b, contextMonth);
  return inPeriod(tr.postedAt, period.year, period.month, period.quarter);
}

// ── Dashboard period (Month ↔ Year-to-date) ──────────────────────────────────
/**
 * The dashboard's selected period. `month` is always the THROUGH-month (the one
 * the stepper selects). In `"month"` mode the dashboard reports only that month;
 * in `"ytd"` mode it reports the cumulative Jan..throughMonth range of the year.
 * Every spend/actual aggregation reads this so the two modes stay in lock-step.
 */
type PeriodMode = "month" | "ytd";
type DashPeriod = { year: number; month: number; ytd: boolean };

/** True iff a timestamp falls in the dashboard's period: one month, or Jan..throughMonth (YTD). */
function inDashRange(postedAt: number, dp: DashPeriod): boolean {
  const p = easternParts(postedAt);
  if (p.year !== dp.year) return false;
  if (!dp.ytd) return p.month === dp.month;
  return p.month >= 1 && p.month <= dp.month;
}

/**
 * The YTD window for a budget's spend: the txn is in the budget's year, on or
 * before the through-month, and honors the budget's OWN fixed narrowers (a
 * fixed-month or fixed-quarter budget only matches its month/quarter). This
 * widens the single-month/quarter window that `budgetEffectivePeriod` +
 * `inPeriod` apply in month mode to the cumulative 1..throughMonth range for
 * period-scoped (month-null / quarter-null / yearly) budgets, without ever
 * double-counting a fixed-period budget.
 */
function inYtdBudgetWindow(postedAt: number, b: Doc<"budgets">, throughMonth: number): boolean {
  const p = easternParts(postedAt);
  if (p.year !== b.year) return false;
  if (p.month > throughMonth) return false;
  if (b.month != null && p.month !== b.month) return false;
  if (b.quarter != null && quarterOfMonth(p.month) !== b.quarter) return false;
  return true;
}

/**
 * The single budget-attribution rule, period-aware for the dashboard: in
 * `"month"` mode it defers to `txnCountsTowardBudget` (unchanged); in `"ytd"`
 * mode it keeps the exact same `isSpend` gate + explicit `budgetId` link but
 * widens the period window to Jan..throughMonth (`inYtdBudgetWindow`).
 */
function txnCountsTowardBudgetDash(
  tr: Doc<"transactions">,
  b: Doc<"budgets">,
  dp: DashPeriod,
): boolean {
  if (!dp.ytd) return txnCountsTowardBudget(tr, b, dp.month);
  if (!isSpend(tr) || tr.budgetId !== b._id) return false;
  return inYtdBudgetWindow(tr.postedAt, b, dp.month);
}

/**
 * Whether a txn's spend counts toward a budget for a By-tag AGGREGATE (tag
 * rollups + the tag drill-down) — NOT the same rule as `txnCountsTowardBudgetDash`,
 * which is deliberately CARD-shaped: for a budget with its OWN declared
 * `month`/`quarter` (e.g. an event budget stamped to May at creation), it
 * narrows `inPeriod` to THAT fixed month/quarter regardless of `dp` — correct
 * for a card, whose own bar reports on the budget's declared period no matter
 * which month you're viewing, but wrong for an AGGREGATE: a July charge on a
 * May-fixed budget would never count toward July's tag total (it only matches
 * May), while that same May charge would count toward EVERY month's tag total
 * including July (nothing in the check compares against `dp` at all once
 * `b.month` is set). That's the mis-scoping bug — a tag's "by month" total
 * silently tracked the budget's own fixed month instead of the viewed one, so
 * a July dashboard could show May's spend under "Events" while missing July's.
 *
 * A tag AGGREGATE needs the opposite rule: sum whatever this budget's linked
 * spend actually POSTED in the dashboard's OWN period (`inDashRange`), full
 * stop — ignoring the budget's own month/quarter narrowers entirely. This is
 * also what keeps a 12-month sum of a tag's aggregate exactly equal to its
 * whole-year (YTD) total: every linked spend txn is posted in exactly one
 * month, so it's counted in exactly one month's aggregate, never dropped or
 * double-counted regardless of which month the underlying budget declares.
 */
function txnCountsTowardTagAgg(
  tr: Doc<"transactions">,
  b: Doc<"budgets">,
  dp: DashPeriod,
): boolean {
  return isSpend(tr) && tr.budgetId === b._id && inDashRange(tr.postedAt, dp);
}

/** Is a recurring budget active anywhere in the dashboard period (any month for YTD)? */
function recurringAppliesToDash(b: Doc<"budgets">, dp: DashPeriod): boolean {
  if (!dp.ytd) return recurringAppliesToMonth(b, dp.year, dp.month);
  for (let m = 1; m <= dp.month; m++) {
    if (recurringAppliesToMonth(b, dp.year, m)) return true;
  }
  return false;
}

/**
 * DASH-2.1 (bug 2): a recurring budget's YTD denominator, cadence-aware — NOT
 * a per-month sum (see `monthEquivForDash`'s doc comment for why the naive
 * per-month sum is wrong for `quarterly`/`yearly`). Only reached for
 * `b.year === dp.year` in `"ytd"` mode by a genuinely recurring cadence
 * (`monthly`/`quarterly`/`yearly` — `effectiveType(b) !== "recurring"` budgets
 * never reach `monthEquivForDash`'s ytd branch at all, so `per_instance`/
 * `one_off` never hit this function).
 *
 * Owner rule (the exact bug report): "$978.78/$1,000 · 98%" for a YEARLY
 * budget stayed identical from Feb through Apr because the OLD denominator
 * was `capCents/12 * monthsElapsed` (a calendar pot prorated as if it were a
 * monthly allowance) — by April that's `$1,000/12×5 = $416.65`, so genuine
 * cumulative spend of $978.78 reads as "235% · Over", which is absurd for a
 * POT that's fully available the whole year. Fixed semantics, mirroring
 * `monthly`'s (unchanged, already-correct) "cap × months elapsed":
 *  - `monthly`   → cap × months elapsed (unchanged, falls through below).
 *  - `quarterly` → cap × QUARTERS elapsed (`Math.ceil(throughMonth / 3)`,
 *    the same "the current, in-progress period's full cap is already
 *    counted" rule `monthly` uses — by May, Q1 is fully elapsed AND Q2 has
 *    started, so 2 quarters' worth is due, not 5/3). A budget fixed to ONE
 *    specific quarter (`b.quarter` set) instead gets its cap once that
 *    quarter has started, 0 before it — never a fractional quarter.
 *  - `yearly`    → the FULL cap, unconditionally — a yearly budget is a pot
 *    available all year, not something that accrues month by month.
 */
function ytdCadenceAllocationCents(b: Doc<"budgets">, dp: DashPeriod): number | null {
  const capCents = effectiveCapCents(b);
  if (b.cadence === "yearly") return capCents;
  if (b.cadence === "quarterly") {
    if (b.quarter != null) {
      const quarterStartMonth = (b.quarter - 1) * 3 + 1;
      return quarterStartMonth <= dp.month ? capCents : 0;
    }
    const quartersElapsed = Math.ceil(dp.month / 3);
    return capCents * quartersElapsed;
  }
  // `monthly` (and any other cadence that reaches here) falls through to the
  // caller's unchanged per-month-sum loop.
  return null;
}

/**
 * A budget's month-equivalent allocation for the dashboard period: one month in
 * `"month"` mode (identical to `monthEquivalentBudgetCents` — a deliberately
 * DIFFERENT, comparison-normalized semantic from this function's own YTD
 * branch, used e.g. by the central chapter roll-up to compare one month of
 * mixed-cadence budgets; see that function's doc comment), or the cadence-aware
 * YTD allocation in `"ytd"` mode (`ytdCadenceAllocationCents` for
 * `quarterly`/`yearly` — DASH-2.1 bug 2; the sum across months 1..throughMonth
 * for `monthly`/`per_instance`/`one_off`, UNCHANGED — "spent vs allocated"
 * stays comparable when spend is accumulated YTD).
 */
function monthEquivForDash(b: Doc<"budgets">, dp: DashPeriod): number {
  if (!dp.ytd) return monthEquivalentBudgetCents(b, dp.year, dp.month);
  if (b.year === dp.year) {
    const cadenceAllocation = ytdCadenceAllocationCents(b, dp);
    if (cadenceAllocation != null) return cadenceAllocation;
  }
  let sum = 0;
  for (let m = 1; m <= dp.month; m++) sum += monthEquivalentBudgetCents(b, dp.year, m);
  return sum;
}

/**
 * A recurring/tag budget's ALLOCATION for the dashboard period. Month mode keeps
 * the EFFECTIVE cap (B1 — `effectiveCapCents`, never the raw `amountCents`, so a
 * pending unapproved increase is never advertised); YTD sums the per-month
 * allocation across months 1..throughMonth (per-period budgets scale, a fixed
 * one_time lump does not). Feeds the recurring cards' + tag rollups' +
 * central cards' `budgetCents`.
 */
function budgetAllocationForDash(b: Doc<"budgets">, dp: DashPeriod): number {
  if (!dp.ytd) return effectiveCapCents(b);
  if (effectiveType(b) !== "recurring") return effectiveCapCents(b);
  return monthEquivForDash(b, dp);
}

/**
 * A budget's ALLOCATION for a By-tag AGGREGATE (tag rollups + the tag
 * drill-down) — `budgetAllocationForDash` (above) is CARD-shaped: in month
 * mode it hands back a one-time budget's full effective cap unconditionally,
 * with no check that the budget is even relevant to the viewed month. That's
 * fine for the one-time CARD itself (its OWN visibility is separately
 * month-gated by `oneTimeCardAppliesToDash`, and once visible its bar is
 * deliberately lifetime-cumulative — see `oneTimeCardBreakdown`'s doc
 * comment), but an AGGREGATE has no per-budget visibility gate of its own: it
 * just sums `budgetAllocationForDash` over every budget carrying the tag, so
 * an irrelevant month's one-time cap silently inflated the denominator (a
 * June $500 + July $1,000 same-tag pair made BOTH months' tag row report
 * against $1,500). This reuses `oneTimeCardAppliesToDash`'s existing
 * relevance rule (own month matches / linked ref date in month / spend
 * posted that month) as a GATE on the allocation itself, rather than forking
 * a third relevance rule: a one-time budget's allocation counts toward a
 * tag's month-mode denominator only when it's relevant to that month, exactly
 * mirroring when its own card would be visible. YTD/year mode is unchanged
 * (matches `oneTimeCardAppliesToDash`'s `dp.ytd` early return — every
 * one-time budget counts, full stop). A recurring budget's
 * `budgetAllocationForDash` is already period-correct via `monthEquivForDash`
 * — this passes it through unconditionally, so this function is a strict
 * narrowing of `budgetAllocationForDash`, never a wider figure.
 */
function tagAllocationForDash(
  b: Doc<"budgets">,
  dp: DashPeriod,
  refDate: number | null,
  relevantTxns: Doc<"transactions">[],
): number {
  if (effectiveType(b) === "one_time" && !oneTimeCardAppliesToDash(b, dp, refDate, relevantTxns)) {
    return 0;
  }
  return budgetAllocationForDash(b, dp);
}

/**
 * WP-wave4 (item 2 — ref name/date sync): a one_time budget's LIVE display
 * fields, resolved from its linked event/project at READ TIME rather than a
 * stale mirrored `budget.label` — a rename or date change on the ref follows
 * everywhere this is called without a separate write-through step. `name` is
 * the ref's current `name` (event or project); `dateLabel`/`refDate` are the
 * event's `eventDate`, or the project's `deadline` (a project with no
 * deadline gets no date claim — see `forPickerOptions`'s "NO FABRICATED
 * DATES" doc comment for why `startDate`/`createdAt` are never substituted).
 * Falls back to the budget's OWN stored `label`/type-word
 * (`budgetDisplayName`) when the budget carries no ref, OR the ref has
 * vanished (a deleted event/project doesn't cascade to its budget) — the
 * fallback is never a raw "null"/blank card.
 *
 * The SINGLE resolver for every dashboard/tag/picker surface that shows a
 * one-time budget's name (`dashboardChapter`'s one-time cards,
 * `dashboardCentral`'s central one-time cards, `tagDrilldown`'s budget rows)
 * — before this, `dashboardChapter` had its own inline copy and
 * `dashboardCentral`/`tagDrilldown` didn't resolve live refs at all (still
 * exposing the stale stored `label`). `getEvent`/`getProject` are the
 * caller's own `nameCache`s (bounded read-through caches), so repeat lookups
 * of the same ref — a budget can carry more than one tag, or appear under
 * more than one call site in a single query — cost no extra reads.
 *
 * `live` (review fix — dead-link parity): true only when a ref was actually
 * resolved from a real event/project doc, false for the no-ref AND the
 * vanished-ref fallback alike (`events.remove` doesn't cascade to a linked
 * budget, so a deleted event's budget keeps a dead `scopeRefId` forever).
 * Callers that offer an "open ref" link (`oneTimeBudgets`/`centralBudgets`
 * cards) gate `refKind`/`scopeRefId` on this — never show a link for a ref
 * that doesn't (or no longer) resolves, same rule `dashboardChapter`'s
 * `codedTo.refKind` already applies to the recent-transactions digest.
 */
export async function resolveBudgetRef(
  b: Doc<"budgets">,
  getEvent: (id: Id<"events">) => Promise<Doc<"events"> | null>,
  getProject: (id: Id<"projects">) => Promise<Doc<"projects"> | null>,
): Promise<{ name: string; dateLabel: string | null; refDate: number | null; live: boolean }> {
  const refKind = effectiveRefKind(b);
  if (refKind === "event" && b.scopeRefId) {
    const ev = await getEvent(b.scopeRefId as Id<"events">);
    if (ev) {
      return {
        name: ev.name,
        dateLabel: easternDateStr(ev.eventDate),
        refDate: ev.eventDate,
        live: true,
      };
    }
  } else if (refKind === "project" && b.scopeRefId) {
    const pr = await getProject(b.scopeRefId as Id<"projects">);
    if (pr) {
      return {
        name: pr.name,
        dateLabel: pr.deadline ? easternDateStr(pr.deadline) : null,
        refDate: pr.deadline ?? pr.startDate ?? null,
        live: true,
      };
    }
  }
  return { name: budgetDisplayName(b), dateLabel: null, refDate: null, live: false };
}

/**
 * Resolve a one-time budget's linked event/project ref date alone, for
 * relevance checks that don't need the display name (`tagAllocationForDash`'s
 * gate, consulted by the tag rollups) — a thin wrapper over
 * `resolveBudgetRef` so those call sites don't build a name/dateLabel string
 * they never use.
 */
async function refDateForBudget(
  b: Doc<"budgets">,
  getEvent: (id: Id<"events">) => Promise<Doc<"events"> | null>,
  getProject: (id: Id<"projects">) => Promise<Doc<"projects"> | null>,
): Promise<number | null> {
  return (await resolveBudgetRef(b, getEvent, getProject)).refDate;
}

/** Translate a client patch: `null` clears the field, `undefined` is untouched. */
function cleanPatch(patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(patch)) {
    if (val === undefined) continue;
    out[k] = val === null ? undefined : val;
  }
  return out;
}

/** Resolve the caller's chapter for a READ (null → empty result, no throw). */
async function readChapterId(
  ctx: QueryCtx,
): Promise<Id<"chapters"> | null> {
  const id = await getChapterIdOrNull(ctx);
  return (id as Id<"chapters"> | null) ?? null;
}

/** The next sort order for a chapter-scoped list (max existing + 1). */
async function nextSortOrder(
  ctx: MutationCtx,
  rows: { sortOrder?: number }[],
): Promise<number> {
  let max = -1;
  for (const r of rows) if ((r.sortOrder ?? 0) > max) max = r.sortOrder ?? 0;
  return max + 1;
}

// ── Budget tags (managed, level-scoped) ──────────────────────────────────────
/** A budget's LEVEL: a real chapter id, or the CENTRAL sentinel. */
type BudgetLevel = Id<"chapters"> | typeof CENTRAL;

/**
 * True iff a tag at `tagLevel` may be attached to a budget at `budgetLevel`:
 * a chapter budget accepts its own chapter's tags OR central tags; a central
 * budget accepts only central tags.
 */
function tagLevelAllowed(tagLevel: BudgetLevel, budgetLevel: BudgetLevel): boolean {
  if (budgetLevel === CENTRAL) return tagLevel === CENTRAL;
  return tagLevel === budgetLevel || tagLevel === CENTRAL;
}

/** Load a tag and assert it's usable at the budget's level, else throw. */
async function requireTagInLevel(
  ctx: QueryCtx,
  budgetLevel: BudgetLevel,
  tagId: Id<"budgetTags">,
): Promise<Doc<"budgetTags">> {
  const tag = await ctx.db.get(tagId);
  if (!tag || !tagLevelAllowed(tag.chapterId, budgetLevel)) {
    throw new ConvexError({
      code: "NOT_FOUND",
      message: "Tag not found at this budget's level.",
    });
  }
  return tag;
}

/**
 * Find-or-create a managed tag at a level. Dedups by (level, kind, refId) via
 * `by_chapter_and_ref` when a `refId` is given, else by (name, kind) within the
 * level. Used by the event auto-tag on create + the scope→type migration.
 */
export async function ensureTag(
  ctx: MutationCtx,
  args: {
    chapterId: BudgetLevel;
    name: string;
    kind: (typeof BUDGET_TAG_KINDS)[number];
    refId?: string;
    createdBy?: Id<"users">;
  },
): Promise<Id<"budgetTags">> {
  if (args.refId) {
    const byRef = await ctx.db
      .query("budgetTags")
      .withIndex("by_chapter_and_ref", (q) =>
        q.eq("chapterId", args.chapterId).eq("kind", args.kind).eq("refId", args.refId),
      )
      .first();
    if (byRef) return byRef._id;
  }
  const byName = (
    await ctx.db
      .query("budgetTags")
      .withIndex("by_chapter", (q) => q.eq("chapterId", args.chapterId))
      .take(ROLLUP_SCAN_LIMIT)
  ).find((t) => t.name === args.name && t.kind === args.kind);
  if (byName) return byName._id;
  return await ctx.db.insert("budgetTags", {
    chapterId: args.chapterId,
    name: args.name,
    kind: args.kind,
    refId: args.refId,
    createdBy: args.createdBy,
    createdAt: Date.now(),
  });
}

/** Insert a budget↔tag link unless one already exists in `seen`. */
async function linkBudgetTag(
  ctx: MutationCtx,
  budgetId: Id<"budgets">,
  budgetLevel: BudgetLevel,
  tagId: Id<"budgetTags">,
  seen: Set<string>,
): Promise<void> {
  if (seen.has(tagId)) return;
  seen.add(tagId);
  await ctx.db.insert("budgetTagLinks", {
    budgetId,
    tagId,
    chapterId: budgetLevel,
    createdAt: Date.now(),
  });
}

/**
 * Auto-tag a one_time EVENT budget: ensure + link the event's eventType
 * `template` tag AND a catch-all `events` tag. No-op if `scopeRefId` doesn't
 * resolve to an event. Shared by `createBudget` and the migration.
 */
export async function autoTagEventBudget(
  ctx: MutationCtx,
  budgetId: Id<"budgets">,
  budgetLevel: BudgetLevel,
  scopeRefId: string | undefined,
  seen: Set<string>,
  createdBy?: Id<"users">,
): Promise<void> {
  const eventsTag = await ensureTag(ctx, {
    chapterId: budgetLevel,
    name: "Events",
    kind: "events",
    createdBy,
  });
  await linkBudgetTag(ctx, budgetId, budgetLevel, eventsTag, seen);
  if (!scopeRefId) return;
  const ev = await ctx.db.get(scopeRefId as Id<"events">);
  if (!ev || !("eventTypeId" in ev)) return;
  const et = await ctx.db.get((ev as Doc<"events">).eventTypeId);
  if (!et) return;
  const templateTag = await ensureTag(ctx, {
    chapterId: budgetLevel,
    name: (et as Doc<"eventTypes">).name,
    kind: "template",
    refId: (ev as Doc<"events">).eventTypeId,
    createdBy,
  });
  await linkBudgetTag(ctx, budgetId, budgetLevel, templateTag, seen);
}

/**
 * Auto-tag a one_time PROJECT budget with a catch-all "Projects" tag (kind
 * `"custom"` — projects get no dedicated tag kind; WP-3.4: "keep tags as-is,
 * no new tag investment"). Mirrors `autoTagEventBudget`'s "Events" catch-all;
 * unlike an event, a project has no per-instance "template" to also tag.
 * Shared by `projects.create` (the create-time hook) and `backfillProjectBudgets`.
 */
export async function autoTagProjectBudget(
  ctx: MutationCtx,
  budgetId: Id<"budgets">,
  budgetLevel: BudgetLevel,
  seen: Set<string>,
  createdBy?: Id<"users">,
): Promise<void> {
  const projectsTag = await ensureTag(ctx, {
    chapterId: budgetLevel,
    name: "Projects",
    kind: "custom",
    createdBy,
  });
  await linkBudgetTag(ctx, budgetId, budgetLevel, projectsTag, seen);
}

/** Load a budget's linked tags as `{ id, name, kind }`, via `by_budget`. */
async function loadBudgetTags(
  ctx: QueryCtx,
  budgetId: Id<"budgets">,
  tagCache: Map<string, Doc<"budgetTags"> | null>,
): Promise<{ id: Id<"budgetTags">; name: string; kind: (typeof BUDGET_TAG_KINDS)[number] | null }[]> {
  const links = await ctx.db
    .query("budgetTagLinks")
    .withIndex("by_budget", (q) => q.eq("budgetId", budgetId))
    .take(ROLLUP_SCAN_LIMIT);
  const out: { id: Id<"budgetTags">; name: string; kind: (typeof BUDGET_TAG_KINDS)[number] | null }[] = [];
  for (const link of links) {
    let tag = tagCache.get(link.tagId);
    if (tag === undefined) {
      tag = await ctx.db.get(link.tagId);
      tagCache.set(link.tagId, tag);
    }
    if (tag) out.push({ id: tag._id, name: tag.name, kind: tag.kind ?? null });
  }
  return out;
}

// ── Dashboard math + name resolution ─────────────────────────────────────────
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

/** `YYYY-MM-DD` in America/New_York (the finance timezone). */
function easternDateStr(ts: number): string {
  return new Date(ts).toLocaleDateString("en-CA", {
    timeZone: "America/New_York",
  });
}

/**
 * Integer percent spent-of-budget. An unfunded budget (`budget <= 0`, e.g. a
 * $0/never-approved cap) with real spend against it is NOT "0% spent" —
 * that reads as healthy when it's actually unfunded overspend — so it reports
 * 100 (the client's `BudgetBar` already goes danger-red at `pct >= 100`,
 * purely off this field — no separate "over" status is needed). An unfunded
 * budget with NO spend yet stays a quiet 0 (nothing wrong to flag yet).
 */
function pctOf(spent: number, budget: number): number {
  if (budget <= 0) return spent > 0 ? 100 : 0;
  return Math.round((spent / budget) * 100);
}

/**
 * A budget is "warn" once ≥80% spent, else "ok". There is no separate "over"
 * literal — an unfunded-and-overspent budget already reports `pct: 100` (see
 * `pctOf`), which is ≥80 ("warn") AND trips the client `BudgetBar`'s own
 * `pct >= 100` danger-red rule, so the loud state is carried by `pct` alone.
 */
function statusFor(pct: number): "ok" | "warn" {
  return pct >= 80 ? "warn" : "ok";
}

/** A capped 0–100 bar percentage for a part of a whole. */
function barPctOf(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.min(100, Math.round((part / whole) * 100));
}

/** Sum the SPEND amount of a list of transactions. */
function sumSpend(txns: Doc<"transactions">[]): number {
  return txns.reduce((s, tr) => (isSpend(tr) ? s + tr.amountCents : s), 0);
}

/** Shared spend + per-category breakdown body for an already-narrowed list of
 *  a budget's matching transactions — factored out of `budgetSpendBreakdown`
 *  so `oneTimeCardBreakdown` (a DIFFERENT period narrowing, see below) doesn't
 *  duplicate the category-grouping/bar-normalizing logic. */
function spendBreakdownFor(
  b: Doc<"budgets">,
  matching: Doc<"transactions">[],
  catName: Map<Id<"budgetCategories">, string>,
): {
  spentCents: number;
  categories: { name: string; spentCents: number; barPct: number }[];
} {
  const spentCents = matching.reduce((s, tr) => s + tr.amountCents, 0);
  const byCat = new Map<string, number>();
  for (const tr of matching) {
    const key = tr.categoryId ? catName.get(tr.categoryId) ?? "Uncategorized" : "Uncategorized";
    byCat.set(key, (byCat.get(key) ?? 0) + tr.amountCents);
  }
  // B1: the mini category bars normalize against the EFFECTIVE cap too, not
  // the raw (possibly pending-increase) `amountCents`.
  const capCents = effectiveCapCents(b);
  const denom = capCents > 0 ? capCents : spentCents;
  const categories = [...byCat.entries()]
    .sort((a, c) => c[1] - a[1])
    .map(([name, cents]) => ({
      name,
      spentCents: cents,
      barPct: barPctOf(cents, denom),
    }));
  return { spentCents, categories };
}

/**
 * The spent total + per-category breakdown for one budget, from an already-
 * loaded year of transactions. `catName` resolves category ids to names. `dp`
 * scopes recurring (monthly/quarterly) budgets to the dashboard's period: a
 * single month (so a "$2,000/mo" budget reports one month's spend) in month
 * mode, or the cumulative Jan..throughMonth range in YTD mode. Also used for
 * MONTH-MODE AGGREGATES that fold in one-time budgets (tag rollups, central
 * budget cards) — those must NOT double-count a month-less one-time budget's
 * spend into every month, which `txnCountsTowardBudgetDash` now guards via
 * `budgetEffectivePeriod`'s `contextMonth` fallback. The one-time dashboard
 * CARD itself does NOT use this — see `oneTimeCardBreakdown`.
 */
function budgetSpendBreakdown(
  b: Doc<"budgets">,
  yearTxns: Doc<"transactions">[],
  catName: Map<Id<"budgetCategories">, string>,
  dp: DashPeriod,
): {
  spentCents: number;
  categories: { name: string; spentCents: number; barPct: number }[];
} {
  const matching = yearTxns.filter((tr) => txnCountsTowardBudgetDash(tr, b, dp));
  return spendBreakdownFor(b, matching, catName);
}

/**
 * DASH-2.1 (bug 1): a recurring budget's spend in the dashboard's SELECTED
 * MONTH specifically (`dp.year`/`dp.month`) — regardless of the budget's own
 * cadence or the dashboard's period mode (month vs YTD). Feeds the recurring
 * card's new `periodSpendCents` field, from `yearTxns` already loaded for the
 * dashboard (no extra scan).
 *
 * For a `monthly` cadence card in month mode this is identical to
 * `spentCents` (`budgetSpendBreakdown`'s own cumulative figure already IS one
 * month — see its doc comment). The gap this closes is `quarterly`/`yearly`:
 * `budgetSpendBreakdown` in month mode widens to the whole quarter/year (via
 * `budgetEffectivePeriod`), so a yearly bucket's `spentCents` reads as the
 * SAME cumulative number in every month of the year (the exact owner report —
 * "$978.78/$1,000 · 98%" unchanged from Feb through Apr). This function
 * narrows to the one calendar month regardless.
 */
function monthOnlySpendCentsForBudget(
  b: Doc<"budgets">,
  yearTxns: Doc<"transactions">[],
  dp: DashPeriod,
): number {
  let sum = 0;
  for (const tr of yearTxns) {
    if (tr.budgetId !== b._id || !isSpend(tr)) continue;
    if (inPeriod(tr.postedAt, dp.year, dp.month)) sum += tr.amountCents;
  }
  return sum;
}

/**
 * A one-time budget CARD's own actuals — genuinely LIFETIME, not just
 * un-sliced from the dashboard's viewed month: an event/project budget is a
 * total plan, not a per-month allocation, so its own bar/pct/remaining must
 * stay stable as the viewer steps through months — only the card's
 * VISIBILITY is month-gated (see `oneTimeCardAppliesToDash`), never its own
 * numbers. Matches purely on the explicit `budgetId` link + `isSpend` — the
 * SAME no-period rule `actualsForRef` (`eventActuals`/`projectActuals`) uses
 * — deliberately bypassing `budgetEffectivePeriod`/`txnCountsTowardBudget`
 * entirely, so a budget WITH a stored `month`/`quarter` no longer narrows the
 * card to just that period either (an earlier version of this fix still
 * applied the budget's own declared month, which left a coherence gap: a
 * fixed-month budget's card could be made VISIBLE in an off month by an
 * out-of-period charge — `oneTimeCardAppliesToDash`'s "has spend this month"
 * signal — while its own bar still reported $0, hiding the very charge that
 * made it show up; matching `actualsForRef`'s rule closes that gap).
 */
function oneTimeCardBreakdown(
  b: Doc<"budgets">,
  yearTxns: Doc<"transactions">[],
  catName: Map<Id<"budgetCategories">, string>,
): {
  spentCents: number;
  categories: { name: string; spentCents: number; barPct: number }[];
} {
  const matching = yearTxns.filter((tr) => tr.budgetId === b._id && isSpend(tr));
  return spendBreakdownFor(b, matching, catName);
}

/**
 * True iff a one-time budget CARD belongs on the dashboard for the viewed
 * period (Bug 1a — one-time budgets used to render on EVERY month regardless
 * of relevance, e.g. a May event budget showing up in July). YTD/year mode
 * always shows every one-time card (unchanged). Month mode shows a card only
 * when it's actually relevant to THAT month:
 *  - a resolvable `refDate` (the linked event/project's real date) DECIDES
 *    relevance on its own — budget identity & dates fix: this used to be
 *    OR'd with the stored `month` check below, so a budget whose stored
 *    `month` happened to match the viewed month (e.g. its CREATION month,
 *    before the write-through sync existed) would short-circuit true even
 *    when its entity's real date said otherwise — a March-due project's card
 *    could show up in July just because that's when someone entered its
 *    budget. Now the stored `month` is a FALLBACK, consulted only when there
 *    is no `refDate` to resolve (a budget with no ref, or whose ref has
 *    vanished);
 *  - OR it already has spend posted in that month (covers a month-less
 *    budget with real activity this month even before either signal above
 *    applies) — unaffected by this fix, still an independent OR.
 */
function oneTimeCardAppliesToDash(
  b: Doc<"budgets">,
  dp: DashPeriod,
  refDate: number | null,
  yearTxns: Doc<"transactions">[],
): boolean {
  if (dp.ytd) return true;
  if (refDate != null) {
    if (inPeriod(refDate, dp.year, dp.month)) return true;
  } else if (b.month != null && b.month === dp.month) {
    return true;
  }
  return yearTxns.some(
    (tr) => tr.budgetId === b._id && isSpend(tr) && inPeriod(tr.postedAt, dp.year, dp.month),
  );
}

/** Is a recurring budget active for the dashboard's {year, month}? */
function recurringAppliesToMonth(
  b: Doc<"budgets">,
  year: number,
  month: number,
): boolean {
  if (b.year !== year) return false;
  if (b.month != null && b.month !== month) return false;
  if (b.quarter != null && quarterOfMonth(month) !== b.quarter) return false;
  return true;
}

/**
 * A budget's allocation NORMALIZED to one month, so a single month of actual
 * spend compares apples-to-apples: monthly → full amount, quarterly → ÷3,
 * yearly → ÷12, per-instance / one-off → the full amount only when the budget's
 * own period includes this month (else 0). Used by the central chapter roll-up
 * to avoid comparing one month of spend against a full year of mixed budgets.
 * Normalizes the EFFECTIVE cap (B1 — `effectiveCapCents`), never the raw
 * `amountCents`, so the org-wide rollup can't advertise an unapproved increase
 * either.
 */
function monthEquivalentBudgetCents(
  b: Doc<"budgets">,
  year: number,
  month: number,
): number {
  if (b.year !== year) return 0;
  if (b.quarter != null && quarterOfMonth(month) !== b.quarter) return 0;
  const capCents = effectiveCapCents(b);
  switch (b.cadence) {
    case "monthly":
      if (b.month != null && b.month !== month) return 0;
      return capCents;
    case "quarterly":
      return Math.round(capCents / 3);
    case "yearly":
      return Math.round(capCents / 12);
    case "per_instance":
    case "one_off":
    default:
      if (b.month != null && b.month !== month) return 0;
      return capCents;
  }
}

/** A tiny read-through name cache for a table's display name. Exported for
 *  `budgetDecisionEmails.ts`'s own `resolveBudgetRef` call. */
export function nameCache<
  T extends
    | "events"
    | "projects"
    | "people"
    | "cards"
    | "eventTypes"
    | "funds"
    | "budgetCategories"
    | "budgets"
    | "personalRepayments",
>(
  ctx: QueryCtx,
  table: T,
) {
  const cache = new Map<string, Doc<T> | null>();
  return async (id: Id<T>): Promise<Doc<T> | null> => {
    const hit = cache.get(id);
    if (hit !== undefined) return hit;
    const doc = (await ctx.db.get(id)) as Doc<T> | null;
    cache.set(id, doc);
    return doc;
  };
}

/**
 * A per-query cardholder resolver: the `personId` on the txn, else the person
 * who owns its `cardId`, resolved to `{ personId, name, imageUrl }` with
 * read-through caching for people / cards / avatar urls across rows. Factored
 * out of `listReconcile` so the missing-receipt chase view (`receiptChase`)
 * resolves the SAME "whose charge is this" answer the reconcile Cardholder
 * column shows — the chase list must never attribute a charge to a different
 * person than the grid the FM just came from.
 */
function makeCardholderResolver(ctx: QueryCtx) {
  const getPerson = nameCache(ctx, "people");
  const getCard = nameCache(ctx, "cards");
  const imageUrlCache = new Map<Id<"_storage">, string | null>();
  const personFor = async (tr: Doc<"transactions">): Promise<Doc<"people"> | null> => {
    let personId = tr.personId ?? null;
    if (!personId && tr.cardId) {
      const card = await getCard(tr.cardId);
      personId = card?.cardholderPersonId ?? null;
    }
    if (!personId) return null;
    return await getPerson(personId);
  };
  return {
    /** The full display shape, including a signed avatar URL. */
    resolve: async (
      tr: Doc<"transactions">,
    ): Promise<{
      personId: Id<"people">;
      name: string;
      imageUrl: string | null;
    } | null> => {
      const person = await personFor(tr);
      if (!person) return null;
      let imageUrl: string | null = null;
      if (person.image) {
        if (imageUrlCache.has(person.image)) {
          imageUrl = imageUrlCache.get(person.image)!;
        } else {
          imageUrl = await ctx.storage.getUrl(person.image);
          imageUrlCache.set(person.image, imageUrl);
        }
      }
      return { personId: person._id, name: person.name, imageUrl };
    },
    /**
     * Just the name — no `storage.getUrl`. `listReconcile`'s server-side search
     * has to match a cardholder's name across EVERY row in scope, not just the
     * page it ships, and minting a signed avatar URL for each of those is pure
     * waste. Shares the person/card caches with `resolve`, so a row that later
     * lands on the page costs no second read.
     */
    resolveName: async (tr: Doc<"transactions">): Promise<string | null> =>
      (await personFor(tr))?.name ?? null,
  };
}

// ── Dashboards ───────────────────────────────────────────────────────────────

/** Reimbursement statuses awaiting a manager decision — mirrors the exact set
 *  `listStaleReimbursements` (reimbursements.ts) treats as "awaiting a
 *  manager", so the two queues never drift on what counts as approvable. */
const APPROVABLE_REIMBURSEMENT_STATUSES = ["submitted", "preapproved"] as const;

/**
 * The chapter "Needs attention" queue: (a) reimbursements awaiting a manager
 * decision (submitted / preapproved — NOT pre-approval-pending, approved, or
 * terminal), and (b) cards with a missing-receipt charge still inside the
 * `RECEIPT_GRACE_DAYS` grace window (nearing the auto-lock sweep, not yet past
 * it — those are already locked by the cron). Each active card is checked
 * against its own recent charges via `isMissingReceiptCharge`, the exact same
 * predicate `autoLockOverdueCards` (cards.ts) uses, so "nearing" and "overdue"
 * can never disagree on what counts as a missing receipt.
 */
async function chapterAttentionQueue(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<(typeof attentionItem.type)[]> {
  const items: (typeof attentionItem.type)[] = [];

  // (a) Reimbursements to approve.
  let reimbCount = 0;
  let reimbCents = 0;
  for (const status of APPROVABLE_REIMBURSEMENT_STATUSES) {
    const rows = await ctx.db
      .query("reimbursementRequests")
      .withIndex("by_chapter_and_status", (q) =>
        q.eq("chapterId", chapterId).eq("status", status),
      )
      .take(ROLLUP_SCAN_LIMIT);
    if (rows.length === ROLLUP_SCAN_LIMIT) {
      console.warn(
        `[finances] attention queue hit ROLLUP_SCAN_LIMIT (${ROLLUP_SCAN_LIMIT}) reading "${status}" reimbursements for chapter ${chapterId}; count/total truncated.`,
      );
    }
    for (const r of rows) {
      reimbCount++;
      reimbCents += r.totalCents;
    }
  }
  if (reimbCount > 0) {
    items.push({
      kind: "reimbursements",
      title: "Reimbursements to approve",
      badgeCount: reimbCount,
      detail: `${formatCents(reimbCents)} awaiting approval`,
      actionLabel: "Review",
    });
  }

  // (b) Cards nearing the receipt auto-lock — count distinct CARDHOLDERS (a
  // person with two nearing charges is one attention row, not two).
  const cutoff = Date.now() - RECEIPT_GRACE_DAYS * DAY_MS;
  const chapterCards = await ctx.db
    .query("cards")
    .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
    .take(ROLLUP_SCAN_LIMIT);
  if (chapterCards.length === ROLLUP_SCAN_LIMIT) {
    console.warn(
      `[finances] attention queue hit ROLLUP_SCAN_LIMIT (${ROLLUP_SCAN_LIMIT}) reading cards for chapter ${chapterId}; nearing-lock scan truncated.`,
    );
  }
  const nearingCardholders = new Set<Id<"people">>();
  for (const card of chapterCards) {
    // Only ACTIVE cards can still be "nearing" — a locked card already tipped
    // over (the auto-lock cron caught it) or was manually locked/canceled.
    if (card.status !== "active") continue;
    const charges = await ctx.db
      .query("transactions")
      .withIndex("by_card", (q) => q.eq("cardId", card._id))
      .take(ROLLUP_SCAN_LIMIT);
    if (charges.length === ROLLUP_SCAN_LIMIT) {
      console.warn(
        `[finances] attention queue hit ROLLUP_SCAN_LIMIT (${ROLLUP_SCAN_LIMIT}) reading charges for card ${card._id}; nearing-lock check truncated.`,
      );
    }
    const nearing = charges.some(
      (tr) => isMissingReceiptCharge(tr, card) && tr.postedAt >= cutoff,
    );
    if (nearing) nearingCardholders.add(card.cardholderPersonId);
  }
  if (nearingCardholders.size > 0) {
    items.push({
      kind: "cards",
      title: "Cards nearing receipt lock",
      badgeCount: nearingCardholders.size,
      detail:
        nearingCardholders.size === 1
          ? "1 cardholder has a receipt due before the auto-lock"
          : `${nearingCardholders.size} cardholders have a receipt due before the auto-lock`,
      actionLabel: "Review",
    });
  }

  // (c) Budgets awaiting approval (WP-3.2): explicit submissions only — a
  // grandfathered legacy budget never appears here (its literal
  // `approvalStatus` is absent, not `"submitted"`). The decision itself
  // happens right on the budget card (Approve / Request changes), so this
  // row is a pure count/nudge — no dedicated destination to navigate to.
  const pendingBudgets = await ctx.db
    .query("budgets")
    .withIndex("by_chapter_and_approval_status", (q) =>
      q.eq("chapterId", chapterId).eq("approvalStatus", "submitted"),
    )
    .take(ROLLUP_SCAN_LIMIT);
  if (pendingBudgets.length === ROLLUP_SCAN_LIMIT) {
    console.warn(
      `[finances] attention queue hit ROLLUP_SCAN_LIMIT (${ROLLUP_SCAN_LIMIT}) reading pending-approval budgets for chapter ${chapterId}; count truncated.`,
    );
  }
  if (pendingBudgets.length > 0) {
    items.push({
      kind: "budget_approvals",
      title: "Budgets awaiting approval",
      badgeCount: pendingBudgets.length,
      detail:
        pendingBudgets.length === 1
          ? "1 budget needs a decision"
          : `${pendingBudgets.length} budgets need a decision`,
      actionLabel: "Review",
    });
  }

  return items;
}

/**
 * The chapter finance dashboard (prototype shape): month tiles, project /
 * recurring budget cards joined to actual spend, enriched recent transactions,
 * an attention queue, plus the fund balances.
 *
 * `{year, month}` default to the current Eastern month so the UI's month
 * stepper can page through history. `period` toggles between the selected month
 * (`"month"`, default) and the cumulative year-to-date range through that month
 * (`"ytd"`); `month` is always the through-month.
 *
 * `chapterId` optionally drills into a DIFFERENT chapter than the caller's own
 * (central-only — see the authz check in the handler); absent (or the
 * caller's own chapter) behaves exactly as before.
 */
export const dashboardChapter = query({
  args: {
    // Central drill-down: view a DIFFERENT chapter's dashboard (see the authz
    // note below). Absent (or the caller's own chapter) is unchanged.
    chapterId: v.optional(v.id("chapters")),
    year: v.optional(v.number()),
    month: v.optional(v.number()),
    period: v.optional(v.union(v.literal("month"), v.literal("ytd"))),
  },
  returns: v.object({
    tiles: v.array(chapterTile),
    oneTimeBudgets: v.array(projectBudgetCard),
    recurringBudgets: v.array(recurringBudgetCard),
    tagRollups: v.array(tagRollupRow),
    recentTransactions: v.array(recentTxnCard),
    attention: v.array(attentionItem),
    funds: v.array(fundPeriodSpend),
    // Count of spend txns with no budget attributed (bounded, all-time-capped
    // scan — a txn from any period still needs a budget). Kept all-time for
    // whatever else consumes it; the dashboard card uses `unattributedCount`
    // (below) instead so its "N transactions" copy matches its period scope.
    toBudgetCount: v.number(),
    // Explicit-only attribution gap, scoped to THIS dashboard period: spend
    // (countsAsSpend — outflow, non-transfer, non-excluded/personal) with no
    // `budgetId` link. Every dollar here is invisible to every budget card
    // above (no derive-matching fallback) — surfaced loudly so it's never
    // silently missing. Taps through to Reconcile's `needs_budget` filter.
    unattributedCents: v.number(),
    // Same period scope + predicate as `unattributedCents`, but a transaction
    // COUNT rather than a dollar figure. Drives the "N transactions need a
    // budget THIS PERIOD" attention card — a SOFT warning, never a block.
    // (`toBudgetCount` above is all-time-scoped, so it undercounts/overcounts
    // relative to this period's copy; don't use it for that card.)
    unattributedCount: v.number(),
    // Chapter spend explicitly linked to a CENTRAL budget (legal — central may
    // fund something a chapter incurred) for THIS dashboard period. Excluded
    // from `unattributedCents` (it has a `budgetId`) but also absent from every
    // chapter budget card above (the linked budget isn't a chapter budget) —
    // without this field the identity `period spend = Σ(cards) + unattributed`
    // silently breaks. An info-tier row, not a warning.
    centralLinkedCents: v.number(),
  }),
  handler: async (ctx, args) => {
    const now = easternParts(Date.now());
    const year = args.year ?? now.year;
    const month = args.month ?? now.month;
    const ytd = (args.period ?? "month") === "ytd";
    const dp: DashPeriod = { year, month, ytd };
    // The tile meta: the month name for month mode; a "year-to-date" label for YTD.
    const periodMeta = ytd
      ? `Jan–${MONTH_NAMES[month - 1]} ${year} · year-to-date`
      : `${MONTH_NAMES[month - 1]} ${year}`;
    // The Spent tile's period label suffix.
    const spentSuffix = ytd ? "YTD" : MONTH_NAMES[month - 1];

    const empty = {
      tiles: [] as never[],
      oneTimeBudgets: [] as never[],
      recurringBudgets: [] as never[],
      tagRollups: [] as never[],
      recentTransactions: [] as never[],
      attention: [] as never[],
      funds: [] as never[],
      toBudgetCount: 0,
      unattributedCents: 0,
      unattributedCount: 0,
      centralLinkedCents: 0,
    };
    const ownChapterId = await readChapterId(ctx);
    const chapterId = args.chapterId ?? ownChapterId;
    if (!chapterId) return empty;
    // Drilling into a DIFFERENT chapter than the caller's own needs central
    // (org-wide) reach — the same gate `dashboardCentral` uses. The central
    // check resolves the caller's finance capability through their OWN
    // chapter (a central grant is scope-wide regardless of which chapterId
    // it's checked against, but `viewerPerson` only finds a roster row in the
    // chapter passed in, so we must pass the caller's home chapter, not the
    // target one — mirroring `dashboardCentral` below). Otherwise this is the
    // normal same-chapter viewer gate.
    if (args.chapterId != null && args.chapterId !== ownChapterId) {
      // A caller with no chapter of their own has no home to check central
      // reach through — never fall back to the TARGET chapter for this (that
      // would check central-ness against the chapter being drilled into,
      // not the caller's own standing). Throw the same NO_CHAPTER shape
      // `requireChapterId` uses elsewhere.
      if (!ownChapterId) {
        throw new ConvexError({
          code: "NO_CHAPTER",
          message: "You don't belong to a chapter yet.",
        });
      }
      await requireFinanceCentral(ctx, ownChapterId);
    } else {
      await requireFinanceRole(ctx, chapterId, "viewer");
    }

    // One period read for the year drives every budget's actual + the period tile.
    const sandboxMode = await readSandbox(ctx);
    const yearTxns = await loadPeriodTxns(ctx, chapterId, year, sandboxMode);
    // The dashboard period's txns: the selected month, or Jan..throughMonth (YTD).
    const periodTxns = yearTxns.filter((tr) => inDashRange(tr.postedAt, dp));
    const periodSpendCents = sumSpend(periodTxns);
    // Unattributed: this period's spend with no explicit budget link — the
    // dollar amount every budget card above is BLIND to (no derive-matching
    // fallback exists anymore). `isSpend` already excludes transfers/excluded/
    // personal rows, matching invariant #3. `unattributedCount` is the same
    // predicate + period scope as a transaction count (drives the "N
    // transactions" copy on the attention card — see `unattributedCount` above).
    let unattributedCents = 0;
    let unattributedCount = 0;
    for (const tr of periodTxns) {
      if (needsBudget(tr)) {
        unattributedCents += tr.amountCents;
        unattributedCount += 1;
      }
    }

    // Category-name map (chapter-wide, bounded) for budget breakdowns.
    const categoryDocs = await ctx.db
      .query("budgetCategories")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .take(ROLLUP_SCAN_LIMIT);
    const catName = new Map(categoryDocs.map((c) => [c._id, c.name] as const));
    const getEvent = nameCache(ctx, "events");
    const getProject = nameCache(ctx, "projects");
    const getCard = nameCache(ctx, "cards");
    const getBudget = nameCache(ctx, "budgets");

    const budgets = await ctx.db
      .query("budgets")
      .withIndex("by_chapter_and_period", (q) =>
        q.eq("chapterId", chapterId).eq("year", year),
      )
      .take(ROLLUP_SCAN_LIMIT);

    // BUDGET-ACTUAL input set = this chapter's own txns UNION the cross-book
    // rows another book paid for but charged to one of these budgets (see
    // `loadCrossBookTxnsForChapterBudgets`). Every budget-card breakdown below
    // filters this by `budgetId`, so a Public Worship card bought for New York
    // lands on New York's card exactly like a New York card would.
    //
    // Only the BUDGET math reads this. `periodSpendCents` (the "Spent" tile),
    // `unattributedCents`, and the recent-transactions digest deliberately stay
    // on `yearTxns` — they answer "what did this chapter's own account do",
    // which is the number that reconciles against its bank statement. The
    // difference between the two IS the receivable central owes the chapter,
    // and it's surfaced as such by `transfers.interScopeBalances`, not hidden
    // by quietly merging the two questions into one.
    const crossBookTxns = await loadCrossBookTxnsForChapterBudgets(
      ctx,
      budgets,
      chapterId,
      sandboxMode,
    );
    const budgetTxns = crossBookTxns.length > 0 ? [...yearTxns, ...crossBookTxns] : yearTxns;

    // One-time (event / project) budget cards (per-instance / one-off).
    // Bug 1a: month mode only shows a card RELEVANT to the viewed month (own
    // `month`, linked ref's date, or spend posted this month) — YTD/year mode
    // keeps every one-time card, unchanged. Resolve the ref (name/dateLabel/
    // refDate) BEFORE deciding relevance since the relevance check itself
    // needs the ref's date.
    const oneTimeBudgets: (typeof projectBudgetCard.type)[] = [];
    for (const b of budgets) {
      if (effectiveType(b) !== "one_time") continue;
      const refKind = effectiveRefKind(b);
      const { name, dateLabel, refDate, live } = await resolveBudgetRef(b, getEvent, getProject);
      if (!oneTimeCardAppliesToDash(b, dp, refDate, budgetTxns)) continue;
      // Bug 1b: the card's OWN bar stays CUMULATIVE (never month-sliced) even
      // though its VISIBILITY above is month-gated — see `oneTimeCardBreakdown`.
      const { spentCents, categories } = oneTimeCardBreakdown(b, budgetTxns, catName);
      // B1: the CAP driving pct/remaining/status is the EFFECTIVE one — a
      // budget pending an increase never advertises the unapproved amount.
      const capCents = effectiveCapCents(b);
      // WP-wave4 (item 9): a zero-cap, zero-spend ref-linked card is a
      // "$0.00/$0.00" straggler — a summoned-on-pick budget nobody ever
      // filled an amount into (the flow itself is retired, item 5, but
      // legacy rows survive until `removeEmptyAutoBudgets` runs on prod —
      // see that fn's doc comment, which already covers this exact shape).
      // Hide it from the dashboard as a belt, independent of the ops
      // cleanup's own timing.
      if (capCents === 0 && spentCents === 0) continue;
      const pct = pctOf(spentCents, capCents);
      oneTimeBudgets.push({
        id: b._id,
        name,
        cadence: b.cadence === "per_instance" ? "per_instance" : "one_off",
        sourceBadge: null,
        dateLabel,
        subtitle: null,
        // WP-wave4 (item 4 — deep links): the linked ref, so the card can
        // offer an "open" button straight to the event/project page. Review
        // fix (dead-link parity): only when `live` — a deleted event/project
        // doesn't cascade to its budget, so an unresolved ref never offers a
        // link (same rule the recent-transactions digest's `codedTo.refKind`
        // already applies).
        refKind: live ? (refKind ?? null) : null,
        scopeRefId: live ? (b.scopeRefId ?? null) : null,
        spentCents,
        budgetCents: capCents,
        pct,
        remainingCents: capCents - spentCents,
        status: statusFor(pct),
        categories,
        ...budgetApprovalCardFields(b),
      });
    }

    // Recurring bucket / team / chapter budget cards active this month.
    const teamDocs = await ctx.db
      .query("financeTeams")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .take(ROLLUP_SCAN_LIMIT);
    const teamName = new Map(teamDocs.map((t) => [t._id, t.name] as const));
    const recurringBudgets: (typeof recurringBudgetCard.type)[] = [];
    for (const b of budgets) {
      const isRecurringCadence =
        b.cadence === "monthly" || b.cadence === "quarterly" || b.cadence === "yearly";
      if (effectiveType(b) !== "recurring" || !isRecurringCadence) continue;
      if (!recurringAppliesToDash(b, dp)) continue;
      // Scope recurring spend to the dashboard period: THIS month (fixes
      // "$2,000/mo" showing YTD in month mode), or Jan..throughMonth in YTD mode.
      const { spentCents, categories } = budgetSpendBreakdown(b, budgetTxns, catName, dp);
      // Prefer an author label; fall back to a legacy team name, then a generic.
      let name = b.label ?? (b.teamId ? teamName.get(b.teamId) : undefined) ?? "Recurring";
      // Allocation scales with the period in YTD (sum of month-equivalents;
      // DASH-2.1 bug 2: cadence-aware for quarterly/yearly — see
      // `monthEquivForDash`'s doc comment).
      const budgetCents = budgetAllocationForDash(b, dp);
      const pct = pctOf(spentCents, budgetCents);
      // DASH-2.1 bug 1: ADDITIVE month-honest fields alongside the unchanged
      // cumulative `spentCents`/`budgetCents`/`pct` — see `recurringBudgetCard`'s
      // doc comment.
      const periodSpendCents = monthOnlySpendCentsForBudget(b, budgetTxns, dp);
      const fullCapCents = effectiveCapCents(b);
      recurringBudgets.push({
        id: b._id,
        name,
        cadence: b.cadence as "monthly" | "quarterly" | "yearly",
        spentCents,
        budgetCents,
        pct,
        status: statusFor(pct),
        categories: categories.length ? categories : undefined,
        note: null,
        periodSpendCents,
        fullCapCents,
        cadenceSpendCents: spentCents,
        ...budgetApprovalCardFields(b),
      });
    }

    // Per-tag rollups: for each chapter tag, sum the linked-txn actuals of every
    // one of THIS year's budgets carrying it (a budget appears in each of its
    // tags' rollups). Reached via `budgetTagLinks` `by_tag`; `budgetById`
    // restricts to this chapter+year so a link to another year/level is skipped.
    const budgetById = new Map(budgets.map((b) => [b._id, b] as const));

    // Central-linked: this period's chapter spend explicitly linked to a
    // budget that ISN'T one of this chapter's own (`budgetById` only holds
    // this chapter+year's budgets) — i.e. a central budget (the only other
    // tenancy `categorizeTransaction` allows, see its doc comment). Such a
    // txn has a `budgetId` (so `unattributedCents` correctly excludes it) but
    // appears in no card above (the linked budget isn't a chapter budget),
    // so surface it separately: period spend = Σ(cards) + centralLinkedCents
    // + unattributedCents must hold.
    const externalBudgetCache = new Map<Id<"budgets">, Doc<"budgets"> | null>();
    let centralLinkedCents = 0;
    for (const tr of periodTxns) {
      if (!isSpend(tr) || tr.budgetId == null || budgetById.has(tr.budgetId)) continue;
      let linked = externalBudgetCache.get(tr.budgetId);
      if (linked === undefined) {
        linked = await ctx.db.get(tr.budgetId);
        externalBudgetCache.set(tr.budgetId, linked);
      }
      if (linked && linked.chapterId === CENTRAL) centralLinkedCents += tr.amountCents;
    }

    const chapterTags = await ctx.db
      .query("budgetTags")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .take(ROLLUP_SCAN_LIMIT);
    const tagRollups: (typeof tagRollupRow.type)[] = [];
    for (const tag of chapterTags) {
      const links = await ctx.db
        .query("budgetTagLinks")
        .withIndex("by_tag", (q) => q.eq("tagId", tag._id))
        .take(ROLLUP_SCAN_LIMIT);
      // The DISTINCT budgets of this chapter+year carrying the tag.
      const tagBudgets = new Map<Id<"budgets">, Doc<"budgets">>();
      for (const link of links) {
        const b = budgetById.get(link.budgetId);
        if (b) tagBudgets.set(b._id, b);
      }
      if (tagBudgets.size === 0) continue;
      // Denominator: `tagAllocationForDash` (NOT `budgetAllocationForDash`
      // directly — see its doc comment) so a one-time budget's cap only
      // counts here when it's actually relevant to the viewed month, the
      // same relevance rule the one-time CARD's own visibility uses.
      let budgetCents = 0;
      for (const b of tagBudgets.values()) {
        const refDate = await refDateForBudget(b, getEvent, getProject);
        budgetCents += tagAllocationForDash(b, dp, refDate, budgetTxns);
      }
      // Tag totals are LINKED-ONLY: count only txns EXPLICITLY linked
      // (`budgetId`) to a budget carrying the tag — NO derived matching. A linked
      // txn has exactly one `budgetId`, so it's counted once (no dedup needed).
      // `txnCountsTowardTagAgg` (NOT `txnCountsTowardBudgetDash` — see its doc
      // comment) scopes purely to the txn's own posted date falling in `dp`, so
      // a fixed-month one-time budget's spend lands in the month it was
      // actually posted, not the budget's own declared month.
      // `budgetTxns`, not `yearTxns`: a tag rollup is BUDGET-linked spend by
      // definition ("count only txns EXPLICITLY linked to a budget carrying the
      // tag"), so it has to see the same cross-book rows the budget cards do —
      // otherwise a tag and the budgets under it would report different totals
      // for the same charges.
      let spentCents = 0;
      for (const tr of budgetTxns) {
        if (tr.budgetId == null) continue;
        const b = tagBudgets.get(tr.budgetId);
        if (b && txnCountsTowardTagAgg(tr, b, dp)) spentCents += tr.amountCents;
      }
      // Only surface a tag rollup once it has an actual charge in the shown
      // period (month or YTD): a budgeted-but-unspent tag is noise on the
      // dashboard, so drop zero-spend entries before returning.
      if (spentCents <= 0) continue;
      const pct = pctOf(spentCents, budgetCents);
      tagRollups.push({
        tagId: tag._id,
        tagName: tag.name,
        kind: tag.kind ?? null,
        budgetCents,
        spentCents,
        pct,
        status: statusFor(pct),
      });
    }
    tagRollups.sort((a, b) => b.spentCents - a.spentCents);

    // Per-fund SPEND for the month (period-bounded; all-time balance is deferred
    // to the Increase sync — an all-time scan silently truncates and isn't in
    // the prototype).
    const fundSpend = new Map<Id<"funds">, number>();
    for (const tr of periodTxns) {
      if (!isSpend(tr) || !tr.fundId) continue;
      fundSpend.set(tr.fundId, (fundSpend.get(tr.fundId) ?? 0) + tr.amountCents);
    }
    const fundDocs = await ctx.db
      .query("funds")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .take(ROLLUP_SCAN_LIMIT);
    const funds = fundDocs
      .filter((f) => f.isActive !== false)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((f) => ({
        id: f._id,
        name: f.name,
        spentCents: fundSpend.get(f._id) ?? 0,
      }));

    // Enriched recent-transaction cards — a small newest-first read (top N only).
    const recent = await ctx.db
      .query("transactions")
      .withIndex("by_chapter_and_postedAt", (q) => q.eq("chapterId", chapterId))
      .order("desc")
      .take(RECENT_TXN_COUNT);
    const getPerson = nameCache(ctx, "people");
    const recentTransactions: (typeof recentTxnCard.type)[] = [];
    for (const tr of recent) {
      // WP-U (one home per dollar): "what this is coded to" is resolved from
      // the txn's BUDGET (never the vestigial `projectId`/`eventId` FKs) — a
      // one_time budget resolves to its event's/project's own name (same
      // display the old FK-based lookup gave); any OTHER budget (recurring,
      // or a one_time budget whose ref has since vanished) falls back to the
      // budget's own display name, so a recurring-budget-coded txn is no
      // longer silently blank here.
      let projectOrEvent: string | undefined;
      // WP-wave4 (item 4 — deep links) restore: the live ref behind
      // `projectOrEvent` — set ONLY when that name actually resolved from a
      // LIVE event/project (never for the `budgetDisplayName` fallback, so
      // the modal's link never points at a vanished ref).
      let recentRefKind: BudgetRefKind | null = null;
      let recentScopeRefId: string | null = null;
      if (tr.budgetId) {
        const budget = await getBudget(tr.budgetId);
        if (budget) {
          if (budget.refKind === "event" && budget.scopeRefId) {
            projectOrEvent = (await getEvent(budget.scopeRefId as Id<"events">))?.name;
            if (projectOrEvent) {
              recentRefKind = "event";
              recentScopeRefId = budget.scopeRefId;
            }
          } else if (budget.refKind === "project" && budget.scopeRefId) {
            projectOrEvent = (await getProject(budget.scopeRefId as Id<"projects">))?.name;
            if (projectOrEvent) {
              recentRefKind = "project";
              recentScopeRefId = budget.scopeRefId;
            }
          }
          projectOrEvent ??= budgetDisplayName(budget);
        }
      }
      // Funds are backend-only (WP-1.4) — every chapter has exactly one, so a
      // fund-name fallback here would just repeat "General Fund" on every
      // uncoded-to-budget row.
      const categoryName = tr.categoryId ? catName.get(tr.categoryId) : undefined;
      const codedTo =
        projectOrEvent || categoryName
          ? {
              projectOrEvent: projectOrEvent ?? "",
              category: categoryName ?? "",
              refKind: recentRefKind,
              scopeRefId: recentScopeRefId,
            }
          : null;
      // Mirrors `resolveCardholder` (Reconcile): a reassigned central card
      // charge has its `personId` cleared (chapter-scoped link) but keeps its
      // `cardId` (provenance is never touched by reassignment) — fall back to
      // the card's cardholder so the spender still shows up here too.
      let spenderPersonId = tr.personId ?? null;
      if (!spenderPersonId && tr.cardId) {
        const card = await getCard(tr.cardId);
        spenderPersonId = card?.cardholderPersonId ?? null;
      }
      const spenderName = spenderPersonId
        ? (await getPerson(spenderPersonId))?.name ?? null
        : null;
      recentTransactions.push({
        id: tr._id,
        date: easternDateStr(tr.postedAt),
        merchant: tr.merchantName ?? null,
        cardLast4: null,
        spenderName,
        timeOrNote: tr.description ?? null,
        codedTo,
        amountCents: tr.amountCents,
        flow: tr.flow,
        status: tr.status,
      });
    }

    // SANDBOX PARITY (founder report — "it says review 80, but 80 is nowhere
    // in Reconcile"): this count and the grid it links into MUST apply the
    // same environment filter, or the tile promises rows Reconcile won't show.
    // `listReconcile` filters every row through `txnMatchesMode`; this scan
    // didn't, so a deployment holding both sandbox and production rows made
    // the tile over-count by exactly the off-mode rows. Same fix applied to
    // the three sibling scans (`dashboardCentral`'s two, `chapterHealth`'s
    // two) so every "to review" number in the app counts one population.
    // (`status === "unreviewed"` already excludes `excluded`, the grid's other
    // exclusion, so `txnMatchesMode` is the whole gap.)
    const unreviewed = (
      await ctx.db
        .query("transactions")
        .withIndex("by_chapter_and_status", (q) =>
          q.eq("chapterId", chapterId).eq("status", "unreviewed"),
        )
        .take(ROLLUP_SCAN_LIMIT)
    ).filter((tr) => txnMatchesMode(tr, sandboxMode));

    // Tiles: period spend, a headline project + monthly bucket, and to-review.
    const tiles: (typeof chapterTile.type)[] = [
      {
        label: `Spent · ${spentSuffix}`,
        value: formatCents(periodSpendCents),
        subValueCents: periodSpendCents,
        meta: periodMeta,
      },
    ];
    const topProject = oneTimeBudgets[0];
    if (topProject) {
      tiles.push({
        label: topProject.name,
        value: `${formatCents(topProject.spentCents)} / ${formatCents(topProject.budgetCents)}`,
        subValueCents: topProject.spentCents,
        meta: `per instance · ${topProject.pct}%`,
      });
    }
    // DETERMINISM FIX (no-dead-numbers, review finding — PR #368 rebase note
    // below): was `.find(cadence === "monthly")`, the FIRST monthly recurring
    // budget in `recurringBudgets`' insertion order — an arbitrary pick, not
    // "the biggest bucket" the tile's position implies. Deterministic now:
    // the monthly bucket with the largest allocation (`budgetCents`, ties
    // keep the earliest by `reduce`'s left-to-right scan). The chapter
    // dashboard (`ChapterView.tsx`) mirrors this EXACT rule client-side (from
    // the same `recurringBudgets` array) so the tile it renders and the
    // budget its own click-through opens can never disagree.
    // REBASE NOTE: PR #368 (open, refactors this file into
    // `lib/financeInternals/`) touches this same tile-construction region —
    // this fix may need re-applying after that refactor lands; it's a
    // single self-contained expression, not a structural change, so the
    // rebase should be mechanical.
    const monthlyBuckets = recurringBudgets.filter((r) => r.cadence === "monthly");
    const topBucket =
      monthlyBuckets.length > 0
        ? monthlyBuckets.reduce((best, r) => (r.budgetCents > best.budgetCents ? r : best))
        : undefined;
    if (topBucket) {
      tiles.push({
        label: topBucket.name,
        value: `${formatCents(topBucket.spentCents)} / ${formatCents(topBucket.budgetCents)}`,
        subValueCents: topBucket.spentCents,
        meta: `monthly · ${topBucket.pct}%`,
      });
    }
    tiles.push({
      label: "To review",
      value: String(unreviewed.length),
      meta: "transactions",
    });

    // SOFT attribution attention: count the chapter's spend txns with no budget
    // attributed (a bounded, all-time-capped scan — a txn from any period still
    // needs a budget). Powers the "N transactions need a budget" attention row.
    const chapterTxns = await ctx.db
      .query("transactions")
      .withIndex("by_chapter_and_postedAt", (q) => q.eq("chapterId", chapterId))
      .take(ROLLUP_SCAN_LIMIT);
    const toBudgetCount = chapterTxns.reduce(
      (n, tr) => (needsBudget(tr) ? n + 1 : n),
      0,
    );

    const attention = await chapterAttentionQueue(ctx, chapterId);

    return {
      tiles,
      oneTimeBudgets,
      recurringBudgets,
      tagRollups,
      recentTransactions,
      attention,
      funds,
      toBudgetCount,
      unattributedCents,
      unattributedCount,
      centralLinkedCents,
    };
  },
});

/**
 * WP-4.3 "can we afford this?" — the chapter dashboard's affordability header.
 * Backers → monthly revenue → tier → operating floor → central skim →
 * discretionary. All arithmetic lives in `chapterAffordability`
 * (`@events-os/shared`) — this query only resolves the two inputs (backer
 * count, teammate count).
 *
 * The backer count is READ-ONLY here and everywhere else: it is derived from
 * active $50+ pledges by `givingPledges.recomputeChapterBackerCount`. There is
 * no edit affordance to gate any more, which is why this no longer returns a
 * `canEdit` flag.
 *
 * Supports the same central drill-down as `dashboardChapter` (viewing a
 * DIFFERENT chapter's header, read-only) so the two stay consistent on the
 * same dashboard render — an FM drilled into a chapter must see THAT
 * chapter's affordability, not their own.
 */
export const chapterAffordability = query({
  args: {
    chapterId: v.optional(v.id("chapters")),
  },
  returns: v.object({
    backerCount: v.number(),
    // The chapter's active team-member headcount — the honest queryable
    // stand-in for the playbook's "teammate" (there's no separate roster of
    // "funded seats" yet). Counts `people` rows in this chapter where
    // `isSamplePerson !== true` (Academy sandbox bench, never real) and EITHER
    // `isTeamMember === true` OR the row is linked to a real user account —
    // the exact predicate `people.teamMembers` already uses as this app's one
    // definition of "team member", so this doesn't invent a second one.
    // Placeholder crew (`isPlaceholder`) are excluded: they're a stand-in
    // slot, not a funded seat drawing the $50/mo operating-floor add-on.
    teammateCount: v.number(),
    monthlyRevenueCents: v.number(),
    tierLabel: v.string(),
    floorCents: v.number(),
    skimCents: v.number(),
    discretionaryCents: v.number(),
  }),
  handler: async (ctx, args) => {
    const ownChapterId = await readChapterId(ctx);
    const chapterId = args.chapterId ?? ownChapterId;
    if (!chapterId) {
      throw new ConvexError({
        code: "NO_CHAPTER",
        message: "You don't belong to a chapter yet.",
      });
    }

    if (args.chapterId != null && args.chapterId !== ownChapterId) {
      // Drilling into a different chapter than the caller's own needs central
      // reach, checked through the caller's OWN chapter — mirrors
      // `dashboardChapter`'s identical drill-down gate.
      if (!ownChapterId) {
        throw new ConvexError({
          code: "NO_CHAPTER",
          message: "You don't belong to a chapter yet.",
        });
      }
      await requireFinanceCentral(ctx, ownChapterId);
    } else {
      await requireFinanceRole(ctx, chapterId, "viewer");
    }

    const chapter = await ctx.db.get(chapterId);
    const backerCount = chapter?.backerCount ?? 0;

    const roster = await ctx.db
      .query("people")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .collect();
    const teammateCount = roster.filter(
      (p) =>
        p.isSamplePerson !== true &&
        p.isPlaceholder !== true &&
        (p.isTeamMember === true || p.userId != null),
    ).length;

    // giving-platform PRD §3: the milestone ladder is now dev-director
    // configurable (`backerMilestones.ts`). If any rows exist, use them for
    // the tier label; otherwise `chapterAffordabilityCalc` falls back to the
    // hardcoded `AFFORDABILITY_TIERS` constant (its own default arg) — the
    // config table is never required to be populated for finance to work.
    const milestoneRows = await ctx.db
      .query("backerMilestones")
      .withIndex("by_minBackers")
      .order("asc")
      .take(MAX_MILESTONES + 1);
    const tiers =
      milestoneRows.length > 0
        ? milestoneRows.map((m) => ({ minBackers: m.minBackers, label: m.label }))
        : undefined;

    const computed = chapterAffordabilityCalc(backerCount, teammateCount, tiers);

    return { backerCount, teammateCount, ...computed };
  },
});

// `setBackerCount` (the hand-written backer count, WP-4.3) is GONE. It was a
// second writer of `chapters.backerCount` alongside the derive in
// `givingPledges.recomputeChapterBackerCount`, and its own doc comment admitted
// the two "must not be used in parallel long-term". They were: a hand-set 2 on
// New York (2026-07-17) outlived three imported `past_due` pledges (2026-07-19)
// that derive to 0, and the public give page told readers a city was funded on
// money that had already failed to arrive. Its only UI, `BackerCountModal`, was
// orphaned when the affordability header was removed, so the manual path had no
// user — only a drift source. The count is derived, full stop;
// `givingPledges.recomputeAllBackerCounts` is the repair tool if it ever drifts
// again.

/**
 * The org-wide roll-up (prototype shape, central finance only): global tiles, a
 * by-TAG rollup across chapters, and a by-chapter rollup — all for the
 * given `{year, month}` (default current Eastern month). Member data stays out.
 */
export const dashboardCentral = query({
  args: {
    year: v.optional(v.number()),
    month: v.optional(v.number()),
    period: v.optional(v.union(v.literal("month"), v.literal("ytd"))),
  },
  returns: v.object({
    tiles: v.array(centralTile),
    // The "To review · org" tile's total, split per book (Central first, then
    // every active chapter) — see `toReviewBookCount`. `Σ count` equals the
    // tile's own value by construction: both are accumulated from the same
    // per-book scans in the same pass.
    toReviewByBook: v.array(toReviewBookCount),
    tagRollups: v.array(tagRollupRow),
    chapterRollup: v.array(chapterRollupRow),
    centralBudgets: v.array(centralBudgetCard),
    // The org-wide SPEND total for the dashboard period: the selected month, or
    // the cumulative Jan..throughMonth range in YTD mode.
    totalMonthSpendCents: v.number(),
    // Org-wide Unattributed: the sum, across every chapter, of this period's
    // spend with no explicit `budgetId` link (see `dashboardChapter`'s field
    // of the same name — central has no txns of its own yet, so this is purely
    // the cross-chapter sum).
    orgUnattributedCents: v.number(),
    // The City Launch Fund position, derived from the central legs of every
    // recorded transfer — chapter→central (inflow, "received") vs
    // central→chapter (outflow, "made/granted"); see the handler below for how
    // that's computed now that skim/launch-grant/settlement are one generic
    // transfer. `positionCents` = all-time received − made; the `period*`
    // figures are the same, bounded to the dashboard period. Field names are
    // unchanged from the retired skim/launch-grant era (`skimsReceivedCents`,
    // `launchGrantsMadeCents`) to avoid a churny rename across every consumer;
    // they now mean "received from a chapter" / "made to a chapter" generically.
    cityLaunchFund: v.object({
      skimsReceivedCents: v.number(),
      launchGrantsMadeCents: v.number(),
      positionCents: v.number(),
      periodSkimsReceivedCents: v.number(),
      periodLaunchGrantsMadeCents: v.number(),
      periodNetCents: v.number(),
    }),
    // WP-3.2 FM/ED oversight: the count of budgets sitting `"submitted"` right
    // now, across EVERY chapter + central — a read-only aggregate (the actual
    // decision happens on each chapter's own dashboard, or right here for a
    // central budget's own card). Never gates anything — the 85% principle
    // keeps central's role audit, not approval.
    pendingBudgetApprovalsCount: v.number(),
  }),
  handler: async (ctx, args) => {
    const now = easternParts(Date.now());
    const year = args.year ?? now.year;
    const month = args.month ?? now.month;
    const ytd = (args.period ?? "month") === "ytd";
    const dp: DashPeriod = { year, month, ytd };
    const spentSuffix = ytd ? "YTD" : MONTH_NAMES[month - 1];

    const emptyFund = {
      skimsReceivedCents: 0,
      launchGrantsMadeCents: 0,
      positionCents: 0,
      periodSkimsReceivedCents: 0,
      periodLaunchGrantsMadeCents: 0,
      periodNetCents: 0,
    };
    const empty = {
      tiles: [] as never[],
      toReviewByBook: [] as never[],
      tagRollups: [] as never[],
      chapterRollup: [] as never[],
      centralBudgets: [] as never[],
      totalMonthSpendCents: 0,
      orgUnattributedCents: 0,
      cityLaunchFund: emptyFund,
      pendingBudgetApprovalsCount: 0,
    };
    const chapterId = await readChapterId(ctx);
    if (!chapterId) return empty;
    await requireFinanceCentral(ctx, chapterId);

    const chapters = await listActiveChapters(ctx, ROLLUP_SCAN_LIMIT);
    // Read the env flag once for the whole cross-chapter rollup.
    const sandboxMode = await readSandbox(ctx);
    // Shared read-through ref caches: a one-time budget's linked event/project
    // date is needed both by the central budget CARD loop below (its own
    // visibility gate) and by BOTH tag loops (chapter + central) for
    // `tagAllocationForDash`'s relevance check — one cache per table, reused
    // everywhere in this handler so no ref is fetched twice.
    const getEvent = nameCache(ctx, "events");
    const getProject = nameCache(ctx, "projects");

    // Central budgets, loaded once up front (not just for the "Central" row
    // built below, but also to PARTITION each chapter row's spend): a txn
    // whose `budgetId` resolves to one of these belongs to the Central row,
    // not its posting chapter's row — otherwise the same dollar is counted in
    // both (mirrors `dashboardChapter`'s `centralLinkedCents` split, WP-0.1).
    const centralBudgetDocs = await ctx.db
      .query("budgets")
      .withIndex("by_chapter_and_period", (q) =>
        q.eq("chapterId", CENTRAL).eq("year", year),
      )
      .take(ROLLUP_SCAN_LIMIT);
    const centralBudgetById = new Map(centralBudgetDocs.map((b) => [b._id, b] as const));
    const centralBudgetIds = new Set(centralBudgetDocs.map((b) => b._id));

    let totalMonthSpendCents = 0;
    let orgUnattributedCents = 0;
    let activeChapters = 0;
    let toReviewOrg = 0;
    // The org "to review" total, kept per book so the tile can route (see the
    // push sites below). Central is unshifted to the front after the loop.
    const toReviewByBook: (typeof toReviewBookCount.type)[] = [];
    // WP-3.2 (I2, review): budgets sitting "submitted" right now — MUST match
    // the chapter attention queue's own definition exactly (`chapterAttentionQueue`
    // above), or a submission this FM/ED aggregate can't see becomes invisible
    // to central oversight. That queue reads the year-AGNOSTIC
    // `by_chapter_and_approval_status` index — filtering `centralBudgetDocs`/
    // `chBudgets` (both year-scoped, loaded for THIS dashboard's `year`) missed
    // any cross-year submission entirely. Central's own contribution seeds the
    // count via the same index; each chapter's own is added inside the loop
    // below via the same index, never the year-scoped budget lists.
    const centralPendingBudgets = await ctx.db
      .query("budgets")
      .withIndex("by_chapter_and_approval_status", (q) =>
        q.eq("chapterId", CENTRAL).eq("approvalStatus", "submitted"),
      )
      .take(ROLLUP_SCAN_LIMIT);
    let pendingBudgetApprovalsCount = centralPendingBudgets.length;
    // Running sum of CHAPTER spend explicitly linked to a central budget — the
    // amount partitioned OUT of each chapter's own row (below) and INTO the
    // Central row. Kept disjoint from central-OWNED spend (a real chapter's
    // txns can never be `chapterId:"central"`), so the Central row never
    // double-counts (WP-2.1).
    let chapterLinkedToCentralCents = 0;

    const chapterRollup: (typeof chapterRollupRow.type)[] = [];
    // Across-chapter by-tag aggregation, keyed by (kind, name) so same-named
    // tags in different chapters merge into one org rollup row.
    const tagAgg = new Map<
      string,
      {
        name: string;
        kind: (typeof BUDGET_TAG_KINDS)[number] | null;
        spentCents: number;
        budgetCents: number;
      }
    >();

    for (const chapter of chapters) {
      if (chapter.isActive !== false) activeChapters++;

      // Period-bounded read (this year), narrowed to the dashboard period (the
      // selected month, or Jan..throughMonth in YTD).
      const periodTxns = await loadPeriodTxns(ctx, chapter._id, year, sandboxMode);
      const dashTxns = periodTxns.filter((tr) => inDashRange(tr.postedAt, dp));
      // Full chapter spend (drives the org-wide "Spent" tile below, where
      // each real dollar — central-linked or not — is counted exactly once
      // under whichever chapter it was posted in).
      const chapterPeriodSpend = sumSpend(dashTxns);
      totalMonthSpendCents += chapterPeriodSpend;
      orgUnattributedCents += dashTxns.reduce(
        (s, tr) => (needsBudget(tr) ? s + tr.amountCents : s),
        0,
      );
      // This chapter ROW's spend excludes central-linked txns — those are
      // surfaced only in the "Central" row below (see the partition comment
      // where `centralBudgetIds` is built). Without this exclusion the same
      // txn is double-counted: once here, once in the Central row.
      const linkedToCentralThisChapter = dashTxns.reduce(
        (s, tr) =>
          isSpend(tr) && tr.budgetId != null && centralBudgetIds.has(tr.budgetId)
            ? s + tr.amountCents
            : s,
        0,
      );
      chapterLinkedToCentralCents += linkedToCentralThisChapter;
      const chapterOwnSpendCents = chapterPeriodSpend - linkedToCentralThisChapter;

      // Month-equivalent budget allocation (monthly→amount, quarterly→÷3,
      // yearly→÷12, per-instance→in-period only) — comparable to one month of
      // actual spend, unlike a raw full-year sum of mixed cadences. In YTD it's
      // summed across months 1..throughMonth to match the accumulated spend.
      const chBudgets = await ctx.db
        .query("budgets")
        .withIndex("by_chapter_and_period", (q) =>
          q.eq("chapterId", chapter._id).eq("year", year),
        )
        .take(ROLLUP_SCAN_LIMIT);
      const budgetCents = chBudgets.reduce(
        (s, b) => s + monthEquivForDash(b, dp),
        0,
      );
      // I2: year-agnostic, same index + status literal as the chapter's own
      // attention-queue count — see the comment on `pendingBudgetApprovalsCount`'s
      // seed above. Deliberately NOT derived from `chBudgets` (year-scoped).
      const chapterPendingBudgets = await ctx.db
        .query("budgets")
        .withIndex("by_chapter_and_approval_status", (q) =>
          q.eq("chapterId", chapter._id).eq("approvalStatus", "submitted"),
        )
        .take(ROLLUP_SCAN_LIMIT);
      pendingBudgetApprovalsCount += chapterPendingBudgets.length;

      // Tag attribution: for each of this chapter's tags, sum the linked-txn
      // actuals of its year budgets, then merge into the org-wide by-tag agg.
      const chBudgetById = new Map(chBudgets.map((b) => [b._id, b] as const));
      const chTags = await ctx.db
        .query("budgetTags")
        .withIndex("by_chapter", (q) => q.eq("chapterId", chapter._id))
        .take(ROLLUP_SCAN_LIMIT);
      for (const tag of chTags) {
        const links = await ctx.db
          .query("budgetTagLinks")
          .withIndex("by_tag", (q) => q.eq("tagId", tag._id))
          .take(ROLLUP_SCAN_LIMIT);
        const tagBudgets = new Map<Id<"budgets">, Doc<"budgets">>();
        for (const link of links) {
          const b = chBudgetById.get(link.budgetId);
          if (b) tagBudgets.set(b._id, b);
        }
        if (tagBudgets.size === 0) continue;
        // Denominator: `tagAllocationForDash` (see its doc comment) — a
        // one-time budget's cap only counts here when relevant to the viewed
        // month, mirroring dashboardChapter's own tag rollup fix.
        let budget = 0;
        for (const b of tagBudgets.values()) {
          const refDate = await refDateForBudget(b, getEvent, getProject);
          budget += tagAllocationForDash(b, dp, refDate, periodTxns);
        }
        // Tag totals are LINKED-ONLY (see dashboardChapter): only txns
        // explicitly linked to a budget carrying the tag count — no derived
        // matching. One `budgetId` per txn → counted once, no dedup.
        // `txnCountsTowardTagAgg`, NOT `txnCountsTowardBudgetDash` — see its
        // doc comment (a fixed-month budget's spend must land in the month it
        // was actually posted, not the budget's own declared month).
        let spent = 0;
        for (const tr of periodTxns) {
          if (tr.budgetId == null) continue;
          const b = tagBudgets.get(tr.budgetId);
          if (b && txnCountsTowardTagAgg(tr, b, dp)) spent += tr.amountCents;
        }
        const key = `${tag.kind ?? ""}::${tag.name}`;
        const agg =
          tagAgg.get(key) ??
          { name: tag.name, kind: tag.kind ?? null, spentCents: 0, budgetCents: 0 };
        agg.spentCents += spent;
        agg.budgetCents += budget;
        tagAgg.set(key, agg);
      }

      // Unreviewed count for the org "to review" tile. `txnMatchesMode` for
      // the same reason `dashboardChapter`'s own scan applies it — see that
      // one's SANDBOX PARITY comment.
      const unreviewed = (
        await ctx.db
          .query("transactions")
          .withIndex("by_chapter_and_status", (q) =>
            q.eq("chapterId", chapter._id).eq("status", "unreviewed"),
          )
          .take(ROLLUP_SCAN_LIMIT)
      ).filter((tr) => txnMatchesMode(tr, sandboxMode));
      toReviewOrg += unreviewed.length;
      // ...and the same number kept PER BOOK, so the org tile can break itself
      // down instead of showing one total with nowhere to click. An org-wide
      // "84" has no single destination — Reconcile works a book at a time (or
      // all books merged) — so the dashboard hands the client both halves and
      // lets each one route to the rows behind it.
      toReviewByBook.push({
        id: chapter._id,
        name: chapter.name,
        count: unreviewed.length,
      });

      const barPct = barPctOf(chapterOwnSpendCents, budgetCents);
      chapterRollup.push({
        chapterId: chapter._id,
        chapterName: chapter.name,
        subtitle: null,
        spentCents: chapterOwnSpendCents,
        budgetCents,
        barPct,
        status: statusFor(pctOf(chapterOwnSpendCents, budgetCents)),
      });
    }

    // Org-level (central) budgets roll up across EVERY chapter: their actual is
    // the sum of all chapters' transactions explicitly linked to them (by
    // `budgetId`). `centralBudgetDocs`/`centralBudgetById` were already loaded
    // above (before the chapter loop, to build `centralBudgetIds` for the
    // per-row partition) — reused here, no second scan. Per-chapter rollups
    // above never see these budgets in their OWN allocation (they query
    // budgets by real chapterId) and now exclude their linked spend too, so
    // nothing here is double-counted. `getEvent`/`getProject` (declared above)
    // resolve a one-time central budget's linked ref for the SAME visibility
    // gate `dashboardChapter` uses (F1) — a central one_time budget is
    // creatable (`createBudget` allows `type:"one_time" && central:true`) and
    // must behave identically to its chapter counterpart, not just avoid the
    // month-less double-count.
    const centralSpentById = new Map<Id<"budgets">, number>();
    // The By-tag AGGREGATE's own spend per central budget — DELIBERATELY a
    // separate map from `centralSpentById` (which feeds the recurring central
    // budget CARD's own `spentCents`/`pct` below, via `txnCountsTowardBudgetDash`
    // — CARD-shaped, out of this fix's scope). `txnCountsTowardTagAgg` (see its
    // doc comment) scopes purely to the txn's own posted date, so a fixed-
    // month/quarter central budget's spend lands in the month it was actually
    // posted rather than always reporting its own declared month regardless of
    // which month the org dashboard is viewing. Read by the central tag loop
    // below instead of `centralSpentById`.
    const centralTagAggSpentById = new Map<Id<"budgets">, number>();
    // Per-budget ref date + mode-matched txns, captured here so the central
    // tag loop (below, a SEPARATE loop over `centralBudgetById`) can feed
    // `tagAllocationForDash` the same relevance signal this loop's one-time
    // CARD visibility gate uses, without re-querying each ref/txn set again.
    const centralRefDateById = new Map<Id<"budgets">, number | null>();
    const centralModeMatchedById = new Map<Id<"budgets">, Doc<"transactions">[]>();
    // Projects-category-breakdown: category-name resolution for the central
    // cards' own category mini-bars. A central budget's linked txns can come
    // from ANY chapter, so there's no single-chapter `budgetCategories` list
    // to preload (`dashboardChapter`'s `catName` pattern) — instead resolve
    // each distinct categoryId once, read-through, shared across the loop.
    // A vanished category falls back to `spendBreakdownFor`'s own
    // "Uncategorized" bucket (id absent from the map), same as everywhere else.
    const centralCatName = new Map<Id<"budgetCategories">, string>();
    async function resolveCentralCatNames(
      txns: Doc<"transactions">[],
    ): Promise<Map<Id<"budgetCategories">, string>> {
      for (const tr of txns) {
        if (tr.categoryId && !centralCatName.has(tr.categoryId)) {
          const cat = await ctx.db.get(tr.categoryId);
          if (cat) centralCatName.set(tr.categoryId, cat.name);
        }
      }
      return centralCatName;
    }
    const centralBudgets: (typeof centralBudgetCard.type)[] = [];
    for (const cb of centralBudgetDocs) {
      const linked = await ctx.db
        .query("transactions")
        .withIndex("by_budget", (q) => q.eq("budgetId", cb._id))
        .take(ROLLUP_SCAN_LIMIT);
      // Unlike yearTxns/periodTxns (already mode-filtered via loadPeriodTxns),
      // this is a raw by-budget scan — filter sandbox vs prod explicitly so
      // central budget cards don't mix modes (#151). Shared by both the
      // aggregate (tag-rollup) sum below and the one-time card's own
      // cumulative sum, so neither has to re-filter mode separately.
      const modeMatched = linked.filter((tr) => txnMatchesMode(tr, sandboxMode));
      // The CARD's (dashboard-period-scoped) spend — always computed for
      // EVERY central budget regardless of card visibility, exactly like
      // `dashboardChapter`'s tag rollups independently re-derive each
      // budget's month-scoped spend rather than reusing a one-time card's
      // cumulative number. Feeds `centralSpentById`, which the recurring
      // central budget CARD below reads (`txnCountsTowardTagAgg`'s doc
      // comment flags this as carrying the same fixed-month/quarter
      // mis-scoping bug this PR fixes for tag rollups — a pre-existing,
      // separate CARD-visibility issue left for a follow-up, out of this
      // fix's declared scope).
      const spentCents = modeMatched.reduce(
        (s, tr) => (txnCountsTowardBudgetDash(tr, cb, dp) ? s + tr.amountCents : s),
        0,
      );
      centralSpentById.set(cb._id, spentCents);
      centralTagAggSpentById.set(
        cb._id,
        modeMatched.reduce(
          (s, tr) => (txnCountsTowardTagAgg(tr, cb, dp) ? s + tr.amountCents : s),
          0,
        ),
      );
      // Captured for the central tag loop below, regardless of `type` — a
      // recurring budget's entries here are simply unused (`tagAllocationForDash`
      // only consults them for a `one_time` budget). WP-wave4: also resolves
      // the card's live display name/date (item 2) in the same read.
      const { name: cbName, dateLabel: cbDateLabel, refDate, live: cbLive } = await resolveBudgetRef(
        cb,
        getEvent,
        getProject,
      );
      centralRefDateById.set(cb._id, refDate);
      centralModeMatchedById.set(cb._id, modeMatched);
      const cbRefKind = effectiveType(cb) === "one_time" ? effectiveRefKind(cb) : null;

      if (effectiveType(cb) === "one_time") {
        // Bug 1 (F1): the exact same treatment as `dashboardChapter`'s
        // one-time loop — month-gated CARD visibility, and a CUMULATIVE (never
        // month-sliced) card bar — so the same budget object behaves
        // identically on the chapter and org dashboards.
        if (!oneTimeCardAppliesToDash(cb, dp, refDate, modeMatched)) continue;
        // Genuinely lifetime (see `oneTimeCardBreakdown`'s doc comment) —
        // `modeMatched` is already `budgetId === cb._id`-scoped (the `by_budget`
        // index query above), so this is just its total spend, unconditionally.
        const cardSpentCents = sumSpend(modeMatched);
        const budgetCents = budgetAllocationForDash(cb, dp);
        // WP-wave4 (item 9): hide a zero-cap, zero-spend ref-linked
        // straggler — see `dashboardChapter`'s identical belt-and-suspenders
        // guard for the full reasoning.
        if (budgetCents === 0 && cardSpentCents === 0) continue;
        const pct = pctOf(cardSpentCents, budgetCents);
        // Same LIFETIME narrowing as `cardSpentCents` right above (and as
        // `oneTimeCardBreakdown`'s isSpend-only rule on the chapter side), so
        // the mini-bars always sum to exactly this card's own figure.
        const oneTimeMatching = modeMatched.filter(isSpend);
        const { categories } = spendBreakdownFor(
          cb,
          oneTimeMatching,
          await resolveCentralCatNames(oneTimeMatching),
        );
        centralBudgets.push({
          id: cb._id,
          name: cbName,
          dateLabel: cbDateLabel,
          // Review fix (dead-link parity): same `live`-gate as
          // `dashboardChapter`'s one-time cards — see `resolveBudgetRef`'s
          // own doc comment.
          refKind: cbLive ? (cbRefKind ?? null) : null,
          scopeRefId: cbLive ? (cb.scopeRefId ?? null) : null,
          scope: cb.scope ?? null,
          cadence: cb.cadence,
          year: cb.year,
          budgetCents,
          spentCents: cardSpentCents,
          pct,
          status: statusFor(pct),
          categories,
          ...budgetApprovalCardFields(cb),
        });
        continue;
      }

      // Allocation scales with the period in YTD so spent-vs-allocated stays comparable.
      const budgetCents = budgetAllocationForDash(cb, dp);
      const pct = pctOf(spentCents, budgetCents);
      // Same CARD-shaped narrowing as `spentCents` above (`txnCountsTowardBudgetDash`
      // — which includes the isSpend gate), so the mini-bars always sum to
      // exactly this card's own figure.
      const recurringMatching = modeMatched.filter((tr) =>
        txnCountsTowardBudgetDash(tr, cb, dp),
      );
      const { categories } = spendBreakdownFor(
        cb,
        recurringMatching,
        await resolveCentralCatNames(recurringMatching),
      );
      centralBudgets.push({
        id: cb._id,
        name: cbName,
        dateLabel: null,
        refKind: null,
        scopeRefId: null,
        scope: cb.scope ?? null,
        cadence: cb.cadence,
        year: cb.year,
        budgetCents,
        spentCents,
        pct,
        status: statusFor(pct),
        categories,
        ...budgetApprovalCardFields(cb),
      });
    }

    // CENTRAL-OWNED transactions (WP-2.1): txns whose `chapterId` IS the
    // `"central"` sentinel — money that belongs to central directly, not to any
    // chapter. Read once via the same period index (keyed on the string), then
    // narrowed to the dashboard period. These are DISJOINT from every chapter's
    // txns (a real chapter's rows can never carry `chapterId:"central"`), so
    // adding them double-counts nothing.
    const centralOwnedPeriodTxns = await loadPeriodTxns(ctx, CENTRAL, year, sandboxMode);
    const centralOwnedDashTxns = centralOwnedPeriodTxns.filter((tr) =>
      inDashRange(tr.postedAt, dp),
    );
    const centralOwnedSpendCents = sumSpend(centralOwnedDashTxns);
    // Central-owned spend is real money — it belongs in the org-wide "Spent"
    // tile and the org Unattributed sum, exactly like a chapter's spend does.
    totalMonthSpendCents += centralOwnedSpendCents;
    orgUnattributedCents += centralOwnedDashTxns.reduce(
      (s, tr) => (needsBudget(tr) ? s + tr.amountCents : s),
      0,
    );
    // Central-owned unreviewed txns count toward the org "to review" tile too —
    // they are reconcilable at the central desk (see `listReconcile`).
    // `txnMatchesMode` for the same reason the sibling scans apply it — see
    // `dashboardChapter`'s SANDBOX PARITY comment.
    const centralUnreviewed = (
      await ctx.db
        .query("transactions")
        .withIndex("by_chapter_and_status", (q) =>
          q.eq("chapterId", CENTRAL).eq("status", "unreviewed"),
        )
        .take(ROLLUP_SCAN_LIMIT)
    ).filter((tr) => txnMatchesMode(tr, sandboxMode));
    toReviewOrg += centralUnreviewed.length;
    // Central leads the breakdown (it's the org's own book, and it matches the
    // "Chapters at a glance" fleet table's own Central-first row order).
    toReviewByBook.unshift({
      id: CENTRAL,
      name: "Central",
      count: centralUnreviewed.length,
    });

    // "Central" row (WP-0.3 + WP-2.1): the spend that BELONGS to central. Two
    // disjoint parts, summed with no double-count:
    //   (1) central-OWNED spend — every `chapterId:"central"` txn's spend,
    //       whether or not it's linked to a central budget; PLUS
    //   (2) chapter spend LINKED to a central budget — the amount partitioned
    //       out of each chapter row above (`chapterLinkedToCentralCents`).
    // (1) and (2) can never overlap: (1) is central-owned rows, (2) is
    // real-chapter rows. NOTE: this is NOT `Σ centralBudgets[].spentCents` —
    // that sum omits central-owned txns with no budget link and would drop a
    // central-owned txn that IS linked (already inside (1)), so it's replaced.
    const centralRowSpentCents = centralOwnedSpendCents + chapterLinkedToCentralCents;
    const centralRowBudgetCents = centralBudgets.reduce((s, b) => s + b.budgetCents, 0);
    const centralRow: (typeof chapterRollupRow.type) = {
      chapterId: CENTRAL,
      chapterName: "Central",
      subtitle: null,
      spentCents: centralRowSpentCents,
      budgetCents: centralRowBudgetCents,
      barPct: barPctOf(centralRowSpentCents, centralRowBudgetCents),
      status: statusFor(pctOf(centralRowSpentCents, centralRowBudgetCents)),
    };
    chapterRollup.unshift(centralRow);

    // Central-level tags roll up too: aggregate central budgets by their tags
    // and merge into the same by-(kind,name) agg as the per-chapter tags. A
    // central budget's actual is its explicitly-linked txns only (already unique
    // per budget, since a txn carries one `budgetId`), so no cross-budget dedup
    // is needed here. Per-chapter tags never see central budgets (chBudgetById
    // is keyed by real chapterId), so there's no double-count.
    const centralTags = await ctx.db
      .query("budgetTags")
      .withIndex("by_chapter", (q) => q.eq("chapterId", CENTRAL))
      .take(ROLLUP_SCAN_LIMIT);
    for (const tag of centralTags) {
      const links = await ctx.db
        .query("budgetTagLinks")
        .withIndex("by_tag", (q) => q.eq("tagId", tag._id))
        .take(ROLLUP_SCAN_LIMIT);
      const tagBudgets = new Map<Id<"budgets">, Doc<"budgets">>();
      for (const link of links) {
        const b = centralBudgetById.get(link.budgetId);
        if (b) tagBudgets.set(b._id, b);
      }
      if (tagBudgets.size === 0) continue;
      let spent = 0;
      let budget = 0;
      for (const b of tagBudgets.values()) {
        // `centralTagAggSpentById`, NOT `centralSpentById` (the CARD's own
        // number) — see its declaration above.
        spent += centralTagAggSpentById.get(b._id) ?? 0;
        // `tagAllocationForDash` (see its doc comment), fed the ref date +
        // mode-matched txns the central budget CARD loop above already
        // captured per budget (`centralRefDateById`/`centralModeMatchedById`)
        // — the same relevance signal, no re-fetch.
        budget += tagAllocationForDash(
          b,
          dp,
          centralRefDateById.get(b._id) ?? null,
          centralModeMatchedById.get(b._id) ?? [],
        );
      }
      const key = `${tag.kind ?? ""}::${tag.name}`;
      const agg =
        tagAgg.get(key) ??
        { name: tag.name, kind: tag.kind ?? null, spentCents: 0, budgetCents: 0 };
      agg.spentCents += spent;
      agg.budgetCents += budget;
      tagAgg.set(key, agg);
    }

    const tagRollups: (typeof tagRollupRow.type)[] = [...tagAgg.values()]
      // Only surface a tag rollup once it has an actual charge in the shown
      // period: drop zero-spend (budgeted-but-unspent) tags before returning.
      .filter((agg) => agg.spentCents > 0)
      .sort((a, b) => b.spentCents - a.spentCents)
      .map((agg) => {
        const pct = pctOf(agg.spentCents, agg.budgetCents);
        return {
          tagId: null,
          tagName: agg.name,
          kind: agg.kind,
          budgetCents: agg.budgetCents,
          spentCents: agg.spentCents,
          pct,
          status: statusFor(pct),
        };
      });

    const tiles: (typeof centralTile.type)[] = [
      {
        label: `Spent · ${spentSuffix} · all chapters`,
        value: formatCents(totalMonthSpendCents),
        meta: `${activeChapters} chapters`,
      },
    ];
    const topTag = tagRollups[0];
    if (topTag) {
      tiles.push({
        label: topTag.tagName,
        value: formatCents(topTag.spentCents),
        meta: "across chapters",
      });
    }
    tiles.push({
      label: "Active chapters",
      value: String(activeChapters),
      meta: "org-wide",
    });
    tiles.push({
      label: "To review · org",
      value: String(toReviewOrg),
      meta: "transactions",
    });

    // City Launch Fund position: the CENTRAL legs of every transfer that moved
    // money INTO the fund (received) vs OUT of it (made/granted). Read all
    // central rows once (bounded) — transfer legs are low-volume — and sum by
    // kind. All-time drives the fund balance; the `period*` figures narrow the
    // same legs to the dashboard period.
    //
    // RETIRED (2026-07-26): the skim/launch-grant/settlement collapse to ONE
    // generic `source:"transfer"` (see `transfers.ts`'s header comment) means
    // this sum can no longer distinguish "the skim" from "a settlement" by
    // `source` alone — that distinction doesn't exist anymore. So EVERY
    // chapter→central transfer counts as "received" and every central→chapter
    // transfer counts as "made/granted", via `transferDirection`, regardless
    // of what the recording treasurer's `note` says it was for. The historical
    // `"skim"`/`"launch_grant"` sources (rows written before the collapse)
    // keep summing exactly as before; historical `"settlement"` rows are
    // DELIBERATELY excluded here (as they always were — a settlement corrects
    // a cash/budget-attribution mismatch, not fund money) but a NEW transfer
    // recorded for that same reason is indistinguishable from any other and
    // DOES count — an accepted consequence of the simplification, not an
    // oversight.
    const allCentralTxns = await ctx.db
      .query("transactions")
      .withIndex("by_chapter", (q) => q.eq("chapterId", CENTRAL))
      .take(ROLLUP_SCAN_LIMIT);
    if (allCentralTxns.length === ROLLUP_SCAN_LIMIT) {
      console.warn(
        `[finances] City Launch Fund scan hit ROLLUP_SCAN_LIMIT (${ROLLUP_SCAN_LIMIT}) reading central transactions; fund position may be truncated.`,
      );
    }
    let skimsReceivedCents = 0;
    let launchGrantsMadeCents = 0;
    let periodSkimsReceivedCents = 0;
    let periodLaunchGrantsMadeCents = 0;
    for (const tr of allCentralTxns) {
      // NOT `txnMatchesMode` — that helper short-circuits `true` for any
      // source other than `increase_card`/`increase_ach`, which would let a
      // sandbox-initiated transfer leg (externalId `sandbox_account_transfer_
      // …`) count toward the PRODUCTION fund position forever. A transfer leg
      // carries its own env in `externalId` when it's a real Increase
      // movement, so check that directly; a manual leg (no externalId — every
      // NEW transfer, since there's no more Increase auto-initiate path) has
      // none and stays env-neutral (`matchesMode` returns `true` for a
      // falsy id either way).
      if (!matchesMode(tr.externalId ?? null, sandboxMode)) continue;
      // ENGINE-BOOKED pairs are excluded from the fund position entirely. A
      // `payout_allocation` pair distributes a chapter's own Stripe revenue
      // out of central's bank deposit, and an `auto_settlement` pair trues up
      // cross-book card spend — neither is a skim received nor a grant made,
      // and with the morning engine booking them daily they'd otherwise drown
      // the fund position in noise within a week. Only HUMAN-recorded
      // transfers (transferOrigin absent) carry fund intent.
      if (tr.transferOrigin != null) continue;
      const inPeriod = inDashRange(tr.postedAt, dp);
      const receivedFromChapter =
        tr.source === "skim" ||
        (tr.source === "transfer" && tr.transferDirection === "chapter_to_central");
      const madeToChapter =
        tr.source === "launch_grant" ||
        (tr.source === "transfer" && tr.transferDirection === "central_to_chapter");
      if (receivedFromChapter) {
        skimsReceivedCents += tr.amountCents;
        if (inPeriod) periodSkimsReceivedCents += tr.amountCents;
      } else if (madeToChapter) {
        launchGrantsMadeCents += tr.amountCents;
        if (inPeriod) periodLaunchGrantsMadeCents += tr.amountCents;
      }
    }
    const cityLaunchFund = {
      skimsReceivedCents,
      launchGrantsMadeCents,
      positionCents: skimsReceivedCents - launchGrantsMadeCents,
      periodSkimsReceivedCents,
      periodLaunchGrantsMadeCents,
      periodNetCents: periodSkimsReceivedCents - periodLaunchGrantsMadeCents,
    };

    return {
      tiles,
      toReviewByBook,
      tagRollups,
      chapterRollup,
      centralBudgets,
      totalMonthSpendCents,
      orgUnattributedCents,
      cityLaunchFund,
      pendingBudgetApprovalsCount,
    };
  },
});

/** Budget-vs-actual for a period (year, optionally narrowed to a month). */
export const budgetVsActual = query({
  args: { year: v.number(), month: v.optional(v.number()) },
  returns: v.array(
    v.object({
      budgetId: v.union(v.id("budgets"), v.null()),
      label: v.string(),
      type: v.union(typeValidator, v.null()),
      scope: v.union(scopeValidator, v.null()),
      allocatedCents: v.number(),
      actualCents: v.number(),
      // WP-3.2 (B1): the EFFECTIVE cap (`effectiveCapCents`) — every over-cap
      // warning surface compares/displays against THIS, never `allocatedCents`
      // alone (see the schema doc on `budgets.approvedCents`). The mobile
      // dashboard's tag-detail sheet now sources its own figures from
      // `tagDrilldown` instead of backfilling from this query (see that
      // query's doc comment for why).
      approvedCapCents: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const chapterId = await readChapterId(ctx);
    if (!chapterId) return [];
    await requireFinanceRole(ctx, chapterId, "viewer");

    const budgets = await ctx.db
      .query("budgets")
      .withIndex("by_chapter_and_period", (q) =>
        q.eq("chapterId", chapterId).eq("year", args.year),
      )
      .take(ROLLUP_SCAN_LIMIT);

    // When a month is given, keep month-specific budgets for that month plus
    // year/quarter-level budgets (which have no `month`).
    const relevant =
      args.month == null
        ? budgets
        : budgets.filter((b) => b.month == null || b.month === args.month);

    // One period read (whole year) feeds every budget's actual — ESTIMATED
    // (budget.amountCents) is reported separately, never summed with ACTUAL.
    const sandboxMode = await readSandbox(ctx);
    const periodTxns = await loadPeriodTxns(
      ctx,
      chapterId,
      args.year,
      sandboxMode,
    );

    return relevant.map((b) => {
      // `args.month` scopes recurring budgets to that month (a "$/mo" budget
      // with no stored month otherwise matches all 12 months → YTD spend).
      const actualCents = periodTxns.reduce(
        (sum, tr) =>
          txnCountsTowardBudget(tr, b, args.month ?? undefined) ? sum + tr.amountCents : sum,
        0,
      );
      return {
        budgetId: b._id,
        label: b.label ?? (b.scope ? BUDGET_SCOPE_LABELS[b.scope] : "Budget"),
        type: effectiveType(b),
        scope: b.scope ?? null,
        allocatedCents: b.amountCents,
        actualCents,
        approvedCapCents: effectiveCapCents(b),
      };
    });
  },
});

const tagDrilldownBudgetRow = v.object({
  id: v.id("budgets"),
  // WP-wave4 (item 2 — ref name/date sync): the resolved live display name
  // (`resolveBudgetRef`) — a one-time row's linked event/project's CURRENT
  // name, falling back to the budget's own stored label/type-word.
  name: v.string(),
  type: typeValidator,
  cadence: cadenceValidator,
  level: v.union(v.literal("chapter"), v.literal("central")),
  // Which chapter owns this budget — populated only for a `scope: "central"`
  // call (a chapter-scope call's rows are all the caller's own chapter, by
  // construction). `null` for a central-owned (`level: "central"`) budget.
  chapterName: v.union(v.string(), v.null()),
  spentCents: v.number(),
  budgetCents: v.number(),
});

/**
 * The tag detail sheet's budget list: every budget carrying a By-tag rollup
 * row's tag, each with its OWN spend/allocation scoped to the SAME `{year,
 * month, period}` the rollup row itself used — so `Σ(budgets[].spentCents)`
 * equals the rollup row's `spentCents` and `Σ(budgets[].budgetCents)` equals
 * its `budgetCents`, exactly (both sides run the identical
 * `txnCountsTowardTagAgg`/`budgetAllocationForDash` pair, over the identical
 * budget set — chapter tag → this chapter's own-year budgets carrying it;
 * central tag (name+kind) → every chapter's + central's own-year budgets
 * carrying a same-named tag, mirroring `dashboardCentral`'s `tagAgg` merge).
 *
 * Replaces the old client-side glue (`ChapterView`/`CentralView`'s "R1d"
 * backfill): the sheet used to derive its "carrying budgets" from
 * `listBudgets` (real allocations, but NOT period-scoped) and patch in spend
 * from `budgetVsActual({year})` (no `month`, so always a whole-YEAR read,
 * disagreeing with a month-mode rollup header) — rows never summed to the
 * header. Worse, for a CENTRAL drill-down `budgetVsActual` only ever resolves
 * the CALLER's OWN chapter (`readChapterId`); a pure central-only seat holder
 * with no chapter-level finance grant of their own got an EMPTY backfill, so
 * EVERY row read "—" regardless of which chapter actually owned the budget.
 * This query fixes both: it computes each row's spend itself (nothing to
 * disagree with the header), and for `scope: "central"` it relies on the
 * caller's ALREADY-VERIFIED central reach (`requireFinanceCentral`) to read
 * every chapter's contributing budgets directly — no per-chapter viewer grant
 * of the caller's own required, closing the PR #106 gap for real.
 *
 * KNOWN, UNCHANGED GAP (mirrors `dashboardChapter`/`dashboardCentral`'s own
 * tag rollups, not introduced here): a CHAPTER budget carrying a CENTRAL-level
 * tag (`tagLevelAllowed` permits this) is invisible to every tag surface —
 * `dashboardChapter` only scans the chapter's OWN `budgetTags`, and
 * `dashboardCentral` only scans central `budgetTags` against CENTRAL-owned
 * budgets — so neither the rollup nor this drill-down ever surfaces that
 * combination. Left as-is so this drill-down keeps reconciling with the
 * (equally gapped) rollup header above it; fixing the gap itself is a
 * follow-up that touches both call sites together.
 */
export const tagDrilldown = query({
  args: {
    year: v.number(),
    month: v.optional(v.number()),
    period: v.optional(v.union(v.literal("month"), v.literal("ytd"))),
    scope: v.union(v.literal("chapter"), v.literal("central")),
    // `scope: "chapter"` — drill into a DIFFERENT chapter's dashboard (central
    // peek — mirrors `dashboardChapter`'s own `chapterId` arg + authz). Absent
    // (or the caller's own chapter) is the normal same-chapter case. The
    // rollup row's real `tagId` (a chapter dashboard's tag rollups always
    // carry one).
    chapterId: v.optional(v.id("chapters")),
    tagId: v.optional(v.id("budgetTags")),
    // `scope: "central"` — the rollup row aggregates same-named (+ same-kind)
    // tags across chapters and carries no single tag id, so it's matched by
    // (name, kind) instead, exactly like `dashboardCentral`'s own `tagAgg` key.
    tagName: v.optional(v.string()),
    tagKind: v.optional(v.union(tagKindValidator, v.null())),
  },
  returns: v.object({ budgets: v.array(tagDrilldownBudgetRow) }),
  handler: async (ctx, args) => {
    const empty = { budgets: [] as never[] };
    const now = easternParts(Date.now());
    const year = args.year;
    const month = args.month ?? now.month;
    const ytd = (args.period ?? "month") === "ytd";
    const dp: DashPeriod = { year, month, ytd };
    const sandboxMode = await readSandbox(ctx);
    const rows: (typeof tagDrilldownBudgetRow.type)[] = [];
    // Shared read-through ref caches, so a budget's linked event/project date
    // (needed for `tagAllocationForDash`'s relevance check) is fetched once
    // even if the same budget appears under more than one matching tag.
    const getEvent = nameCache(ctx, "events");
    const getProject = nameCache(ctx, "projects");

    // `budgetCents` uses `tagAllocationForDash` (NOT `budgetAllocationForDash`
    // directly — see its doc comment): a one-time budget's cap only counts
    // here when relevant to the viewed month, the SAME gate the rollup header
    // above this sheet now applies, so rows keep summing to the header.
    const rowFor = async (
      b: Doc<"budgets">,
      spentCents: number,
      level: "chapter" | "central",
      chapterName: string | null,
      relevantTxns: Doc<"transactions">[],
    ): Promise<typeof tagDrilldownBudgetRow.type> => {
      const { name, refDate } = await resolveBudgetRef(b, getEvent, getProject);
      return {
        id: b._id,
        name,
        type: effectiveType(b),
        cadence: b.cadence,
        level,
        chapterName,
        spentCents,
        budgetCents: tagAllocationForDash(b, dp, refDate, relevantTxns),
      };
    };

    if (args.scope === "chapter") {
      if (args.tagId == null) return empty;
      const ownChapterId = await readChapterId(ctx);
      const chapterId = args.chapterId ?? ownChapterId;
      if (!chapterId) return empty;
      // Same drill-down authz as `dashboardChapter`: viewing a DIFFERENT
      // chapter than the caller's own needs central reach, checked through
      // the caller's OWN chapter (never the target one).
      if (args.chapterId != null && args.chapterId !== ownChapterId) {
        if (!ownChapterId) {
          throw new ConvexError({
            code: "NO_CHAPTER",
            message: "You don't belong to a chapter yet.",
          });
        }
        await requireFinanceCentral(ctx, ownChapterId);
      } else {
        await requireFinanceRole(ctx, chapterId, "viewer");
      }

      const tag = await ctx.db.get(args.tagId);
      // Tenancy: a chapter-scope drill-down only ever resolves a tag actually
      // owned by the chapter being viewed — a central tag (or another
      // chapter's) never reaches this branch (see the central-tag gap note
      // above; the rollup itself never emits a `tagId` for those either).
      if (!tag || tag.chapterId !== chapterId) return empty;

      const links = await ctx.db
        .query("budgetTagLinks")
        .withIndex("by_tag", (q) => q.eq("tagId", args.tagId!))
        .take(ROLLUP_SCAN_LIMIT);
      const yearTxns = await loadPeriodTxns(ctx, chapterId, year, sandboxMode);
      for (const link of links) {
        const b = await ctx.db.get(link.budgetId);
        if (!b || b.chapterId !== chapterId || b.year !== year) continue;
        const spentCents = yearTxns.reduce(
          (s, tr) => (txnCountsTowardTagAgg(tr, b, dp) ? s + tr.amountCents : s),
          0,
        );
        rows.push(await rowFor(b, spentCents, "chapter", null, yearTxns));
      }
    } else {
      if (args.tagName == null || args.tagKind === undefined) return empty;
      const ownChapterId = await readChapterId(ctx);
      if (!ownChapterId) return empty;
      await requireFinanceCentral(ctx, ownChapterId);

      const chapters = await listActiveChapters(ctx, ROLLUP_SCAN_LIMIT);
      for (const chapter of chapters) {
        const tags = await ctx.db
          .query("budgetTags")
          .withIndex("by_chapter", (q) => q.eq("chapterId", chapter._id))
          .take(ROLLUP_SCAN_LIMIT);
        const matching = tags.filter(
          (t) => t.name === args.tagName && (t.kind ?? null) === args.tagKind,
        );
        if (matching.length === 0) continue;
        const chBudgets = await ctx.db
          .query("budgets")
          .withIndex("by_chapter_and_period", (q) =>
            q.eq("chapterId", chapter._id).eq("year", year),
          )
          .take(ROLLUP_SCAN_LIMIT);
        const chBudgetById = new Map(chBudgets.map((b) => [b._id, b] as const));
        const yearTxns = await loadPeriodTxns(ctx, chapter._id, year, sandboxMode);
        for (const tag of matching) {
          const links = await ctx.db
            .query("budgetTagLinks")
            .withIndex("by_tag", (q) => q.eq("tagId", tag._id))
            .take(ROLLUP_SCAN_LIMIT);
          for (const link of links) {
            const b = chBudgetById.get(link.budgetId);
            if (!b) continue;
            const spentCents = yearTxns.reduce(
              (s, tr) => (txnCountsTowardTagAgg(tr, b, dp) ? s + tr.amountCents : s),
              0,
            );
            rows.push(await rowFor(b, spentCents, "chapter", chapter.name, yearTxns));
          }
        }
      }

      // Central-owned tags/budgets — mirrors `dashboardCentral`'s own central
      // tag loop (which reads `centralBudgetDocs`/`centralTagAggSpentById`;
      // this query re-derives the same figures independently since it isn't
      // handed the dashboard's already-loaded maps).
      const centralTags = await ctx.db
        .query("budgetTags")
        .withIndex("by_chapter", (q) => q.eq("chapterId", CENTRAL))
        .take(ROLLUP_SCAN_LIMIT);
      const matchingCentral = centralTags.filter(
        (t) => t.name === args.tagName && (t.kind ?? null) === args.tagKind,
      );
      if (matchingCentral.length > 0) {
        const centralBudgetDocs = await ctx.db
          .query("budgets")
          .withIndex("by_chapter_and_period", (q) =>
            q.eq("chapterId", CENTRAL).eq("year", year),
          )
          .take(ROLLUP_SCAN_LIMIT);
        const centralBudgetById = new Map(
          centralBudgetDocs.map((b) => [b._id, b] as const),
        );
        for (const tag of matchingCentral) {
          const links = await ctx.db
            .query("budgetTagLinks")
            .withIndex("by_tag", (q) => q.eq("tagId", tag._id))
            .take(ROLLUP_SCAN_LIMIT);
          for (const link of links) {
            const b = centralBudgetById.get(link.budgetId);
            if (!b) continue;
            const linked = await ctx.db
              .query("transactions")
              .withIndex("by_budget", (q) => q.eq("budgetId", b._id))
              .take(ROLLUP_SCAN_LIMIT);
            const modeMatched = linked.filter((tr) => txnMatchesMode(tr, sandboxMode));
            const spentCents = modeMatched.reduce(
              (s, tr) => (txnCountsTowardTagAgg(tr, b, dp) ? s + tr.amountCents : s),
              0,
            );
            rows.push(await rowFor(b, spentCents, "central", null, modeMatched));
          }
        }
      }
    }

    rows.sort((a, b) => b.spentCents - a.spentCents);
    return { budgets: rows };
  },
});

/**
 * Actual spend for an event/project ref, BUDGET-FIRST (WP-U: one home per
 * dollar) — found via `by_ref` (EVERY one_time budget for this ref, wherever
 * each currently lives) then summed via `by_budget` across ALL of them,
 * exactly like the dashboard's `txnCountsTowardBudget*` rollups. A ref should
 * only ever have one budget (the D8 invariant, now enforced at creation by
 * `createBudget`'s dedup guard), but `by_ref` still unions every matching
 * budget rather than taking the first — legacy data can carry a duplicate
 * from before that guard existed (see `migrateLinksToBudgets`'s conflict
 * path), and undercounting a ref's actuals because of a stale duplicate is
 * worse than the extra bounded read. A ref with no budget yet reports zero
 * spend and no rows — it's never been attributed to (the "For" picker summons
 * a budget the first time a caller attributes a transaction to it).
 */
async function actualsForRef(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
  refKind: BudgetRefKind,
  scopeRefId: string,
): Promise<{ totalCents: number; transactions: ReturnType<typeof toTxnSummary>[] }> {
  const budgets = await ctx.db
    .query("budgets")
    .withIndex("by_ref", (q) => q.eq("refKind", refKind).eq("scopeRefId", scopeRefId))
    .take(ROLLUP_SCAN_LIMIT);
  if (budgets.length === 0) return { totalCents: 0, transactions: [] };
  const rowsByBudget = await Promise.all(
    budgets.map((b) =>
      ctx.db
        .query("transactions")
        .withIndex("by_budget", (q) => q.eq("budgetId", b._id))
        .take(ROLLUP_SCAN_LIMIT),
    ),
  );
  const raw = rowsByBudget.flat();
  // Scope guard, now BOOK-aware rather than custody-only. It still refuses a
  // row from an unrelated chapter (the original defence-in-depth: once
  // `transferProjectScope` moves a project's budget AND its linked
  // transactions to central together, they drop out of the origin chapter's
  // actuals exactly as before). What it no longer refuses is a CROSS-BOOK row:
  // another book paid, but the charge was deliberately attributed to a budget
  // belonging to THIS ref — central fronting a chapter's event, say. That's a
  // real actual against this ref's plan, and the old `tr.chapterId ===
  // chapterId` test dropped it on the floor (it couldn't happen when this was
  // written — the write path only ran the other way; see
  // `requireBudgetForCentralTxn`).
  //
  // The admitted set is therefore: rows this chapter paid for, plus rows any
  // other book paid for that are charged to a budget owned by THIS chapter.
  // A budget that has itself moved to central keeps its old behaviour, since
  // the ownership test below fails for it.
  const budgetOwnedHere = new Set(
    budgets.filter((b) => b.chapterId === chapterId).map((b) => b._id),
  );
  const rows = raw.filter(
    (tr) =>
      tr.chapterId === chapterId ||
      (tr.budgetId != null && budgetOwnedHere.has(tr.budgetId)),
  );
  const totalCents = rows.reduce((s, tr) => (isSpend(tr) ? s + tr.amountCents : s), 0);
  return { totalCents, transactions: rows.map(toTxnSummary) };
}

/** Actual spend attached to a single event. */
export const eventActuals = query({
  args: { eventId: v.id("events") },
  returns: v.object({
    totalCents: v.number(),
    transactions: v.array(txnSummary),
  }),
  handler: async (ctx, args) => {
    const chapterId = await readChapterId(ctx);
    if (!chapterId) return { totalCents: 0, transactions: [] };
    await requireFinanceRole(ctx, chapterId, "viewer");
    await requireInCallerChapter(ctx, chapterId, "events", args.eventId, "Event");
    return actualsForRef(ctx, chapterId, "event", args.eventId);
  },
});

/** Actual spend attached to a single project. */
export const projectActuals = query({
  args: { projectId: v.id("projects") },
  returns: v.object({
    totalCents: v.number(),
    transactions: v.array(txnSummary),
  }),
  handler: async (ctx, args) => {
    const chapterId = await readChapterId(ctx);
    if (!chapterId) return { totalCents: 0, transactions: [] };
    await requireFinanceRole(ctx, chapterId, "viewer");
    await requireInCallerChapter(ctx, chapterId, "projects", args.projectId, "Project");
    return actualsForRef(ctx, chapterId, "project", args.projectId);
  },
});

/**
 * Transactions attached to a person (defaults to the caller when omitted).
 *
 * A caller with NO finance seat (the member/cardholder case) may always read
 * their OWN transactions here — this is their "My transactions" surface, not a
 * finance-role read. Looking up a DIFFERENT person's transactions (the
 * manager/bookkeeper audit path) still requires at least the viewer role.
 *
 * Note visibility: a member sees the bookkeeper's `note` on THEIR OWN
 * transactions (owner decision — read-only, no member editing), never on
 * anyone else's. `toMemberTxnSummary` enforces this per-row against the
 * caller's own resolved person, independent of which `personId` was queried,
 * so the finance-role audit path above never leaks a note through this
 * member-facing endpoint (that path still sees notes in full via
 * `listReconcile`, the bookkeeper surface).
 */
export const personTransactions = query({
  args: { personId: v.optional(v.id("people")) },
  returns: v.array(txnSummary),
  handler: async (ctx, args) => {
    const chapterId = await readChapterId(ctx);
    if (!chapterId) return [];
    const self = await viewerPerson(ctx, chapterId);

    let personId = args.personId ?? null;
    if (personId) {
      if (self == null || personId !== self._id) {
        await requireFinanceRole(ctx, chapterId, "viewer");
      }
      await requireInCallerChapter(ctx, chapterId, "people", personId, "Person");
    } else {
      personId = self?._id ?? null;
    }
    if (!personId) return [];
    const viewerPersonId = self?._id ?? null;
    const rows = await ctx.db
      .query("transactions")
      .withIndex("by_person", (q) => q.eq("personId", personId!))
      .take(ROLLUP_SCAN_LIMIT);
    // Defense-in-depth: never leak a row linked from another chapter.
    return rows
      .filter((tr) => tr.chapterId === chapterId)
      .map((tr) => toMemberTxnSummary(tr, viewerPersonId));
  },
});

/**
 * Member-visible spend-category list for the caller's OWN chapter — powers the
 * cardholder's `submitOwnCharge` category picker on the "My transactions" tab.
 * DELIBERATELY NOT finance-role gated (same posture as `budgetsGlance`): a
 * cardholder with no finance seat still needs a category list to pre-fill the
 * bookkeeper's review, and membership (`readChapterId`) is the only gate.
 * Returns id + name only (active categories, sorted) — no spend/attribution
 * detail; `listCategories` (viewer-gated, richer) stays the reconcile surface.
 */
export const myChargeCategories = query({
  args: {},
  returns: v.array(v.object({ id: v.id("budgetCategories"), name: v.string() })),
  handler: async (
    ctx,
  ): Promise<{ id: Id<"budgetCategories">; name: string }[]> => {
    const chapterId = await readChapterId(ctx);
    if (!chapterId) return [];
    const cats = await ctx.db
      .query("budgetCategories")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .take(ROLLUP_SCAN_LIMIT);
    return cats
      .filter((c) => c.isActive !== false)
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
      .map((c) => ({ id: c._id, name: c.name }));
  },
});

// ── Budgets at a glance (member-visible, read-only) ──────────────────────────

// One budget's glance row: name/scope, the cap, spend to date, and the room
// left. `capCents` is ALWAYS the EFFECTIVE cap (`effectiveCapCents`, B1) — a
// pending increase is never advertised as already-spendable room.
const glanceBudgetRow = v.object({
  id: v.id("budgets"),
  name: v.string(),
  // The linked event/project's date (one-time budgets with a live ref only).
  dateLabel: v.union(v.string(), v.null()),
  type: typeValidator,
  cadence: cadenceValidator,
  capCents: v.number(),
  spentCents: v.number(),
  remainingCents: v.number(),
  pct: v.number(),
  status: okWarnValidator,
});

/**
 * BUDGETS AT A GLANCE — the whole chapter's "how much has been spent on X and
 * how much room is left", readable by ANY signed-in team member (the FM's top
 * ask: cardholders shouldn't have to ask her before swiping).
 *
 * DELIBERATELY NOT finance-role gated — the one finance read that isn't.
 * Membership (`readChapterId` — auth + a chapter roster) is the only gate:
 * this is read-only spend-vs-cap visibility for the ~16 volunteers holding
 * cards, not a reconcile/edit surface, and per the owner every team member
 * should see it without holding a `financeRoles` grant. Everything else about
 * a budget (creating, approving, editing, the transaction detail behind the
 * numbers) stays on the gated surfaces.
 *
 * Shows only budgets with an IN-FORCE cap: approved (`isAttributableBudget`
 * — the same gate that decides what the "For" picker offers), OR a
 * previously-approved budget whose increase is mid-review (`approvedCents`
 * recorded — the `effectiveCapCents` special case; its OLD cap is still the
 * one in force, and vanishing from the team's view because the FM asked for
 * more room would read as "the budget's gone"). A never-approved
 * draft/submission isn't spendable yet, so advertising it would invite
 * spending against room that doesn't exist. Zero-cap zero-spend stragglers
 * are hidden (the same WP-wave4 item-9 belt the dashboard cards apply).
 *
 * Spend math REUSES the dashboard's own rules, so this view can never
 * disagree with what the FM sees:
 *  - one_time (event/project) → LIFETIME linked spend (`budgetId` link +
 *    `isSpend` — the `oneTimeCardBreakdown`/`actualsForRef` rule);
 *  - recurring → the CURRENT cadence window via `txnCountsTowardBudget`
 *    (monthly → this month, quarterly → this quarter, yearly → the year),
 *    against the full cadence cap.
 * Current-Eastern-year budgets only, one bounded `loadPeriodTxns` read.
 */
export const budgetsGlance = query({
  args: {},
  returns: v.object({
    year: v.number(),
    month: v.number(),
    oneTime: v.array(glanceBudgetRow),
    recurring: v.array(glanceBudgetRow),
  }),
  handler: async (ctx) => {
    const now = easternParts(Date.now());
    const empty = { year: now.year, month: now.month, oneTime: [], recurring: [] };
    const chapterId = await readChapterId(ctx);
    if (!chapterId) return empty;
    // No requireFinanceRole here — see the doc comment above (member-visible
    // by design; membership is the gate).

    const sandboxMode = await readSandbox(ctx);
    const yearTxns = await loadPeriodTxns(ctx, chapterId, now.year, sandboxMode);
    const budgets = await ctx.db
      .query("budgets")
      .withIndex("by_chapter_and_period", (q) =>
        q.eq("chapterId", chapterId).eq("year", now.year),
      )
      .take(ROLLUP_SCAN_LIMIT);
    // Same UNION as `dashboardChapter`'s budget cards — this screen is "budgets
    // at a glance" for the whole team, so a cardholder checking room-left must
    // see the identical figure the treasurer's dashboard shows. Leaving it
    // custody-scoped would make the two disagree by exactly the cross-book
    // charges (see `loadCrossBookTxnsForChapterBudgets`).
    const crossBookTxns = await loadCrossBookTxnsForChapterBudgets(
      ctx,
      budgets,
      chapterId,
      sandboxMode,
    );
    const budgetTxns = crossBookTxns.length > 0 ? [...yearTxns, ...crossBookTxns] : yearTxns;

    const getEvent = nameCache(ctx, "events");
    const getProject = nameCache(ctx, "projects");
    const oneTime: (typeof glanceBudgetRow.type & { refDate: number | null })[] = [];
    const recurring: (typeof glanceBudgetRow.type)[] = [];
    for (const b of budgets) {
      // Only a budget with an in-force cap is advertised to the whole team:
      // approved (grandfathered included), or previously approved with an
      // increase mid-review (`approvedCents` — its old cap still governs).
      if (b.approvedCents == null && !isAttributableBudget(b)) continue;
      const isOneTime = effectiveType(b) === "one_time";
      const spentCents = budgetTxns.reduce((sum, tr) => {
        const counts = isOneTime
          ? tr.budgetId === b._id && isSpend(tr)
          : txnCountsTowardBudget(tr, b, now.month);
        return counts ? sum + tr.amountCents : sum;
      }, 0);
      const capCents = effectiveCapCents(b);
      // WP-wave4 (item 9) mirror: hide the "$0.00 / $0.00" stragglers.
      if (capCents === 0 && spentCents === 0) continue;
      const pct = pctOf(spentCents, capCents);
      const { name, dateLabel, refDate } = await resolveBudgetRef(b, getEvent, getProject);
      const row = {
        id: b._id,
        name,
        dateLabel,
        type: effectiveType(b),
        cadence: b.cadence,
        capCents,
        spentCents,
        remainingCents: capCents - spentCents,
        pct,
        status: statusFor(pct),
      };
      if (isOneTime) oneTime.push({ ...row, refDate });
      else recurring.push(row);
    }

    // One-time: newest ref date first (the events/projects people are spending
    // on NOW), date-less rows last. Recurring: alphabetical — a short, stable
    // list of standing buckets.
    oneTime.sort((a, b) => {
      if ((a.refDate == null) !== (b.refDate == null)) return a.refDate == null ? 1 : -1;
      return (b.refDate ?? 0) - (a.refDate ?? 0);
    });
    recurring.sort((a, b) => a.name.localeCompare(b.name));

    return {
      year: now.year,
      month: now.month,
      oneTime: oneTime.map(({ refDate: _refDate, ...row }) => row),
      recurring,
    };
  },
});

// ── Funds ────────────────────────────────────────────────────────────────────
// No `listFunds` query — the funds UI was removed in WP-1.4/#145 (funds are
// backend-only; see `lib/finance.ts#defaultFundId`'s doc comment).

export const createFund = mutation({
  args: {
    name: v.string(),
    restriction: restrictionValidator,
    code: v.optional(v.string()),
    color: v.optional(v.string()),
    sortOrder: v.optional(v.number()),
  },
  returns: v.id("funds"),
  handler: async (ctx, args) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceManager(ctx, chapterId);
    const existing = await ctx.db
      .query("funds")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .take(ROLLUP_SCAN_LIMIT);
    return await ctx.db.insert("funds", {
      chapterId,
      name: args.name,
      restriction: args.restriction,
      code: args.code,
      color: args.color,
      sortOrder: args.sortOrder ?? (await nextSortOrder(ctx, existing)),
      isActive: true,
      createdAt: Date.now(),
    });
  },
});

export const updateFund = mutation({
  args: {
    fundId: v.id("funds"),
    patch: v.object({
      name: v.optional(v.string()),
      restriction: v.optional(restrictionValidator),
      code: v.optional(v.union(v.string(), v.null())),
      color: v.optional(v.union(v.string(), v.null())),
      sortOrder: v.optional(v.number()),
      isActive: v.optional(v.boolean()),
    }),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceManager(ctx, chapterId);
    await requireInCallerChapter(ctx, chapterId, "funds", args.fundId, "Fund");
    await ctx.db.patch(args.fundId, cleanPatch(args.patch));
    return null;
  },
});

// ── Categories ────────────────────────────────────────────────────────────────

export const listCategories = query({
  args: { fundId: v.optional(v.id("funds")) },
  returns: v.array(categorySummary),
  handler: async (ctx, args) => {
    const chapterId = await readChapterId(ctx);
    if (!chapterId) return [];
    await requireFinanceRole(ctx, chapterId, "viewer");
    let categories: Doc<"budgetCategories">[];
    if (args.fundId) {
      await requireInCallerChapter(ctx, chapterId, "funds", args.fundId, "Fund");
      categories = await ctx.db
        .query("budgetCategories")
        .withIndex("by_fund", (q) => q.eq("fundId", args.fundId!))
        .take(ROLLUP_SCAN_LIMIT);
    } else {
      categories = await ctx.db
        .query("budgetCategories")
        .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
        .take(ROLLUP_SCAN_LIMIT);
    }
    return categories
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
      .map(toCategorySummary);
  },
});

export const createCategory = mutation({
  args: {
    fundId: v.id("funds"),
    name: v.string(),
    kind: categoryKindValidator,
    parentCategoryId: v.optional(v.id("budgetCategories")),
    sortOrder: v.optional(v.number()),
  },
  returns: v.id("budgetCategories"),
  handler: async (ctx, args) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceManager(ctx, chapterId);
    await requireInCallerChapter(ctx, chapterId, "funds", args.fundId, "Fund");
    if (args.parentCategoryId) {
      const parent = await requireInCallerChapter(
        ctx,
        chapterId,
        "budgetCategories",
        args.parentCategoryId,
        "Parent category",
      );
      if (parent.fundId !== args.fundId) {
        throw new ConvexError({
          code: "INVALID_PARENT",
          message: "A category's parent must be in the same fund.",
        });
      }
    }
    const existing = await ctx.db
      .query("budgetCategories")
      .withIndex("by_fund", (q) => q.eq("fundId", args.fundId))
      .take(ROLLUP_SCAN_LIMIT);
    return await ctx.db.insert("budgetCategories", {
      chapterId,
      fundId: args.fundId,
      parentCategoryId: args.parentCategoryId,
      name: args.name,
      kind: args.kind,
      sortOrder: args.sortOrder ?? (await nextSortOrder(ctx, existing)),
      isActive: true,
      createdAt: Date.now(),
    });
  },
});

/**
 * Resolve a chapter's General Fund to hang the default categories off of: prefer
 * the "General Fund" by name, else the lowest-sortOrder unrestricted fund, else
 * the lowest-sortOrder fund. Returns `null` for a fund-less chapter.
 *
 * NOT the same resolver as `lib/finance.ts#defaultFundId` (#145) — that one
 * auto-codes NEW spend and must never fall back to a restricted fund, so it
 * stops at `null` instead of picking one. This one is a migration/merge-target
 * picker (seeding default categories, merging funds into "General") where any
 * existing fund is an acceptable keeper, restricted or not.
 */
async function findGeneralFundId(
  ctx: MutationCtx,
  chapterId: Id<"chapters">,
): Promise<Id<"funds"> | null> {
  const funds = await ctx.db
    .query("funds")
    .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
    .take(ROLLUP_SCAN_LIMIT);
  if (funds.length === 0) return null;
  const byName = funds.find((f) => f.name === "General Fund");
  if (byName) return byName._id;
  const byOrder = [...funds].sort((a, b) => a.sortOrder - b.sortOrder);
  const unrestricted = byOrder.find((f) => f.restriction === "unrestricted");
  return (unrestricted ?? byOrder[0])._id;
}

/**
 * Shared: seed one chapter's default fund + expense categories. First ensures
 * the chapter's default fund exists (General Fund — the only fund, see
 * WP-1.4) — so a chapter created before the finance seed (zero funds) is fixed
 * in one shot — then seeds the default categories under its General Fund.
 * Idempotent (skips funds / categories whose names already exist). Returns the
 * count of categories inserted (0 if, unexpectedly, no General Fund can be
 * resolved).
 */
async function seedDefaultCategoriesForChapter(
  ctx: MutationCtx,
  chapterId: Id<"chapters">,
  now: number,
): Promise<number> {
  await ensureDefaultFunds(ctx, chapterId, now);
  const fundId = await findGeneralFundId(ctx, chapterId);
  if (!fundId) return 0;
  return await insertDefaultExpenseCategories(ctx, chapterId, fundId, now);
}

/**
 * Superuser-gated backfill: seed the default expense categories for ONE chapter
 * (the caller's, or an explicit `chapterId` — lets central admins fix existing /
 * prod chapters). Idempotent: names that already exist are skipped, so a chapter
 * that already has the set is a no-op. Reuses {@link seedDefaultCategoriesForChapter}.
 */
export const seedDefaultExpenseCategories = mutation({
  args: { chapterId: v.optional(v.id("chapters")) },
  returns: v.object({ inserted: v.number() }),
  handler: async (ctx, args) => {
    await requireSuperuser(ctx);
    const chapterId =
      args.chapterId ?? ((await requireChapterId(ctx)) as Id<"chapters">);
    const chapter = await ctx.db.get(chapterId);
    if (!chapter) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Chapter not found." });
    }
    const inserted = await seedDefaultCategoriesForChapter(
      ctx,
      chapterId,
      Date.now(),
    );
    return { inserted };
  },
});

/**
 * CLI-runnable (no auth) sibling of {@link seedDefaultExpenseCategories}: seed
 * the defaults for EVERY chapter that currently has no categories. Bounded +
 * idempotent — re-runs skip already-seeded chapters.
 *
 * Run locally:  npx convex run finances:runSeedDefaultExpenseCategories
 * Run on prod:  npx convex run --prod finances:runSeedDefaultExpenseCategories
 */
export const runSeedDefaultExpenseCategories = internalMutation({
  args: {},
  returns: v.object({ chaptersSeeded: v.number(), inserted: v.number() }),
  handler: async (ctx) => {
    const now = Date.now();
    const chapters = await listActiveChapters(ctx, ROLLUP_SCAN_LIMIT);
    let chaptersSeeded = 0;
    let inserted = 0;
    for (const c of chapters) {
      const existing = await ctx.db
        .query("budgetCategories")
        .withIndex("by_chapter", (q) => q.eq("chapterId", c._id))
        .take(1);
      if (existing.length > 0) continue;
      const n = await seedDefaultCategoriesForChapter(ctx, c._id, now);
      if (n > 0) {
        chaptersSeeded++;
        inserted += n;
      }
    }
    return { chaptersSeeded, inserted };
  },
});

/** Walk up from `startId`; true iff `targetId` is reachable (would form a cycle). */
async function categoryAncestorHits(
  ctx: QueryCtx,
  startId: Id<"budgetCategories"> | undefined,
  targetId: Id<"budgetCategories">,
): Promise<boolean> {
  let cursor = startId;
  let guard = 0;
  while (cursor && guard < 1000) {
    if (cursor === targetId) return true;
    const node: Doc<"budgetCategories"> | null = await ctx.db.get(cursor);
    cursor = node?.parentCategoryId;
    guard++;
  }
  return false;
}

export const updateCategory = mutation({
  args: {
    categoryId: v.id("budgetCategories"),
    patch: v.object({
      name: v.optional(v.string()),
      kind: v.optional(categoryKindValidator),
      parentCategoryId: v.optional(v.union(v.id("budgetCategories"), v.null())),
      sortOrder: v.optional(v.number()),
      isActive: v.optional(v.boolean()),
    }),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceManager(ctx, chapterId);
    const category = await requireInCallerChapter(
      ctx,
      chapterId,
      "budgetCategories",
      args.categoryId,
      "Category",
    );
    const newParent = args.patch.parentCategoryId;
    if (newParent) {
      if (newParent === args.categoryId) {
        throw new ConvexError({
          code: "INVALID_PARENT",
          message: "A category cannot be its own parent.",
        });
      }
      const parent = await requireInCallerChapter(
        ctx,
        chapterId,
        "budgetCategories",
        newParent,
        "Parent category",
      );
      if (parent.fundId !== category.fundId) {
        throw new ConvexError({
          code: "INVALID_PARENT",
          message: "A category's parent must be in the same fund.",
        });
      }
      // Reject a parent that is itself a descendant of this category (a cycle).
      if (await categoryAncestorHits(ctx, newParent, args.categoryId)) {
        throw new ConvexError({
          code: "CYCLE",
          message: "That parent would create a category cycle.",
        });
      }
    }
    await ctx.db.patch(args.categoryId, cleanPatch(args.patch));
    return null;
  },
});

// ── Teams ─────────────────────────────────────────────────────────────────────

export const listTeams = query({
  args: {},
  returns: v.array(teamSummary),
  handler: async (ctx) => {
    const chapterId = await readChapterId(ctx);
    if (!chapterId) return [];
    await requireFinanceRole(ctx, chapterId, "viewer");
    const chapterTeams = await ctx.db
      .query("financeTeams")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .take(ROLLUP_SCAN_LIMIT);
    const centralTeams = await ctx.db
      .query("financeTeams")
      .withIndex("by_chapter", (q) => q.eq("chapterId", undefined))
      .take(ROLLUP_SCAN_LIMIT);
    return [...chapterTeams, ...centralTeams]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map(toTeamSummary);
  },
});

export const createTeam = mutation({
  args: { name: v.string(), sortOrder: v.optional(v.number()) },
  returns: v.id("financeTeams"),
  handler: async (ctx, args) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceManager(ctx, chapterId);
    const existing = await ctx.db
      .query("financeTeams")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .take(ROLLUP_SCAN_LIMIT);
    return await ctx.db.insert("financeTeams", {
      chapterId,
      name: args.name,
      sortOrder: args.sortOrder ?? (await nextSortOrder(ctx, existing)),
      isActive: true,
      createdAt: Date.now(),
    });
  },
});

export const updateTeam = mutation({
  args: {
    teamId: v.id("financeTeams"),
    patch: v.object({
      name: v.optional(v.string()),
      sortOrder: v.optional(v.number()),
      isActive: v.optional(v.boolean()),
    }),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceManager(ctx, chapterId);
    await requireInCallerChapter(ctx, chapterId, "financeTeams", args.teamId, "Team");
    await ctx.db.patch(args.teamId, cleanPatch(args.patch));
    return null;
  },
});

// ── Budgets ────────────────────────────────────────────────────────────────────

export const listBudgets = query({
  args: {},
  returns: v.array(budgetSummary),
  handler: async (ctx) => {
    const chapterId = await readChapterId(ctx);
    if (!chapterId) return [];
    await requireFinanceRole(ctx, chapterId, "viewer");
    // The caller's chapter budgets PLUS every org-level (central) budget, each
    // tagged with its `level` so the reconcile picker can group them, and with
    // its managed tags resolved from `budgetTagLinks`.
    const chapterBudgets = await ctx.db
      .query("budgets")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .take(ROLLUP_SCAN_LIMIT);
    const centralBudgets = await ctx.db
      .query("budgets")
      .withIndex("by_chapter", (q) => q.eq("chapterId", CENTRAL))
      .take(ROLLUP_SCAN_LIMIT);
    const tagCache = new Map<string, Doc<"budgetTags"> | null>();
    const rows: (typeof budgetSummary.type)[] = [];
    for (const b of [...chapterBudgets, ...centralBudgets]) {
      const tags = await loadBudgetTags(ctx, b._id, tagCache);
      rows.push(toBudgetSummary(b, tags));
    }
    return rows;
  },
});

// ── The "For" picker (WP-U: one home per dollar) ─────────────────────────────
// Candidate gather (events/projects/budgets scan + one-budget-per-ref dedup +
// row label) lives in `lib/forPickerCandidates.ts#gatherForPickerCandidates`
// — the SAME scan `reconcileSuggest.rankForPicker` calls, so the two "For"
// picker surfaces can never drift apart on what's offered (see that file's
// module doc for the history: re-derived independently at #217, reconciled
// into this one scan once the parallel-ownership constraint that forced the
// duplication was gone).

const forPickerRefRow = v.object({
  label: v.string(),
  // WP-wave4 (item 5): ALWAYS a real, APPROVED budget now — a row for a
  // ref with no budget yet, or one whose budget isn't approved, is simply
  // OMITTED from the list (not included with a `null` here). The old
  // "summon a $0 budget on pick" flow (`summonBudgetForRef` called from the
  // picker) is retired — see `isAttributableBudget`'s doc. An unbudgeted or
  // not-yet-approved ref's spend stays visible another way: the dashboard's
  // "Needs budget" bucket (`unattributedCents`).
  budgetId: v.id("budgets"),
});

export const forPickerOptions = query({
  args: {},
  returns: v.object({
    // The chapter's own (non-training) events — always chapter-scoped (events
    // never transfer to central, unlike project budgets — WP-2.2 finding).
    events: v.array(v.object({ eventId: v.id("events"), ...forPickerRefRow.fields })),
    // The chapter's own projects. A project's BUDGET may have moved to central
    // (`transferProjectScope`) while the project row stays put — `budgetId`
    // reflects wherever the budget currently lives, found via `by_ref` (same
    // discovery `transferProjectScope` itself relies on).
    projects: v.array(v.object({ projectId: v.id("projects"), ...forPickerRefRow.fields })),
    // Every budget that ISN'T a one_time event/project budget — recurring
    // budgets (chapter or central) plus any legacy/odd budget shape, so
    // nothing silently disappears from the picker. Grouped by `level` in the
    // UI (mirrors the old Budget picker's Chapter/Central split).
    recurring: v.array(
      v.object({
        budgetId: v.id("budgets"),
        label: v.string(),
        level: v.union(v.literal("chapter"), v.literal("central")),
      }),
    ),
  }),
  handler: async (ctx) => {
    const empty = { events: [], projects: [], recurring: [] };
    const chapterId = await readChapterId(ctx);
    if (!chapterId) return empty;
    await requireFinanceRole(ctx, chapterId, "viewer");

    // `gatherForPickerCandidates` returns EVERY event/project/recurring-budget
    // candidate (budget-less or unapproved ones included, `budget: null` or
    // not-yet-approved) — WP-wave4 (item 5)'s `isAttributableBudget` gate is
    // applied below, per output group, exactly as it was before this scan was
    // shared (a ref with no budget, or an unapproved one, is OMITTED entirely
    // — its spend stays visible in the dashboard's "Needs budget" bucket
    // instead). Truncation (unlikely — see `ROLLUP_SCAN_LIMIT`'s doc) isn't
    // logged here, unlike `reconcileSuggest.rankForPicker`'s own caller-side
    // warning — this list has no per-request "may be truncated" UI to back it.
    const { candidates } = await gatherForPickerCandidates(ctx, chapterId, ROLLUP_SCAN_LIMIT);

    // NO FABRICATED DATES (identical fix to #219's `reconcileSuggest.ts` —
    // that PR's own commit judged this static list's `startDate ?? createdAt`
    // fallback "fine" since nothing here cross-checks it against a second,
    // independently-computed date the way `reconcileSuggest`'s tier-3 ranking
    // does; on reflection the SAME defect is still live here on its own
    // terms — a project's row can show its ROW-CREATION timestamp dressed up
    // as a meaningful date, which is misleading regardless of whether a
    // second date is present to visibly contradict it). `projects.deadline`
    // is the one real, directly-editable date field
    // (`ProjectCard.tsx`'s "Due {date}"/"Set deadline", `projects.ts#update`)
    // — never derived from `startDate`/`createdAt`; `gatherForPickerCandidates`
    // already enforces this when it builds each candidate's `label`.
    const eventRows = candidates.flatMap((c) => {
      if (c.refKind !== "event" || !isAttributableBudget(c.budget)) return [];
      return [{ eventId: c.refId as Id<"events">, label: c.label, budgetId: c.budget._id }];
    });
    const projectRows = candidates.flatMap((c) => {
      if (c.refKind !== "project" || !isAttributableBudget(c.budget)) return [];
      return [{ projectId: c.refId as Id<"projects">, label: c.label, budgetId: c.budget._id }];
    });
    const recurring = candidates.flatMap((c) => {
      if (c.refKind !== "recurring" || !isAttributableBudget(c.budget)) return [];
      // Non-null: every "recurring" candidate carries a chapter/central level
      // (only an event/project candidate's `level` is `null`) — see
      // `PickerCandidate`'s doc in `lib/forPickerCandidates.ts`.
      return [{ budgetId: c.budget._id, label: c.label, level: c.level as "chapter" | "central" }];
    });

    return { events: eventRows, projects: projectRows, recurring };
  },
});

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

export const summonBudgetForRef = mutation({
  args: {
    refKind: refKindValidator,
    scopeRefId: v.string(),
  },
  returns: v.id("budgets"),
  handler: async (ctx, args) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    const userId = (await requireUserId(ctx)) as Id<"users">;
    await requireFinanceRole(ctx, chapterId, "bookkeeper");
    return await ensureBudgetForRef(ctx, chapterId, args.refKind, args.scopeRefId, userId);
  },
});

/**
 * Validate + verify tenancy of the optional narrowers on a budget write. The
 * one_time instance ref is verified against `events`/`projects` per `refKind`.
 */
async function verifyBudgetRefs(
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

export const createBudget = mutation({
  args: {
    amountCents: v.number(),
    // v2: one_time (a specific event/project) vs recurring.
    type: typeValidator,
    cadence: cadenceValidator,
    year: v.number(),
    label: v.optional(v.string()),
    // one_time: which instance table `scopeRefId` points at + the id.
    refKind: v.optional(refKindValidator),
    scopeRefId: v.optional(v.string()),
    month: v.optional(v.number()),
    quarter: v.optional(v.number()),
    fundId: v.optional(v.id("funds")),
    categoryId: v.optional(v.id("budgetCategories")),
    // Managed tags to attach (many-to-many); verified in-tenant.
    tagIds: v.optional(v.array(v.id("budgetTags"))),
    // When true, create an org-level (central) budget instead of a chapter one:
    // it stores `chapterId: "central"` and requires central finance access.
    central: v.optional(v.boolean()),
  },
  returns: v.id("budgets"),
  handler: async (ctx, args) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    // Central budgets are gated on org-wide reach; chapter budgets on manager.
    if (args.central) {
      await requireFinanceCentral(ctx, chapterId);
    } else {
      await requireFinanceManager(ctx, chapterId);
    }
    assertIntegerCents(args.amountCents, "Budget amount");
    // `refKind`/`scopeRefId` only make sense on a one_time budget.
    const refKind = args.type === "one_time" ? args.refKind ?? undefined : undefined;
    const scopeRefId = args.type === "one_time" ? args.scopeRefId : undefined;
    await verifyBudgetRefs(ctx, chapterId, {
      refKind,
      scopeRefId,
      fundId: args.fundId,
      categoryId: args.categoryId,
      month: args.month,
      quarter: args.quarter,
    });
    // D8 invariant: every money-carrying event/project has EXACTLY one
    // budget. `by_ref` finds a match regardless of which scope currently
    // owns it (a project's budget can live at central post-transfer — same
    // reasoning as `hasBudgetForRef`/`ensureBudgetForRef`) — reject rather
    // than silently create a second home for the same ref, which would make
    // `actualsForRef`'s sum-across-duplicates the norm instead of a legacy
    // fallback.
    if (refKind && scopeRefId) {
      const existingForRef = await ctx.db
        .query("budgets")
        .withIndex("by_ref", (q) => q.eq("refKind", refKind).eq("scopeRefId", scopeRefId))
        .first();
      if (existingForRef) {
        throw new ConvexError({
          code: "REF_ALREADY_BUDGETED",
          message: `This ${refKind} already has a budget ("${budgetDisplayName(existingForRef)}") — every event/project gets exactly one budget. Edit the existing budget (${existingForRef._id}) instead of creating another.`,
        });
      }
    }
    const level: BudgetLevel = args.central ? CENTRAL : chapterId;
    // Verify each explicit tag is usable at this budget's level BEFORE inserting.
    for (const tagId of args.tagIds ?? []) {
      await requireTagInLevel(ctx, level, tagId);
    }
    const userId = (await requireUserId(ctx)) as Id<"users">;
    // Default an event budget's label to the linked event's name when none was
    // given, so the picker/tag-detail shows the event name instead of the
    // "One-time" type word. Disambiguate repeated event names (see
    // `eventBudgetLabel`). Non-event or explicitly-labeled budgets are untouched.
    let label = args.label;
    if (label == null && args.type === "one_time" && refKind === "event" && scopeRefId) {
      const ev = await ctx.db.get(scopeRefId as Id<"events">);
      if (ev && "name" in ev) {
        const event = ev as Doc<"events">;
        const parts = easternParts(event.eventDate);
        // Sibling events sharing this name in the SAME chapter decide whether the
        // bare name is ambiguous (bounded scan; training events don't get budgets).
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
        label = eventBudgetLabel(event.name, parts, siblings.length, sameMonthCount);
      }
    }
    // Silently default a CHAPTER budget to its General Fund when the client
    // omits a fund (no UI ever sends one — funds are backend-only, see
    // WP-1.4). Central budgets have no chapter to resolve a fund from — the
    // "central" sentinel isn't a `funds`-scoping chapter — so they stay
    // fund-less, same as today.
    const fundId =
      args.fundId ??
      (args.central ? undefined : (await defaultFundId(ctx, chapterId)) ?? undefined);
    const budgetId = await ctx.db.insert("budgets", {
      chapterId: level,
      amountCents: args.amountCents,
      label,
      type: args.type,
      refKind,
      scopeRefId,
      cadence: args.cadence,
      year: args.year,
      month: args.month,
      quarter: args.quarter,
      fundId,
      categoryId: args.categoryId,
      createdBy: userId,
      createdAt: Date.now(),
      // WP-3.2: a NEW budget starts the approval workflow at "draft" — unlike
      // a pre-existing (grandfathered) row, which carries no `approvalStatus`
      // at all. Only new budgets are submittable/approvable from day one.
      approvalStatus: "draft",
    });
    const seen = new Set<string>();
    for (const tagId of args.tagIds ?? []) {
      await linkBudgetTag(ctx, budgetId, level, tagId, seen);
    }
    // Auto-tag one_time EVENT budgets with the eventType template tag + an
    // "events" tag (idempotent + deduped against any explicit tags above).
    if (args.type === "one_time" && refKind === "event") {
      await autoTagEventBudget(ctx, budgetId, level, scopeRefId ?? undefined, seen, userId);
    }
    return budgetId;
  },
});

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

export const updateBudget = mutation({
  args: {
    budgetId: v.id("budgets"),
    patch: v.object({
      amountCents: v.optional(v.number()),
      label: v.optional(v.union(v.string(), v.null())),
      type: v.optional(typeValidator),
      refKind: v.optional(v.union(refKindValidator, v.null())),
      scopeRefId: v.optional(v.union(v.string(), v.null())),
      cadence: v.optional(cadenceValidator),
      year: v.optional(v.number()),
      month: v.optional(v.union(v.number(), v.null())),
      quarter: v.optional(v.union(v.number(), v.null())),
      fundId: v.optional(v.union(v.id("funds"), v.null())),
      categoryId: v.optional(v.union(v.id("budgetCategories"), v.null())),
    }),
    // When provided, REPLACE the budget's whole tag set (diff the links). Omit
    // to leave the existing tags untouched.
    tagIds: v.optional(v.array(v.id("budgetTags"))),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    // Load first (central budgets are visible to the caller's chapter), then gate
    // the WRITE: central budgets are mutated only by central users, chapter
    // budgets by a manager.
    const budget = await requireInCallerChapter(
      ctx,
      chapterId,
      "budgets",
      args.budgetId,
      "Budget",
      { allowCentral: true },
    );
    const level = budget.chapterId as BudgetLevel;
    const access =
      level === CENTRAL
        ? await requireFinanceCentral(ctx, chapterId)
        : await requireFinanceManager(ctx, chapterId);
    if (args.patch.amountCents != null) {
      assertIntegerCents(args.patch.amountCents, "Budget amount");
    }
    const patch = { ...args.patch };
    const newType = patch.type ?? effectiveType(budget);
    // A recurring budget carries no instance ref: clear a stale event/project.
    if (newType === "recurring") {
      if (patch.refKind === undefined) patch.refKind = null;
      if (patch.scopeRefId === undefined) patch.scopeRefId = null;
    }
    const currentRefKind = effectiveRefKind(budget) ?? undefined;
    const newRefKind =
      newType === "one_time"
        ? (patch.refKind ?? budget.refKind ?? effectiveRefKind(budget) ?? undefined)
        : undefined;
    // The EFFECTIVE instance ref: a patch value (set OR cleared) wins, else the
    // budget's stored one. `refKind` and `scopeRefId` must stay consistent (an
    // event id compared as a project id, or vice versa, is meaningless) — verify
    // the effective pair, not just a freshly-patched `scopeRefId`.
    const scopeRefIdProvided = patch.scopeRefId !== undefined;
    const effScopeRefId = scopeRefIdProvided ? patch.scopeRefId : budget.scopeRefId ?? null;
    // Budget identity & dates (item 3): a budget that IS (or is BECOMING, via
    // this same patch) a linked one_time budget always takes its name/period
    // from the linked event/project — never a caller-supplied value. Gated on
    // the EFFECTIVE POST-PATCH state (not the pre-patch one) so converting an
    // unlinked budget onto a ref can't sneak in a custom label/year/month in
    // the same call — `BudgetCreateModal.tsx` never sends these fields once a
    // ref is selected, whether editing an already-linked budget or converting
    // one. Unlinked/recurring budgets (post-patch) are untouched by this
    // check — they keep full control over their own label/year/month, exactly
    // as before. Deliberately NOT auto-deriving the correct identity here on
    // conversion (owner decision, keep it simple) — a budget newly linked via
    // this mutation keeps its prior label/year/month until the entity's own
    // next edit triggers `syncBudgetIdentityForRef`. `quarter` is included
    // for completeness (review nit) — a one_time budget's cadence never
    // actually surfaces it, but the patch validator structurally allows it,
    // so it's blocked the same as year/month rather than silently accepted.
    const isLinkedAfterPatch = newType === "one_time" && !!newRefKind && effScopeRefId != null;
    if (
      isLinkedAfterPatch &&
      (patch.label !== undefined ||
        patch.year !== undefined ||
        patch.month !== undefined ||
        patch.quarter !== undefined)
    ) {
      throw new ConvexError({
        code: "LINKED_BUDGET_IDENTITY",
        message:
          "This budget's name and period come from its linked event/project — edit the event/project instead.",
      });
    }
    // Changing `refKind` while keeping a stale `scopeRefId` would silently make
    // the budget match nothing (an event id compared as a project id, or vice
    // versa). Reject rather than persist a mismatched ref.
    if (
      newType === "one_time" &&
      newRefKind !== currentRefKind &&
      !scopeRefIdProvided &&
      budget.scopeRefId != null
    ) {
      throw new ConvexError({
        code: "REF_KIND_MISMATCH",
        message: "Changing a budget's link type requires a matching reference.",
      });
    }
    await verifyBudgetRefs(ctx, chapterId, {
      refKind: newRefKind,
      scopeRefId: effScopeRefId,
      fundId: patch.fundId,
      categoryId: patch.categoryId,
      month: patch.month,
      quarter: patch.quarter,
    });
    // Minor review fix: when this edit CONVERTS the budget's ref (a different
    // event/project, a different refKind, or off to recurring/central
    // entirely), the OLD entity is left holding a stale mirrored
    // `budget`/`budgetUsd` field pointing at money that isn't its budget
    // anymore — nothing else ever clears it (the OLD entity's own edit path
    // would only write-through if IT still owned this budget, which it no
    // longer does). Cheap to clear here, so it doesn't linger as a fake
    // "field set, no row" display on the old ref.
    if (
      currentRefKind &&
      budget.scopeRefId &&
      (currentRefKind !== newRefKind || budget.scopeRefId !== effScopeRefId)
    ) {
      if (currentRefKind === "event") {
        const oldEvent = await ctx.db.get(budget.scopeRefId as Id<"events">);
        if (oldEvent) await ctx.db.patch(oldEvent._id, { budget: undefined });
      } else {
        const oldProject = await ctx.db.get(budget.scopeRefId as Id<"projects">);
        if (oldProject) await ctx.db.patch(oldProject._id, { budgetUsd: undefined });
      }
    }
    // WP-U2: amountCents writes through `setBudgetAmount` (the one shared
    // helper `events.updateDetails`/`projects.update` also call), which
    // mirrors the dollar amount back onto the entity's own field in the same
    // step — everything else patches normally. Applied AFTER the general
    // patch (any refKind/scopeRefId conversion above) so a same-call "convert
    // AND set the amount" mirrors onto the NEW ref, not the old one.
    const { amountCents: nextAmountCents, ...restPatch } = patch;
    await ctx.db.patch(args.budgetId, cleanPatch(restPatch));
    if (nextAmountCents != null) {
      await setBudgetAmount(ctx, args.budgetId, nextAmountCents);
      // financeAuditLog (budget_amount_change) — only when the amount
      // actually changed (skip a same-value resubmit).
      if (nextAmountCents !== budget.amountCents) {
        await logFinanceAudit(ctx, {
          chapterId: level,
          subjectType: "budget",
          subjectId: args.budgetId,
          action: "budget_amount_change",
          actorPersonId: access.personId,
          field: "amount",
          before: formatCents(budget.amountCents),
          after: formatCents(nextAmountCents),
          amountCents: nextAmountCents,
        });
      }
    }

    // Replace the tag set when `tagIds` was provided (diff the link rows).
    if (args.tagIds !== undefined) {
      const want = new Set(args.tagIds);
      for (const tagId of want) await requireTagInLevel(ctx, level, tagId);
      const existing = await ctx.db
        .query("budgetTagLinks")
        .withIndex("by_budget", (q) => q.eq("budgetId", args.budgetId))
        .take(ROLLUP_SCAN_LIMIT);
      const have = new Set(existing.map((l) => l.tagId as string));
      for (const link of existing) {
        if (!want.has(link.tagId)) await ctx.db.delete(link._id);
      }
      for (const tagId of want) {
        if (!have.has(tagId)) {
          await ctx.db.insert("budgetTagLinks", {
            budgetId: args.budgetId,
            tagId,
            chapterId: level,
            createdAt: Date.now(),
          });
        }
      }
    }

    // Auto-tag on CONVERSION to a one_time EVENT budget (consistent with
    // `createBudget`): ensure + link the eventType `template` tag + an `events`
    // tag, only when it wasn't already a one_time event budget. Runs AFTER the
    // tagIds replacement so its links aren't diffed away; idempotent because the
    // existing links seed `seen`, so ensureTag/linkBudgetTag never duplicate.
    const wasEventOneTime =
      effectiveType(budget) === "one_time" && currentRefKind === "event";
    if (newType === "one_time" && newRefKind === "event" && !wasEventOneTime) {
      const userId = (await requireUserId(ctx)) as Id<"users">;
      const existingLinks = await ctx.db
        .query("budgetTagLinks")
        .withIndex("by_budget", (q) => q.eq("budgetId", args.budgetId))
        .take(ROLLUP_SCAN_LIMIT);
      const seen = new Set<string>(existingLinks.map((l) => l.tagId as string));
      await autoTagEventBudget(
        ctx,
        args.budgetId,
        level,
        effScopeRefId ?? undefined,
        seen,
        userId,
      );
    }
    return null;
  },
});

// ── Budget approval workflow (WP-3.2) ────────────────────────────────────────
// State machine: draft → submitted → approved | changes_requested. Submit is
// an editor action (bookkeeper+ at the budget's scope); approve/request-
// changes is an APPROVER action, scope-gated + identity-SoD'd exactly like
// reimbursements (`assertApprovalSoD` in `reimbursements.ts`):
//   - chapter budget  → EITHER chapter finance MANAGER rank (Treasurer —
//     `requireFinanceManager`) OR the caller holds a seat carrying
//     `finance.approve` at that chapter (Chapter Director —
//     `holdsApprovalSeatAt`, `lib/seats.ts`). Owner decision: "Chapter
//     Director does have financial powers, they approve budgets... a budget
//     shouldn't get approved without the chapter director." The CD's
//     leadership-kind title never bridges a `financeRoles` manager grant
//     (unlike Treasurer's `finance_manager` title), so without this seat
//     path a CD-only holder could never approve — this closes that gap
//     without widening the Treasurer path.
//   - central budget  → the ED or FM SPECIALIZED role (`requireCentralEdOrFm`),
//     tighter than plain central finance reach. UNCHANGED — the ED's seat
//     also carries `finance.approve`, but that's covered by the existing
//     title check (`legacyTitle: "executive_director"`); `holdsApprovalSeatAt`
//     is never consulted for a central-scoped decision, so a chapter
//     director's seat can't widen central approval.
// Either scope: approver ≠ submitter (identity, not role) — a dual-hat holder
// who submitted as one seat cannot approve their own submission as the other.
//
// Notifications (founder feedback review): `submitBudgetForApproval` emails
// the scope's approvers (`notifyBudgetApprovers`, below); `approveBudget`/
// `requestBudgetChanges` each email the SUBMITTER back
// (`budgetDecisionEmails.ts#notifyBudgetSubmitter`), including the reviewer's
// `reviewNote` on a changes-requested decision. Both directions are
// best-effort, scheduled Resend sends — never awaited inline, never block
// the mutation.

/** Assert a budget's EFFECTIVE approval status permits `action`. */
function assertBudgetTransition(
  current: BudgetApprovalStatus,
  allowedFrom: readonly BudgetApprovalStatus[],
  action: string,
): void {
  if (!allowedFrom.includes(current)) {
    throw new ConvexError({
      code: "ILLEGAL_TRANSITION",
      message: `Can't ${action} a budget that's ${BUDGET_APPROVAL_STATUS_LABELS[current]}.`,
    });
  }
}

/**
 * WP-wave4 (item 8-LOW, opus review 2026-07-17): append one durable row to
 * `budgetApprovalLog` — the permanent record `budgets`' own last-decision-only
 * fields (`approvalParty`, `approvedByPersonId`/`approvedAt`,
 * `submittedByPersonId`/`submittedAt`) can never be (each gets overwritten by
 * the next decision, and `moveBudgetScope` resets them on a scope move).
 * Called from `submitBudgetForApproval`/`approveBudget`/`requestBudgetChanges`
 * ONLY — never updated or deleted afterward by anything, including
 * `moveBudgetScope`/`deleteBudget` (a budget's history outlives the row).
 */
async function logBudgetDecision(
  ctx: MutationCtx,
  budgetId: Id<"budgets">,
  action: "sent" | "approved" | "changes_requested",
  decidedByPersonId: Id<"people">,
  extra: { party?: "single" | "two_party"; note?: string } = {},
): Promise<void> {
  await ctx.db.insert("budgetApprovalLog", {
    budgetId,
    action,
    decidedByPersonId,
    decidedAt: Date.now(),
    ...extra,
  });
}

export const submitBudgetForApproval = mutation({
  args: { budgetId: v.id("budgets") },
  returns: v.null(),
  handler: async (ctx, { budgetId }) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    const budget = await requireInCallerChapter(
      ctx,
      chapterId,
      "budgets",
      budgetId,
      "Budget",
      { allowCentral: true },
    );
    if (budget.chapterId === CENTRAL) {
      // WP-wave4 (item 1): the ED can plan/edit a central budget (see
      // `budgetLines.ts`) — they can also SEND their own draft for review
      // without needing a stored central rank grant too.
      await requireCentralFinanceRoleOrEdSeat(ctx, chapterId, "bookkeeper");
    } else {
      await requireFinanceRole(ctx, chapterId, "bookkeeper");
    }
    assertBudgetTransition(
      effectiveBudgetApprovalStatus(budget.approvalStatus),
      ["draft", "changes_requested"],
      "submit",
    );
    const personId = await resolveCallerPersonId(ctx, chapterId);
    await ctx.db.patch(budgetId, {
      approvalStatus: "submitted",
      submittedByPersonId: personId,
      submittedAt: Date.now(),
    });
    await logBudgetDecision(ctx, budgetId, "sent", personId);
    // WP-wave4 (item 3): notify the scope's approvers (chapter: Treasurer +
    // Chapter Director; central: ED + FM) — best-effort email, scheduled so
    // this mutation doesn't wait on the network call (Resend needs an action
    // context; see `notifyBudgetApprovers`).
    await ctx.scheduler.runAfter(0, internal.finances.notifyBudgetApprovers, {
      budgetId,
    });
    return null;
  },
});

/**
 * WP-wave4 (item 3): resolve everything `notifyBudgetApprovers` needs to
 * email a budget's approvers — the budget's live display name
 * (`resolveBudgetRef`) and the scope's approvers, found via EITHER the seat
 * chart (`chapter_director`/`treasurer`, or `executive_director`/
 * `financial_manager` at `"central"`) OR the legacy `specializedRoles` title
 * (`"president"`/`"finance_manager"`, or `"executive_director"`/
 * `"finance_manager"` at central) — unioned + deduped by person, mirroring
 * the "seat widens, never replaces the stored side" philosophy elsewhere in
 * finance auth (`lib/finance.ts`'s B10 doc). A scope with no
 * seated/titled holder (or a holder with no `email` on file) simply
 * contributes no row — best-effort, matches `sendReimbursementReminders`'s
 * philosophy (never blocks the submit itself).
 */
export const getBudgetSubmissionContext = internalQuery({
  args: { budgetId: v.id("budgets") },
  returns: v.union(
    v.object({
      budgetName: v.string(),
      level: v.union(v.literal("chapter"), v.literal("central")),
      approvers: v.array(v.object({ email: v.string(), name: v.string() })),
    }),
    v.null(),
  ),
  handler: async (ctx, { budgetId }) => {
    const budget = await ctx.db.get(budgetId);
    if (!budget) return null;
    const level: BudgetLevel = budget.chapterId;
    const { name: budgetName } = await resolveBudgetRef(
      budget,
      nameCache(ctx, "events"),
      nameCache(ctx, "projects"),
    );
    const seatSlugs =
      level === CENTRAL
        ? ["executive_director", "financial_manager"]
        : ["chapter_director", "treasurer"];
    const titleNames: readonly string[] =
      level === CENTRAL
        ? ["executive_director", "finance_manager"]
        : ["president", "finance_manager"];

    const personIds = new Set<Id<"people">>();
    const seated = await ctx.db
      .query("seatAssignments")
      .withIndex("by_scope", (q) => q.eq("scope", level))
      .collect();
    for (const a of seated) {
      const def = await ctx.db.get(a.seatDefId);
      if (def && !def.derived && seatSlugs.includes(def.slug)) personIds.add(a.personId);
    }
    const titled = await ctx.db
      .query("specializedRoles")
      .withIndex("by_scope", (q) => q.eq("scope", level))
      .collect();
    for (const r of titled) {
      if (titleNames.includes(r.title)) personIds.add(r.personId);
    }

    const approvers: { email: string; name: string }[] = [];
    for (const personId of personIds) {
      const p = await ctx.db.get(personId);
      if (p?.email) approvers.push({ email: p.email, name: p.name });
    }
    return {
      budgetName,
      level: level === CENTRAL ? ("central" as const) : ("chapter" as const),
      approvers,
    };
  },
});

/**
 * WP-wave4 (item 3): email a budget's approvers that it's awaiting their
 * review. Best-effort Resend — a no-op that only logs when `RESEND_API_KEY`
 * is unset (mirrors `reimbursements.ts#sendReimbursementReminders` / the
 * ticketing emails), so dev + CI never send. Scheduled (never awaited
 * inline) from `submitBudgetForApproval`, since a mutation can't perform the
 * network call itself.
 *
 * PUSH NOTIFICATIONS ARE A FOLLOW-UP, NOT SHIPPED HERE: this repo has no
 * server-side push-token infra today (`@supa-media/notifications`'s
 * `NotificationProvider` is client-only — it registers device permissions
 * and exposes a token, but nothing persists it server-side, and no Convex
 * action calls the Expo Push API anywhere). Building that (a `pushTokens`
 * table + registration mutation + a push-send action) is out of scope for
 * this PR; email is the full notification surface for now.
 */
export const notifyBudgetApprovers = internalAction({
  args: { budgetId: v.id("budgets") },
  returns: v.null(),
  handler: async (ctx, { budgetId }) => {
    const submission = await ctx.runQuery(internal.finances.getBudgetSubmissionContext, {
      budgetId,
    });
    if (!submission) return null;
    const scopeLabel = submission.level === "central" ? "central budget" : "chapter budget";
    // The finance dashboard is where `BudgetApprovalActions` actually renders
    // (the AttentionRail / BudgetTable rows on `(app)/finances/index.tsx`) —
    // null when APP_URL is unset, per `appUrl`'s contract.
    const link = appUrl("/finances");
    for (const approver of submission.approvers) {
      await sendEmail(ctx, {
        to: approver.email,
        subject: `Budget awaiting your review: ${submission.budgetName}`,
        html: emailShell(`
          ${emailHeading("Budget awaiting review")}
          ${emailParagraph(`Hi ${escapeHtml(approver.name)} — the ${escapeHtml(scopeLabel)} "${escapeHtml(submission.budgetName)}" was just sent for review. Open the finance dashboard to approve it or request changes.`)}
          ${link ? emailButtonRow(link, "Review budget →") : ""}`),
      });
    }
    return null;
  },
});

/** Load a budget for an approve/request-changes decision: resolve the
 *  caller's chapter + identity, verify the budget is visible to them, and
 *  gate on the APPROVER capability for its scope (chapter manager rank OR a
 *  chapter `finance.approve` seat, or central ED/FM). Shared by
 *  `approveBudget` + `requestBudgetChanges` so the two decisions can never
 *  gate differently. */
async function loadBudgetForApprovalDecision(
  ctx: MutationCtx,
  budgetId: Id<"budgets">,
): Promise<{ budget: Doc<"budgets">; callerPersonId: Id<"people"> }> {
  const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
  const budget = await requireInCallerChapter(
    ctx,
    chapterId,
    "budgets",
    budgetId,
    "Budget",
    { allowCentral: true },
  );
  const callerPersonId = await resolveCallerPersonId(ctx, chapterId);
  if (budget.chapterId === CENTRAL) {
    await requireCentralEdOrFm(ctx);
  } else {
    // `requireInCallerChapter` above already proved `budget.chapterId ===
    // chapterId` (the caller's OWN chapter) or threw NOT_FOUND — so a
    // Chapter Director seated at a DIFFERENT chapter never reaches this
    // branch with a matching scope to check. EITHER path clears the gate:
    // manager rank (Treasurer, unchanged) OR a `finance.approve` seat here
    // (Chapter Director — the owner-mandated fix).
    const hasApprovalSeat = await holdsApprovalSeatAt(
      ctx,
      callerPersonId,
      chapterId,
    );
    if (!hasApprovalSeat) {
      await requireFinanceManager(ctx, chapterId);
    }
  }
  return { budget, callerPersonId };
}

export const approveBudget = mutation({
  args: { budgetId: v.id("budgets"), note: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { budgetId, note }) => {
    const { budget, callerPersonId } = await loadBudgetForApprovalDecision(
      ctx,
      budgetId,
    );
    assertBudgetTransition(
      effectiveBudgetApprovalStatus(budget.approvalStatus),
      ["submitted"],
      "approve",
    );
    // WP-wave4 (item 8, owner addendum 2026-07-17) — TEMPORARY governance
    // relaxation: while solo-building/backfilling history, a SUPERUSER may
    // approve their OWN submission (the normal SoD identity block stays for
    // EVERYONE ELSE, unconditionally). `approvalParty` records which path a
    // decision took — a durable, re-reviewable trail for when the org grows
    // past one person. `requestBudgetChanges` is deliberately NOT widened —
    // the addendum only asked for the approve path.
    const selfSubmitted = callerPersonId === budget.submittedByPersonId;
    const bypassSoD = selfSubmitted && (await isSuperuser(ctx));
    if (!bypassSoD) {
      assertSeparationOfDuties(callerPersonId, budget.submittedByPersonId);
    }
    const approvalParty: "single" | "two_party" = bypassSoD ? "single" : "two_party";
    await ctx.db.patch(budgetId, {
      approvalStatus: "approved",
      approvedCents: budget.amountCents,
      approvedByPersonId: callerPersonId,
      approvedAt: Date.now(),
      reviewNote: note,
      approvalParty,
    });
    await logBudgetDecision(ctx, budgetId, "approved", callerPersonId, {
      party: approvalParty,
      note,
    });
    // Notify the submitter back — best-effort email (never awaited inline; a
    // mutation can't call Resend itself). See `budgetDecisionEmails.ts`'s
    // module doc for why this lives in its own file instead of here.
    await ctx.scheduler.runAfter(0, internal.budgetDecisionEmails.notifyBudgetSubmitter, {
      budgetId,
    });
    return null;
  },
});

export const requestBudgetChanges = mutation({
  args: { budgetId: v.id("budgets"), note: v.string() },
  returns: v.null(),
  handler: async (ctx, { budgetId, note }) => {
    const { budget, callerPersonId } = await loadBudgetForApprovalDecision(
      ctx,
      budgetId,
    );
    assertBudgetTransition(
      effectiveBudgetApprovalStatus(budget.approvalStatus),
      ["submitted"],
      "request changes on",
    );
    assertSeparationOfDuties(callerPersonId, budget.submittedByPersonId);
    // `approvedByPersonId`/`approvedAt` double as "last reviewer / reviewed
    // at" for BOTH decisions (there's no separate schema field for a
    // changes-requested reviewer) — only `reviewNote` + `approvalStatus`
    // itself distinguish which decision was made.
    await ctx.db.patch(budgetId, {
      approvalStatus: "changes_requested",
      approvedByPersonId: callerPersonId,
      approvedAt: Date.now(),
      reviewNote: note,
    });
    // `requestBudgetChanges` is deliberately NOT widened for self-submission
    // (item 8's bypass is approve-only) — the assert above already proved
    // this is always a different-identity decision, so "two_party" is the
    // only value this action can ever record.
    await logBudgetDecision(ctx, budgetId, "changes_requested", callerPersonId, {
      party: "two_party",
      note,
    });
    // Notify the submitter back — best-effort email, including the `note`
    // (the "why" on a changes-requested decision). See
    // `budgetDecisionEmails.ts`'s module doc for why this lives in its own
    // file instead of here.
    await ctx.scheduler.runAfter(0, internal.budgetDecisionEmails.notifyBudgetSubmitter, {
      budgetId,
    });
    return null;
  },
});

const budgetApprovalLogRow = v.object({
  action: v.union(
    v.literal("sent"),
    v.literal("approved"),
    v.literal("changes_requested"),
  ),
  party: v.union(v.literal("single"), v.literal("two_party"), v.null()),
  decidedByName: v.string(),
  decidedAt: v.number(),
  note: v.union(v.string(), v.null()),
});

/**
 * WP-wave4 (item 8-LOW, opus review 2026-07-17): the PERMANENT decision
 * history for one budget, newest first — `budgetApprovalLog`'s append-only
 * rows resolved to display names. Gated identically to `budgetLines.listLines`
 * (viewer+ at the budget's own level: chapter viewer, or central reach —
 * OR, item 1, a central `finance.approve` seat) — a budget's own history is
 * exactly as visible as its plan. Bounded to the most recent 20 decisions
 * (a real budget goes through a small handful of send/approve/
 * request-changes rounds, never hundreds).
 */
export const listBudgetApprovalLog = query({
  args: { budgetId: v.id("budgets") },
  returns: v.array(budgetApprovalLogRow),
  handler: async (ctx, { budgetId }) => {
    const chapterId = await readChapterId(ctx);
    if (!chapterId) return [];
    const budget = await requireInCallerChapter(
      ctx,
      chapterId,
      "budgets",
      budgetId,
      "Budget",
      { allowCentral: true },
    );
    if (budget.chapterId === CENTRAL) {
      await requireCentralFinanceRoleOrEdSeat(ctx, chapterId, "viewer");
    } else {
      await requireFinanceRole(ctx, chapterId, "viewer");
    }
    const rows = await ctx.db
      .query("budgetApprovalLog")
      .withIndex("by_budget", (q) => q.eq("budgetId", budgetId))
      .order("desc")
      .take(20);
    const out: (typeof budgetApprovalLogRow.type)[] = [];
    for (const r of rows) {
      const person = await ctx.db.get(r.decidedByPersonId);
      out.push({
        action: r.action,
        party: r.party ?? null,
        decidedByName: person?.name ?? "Unknown",
        decidedAt: r.decidedAt,
        note: r.note ?? null,
      });
    }
    return out;
  },
});

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
async function cascadeDeleteBudget(ctx: MutationCtx, budgetId: Id<"budgets">): Promise<void> {
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

export const deleteBudget = mutation({
  args: { budgetId: v.id("budgets") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    const budget = await requireInCallerChapter(
      ctx,
      chapterId,
      "budgets",
      args.budgetId,
      "Budget",
      { allowCentral: true },
    );
    const access =
      budget.chapterId === CENTRAL
        ? await requireFinanceCentral(ctx, chapterId)
        : await requireFinanceManager(ctx, chapterId);
    // financeAuditLog (budget_delete) — logged before the cascade below (the
    // row still exists here to describe); subjectId is a plain string, so the
    // log outlives the deleted budget doc it describes, same as
    // `reattributionAudit`'s own priorStates.
    await logFinanceAudit(ctx, {
      chapterId: budget.chapterId,
      subjectType: "budget",
      subjectId: args.budgetId,
      action: "budget_delete",
      actorPersonId: access.personId,
      field: "budget",
      before: `${budgetDisplayName(budget)} (${formatCents(budget.amountCents)})`,
      amountCents: budget.amountCents,
    });
    // Clear the explicit link on every txn attributed to this budget FIRST —
    // otherwise a linked txn's `budgetId` points at a deleted doc: invisible
    // to every budget card (it's no one's budget anymore), to
    // `unattributedCents` (its `budgetId` is still non-null), and to
    // `listReconcile`'s `needs_budget` filter (same reason) — the dollar
    // vanishes from every surface. Dropping the link sends it loudly back
    // into Unattributed instead.
    const linkedTxns = await ctx.db
      .query("transactions")
      .withIndex("by_budget", (q) => q.eq("budgetId", args.budgetId))
      .take(ROLLUP_SCAN_LIMIT);
    if (linkedTxns.length === ROLLUP_SCAN_LIMIT) {
      console.warn(
        `[finances] deleteBudget hit ROLLUP_SCAN_LIMIT (${ROLLUP_SCAN_LIMIT}) unlinking transactions from budget ${args.budgetId}; some linked transactions may still reference the deleted budget.`,
      );
    }
    for (const tr of linkedTxns) await ctx.db.patch(tr._id, { budgetId: undefined });

    // Remove its tag links + WP-3.1 `budgetLines` plan, then the budget.
    await cascadeDeleteBudget(ctx, args.budgetId);
    return null;
  },
});

// ── Budget tags (managed CRUD) ───────────────────────────────────────────────
// Gated: chapter tags need a chapter finance manager; central tags need central
// reach. TODO(PR3): also allow president/ED once the specialized-roles system
// lands (do NOT build those role checks here — they don't exist yet).

const budgetTagSummary = v.object({
  id: v.id("budgetTags"),
  name: v.string(),
  kind: v.union(tagKindValidator, v.null()),
  refId: v.union(v.string(), v.null()),
  level: v.union(v.literal("chapter"), v.literal("central")),
});

function toBudgetTagSummary(t: Doc<"budgetTags">) {
  return {
    id: t._id,
    name: t.name,
    kind: t.kind ?? null,
    refId: t.refId ?? null,
    level: t.chapterId === CENTRAL ? ("central" as const) : ("chapter" as const),
  };
}

export const listBudgetTags = query({
  args: {},
  returns: v.array(budgetTagSummary),
  handler: async (ctx) => {
    const chapterId = await readChapterId(ctx);
    if (!chapterId) return [];
    await requireFinanceRole(ctx, chapterId, "viewer");
    const chapterTags = await ctx.db
      .query("budgetTags")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .take(ROLLUP_SCAN_LIMIT);
    const centralTags = await ctx.db
      .query("budgetTags")
      .withIndex("by_chapter", (q) => q.eq("chapterId", CENTRAL))
      .take(ROLLUP_SCAN_LIMIT);
    return [...chapterTags, ...centralTags]
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
      .map(toBudgetTagSummary);
  },
});

export const createBudgetTag = mutation({
  args: {
    name: v.string(),
    kind: v.optional(tagKindValidator),
    refId: v.optional(v.string()),
    sortOrder: v.optional(v.number()),
    // Org-level (central) tag; requires central finance reach.
    central: v.optional(v.boolean()),
  },
  returns: v.id("budgetTags"),
  handler: async (ctx, args) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    if (args.central) {
      await requireFinanceCentral(ctx, chapterId);
    } else {
      await requireFinanceManager(ctx, chapterId);
    }
    const level: BudgetLevel = args.central ? CENTRAL : chapterId;
    // Tenancy-check a ref-carrying tag: a `team`/`template` `refId` must point at
    // a doc in THIS tag's level (the caller's chapter, or central), else a tag
    // could reference another chapter's financeTeam / eventType.
    if (args.refId && (args.kind === "team" || args.kind === "template")) {
      const refDoc = await ctx.db.get(
        args.refId as Id<"financeTeams"> | Id<"eventTypes">,
      );
      const refChapter = (refDoc as { chapterId?: Id<"chapters"> | typeof CENTRAL } | null)
        ?.chapterId;
      const inLevel =
        !!refDoc &&
        (refChapter === level ||
          (level === CENTRAL && (refChapter === CENTRAL || refChapter === undefined)));
      if (!inLevel) {
        throw new ConvexError({
          code: "NOT_FOUND",
          message: `Referenced ${args.kind === "team" ? "team" : "template"} not found at this tag's level.`,
        });
      }
    }
    const userId = (await requireUserId(ctx)) as Id<"users">;
    return await ctx.db.insert("budgetTags", {
      chapterId: level,
      name: args.name,
      kind: args.kind,
      refId: args.refId,
      sortOrder: args.sortOrder,
      createdBy: userId,
      createdAt: Date.now(),
    });
  },
});

export const updateBudgetTag = mutation({
  args: {
    tagId: v.id("budgetTags"),
    patch: v.object({
      name: v.optional(v.string()),
      kind: v.optional(v.union(tagKindValidator, v.null())),
      refId: v.optional(v.union(v.string(), v.null())),
      sortOrder: v.optional(v.number()),
    }),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    const tag = await requireInCallerChapter(
      ctx,
      chapterId,
      "budgetTags",
      args.tagId,
      "Tag",
      { allowCentral: true },
    );
    if (tag.chapterId === CENTRAL) {
      await requireFinanceCentral(ctx, chapterId);
    } else {
      await requireFinanceManager(ctx, chapterId);
    }
    await ctx.db.patch(args.tagId, cleanPatch(args.patch));
    return null;
  },
});

export const deleteBudgetTag = mutation({
  args: { tagId: v.id("budgetTags") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    const tag = await requireInCallerChapter(
      ctx,
      chapterId,
      "budgetTags",
      args.tagId,
      "Tag",
      { allowCentral: true },
    );
    if (tag.chapterId === CENTRAL) {
      await requireFinanceCentral(ctx, chapterId);
    } else {
      await requireFinanceManager(ctx, chapterId);
    }
    // Blocked while any budget still carries the tag.
    const inUse = await ctx.db
      .query("budgetTagLinks")
      .withIndex("by_tag", (q) => q.eq("tagId", args.tagId))
      .first();
    if (inUse) {
      throw new ConvexError({
        code: "TAG_IN_USE",
        message: "This tag is still used by one or more budgets.",
      });
    }
    await ctx.db.delete(args.tagId);
    return null;
  },
});

// ── Migration: legacy `scope` → v2 `type` + tags ─────────────────────────────
const budgetScopeMigrationResult = v.object({
  migrated: v.number(),
  skipped: v.number(),
  tagsLinked: v.number(),
});

/**
 * Backfill every legacy budget onto the v2 `type` + tag model. Shared body for
 * the superuser-gated public mutation and the no-auth CLI internal wrapper.
 * Idempotent: a budget that already has `type` set is skipped, so re-runs are
 * no-ops.
 *
 * Per-scope mapping:
 *  - event    → one_time, refKind=event; auto-tag the eventType template tag + an "events" tag
 *  - project  → one_time, refKind=project
 *  - team     → recurring; ensure/link a `team` tag (refId=teamId, name=financeTeams.name)
 *  - template → recurring; ensure/link a `template` tag when scopeRefId resolves to an eventType
 *  - bucket   → recurring (no tags)
 *  - chapter  → recurring (no tags)
 */
async function runBudgetScopeMigration(
  ctx: MutationCtx,
): Promise<{ migrated: number; skipped: number; tagsLinked: number }> {
    let migrated = 0;
    let skipped = 0;
    let tagsLinked = 0;

    const all = await ctx.db.query("budgets").collect();
    for (const b of all) {
      // Idempotent: a budget already on the v2 model is left untouched.
      if (b.type != null) {
        skipped++;
        continue;
      }
      const level = b.chapterId as BudgetLevel;
      const seen = new Set<string>();
      let type: BudgetType = "recurring";
      let refKind: BudgetRefKind | undefined;

      switch (b.scope) {
        case "event": {
          type = "one_time";
          refKind = "event";
          break;
        }
        case "project": {
          type = "one_time";
          refKind = "project";
          break;
        }
        case "team": {
          type = "recurring";
          const teamId = (b.teamId ?? b.scopeRefId) as Id<"financeTeams"> | undefined;
          if (teamId) {
            const team = await ctx.db.get(teamId);
            if (team && "name" in team) {
              const tagId = await ensureTag(ctx, {
                chapterId: level,
                name: (team as Doc<"financeTeams">).name,
                kind: "team",
                refId: teamId,
              });
              await linkBudgetTag(ctx, b._id, level, tagId, seen);
              tagsLinked++;
            }
          }
          break;
        }
        case "template": {
          type = "recurring";
          if (b.scopeRefId) {
            const et = await ctx.db.get(b.scopeRefId as Id<"eventTypes">);
            if (et && "name" in et) {
              const tagId = await ensureTag(ctx, {
                chapterId: level,
                name: (et as Doc<"eventTypes">).name,
                kind: "template",
                refId: b.scopeRefId,
              });
              await linkBudgetTag(ctx, b._id, level, tagId, seen);
              tagsLinked++;
            }
          }
          break;
        }
        // bucket / chapter / undefined → recurring, no tags.
        default:
          type = "recurring";
          break;
      }

      await ctx.db.patch(b._id, { type, refKind });

      // Event budgets also get the auto template + events tags.
      if (type === "one_time" && refKind === "event") {
        const before = seen.size;
        await autoTagEventBudget(ctx, b._id, level, b.scopeRefId ?? undefined, seen);
        tagsLinked += seen.size - before;
      }
      migrated++;
    }

    return { migrated, skipped, tagsLinked };
}

/**
 * Superuser-gated public wrapper (invoke manually — NOT in the auto-run
 * registry). Idempotent.
 *
 * Run locally:  npx convex run finances:migrateBudgetScopesToTypes
 * Run on prod:  npx convex run --prod finances:migrateBudgetScopesToTypes
 */
export const migrateBudgetScopesToTypes = mutation({
  args: {},
  returns: budgetScopeMigrationResult,
  handler: async (ctx) => {
    await requireSuperuser(ctx);
    return await runBudgetScopeMigration(ctx);
  },
});

/**
 * CLI-runnable (no auth) sibling of {@link migrateBudgetScopesToTypes} — an
 * internalMutation is safe to run without the superuser gate. Same idempotent
 * backfill.
 *
 * Run locally:  npx convex run finances:runMigrateBudgetScopesToTypes
 * Run on prod:  npx convex run --prod finances:runMigrateBudgetScopesToTypes
 */
export const runMigrateBudgetScopesToTypes = internalMutation({
  args: {},
  returns: budgetScopeMigrationResult,
  handler: async (ctx) => await runBudgetScopeMigration(ctx),
});

// ── Event-budget backfill (populate the dashboard's Events & Projects) ───────
const eventBudgetBackfillResult = v.object({
  created: v.number(),
  skipped: v.number(),
  // How many already-existing event budgets had a null/empty label patched to
  // the event's name on this run (a subset of `skipped`; 0 on a settled re-run).
  relabeled: v.number(),
  tagsLinked: v.number(),
});

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
async function runBackfillEventBudgets(
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
  const NUL = " ";
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
 * CLI-runnable (no auth) event-budget backfill — an internalMutation is safe to
 * run without an auth gate, and runnable via `run-convex-function.yml`. Bounded
 * + idempotent (see {@link runBackfillEventBudgets}).
 *
 * Run locally:  npx convex run finances:backfillEventBudgets
 * Run on prod:  npx convex run --prod finances:backfillEventBudgets '{"chapterId":"..."}'
 */
export const backfillEventBudgets = internalMutation({
  args: { chapterId: v.optional(v.id("chapters")) },
  returns: eventBudgetBackfillResult,
  handler: async (ctx, args) =>
    await runBackfillEventBudgets(ctx, args.chapterId),
});

// ── Project budgets (WP-3.4 — mirrors the event budget backfill above) ──────
const projectBudgetBackfillResult = v.object({
  created: v.number(),
  skipped: v.number(),
  // How many already-existing project budgets had a null/empty label patched
  // to the project's name on this run (a subset of `skipped`; 0 on a settled
  // re-run).
  relabeled: v.number(),
  tagsLinked: v.number(),
});

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
async function runBackfillProjectBudgets(
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

/**
 * CLI-runnable (no auth) project-budget backfill — mirrors
 * `backfillEventBudgets`. Bounded + idempotent (see
 * {@link runBackfillProjectBudgets}).
 *
 * Run locally:  npx convex run finances:backfillProjectBudgets
 * Run on prod:  npx convex run --prod finances:backfillProjectBudgets '{"chapterId":"..."}'
 */
export const backfillProjectBudgets = internalMutation({
  args: { chapterId: v.optional(v.id("chapters")) },
  returns: projectBudgetBackfillResult,
  handler: async (ctx, args) =>
    await runBackfillProjectBudgets(ctx, args.chapterId),
});

// ── Cleanup: empty auto-created budgets (owner rule retrofit) ────────────────
const removeEmptyAutoBudgetsResult = v.object({
  scanned: v.number(),
  deleted: v.number(),
  // Kept because a nonzero txn is already linked to it (real spend).
  keptWithSpend: v.number(),
  // Kept because `amountCents` isn't 0 (a real, filled-in budget).
  keptNonzero: v.number(),
  // Kept because the budget already has WP-3.1 `budgetLines` planning rows
  // (event OR project refKind — a v2 plan breakdown): someone's already
  // using budgeting on it, so the planning work in it shouldn't quietly
  // disappear. (Budget v1's legacy `budgetLineItems` guard was retired along
  // with that table — see `0026_migrate_budget_v1_lines`.)
  keptWithLineItems: v.number(),
});

/**
 * Ops cleanup (workflow-callable, no-auth internalMutation): delete
 * auto-created one_time budgets (`refKind` "event" OR "project") that are
 * EMPTY — before the owner rule ("budgets only exist when money does")
 * landed, `backfillEventBudgets` (#125) and `backfillProjectBudgets`/
 * `projects.create`'s create-time hook (this PR, pre-fix) both created a
 * zero-amount budget for every budget-less event/project, which is dashboard
 * clutter the owner flagged. This retroactively removes those.
 *
 * A budget is deleted ONLY when ALL of:
 *  - `type === "one_time"` and `refKind` is `"event"` or `"project"` (never
 *    touches a recurring or legacy-scope budget).
 *  - `amountCents === 0` — NEVER deletes a budget with a nonzero amount, even
 *    if it's otherwise unused.
 *  - Zero linked transactions (`transactions.by_budget`) — NEVER deletes a
 *    budget with linked spend; its actuals still need somewhere to roll up.
 *  - For EITHER ref kind: the budget has no WP-3.1 `budgetLines` rows
 *    (`by_budget`) — a $0 budget can still carry a real v2 plan breakdown (the
 *    amount just hasn't been filled in yet), so deleting it would silently
 *    destroy someone's planning work.
 *
 * Deletes via the shared {@link cascadeDeleteBudget} helper (also used by
 * `deleteBudget`) so its `budgetTagLinks` AND any `budgetLines` rows are
 * removed too — no orphan survives the budget. Bounded + idempotent — a
 * settled re-run deletes nothing.
 *
 * Run locally:  npx convex run finances:removeEmptyAutoBudgets
 * Run on prod:  npx convex run --prod finances:removeEmptyAutoBudgets '{"chapterId":"..."}'
 */
export const removeEmptyAutoBudgets = internalMutation({
  args: { chapterId: v.optional(v.id("chapters")) },
  returns: removeEmptyAutoBudgetsResult,
  handler: async (ctx, args) => {
    let scanned = 0;
    let deleted = 0;
    let keptWithSpend = 0;
    let keptNonzero = 0;
    let keptWithLineItems = 0;

    // Guard: a passed chapter must exist (ConvexError, not a silent no-op).
    if (args.chapterId) {
      const chapter = await ctx.db.get(args.chapterId);
      if (!chapter) {
        throw new ConvexError({ code: "NOT_FOUND", message: "Chapter not found." });
      }
    }

    const budgets = args.chapterId
      ? await ctx.db
          .query("budgets")
          .withIndex("by_chapter", (q) => q.eq("chapterId", args.chapterId!))
          .take(ROLLUP_SCAN_LIMIT)
      : await ctx.db.query("budgets").take(ROLLUP_SCAN_LIMIT);

    for (const b of budgets) {
      if (b.type !== "one_time" || !b.scopeRefId) continue;
      if (b.refKind !== "event" && b.refKind !== "project") continue;
      scanned++;

      if (b.amountCents !== 0) {
        keptNonzero++;
        continue;
      }

      const linkedTxn = await ctx.db
        .query("transactions")
        .withIndex("by_budget", (q) => q.eq("budgetId", b._id))
        .first();
      if (linkedTxn) {
        keptWithSpend++;
        continue;
      }

      // v2 plan guard — covers BOTH event and project refKinds: a $0 budget
      // that already has `budgetLines` planning is real work, not clutter.
      const planLine = await ctx.db
        .query("budgetLines")
        .withIndex("by_budget", (q) => q.eq("budgetId", b._id))
        .first();
      if (planLine) {
        keptWithLineItems++;
        continue;
      }

      await cascadeDeleteBudget(ctx, b._id);
      deleted++;
    }

    console.log(
      `[finances] removeEmptyAutoBudgets: scanned ${scanned}, deleted ${deleted}, ` +
        `kept ${keptWithSpend} (linked spend), ${keptNonzero} (nonzero), ` +
        `${keptWithLineItems} (budget has plan lines).`,
    );

    return { scanned, deleted, keptWithSpend, keptNonzero, keptWithLineItems };
  },
});

// ── Links → budgets migration (WP-U phase A: one home per dollar) ───────────
// Default page size for the migration's own `.paginate()` call (independent
// of `ROLLUP_SCAN_LIMIT`, which bounds ONE-SHOT reads elsewhere in this file —
// a migration needs to PROVE completeness across the whole table, not just
// read a bounded slice and log a "may be truncated" warning). Small enough
// that `ensureBudgetForRef`'s per-row lookups (and occasional budget insert)
// stay comfortably under a mutation's execution budget even on the slowest
// page.
const MIGRATION_PAGE_SIZE = 500;

// One flagged conflict: `budgetId` was already set to something OTHER than
// the ref's budget when the migration examined this row — a human explicitly
// re-coded it since the FK was written, so the migration keeps their choice
// and reports it here instead of silently reconciling. Structured (not a bare
// id) so a reviewer can act on the CLI/log output alone, without a follow-up
// query per conflict.
const migrateLinksToBudgetsConflict = v.object({
  transactionId: v.id("transactions"),
  merchantName: v.union(v.string(), v.null()),
  postedAt: v.number(),
  amountCents: v.number(),
  refKind: refKindValidator,
  refId: v.string(),
  // The event/project's own name (e.g. "Fall Retreat Worship"), so a reviewer
  // doesn't have to look the ref up separately.
  refName: v.string(),
  // The budget the FK points at — what this txn WOULD have been attributed
  // to had the migration not deferred to the human's later re-code.
  refBudgetId: v.id("budgets"),
  refBudgetLabel: v.string(),
  // The budget the txn is CURRENTLY (and remains) attributed to.
  currentBudgetId: v.id("budgets"),
  currentBudgetLabel: v.string(),
  // Sentence-level implication, ready to paste into a review thread.
  message: v.string(),
});

const migrateLinksToBudgetsResult = v.object({
  // Transactions examined THIS PAGE that carry a legacy `eventId`/`projectId`
  // (i.e. excludes rows with neither FK, which the page may also contain).
  scanned: v.number(),
  // `budgetId` was absent → resolved/summoned the ref's budget and set it.
  backfilled: v.number(),
  // `budgetId` was already exactly the ref's budget — a settled re-run no-op.
  alreadySet: v.number(),
  // Count of `conflicts` below, kept alongside it for a one-line CLI summary
  // without having to count the array.
  conflictCount: v.number(),
  conflicts: v.array(migrateLinksToBudgetsConflict),
  // How many NEW $0 "plan" budgets this run had to summon along the way.
  budgetsSummoned: v.number(),
  // Carried a legacy FK pointing at a ref that's central-owned, deleted, or
  // otherwise unresolvable — skipped rather than guessed at.
  skipped: v.number(),
  // Convex's own pagination cursor state — `isDone: false` means there is
  // MORE of the table left; re-invoke with `{ paginationOpts: { numItems,
  // cursor: continueCursor } }` (same `chapterId`, if any) until `isDone` is
  // `true`. This is the operator's proof of completeness — see
  // `docs/plans/link-migration-runbook.md`.
  isDone: v.boolean(),
  continueCursor: v.string(),
});

/** One flagged conflict row — see {@link migrateLinksToBudgetsConflict}'s doc
 *  comment for what each field means and why. */
type MigrationConflict = {
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
async function runMigrateLinksToBudgets(
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

/**
 * CLI-runnable (no auth) migration — mirrors `backfillEventBudgets`. Paginated
 * + idempotent (see {@link runMigrateLinksToBudgets}); re-invoke with the
 * returned `continueCursor` until `isDone` to cover the whole table. See
 * `docs/plans/link-migration-runbook.md` for the full deploy + verify + review
 * procedure — do NOT run this ad hoc against production.
 *
 * Run locally:  npx convex run finances:migrateLinksToBudgets
 * Run on prod (first page):     npx convex run --prod finances:migrateLinksToBudgets '{}'
 * Run on prod (next page):      npx convex run --prod finances:migrateLinksToBudgets '{"paginationOpts":{"numItems":500,"cursor":"<continueCursor>"}}'
 * Run on prod (one chapter):    npx convex run --prod finances:migrateLinksToBudgets '{"chapterId":"..."}'
 */
export const migrateLinksToBudgets = internalMutation({
  args: {
    chapterId: v.optional(v.id("chapters")),
    paginationOpts: v.optional(paginationOptsValidator),
  },
  returns: migrateLinksToBudgetsResult,
  handler: async (ctx, args) =>
    await runMigrateLinksToBudgets(
      ctx,
      args.chapterId,
      args.paginationOpts ?? { cursor: null, numItems: MIGRATION_PAGE_SIZE },
    ),
});

// ── Entity ↔ budget drift reconciliation (WP-U2 — row wins) ──────────────────
// One flagged drift: a money-carrying event/project whose OWN
// `budget`/`budgetUsd` field disagreed with its budget row's `amountCents`
// when the migration examined it — the row won, so this reports what got
// overwritten for a reviewer to scan without a follow-up query per row.
const reconcileEntityBudgetDriftRow = v.object({
  refKind: refKindValidator,
  refId: v.string(),
  refName: v.string(),
  budgetId: v.id("budgets"),
  // The entity field's value BEFORE this run overwrote it (dollars; `null` =
  // unset). `undefined` is never serialized so `null` stands in for "unset".
  entityValueUsd: v.union(v.number(), v.null()),
  // The budget row's `amountCents`, in dollars — what the entity field was
  // just set TO.
  rowAmountUsd: v.union(v.number(), v.null()),
});

const reconcileEntityBudgetDriftResult = v.object({
  // one_time event/project budgets examined this page (recurring/central
  // budgets, and any with no `scopeRefId`, are excluded — nothing to mirror).
  scanned: v.number(),
  // Entity field overwritten to match its budget row this run.
  fixed: v.number(),
  // Entity field already matched its budget row — a settled re-run no-op.
  alreadySynced: v.number(),
  // The ref no longer exists (deleted event/project) — nothing to reconcile.
  skipped: v.number(),
  drifts: v.array(reconcileEntityBudgetDriftRow),
  isDone: v.boolean(),
  continueCursor: v.string(),
});

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
async function runReconcileEntityBudgetDrift(
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
 * CLI-runnable (no auth) migration — mirrors `migrateLinksToBudgets`.
 * Paginated + idempotent (see {@link runReconcileEntityBudgetDrift}); re-invoke
 * with the returned `continueCursor` until `isDone` to cover the whole table.
 *
 * Run locally:  npx convex run finances:reconcileEntityBudgetDrift
 * Run on prod (first page):  npx convex run --prod finances:reconcileEntityBudgetDrift '{}'
 * Run on prod (next page):   npx convex run --prod finances:reconcileEntityBudgetDrift '{"paginationOpts":{"numItems":500,"cursor":"<continueCursor>"}}'
 * Run on prod (one chapter): npx convex run --prod finances:reconcileEntityBudgetDrift '{"chapterId":"..."}'
 */
export const reconcileEntityBudgetDrift = internalMutation({
  args: {
    chapterId: v.optional(v.id("chapters")),
    paginationOpts: v.optional(paginationOptsValidator),
  },
  returns: reconcileEntityBudgetDriftResult,
  handler: async (ctx, args) =>
    await runReconcileEntityBudgetDrift(
      ctx,
      args.chapterId,
      args.paginationOpts ?? { cursor: null, numItems: MIGRATION_PAGE_SIZE },
    ),
});

// ── Row-less entity healing (WP-U2 review — companion to the drift sweep) ───
const healRowlessEntityBudgetsRow = v.object({
  refKind: refKindValidator,
  refId: v.string(),
  refName: v.string(),
  budgetId: v.id("budgets"),
  amountUsd: v.number(),
});

const healRowlessEntityBudgetsResult = v.object({
  // Money-carrying (non-training) refs examined this page.
  scanned: v.number(),
  // A row was missing and got summoned + mirrored this run.
  healed: v.number(),
  isDone: v.boolean(),
  continueCursor: v.string(),
  healedRefs: v.array(healRowlessEntityBudgetsRow),
});

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
async function runHealRowlessEntityBudgets(
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

export const healRowlessEntityBudgets = internalMutation({
  args: {
    refKind: refKindValidator,
    chapterId: v.optional(v.id("chapters")),
    paginationOpts: v.optional(paginationOptsValidator),
  },
  returns: healRowlessEntityBudgetsResult,
  handler: async (ctx, args) =>
    await runHealRowlessEntityBudgets(
      ctx,
      args.refKind,
      args.chapterId,
      args.paginationOpts ?? { cursor: null, numItems: MIGRATION_PAGE_SIZE },
    ),
});

// ── Fund merge (WP-1.4 "defund the UI" — one General Fund, zero fund UI) ────
const fundMergeResult = v.object({
  chaptersScanned: v.number(),
  // Chapters that actually had >1 fund and got merged this run (0 on a
  // settled re-run — the whole migration is a no-op once every chapter is
  // down to its General Fund).
  chaptersMerged: v.number(),
  fundsDeleted: v.number(),
  categoriesRepointed: v.number(),
  budgetsRepointed: v.number(),
  transactionsRepointed: v.number(),
  reimbursementLineItemsRepointed: v.number(),
  legacyAccountsRepointed: v.number(),
});

/**
 * Merge every extra fund in ONE chapter into its General Fund (resolved via
 * {@link findGeneralFundId} — by name, else lowest-sortOrder unrestricted,
 * else lowest-sortOrder). Repoints every `fundId`/`defaultFundId` reference
 * (`budgetCategories` — required field, so a dangling extra-fund reference
 * would otherwise break category display; `budgets`; `transactions`;
 * `reimbursementLineItems`; `legacyAccounts.defaultFundId`), then deletes the
 * now-empty extra fund docs.
 *
 * A chapter with 0 or 1 funds is a no-op (nothing to merge) — this is what
 * makes a re-run of the whole migration idempotent.
 */
async function runMergeFundsIntoGeneralForChapter(
  ctx: MutationCtx,
  chapterId: Id<"chapters">,
): Promise<{
  merged: boolean;
  fundsDeleted: number;
  categoriesRepointed: number;
  budgetsRepointed: number;
  transactionsRepointed: number;
  reimbursementLineItemsRepointed: number;
  legacyAccountsRepointed: number;
}> {
  const zero = {
    merged: false,
    fundsDeleted: 0,
    categoriesRepointed: 0,
    budgetsRepointed: 0,
    transactionsRepointed: 0,
    reimbursementLineItemsRepointed: 0,
    legacyAccountsRepointed: 0,
  };
  const keeperId = await findGeneralFundId(ctx, chapterId);
  if (!keeperId) return zero; // fund-less chapter — nothing to merge

  const funds = await ctx.db
    .query("funds")
    .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
    .take(ROLLUP_SCAN_LIMIT);
  const extras = funds.filter((f) => f._id !== keeperId);
  if (extras.length === 0) return zero; // already down to one fund

  let categoriesRepointed = 0;
  let budgetsRepointed = 0;
  let transactionsRepointed = 0;
  let reimbursementLineItemsRepointed = 0;
  let legacyAccountsRepointed = 0;

  // Cache the chapter-wide scans that lack a `by_fund` index — one bounded
  // read per table, reused across every extra fund instead of per-fund.
  const chapterBudgets = await ctx.db
    .query("budgets")
    .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
    .take(ROLLUP_SCAN_LIMIT);
  const chapterLines = await ctx.db
    .query("reimbursementLineItems")
    .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
    .take(ROLLUP_SCAN_LIMIT);
  const chapterAccounts = await ctx.db
    .query("legacyAccounts")
    .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
    .take(ROLLUP_SCAN_LIMIT);

  for (const extra of extras) {
    // budgetCategories.fundId is REQUIRED — a dangling reference here would
    // break category display/grouping the instant the fund doc is deleted.
    const categories = await ctx.db
      .query("budgetCategories")
      .withIndex("by_fund", (q) => q.eq("fundId", extra._id))
      .take(ROLLUP_SCAN_LIMIT);
    for (const c of categories) {
      await ctx.db.patch(c._id, { fundId: keeperId });
      categoriesRepointed++;
    }

    for (const b of chapterBudgets) {
      if (b.fundId === extra._id) {
        await ctx.db.patch(b._id, { fundId: keeperId });
        budgetsRepointed++;
      }
    }

    const transactions = await ctx.db
      .query("transactions")
      .withIndex("by_fund", (q) => q.eq("fundId", extra._id))
      .take(ROLLUP_SCAN_LIMIT);
    for (const tr of transactions) {
      await ctx.db.patch(tr._id, { fundId: keeperId });
      transactionsRepointed++;
    }

    for (const l of chapterLines) {
      if (l.fundId === extra._id) {
        await ctx.db.patch(l._id, { fundId: keeperId });
        reimbursementLineItemsRepointed++;
      }
    }

    for (const a of chapterAccounts) {
      if (a.defaultFundId === extra._id) {
        await ctx.db.patch(a._id, { defaultFundId: keeperId });
        legacyAccountsRepointed++;
      }
    }

    await ctx.db.delete(extra._id);
  }

  return {
    merged: true,
    fundsDeleted: extras.length,
    categoriesRepointed,
    budgetsRepointed,
    transactionsRepointed,
    reimbursementLineItemsRepointed,
    legacyAccountsRepointed,
  };
}

/**
 * CLI-runnable (no auth) fund-merge migration for WP-1.4 ("defund the UI"):
 * every chapter with more than one fund gets its extras merged into its
 * General Fund (see {@link runMergeFundsIntoGeneralForChapter}). Bounded +
 * idempotent — a settled re-run finds every chapter already at one fund and
 * reports `chaptersMerged: 0`. Pass `chapterId` to merge just one chapter;
 * omit to sweep every chapter.
 *
 * Run locally:  npx convex run finances:runMergeFundsIntoGeneral
 * Run on prod:  npx convex run --prod finances:runMergeFundsIntoGeneral
 */
export const runMergeFundsIntoGeneral = internalMutation({
  args: { chapterId: v.optional(v.id("chapters")) },
  returns: fundMergeResult,
  handler: async (ctx, args) => {
    const chapters = args.chapterId
      ? [await ctx.db.get(args.chapterId)].filter(
          (c): c is Doc<"chapters"> => c !== null,
        )
      : await ctx.db.query("chapters").take(ROLLUP_SCAN_LIMIT);

    let chaptersMerged = 0;
    let fundsDeleted = 0;
    let categoriesRepointed = 0;
    let budgetsRepointed = 0;
    let transactionsRepointed = 0;
    let reimbursementLineItemsRepointed = 0;
    let legacyAccountsRepointed = 0;

    for (const chapter of chapters) {
      const result = await runMergeFundsIntoGeneralForChapter(ctx, chapter._id);
      if (result.merged) {
        chaptersMerged++;
        fundsDeleted += result.fundsDeleted;
        categoriesRepointed += result.categoriesRepointed;
        budgetsRepointed += result.budgetsRepointed;
        transactionsRepointed += result.transactionsRepointed;
        reimbursementLineItemsRepointed += result.reimbursementLineItemsRepointed;
        legacyAccountsRepointed += result.legacyAccountsRepointed;
        console.log(
          `[runMergeFundsIntoGeneral] chapter ${chapter._id}: deleted ${result.fundsDeleted} fund(s); ` +
            `repointed ${result.categoriesRepointed} categories, ${result.budgetsRepointed} budgets, ` +
            `${result.transactionsRepointed} transactions, ${result.reimbursementLineItemsRepointed} reimbursement lines, ` +
            `${result.legacyAccountsRepointed} legacy accounts.`,
        );
      }
    }

    const summary = {
      chaptersScanned: chapters.length,
      chaptersMerged,
      fundsDeleted,
      categoriesRepointed,
      budgetsRepointed,
      transactionsRepointed,
      reimbursementLineItemsRepointed,
      legacyAccountsRepointed,
    };
    console.log(`[runMergeFundsIntoGeneral] done: ${JSON.stringify(summary)}`);
    return summary;
  },
});

// ── Transactions ───────────────────────────────────────────────────────────────

export const listTransactions = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: v.object({
    page: v.array(txnSummary),
    isDone: v.boolean(),
    continueCursor: v.string(),
    splitCursor: v.optional(v.union(v.string(), v.null())),
    pageStatus: v.optional(
      v.union(
        v.literal("SplitRecommended"),
        v.literal("SplitRequired"),
        v.null(),
      ),
    ),
  }),
  handler: async (ctx, args) => {
    const emptyPage = { page: [], isDone: true, continueCursor: "" };
    const chapterId = await readChapterId(ctx);
    if (!chapterId) return emptyPage;
    await requireFinanceRole(ctx, chapterId, "viewer");
    // Drop cross-environment increase_* txns (a `sandbox_` id while in
    // production, or vice versa). A null-id / non-Increase txn is env-neutral.
    const sandboxMode = await readSandbox(ctx);
    const result = await ctx.db
      .query("transactions")
      .withIndex("by_chapter_and_postedAt", (q) => q.eq("chapterId", chapterId))
      .order("desc")
      .paginate(args.paginationOpts);
    return {
      ...result,
      page: result.page
        .filter((tr) => txnMatchesMode(tr, sandboxMode))
        .map(toTxnSummary),
    };
  },
});

/**
 * RECONCILE LIST — the bookkeeper grid's data source. Unlike the paginated
 * {@link listTransactions} (50/page, so filters only ever saw one page), this
 * loads the chapter's transactions bounded (`ROLLUP_SCAN_LIMIT`, a bounded admin
 * set) and filters SERVER-SIDE across ALL rows, so every filter pill is truthful.
 * Returns the filtered `rows` (newest-first, cardholder resolved) plus per-filter
 * `counts` for the pill badges.
 *
 * Filters (the `excluded` status is always dropped first — an intentional
 * exclusion never belongs in the inbox):
 *   - `all`            every non-excluded row
 *   - `spend`          a row that counts as actual spend (`isSpend` — outflow,
 *                       not personal) — the drill-down target for the
 *                       dashboards' "Spent" KPI tile (no-dead-numbers): `all`
 *                       also keeps inflow/transfer/personal rows, so it would
 *                       NOT sum to that tile's figure the way this does
 *   - `needs_budget`   a spend row with no budget yet (`isSpend && budgetId == null`)
 *   - `missing_receipt` a row that still owes a receipt / supporting document
 *     and isn't yet `reconciled` — `needsDocumentation`, which covers spend
 *     charges PLUS marked internal transfers and marked processor payouts (a
 *     marked row must not vanish from the chase just because it stopped being
 *     spend; see that predicate's doc comment). A treasurer who closed a row
 *     document-less made a call, so it drops out of the chase-worthy count
 *     (the row stays visible under `reconciled`, just not counted here).
 *     `receiptChase` calls the SAME function (same scope resolution too), so
 *     this pill and the Chase list it opens into cannot disagree. An APPROVED
 *     receipt exception closes the chase exactly like a receipt does.
 *   - `undocumented`   a row that owes documentation and has NEITHER a receipt
 *     NOR an approved exception — `isUndocumented`, which unlike the pill
 *     above ignores `status` entirely. This is the PUBLISHING backlog: a row a
 *     treasurer closed document-less is invisible to the chase and loudly
 *     visible here, and this count is what has to reach zero before a period
 *     can honestly be published. See `docs/plans/receipt-exceptions.md`.
 *   - `to_review`      status `unreviewed`
 *   - `reconciled`     status `reconciled`
 *   - `transfers`      any internal transfer leg (`flow:"transfer"`) — the ones
 *     a bookkeeper marked via `markAsTransfer` AND the ones the app booked
 *     itself. This key is also the queue's one INCLUSION filter: an unmarked
 *     leg is hidden from the default view because it owes no coding, no
 *     receipt and no close, and picking Transfers is how you reach it again.
 *     See `isHiddenTransferLeg` in the handler for the full reasoning.
 *   - `payouts`        a processor settlement deposit marked via `markAsPayout`.
 *     Deliberately NOT hidden alongside transfers: a payout is outside money
 *     arriving and the org's only record of that revenue, so it earns a look.
 *
 * Kept to a SINGLE bounded scan over `by_chapter_and_postedAt`: that one desc
 * read yields both the newest-first ordering the grid wants AND every pill's
 * count in one pass, cheaper than a separate `by_chapter_and_status` query per
 * pill.
 *
 * OPTIONAL PERIOD SCOPE (no-dead-numbers): `year` (+ `month`/`period`) narrows
 * the scan to the SAME {year, month, period} window a dashboard tile was
 * showing when the caller drilled in — the same `loadPeriodTxns`/
 * `inDashRange` machinery `dashboardChapter`/`dashboardCentral` use for their
 * own period totals, so a linked-through "Spent" figure and the rows here
 * agree. Omitting `year` keeps the ORIGINAL all-time bounded-recent behavior
 * (every existing caller — the plain Reconcile tab, "Needs budget" links —
 * is unaffected).
 */
/**
 * How many reconcile rows one page ships when the caller doesn't say. The scan
 * behind it is unchanged and still covers the whole scope — this bounds only
 * the per-row ENRICHMENT (documentation state, cardholder, budget owner) and
 * the payload, which is where the query's cost actually scales.
 *
 * 100 is chosen to be comfortably more than a screen at any zoom, so the first
 * paint needs no "Load more", while keeping the expensive tail off the wire.
 */
export const DEFAULT_RECONCILE_PAGE_SIZE = 100;
/** Hard ceiling on `limit`, so a caller can't ask for the old unbounded behavior. */
export const MAX_RECONCILE_PAGE_SIZE = 500;

export const listReconcile = query({
  args: {
    // LEGACY single filter — one mutually-exclusive bucket. Superseded by
    // `filters` (a set), kept because dashboard drill-throughs and shared
    // links carry it. Ignored when `filters` is present.
    filter: v.optional(reconcileFilterValidator),
    // The real input: a SET of filters, OR'd within a group and AND'd across
    // groups (`@events-os/shared#matchesReconcileFilters`). Empty/absent means
    // no constraint. A charge is routinely unreviewed AND missing a receipt
    // AND unbudgeted at once, which one bucket could never express.
    filters: v.optional(v.array(reconcileFilterValidator)),
    // WP-2.1: `scope:"central"` reconciles CENTRAL-owned txns instead of the
    // caller's chapter — the central desk's Reconcile. Requires central reach
    // (mirrors `dashboardChapter`'s optional-chapterId central drill-down).
    // Absent → the caller's own chapter, exactly as before.
    //
    // `scope:"all"` (the founder's dual-hat case) reconciles EVERY book at once
    // — central plus every active chapter — in one merged queue. This is the
    // only scope whose row set spans books, and it exists because one person is
    // currently both the central Financial Manager and New York's treasurer:
    // making her clear the same backlog twice, once per desk, is the actual
    // complaint behind "the UI needs to be cleaned up". Gated on
    // `requireAllBooksReconcile` (see `lib/finance.ts`) — a named power, not an
    // inline `isCentral`, so restricting it post-split is a one-file change.
    // Every row still carries its own `book`, and rows the caller can't write
    // come back `canEdit: false` rather than being hidden.
    scope: v.optional(v.union(v.literal("central"), v.literal("all"))),
    // Central drill-down: view a DIFFERENT real chapter's reconcile queue —
    // independent of `scope:"central"` (that's the CENTRAL-owned-txns
    // bucket; this is "central viewer picks one specific chapter"). Mirrors
    // `dashboardChapter`'s own `chapterId` drill-down gate exactly. Ignored
    // when `scope:"central"` is also set (that branch wins — the two never
    // conflict since `chapterId` is only consulted in the `else` branch).
    chapterId: v.optional(v.id("chapters")),
    // Optional period narrowing (no-dead-numbers) — see the module doc above.
    // `year` gates the other two: `month` un-set + `period !== "ytd"` reads
    // the whole year.
    year: v.optional(v.number()),
    month: v.optional(v.number()),
    period: v.optional(v.union(v.literal("month"), v.literal("ytd"))),
    // FREE-TEXT SEARCH, run SERVER-SIDE over the whole scope. This used to be
    // `filterReconcileRows` on the client, over the rows the server had already
    // narrowed — which made search a function of the active State filter. With
    // the page's default selection that meant the box searched 14 of 346
    // transactions and returned a confident, silent nothing for a vendor
    // sitting in another state.
    //
    // So a query does two things here that a filter doesn't: it DROPS the State
    // group for this request, and it un-hides the hidden transfer legs (see
    // `isHiddenTransferLeg`). Kind is still honoured — "payouts, and among them
    // the Givebutter one" is a coherent sentence, where "Olive Garden, but only
    // if it needs a budget" is not. The response reports `searchIgnoredState`
    // so the grid can SAY the State filter is standing down, rather than
    // silently disagreeing with the dropdown the user can still see.
    //
    // Counts are deliberately NOT narrowed by the search — see `counts` below.
    search: v.optional(v.string()),
    // PAGE SIZE for `rows`. The scan and the counts still cover the whole
    // scope (they must — see `counts`), but only this many rows are ENRICHED
    // and shipped. Before this existed the query returned every matching row,
    // each one paying a `documentation` resolution, a cardholder resolution and
    // a budget-owner resolution: fine behind a filter that left 14 rows, and
    // 346 rows' worth of sequential database round-trips the moment the filter
    // came off. Clamped server-side to `MAX_RECONCILE_PAGE_SIZE`.
    limit: v.optional(v.number()),
  },
  returns: v.object({
    rows: v.array(reconcileRow),
    counts: reconcileCounts,
    // How many rows the selection (+ search) matched across the WHOLE scope,
    // before paging. `rows.length` is min(this, limit), so the grid can say
    // "showing 100 of 346" honestly and know whether to offer "Load more".
    matchedCount: v.number(),
    // Whether `matchedCount` exceeds what `rows` carries.
    hasMore: v.boolean(),
    // True when a non-empty `search` caused the State/roll-up groups to be
    // dropped for this request. The grid shows this; a filter that silently
    // stops applying is the defect this whole change exists to remove.
    searchIgnoredState: v.boolean(),
    // Whether the transaction-coding policy has STARTED
    // (`codingRequiredSinceMs <= now`). The grid hides the "Needs coding" and
    // "Coding review" options until it has: before that date `requiresCoding`
    // is false for every transaction that can exist, so both options are zero
    // by calendar rather than by adoption, and an option that cannot return a
    // row teaches people the whole list is broken. Resolved here because the
    // policy already gets read once per query for `isUncoded`.
    codingArmed: v.boolean(),
    // Rows in scope still awaiting a treasurer — the header's backlog figure.
    // Separate from `counts` because those are facet counts now (see the
    // handler); this one deliberately ignores the active selection.
    toClearCount: v.number(),
    // Rows in scope that owe a receipt or a coding — `receiptChase`'s exact
    // population. Also selection-independent, and the gate for the "Chase
    // receipts" entry point; see the handler for why the `missing_receipt`
    // facet can no longer serve that purpose.
    chaseCount: v.number(),
    // The caller's OWN roster person id (home-chapter scoped, `null` for a
    // superuser with no roster row) — founder feedback review: lets the grid
    // widen "Mark personal" to a cardholder viewing their OWN charge, not
    // just a manager (`cards.flagPersonalCharge` already allows either
    // server-side; the UI just didn't offer it here). Resolved ONCE per
    // query rather than per row since it never varies row to row.
    viewerPersonId: v.union(v.id("people"), v.null()),
    // Whether the caller counts as a finance MANAGER — the grid's manager-only
    // row actions ("Mark personal" on someone else's charge, un-mark
    // transfer/payout). Resolved SERVER-side through the same
    // `getFinanceRole(...).isManager` the mutations themselves gate on, rather
    // than re-derived client-side from `financeRoles.mySeats`. That derivation
    // (`seats.some(s => s.scope === "chapter" && s.role === "manager")`) missed
    // an entire class of real managers: a CENTRAL-scope grant (an Executive
    // Director / Financial Manager, or a superuser) is manager-everywhere
    // server-side — `getFinanceRole` folds in every `scope === "central"` grant
    // — but produces no `scope:"chapter"` seat, so the UI silently hid the flag
    // from them on every row but their own. One authority, no drift.
    viewerIsManager: v.boolean(),
  }),
  handler: async (ctx, args) => {
    // The selection, as a SET. `filters` is the real input; the singular
    // `filter` is kept so pre-existing deep links (and the dashboards' own
    // drill-throughs) keep working — it's just a one-element set, and `"all"`
    // means "no constraint", which is the empty set.
    const activeFilters: ReconcileFilterKey[] =
      args.filters && args.filters.length > 0
        ? args.filters.filter(
            (f): f is ReconcileFilterKey => f !== "all",
          )
        : args.filter && args.filter !== "all"
          ? [args.filter as ReconcileFilterKey]
          : [];
    const zero = {
      all: 0,
      spend: 0,
      needs_budget: 0,
      missing_receipt: 0,
      uncoded: 0,
      coding_review: 0,
      to_review: 0,
      reconciled: 0,
      undocumented: 0,
      personal_unpaid: 0,
      transfers: 0,
      payouts: 0,
      needs_attention: 0,
      ready_to_close: 0,
    };
    // The search terms, parsed once. `[]` means "not searching" — every rule
    // below is a no-op in that case, so an unsearched request behaves exactly
    // as it did before this argument existed.
    const searchTerms = reconcileSearchTerms(args.search);
    const searching = searchTerms.length > 0;
    // A search DROPS the State group (see the `search` arg's doc). Kind is kept.
    const selectionFilters = searching
      ? activeFilters.filter((k) => reconcileFilterGroupOf(k) === "kind")
      : activeFilters;
    const searchIgnoredState = searching && selectionFilters.length !== activeFilters.length;
    const pageSize = Math.max(
      1,
      Math.min(
        Math.floor(args.limit ?? DEFAULT_RECONCILE_PAGE_SIZE),
        MAX_RECONCILE_PAGE_SIZE,
      ),
    );
    const homeChapterId = await readChapterId(ctx);
    if (!homeChapterId)
      return {
        rows: [],
        counts: zero,
        matchedCount: 0,
        hasMore: false,
        searchIgnoredState: false,
        codingArmed: false,
        toClearCount: 0,
        chaseCount: 0,
        viewerPersonId: null,
        viewerIsManager: false,
      };
    // Resolve the BOOKS this queue reads. One book in every scope except
    // `"all"`, which merges central + every active chapter (see the `scope`
    // arg's doc). Central-owned txns key on the `"central"` sentinel; a
    // transaction's own `chapterId` IS its book id, so nothing extra has to be
    // threaded through the load below to know where a row came from.
    let books: FinanceScope[];
    if (args.scope === "all") {
      await requireAllBooksReconcile(ctx, homeChapterId);
      const chapters = await listActiveChapters(ctx, ROLLUP_SCAN_LIMIT);
      books = [CENTRAL, ...chapters.map((c) => c._id)];
    } else if (args.scope === "central") {
      await requireFinanceCentral(ctx, homeChapterId);
      books = [CENTRAL];
    } else if (args.chapterId != null && args.chapterId !== homeChapterId) {
      // The central check resolves the caller's finance capability through
      // their OWN chapter, never the target — a central grant is scope-wide
      // regardless of which chapterId it's checked against, but
      // `getFinanceRole` only finds a roster row in the chapter passed in
      // (mirrors `dashboardChapter`'s identical drill-down gate comment).
      await requireFinanceCentral(ctx, homeChapterId);
      books = [args.chapterId];
    } else {
      await requireFinanceRole(ctx, homeChapterId, "viewer");
      books = [args.chapterId ?? homeChapterId];
    }

    // Display name + writability per book, resolved once (not per row).
    // `canEdit` is about BOOK SCOPE only — it mirrors `requireReconcileTxn`'s
    // chapter rule (central-owned needs central reach, which every branch
    // reaching CENTRAL above already asserted; chapter-owned must be the
    // caller's OWN chapter). The graded rank that gate ALSO checks is uniform
    // across rows, so it isn't a per-row distinction and isn't modelled here.
    const bookMeta = new Map<string, { name: string; canEdit: boolean }>();
    for (const b of books) {
      if (b === CENTRAL) {
        bookMeta.set(CENTRAL, { name: "Central", canEdit: true });
      } else {
        const chapter = await ctx.db.get(b);
        bookMeta.set(b, {
          name: chapter?.name ?? "Chapter",
          canEdit: b === homeChapterId,
        });
      }
    }
    const bookOf = (tr: Doc<"transactions">): typeof reconcileBook.type => {
      const meta = bookMeta.get(tr.chapterId) ?? { name: "Chapter", canEdit: false };
      return { id: tr.chapterId, name: meta.name, canEdit: meta.canEdit };
    };

    const sandboxMode = await readSandbox(ctx);
    // Load each book's slice with the SAME per-book logic as before, then
    // concatenate and re-sort — a merged queue is still newest-first overall,
    // not book-by-book. Single-book scopes take the identical path they always
    // did (one iteration), so nothing about them changes.
    const perBook: Doc<"transactions">[][] = [];
    for (const book of books) {
      if (args.year != null) {
        // Period-scoped (no-dead-numbers): the SAME year/month/ytd window a
        // dashboard tile summed, via the dashboards' own period helpers — see
        // the module doc above. No `month` (or an explicit `period:"ytd"`)
        // reads the WHOLE year (dp.month = 12, ytd = true), not just January.
        const ytd = args.period === "ytd" || args.month == null;
        const dp: DashPeriod = { year: args.year, month: args.month ?? 12, ytd };
        const yearTxns = await loadPeriodTxns(
          ctx,
          book,
          args.year,
          sandboxMode,
          !ytd ? args.month : undefined,
        );
        perBook.push(
          yearTxns
            .filter((tr) => inDashRange(tr.postedAt, dp))
            .filter((tr) => tr.status !== "excluded"),
        );
      } else {
        perBook.push(
          (
            await ctx.db
              .query("transactions")
              .withIndex("by_chapter_and_postedAt", (q) => q.eq("chapterId", book))
              .order("desc")
              .take(ROLLUP_SCAN_LIMIT)
          )
            .filter((tr) => txnMatchesMode(tr, sandboxMode))
            // An intentionally-excluded charge is never part of the reconcile inbox.
            .filter((tr) => tr.status !== "excluded"),
        );
      }
    }
    const all: Doc<"transactions">[] = perBook
      .flat()
      .sort((a, b) => b.postedAt - a.postedAt);

    // The linked personal repayment's live status, resolved EAGERLY (before
    // the counts loop) for just the `isPersonal` subset of `all` — bounded by
    // how many rows are flagged personal (small in practice), not `all.length`.
    // Needed both for the `personal_unpaid` pill's count AND its predicate,
    // since "unpaid" (as opposed to "flagged at all") depends on the linked
    // `personalRepayments` row's `status`, not just `isPersonal`.
    const getRepaymentForCount = nameCache(ctx, "personalRepayments");
    const repaymentStatusByTxnId = new Map<
      Id<"transactions">,
      RepaymentStatus | null
    >();
    for (const tr of all) {
      if (tr.isPersonal === true) {
        const rep = tr.repaymentId ? await getRepaymentForCount(tr.repaymentId) : null;
        repaymentStatusByTxnId.set(tr._id, rep?.status ?? null);
      }
    }
    // Mirrors `personalExpenseState` (`@events-os/shared`) collapsed to the
    // one boolean this pill needs: unpaid iff personal AND not yet "paid" (a
    // "failed" repayment attempt still counts — the debt is outstanding).
    const isPersonalUnpaid = (tr: Doc<"transactions">) =>
      tr.isPersonal === true && repaymentStatusByTxnId.get(tr._id) !== "paid";

    // Each row's predicate results, computed ONCE and reused for both the
    // narrowing and the counts (`@events-os/shared`'s pure set logic takes
    // these flags rather than a transaction, so the semantics are testable
    // without a database — see `reconcileFilters.test.ts`).
    // The coding policy's start date — read once per query, consulted per row
    // by `isUncoded` (pre-policy history must never light the facet up).
    const { sinceMs: codingSinceMs } = await codingPolicy(ctx);
    /**
     * EVERY FACET CHANGE IN THIS FUNCTION IS A QUEUE-POPULATION CHANGE, NOT A
     * PREDICATE CHANGE. `needsBudget`, `needsDocumentation` and `isUndocumented`
     * are untouched and stay untouched: they feed the dashboards' dollar tiles,
     * the receipt chase and the publishing gate, and they encode a founder rule
     * (a marked internal transfer and a marked processor payout still owe a
     * receipt, so marking a row can never be a way to stop being chased) that is
     * pinned by `markTransferPayout.test.ts` and `receiptChase.test.ts`.
     *
     * The gates live HERE, next to the other facet logic, precisely so the drift
     * risk is visible in one place rather than hidden behind a second predicate
     * that looks like the first one.
     */
    const flagsFor = (tr: Doc<"transactions">): Record<ReconcileFilterKey, boolean> => {
      const open = tr.status !== "reconciled";
      const base = {
      spend: isSpend(tr),
      // EVERY internal transfer leg, not just the MARKED ones. This used to be
      // `isMarkedTransfer`, which left the app-created legs (a
      // `transfers.recordTransfer` pair, a reimbursement/repayment leg, the
      // reconciliation engine's allocation legs, the retired skim/launch_grant/
      // settlement kinds still on prod) matchable by no key at all. That was
      // survivable while they sat in the default queue; it isn't now that the
      // queue hides them (see `isHiddenTransferLeg` below), because Kind →
      // Transfers is what brings them back. `isMarkedTransfer` still decides
      // what a row OWES (`needsDocumentation`) and whether Un-mark is offered —
      // widening the FILTER doesn't widen either of those.
      transfers: tr.flow === "transfer",
      payouts: isProcessorPayout(tr),
      to_review: tr.status === "unreviewed",
      // OPEN rows only. `needsBudget` is deliberately status-blind — the
      // dashboards' unbudgeted-spend tiles want every status, because
      // unattributed money is unattributed whether someone closed the row or
      // not — but a closed row is not queue work, and 4 of the 14 rows this
      // facet showed in production were already `reconciled`. Matches what
      // `needsDocumentation` has always done. THE PREDICATE IS UNCHANGED.
      needs_budget: needsBudget(tr) && open,
      missing_receipt: needsDocumentation(tr),
      // The substantiation chase (`docs/plans/transaction-coding.md`):
      // `uncoded` waits on the AUTHOR (nothing submitted, or sent back);
      // `coding_review` waits on a REVIEWER — deliberately keyed off
      // `codingState` alone, so a voluntarily-coded pre-policy row still
      // reaches the review queue.
      uncoded: isUncoded(tr, codingSinceMs),
      coding_review: tr.codingState === "submitted",
      personal_unpaid: isPersonalUnpaid(tr),
      reconciled: tr.status === "reconciled",
      // "Closed without documentation" — the DIFFERENCE, not the superset.
      //
      // `isUndocumented` ignores status entirely, which made this facet a
      // strict superset of `missing_receipt`: in production, overlap 42,
      // only-undocumented 3, only-missing-receipt 0. Two options with
      // near-identical labels and near-identical numbers, where picking the
      // bigger one showed you the rows you had just looked at plus three you
      // hadn't. Restricting the facet to the CLOSED tail leaves two disjoint
      // options whose labels are both literally true; the publishing backlog is
      // their OR, which — same group — is what multi-select already gives you.
      //
      // THE PREDICATE IS UNCHANGED: `isUndocumented` is still the publishing
      // gate and still mirrors `documentationState(...)` for the ledger.
      undocumented: isUndocumented(tr) && !open,
      };
      // THE HEADER ROLL-UPS, defined as complements over the OPEN set so
      // `needs_attention + ready_to_close === toClearCount` holds by
      // construction and the header cannot drift from the grid. Derived from
      // `RECONCILE_ATTENTION_KEYS` rather than a re-typed list, for the same
      // reason.
      //
      // They answer the question `toClearCount` alone could not: of 127 open
      // rows, 51 had something genuinely outstanding and 76 were categorised,
      // budgeted, documented and simply never closed. That second pile is the
      // single biggest actionable bucket in the book and there was no filter
      // that found it — you could only reach it by scrolling 346 rows and
      // eyeballing each one.
      const needsAttention =
        open && RECONCILE_ATTENTION_KEYS.some((k) => base[k]);
      return {
        ...base,
        needs_attention: needsAttention,
        ready_to_close: open && !needsAttention,
      };
    };

    // FACET COUNTS, not global ones. With one mutually-exclusive filter, a
    // count could safely be "rows matching this predicate". With a SET of
    // filters it can't: pick "Spend", and a global "Missing receipt 153"
    // sitting beside it promises 153 rows that selecting it would never
    // produce — the same dead number this whole area was fixing, reintroduced
    // by multi-select. `countsTowardFacet` honours every OTHER group's
    // selections and ignores the key's own group, so the numbers inside one
    // dropdown stay comparable while still reflecting what's narrowed
    // elsewhere. With nothing selected these equal the old global counts
    // exactly.
    // INTERNAL TRANSFER LEGS ARE NOT QUEUE WORK. Reconcile asks three things of
    // a row — code it, confirm its documentation, close it — and a
    // `flow:"transfer"` leg answers none of them. It's one half of a matched
    // PAIR sharing a `transferGroupId`, with a `note` spelling out the
    // arithmetic; it takes no category and no budget, so there is nothing to
    // code. It's the org moving money between its own books, and it sat in this
    // queue as volume the treasurer could only ever scroll past (owner,
    // 2026-08, pointing at both a hand-marked balance transfer and the
    // engine's own "Auto: settlement of cross-book card spend" legs).
    //
    // MARKED legs are hidden too, and that is safe — the point deserves stating
    // because it looks like it contradicts `needsDocumentation`'s founder rule
    // ("marking a row must never be a way to make it stop being chased"). It
    // doesn't. THE RECEIPT CHASE IS A SEPARATE SURFACE: `receiptChase` runs its
    // own scan and its own `needsDocumentation(tr) || chargeOutstanding(...)`
    // union, with no reference to this list or its filters, and it's where a
    // cardholder-less row (a bank transfer, a processor deposit) is chased with
    // a statement rather than a person. So a marked transfer hidden from HERE
    // still owes its receipt, still returns true from `needsDocumentation`, and
    // still appears on the treasurer's chase page. Marking still changes
    // nothing about what a row owes — only where it is listed. Neither
    // `needsDocumentation` nor `isMarkedTransfer` is touched by any of this.
    //
    // Hidden, not gone: Kind → Transfers lifts the exclusion, and the hidden
    // rows still feed that key's facet count below, so the number beside it is a
    // number you can get to.
    const isHiddenTransferLeg = (tr: Doc<"transactions">): boolean =>
      tr.flow === "transfer";
    const transfersRequested = activeFilters.includes("transfers");

    // Cardholder resolution, built HERE rather than beside the row projection
    // because a search has to match a cardholder's NAME across every row in
    // scope, not just the page that ships. `resolveName` skips the signed
    // avatar URL and shares its people/cards caches with `resolve` below, so a
    // row that later lands on the page costs no second read.
    const cardholders = makeCardholderResolver(ctx);
    /**
     * Does this row match the free-text query? Always true when not searching,
     * so the non-search path does no extra work at all (and resolves no names).
     * The matching rule itself is `@events-os/shared#matchesReconcileSearch` —
     * the same function the grid's own tests pin — so what a query finds can't
     * drift between the two halves.
     */
    const matchesSearch = async (tr: Doc<"transactions">): Promise<boolean> => {
      if (!searching) return true;
      return matchesReconcileSearch(
        {
          merchantNameOverride: tr.merchantNameOverride ?? null,
          merchantName: tr.merchantName ?? null,
          description: tr.description ?? null,
          cardholderName: await cardholders.resolveName(tr),
          cardLast4: tr.cardLast4 ?? null,
          bookName: bookMeta.get(tr.chapterId)?.name ?? null,
          amountCents: tr.amountCents,
        },
        searchTerms,
      );
    };

    // `counts.all` is the DEFAULT queue's size, not the raw scan's — counting
    // rows the grid refuses to show would put a total in the header that no
    // amount of scrolling reaches. It's accumulated in the loop rather than
    // taken from `all.length` for that reason, and it stays unmoved by the
    // selection (hidden legs never join it, even when Transfers is picked).
    const counts = { ...zero };
    const selected: Doc<"transactions">[] = [];
    // The header's "N to clear" — everything in SCOPE that isn't reconciled.
    // It can't be derived from `counts` anymore: `counts.all` is the scope
    // total while `counts.reconciled` is now a FACET count that moves with the
    // selection, so `all - reconciled` would mix two different populations and
    // drift as filters change. The backlog headline has to be stable, so it's
    // counted here directly, ignoring the selection entirely.
    let toClearCount = 0;
    // How many rows in scope owe a receipt or a coding — deliberately counted
    // over EVERY row including the hidden transfer legs, and ignoring the
    // selection. This is `receiptChase`'s own population, expression for
    // expression, and it exists because the "Chase receipts" button used to be
    // gated on `counts.missing_receipt`: a facet count that (a) narrows with the
    // selection and (b) no longer sees a marked transfer, since the queue hides
    // it. A book whose only receipt-owing rows are marked transfers would have
    // lost its only route to a chase page that still lists them.
    let chaseCount = 0;
    for (const tr of all) {
      const flags = flagsFor(tr);
      if (needsDocumentation(tr) || chargeOutstanding(tr, codingSinceMs) != null) {
        chaseCount += 1;
      }
      if (isHiddenTransferLeg(tr)) {
        // A hidden leg contributes exactly ONE thing to the unfiltered view:
        // the `transfers` facet count, so the dropdown can advertise the rows
        // it's holding back. It stays out of `counts.all`, out of
        // `toClearCount` (nothing to clear), and out of every other facet —
        // "To review 1" or "Needs documentation 1" beside a queue that renders
        // zero rows is the dead number this whole area exists to prevent. What
        // a hidden row still OWES is unaffected and is counted by `chaseCount`
        // above, which is what the chase page and its button read.
        if (countsTowardFacet(flags, activeFilters, "transfers")) counts.transfers += 1;
        // A SEARCH un-hides these. The hiding rule exists because a transfer
        // leg is not queue work, which is an argument about browsing — it is
        // not an argument for making a $1,000 movement unfindable by name when
        // someone is looking for exactly it. Picking Transfers still un-hides
        // them the ordinary way.
        if (
          (transfersRequested || searching) &&
          matchesReconcileFilters(flags, selectionFilters) &&
          (await matchesSearch(tr))
        ) {
          selected.push(tr);
        }
        continue;
      }
      counts.all += 1;
      if (!flags.reconciled) toClearCount += 1;
      if (
        matchesReconcileFilters(flags, selectionFilters) &&
        (await matchesSearch(tr))
      ) {
        selected.push(tr);
      }
      // FACET COUNTS IGNORE THE SEARCH, deliberately, and are still computed
      // over the WHOLE scope — never over the page. They describe the book, and
      // they are what the State dropdown advertises; recomputing them per
      // keystroke would make every number in that dropdown flicker while the
      // grid it is supposed to describe has stopped obeying it anyway (a search
      // drops the State group). The grid says so explicitly instead, via
      // `searchIgnoredState`.
      for (const key of RECONCILE_FILTER_KEYS) {
        if (countsTowardFacet(flags, activeFilters, key)) counts[key] += 1;
      }
    }
    // PAGE the rows. `selected` is the full match set across the scope — that's
    // what `matchedCount` reports and what "Load more" walks — but only
    // `pageSize` of them get enriched and serialized below.
    const matchedCount = selected.length;
    const page = selected.slice(0, pageSize);
    const hasMore = matchedCount > page.length;

    // The linked personal repayment's live status (`repaymentId` →
    // `personalRepayments.status`) — the grid's Personal badge reads "Repaid"
    // once it settles. Every returned row is a member of `all`
    // (`selected = all.filter(...)`), and `repaymentStatusByTxnId` above
    // already resolved this for every `isPersonal` row in `all` — reuse it
    // rather than re-querying `personalRepayments` a second time per row.
    const resolveRepaymentStatus = async (tr: Doc<"transactions">) =>
      tr.isPersonal === true ? (repaymentStatusByTxnId.get(tr._id) ?? null) : null;

    // Read-through cache for the linked budget's display name (see
    // `reconcileRow.chargedTo` below).
    const getBudget = nameCache(ctx, "budgets");

    // Which book a row COUNTS AGAINST — the linked budget's owner (see
    // `reconcileRow.chargedTo`). Resolved through the same `getBudget` cache
    // the AI-suggestion resolver uses, plus a chapter-name cache: a cross-book
    // row's budget can belong to a chapter that ISN'T among the books this
    // query loaded, so `bookMeta` can't answer it.
    // (`nameCache` is typed to a fixed table set that excludes `chapters`, so
    // this is a plain read-through map rather than reaching into that helper.)
    const chapterNames = new Map<Id<"chapters">, string>();
    const resolveChargedTo = async (
      tr: Doc<"transactions">,
    ): Promise<{ id: Id<"chapters"> | typeof CENTRAL; name: string } | null> => {
      if (tr.budgetId == null) return null;
      const budget = await getBudget(tr.budgetId);
      if (!budget) return null;
      if (budget.chapterId === CENTRAL) return { id: CENTRAL, name: "Central" };
      const ownerId = budget.chapterId;
      let name = chapterNames.get(ownerId);
      if (name === undefined) {
        name = (await ctx.db.get(ownerId))?.name ?? "Chapter";
        chapterNames.set(ownerId, name);
      }
      return { id: ownerId, name };
    };

    // What backs each RETURNED row up. Bounded by the page, not by `all`: an
    // approved exception is one direct `get` off the denormalized pointer, and
    // the `by_transaction` scan for a PENDING one only runs on rows that have
    // neither a receipt nor an approved exception (the undocumented tail).
    const resolveDocumentation = async (
      tr: Doc<"transactions">,
    ): Promise<(typeof reconcileRow.type)["documentation"]> => {
      if (tr.receiptStorageId != null) {
        return { state: "receipt", reasonLabel: null, pendingReason: null };
      }
      if (tr.approvedReceiptExceptionId != null) {
        const ex = await ctx.db.get(tr.approvedReceiptExceptionId);
        return {
          state: "exception",
          reasonLabel: ex
            ? RECEIPT_EXCEPTION_REASON_LABELS[ex.reason]
            : null,
          pendingReason: null,
        };
      }
      const open = await pendingExceptionForTransaction(ctx, tr._id);
      return {
        state: "undocumented",
        reasonLabel: null,
        pendingReason: open
          ? RECEIPT_EXCEPTION_REASON_LABELS[open.reason]
          : null,
      };
    };

    // Projected for the PAGE only, and CONCURRENTLY. Each row costs up to three
    // dependent reads (documentation state, cardholder, budget owner); walking
    // them in a sequential `for` loop made the query's latency the SUM of every
    // row's reads rather than roughly the slowest one. The read-through caches
    // above are plain Maps, so concurrent misses can duplicate a read — which
    // is harmless (same id, same answer) and much cheaper than serializing.
    const rows: (typeof reconcileRow.type)[] = await Promise.all(
      page.map(async (tr) => ({
        ...toTxnSummary(tr),
        correctable: isTransactionCorrectable(tr),
        isReconstructed: isReconstructedHistory({
          externalId: tr.externalId ?? null,
          historicalImportBatch: tr.historicalImportBatch ?? null,
        }),
        documentation: await resolveDocumentation(tr),
        cardholder: await cardholders.resolve(tr),
        book: bookOf(tr),
        chargedTo: await resolveChargedTo(tr),
        repaymentStatus: await resolveRepaymentStatus(tr),
      })),
    );
    // Resolved off the caller's HOME chapter (not `scope`, which can be a
    // central/peeked chapter the caller may not have a roster row in) — the
    // grid compares this against each row's `cardholder.personId` to decide
    // "is this MY charge," which is unaffected by which chapter's queue is
    // currently on screen. `null` for a superuser with no roster row at all.
    const viewer = await viewerPerson(ctx, homeChapterId);
    // Same home-chapter resolution, and deliberately the same call the write
    // mutations make (`cards.flagPersonalCharge` / `finances.unmarkTransfer`
    // both gate on `getFinanceRole(ctx, requireChapterId(ctx))`), so the button
    // the grid offers and the permission the server enforces can never disagree.
    const access = await getFinanceRole(ctx, homeChapterId);
    return {
      rows,
      counts,
      matchedCount,
      hasMore,
      searchIgnoredState,
      codingArmed: codingSinceMs <= Date.now(),
      toClearCount,
      chaseCount,
      viewerPersonId: viewer?._id ?? null,
      viewerIsManager: access.isManager,
    };
  },
});

// ── Missing-receipt chase (the FM's "who do I nudge" list) ───────────────────

// One charge still owed a receipt, projected for the chase list — read-only
// display fields plus the reminder-timeline stage (same meaning as
// `txnSummaryFields.reminderStage`) so the list can show how loudly each
// charge has already been nudged.
const chaseTxn = v.object({
  id: v.id("transactions"),
  postedAt: v.number(),
  amountCents: v.number(),
  merchantName: v.union(v.string(), v.null()),
  description: v.union(v.string(), v.null()),
  cardLast4: v.union(v.string(), v.null()),
  reminderStage: v.union(
    v.literal("none"),
    v.literal("flagged"),
    v.literal("escalated"),
  ),
  // WHAT this row still owes, in the same words the cardholder's own digest
  // uses (`lib/codingReminders.ts#chargeOutstanding`) — "needs coding",
  // "needs a receipt", "needs coding and a receipt", "sent back — needs your
  // edit". Null for a row that owes only documentation and carries no
  // cardholder to chase (a marked transfer or payout), which the chase list
  // still shows under Unattributed.
  //
  // Surfaced because the FM now chases TWO debts from one screen: without it
  // the page can say "3 charges" while the person on the other end is being
  // emailed about something the page never named.
  outstanding: v.union(v.string(), v.null()),
});

// One cardholder's bundle of receipt-owing charges. `personId` is `null` for
// the "Unattributed" group (a charge that resolves to no cardholder at all).
const chaseGroup = v.object({
  personId: v.union(v.id("people"), v.null()),
  name: v.string(),
  imageUrl: v.union(v.string(), v.null()),
  totalCents: v.number(),
  transactions: v.array(chaseTxn),
});

/**
 * MISSING-RECEIPT CHASE — every charge still owed a receipt, grouped by
 * cardholder: the FM's ready-made "who do I nudge, and for what" list, so
 * chasing 16 volunteers doesn't mean re-deriving the same answer from the
 * reconcile grid's flat Missing-receipt filter each week.
 *
 * "Needs a receipt" here = `needsDocumentation` — a spend charge, a MARKED
 * internal transfer, or a MARKED processor payout, with nothing attached and
 * not yet `reconciled` (a treasurer who closed a row document-less made a
 * call — there's nobody left to chase). Both this list and `listReconcile`'s
 * `missing_receipt` pill call that one function, so the pill's count and this
 * list's `count` cannot disagree.
 *
 * Note the two marked classes have no cardholder to chase (a bank transfer and
 * a processor deposit carry no `cardId`/`personId`), so they land in the
 * "Unattributed" group — pinned last, which is the right priority: the
 * treasurer owes those a statement or settlement report, not a person owing a
 * receipt for a card charge.
 *
 * THIS IS WHY THE RECONCILE QUEUE CAN HIDE A MARKED TRANSFER. `listReconcile`
 * drops every `flow:"transfer"` leg from its default view — there's nothing to
 * code on one and nothing to close. That is purely a question of where a row is
 * LISTED: this query is a separate surface with its own scan and its own
 * predicate union, so a marked transfer hidden there still owes its receipt,
 * still returns true from `needsDocumentation`, and still shows up right here.
 * Marking a row remains no way to stop it being chased.
 *
 * `scope`/`chapterId` mirror `listReconcile`'s args and resolution byte for
 * byte (central desk / central drill-down / caller's own chapter, same authz
 * via `requireFinanceCentral`/`requireFinanceRole`) — the Reconcile screen
 * passes through whatever scope it's currently viewing when it navigates
 * here, so "Chase receipts" always opens into the SAME bucket the pill it was
 * clicked from was counting.
 *
 * Grouping resolves the cardholder exactly like the reconcile Cardholder
 * column (`makeCardholderResolver`: the txn's `personId`, else the owner of
 * its `cardId`); a charge resolving to nobody lands in the "Unattributed"
 * group (`personId: null`). Within a group charges sort by amount DESC (chase
 * the big ones first); groups sort by their total DESC, with Unattributed
 * pinned LAST regardless of size — there's no one to chase for it.
 *
 * Viewer+ gated (the same floor as `listReconcile`), single bounded scan over
 * `by_chapter_and_postedAt` (`ROLLUP_SCAN_LIMIT`, the reconcile inbox bound).
 */
export const receiptChase = query({
  args: {
    // Same meaning as `listReconcile`'s `scope`/`chapterId` — see that
    // query's arg comments for the full authz story. Absent → the caller's
    // own chapter, exactly as before this pair of args existed.
    scope: v.optional(v.union(v.literal("central"), v.literal("all"))),
    chapterId: v.optional(v.id("chapters")),
  },
  returns: v.object({
    groups: v.array(chaseGroup),
    totalCents: v.number(),
    count: v.number(),
  }),
  handler: async (ctx, args) => {
    const homeChapterId = await readChapterId(ctx);
    if (!homeChapterId) return { groups: [], totalCents: 0, count: 0 };
    // Resolve the chase BOOKS exactly like `listReconcile` — all books merged,
    // central, a central drill-down into a different chapter, or the caller's
    // own chapter. Keep this branch in sync with `listReconcile`'s: the
    // "Chase receipts" button is reached FROM that grid's `missing_receipt`
    // pill, so a scope this query didn't understand would open a list that
    // disagreed with the count that sent the caller here.
    //
    // Grouping by cardholder makes the merged scope read naturally: one person
    // can hold both a central and a chapter card, and "who still owes me a
    // receipt" is a question about the person, not the book.
    let books: FinanceScope[];
    if (args.scope === "all") {
      await requireAllBooksReconcile(ctx, homeChapterId);
      const chapters = await listActiveChapters(ctx, ROLLUP_SCAN_LIMIT);
      books = [CENTRAL, ...chapters.map((c) => c._id)];
    } else if (args.scope === "central") {
      await requireFinanceCentral(ctx, homeChapterId);
      books = [CENTRAL];
    } else if (args.chapterId != null && args.chapterId !== homeChapterId) {
      await requireFinanceCentral(ctx, homeChapterId);
      books = [args.chapterId];
    } else {
      await requireFinanceRole(ctx, homeChapterId, "viewer");
      books = [args.chapterId ?? homeChapterId];
    }

    const sandboxMode = await readSandbox(ctx);
    const perBook: Doc<"transactions">[][] = [];
    for (const book of books) {
      perBook.push(
        await ctx.db
          .query("transactions")
          .withIndex("by_chapter_and_postedAt", (q) => q.eq("chapterId", book))
          .order("desc")
          .take(ROLLUP_SCAN_LIMIT),
      );
    }
    // THE CHASE IS NOW TWO DEBTS, UNIONED (transaction-coding phase 2).
    //
    // The cardholder digest and the FM's "Remind all" both chase whatever a
    // charge still owes — a receipt, a coding, or both
    // (`lib/codingReminders.ts#chargeOutstanding`). This page is the FM's view
    // of that same worklist, so it has to list the same rows: keyed on
    // documentation alone it would show "3 charges" and then email someone
    // about a fourth it never displayed.
    //
    // Union rather than replacement, because the two predicates cover
    // deliberately different populations. `needsDocumentation` includes MARKED
    // internal transfers and MARKED processor payouts — rows with no cardholder
    // at all, which land in Unattributed and are chased with a statement, not a
    // person. `chargeOutstanding` is cardholder-shaped (outflow spend only), so
    // swapping it in wholesale would silently drop those from the treasurer's
    // list. Taking both keeps every owed row visible and lets each say which
    // debt it carries.
    const { sinceMs: codingSinceMs } = await codingPolicy(ctx);
    const owing = perBook
      .flat()
      .filter((tr) => txnMatchesMode(tr, sandboxMode))
      .filter(
        (tr) =>
          needsDocumentation(tr) || chargeOutstanding(tr, codingSinceMs) != null,
      );

    const resolveCardholder = makeCardholderResolver(ctx).resolve;
    const byHolder = new Map<string, typeof chaseGroup.type>();
    for (const tr of owing) {
      const holder = await resolveCardholder(tr);
      const key = holder?.personId ?? "unattributed";
      let group = byHolder.get(key);
      if (!group) {
        group = {
          personId: holder?.personId ?? null,
          name: holder?.name ?? "Unattributed",
          imageUrl: holder?.imageUrl ?? null,
          totalCents: 0,
          transactions: [],
        };
        byHolder.set(key, group);
      }
      group.totalCents += tr.amountCents;
      group.transactions.push({
        id: tr._id,
        postedAt: tr.postedAt,
        amountCents: tr.amountCents,
        merchantName: tr.merchantName ?? null,
        description: tr.description ?? null,
        cardLast4: tr.cardLast4 ?? null,
        reminderStage: tr.receiptReminderStage ?? ("none" as const),
        outstanding: chargeOutstanding(tr, codingSinceMs),
      });
    }

    const groups = [...byHolder.values()];
    for (const g of groups) {
      g.transactions.sort((a, b) => b.amountCents - a.amountCents);
    }
    groups.sort((a, b) => {
      // Unattributed last, always (nobody to chase); otherwise biggest total first.
      if ((a.personId == null) !== (b.personId == null)) {
        return a.personId == null ? 1 : -1;
      }
      return b.totalCents - a.totalCents;
    });

    return {
      groups,
      totalCents: groups.reduce((s, g) => s + g.totalCents, 0),
      count: owing.length,
    };
  },
});

/** Verify the optional operational-link ids on a transaction write. */
async function verifyTxnRefs(
  ctx: MutationCtx,
  chapterId: Id<"chapters">,
  refs: {
    fundId?: Id<"funds"> | null;
    categoryId?: Id<"budgetCategories"> | null;
    teamId?: Id<"financeTeams"> | null;
    personId?: Id<"people"> | null;
  },
): Promise<void> {
  if (refs.fundId) await requireInCallerChapter(ctx, chapterId, "funds", refs.fundId, "Fund");
  if (refs.categoryId)
    await requireInCallerChapter(ctx, chapterId, "budgetCategories", refs.categoryId, "Category");
  if (refs.teamId)
    await requireInCallerChapter(ctx, chapterId, "financeTeams", refs.teamId, "Team", {
      allowCentral: true,
    });
  if (refs.personId)
    await requireInCallerChapter(ctx, chapterId, "people", refs.personId, "Person");
}

/**
 * Load a transaction for a RECONCILE WRITE and authorize the caller at the
 * txn's own scope (WP-2.1). A chapter-owned txn requires the caller's `min`
 * finance role in that chapter (unchanged from `requireInCallerChapter`); a
 * CENTRAL-owned txn (`chapterId:"central"`) requires central reach
 * (`requireFinanceCentral`) AND the same `min` role rank — `requireFinanceCentral`
 * only checks central REACH (any central grant, including a viewer-only one),
 * so without the extra rank check a central-scoped VIEWER could perform
 * reconcile writes on central txns while a chapter viewer is correctly
 * blocked. Returns the txn, the caller's home chapter (for fund defaults
 * etc.), and the txn's `FinanceScope`. Mirrors how `dashboardChapter`'s
 * optional-chapterId drill-down re-checks central reach (#131).
 */
async function requireReconcileTxn(
  ctx: MutationCtx,
  transactionId: Id<"transactions">,
  min: "viewer" | "bookkeeper" | "manager",
): Promise<{
  txn: Doc<"transactions">;
  homeChapterId: Id<"chapters">;
  scope: FinanceScope;
  /** The caller's roster person id at this scope, for `financeAuditLog`'s
   *  `actorPersonId` — `null` for a superuser with no roster row (a real,
   *  supported path; see that table's doc comment). */
  actorPersonId: Id<"people"> | null;
} > {
  const homeChapterId = (await requireChapterId(ctx)) as Id<"chapters">;
  const txn = (await ctx.db.get(transactionId)) as Doc<"transactions"> | null;
  const notFound = () =>
    new ConvexError({ code: "NOT_FOUND", message: "Transaction not found in your chapter." });
  if (!txn) throw notFound();
  if (txn.chapterId === CENTRAL) {
    const access = await requireFinanceCentral(ctx, homeChapterId);
    if (!financeRoleAtLeast(access.role, min)) {
      throw new ConvexError({
        code: "FORBIDDEN",
        message: `This action needs at least the ${FINANCE_ROLE_LABELS[min]} finance role.`,
      });
    }
    return { txn, homeChapterId, scope: CENTRAL, actorPersonId: access.personId };
  }
  const access = await requireFinanceRole(ctx, homeChapterId, min);
  if (txn.chapterId !== homeChapterId) throw notFound();
  return { txn, homeChapterId, scope: txn.chapterId, actorPersonId: access.personId };
}

/**
 * Resolve + authorize a READ against a finance subject that already lives at
 * `ownerChapterId` (a transaction's or a budget's own `chapterId`) — the
 * EXACT scope rule `requireReconcileTxn` applies to transaction WRITES
 * (central-owned needs central reach + the `min` rank; chapter-owned needs
 * the caller's OWN chapter at that rank), reused here for
 * `financeAuditTrail`'s read gate per the design's "match `requireReconcileTxn`
 * / `listReconcile`, don't invent new scoping" instruction. Kept as a
 * standalone QueryCtx-typed function (rather than refactoring the
 * MutationCtx-typed `requireReconcileTxn` to share it) so an existing write
 * gate is never put at risk for a new read path. Returns `null` — never
 * throws NOT_FOUND — when the subject belongs to a chapter that isn't the
 * caller's own and isn't central (mirrors `requireReconcileTxn`'s own
 * chapter-mismatch branch, but a read path degrades to "nothing to show"
 * rather than a hard error).
 */
async function requireFinanceSubjectRead(
  ctx: QueryCtx,
  ownerChapterId: FinanceScope,
  min: "viewer" | "bookkeeper" | "manager",
): Promise<FinanceScope | null> {
  const homeChapterId = await readChapterId(ctx);
  if (!homeChapterId) return null;
  if (ownerChapterId === CENTRAL) {
    const access = await requireFinanceCentral(ctx, homeChapterId);
    if (!financeRoleAtLeast(access.role, min)) {
      throw new ConvexError({
        code: "FORBIDDEN",
        message: `This action needs at least the ${FINANCE_ROLE_LABELS[min]} finance role.`,
      });
    }
    return CENTRAL;
  }
  await requireFinanceRole(ctx, homeChapterId, min);
  if (ownerChapterId !== homeChapterId) return null;
  return ownerChapterId;
}

// ── financeAuditLog read (History section, mobile) ───────────────────────────
const financeAuditActionValidator = v.union(
  ...FINANCE_AUDIT_ACTIONS.map((a) => v.literal(a)),
);
const AUDIT_TRAIL_LIMIT = 200;

const financeAuditRow = v.object({
  id: v.id("financeAuditLog"),
  action: financeAuditActionValidator,
  actorName: v.union(v.string(), v.null()),
  field: v.union(v.string(), v.null()),
  before: v.union(v.string(), v.null()),
  after: v.union(v.string(), v.null()),
  reason: v.union(v.string(), v.null()),
  amountCents: v.union(v.number(), v.null()),
  createdAt: v.number(),
});

/**
 * The field-change trail for one transaction or budget — the mobile detail
 * modal's compact, collapsed-by-default "History" section. Bookkeeper+
 * gated, scope-aware the SAME way `requireReconcileTxn`/`listReconcile`
 * already are (see `requireFinanceSubjectRead`'s own doc comment) — never a
 * new scoping rule. Returns `[]` (never throws NOT_FOUND) for a missing or
 * out-of-scope subject, exactly like `listReconcile`'s own empty-result
 * shape for "nothing to show here."
 */
export const financeAuditTrail = query({
  args: {
    subjectType: v.union(
      v.literal("transaction"),
      v.literal("budget"),
      v.literal("sale"),
    ),
    subjectId: v.string(),
  },
  returns: v.array(financeAuditRow),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("financeAuditLog")
      .withIndex("by_subject", (q) =>
        q.eq("subjectType", args.subjectType).eq("subjectId", args.subjectId),
      )
      .order("desc")
      .take(AUDIT_TRAIL_LIMIT);
    if (rows.length === 0) return [];
    // Resolve scope from the LIVE subject when it still exists; `deleteBudget`
    // logs its `budget_delete` row for a doc that's gone by the time anyone
    // reads this trail, so fall back to the newest log row's own recorded
    // `chapterId` (every row for one subject carries the same chapter — a
    // subject's chapter only ever changes via bulk reattribution, which
    // writes `reattributionAudit`, not this table) rather than 404ing a trail
    // whose whole point is to outlive the row it describes.
    const ownerChapterId: FinanceScope | null =
      (args.subjectType === "transaction"
        ? (await ctx.db.get(args.subjectId as Id<"transactions">))?.chapterId
        : args.subjectType === "sale"
          ? (await ctx.db.get(args.subjectId as Id<"sales">))?.chapterId
          : (await ctx.db.get(args.subjectId as Id<"budgets">))?.chapterId) ??
      rows[0].chapterId;
    if (ownerChapterId == null) return [];
    const scope = await requireFinanceSubjectRead(ctx, ownerChapterId, "bookkeeper");
    if (scope == null) return [];
    const getPerson = nameCache(ctx, "people");
    const out: (typeof financeAuditRow.type)[] = [];
    for (const r of rows) {
      const actor = r.actorPersonId ? await getPerson(r.actorPersonId) : null;
      out.push({
        id: r._id,
        action: r.action,
        actorName: actor?.name ?? null,
        field: r.field ?? null,
        before: r.before ?? null,
        after: r.after ?? null,
        reason: r.reason ?? null,
        amountCents: r.amountCents ?? null,
        createdAt: r.createdAt,
      });
    }
    return out;
  },
});

/**
 * The single EVENT a transaction's budget is scoped to, if any — `null` for
 * a txn attributed to no budget, or one whose budget isn't a one_time EVENT
 * budget (a project/recurring/central budget has no single event to scope an
 * "event lead" gate to). Used ONLY by the note/receipt/category scoped
 * carve-out below — never widens what a project's or a recurring budget's
 * txns are reachable by. Checks `type === "one_time"` alongside
 * `refKind === "event"` — today every `refKind:"event"` budget is also
 * `type:"one_time"` (a real event has no OTHER reason to carry `refKind`),
 * so this is defensive belt-and-suspenders against that schema invariant
 * ever drifting, not a behavior change against current data (Opus review,
 * PR #218).
 */
async function eventForTxn(
  ctx: MutationCtx,
  txn: Doc<"transactions">,
): Promise<Doc<"events"> | null> {
  if (!txn.budgetId) return null;
  const budget = await ctx.db.get(txn.budgetId);
  if (
    !budget ||
    budget.type !== "one_time" ||
    budget.refKind !== "event" ||
    !budget.scopeRefId
  ) {
    return null;
  }
  return await ctx.db.get(budget.scopeRefId as Id<"events">);
}

/**
 * NOTE / RECEIPT / CATEGORY scoped gate (owner decision, 2026-07-17,
 * verbatim: "they shouldn't be able to change the budget bucket, but they
 * should be able to do everything else like write notes, add receipts,
 * change the category etc"). A caller with EVENT EDIT rights
 * (`callerHasEventEditRights` — the event's owner/lead, or a chapter admin)
 * may act on a transaction attributed to THEIR OWN event's budget, for
 * note/receipt/category ONLY. Reattribution (`budgetId`/`fundId`/`teamId`),
 * amount, and status are NEVER reachable through this gate — those stay
 * `categorizeTransaction`'s/the reconcile grid's bookkeeper+-only territory,
 * completely untouched by this addition.
 *
 * PURE ADDITIVE — the existing finance-role path (`requireReconcileTxn`,
 * bookkeeper+, central-aware) is tried FIRST and, on success, returns
 * immediately with the finance rank's UNCHANGED existing power; the event-
 * lead carve-out is only ever consulted once that path has already failed,
 * so no finance-role caller's reach can shrink because of this gate.
 */
async function requireTxnNoteReceiptCategoryAccess(
  ctx: MutationCtx,
  transactionId: Id<"transactions">,
): Promise<{
  txn: Doc<"transactions">;
  viaFinance: boolean;
  /** For `financeAuditLog` — see `requireReconcileTxn`'s own doc comment. */
  actorPersonId: Id<"people"> | null;
}> {
  try {
    const { txn, actorPersonId } = await requireReconcileTxn(ctx, transactionId, "bookkeeper");
    return { txn, viaFinance: true, actorPersonId };
  } catch (err) {
    if (!(err instanceof ConvexError)) throw err;
    // Fall through — the caller isn't bookkeeper+ (or has no home chapter at
    // all); try the event-lead scoped carve-out below before giving up.
  }
  const txn = (await ctx.db.get(transactionId)) as Doc<"transactions"> | null;
  if (!txn) {
    throw new ConvexError({ code: "NOT_FOUND", message: "Transaction not found." });
  }
  const event = await eventForTxn(ctx, txn);
  if (event && (await callerHasEventEditRights(ctx, event))) {
    // Resolve the caller's OWN roster person (their home chapter, not the
    // txn's — mirrors `requireReconcileTxn`'s `actorPersonId` resolution) for
    // the audit trail; `null` is a legitimate outcome here too.
    const homeChapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    const actor = await viewerPerson(ctx, homeChapterId);
    return { txn, viaFinance: false, actorPersonId: actor?._id ?? null };
  }
  throw new ConvexError({
    code: "FORBIDDEN",
    message:
      "This action needs a finance role, or edit rights on the event this transaction belongs to.",
  });
}

export const createManualTransaction = mutation({
  args: {
    flow: flowValidator,
    amountCents: v.number(),
    postedAt: v.number(),
    description: v.optional(v.string()),
    merchantName: v.optional(v.string()),
    fundId: v.optional(v.id("funds")),
    categoryId: v.optional(v.id("budgetCategories")),
    // WP-U: one home per dollar — a manual entry attributes to a BUDGET
    // directly (the "For" picker), never a separate event/project link.
    budgetId: v.optional(v.id("budgets")),
    teamId: v.optional(v.id("financeTeams")),
    personId: v.optional(v.id("people")),
    // WP-2.1: create a CENTRAL-owned txn (`chapterId:"central"`) instead of a
    // chapter one — requires central reach. Mirrors `createBudget`'s `central`
    // flag. Central txns carry no chapter-scoped links (funds/categories/
    // teams/person are chapter-only; a central budget IS allowed), so those
    // args are rejected but `budgetId` isn't.
    central: v.optional(v.boolean()),
  },
  returns: v.id("transactions"),
  handler: async (ctx, args) => {
    const homeChapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    assertIntegerCents(args.amountCents);
    const userId = (await requireUserId(ctx)) as Id<"users">;
    // financeAuditLog (manual_create) — human summary of what was entered;
    // logged for BOTH branches right before returning, once the txn id exists.
    const logManualCreate = async (
      chapterIdForLog: FinanceScope,
      txnId: Id<"transactions">,
      actorPersonId: Id<"people"> | null,
    ) => {
      const what = args.merchantName?.trim() || args.description?.trim() || "Manual entry";
      await logFinanceAudit(ctx, {
        chapterId: chapterIdForLog,
        subjectType: "transaction",
        subjectId: txnId,
        action: "manual_create",
        actorPersonId,
        after: `${what} — ${formatCents(args.amountCents)} (${args.flow})`,
        amountCents: args.amountCents,
      });
    };
    if (args.central) {
      // Central desk: org-wide reach, and NONE of the chapter-scoped links
      // apply (central has no funds/categories/teams; a person is a chapter
      // roster row). Reject them loudly rather than silently drop.
      const access = await requireFinanceCentral(ctx, homeChapterId);
      if (args.fundId || args.categoryId || args.teamId || args.personId) {
        throw new ConvexError({
          code: "UNSUPPORTED",
          message:
            "A central transaction can't carry chapter-scoped links (fund/category/team/person).",
        });
      }
      if (args.budgetId) {
        // Central's own budget, or — cross-book — a chapter's, when central is
        // fronting that chapter's spend. Same gate the reconcile path uses.
        await requireBudgetForCentralTxn(ctx, homeChapterId, args.budgetId);
        // WP-wave4 (item 5): only an APPROVED budget can take a charge.
        await assertBudgetApprovedForAttribution(ctx, args.budgetId);
      }
      const txnId = await ctx.db.insert("transactions", {
        chapterId: CENTRAL,
        source: "manual",
        flow: args.flow,
        amountCents: args.amountCents,
        currency: "usd",
        postedAt: args.postedAt,
        description: args.description,
        merchantName: args.merchantName,
        budgetId: args.budgetId,
        // Central has no funds (WP-1.4/2.1) — stays fund-less. Coded on entry
        // when a budget was explicitly given, else unreviewed.
        status: args.budgetId ? "categorized" : "unreviewed",
        createdBy: userId,
        createdAt: Date.now(),
      });
      await logManualCreate(CENTRAL, txnId, access.personId);
      return txnId;
    }
    const chapterId = homeChapterId;
    const access = await requireFinanceRole(ctx, chapterId, "bookkeeper");
    await verifyTxnRefs(ctx, chapterId, args);
    if (args.budgetId) {
      // A chapter txn may point at its OWN chapter budget or a central one.
      await requireInCallerChapter(ctx, chapterId, "budgets", args.budgetId, "Budget", {
        allowCentral: true,
      });
      // WP-wave4 (item 5): only an APPROVED budget can take a charge.
      await assertBudgetApprovedForAttribution(ctx, args.budgetId);
    }
    // Categorized on entry when a fund/category/budget was EXPLICITLY
    // supplied, else unreviewed — computed before the silent fund default
    // below so the fund auto-fill (no UI ever sends one) never fakes a real
    // categorization.
    const status =
      args.fundId || args.categoryId || args.budgetId ? "categorized" : "unreviewed";
    // Silently default to the chapter's General Fund when the client omits a
    // fund (every UI now does — funds are backend-only, see WP-1.4).
    const fundId = args.fundId ?? (await defaultFundId(ctx, chapterId)) ?? undefined;
    const txnId = await ctx.db.insert("transactions", {
      chapterId,
      source: "manual",
      flow: args.flow,
      amountCents: args.amountCents,
      currency: "usd",
      postedAt: args.postedAt,
      description: args.description,
      merchantName: args.merchantName,
      fundId,
      categoryId: args.categoryId,
      budgetId: args.budgetId,
      teamId: args.teamId,
      personId: args.personId,
      status,
      createdBy: userId,
      createdAt: Date.now(),
    });
    await logManualCreate(chapterId, txnId, access.personId);
    return txnId;
  },
});

export const categorizeTransaction = mutation({
  args: {
    transactionId: v.id("transactions"),
    fundId: v.optional(v.union(v.id("funds"), v.null())),
    categoryId: v.optional(v.union(v.id("budgetCategories"), v.null())),
    teamId: v.optional(v.union(v.id("financeTeams"), v.null())),
    // Explicit budget attribution — the "For" picker's ONLY link (WP-U: one
    // home per dollar; the old separate eventId/projectId args are gone —
    // `budgetId` subsumes them both). A chapter txn may point at its OWN
    // chapter budget or a central budget (never another chapter's). `null`
    // clears it.
    budgetId: v.optional(v.union(v.id("budgets"), v.null())),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Scope-aware (WP-2.1): a central-owned txn is authorized at central reach,
    // a chapter txn at the caller's bookkeeper role in its chapter.
    const { txn, scope, homeChapterId, actorPersonId } = await requireReconcileTxn(
      ctx,
      args.transactionId,
      "bookkeeper",
    );
    if (scope === CENTRAL) {
      // FUND stays refused, and not for symmetry's sake. A fund encodes DONOR
      // RESTRICTION — whose restricted money paid for this. A central card
      // doesn't draw on a chapter's restricted fund; the cash left central's
      // account. Attaching one would assert something false about where the
      // money came from, which is a worse error than the missing category this
      // branch used to force. (Funds are dormant anyway — one General Fund per
      // chapter, backend-only since WP-1.4.)
      //
      // TEAM stays refused because it's a dead dimension, not because a central
      // txn couldn't have one — see `transactions.teamId`'s schema comment.
      if (args.fundId || args.teamId) {
        throw new ConvexError({
          code: "UNSUPPORTED",
          message:
            "A central transaction can't carry a fund or team — those are chapter-scoped.",
        });
      }
      // CATEGORY is now allowed, but ONLY on a cross-book charge, and only from
      // the receiving chapter's own categories. See
      // `requireCategoryForCentralTxn` for why this had to change: without it,
      // a chapter's budget card showed cross-book spend in an "Uncategorized"
      // bar that literally nobody could fix — not the central FM (refused here)
      // and not the chapter's treasurer (the row lives in central's book, so
      // `requireReconcileTxn` denies them the write).
      if (args.categoryId) {
        await requireCategoryForCentralTxn(
          ctx,
          args.categoryId,
          args.budgetId !== undefined ? args.budgetId : txn.budgetId ?? null,
        );
      }
    } else {
      await verifyTxnRefs(ctx, scope, {
        fundId: args.fundId ?? undefined,
        categoryId: args.categoryId ?? undefined,
        teamId: args.teamId ?? undefined,
      });
    }
    if (args.budgetId) {
      if (scope === CENTRAL) {
        // A central-owned txn: its own book's budget, OR — cross-book — a
        // chapter's, when central fronted that chapter's spend. See
        // `requireBudgetForCentralTxn`.
        await requireBudgetForCentralTxn(ctx, homeChapterId, args.budgetId);
      } else {
        // A chapter txn: its own chapter's budget or a central one
        // (`allowCentral`) — the long-standing chapter-fronts-central case.
        await requireInCallerChapter(ctx, scope, "budgets", args.budgetId, "Budget", {
          allowCentral: true,
        });
      }
      // WP-wave4 (item 5): only an APPROVED budget can take a charge — the
      // "For" picker's own target gate.
      await assertBudgetApprovedForAttribution(ctx, args.budgetId);
    }
    const patch = cleanPatch({
      fundId: args.fundId,
      categoryId: args.categoryId,
      teamId: args.teamId,
      budgetId: args.budgetId,
    });
    // Default the fund to the chapter's General Fund when the client omits it and
    // the txn isn't already coded to one. The reconcile grid hides the fund
    // selector (coding = category + budget only), so this keeps every coded txn
    // attached to a real fund without the UI having to pass it. Central txns have
    // no fund (WP-2.1) — skip the default for them.
    if (scope !== CENTRAL && args.fundId === undefined && txn.fundId == null) {
      const def = await defaultFundId(ctx, scope);
      if (def) patch.fundId = def;
    }
    // INVARIANT: a central-book row may carry a category ONLY while it's
    // charged to that category's chapter budget (see
    // `requireCategoryForCentralTxn`). Re-pointing it at a central budget — or
    // clearing the budget entirely — must therefore drop the category with it,
    // or a correction leaves behind a chapter category on a row that is once
    // again purely central's. Assigned `undefined` (Convex's "remove this
    // optional field" in a patch) — the same value `cleanPatch` translates a
    // caller's explicit `null` into; a literal `null` would fail validation,
    // since `transactions.categoryId` is `v.optional(v.id(...))`, not nullable.
    if (scope === CENTRAL && args.categoryId == null) {
      const nextBudgetId =
        args.budgetId !== undefined ? args.budgetId : txn.budgetId ?? null;
      const nextBudget = nextBudgetId ? await ctx.db.get(nextBudgetId) : null;
      const stillCrossBook = nextBudget != null && nextBudget.chapterId !== CENTRAL;
      if (!stillCrossBook && txn.categoryId != null) patch.categoryId = undefined;
    }
    // Advance an unreviewed transaction to categorized once coded. For a chapter
    // txn "coded" = fund/category; a central txn is coded by its central budget
    // link (its only attribution).
    const nowCoded =
      (patch.fundId ?? txn.fundId) ||
      (patch.categoryId ?? txn.categoryId) ||
      (scope === CENTRAL && args.budgetId != null);
    if (nowCoded && txn.status === "unreviewed") patch.status = "categorized";
    await ctx.db.patch(args.transactionId, patch);
    // financeAuditLog (recode) — see `logRecodeAudit`'s own doc comment; only
    // logs the attribution fields the CALLER explicitly touched, never the
    // silent fund auto-default above.
    await logRecodeAudit(ctx, {
      txn,
      scope,
      actorPersonId,
      categoryChanged: args.categoryId !== undefined,
      budgetChanged: args.budgetId !== undefined,
      beforeCategoryId: txn.categoryId ?? null,
      afterCategoryId: args.categoryId === undefined ? (txn.categoryId ?? null) : args.categoryId,
      beforeBudgetId: txn.budgetId ?? null,
      afterBudgetId: args.budgetId === undefined ? (txn.budgetId ?? null) : args.budgetId,
    });
    return null;
  },
});

export const bulkCategorize = mutation({
  args: {
    transactionIds: v.array(v.id("transactions")),
    fundId: v.optional(v.union(v.id("funds"), v.null())),
    categoryId: v.optional(v.union(v.id("budgetCategories"), v.null())),
    // Explicit budget attribution (chapter or central); `null` clears it.
    budgetId: v.optional(v.union(v.id("budgets"), v.null())),
  },
  returns: v.object({ updated: v.number() }),
  handler: async (ctx, args) => {
    // WP-wave4 (item 5): only an APPROVED budget can take a charge — checked
    // ONCE up front (unlike per-row scope, the approval-status check doesn't
    // depend on which row it's applied to: `args.budgetId` is the same
    // target for the whole batch), so a rejection fails the bulk action
    // atomically before any row is touched.
    if (args.budgetId) {
      await assertBudgetApprovedForAttribution(ctx, args.budgetId);
    }
    // Per-row scope resolution (WP-2.1): a bulk selection is normally all one
    // scope, but resolving each row's scope keeps mixed selections correct — a
    // central row authorizes at central reach, a chapter row at bookkeeper.
    // Fund defaults are memoized per scope (central → none).
    const fundDefaultByScope = new Map<FinanceScope, Id<"funds"> | null>();
    const resolveFundDefault = async (scope: FinanceScope) => {
      if (fundDefaultByScope.has(scope)) return fundDefaultByScope.get(scope)!;
      const def = await defaultFundId(ctx, scope);
      fundDefaultByScope.set(scope, def);
      return def;
    };
    let updated = 0;
    for (const id of args.transactionIds) {
      const { txn, scope, actorPersonId } = await requireReconcileTxn(ctx, id, "bookkeeper");
      if (scope === CENTRAL && (args.fundId || args.categoryId)) {
        throw new ConvexError({
          code: "UNSUPPORTED",
          message:
            "A central transaction can't take a chapter fund/category — only a central budget.",
        });
      } else if (scope !== CENTRAL) {
        await verifyTxnRefs(ctx, scope, {
          fundId: args.fundId ?? undefined,
          categoryId: args.categoryId ?? undefined,
        });
      }
      if (args.budgetId) {
        // Verify against the row's OWN scope (a central budget for a central
        // row; the chapter's own or a central budget for a chapter row).
        await requireInCallerChapter(ctx, scope, "budgets", args.budgetId, "Budget", {
          allowCentral: true,
        });
      }
      const patch = cleanPatch({
        fundId: args.fundId,
        categoryId: args.categoryId,
        budgetId: args.budgetId,
      });
      if (scope !== CENTRAL && args.fundId === undefined && txn.fundId == null) {
        const fallbackFundId = await resolveFundDefault(scope);
        if (fallbackFundId) patch.fundId = fallbackFundId;
      }
      const nowCoded =
        (patch.fundId ?? txn.fundId) ||
        (patch.categoryId ?? txn.categoryId) ||
        (scope === CENTRAL && args.budgetId != null);
      if (nowCoded && txn.status === "unreviewed") patch.status = "categorized";
      await ctx.db.patch(id, patch);
      // financeAuditLog (recode) — same rule `categorizeTransaction` documents
      // (one row per explicitly-touched attribution field, never the silent
      // fund default), applied per row so a bulk action still leaves an
      // individually-readable trail on every transaction it touched.
      await logRecodeAudit(ctx, {
        txn,
        scope,
        actorPersonId,
        categoryChanged: args.categoryId !== undefined,
        budgetChanged: args.budgetId !== undefined,
        beforeCategoryId: txn.categoryId ?? null,
        afterCategoryId:
          args.categoryId === undefined ? (txn.categoryId ?? null) : args.categoryId,
        beforeBudgetId: txn.budgetId ?? null,
        afterBudgetId: args.budgetId === undefined ? (txn.budgetId ?? null) : args.budgetId,
      });
      updated++;
    }
    return { updated };
  },
});

export const setTransactionStatus = mutation({
  args: {
    transactionId: v.id("transactions"),
    status: statusValidator,
    // REQUIRED (non-blank) when `status:"excluded"` — dropping a charge out of
    // every budget/category/actuals total (`isSpend`) with no trace was the
    // founder-flagged gap this whole audit trail exists to close. Optional
    // (but still logged) for every other transition.
    reason: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Scope-aware (WP-2.1): central-owned txns are reconcilable at central reach.
    const { txn, scope, actorPersonId } = await requireReconcileTxn(
      ctx,
      args.transactionId,
      "bookkeeper",
    );
    const reason = args.reason?.trim() || undefined;
    if (args.status === "excluded" && !reason) {
      throw new ConvexError({
        code: "REASON_REQUIRED",
        message: "Excluding a transaction requires a reason.",
      });
    }
    // RECONCILED MEANS DOCUMENTED (receipt-exceptions PR). Closing a row that
    // owes documentation with neither a receipt nor an approved exception used
    // to be the ONLY way to make a receipt-less charge go quiet — and it went
    // quiet everywhere, including in a published ledger, which can't tell that
    // row from a properly documented one. Now it's refused, and the honest
    // alternative (file an exception saying WHY there's no receipt) is one
    // click away in the same panel.
    //
    // Read paths are untouched: this is a guard on the WRITE, so the legacy
    // backlog of already-reconciled undocumented rows stays valid and stays
    // visible in the `undocumented` pill rather than being retroactively
    // invalidated.
    if (args.status === "reconciled" && isUndocumented(txn)) {
      throw new ConvexError({
        code: "RECEIPT_REQUIRED",
        message:
          "Attach a receipt before reconciling — or, if no receipt exists, file a receipt exception saying why.",
      });
    }
    // RECONCILED MEANS SUBSTANTIATED, too (transaction-coding PR): spend
    // posted at/after the coding policy date (2026-09-01 by default —
    // `docs/plans/transaction-coding.md`) also needs an APPROVED coding — the
    // structured what/why/who record — before it can close. Same
    // write-guard-only posture as the receipt gate above: pre-policy history
    // and already-closed rows are untouched.
    if (args.status === "reconciled") {
      const { sinceMs } = await codingPolicy(ctx);
      if (requiresCoding(txn, sinceMs) && txn.codingState !== "approved") {
        throw new ConvexError({
          code: "CODING_REQUIRED",
          message:
            "This charge still needs its coding — what it was for, and who was involved — submitted and approved before it can be reconciled.",
        });
      }
    }
    await ctx.db.patch(args.transactionId, {
      status: args.status,
      // A manager just resolved this txn — the receipt-reminder timeline is
      // moot from here on, so clear it too (mirrors `attachReceipt`'s clear).
      // Otherwise the "Day 3 overdue" badge keeps rendering forever on a row
      // the manager already reconciled or intentionally excluded.
      ...(args.status === "reconciled" || args.status === "excluded"
        ? { receiptReminderStage: undefined, lastReminderSentAt: undefined }
        : {}),
    });
    // financeAuditLog (status_change) — the headline instrumentation: every
    // status set is logged, `reason` carried through only when the caller gave
    // one (required above for `excluded`, optional otherwise).
    await logFinanceAudit(ctx, {
      chapterId: scope,
      subjectType: "transaction",
      subjectId: args.transactionId,
      action: "status_change",
      actorPersonId,
      field: "status",
      before: TRANSACTION_STATUS_LABELS[txn.status],
      after: TRANSACTION_STATUS_LABELS[args.status],
      reason,
      amountCents: txn.amountCents,
    });
    return null;
  },
});

/**
 * Attach a receipt to a transaction. Bookkeeper-or-above may attach to ANY
 * transaction in the chapter (the reconcile-grid path); a caller with no
 * finance seat may still attach to their OWN transaction (the member "My
 * transactions" path) — a cardholder chasing their own receipt shouldn't need
 * a finance grant to do it.
 *
 * `filename` is the name of the file the human actually picked. This is the
 * BUSIEST upload path in the app (every "Attached" chip's own uploader —
 * Reconcile, Transaction Detail, My transactions, the Money view) and it used
 * to record none, while every other ingest path did. The viewer's file-kind
 * detector prefers the stored content type, so a missing name was never fatal
 * — but it is the fallback that saves a browser-supplied
 * `application/octet-stream`, and a receipt whose row says "Feb-invoice.pdf"
 * is simply legible in a way `receipts/kg2f…` is not. Optional: an older
 * client sends nothing, and a native camera roll pick genuinely has no name.
 */
export const attachReceipt = mutation({
  args: {
    transactionId: v.id("transactions"),
    storageId: v.id("_storage"),
    filename: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    const txn = (await ctx.db.get(args.transactionId)) as Doc<"transactions"> | null;
    if (!txn) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Transaction not found in your chapter.",
      });
    }
    if (txn.chapterId === CENTRAL) {
      // A central-owned txn's receipt is central-desk territory (no cardholder
      // "own txn" path — central issues no cards). Gate on central reach AND
      // the bookkeeper rank (requireFinanceCentral alone only checks reach,
      // not role — see requireReconcileTxn for the same fix) — UNLESS the
      // caller has event edit rights on the event this (possibly central-
      // moved) budget still belongs to (owner decision, 2026-07-17 — see
      // `requireTxnNoteReceiptCategoryAccess`'s own doc comment; kept as a
      // parallel inline check here since `attachReceipt`'s own-txn carve-out
      // doesn't compose with that helper's `requireReconcileTxn`-first shape).
      const access = await getFinanceRole(ctx, chapterId);
      const isBookkeeperCentral = access.isCentral && financeRoleAtLeast(access.role, "bookkeeper");
      if (!isBookkeeperCentral) {
        const event = await eventForTxn(ctx, txn);
        if (!event || !(await callerHasEventEditRights(ctx, event))) {
          throw new ConvexError({
            code: "FORBIDDEN",
            message: `This action needs at least the ${FINANCE_ROLE_LABELS.bookkeeper} finance role, or edit rights on the event this transaction belongs to.`,
          });
        }
      }
    } else {
      if (txn.chapterId !== chapterId) {
        throw new ConvexError({
          code: "NOT_FOUND",
          message: "Transaction not found in your chapter.",
        });
      }
      const access = await getFinanceRole(ctx, chapterId);
      const isOwnTxn = access.personId != null && access.personId === txn.personId;
      if (!isOwnTxn && !financeRoleAtLeast(access.role, "bookkeeper")) {
        const event = await eventForTxn(ctx, txn);
        if (!event || !(await callerHasEventEditRights(ctx, event))) {
          throw new ConvexError({
            code: "FORBIDDEN",
            message:
              "Only the transaction's own person, a bookkeeper, or someone with edit rights on the event this transaction belongs to can attach a receipt.",
          });
        }
      }
    }
    // First-class document + link (the receipts layer is now the source of
    // truth; `transactions.receiptStorageId` is the denormalized cache the link
    // maintains — see lib/receiptLinks.ts). The reminder-clear + card-unlock
    // side effects live in `linkReceiptToTransaction`.
    //
    // BEHAVIOR PRESERVED: the in-app upload path historically did NOT flip a
    // `categorized` charge to `reconciled` (reconcile is a deliberate later
    // step here), so we opt out via `reconcileIfCategorized: false`.
    const uploader = await viewerPerson(ctx, chapterId);
    const hadReceipt = txn.receiptStorageId != null;
    const receiptId = await createReceipt(ctx, {
      chapterId: txn.chapterId,
      storageId: args.storageId,
      source: "upload",
      ...(uploader ? { uploadedByPersonId: uploader._id } : {}),
      ...(args.filename && args.filename.trim() !== ""
        ? { filename: args.filename.trim() }
        : {}),
    });
    await linkReceiptToTransaction(ctx, {
      receiptId,
      transactionId: args.transactionId,
      source: "upload",
      ...(uploader ? { linkedByPersonId: uploader._id } : {}),
      reconcileIfCategorized: false,
    });
    // financeAuditLog (receipt_attach). `receipts.linkReceipt` (the bookkeeper
    // "pick the right charge" path over an inbox receipt) logs the same
    // action independently — see its own comment.
    await logFinanceAudit(ctx, {
      chapterId: txn.chapterId,
      subjectType: "transaction",
      subjectId: args.transactionId,
      action: "receipt_attach",
      actorPersonId: uploader?._id ?? null,
      field: "receipt",
      before: hadReceipt ? "Attached" : "None",
      after: "Attached",
      amountCents: txn.amountCents,
    });
    return null;
  },
});

// NOTE: `flagPersonal` (a plain `isPersonal` boolean setter) used to live
// here. It created no `personalRepayments` row and sent no email — a dead
// end nobody could ever actually get billed or paid back through. DELETED:
// every marking/unmarking path (Reconcile grid, Cards tab, "My transactions",
// the dashboard drill-down modal) now routes through `cards.ts#flagPersonalCharge`
// / `cards.ts#unflagPersonalCharge` — the ONE workflow that resolves a real
// payee, creates the repayment record, and emails them. Any `isPersonal:true`
// row this old setter left behind with no `repaymentId` is backfilled by
// migration `0045_backfill_personal_repayments`.

// ── Marking: internal transfers & processor payouts ──────────────────────────
// Founder ask: an ingested bank row reading "PUBLIC WORSHIP | Transfer" landed
// in "Needs budget" as ordinary spend, because EVERY ingest path sets `flow`
// purely from the sign of the amount (`amountCents < 0 ? "outflow" : "inflow"`)
// and nothing has ever recognised a transfer. There was also no way to fix one
// after the fact — `flow` was only ever settable when hand-creating a brand-new
// row. These four mutations are that missing reclassification path.
//
// MANUAL ONLY, BY DECISION (founder, this PR: "manual marking only, in the
// future there should be not a lot of transfers"). No merchant-name heuristic,
// no rule engine, nothing that reclassifies at ingest — a human marks each
// row. Worth revisiting only if the volume ever justifies it, and only after
// real descriptors have been observed.
//
// The two cases are deliberately NOT symmetrical, and that asymmetry is the
// whole point (see `PAYOUT_PROCESSORS` in `@events-os/shared`):
//  - an INTERNAL TRANSFER is money moving between the org's own accounts. Both
//    legs are real ledger rows, so counting either as spend double-counts.
//    Marked -> `flow:"transfer"`, excluded from spend, and REQUIRES both legs
//    (founder: "yes lets require marking the other leg") — marking one side
//    alone would leave the other as unexplained income forever.
//  - a PROCESSOR PAYOUT is real revenue arriving. It gets a LABEL and stays
//    `flow:"inflow"`; it has no second leg to pair with (founder: "payouts have
//    no other leg to mark"), because donations live in `gifts` and never reach
//    this table. Marking one as a transfer would erase the org's income.
//
// Both classes keep owing a receipt (`needsDocumentation`) — marking a row must
// never be a way to make it stop being chased.

/** Bookkeeper+ is the floor for every marking mutation below: this moves a row
 *  in and out of spend totals, which is the same weight class as
 *  `setTransactionStatus`'s exclude. */
const MARK_MIN_ROLE = "bookkeeper" as const;

/**
 * Mark TWO already-ingested rows as the two legs of one internal transfer.
 *
 * Both legs are required and are marked atomically — there is no "mark one
 * side" entry point, by design. The pair is linked by a shared
 * `transferGroupId` (the same linkage `transfers.ts#recordTransfer` uses for
 * the pairs IT creates), each leg's original `flow` is preserved in
 * `preMarkFlow` so `unmarkTransfer` is lossless, and both legs become
 * `flow:"transfer"` — which is what actually drops them out of `isSpend`,
 * "Needs budget", and every category/budget total.
 *
 * SAME SCOPE ONLY. A central<->chapter movement already has a first-class tool
 * that books a proper directional pair (`transfers.recordTransfer`); this one
 * is for reclassifying bank rows that were ingested inside a single scope, so
 * it leaves `transferDirection` unset rather than inventing a crossing that
 * didn't happen. Cross-scope callers get pointed at the right tool.
 *
 * `source` is NOT rewritten to `"transfer"`: the row genuinely did come from
 * the bank feed, and provenance isn't ours to overwrite. (It's `preMarkFlow`,
 * not `source`, that tells a marked leg from any other `flow:"transfer"` row —
 * see `isMarkedTransfer` for why the `source` reading is wrong.)
 *
 * Attribution (`budgetId`/`categoryId`/`fundId`) is deliberately left ALONE.
 * It already stops counting the moment `flow` changes (`isSpend` is false), so
 * clearing it would destroy a bookkeeper's earlier work to no numerical effect
 * — and marking has to be reversible.
 */
/**
 * Mark TWO already-ingested rows as a charge and the refund that reversed it.
 *
 * ── WHY IT'S NOT "MARK AS TRANSFER" ─────────────────────────────────────────
 * A transfer moves money between the org's own accounts and belongs to no
 * budget. A refund is the same merchant handing money back, and the point of
 * recording it is that the ORIGINAL CHARGE should stop counting as spend.
 * `isSpend` is outflow-only, so no amount of coding the credit can reduce a
 * category — a refunded charge went on consuming its budget forever. A $676.40
 * Peerspace booking refunded the next day still read as $676.40 against Pop The
 * Balloon.
 *
 * Book value never had the problem: the charge (−) and the credit (+) already
 * net to zero there, and they still do. Nothing about book value changes here.
 *
 * ── FULL REFUNDS ONLY ───────────────────────────────────────────────────────
 * The amounts must match exactly. A PARTIAL refund has to leave the charge
 * counting for the part that stuck, which means spend has to become a signed
 * sum rather than a boolean — a much larger change across every aggregation.
 * Refusing partials outright is better than approximating them: a charge
 * silently dropped whole when only half came back understates spend, and
 * nothing on screen would say so.
 *
 * ── WHAT IT REFUSES ─────────────────────────────────────────────────────────
 * Different books, two rows moving the same way, mismatched amounts or
 * currencies, a row already in a refund pair, and a row that is part of a
 * transfer pair or a payout. Each is a different situation wearing a similar
 * shape, and quietly accepting any of them moves a budget by the difference.
 *
 * The credit inherits the charge's category and budget. Purely for legibility —
 * it changes no total, because an inflow is never spend — but a refund sitting
 * uncategorised next to the charge it reversed reads like unexplained income.
 */
export const markAsRefund = mutation({
  args: {
    /** The original outflow. */
    chargeTransactionId: v.id("transactions"),
    /** The inflow that gave the money back. */
    refundTransactionId: v.id("transactions"),
    note: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (args.chargeTransactionId === args.refundTransactionId) {
      throw new ConvexError({
        code: "SAME_TRANSACTION",
        message: "A refund needs two different rows — the charge and the credit.",
      });
    }
    const charge = await requireReconcileTxn(
      ctx,
      args.chargeTransactionId,
      MARK_MIN_ROLE,
    );
    const refund = await requireReconcileTxn(
      ctx,
      args.refundTransactionId,
      MARK_MIN_ROLE,
    );

    if (charge.txn.chapterId !== refund.txn.chapterId) {
      throw new ConvexError({
        code: "CROSS_SCOPE_REFUND",
        message:
          "Those rows belong to different books. A refund lands back on the book that paid.",
      });
    }
    if (charge.txn.flow !== "outflow" || refund.txn.flow !== "inflow") {
      throw new ConvexError({
        code: "NOT_A_PAIR",
        message:
          "A refund is one charge going out and one credit coming back — pick one of each.",
      });
    }
    if (charge.txn.amountCents !== refund.txn.amountCents) {
      throw new ConvexError({
        code: "PARTIAL_REFUND",
        message:
          "Only a full refund can be marked — these amounts differ. Leave a partial refund coded as income against the same budget.",
      });
    }
    if ((charge.txn.currency ?? "usd") !== (refund.txn.currency ?? "usd")) {
      throw new ConvexError({
        code: "CURRENCY_MISMATCH",
        message: "Those two rows are in different currencies.",
      });
    }
    for (const leg of [charge.txn, refund.txn]) {
      if (leg.refundsTransactionId != null || leg.refundedByTransactionId != null) {
        throw new ConvexError({
          code: "ALREADY_REFUND",
          message: "One of those rows is already part of a refund.",
        });
      }
      if (leg.transferGroupId != null) {
        throw new ConvexError({
          code: "IS_TRANSFER",
          message:
            "One of those rows is part of a transfer. Un-mark it first if it's really a refund.",
        });
      }
      if (leg.payoutProcessor != null) {
        throw new ConvexError({
          code: "IS_PAYOUT",
          message: "One of those rows is marked as a processor payout.",
        });
      }
    }

    const trimmedNote = args.note?.trim() || null;
    if (trimmedNote && trimmedNote.length > MAX_NOTE_LENGTH) {
      throw new ConvexError({
        code: "NOTE_TOO_LONG",
        message: `A note can't be longer than ${MAX_NOTE_LENGTH} characters.`,
      });
    }

    await ctx.db.patch(charge.txn._id, {
      refundedByTransactionId: refund.txn._id,
      ...(trimmedNote && !charge.txn.note ? { note: trimmedNote } : {}),
    });
    await ctx.db.patch(refund.txn._id, {
      refundsTransactionId: charge.txn._id,
      // Legibility only — an inflow is never spend, so this moves no total.
      ...(charge.txn.categoryId ? { categoryId: charge.txn.categoryId } : {}),
      ...(charge.txn.budgetId ? { budgetId: charge.txn.budgetId } : {}),
      ...(trimmedNote && !refund.txn.note ? { note: trimmedNote } : {}),
    });

    for (const leg of [charge, refund]) {
      await logFinanceAudit(ctx, {
        chapterId: leg.txn.chapterId,
        subjectType: "transaction",
        subjectId: leg.txn._id,
        action: "refund_mark",
        actorPersonId: leg.actorPersonId,
        field: "refund",
        before: "none",
        after: "refunded",
        reason: trimmedNote,
        amountCents: leg.txn.amountCents,
      });
    }
    return null;
  },
});

/**
 * Undo a refund marking, on either row of the pair.
 *
 * Symmetric with `markAsRefund` — the charge goes back to counting as spend
 * against its budget, which is the whole point of being able to reverse it. The
 * category the credit inherited is deliberately LEFT: it was a real coding
 * decision once made, and clearing it would destroy a bookkeeper's work for a
 * total that never moved either way.
 */
export const unmarkRefund = mutation({
  args: { transactionId: v.id("transactions") },
  returns: v.null(),
  handler: async (ctx, { transactionId }) => {
    const { txn, actorPersonId } = await requireReconcileTxn(
      ctx,
      transactionId,
      MARK_MIN_ROLE,
    );
    const otherId = txn.refundedByTransactionId ?? txn.refundsTransactionId;
    if (otherId == null) {
      throw new ConvexError({
        code: "NOT_A_REFUND",
        message: "That row isn't part of a refund.",
      });
    }
    const other = await ctx.db.get(otherId);
    await ctx.db.patch(txn._id, {
      refundedByTransactionId: undefined,
      refundsTransactionId: undefined,
    });
    if (other) {
      await ctx.db.patch(other._id, {
        refundedByTransactionId: undefined,
        refundsTransactionId: undefined,
      });
    }
    await logFinanceAudit(ctx, {
      chapterId: txn.chapterId,
      subjectType: "transaction",
      subjectId: txn._id,
      action: "refund_mark",
      actorPersonId,
      field: "refund",
      before: "refunded",
      after: "none",
      amountCents: txn.amountCents,
    });
    return null;
  },
});

export const markAsTransfer = mutation({
  args: {
    transactionId: v.id("transactions"),
    /** The other side of the same movement. Required — see the doc comment. */
    counterpartTransactionId: v.id("transactions"),
    /** Optional "why", stored on BOTH legs' `note` when they have none. */
    note: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (args.transactionId === args.counterpartTransactionId) {
      throw new ConvexError({
        code: "SAME_TRANSACTION",
        message: "A transfer needs two different rows — pick the other side of the movement.",
      });
    }
    // Authorize each leg at its OWN scope, independently: a caller without
    // reconcile rights on one side must not be able to reach it through the
    // side they do control.
    const a = await requireReconcileTxn(ctx, args.transactionId, MARK_MIN_ROLE);
    const b = await requireReconcileTxn(ctx, args.counterpartTransactionId, MARK_MIN_ROLE);

    // CROSS-BOOK IS ALLOWED WHEN CENTRAL IS ONE SIDE (owner report, 2026-08-07:
    // a $2,873.21 central→New York move made by hand in Increase, ingested as
    // two bank rows, that this refused to mark).
    //
    // The old rule sent every cross-book pair to `transfers.recordTransfer`,
    // which is right for a movement the app is ASKED to make and wrong for one
    // that already happened: `recordTransfer` INSERTS two fresh legs, so using
    // it on a movement the bank feed already delivered leaves four rows for one
    // transfer and books it twice. There was no path at all for "these two
    // EXISTING rows are the movement" across books, which is the ordinary case
    // whenever a treasurer moves money in the bank's own UI.
    //
    // Chapter↔chapter stays refused: every movement in this model routes
    // through central, so a pair with no central leg is two unrelated rows that
    // happen to match, and marking them would invent a crossing that doesn't
    // exist. `transferDirection` is set below for a cross-book pair (the
    // same-scope case still leaves it unset — there's no crossing to name).
    //
    // Book value does NOT move: `signedBookCents` reads `preMarkFlow` before it
    // reads `transferDirection`, so each leg keeps contributing exactly what it
    // did as a raw inflow/outflow. The cash genuinely moved between the two
    // books' accounts, so that is the correct answer — marking only stops the
    // rows demanding a budget and a category they can never have.
    const isCrossBook = a.txn.chapterId !== b.txn.chapterId;
    if (isCrossBook && a.txn.chapterId !== CENTRAL && b.txn.chapterId !== CENTRAL) {
      throw new ConvexError({
        code: "CROSS_SCOPE_TRANSFER",
        message:
          "Those rows belong to two different chapters. A movement between books always goes through Central.",
      });
    }
    for (const leg of [a.txn, b.txn]) {
      if (leg.flow === "transfer") {
        throw new ConvexError({
          code: "ALREADY_TRANSFER",
          message: "One of those rows is already part of a transfer.",
        });
      }
      if (leg.payoutProcessor != null) {
        throw new ConvexError({
          code: "ALREADY_PAYOUT",
          message:
            "One of those rows is marked as a processor payout. Un-mark it first if it's really an internal transfer.",
        });
      }
      if (leg.isPersonal === true) {
        throw new ConvexError({
          code: "IS_PERSONAL",
          message:
            "A personal charge is repaid, not transferred — un-mark it as personal first.",
        });
      }
    }
    // One leg out, one leg in. This is what makes `preMarkFlow` recoverable
    // and is a real guard: two outflows are never one movement.
    const outLeg = a.txn.flow === "outflow" ? a : b.txn.flow === "outflow" ? b : null;
    const inLeg = a.txn.flow === "inflow" ? a : b.txn.flow === "inflow" ? b : null;
    if (!outLeg || !inLeg) {
      throw new ConvexError({
        code: "NOT_A_PAIR",
        message:
          "A transfer is one row leaving an account and one arriving — those two move the same way.",
      });
    }
    if (a.txn.amountCents !== b.txn.amountCents) {
      throw new ConvexError({
        code: "AMOUNT_MISMATCH",
        message:
          "Those two amounts don't match. Pick the row on the other side of the same movement.",
      });
    }
    if ((a.txn.currency ?? "usd") !== (b.txn.currency ?? "usd")) {
      throw new ConvexError({
        code: "CURRENCY_MISMATCH",
        message: "Those two rows are in different currencies.",
      });
    }

    // Reuse the created-pair linkage so a reader that already understands
    // `transferGroupId` sees a marked pair as one movement too. Keyed on the
    // OUTFLOW leg's timestamp so the id reads as "when the money left".
    const groupId = `marked-${outLeg.txn.chapterId}-${outLeg.txn.postedAt}-${crypto.randomUUID().slice(0, 8)}`;
    // Name the crossing, but only when there is one. A same-scope marking
    // deliberately leaves this unset — it's one account moving money to another
    // inside a single book, and there is no central/chapter direction to state.
    const transferDirection = isCrossBook
      ? outLeg.txn.chapterId === CENTRAL
        ? ("central_to_chapter" as const)
        : ("chapter_to_central" as const)
      : undefined;
    const trimmedNote = args.note?.trim() || null;
    if (trimmedNote && trimmedNote.length > MAX_NOTE_LENGTH) {
      throw new ConvexError({
        code: "NOTE_TOO_LONG",
        message: `A note can't be longer than ${MAX_NOTE_LENGTH} characters.`,
      });
    }

    for (const leg of [outLeg, inLeg]) {
      await ctx.db.patch(leg.txn._id, {
        flow: "transfer",
        preMarkFlow: leg.txn.flow as "outflow" | "inflow",
        transferGroupId: groupId,
        ...(transferDirection ? { transferDirection } : {}),
        // Only fill a note that isn't already saying something.
        ...(trimmedNote && !leg.txn.note ? { note: trimmedNote } : {}),
      });
      // Audit BOTH legs — "who reclassified this row, and from what". Founder
      // ask alongside the feature ("we should also have an audit trail"); a
      // marking that silently moved money out of spend totals with no record
      // of who did it is exactly what the log exists to prevent.
      await logFinanceAudit(ctx, {
        chapterId: leg.txn.chapterId,
        subjectType: "transaction",
        subjectId: leg.txn._id,
        action: "transfer_mark",
        actorPersonId: leg.actorPersonId,
        field: "flow",
        before: leg.txn.flow,
        after: "transfer",
        reason: trimmedNote,
        amountCents: leg.txn.amountCents,
      });
    }
    return null;
  },
});

/**
 * Undo a transfer marking, restoring BOTH legs to the `flow` they were
 * ingested with (`preMarkFlow`) and clearing the pair's linkage.
 *
 * Symmetric with `markAsTransfer`: marking is always a pair, so un-marking is
 * too — leaving one leg behind as a lone `flow:"transfer"` row would recreate
 * the exact unexplained-money problem the pairing requirement exists to stop.
 * Refuses on a leg the app CREATED (`source:"transfer"`,
 * `transfers.recordTransfer`): that pair isn't a reclassified bank row and has
 * no ingest flow to restore — reversing it means deleting a booked movement,
 * which is that tool's business, not this one's.
 */
export const unmarkTransfer = mutation({
  args: { transactionId: v.id("transactions") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { txn, actorPersonId } = await requireReconcileTxn(
      ctx,
      args.transactionId,
      MARK_MIN_ROLE,
    );
    if (!isMarkedTransfer(txn)) {
      throw new ConvexError({
        code: "NOT_MARKED_TRANSFER",
        message:
          txn.flow === "transfer"
            ? "That's a recorded transfer, not a marked one — undo it from the Transfers tool."
            : "That row isn't marked as an internal transfer.",
      });
    }
    // Both legs, found through the shared group id.
    const legs = txn.transferGroupId
      ? await ctx.db
          .query("transactions")
          .withIndex("by_transfer_group", (q) =>
            q.eq("transferGroupId", txn.transferGroupId),
          )
          .collect()
      : [txn];
    for (const leg of legs) {
      // Defensive: `isMarkedTransfer` already guarantees `preMarkFlow` on the
      // leg the caller named, but the pair is re-read from the index and a
      // half-written group would otherwise leave a row stuck as a transfer
      // forever. `outflow` is the safe fallback — it puts the row BACK in
      // front of a human (spend, needs budget, owes a receipt) rather than
      // quietly parking it as income nobody reviews.
      const restored = leg.preMarkFlow ?? "outflow";
      await ctx.db.patch(leg._id, {
        flow: restored,
        preMarkFlow: undefined,
        transferGroupId: undefined,
        // Cleared with the rest of the marking. A cross-book marking sets this
        // to name the crossing; leaving it behind on a row that is a plain bank
        // inflow again would have `signedBookCents` resolve a direction for a
        // transfer that no longer exists.
        transferDirection: undefined,
      });
      await logFinanceAudit(ctx, {
        chapterId: leg.chapterId,
        subjectType: "transaction",
        subjectId: leg._id,
        action: "transfer_mark",
        actorPersonId,
        field: "flow",
        before: "transfer",
        after: restored,
        amountCents: leg.amountCents,
      });
    }
    return null;
  },
});

/** The deterministic transfer group id for a MANUAL whole-deposit payout
 *  allocation (`markAsPayout`'s "whose money is this?" — one allocation per
 *  deposit row, ever; the engine's per-item Stripe ids use `payoutalloc-<po>-…`). */
export function manualPayoutAllocationGroupId(
  transactionId: Id<"transactions">,
): string {
  return `payoutalloc-manual-${transactionId}`;
}

/**
 * Mark an inflow as a donation-processor settlement deposit.
 *
 * Single-sided on purpose (founder: "payouts have no other leg to mark").
 * Givebutter/Stripe donations are written to `gifts`, never to `transactions`,
 * so this deposit is the ONLY ledger record of that income — there is no
 * counterpart row to pair it with, and nothing to double-count against.
 *
 * The row stays `flow:"inflow"`. This is a label, not a reclassification: see
 * `PAYOUT_PROCESSORS` (`@events-os/shared`) for why marking a payout as a
 * transfer would delete the org's revenue from every total, and for the
 * reimbursement-payout incident that already proved it once.
 *
 * WHOSE MONEY IS IT? (founder, 2026-08-07: "some Givebutter payouts are for
 * central, and some are for the New York chapter... right now they all go to
 * central"). `allocateToScope` optionally states which BOOK the deposit's
 * money belongs to. The deposit row itself never moves (custody: the bank
 * account it landed in really received it); when the stated book differs
 * from the deposit's own, the mutation books ONE whole-amount transfer pair
 * — `transferOrigin:"payout_allocation"`, deterministic group id, visible
 * and flaggable on the accounts page like the engine's Stripe pairs. One
 * allocation per deposit, ever: changing your mind afterwards is an
 * offsetting transfer (docs/plans/transfers-ops-notes.md), and unmarking is
 * BLOCKED while an allocation pair exists. A deposit the Stripe engine
 * already matched (`stripePayoutId` set) is refused — its contents were
 * allocated item-by-item; a whole-amount pair on top would double-move.
 */
export const markAsPayout = mutation({
  args: {
    transactionId: v.id("transactions"),
    processor: v.union(...PAYOUT_PROCESSORS.map((p) => v.literal(p))),
    // Which book this deposit's money belongs to. Omitted = label only
    // (today's behavior — the money stays where it landed).
    allocateToScope: v.optional(
      v.union(v.id("chapters"), v.literal("central")),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { txn, actorPersonId } = await requireReconcileTxn(
      ctx,
      args.transactionId,
      MARK_MIN_ROLE,
    );
    if (txn.flow !== "inflow") {
      throw new ConvexError({
        code: "NOT_AN_INFLOW",
        message:
          "A payout is money arriving — only an inflow can be marked as one.",
      });
    }
    const before = txn.payoutProcessor ?? null;
    if (before !== args.processor) {
      await ctx.db.patch(args.transactionId, { payoutProcessor: args.processor });
      await logFinanceAudit(ctx, {
        chapterId: txn.chapterId,
        subjectType: "transaction",
        subjectId: args.transactionId,
        action: "payout_mark",
        actorPersonId,
        field: "payoutProcessor",
        before: before ? PAYOUT_PROCESSOR_LABELS[before] : null,
        after: PAYOUT_PROCESSOR_LABELS[args.processor],
        amountCents: txn.amountCents,
      });
    }

    // ── Optional whole-deposit book allocation ──────────────────────────────
    if (args.allocateToScope == null || args.allocateToScope === txn.chapterId) {
      return null; // label only, or the money already sits on the stated book
    }
    if (txn.stripePayoutId != null) {
      throw new ConvexError({
        code: "ENGINE_ALLOCATED",
        message:
          "The reconciliation engine already allocated this Stripe payout item-by-item — a whole-deposit allocation on top would double-move the money. Record a manual transfer for any correction instead.",
      });
    }
    // Exactly one side of the pair must be central (the transfer model is
    // central↔chapter; a chapter→chapter deposit reassignment isn't a thing
    // the ledger can express today).
    let chapterSide: Id<"chapters">;
    let direction: TransferDirection;
    if (txn.chapterId === CENTRAL && args.allocateToScope !== CENTRAL) {
      chapterSide = args.allocateToScope;
      direction = "central_to_chapter";
    } else if (txn.chapterId !== CENTRAL && args.allocateToScope === CENTRAL) {
      chapterSide = txn.chapterId;
      direction = "chapter_to_central";
    } else {
      throw new ConvexError({
        code: "UNSUPPORTED_ALLOCATION",
        message:
          "A payout can be allocated between central and a chapter, not from one chapter to another.",
      });
    }
    const chapter = await ctx.db.get(chapterSide);
    if (!chapter) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Chapter not found." });
    }
    const userId = (await requireUserId(ctx)) as Id<"users">;
    try {
      await recordTransferPair(ctx, {
        ...transferScopes(chapterSide, direction),
        amountCents: txn.amountCents,
        transferGroupId: manualPayoutAllocationGroupId(args.transactionId),
        postedAt: txn.postedAt,
        note: `Manual: ${PAYOUT_PROCESSOR_LABELS[args.processor]} payout allocated to ${
          args.allocateToScope === CENTRAL ? "Central" : chapter.name
        }`,
        transferDirection: direction,
        transferOrigin: "payout_allocation",
        userId,
      });
    } catch (err) {
      if (err instanceof ConvexError && err.data?.code === "ALREADY_RECORDED") {
        throw new ConvexError({
          code: "ALREADY_ALLOCATED",
          message:
            "This deposit was already allocated to a book. To change it, record an offsetting transfer (see the transfers ops notes).",
        });
      }
      throw err;
    }
    return null;
  },
});

/** Undo a payout marking. The row was never moved out of inflow, so this only
 *  clears the label — no totals change either way. */
export const unmarkPayout = mutation({
  args: { transactionId: v.id("transactions") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { txn, actorPersonId } = await requireReconcileTxn(
      ctx,
      args.transactionId,
      MARK_MIN_ROLE,
    );
    const before = txn.payoutProcessor ?? null;
    if (!before) {
      throw new ConvexError({
        code: "NOT_MARKED_PAYOUT",
        message: "That row isn't marked as a processor payout.",
      });
    }
    // A deposit whose money was ALLOCATED to a book keeps its label: silently
    // unmarking would leave the whole-amount allocation pair dangling with no
    // visible reason it exists. The fix path is an offsetting transfer first
    // (docs/plans/transfers-ops-notes.md).
    const allocationLegs = await transferPairLegs(
      ctx,
      manualPayoutAllocationGroupId(args.transactionId),
    );
    if (allocationLegs.length > 0) {
      throw new ConvexError({
        code: "ALLOCATED_PAYOUT",
        message:
          "This payout's money was allocated to a book — record an offsetting transfer before unmarking it (see the transfers ops notes).",
      });
    }
    await ctx.db.patch(args.transactionId, { payoutProcessor: undefined });
    await logFinanceAudit(ctx, {
      chapterId: txn.chapterId,
      subjectType: "transaction",
      subjectId: args.transactionId,
      action: "payout_mark",
      actorPersonId,
      field: "payoutProcessor",
      before: PAYOUT_PROCESSOR_LABELS[before],
      after: null,
      amountCents: txn.amountCents,
    });
    return null;
  },
});

/**
 * CORRECT a manually-entered transaction — its amount, date, merchant or
 * description.
 *
 * Exists because a large slice of the ledger was reconstructed by an agent
 * reading historical CSVs and Notion exports, and it got things wrong (owner,
 * 2026-08-05). Before this there was NO edit path for those fields on any
 * transaction — not a restricted one, an absent one — so the only way to fix a
 * wrong amount was to exclude the row and re-create it, which severs the audit
 * thread at exactly the moment you most want it.
 *
 * WHAT IT WILL NOT TOUCH: anything that came from a bank feed, and either leg
 * of a paired system record. `lib/financeEditAccess.ts` owns that rule and
 * refuses with `NOT_CORRECTABLE` before it even looks at the caller's role —
 * see its module doc for why that ordering matters.
 *
 * EVERY FIELD CHANGE IS LOGGED, before → after, to `financeAuditLog`. These
 * rows are going to be published, and "we corrected our history" has to be
 * distinguishable from "we quietly changed our history" — that distinction is
 * most of what publishing is worth. It's also the answer when a backer asks why
 * a row says $445 when some document said $455.
 *
 * A `reason` is REQUIRED. A correction with no stated why is indistinguishable
 * from a typo in the other direction.
 */
export const correctTransaction = mutation({
  args: {
    transactionId: v.id("transactions"),
    amountCents: v.optional(v.number()),
    postedAt: v.optional(v.number()),
    merchantName: v.optional(v.union(v.string(), v.null())),
    description: v.optional(v.union(v.string(), v.null())),
    reason: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { txn, scope, actorPersonId } = await requireCorrectTransaction(
      ctx,
      args.transactionId,
    );
    const reason = args.reason.trim();
    if (!reason) {
      throw new ConvexError({
        code: "REASON_REQUIRED",
        message:
          "Say what you're correcting and why — this row is published, and the trail is what makes a correction different from a quiet edit.",
      });
    }
    // The house invariant: direction rides on `flow`, never on a sign. A
    // negative amount here would silently invert every rollup this row feeds.
    if (args.amountCents !== undefined && args.amountCents < 0) {
      throw new ConvexError({
        code: "INVALID_AMOUNT",
        message: "Enter the amount as a positive number — inflow or outflow is set by the row's direction, not by a minus sign.",
      });
    }
    if (args.postedAt !== undefined && !Number.isFinite(args.postedAt)) {
      throw new ConvexError({
        code: "INVALID_DATE",
        message: "That date isn't valid.",
      });
    }

    const patch: Record<string, unknown> = {};
    const entries: { field: string; before: string; after: string }[] = [];
    const money = (cents: number) => formatCents(cents);
    const day = (ms: number) =>
      new Date(ms).toLocaleDateString("en-US", {
        month: "short",
        day: "2-digit",
        year: "numeric",
        timeZone: "America/New_York",
      });

    if (args.amountCents !== undefined && args.amountCents !== txn.amountCents) {
      patch.amountCents = args.amountCents;
      entries.push({
        field: "amount",
        before: money(txn.amountCents),
        after: money(args.amountCents),
      });
    }
    if (args.postedAt !== undefined && args.postedAt !== txn.postedAt) {
      patch.postedAt = args.postedAt;
      entries.push({
        field: "date",
        before: day(txn.postedAt),
        after: day(args.postedAt),
      });
    }
    if (
      args.merchantName !== undefined &&
      (args.merchantName ?? null) !== (txn.merchantName ?? null)
    ) {
      patch.merchantName = args.merchantName?.trim() || undefined;
      entries.push({
        field: "merchant",
        before: txn.merchantName ?? "—",
        after: args.merchantName?.trim() || "—",
      });
    }
    if (
      args.description !== undefined &&
      (args.description ?? null) !== (txn.description ?? null)
    ) {
      patch.description = args.description?.trim() || undefined;
      entries.push({
        field: "description",
        before: txn.description ?? "—",
        after: args.description?.trim() || "—",
      });
    }

    // A no-op correction writes nothing — an audit trail of "changed X to X"
    // is noise that makes the real corrections harder to find.
    if (entries.length === 0) return null;

    await ctx.db.patch(args.transactionId, patch);
    // An approved exception snapshots the amount it was filed against, and the
    // separation-of-duties threshold is checked against that snapshot — so a
    // changed amount must invalidate it, or a self-approved $5 attestation
    // could be stretched over a $5,000 charge. See
    // `retireApprovedExceptionOnAmountChange` for the full reasoning.
    if (patch.amountCents !== undefined) {
      const retired = await retireApprovedExceptionOnAmountChange(
        ctx,
        args.transactionId,
      );
      if (retired) {
        await logFinanceAudit(ctx, {
          chapterId: scope,
          subjectType: "transaction",
          subjectId: args.transactionId,
          action: "receipt_exception_withdraw",
          actorPersonId,
          field: "receiptException",
          before: "Approved",
          after: "Withdrawn — amount corrected, re-file at the true amount",
          reason,
          amountCents: patch.amountCents as number,
        });
      }
    }
    // ONE audit row per field, so a two-field correction reads as two facts
    // rather than one blob — matching how `logRecodeAudit` already splits
    // category and budget.
    for (const entry of entries) {
      await logFinanceAudit(ctx, {
        chapterId: scope,
        subjectType: "transaction",
        subjectId: args.transactionId,
        action: "correction",
        actorPersonId,
        field: entry.field,
        before: entry.before,
        after: entry.after,
        reason,
        amountCents: patch.amountCents as number | undefined ?? txn.amountCents,
      });
    }
    return null;
  },
});

// ── Merchant rename (a readable name, never an overwrite) ────────────────────
/**
 * RENAME a transaction's merchant to something a human would recognize —
 * "Costco" for `IC* COSTCO BY IN CAR`, "Amazon" for `AMAZON MKTPL*56OXD2TB2`,
 * "Amazon (return)" for `Return from AMAZON.COM | Address: SEATTLE, WA, US |
 * **8728`. Owner ask (finance owner, 2026-08-08): "there should be a way to
 * edit these merchant names inline, and then once it's edited, it keeps a
 * trail of all the things it used to be called."
 *
 * THE PROVIDER'S VALUE IS NEVER TOUCHED. This writes `merchantNameOverride`
 * and nothing else; `merchantName` and `description` are what the bank or
 * processor actually sent, and that is provenance we don't get to destroy.
 * Two properties fall out of that for free rather than having to be enforced:
 * an auditor asking "what did the statement say" can always get the original
 * back, and a rename can never launder a row into looking like a different
 * charge, because the original is still sitting right there in the row and in
 * the trail. Un-naming is `clearMerchantRename` below — dropping the override,
 * not restoring a copy of something we overwrote.
 *
 * This is why it is a separate mutation from `correctTransaction` rather than
 * a relaxation of it. That one really does rewrite `merchantName`, which is
 * exactly why it is manager-only and refuses every non-`manual` row: a
 * hand-entered row is a standalone human assertion with no provider claim to
 * preserve. A rename makes no claim about what happened — only about what to
 * call it — so it is safe on the bank-fed rows a correction must never touch,
 * and it needs no `reason`: the before → after IS the explanation.
 *
 * ENGINE-WRITTEN ROWS ARE RENAMEABLE, deliberately. Some rows in this column
 * are not merchants at all — they are sentences the reconciliation engine
 * wrote into `description` ("Auto: settlement of cross-book card spend through
 * 2026-08-07", "Manual: Givebutter payout allocated to New York"), which
 * surface in the merchant slot only because it falls back to `description`
 * when there is no merchant. Renaming one is allowed because, structurally, it
 * cannot cost anything: the override fills an EMPTY merchant slot rather than
 * replacing the sentence, and that sentence — which for a transfer leg is the
 * whole audit trail of how the number was computed — stays untouched in
 * `description` and `note`, still rendered in the transaction detail modal.
 * A treasurer gets a scannable "Aug settlement — NY" in the grid without the
 * arithmetic going anywhere. Refusing the rename here would have protected
 * nothing and only made the column's worst rows the ones that can't be fixed.
 *
 * ACCESS: `requireReconcileTxn(..., MARK_MIN_ROLE)` — the same bookkeeper+,
 * scope-aware gate every other reclassification on this grid uses. Naming a
 * charge is bookkeeping. A read-only viewer (peek included) is refused by that
 * gate, not by anything special here.
 *
 * The trail goes to `financeAuditLog` like every other finance field change —
 * one table every finance surface writes to, so "who changed what" is one
 * question with one answer rather than a per-feature history store. The FIRST
 * rename's `before` is the PROVIDER's own name (`providerMerchantName`), so
 * the trail's opening line always names what the statement said instead of a
 * bare "—".
 */
export const renameMerchant = mutation({
  args: {
    transactionId: v.id("transactions"),
    /** The readable name. Trimmed; blank is rejected — clearing a rename is
     *  `clearMerchantRename`, an explicit act with its own audit row, not an
     *  empty string quietly meaning something different. */
    merchantName: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { txn, actorPersonId } = await requireReconcileTxn(
      ctx,
      args.transactionId,
      MARK_MIN_ROLE,
    );
    const next = args.merchantName.trim();
    if (!next) {
      throw new ConvexError({
        code: "MERCHANT_NAME_REQUIRED",
        message:
          "Give the merchant a name. To go back to what the bank called it, clear the rename instead.",
      });
    }
    if (next.length > MAX_MERCHANT_NAME_LENGTH) {
      throw new ConvexError({
        code: "MERCHANT_NAME_TOO_LONG",
        message: `A merchant name can't be longer than ${MAX_MERCHANT_NAME_LENGTH} characters.`,
      });
    }
    const before = txn.merchantNameOverride ?? null;
    // A no-op rename writes nothing — a trail of "renamed X to X" is noise
    // that makes the real renames harder to find (same rule
    // `correctTransaction` and `setTransactionNote` apply).
    if (before === next) return null;

    await ctx.db.patch(args.transactionId, {
      merchantNameOverride: next,
      merchantNameRenamedAt: Date.now(),
    });
    await logFinanceAudit(ctx, {
      chapterId: txn.chapterId,
      subjectType: "transaction",
      subjectId: args.transactionId,
      action: "merchant_rename",
      actorPersonId,
      field: "merchant",
      // On the FIRST rename there is no prior override, and "—" would be a
      // lie: the row was called something, by the bank. Naming the provider's
      // own string here is what makes the trail readable end to end — "it was
      // initially called this, then renamed to this by this person."
      before: before ?? providerMerchantName(txn),
      after: next,
      amountCents: txn.amountCents,
    });
    return null;
  },
});

/**
 * Drop a rename and let the provider's own name show through again.
 *
 * Nothing is "restored" — the provider's value was never overwritten, so this
 * only removes the override that was sitting in front of it. That is the whole
 * point of storing the rename separately.
 *
 * `merchantNameRenamedAt` is deliberately NOT cleared: the trail outlives the
 * override, and a row that was renamed and then un-renamed still has a history
 * worth reading, so it keeps its history affordance in the grid.
 */
export const clearMerchantRename = mutation({
  args: { transactionId: v.id("transactions") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { txn, actorPersonId } = await requireReconcileTxn(
      ctx,
      args.transactionId,
      MARK_MIN_ROLE,
    );
    const before = txn.merchantNameOverride ?? null;
    if (before == null) {
      throw new ConvexError({
        code: "NOT_RENAMED",
        message: "That row hasn't been renamed.",
      });
    }
    await ctx.db.patch(args.transactionId, {
      merchantNameOverride: undefined,
      merchantNameRenamedAt: Date.now(),
    });
    await logFinanceAudit(ctx, {
      chapterId: txn.chapterId,
      subjectType: "transaction",
      subjectId: args.transactionId,
      action: "merchant_rename",
      actorPersonId,
      field: "merchant",
      before,
      // Where the name lands, which is the provider's own value — spelled out
      // rather than left null so the trail reads as a real transition instead
      // of "renamed to nothing".
      after: providerMerchantName(txn),
      amountCents: txn.amountCents,
    });
    return null;
  },
});

/**
 * R1a — set (or clear) a transaction's freeform note: "who was this for and
 * why" (the business/mission justification budget + category alone don't
 * capture). Bookkeeper+ (scope-aware `requireReconcileTxn`) keeps its
 * existing, unchanged reach; a caller with EVENT EDIT rights on the txn's own
 * event may also note it (`requireTxnNoteReceiptCategoryAccess` — see its own
 * doc comment). `null` (or an all-whitespace string) clears the note;
 * anything else is trimmed and capped at `MAX_NOTE_LENGTH`.
 */
export const setTransactionNote = mutation({
  args: { transactionId: v.id("transactions"), note: v.union(v.string(), v.null()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { txn, actorPersonId } = await requireTxnNoteReceiptCategoryAccess(
      ctx,
      args.transactionId,
    );
    const trimmed = args.note?.trim() || null;
    if (trimmed && trimmed.length > MAX_NOTE_LENGTH) {
      throw new ConvexError({
        code: "NOTE_TOO_LONG",
        message: `A note can't be longer than ${MAX_NOTE_LENGTH} characters.`,
      });
    }
    await ctx.db.patch(args.transactionId, { note: trimmed ?? undefined });
    // financeAuditLog (note_edit) — skip a true no-op (unchanged note).
    const beforeNote = txn.note ?? null;
    if (beforeNote !== trimmed) {
      await logFinanceAudit(ctx, {
        chapterId: txn.chapterId,
        subjectType: "transaction",
        subjectId: args.transactionId,
        action: "note_edit",
        actorPersonId,
        field: "note",
        before: beforeNote,
        after: trimmed,
        amountCents: txn.amountCents,
      });
    }
    return null;
  },
});

/**
 * CATEGORY-ONLY edit — deliberately NARROWER than `categorizeTransaction`
 * (which also reattributes `fundId`/`teamId`/`budgetId`). Same combined gate
 * as `setTransactionNote` above (bookkeeper+'s existing power, OR event-edit
 * rights on the txn's own event) — but this mutation can NEVER touch
 * anything but `categoryId`, so the event-lead carve-out can never reach
 * fund/team/budget/amount/status through it, by construction (there's no arg
 * for any of those). Finance ranks already have the fuller
 * `categorizeTransaction` for bulk attribution; this is an additional,
 * narrower tool that happens to also serve them, not a replacement.
 *
 * RECONCILED LOCK (owner: "they still need to get their things reconciled by
 * their treasurer or financial manager", product call on PR #218's review):
 * once a transaction is `status:"reconciled"`, the event-lead carve-out may
 * NOT re-categorize or clear its category — the Treasurer has closed it, and
 * reopening a reconciled row is bookkeeper+ territory (`categorizeTransaction`
 * still allows it, unchanged). Bookkeeper+ callers here are UNAFFECTED by
 * this lock — only the event-lead path checks it.
 */
export const setTransactionCategory = mutation({
  args: {
    transactionId: v.id("transactions"),
    categoryId: v.union(v.id("budgetCategories"), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { txn, viaFinance, actorPersonId } = await requireTxnNoteReceiptCategoryAccess(
      ctx,
      args.transactionId,
    );
    if (!viaFinance && txn.status === "reconciled") {
      throw new ConvexError({
        code: "RECONCILED_LOCKED",
        message:
          "This transaction is closed by your treasurer — ask them to reopen it before changing its category.",
      });
    }
    if (args.categoryId) {
      // Central txns carry no chapter-scoped category (mirrors
      // `categorizeTransaction`'s own central branch).
      if (txn.chapterId === CENTRAL) {
        throw new ConvexError({
          code: "UNSUPPORTED",
          message: "A central transaction can't be given a chapter-scoped category.",
        });
      }
      await requireInCallerChapter(
        ctx,
        txn.chapterId,
        "budgetCategories",
        args.categoryId,
        "Category",
      );
    }
    const patch: Record<string, unknown> = { categoryId: args.categoryId ?? undefined };
    // Advance unreviewed -> categorized the same way `categorizeTransaction`
    // does when a category makes the txn "coded".
    if (args.categoryId && txn.status === "unreviewed") patch.status = "categorized";
    await ctx.db.patch(args.transactionId, patch);
    // financeAuditLog (recode) — shares `categorizeTransaction`'s helper so
    // both attribution-change paths log identically; this mutation only ever
    // touches `categoryId`, so `budgetChanged` is always false.
    await logRecodeAudit(ctx, {
      txn,
      scope: txn.chapterId,
      actorPersonId,
      categoryChanged: true,
      budgetChanged: false,
      beforeCategoryId: txn.categoryId ?? null,
      afterCategoryId: args.categoryId,
      beforeBudgetId: null,
      afterBudgetId: null,
    });
    return null;
  },
});

/**
 * CARDHOLDER SELF-SERVICE ("Concur-style" pre-fill) — the cardholder who OWNS
 * a card charge sets its spend `categoryId` and a freeform `note` (the who/why
 * explanation), and optionally flags it personal, to PRE-FILL the bookkeeper's
 * Reconcile review before they ever see the row.
 *
 * Deliberately far NARROWER than `categorizeTransaction` (bookkeeper-gated,
 * reattributes fund/team/budget): this path can ONLY touch `categoryId` and
 * `note` of the caller's OWN charge — never `fundId`/`teamId`/`budgetId`/
 * `amountCents`, and `status` only via the same unreviewed→categorized advance
 * the reconcile paths do. It is NOT finance-role gated (a bookkeeper already
 * has `categorizeTransaction`; this is additive for a plain member).
 *
 * AUTH mirrors `cards.flagPersonalCharge`'s cardholder check: the caller must
 * be the `cardholderPersonId` of the charge's card (get card → cardholder →
 * compare to the caller's finance `access.personId`). Only a card charge
 * (`cardId` set) owned by the caller qualifies — anything else is
 * NOT_A_CARD_CHARGE / FORBIDDEN.
 *
 * RECONCILED LOCK: a `status:"reconciled"` row is refused (the Treasurer has
 * closed it) — the same precedent `setTransactionCategory` documents for its
 * event-lead path. The personal flag REUSES `cards`'s shared
 * `convertChargeToPersonalRepayment` (no duplicate `personalRepayments`
 * insert) and is idempotent.
 */
export const submitOwnCharge = mutation({
  args: {
    transactionId: v.id("transactions"),
    // `undefined` leaves the field unchanged; `null` clears it; an id sets it
    // (a spend category in the CALLER's own chapter).
    categoryId: v.optional(v.union(v.id("budgetCategories"), v.null())),
    note: v.optional(v.union(v.string(), v.null())),
    flagPersonal: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    const access = await getFinanceRole(ctx, chapterId);

    const txn = (await ctx.db.get(args.transactionId)) as Doc<"transactions"> | null;
    if (!txn || txn.chapterId !== chapterId) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Transaction not found in your chapter.",
      });
    }
    if (!txn.cardId) {
      throw new ConvexError({
        code: "NOT_A_CARD_CHARGE",
        message: "Only a card charge can be submitted this way.",
      });
    }
    const card = await ctx.db.get(txn.cardId);
    if (!card || card.chapterId !== chapterId) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Card not found in your chapter.",
      });
    }
    // Auth: the cardholder themselves ONLY (mirrors `flagPersonalCharge`'s
    // `isCardholder`) — this is the member's own-charge surface, not a
    // manager tool. A bookkeeper reattributes via `categorizeTransaction`.
    const isCardholder =
      access.personId != null && access.personId === card.cardholderPersonId;
    if (!isCardholder) {
      throw new ConvexError({
        code: "FORBIDDEN",
        message: "Only the cardholder can submit details for this charge.",
      });
    }
    // RECONCILED LOCK: the Treasurer has closed this row.
    if (txn.status === "reconciled") {
      throw new ConvexError({
        code: "RECONCILED_LOCKED",
        message:
          "This charge is closed by your treasurer — ask them to reopen it before changing it.",
      });
    }

    const patch: {
      categoryId?: Id<"budgetCategories">;
      note?: string;
      status?: "categorized";
    } = {};
    if (args.categoryId !== undefined) {
      if (args.categoryId) {
        // Category must belong to the caller's OWN chapter (never central, never
        // another chapter's) — the same verify pattern the reconcile paths use.
        await requireInCallerChapter(
          ctx,
          chapterId,
          "budgetCategories",
          args.categoryId,
          "Category",
        );
        patch.categoryId = args.categoryId;
      } else {
        patch.categoryId = undefined; // clear
      }
    }
    if (args.note !== undefined) {
      const trimmed = args.note?.trim() || null;
      if (trimmed && trimmed.length > MAX_NOTE_LENGTH) {
        throw new ConvexError({
          code: "NOTE_TOO_LONG",
          message: `A note can't be longer than ${MAX_NOTE_LENGTH} characters.`,
        });
      }
      patch.note = trimmed ?? undefined;
    }
    // Advance unreviewed → categorized once a category makes the row "coded" —
    // the SAME (and only) status transition `categorizeTransaction`/
    // `setTransactionCategory` do; never any other.
    const nextCategoryId = "categoryId" in patch ? patch.categoryId : txn.categoryId;
    if (nextCategoryId && txn.status === "unreviewed") patch.status = "categorized";
    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(args.transactionId, patch);
    }

    // Optional personal flag — REUSE the shared conversion core (no duplicate
    // `personalRepayments` insert). Idempotent: re-submitting an already
    // personal charge is a no-op. Re-read so the helper sees the patch above.
    if (args.flagPersonal === true) {
      const fresh = (await ctx.db.get(args.transactionId)) as Doc<"transactions">;
      await convertChargeToPersonalRepayment(ctx, fresh, card.cardholderPersonId);
    }
    return null;
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// WP-2.2 — Bulk reattribution + audit trail (the split's execution tool)
//
// The retroactive split (Phase 2) moves ~239 historical transactions — and the
// music/recording project's whole money loop — across the central boundary. The
// tools below EXECUTE that division: `reassignTransactions` moves a human-
// confirmed batch of txns; `transferProjectScope` moves a project's budgets +
// txns as one unit; `suggestSplitAssignments` buckets a chapter's history per
// the playbook boundary rules (SUGGESTIONS ONLY — a human confirms the ids);
// every bulk write appends one `reattributionAudit` row.
//
// INVARIANTS held here: reassignment never touches `amountCents`/`flow` (money
// is unchanged — only WHERE it belongs); attribution is explicit-only (we clear
// links, never derive new ones); central power is gated (central reach + the
// bookkeeper WRITE rank — a central viewer is blocked like a chapter viewer);
// every bulk write is audited; failures are `ConvexError`.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Gate a CENTRAL bulk-write operation: central reach AND at least the `min`
 * write rank. `requireFinanceCentral` alone only checks REACH (any central
 * grant, including a viewer-only one), so — exactly like `requireReconcileTxn`
 * (#151) — we additionally clear the role rank so a central VIEWER can't perform
 * a write that a chapter viewer is correctly blocked from. Returns the caller's
 * roster person (may be null for a superuser without a `people` row) + userId.
 */
async function requireCentralWrite(
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
type ReattributionPriorState = {
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
function snapshotPriorState(txn: Doc<"transactions">): ReattributionPriorState {
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
async function computeReassignmentPatch(
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
async function financeScopeName(ctx: QueryCtx, scope: FinanceScope): Promise<string> {
  if (scope === CENTRAL) return "Central";
  const chapter = await ctx.db.get(scope);
  return chapter?.name ?? "Unknown chapter";
}

/** A `"New York (12), Central (1) → Central"` from→to summary for the audit. */
async function buildReassignSummary(
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

const reattributionTargetValidator = v.union(v.id("chapters"), v.literal(CENTRAL));

export const reassignTransactions = mutation({
  args: {
    transactionIds: v.array(v.id("transactions")),
    // The destination scope: a real chapter, or the central sentinel.
    target: reattributionTargetValidator,
    note: v.optional(v.string()),
  },
  returns: v.object({
    updated: v.number(),
    // Selected txns already at `target` — real no-ops, excluded from `updated`
    // and the audit row so summaries reflect only actual reattributions.
    skippedSameScope: v.number(),
    auditId: v.id("reattributionAudit"),
  }),
  handler: async (ctx, args) => {
    // Reassignment across the central boundary is a CENTRAL power.
    const { personId, userId } = await requireCentralWrite(ctx, "bookkeeper");

    if (args.transactionIds.length === 0) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "Select at least one transaction to reassign.",
      });
    }
    if (args.transactionIds.length > REASSIGN_BATCH_CAP) {
      throw new ConvexError({
        code: "BATCH_TOO_LARGE",
        message: `Reassign at most ${REASSIGN_BATCH_CAP} transactions per call — the grid paginates larger runs.`,
      });
    }
    // De-dup so a doubled selection can't be counted or patched twice.
    const ids = [...new Set(args.transactionIds)];

    if (args.target !== CENTRAL) {
      const chapter = await ctx.db.get(args.target);
      if (!chapter) {
        throw new ConvexError({ code: "NOT_FOUND", message: "Target chapter not found." });
      }
    }

    const sourceCounts = new Map<FinanceScope, number>();
    const priorStates: ReattributionPriorState[] = [];
    const movedIds: Id<"transactions">[] = [];
    let updated = 0;
    let skippedSameScope = 0;
    for (const id of ids) {
      const txn = (await ctx.db.get(id)) as Doc<"transactions"> | null;
      if (!txn) {
        throw new ConvexError({
          code: "NOT_FOUND",
          message: "One of the selected transactions no longer exists.",
        });
      }
      if (txn.chapterId === args.target) {
        // Already at the destination — not a real move; keep it out of the
        // audit trail (it never crossed a boundary, so there's nothing to undo).
        skippedSameScope++;
        continue;
      }
      const from = txn.chapterId as FinanceScope;
      sourceCounts.set(from, (sourceCounts.get(from) ?? 0) + 1);
      priorStates.push(snapshotPriorState(txn));
      const patch = await computeReassignmentPatch(ctx, txn, args.target);
      await ctx.db.patch(id, patch);
      movedIds.push(id);
      updated++;
    }

    const summary = await buildReassignSummary(ctx, sourceCounts, args.target);
    const auditId = await ctx.db.insert("reattributionAudit", {
      kind: "bulk_reassign",
      actorUserId: userId,
      ...(personId ? { actorPersonId: personId } : {}),
      transactionIds: movedIds,
      target: args.target,
      summary,
      priorStates,
      ...(args.note ? { note: args.note } : {}),
      createdAt: Date.now(),
    });
    return { updated, skippedSameScope, auditId };
  },
});

/**
 * Move a budget's scope as part of a project transfer. Central budgets carry no
 * chapter-scoped narrowers, so → central clears fund/category/team; → chapter
 * rebases the fund default and drops the source category/team. The budget↔tag
 * links get their denormalized `chapterId` updated, and a link whose tag is
 * invalid at the new level (a chapter tag on a central budget) is dropped.
 *
 * A WP-3.1 `budgetLines` row's own `categoryId` is chapter-scoped the same way
 * the budget's is (`budgetLines.ts#verifyCategory`) — a category from the
 * source chapter's tree is meaningless (or invalid) at the new scope, so it's
 * cleared on every line too. `description`/`plannedCents` are untouched — the
 * PLAN survives the move, only the stale chapter-scoped ref does not.
 *
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
async function transferRefScope(
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

export const transferProjectScope = mutation({
  args: {
    projectId: v.id("projects"),
    target: reattributionTargetValidator,
    note: v.optional(v.string()),
  },
  returns: v.object({
    budgetsMoved: v.number(),
    txnsMoved: v.number(),
    auditId: v.id("reattributionAudit"),
    // The projects table has no central scope / chapterId union yet (WP-2.2
    // finding): the project ROW stays chapter-scoped — only its money moved.
    projectScopeDeferred: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const actor = await requireCentralWrite(ctx, "bookkeeper");
    const project = await ctx.db.get(args.projectId);
    if (!project) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Project not found." });
    }
    if (args.target !== CENTRAL) {
      const chapter = await ctx.db.get(args.target);
      if (!chapter) {
        throw new ConvexError({ code: "NOT_FOUND", message: "Target chapter not found." });
      }
    }
    const { budgetsMoved, txnsMoved, auditId } = await transferRefScope(ctx, {
      refKind: "project",
      refId: args.projectId,
      refLabel: `Project "${project.name}"`,
      sourceScope: project.chapterId as FinanceScope,
      target: args.target,
      note: args.note,
      actor,
    });
    return { budgetsMoved, txnsMoved, auditId, projectScopeDeferred: true };
  },
});

/**
 * The event twin of `transferProjectScope` — same central-bookkeeper+ gate,
 * same `by_ref`-driven budget+transaction move, same one-audit-row trail
 * (`transferRefScope` above is the shared engine). The event ROW stays
 * chapter-scoped either way (`eventScopeDeferred: true`, always) — WP-2.2's
 * "no central union on the ref row" finding applies identically to events
 * (`schema/events.ts#chapterId` is a strict `v.id("chapters")`).
 *
 * NO-BUDGET EVENTS (design choice, owner spec item 5): a Training event
 * (`isTraining`) never gets a budget row by invariant (see `events.ts#get`'s
 * doc comment / `createEventBudget`'s callers), and an operational event with
 * no dollar amount entered yet also has none. Rather than a hard error, this
 * NO-OPS SANELY — `refBudgets` comes back empty, `budgetsMoved`/`txnsMoved`
 * are both `0`, and a single audit row is still written (mirrors
 * `transferProjectScope`'s existing behavior for a budget-less project
 * exactly; there was never a special case for "zero budgets found" before
 * this feature, so events don't invent one either). The "Belongs to" row
 * still flips immediately (`events.get`'s `scope` reads whichever chapter a
 * FUTURE budget would land in — see that query's doc comment), so a
 * coordinator who sets the scope before entering a dollar amount gets the
 * behavior they'd expect.
 */
export const transferEventScope = mutation({
  args: {
    eventId: v.id("events"),
    target: reattributionTargetValidator,
    note: v.optional(v.string()),
  },
  returns: v.object({
    budgetsMoved: v.number(),
    txnsMoved: v.number(),
    auditId: v.id("reattributionAudit"),
    eventScopeDeferred: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const actor = await requireCentralWrite(ctx, "bookkeeper");
    const event = await ctx.db.get(args.eventId);
    if (!event) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Event not found." });
    }
    if (args.target !== CENTRAL) {
      const chapter = await ctx.db.get(args.target);
      if (!chapter) {
        throw new ConvexError({ code: "NOT_FOUND", message: "Target chapter not found." });
      }
    }
    const { budgetsMoved, txnsMoved, auditId } = await transferRefScope(ctx, {
      refKind: "event",
      refId: args.eventId,
      refLabel: `Event "${event.name}"`,
      sourceScope: event.chapterId as FinanceScope,
      target: args.target,
      note: args.note,
      actor,
    });
    return { budgetsMoved, txnsMoved, auditId, eventScopeDeferred: true };
  },
});

// ── Rule-assisted split suggestions (central-gated; SUGGESTIONS ONLY) ─────────
const splitSuggestionRow = v.object({
  id: v.id("transactions"),
  amountCents: v.number(),
  flow: flowValidator,
  postedAt: v.number(),
  description: v.union(v.string(), v.null()),
  merchantName: v.union(v.string(), v.null()),
  // Why the rules bucketed this txn where they did (shown to the human).
  reason: v.string(),
});

export const suggestSplitAssignments = query({
  args: { chapterId: v.id("chapters") },
  returns: v.object({
    central: v.array(splitSuggestionRow),
    chapter: v.array(splitSuggestionRow),
    unassigned: v.array(splitSuggestionRow),
    // The chapter's projects with a per-project scope suggestion, so the UI can
    // let a human override the music-project-is-central heuristic per project.
    projects: v.array(
      v.object({
        id: v.id("projects"),
        name: v.string(),
        suggested: v.union(v.literal("central"), v.literal("chapter")),
        txnCount: v.number(),
      }),
    ),
    counts: v.object({
      central: v.number(),
      chapter: v.number(),
      unassigned: v.number(),
    }),
  }),
  handler: async (ctx, args) => {
    const empty = {
      central: [] as (typeof splitSuggestionRow.type)[],
      chapter: [] as (typeof splitSuggestionRow.type)[],
      unassigned: [] as (typeof splitSuggestionRow.type)[],
      projects: [] as {
        id: Id<"projects">;
        name: string;
        suggested: "central" | "chapter";
        txnCount: number;
      }[],
      counts: { central: 0, chapter: 0, unassigned: 0 },
    };
    const homeChapterId = await readChapterId(ctx);
    if (!homeChapterId) return empty;
    // Bucketing the chapter's money for the split is a central power.
    await requireFinanceCentral(ctx, homeChapterId);

    const sandboxMode = await readSandbox(ctx);
    const txns = (
      await ctx.db
        .query("transactions")
        .withIndex("by_chapter", (q) => q.eq("chapterId", args.chapterId))
        .take(ROLLUP_SCAN_LIMIT)
    ).filter((tr) => txnMatchesMode(tr, sandboxMode));

    const projectCache = new Map<Id<"projects">, Doc<"projects"> | null>();
    const getProject = async (id: Id<"projects">) => {
      if (projectCache.has(id)) return projectCache.get(id)!;
      const p = await ctx.db.get(id);
      projectCache.set(id, p);
      return p;
    };
    // WP-U (one home per dollar): the split heuristic reads a txn's BUDGET ref
    // (`refKind`/`scopeRefId`) instead of its own `eventId`/`projectId` FKs —
    // those are vestigial now (nothing new writes them; only `budgetId` is a
    // real attribution).
    const budgetCache = new Map<Id<"budgets">, Doc<"budgets"> | null>();
    const getBudget = async (id: Id<"budgets">) => {
      if (budgetCache.has(id)) return budgetCache.get(id)!;
      const b = await ctx.db.get(id);
      budgetCache.set(id, b);
      return b;
    };

    const central: (typeof splitSuggestionRow.type)[] = [];
    const chapter: (typeof splitSuggestionRow.type)[] = [];
    const unassigned: (typeof splitSuggestionRow.type)[] = [];
    const projectTxnCounts = new Map<Id<"projects">, number>();

    const toRow = (tr: Doc<"transactions">, reason: string) => ({
      id: tr._id,
      amountCents: tr.amountCents,
      flow: tr.flow,
      postedAt: tr.postedAt,
      description: tr.description ?? null,
      merchantName: tr.merchantName ?? null,
      reason,
    });

    for (const tr of txns) {
      const budget = tr.budgetId ? await getBudget(tr.budgetId) : null;
      if (budget?.refKind === "event") {
        // Event-linked → chapter: canon events are local (playbook boundary).
        chapter.push(toRow(tr, "Event-linked — canon events stay with the chapter"));
      } else if (budget?.refKind === "project" && budget.scopeRefId) {
        const projectId = budget.scopeRefId as Id<"projects">;
        projectTxnCounts.set(projectId, (projectTxnCounts.get(projectId) ?? 0) + 1);
        const project = await getProject(projectId);
        const isCentralProject = matchesAnyKeyword(project?.name, CENTRAL_PROJECT_KEYWORDS);
        if (isCentralProject) {
          central.push(
            toRow(tr, `Project "${project?.name ?? "?"}" is central-owned (music/recording)`),
          );
        } else {
          chapter.push(toRow(tr, `Project "${project?.name ?? "?"}" stays with the chapter`));
        }
      } else if (
        matchesAnyKeyword(tr.merchantName, CENTRAL_MERCHANT_KEYWORDS) ||
        matchesAnyKeyword(tr.description, CENTRAL_MERCHANT_KEYWORDS)
      ) {
        central.push(toRow(tr, "Merchant looks central (expansion / conference / brand)"));
      } else {
        unassigned.push(toRow(tr, "No rule matched — a human decides"));
      }
    }

    const projects: {
      id: Id<"projects">;
      name: string;
      suggested: "central" | "chapter";
      txnCount: number;
    }[] = [];
    for (const [pid, count] of projectTxnCounts) {
      const project = await getProject(pid);
      if (!project) continue;
      projects.push({
        id: pid,
        name: project.name,
        suggested: matchesAnyKeyword(project.name, CENTRAL_PROJECT_KEYWORDS)
          ? "central"
          : "chapter",
        txnCount: count,
      });
    }
    projects.sort((a, b) => a.name.localeCompare(b.name));

    return {
      central,
      chapter,
      unassigned,
      projects,
      counts: {
        central: central.length,
        chapter: chapter.length,
        unassigned: unassigned.length,
      },
    };
  },
});

// ── Restore (true undo) ───────────────────────────────────────────────────────
/**
 * Ops escape hatch — NOT exposed in any UI, callable only via the
 * `run-convex-function` workflow (same pattern as `linkIncreaseAccount`'s
 * demotion in WP-1.2) by an operator who has the audit row id in hand (from
 * `listReattributionAudit` or the dashboard). Restores every txn snapshotted
 * in `audit.priorStates` to EXACTLY its pre-move attribution — the true undo
 * that a swapped-target re-run of `reassignTransactions` /
 * `transferProjectScope` can't provide (that only restores `chapterId`; it
 * would recompute a FRESH reassignment patch, clearing category/fund/links all
 * over again instead of putting them back).
 *
 * Idempotent-ish: a txn deleted since the original move is skipped (not an
 * error) rather than failing the whole restore. Safe to re-run — re-patching
 * the same prior values twice is a no-op the second time.
 *
 * Does NOT re-open a `project_transfer`'s budget move — those round-trip
 * correctly via a second `transferProjectScope` call to the original scope
 * (the `by_ref`-based discovery fix means budgets are never stranded either
 * direction); this restores the TRANSACTION side, including whatever coding
 * the transfer or bulk reassign cleared along the way.
 */
export const restoreReattribution = internalMutation({
  args: { auditId: v.id("reattributionAudit") },
  returns: v.object({ restored: v.number(), skipped: v.number() }),
  handler: async (ctx, args) => {
    const audit = await ctx.db.get(args.auditId);
    if (!audit) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Audit row not found." });
    }
    let restored = 0;
    let skipped = 0;
    for (const prior of audit.priorStates) {
      const txn = await ctx.db.get(prior.transactionId);
      if (!txn) {
        skipped++;
        continue;
      }
      await ctx.db.patch(prior.transactionId, {
        chapterId: prior.chapterId,
        budgetId: prior.budgetId,
        fundId: prior.fundId,
        categoryId: prior.categoryId,
        projectId: prior.projectId,
        eventId: prior.eventId,
        eventItemId: prior.eventItemId,
        teamId: prior.teamId,
        personId: prior.personId,
      });
      restored++;
    }
    return { restored, skipped };
  },
});

// ── Audit read (central-gated) + reassign target list (for the bulk bar) ─────
export const listReattributionAudit = query({
  args: { limit: v.optional(v.number()) },
  returns: v.array(
    v.object({
      id: v.id("reattributionAudit"),
      kind: v.union(
        v.literal("bulk_reassign"),
        v.literal("project_transfer"),
        v.literal("event_transfer"),
      ),
      actorName: v.union(v.string(), v.null()),
      txnCount: v.number(),
      target: reattributionTargetValidator,
      summary: v.string(),
      note: v.union(v.string(), v.null()),
      budgetsMoved: v.union(v.number(), v.null()),
      createdAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const homeChapterId = await readChapterId(ctx);
    if (!homeChapterId) return [];
    await requireFinanceCentral(ctx, homeChapterId);
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
    const rows = await ctx.db
      .query("reattributionAudit")
      .withIndex("by_created")
      .order("desc")
      .take(limit);
    const out: {
      id: Id<"reattributionAudit">;
      kind: "bulk_reassign" | "project_transfer" | "event_transfer";
      actorName: string | null;
      txnCount: number;
      target: FinanceScope;
      summary: string;
      note: string | null;
      budgetsMoved: number | null;
      createdAt: number;
    }[] = [];
    for (const r of rows) {
      let actorName: string | null = null;
      if (r.actorPersonId) {
        const person = await ctx.db.get(r.actorPersonId);
        actorName = person?.name ?? null;
      }
      out.push({
        id: r._id,
        kind: r.kind,
        actorName,
        txnCount: r.transactionIds.length,
        target: r.target,
        summary: r.summary,
        note: r.note ?? null,
        budgetsMoved: r.budgetsMoved ?? null,
        createdAt: r.createdAt,
      });
    }
    return out;
  },
});

/** The chapters a central caller may reassign money to/from — powers the
 *  Reconcile bulk bar's "Reassign to" picker (the UI prepends "Central"). */
export const reassignTargets = query({
  args: {},
  returns: v.array(v.object({ id: v.id("chapters"), name: v.string() })),
  handler: async (ctx) => {
    const homeChapterId = await readChapterId(ctx);
    if (!homeChapterId) return [];
    await requireFinanceCentral(ctx, homeChapterId);
    const chapters = await ctx.db.query("chapters").take(ROLLUP_SCAN_LIMIT);
    return chapters
      .filter((c) => c.isActive !== false)
      .map((c) => ({ id: c._id, name: c.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  },
});
