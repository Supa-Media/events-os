import { defineTable } from "convex/server";
import { v } from "convex/values";
import {
  FUND_RESTRICTIONS,
  BUDGET_CATEGORY_KINDS,
  BUDGET_SCOPES,
  BUDGET_CADENCES,
  BUDGET_ROLLOVER_POLICIES,
  TRANSACTION_SOURCES,
  TRANSACTION_FLOWS,
  TRANSACTION_STATUSES,
  REIMBURSEMENT_STATUSES,
  CARD_TYPES,
  CARD_STATUSES,
  REPAYMENT_METHODS,
  REPAYMENT_STATUSES,
  PAYOUT_PROVIDERS,
  PAYOUT_STATUSES,
  INCREASE_ONBOARDING_STATUSES,
  LEGACY_ACCOUNT_STATUSES,
  FINANCE_ROLES,
  FINANCE_ROLE_SCOPES,
} from "@events-os/shared";

/**
 * Finance schema for Chapter OS — the native money layer that replaces
 * KleerCard / Bill.com. Because the app already holds events, projects,
 * supplies, teams, and people, every dollar can attach to the exact
 * event/project/item it was spent on (see docs/plans/finance.md).
 *
 * INVARIANTS (enforced by convention + tests, mirrored across every table):
 *  - Money is ALWAYS a non-negative integer number of CENTS (never floats).
 *    Direction is carried by `flow`, not by a sign. (Matches ticketing's
 *    `priceCents` and the existing `budgetLineItems`.)
 *  - Every table is chapter-scoped (`chapterId`) with a `by_chapter` index.
 *    The ONE exception is `webhookEvents`, which is a deployment-wide inbound
 *    dedup ledger that exists before a chapter can be resolved.
 *  - Enum fields build their validators from the shared tuples in
 *    `@events-os/shared` (the `EVENT_STATUSES` pattern), so schema + app + tests
 *    can never drift on the allowed values.
 *  - ESTIMATED money (budgets, projects.budgetUsd, events.budget, item costs,
 *    engagement amounts) is never summed with ACTUAL money. `transactions` is
 *    the ONLY table summed for actuals; `transfer`-flow rows are excluded from
 *    category/budget spend (anti-double-count).
 *
 * All finance actors are `people` (resolve the caller through `people` by
 * `by_user`), matching the `ownerPersonId → people` convention.
 */

// ── Funds ────────────────────────────────────────────────────────────────────
/** A top-level money bucket. Unrestricted = general operating; designated =
 *  earmarked for a purpose. Budgets + categories nest beneath a fund. */
export const funds = defineTable({
  chapterId: v.id("chapters"),
  name: v.string(),
  restriction: v.union(...FUND_RESTRICTIONS.map((r) => v.literal(r))),
  // Optional accounting code (e.g. "1000") and a display color chip.
  code: v.optional(v.string()),
  color: v.optional(v.string()),
  sortOrder: v.number(),
  isActive: v.optional(v.boolean()),
  createdAt: v.number(),
}).index("by_chapter", ["chapterId"]);

// ── Budget categories (self-nesting under a fund) ────────────────────────────
/** A category (grouping) or line item (leaf) under a fund. Self-nests via
 *  `parentCategoryId`, kept acyclic by the mutation layer. */
export const budgetCategories = defineTable({
  chapterId: v.id("chapters"),
  fundId: v.id("funds"),
  parentCategoryId: v.optional(v.id("budgetCategories")),
  name: v.string(),
  kind: v.union(...BUDGET_CATEGORY_KINDS.map((k) => v.literal(k))),
  sortOrder: v.optional(v.number()),
  isActive: v.optional(v.boolean()),
  createdAt: v.number(),
})
  .index("by_chapter", ["chapterId"])
  .index("by_fund", ["fundId"])
  .index("by_parent", ["parentCategoryId"]);

// ── Finance teams / departments ──────────────────────────────────────────────
/** A finance team / department (Development, Marketing, Operations…). A null
 *  `chapterId` marks a CENTRAL/org team shared across chapters. */
export const financeTeams = defineTable({
  // Optional: absent = a central/org team (not bound to one chapter).
  chapterId: v.optional(v.id("chapters")),
  name: v.string(),
  sortOrder: v.number(),
  isActive: v.optional(v.boolean()),
  createdAt: v.number(),
}).index("by_chapter", ["chapterId"]);

