import { defineTable } from "convex/server";
import { v } from "convex/values";
import {
  FUND_RESTRICTIONS,
  BUDGET_CATEGORY_KINDS,
  BUDGET_SCOPES,
  BUDGET_TYPES,
  BUDGET_REF_KINDS,
  BUDGET_TAG_KINDS,
  BUDGET_CADENCES,
  BUDGET_ROLLOVER_POLICIES,
  TRANSACTION_SOURCES,
  TRANSACTION_FLOWS,
  TRANSACTION_STATUSES,
  REIMBURSEMENT_STATUSES,
  CARD_TYPES,
  CARD_STATUSES,
  CARD_SOURCES,
  REPAYMENT_METHODS,
  REPAYMENT_STATUSES,
  PAYOUT_PROVIDERS,
  PAYOUT_STATUSES,
  INCREASE_ONBOARDING_STATUSES,
  LEGACY_ACCOUNT_STATUSES,
  FINANCE_ROLES,
  FINANCE_ROLE_SCOPES,
  SPECIALIZED_ROLE_TITLES,
  SPECIALIZED_ROLE_KINDS,
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

// ── Budgets: type × cadence × tags (v2) ──────────────────────────────────────
/** A flexible allocation of the account's balance. v2 keys off `type`
 *  (one_time / recurring) + a real-or-`"central"` chapter LEVEL + MULTIPLE
 *  managed tags (`budgetTags` via `budgetTagLinks`); optionally narrows to a
 *  fund + category. Tracks spent-vs-allocated per period. `scope`/`teamId` are
 *  legacy columns (ignored by v2 logic, backfilled into `type`/tags by
 *  `migrateBudgetScopesToTypes`; dropped in a later follow-up). */
export const budgets = defineTable({
  // A real chapter id, OR the string literal "central" for an org-level budget
  // (the CENTRAL sentinel — never null, not a `chapters` row). Existing rows
  // hold real ids and stay valid; the shared indexes work on the union.
  chapterId: v.union(v.id("chapters"), v.literal("central")),
  // Non-negative integer cents allocated for this type × period.
  amountCents: v.number(),
  label: v.optional(v.string()),
  // v2 SOURCE OF TRUTH: one_time (a specific event/project) vs recurring
  // (monthly/quarterly/yearly). Optional only so live legacy rows validate
  // before the backfill runs; new budgets always set it.
  type: v.optional(v.union(...BUDGET_TYPES.map((t) => v.literal(t)))),
  // For a one_time budget: whether `scopeRefId` points at an event or a project.
  refKind: v.optional(v.union(...BUDGET_REF_KINDS.map((k) => v.literal(k)))),
  // LEGACY (was required → optional): the pre-v2 6-value scope. Ignored by v2
  // logic; retained for the migration + a later drop.
  scope: v.optional(v.union(...BUDGET_SCOPES.map((s) => v.literal(s)))),
  // The id (as a string) of the event/project the one_time budget is attached
  // to (paired with `refKind`). Stored as a string because it references
  // different tables depending on `refKind`.
  scopeRefId: v.optional(v.string()),
  cadence: v.union(...BUDGET_CADENCES.map((c) => v.literal(c))),
  // The period this allocation covers, bucketed in America/New_York. `month`
  // (1–12) and/or `quarter` (1–4) narrow the year; absent = the whole year.
  year: v.number(),
  month: v.optional(v.number()),
  quarter: v.optional(v.number()),
  fundId: v.optional(v.id("funds")),
  categoryId: v.optional(v.id("budgetCategories")),
  // LEGACY: pre-v2 team scope link (migrated to a `team` budget tag).
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
  // Chapter-led so "budgets of type X" never matches another chapter's budgets.
  .index("by_chapter_and_type", ["chapterId", "type"])
  .index("by_category", ["categoryId", "year"]);

// ── Budget tags (managed, level-scoped) ──────────────────────────────────────
/** A managed tag definition on a budget LEVEL (a real chapter or `"central"`).
 *  The flexible filter + rollup dimension: `team`/`template` tags carry a
 *  `refId` (financeTeams / eventType id) so auto-tag can dedup; `events` is the
 *  auto-applied catch-all for event budgets; `custom` is author-created. Budgets
 *  link to tags many-to-many via `budgetTagLinks`. */
export const budgetTags = defineTable({
  chapterId: v.union(v.id("chapters"), v.literal("central")),
  name: v.string(),
  kind: v.optional(v.union(...BUDGET_TAG_KINDS.map((k) => v.literal(k)))),
  // team → financeTeams id, template → eventType id (used by ensureTag dedup).
  refId: v.optional(v.string()),
  sortOrder: v.optional(v.number()),
  createdBy: v.optional(v.id("users")),
  createdAt: v.number(),
})
  .index("by_chapter", ["chapterId"])
  .index("by_chapter_and_kind", ["chapterId", "kind"])
  // ensureTag dedup: find an existing managed tag by (level, kind, refId).
  .index("by_chapter_and_ref", ["chapterId", "kind", "refId"]);

// ── Budget ⇄ tag links (many-to-many) ────────────────────────────────────────
/** One budget↔tag link. A budget carries several tags and a tag rolls up
 *  several budgets. `chapterId` is denormalized (the budget's LEVEL) for
 *  tenancy checks without loading the budget. */
export const budgetTagLinks = defineTable({
  budgetId: v.id("budgets"),
  tagId: v.id("budgetTags"),
  chapterId: v.union(v.id("chapters"), v.literal("central")),
  createdAt: v.number(),
})
  .index("by_budget", ["budgetId"])
  .index("by_tag", ["tagId"]);

// ── Transactions (the unified ACTUAL record) ─────────────────────────────────
/** The one table summed for actuals. Positive integer cents; `flow` carries
 *  direction. `externalId` is the unique dedup key for synced sources.
 *
 *  WP-2.1 (the split keystone): `chapterId` accepts the `"central"` sentinel so
 *  money can belong to CENTRAL itself, not just a chapter — mirroring
 *  `budgets`/`budgetTags`/`increaseAccounts`. Central-owned txns are created by
 *  the central desk (`createManualTransaction({ central: true })`, FC/manual
 *  ingestion onto the central account) and reconciled at central scope
 *  (`requireFinanceCentral`); they NEVER appear in a chapter dashboard/reconcile
 *  (the `by_chapter*` reads scope to a real chapter id) and carry no
 *  chapter-scoped links (funds/categories/projects/events are chapter-only).
 *  Every `by_chapter*` index keeps working — the key is just a string. */
export const transactions = defineTable({
  chapterId: v.union(v.id("chapters"), v.literal("central")),
  source: v.union(...TRANSACTION_SOURCES.map((s) => v.literal(s))),
  flow: v.union(...TRANSACTION_FLOWS.map((f) => v.literal(f))),
  // Always a non-negative integer number of cents.
  amountCents: v.number(),
  currency: v.optional(v.string()), // "usd" (default)
  postedAt: v.number(),
  description: v.optional(v.string()),
  merchantName: v.optional(v.string()),
  merchantCategory: v.optional(v.string()),
  // Card last-4 parsed out of the description (FC syncs the card only inside
  // that string). Powers legacy-card matching (`by_chapter_and_last4`) + display.
  cardLast4: v.optional(v.string()),

  // Categorization (the "where does this money belong" layer).
  fundId: v.optional(v.id("funds")),
  categoryId: v.optional(v.id("budgetCategories")),
  // Explicit budget attribution. When set, this txn counts toward EXACTLY this
  // budget (chapter or central) and is never derive-matched to any other.
  budgetId: v.optional(v.id("budgets")),

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
      // Set when this "suggestion" is actually a failed-attempt marker (the
      // OpenRouter call errored, non-200'd, or returned unparseable JSON) —
      // never a real proposal. Lets the hourly sweep tell "never attempted"
      // apart from "attempted and failed", so it can retry after a cooldown
      // instead of resubmitting every run forever. See aiCodingData.ts.
      failed: v.optional(v.boolean()),
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

  // Receipt-reminder timeline (day-1 flag → day-3 escalate, tracked by
  // `cards.advanceReceiptReminders`). `undefined` = no reminder sent yet.
  // Cleared when a receipt attaches (`finances.attachReceipt`). Terminal day-7
  // handling is `cards.autoLockOverdueCards` (a separate field on `cards`).
  receiptReminderStage: v.optional(
    v.union(v.literal("flagged"), v.literal("escalated")),
  ),
  lastReminderSentAt: v.optional(v.number()),

  createdBy: v.optional(v.id("users")),
  createdAt: v.number(),
})
  .index("by_chapter", ["chapterId"])
  .index("by_chapter_and_postedAt", ["chapterId", "postedAt"])
  .index("by_chapter_and_status", ["chapterId", "status"])
  .index("by_chapter_and_last4", ["chapterId", "cardLast4"])
  .index("by_external_id", ["externalId"])
  .index("by_card", ["cardId"])
  .index("by_fund", ["fundId"])
  .index("by_category", ["categoryId"])
  .index("by_budget", ["budgetId"])
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
  // True ONLY for the authenticated in-app submit path (`submitReimbursement`),
  // where `personId` is server-derived from the caller's OWN roster row — not
  // the public path's best-effort phone/email match. Lets the approval queue
  // show the verified roster identity alongside a `payeeName`/`payeeEmail`
  // override, so a member can't quietly submit under a more-trustworthy name
  // without the approver seeing who's really asking.
  identityVerified: v.optional(v.boolean()),

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
  // The Increase External Account this request's payout is addressed to
  // (`POST /external_accounts`, created via `linkPublicBankAccount` /
  // `linkBankAccount`). The RAW routing + account number are never persisted —
  // only Increase's own reusable reference id + the last-4 above (recomputed
  // from the full account number at link time). Its presence is what flips
  // `hasFullDestination` in `increase.beginPayout` from a degraded manual
  // payout to a real ACH transfer.
  externalAccountId: v.optional(v.string()),
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
  // Provenance: absent/"increase" = a native Increase card; "legacy" = an
  // external/Relay card linked by last-4 (no Increase object, no controls).
  source: v.optional(v.union(...CARD_SOURCES.map((s) => v.literal(s)))),
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
  .index("by_increase_card", ["increaseCardId"])
  // Legacy-card matching: find a chapter's linked card by its last-4.
  .index("by_chapter_and_last4", ["chapterId", "last4"]);

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
  // The payer's own Increase External Account (`POST /external_accounts`) the
  // ACH debit pulls from — created via `linkRepaymentBankAccount`. The raw
  // routing + account number are never persisted, only Increase's reference id
  // + a last-4 for display. Its presence is what flips `canCharge` in
  // `cards.beginRepayment` from a degraded/manual repayment to a real charge.
  payerExternalAccountId: v.optional(v.string()),
  payerAccountLast4: v.optional(v.string()),
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

// ── Increase accounts (one Entity + Account per chapter — AND central) ───────
/** The chapter's single Increase Entity + Account — the source of truth for its
 *  balance. Budgets are logical allocations of this balance, member cards are
 *  issued on it, and ACH reimbursement payouts originate from it.
 *
 *  WP-1.2: also holds ONE row for the org level (`"central"` sentinel — never
 *  null, not a `chapters` row) — the City Launch Fund's own account. Mirrors
 *  the `financeRoles.chapterId` / `specializedRoles.scope` union so central is
 *  representable without a null. */
export const increaseAccounts = defineTable({
  chapterId: v.union(v.id("chapters"), v.literal("central")),
  // The environment this account was provisioned in (true = Increase sandbox).
  // Stamped at provision time from the current `financeSettings.sandboxMode`. A
  // chapter may hold up to TWO rows — one per environment — and each finance
  // view acts on the row matching the current mode. Optional for legacy rows
  // predating the field (their environment falls back to the `sandbox_` id
  // prefix via `accountIsSandbox`; the backfill stamps them).
  sandbox: v.optional(v.boolean()),
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
})
  .index("by_chapter", ["chapterId"])
  // Resolve the owning chapter from an inbound Increase object's `account_id`
  // (card-charge ingestion, GET /transactions webhook) without scanning.
  .index("by_increase_account", ["increaseAccountId"]);

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
  // First-connect full-history backfill state. `backfilledAt` is stamped when
  // the entire transaction history has been paged in (unset = backfill still
  // pending / in progress). While a backfill is draining across scheduled
  // invocations, `syncCursor` holds the last `starting_after` object id reached
  // so a follow-up run resumes where it left off; it is cleared when the
  // backfill completes. Once `backfilledAt` is set the sync switches to the
  // bounded newest-first incremental re-sweep (which keeps no cursor).
  syncCursor: v.optional(v.string()),
  backfilledAt: v.optional(v.number()),
  status: v.union(...LEGACY_ACCOUNT_STATUSES.map((s) => v.literal(s))),
  lastSyncedAt: v.optional(v.number()),
  createdAt: v.number(),
})
  .index("by_chapter", ["chapterId"])
  .index("by_stripe_fc_account", ["stripeFcAccountId"]);

// ── Stripe customers (FC session account_holder cache) ───────────────────────
/** The Stripe Customer provisioned for a connecting LEVEL (a real chapter, or
 *  `"central"` once external-account connect moves org-wide). Stripe's Create
 *  Financial Connections Session REQUIRES an `account_holder`; we scope every
 *  session to this cached customer so the same holder is reused across reconnects
 *  instead of minting a new customer each time. One row per level. */
export const financeStripeCustomers = defineTable({
  chapterId: v.union(v.id("chapters"), v.literal("central")),
  stripeCustomerId: v.string(),
  createdAt: v.number(),
}).index("by_chapter", ["chapterId"]);

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
  // A real chapter id, OR the `"central"` sentinel for an org-level grant (the
  // CENTRAL sentinel — never null, not a `chapters` row). Chapter-level grants
  // hold a real id; a `finance_manager` SPECIALIZED role assigned at central
  // bridges to a grant keyed on `"central"` (see `specializedRoles`). Mirrors the
  // `budgets.chapterId` union so the org level is representable without a null.
  chapterId: v.union(v.id("chapters"), v.literal("central")),
  personId: v.id("people"),
  role: v.union(...FINANCE_ROLES.map((r) => v.literal(r))),
  scope: v.union(...FINANCE_ROLE_SCOPES.map((s) => v.literal(s))),
  grantedByPersonId: v.optional(v.id("people")),
  createdAt: v.number(),
})
  .index("by_chapter", ["chapterId"])
  .index("by_person", ["personId"])
  .index("by_chapter_and_person", ["chapterId", "personId"]);