// ── Budgets: scope × cadence × categories ────────────────────────────────────
/** A flexible allocation of the account's balance. Any scope can take any
 *  cadence; optionally narrows to a fund + category + team. v1 tracks
 *  spent-vs-allocated per period — rollover is deferred (`rolloverPolicy`). */
export const budgets = defineTable({
  chapterId: v.id("chapters"),
  // Non-negative integer cents allocated for this scope × period.
  amountCents: v.number(),
  label: v.optional(v.string()),
  scope: v.union(...BUDGET_SCOPES.map((s) => v.literal(s))),
  // The id (as a string) of the event/project/template/team the budget is
  // attached to, when the scope points at a specific instance. Absent for
  // `chapter`/`bucket` scopes. Stored as a string because it references
  // several different tables depending on `scope`.
  scopeRefId: v.optional(v.string()),
  cadence: v.union(...BUDGET_CADENCES.map((c) => v.literal(c))),
  // The period this allocation covers, bucketed in America/New_York. `month`
  // (1–12) and/or `quarter` (1–4) narrow the year; absent = the whole year.
  year: v.number(),
  month: v.optional(v.number()),
  quarter: v.optional(v.number()),
  fundId: v.optional(v.id("funds")),
  categoryId: v.optional(v.id("budgetCategories")),
  teamId: v.optional(v.id("financeTeams")),
  // Deferred: v1 does no rollover math; this reserves the per-budget toggle.
  rolloverPolicy: v.optional(
    v.union(...BUDGET_ROLLOVER_POLICIES.map((p) => v.literal(p))),
  ),
  createdBy: v.optional(v.id("users")),
  createdAt: v.number(),
})
  .index("by_chapter", ["chapterId"])
  .index("by_chapter_and_period", ["chapterId", "year"])
  // Chapter-led so "budgets for scope X" never matches another chapter's
  // chapter/bucket budgets (whose `scopeRefId` is absent).
  .index("by_chapter_and_scope", ["chapterId", "scope", "scopeRefId"])
  .index("by_category", ["categoryId", "year"]);

// ── Transactions (the unified ACTUAL record) ─────────────────────────────────
/** The one table summed for actuals. Positive integer cents; `flow` carries
 *  direction. `externalId` is the unique dedup key for synced sources. */
export const transactions = defineTable({
  chapterId: v.id("chapters"),
  source: v.union(...TRANSACTION_SOURCES.map((s) => v.literal(s))),
  flow: v.union(...TRANSACTION_FLOWS.map((f) => v.literal(f))),
  // Always a non-negative integer number of cents.
  amountCents: v.number(),
  currency: v.optional(v.string()), // "usd" (default)
  postedAt: v.number(),
  description: v.optional(v.string()),
  merchantName: v.optional(v.string()),
  merchantCategory: v.optional(v.string()),

  // Categorization (the "where does this money belong" layer).
  fundId: v.optional(v.id("funds")),
  categoryId: v.optional(v.id("budgetCategories")),

  // Operational links (the "what was it for" layer — the whole point of a
  // native finance system: a dollar attaches to the exact thing it was spent on).
  projectId: v.optional(v.id("projects")),
  eventId: v.optional(v.id("events")),
  eventItemId: v.optional(v.id("eventItems")),
  teamId: v.optional(v.id("financeTeams")),
  personId: v.optional(v.id("people")),
  engagementId: v.optional(v.id("engagements")),
  cardId: v.optional(v.id("cards")),
  reimbursementId: v.optional(v.id("reimbursementRequests")),

  status: v.union(...TRANSACTION_STATUSES.map((s) => v.literal(s))),

  // AI auto-coding proposal (a human confirms; the model never moves money).
  aiSuggestion: v.optional(
    v.object({
      fundId: v.optional(v.id("funds")),
      categoryId: v.optional(v.id("budgetCategories")),
      projectId: v.optional(v.id("projects")),
      eventId: v.optional(v.id("events")),
      confidence: v.optional(v.number()),
      rationale: v.optional(v.string()),
      model: v.optional(v.string()),
      suggestedAt: v.optional(v.number()),
    }),
  ),

  // Personal-charge repayment: a cardholder flags an accidental personal charge
  // (`isPersonal`) and repays it; `repaymentId` links to the repayment record.
  isPersonal: v.optional(v.boolean()),
  repaymentId: v.optional(v.id("personalRepayments")),

  // Provenance / dedup. `externalId` is the provider's unique id for the row
  // (Increase transaction id, Stripe FC transaction id) — the idempotent sync
  // dedup key. `sourceAccountId` is the Increase/legacy account it came from.
  externalId: v.optional(v.string()),
  sourceAccountId: v.optional(v.string()),
  // Pending (authorization) vs posted (settled) lifecycle from the card network.
  pending: v.optional(v.boolean()),
  authorizedAt: v.optional(v.number()),

  // A single attached receipt (line-level receipts live on reimbursement lines).
  receiptStorageId: v.optional(v.id("_storage")),

  createdBy: v.optional(v.id("users")),
  createdAt: v.number(),
})
  .index("by_chapter", ["chapterId"])
  .index("by_chapter_and_postedAt", ["chapterId", "postedAt"])
  .index("by_chapter_and_status", ["chapterId", "status"])
  .index("by_external_id", ["externalId"])
  .index("by_card", ["cardId"])
  .index("by_fund", ["fundId"])
  .index("by_category", ["categoryId"])
  .index("by_project", ["projectId"])
  .index("by_event", ["eventId"])
  .index("by_person", ["personId"])
  .index("by_reimbursement", ["reimbursementId"]);