// ── Specialized roles (leadership + finance, super-admin managed) ────────────
/** Org leadership + finance TITLES at a scope (`"central"` sentinel OR a real
 *  chapter). A title carries a fixed `roleKind` (leadership | finance), stored
 *  alongside for indexed SoD queries. One holder per (scope, title) SLOT;
 *  assigning a filled slot replaces the holder. Scope-local separation of duties:
 *  a person can't hold both a leadership AND a finance title in the SAME scope
 *  (checked via `by_scope_and_kind`). A `finance_manager` title additionally
 *  BRIDGES to a `financeRoles` manager grant (see `specializedRoles.ts`).
 *  Super-admin managed — NOT gated on the finance ladder. */
export const specializedRoles = defineTable({
  personId: v.id("people"),
  scope: v.union(v.id("chapters"), v.literal("central")),
  title: v.union(...SPECIALIZED_ROLE_TITLES.map((t) => v.literal(t))),
  // Derived from `title` (via SPECIALIZED_ROLE_META), stored so the SoD check +
  // kind rollups can query by index instead of loading + mapping every row.
  roleKind: v.union(...SPECIALIZED_ROLE_KINDS.map((k) => v.literal(k))),
  createdBy: v.optional(v.id("users")),
  createdAt: v.number(),
})
  .index("by_person", ["personId"])
  .index("by_scope", ["scope"])
  // The SLOT: one holder per (scope, title).
  .index("by_scope_and_title", ["scope", "title"])
  // The scope-local separation-of-duties check (the OTHER kind at this scope).
  .index("by_scope_and_kind", ["scope", "roleKind"]);

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

// ── Public reimbursement submit rate limit (deployment-wide) ─────────────────
/** A single timestamped hit against the anonymous `submitPublicReimbursement`
 *  rate limiter. NOT chapter-scoped — the same abuse (a bot hammering the
 *  public form) can target any chapter's slug, so the limiter keys on the
 *  caller's IP and/or submitted email, not a chapter. `key` is
 *  `"ip:<address>"` or `"email:<normalized address>"`; one row is inserted per
 *  key per successful submission, and the check reads the window via
 *  `by_key_and_time`. See `reimbursements.ts` for the threshold + rationale. */
export const reimbursementSubmitAttempts = defineTable({
  key: v.string(),
  createdAt: v.number(),
}).index("by_key_and_time", ["key", "createdAt"]);

// ── Finance settings (deployment-wide singleton) ─────────────────────────────
/** Deployment-wide finance settings (one row, the `aiSettings` pattern).
 *  `sandboxMode` is the runtime testing toggle: when true, NEW Increase account
 *  provisioning targets the Increase SANDBOX (sandbox entity + key + base) so the
 *  whole finance layer can be exercised without touching real money. Existing
 *  accounts always self-select their environment from their `sandbox_` id prefix,
 *  so flipping this can never misroute already-provisioned money. Superuser-only. */
export const financeSettings = defineTable({
  sandboxMode: v.boolean(),
  updatedBy: v.optional(v.id("users")),
  updatedAt: v.number(),
});