// ── Reimbursement requests (public, token-scoped) ────────────────────────────
/** A public reimbursement submission. Accountless: a secret `token` (the
 *  `rsvps.token` precedent) lets a claimant submit + check status without an
 *  account. Approver ≠ requester is enforced at the mutation layer (SoD). */
export const reimbursementRequests = defineTable({
  chapterId: v.id("chapters"),
  // Secret token, returned once to the claimant's browser. NEVER returned by
  // in-app list queries.
  token: v.string(),
  status: v.union(...REIMBURSEMENT_STATUSES.map((s) => v.literal(s))),

  // Claimant identity (accountless). `personId` links to a roster row when the
  // claimant matches a known person.
  payeeName: v.string(),
  payeeEmail: v.optional(v.string()),
  payeePhone: v.optional(v.string()),
  personId: v.optional(v.id("people")),

  purpose: v.optional(v.string()),
  // What the spend was for (categorization is per line item).
  eventId: v.optional(v.id("events")),
  projectId: v.optional(v.id("projects")),

  // Denormalized sum of line-item amounts (integer cents), and the approved
  // subtotal once a manager approves (supports partial approval).
  totalCents: v.number(),
  approvedCents: v.optional(v.number()),

  // Separation of duties: who pre-approved / approved (must differ from the
  // requester). Recorded as people, matching the finance-actor convention.
  preApprovedByPersonId: v.optional(v.id("people")),
  reviewedByPersonId: v.optional(v.id("people")),
  rejectedReason: v.optional(v.string()),

  // Payout details captured on the form (where the money should go).
  bankAccountLast4: v.optional(v.string()),
  payoutId: v.optional(v.id("payouts")),

  submittedAt: v.optional(v.number()),
  approvedAt: v.optional(v.number()),
  paidAt: v.optional(v.number()),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index("by_chapter", ["chapterId"])
  .index("by_token", ["token"])
  .index("by_chapter_and_status", ["chapterId", "status"])
  .index("by_person", ["personId"])
  .index("by_event", ["eventId"]);

/** One receipt line within a reimbursement request. Per-line categorization +
 *  receipt; `matchedTransactionId` links a line to an already-synced txn so an
 *  approved reimbursement can't double-count spend that already posted. */
export const reimbursementLineItems = defineTable({
  chapterId: v.id("chapters"),
  reimbursementId: v.id("reimbursementRequests"),
  description: v.string(),
  amountCents: v.number(),
  fundId: v.optional(v.id("funds")),
  categoryId: v.optional(v.id("budgetCategories")),
  eventId: v.optional(v.id("events")),
  projectId: v.optional(v.id("projects")),
  receiptStorageId: v.optional(v.id("_storage")),
  // Partial approval: a line can be individually approved or rejected.
  approved: v.optional(v.boolean()),
  matchedTransactionId: v.optional(v.id("transactions")),
  order: v.number(),
  createdAt: v.number(),
})
  .index("by_chapter", ["chapterId"])
  .index("by_reimbursement", ["reimbursementId"]);

// ── Cards (person-owned) ─────────────────────────────────────────────────────
/** A member card, owned by ONE person (they own its receipts + reconciliation).
 *  Only two controls: a monthly safety cap + a validity window. Auto-locks if a
 *  receipt is >7 days late (`receiptGraceEndsAt`); unlocks on upload. */
export const cards = defineTable({
  chapterId: v.id("chapters"),
  cardholderPersonId: v.id("people"),
  increaseCardId: v.optional(v.string()),
  increaseCardholderId: v.optional(v.string()),
  type: v.union(...CARD_TYPES.map((t) => v.literal(t))),
  last4: v.optional(v.string()),
  status: v.union(...CARD_STATUSES.map((s) => v.literal(s))),
  // The two controls.
  monthlyCapCents: v.optional(v.number()),
  validFrom: v.optional(v.number()),
  validUntil: v.optional(v.number()),
  // When the receipt grace window ends; past it with a missing receipt the
  // card auto-locks (a cron sweeps this).
  receiptGraceEndsAt: v.optional(v.number()),
  createdBy: v.optional(v.id("users")),
  createdAt: v.number(),
})
  .index("by_chapter", ["chapterId"])
  .index("by_cardholder", ["cardholderPersonId"])
  .index("by_increase_card", ["increaseCardId"]);

// ── Personal-charge repayment ────────────────────────────────────────────────
/** A cardholder's repayment of an accidental personal charge. When paid, an
 *  offsetting credit transaction is posted (`creditTransactionId`). No
 *  reimbursement paperwork — this is the cardholder paying the org back. */
export const personalRepayments = defineTable({
  chapterId: v.id("chapters"),
  // The flagged personal charge being repaid.
  transactionId: v.id("transactions"),
  payerPersonId: v.id("people"),
  amountCents: v.number(),
  method: v.union(...REPAYMENT_METHODS.map((m) => v.literal(m))),
  status: v.union(...REPAYMENT_STATUSES.map((s) => v.literal(s))),
  increaseRef: v.optional(v.string()),
  // The offsetting credit transaction posted once the repayment settles.
  creditTransactionId: v.optional(v.id("transactions")),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index("by_chapter", ["chapterId"])
  .index("by_person", ["payerPersonId"])
  .index("by_transaction", ["transactionId"]);

// ── Payouts (ACH from the chapter's Increase account) ────────────────────────
/** An ACH payout originating from the chapter's Increase account. Idempotency-
 *  keyed on `reimbursementId` so an approved reimbursement can never double-pay.
 *  `provider: "manual"` covers the "mark paid" fallback when Increase isn't set. */
export const payouts = defineTable({
  chapterId: v.id("chapters"),
  // Idempotency key: at most one live payout per reimbursement.
  reimbursementId: v.id("reimbursementRequests"),
  payeePersonId: v.optional(v.id("people")),
  amountCents: v.number(),
  provider: v.union(...PAYOUT_PROVIDERS.map((p) => v.literal(p))),
  status: v.union(...PAYOUT_STATUSES.map((s) => v.literal(s))),
  increaseTransferId: v.optional(v.string()),
  bankAccountLast4: v.optional(v.string()),
  // The `transfer`-flow transaction that records this payout leaving the account.
  transactionId: v.optional(v.id("transactions")),
  failureReason: v.optional(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index("by_chapter", ["chapterId"])
  .index("by_reimbursement", ["reimbursementId"])
  .index("by_increase_transfer", ["increaseTransferId"])
  .index("by_chapter_and_status", ["chapterId", "status"]);

// ── Increase accounts (one Entity + Account per chapter) ─────────────────────
/** The chapter's single Increase Entity + Account — the source of truth for its
 *  balance. Budgets are logical allocations of this balance, member cards are
 *  issued on it, and ACH reimbursement payouts originate from it. */
export const increaseAccounts = defineTable({
  chapterId: v.id("chapters"),
  increaseEntityId: v.optional(v.string()),
  increaseAccountId: v.optional(v.string()),
  onboardingStatus: v.union(
    ...INCREASE_ONBOARDING_STATUSES.map((s) => v.literal(s)),
  ),
  balanceCents: v.optional(v.number()),
  routingLast4: v.optional(v.string()),
  accountLast4: v.optional(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
}).index("by_chapter", ["chapterId"]);

// ── Legacy external accounts (Stripe Financial Connections read-sync) ────────
/** A legacy/external bank or card account, connected read-only via Stripe
 *  Financial Connections (Increase can't aggregate outside accounts). Its
 *  transactions sync in and dedup on `transactions.externalId`. */
export const legacyAccounts = defineTable({
  chapterId: v.id("chapters"),
  stripeFcAccountId: v.string(),
  institutionName: v.optional(v.string()),
  last4: v.optional(v.string()),
  type: v.optional(v.string()),
  // Default fund newly-synced transactions from this account land in.
  defaultFundId: v.optional(v.id("funds")),
  syncCursor: v.optional(v.string()),
  status: v.union(...LEGACY_ACCOUNT_STATUSES.map((s) => v.literal(s))),
  lastSyncedAt: v.optional(v.number()),
  createdAt: v.number(),
})
  .index("by_chapter", ["chapterId"])
  .index("by_stripe_fc_account", ["stripeFcAccountId"]);

// ── Card authorizations (real-time-decision log) ─────────────────────────────
/** The log of Increase `card_authorization` real-time decisions (approve /
 *  decline from the monthly cap + validity + receipt-lock rules). Kept for
 *  audit + to reconcile against the eventual posted transaction. */
export const cardAuthorizations = defineTable({
  chapterId: v.id("chapters"),
  cardId: v.id("cards"),
  increaseAuthId: v.string(),
  amountCents: v.number(),
  merchantName: v.optional(v.string()),
  merchantCategory: v.optional(v.string()),
  approved: v.boolean(),
  reason: v.optional(v.string()),
  transactionId: v.optional(v.id("transactions")),
  createdAt: v.number(),
})
  .index("by_chapter", ["chapterId"])
  .index("by_card", ["cardId"])
  .index("by_increase_auth", ["increaseAuthId"]);

// ── Approval policy + audit ──────────────────────────────────────────────────
/** Per-chapter approval thresholds. One row per chapter. */
export const approvalPolicy = defineTable({
  chapterId: v.id("chapters"),
  // Above this amount a pre-approval is required before submission.
  requirePreApprovalOverCents: v.optional(v.number()),
  // Above this amount a second, distinct approver is required.
  requireSecondApproverOverCents: v.optional(v.number()),
  // Auto-initiate the ACH payout the moment a reimbursement is approved.
  autoPayOnApproval: v.optional(v.boolean()),
  updatedByPersonId: v.optional(v.id("people")),
  updatedAt: v.number(),
}).index("by_chapter", ["chapterId"]);

/** Append-only approval/audit trail (the `projectComments` pattern). Records
 *  who did what to a reimbursement/payout/budget/transaction, for the SoD
 *  audit history. Never updated in place. */
export const approvals = defineTable({
  chapterId: v.id("chapters"),
  subjectType: v.union(
    v.literal("reimbursement"),
    v.literal("payout"),
    v.literal("budget"),
    v.literal("transaction"),
  ),
  subjectId: v.string(),
  action: v.union(
    v.literal("preapprove"),
    v.literal("approve"),
    v.literal("reject"),
    v.literal("cancel"),
    v.literal("pay"),
    v.literal("edit"),
  ),
  actorPersonId: v.id("people"),
  note: v.optional(v.string()),
  createdAt: v.number(),
})
  .index("by_chapter", ["chapterId"])
  .index("by_subject", ["subjectType", "subjectId"]);

// ── Finance roles (graded, per-person) ───────────────────────────────────────
/** A caller's graded finance capability in a chapter (viewer < bookkeeper <
 *  manager). `scope: "central"` layers org-wide roll-up reach on top.
 *  SUPERUSERS are implicitly central managers (the bootstrap path — they seed
 *  the first grants); everyone else, chapter admins included, needs an explicit
 *  grant here. Conferring `scope:"central"` itself requires central reach. */
export const financeRoles = defineTable({
  chapterId: v.id("chapters"),
  personId: v.id("people"),
  role: v.union(...FINANCE_ROLES.map((r) => v.literal(r))),
  scope: v.union(...FINANCE_ROLE_SCOPES.map((s) => v.literal(s))),
  grantedByPersonId: v.optional(v.id("people")),
  createdAt: v.number(),
})
  .index("by_chapter", ["chapterId"])
  .index("by_person", ["personId"])
  .index("by_chapter_and_person", ["chapterId", "personId"]);

// ── Webhook events (deployment-wide inbound dedup) ───────────────────────────
/** Shared inbound webhook dedup ledger. NOT chapter-scoped on purpose: a
 *  webhook is deduped on the provider's `event.id` BEFORE any chapter can be
 *  resolved from its payload. Used by both the Stripe and Increase handlers. */
export const webhookEvents = defineTable({
  provider: v.union(v.literal("stripe"), v.literal("increase")),
  // The provider's unique event id (idempotent handling key).
  eventId: v.string(),
  receivedAt: v.number(),
  processedAt: v.optional(v.number()),
  summary: v.optional(v.string()),
}).index("by_provider_and_event", ["provider", "eventId"]);
