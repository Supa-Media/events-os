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
  BUDGET_APPROVAL_STATUSES,
  TRANSACTION_SOURCES,
  TRANSACTION_FLOWS,
  TRANSACTION_STATUSES,
  REIMBURSEMENT_STATUSES,
  CARD_TYPES,
  CARD_STATUSES,
  CARD_SOURCES,
  CARD_REQUEST_STATUSES,
  REPAYMENT_METHODS,
  REPAYMENT_STATUSES,
  PAYOUT_PROVIDERS,
  PAYOUT_STATUSES,
  INCREASE_ONBOARDING_STATUSES,
  INBOUND_RECEIPT_STATUSES,
  RECEIPT_SOURCES,
  RECEIPT_LINK_SOURCES,
  RECEIPT_SENDER_CLASSES,
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

  // ── Approval workflow (WP-3.2, additive) ───────────────────────────────────
  // ABSENT on a budget created before this feature shipped — a grandfathered
  // legacy row, treated as "approved at its current amount" everywhere (see
  // `effectiveBudgetApprovalStatus` in `@events-os/shared`) UNTIL its first
  // increase, which retriggers it into `"submitted"` (I1, `setBudgetAmount`).
  // Never write `"approved"` implicitly; only the `approveBudget` mutation
  // sets that literal value.
  approvalStatus: v.optional(
    v.union(...BUDGET_APPROVAL_STATUSES.map((s) => v.literal(s))),
  ),
  // The cap a budget is APPROVED to spend against — set (and refreshed) only by
  // `approveBudget`, at the amount then in force, OR stamped by
  // `setBudgetAmount`'s retrigger (a literally-approved budget's increase, or a
  // grandfathered budget's FIRST increase — I1). While a budget sits
  // `"submitted"`/`"changes_requested"` from a retrigger, this keeps the OLD,
  // still-in-force cap: `amountCents` has already moved to the new
  // (not-yet-approved) figure. Every numeric surface — cards, bars, over-cap
  // warnings — compares/displays against `effectiveCapCents` (`finances.ts`),
  // never `amountCents` alone.
  approvedCents: v.optional(v.number()),
  approvedByPersonId: v.optional(v.id("people")),
  approvedAt: v.optional(v.number()),
  submittedByPersonId: v.optional(v.id("people")),
  submittedAt: v.optional(v.number()),
  // The approver's note — a "why" on `changes_requested`, an optional remark
  // on `approved`. Cleared (patched to `undefined`) on a fresh decision with
  // no note.
  reviewNote: v.optional(v.string()),
  // WP-wave4 (item 8, owner addendum 2026-07-17) — TEMPORARY governance
  // relaxation: while the owner is solo-building/backfilling history, a
  // SUPERUSER may approve a budget they themselves submitted/edited
  // (bypassing the normal SoD identity block — everyone else still gets it).
  // Set ONLY by `approveBudget`, alongside `approvalStatus: "approved"`:
  // `"single"` when that decision took the self-approval bypass, `"two_party"`
  // for every normal (different-identity) approval. Absent on any budget
  // that has never been approved. A durable, re-reviewable record ("we can
  // even mark it as legacy approved... keep a record of approvers" — owner)
  // for when the org grows past one person — never overwritten by anything
  // other than a fresh `approveBudget` decision.
  approvalParty: v.optional(v.union(v.literal("single"), v.literal("two_party"))),
})
  .index("by_chapter", ["chapterId"])
  .index("by_chapter_and_period", ["chapterId", "year"])
  // Chapter-led so "budgets of type X" never matches another chapter's budgets.
  .index("by_chapter_and_type", ["chapterId", "type"])
  .index("by_category", ["categoryId", "year"])
  // Finds a one_time budget by what it's ATTACHED TO, independent of which
  // chapter/central level currently owns it (WP-2.2 finding: `by_chapter`
  // alone can't discover a project's budgets after they've moved scope — the
  // project's OWN `chapterId` never changes, so scoping the lookup to it
  // strands budgets that already transferred to central on a later reverse
  // transfer). `transferProjectScope` uses this to find ALL of a project's
  // budgets regardless of where they currently live.
  .index("by_ref", ["refKind", "scopeRefId"])
  // The chapter (or central) approval queue: "every budget of mine awaiting a
  // decision" — WP-3.2's attention-queue item + the FM's cross-chapter oversight
  // aggregate, both scan this instead of a full `by_chapter` + JS filter.
  .index("by_chapter_and_approval_status", ["chapterId", "approvalStatus"]);

// ── Budget approval log (WP-wave4 item 8-LOW, opus review 2026-07-17) ────────
/** APPEND-ONLY durable history of every budget workflow decision — the
 *  owner's own ask: "we can even mark it as legacy approved... keep a
 *  record of approvers." `budgets.approvalParty`/`approvedByPersonId`/
 *  `approvedAt`/`submittedByPersonId`/`submittedAt` are LAST-DECISION-ONLY
 *  (each field gets overwritten by the next send/approve/request-changes,
 *  and `moveBudgetScope` resets them on a scope move) — this table is the
 *  permanent record those fields can never be, one row per decision,
 *  NEVER updated or deleted once written (not even by `moveBudgetScope` or
 *  `deleteBudget` — a budget's own history outlives the row; nothing reads
 *  this table by `budgetId` expecting the parent to still exist). Written
 *  by `submitBudgetForApproval` ("sent"), `approveBudget` ("approved"),
 *  and `requestBudgetChanges` ("changes_requested") — never by anything
 *  else. Surfaced minimally today (`listBudgetApprovalLog`, the budget
 *  edit modal's compact history line); the record exists independent of
 *  whether today's UI reads it. */
export const budgetApprovalLog = defineTable({
  budgetId: v.id("budgets"),
  action: v.union(
    v.literal("sent"),
    v.literal("approved"),
    v.literal("changes_requested"),
  ),
  // Only meaningful for "approved" (the SoD axis item 8 widened) — "sent"
  // and "changes_requested" never take the superuser bypass, so they're
  // always effectively "two_party" but don't bother stamping it (nothing
  // reads it for those two actions).
  party: v.optional(v.union(v.literal("single"), v.literal("two_party"))),
  decidedByPersonId: v.id("people"),
  decidedAt: v.number(),
  note: v.optional(v.string()),
}).index("by_budget", ["budgetId"]);

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

// ── Budget lines (WP-3.1: the plan — "what are you gonna spend this on?") ───
/** One line in a v2 budget's planning breakdown: a categorized, described
 *  chunk of the budget's `amountCents` allocation. ESTIMATED-side only
 *  (invariant #2) — a budget line's `plannedCents` is NEVER summed with
 *  `transactions` actuals; it exists purely to answer "what is this budget
 *  FOR" before a dollar is spent. Named `budgetLines` to avoid colliding with
 *  the now-RETIRED per-EVENT `budgetLineItems` table (Budget v1, which also
 *  tracked an `actualCents` per line — migrated onto this table by
 *  `0026_migrate_budget_v1_lines`; see `moneyViews.ts`/`MoneyView.tsx` for the
 *  single event/project Money surface this table now feeds). Tenancy is
 *  resolved through the parent `budgets` row (a
 *  central budget's lines have no chapter to denormalize onto), so every
 *  read/write goes through the parent budget's scope gate. */
export const budgetLines = defineTable({
  budgetId: v.id("budgets"),
  description: v.string(),
  categoryId: v.optional(v.id("budgetCategories")),
  // Planned amount: a positive (non-zero) integer number of cents.
  plannedCents: v.number(),
  // Append order for a stable list within the budget.
  sortOrder: v.number(),
  createdBy: v.id("users"),
  createdAt: v.number(),
}).index("by_budget", ["budgetId"]);

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
  // R1a: a bookkeeper's freeform note — "who was this for and why" (business/
  // mission justification), distinct from `description` (provider-sourced, the
  // bank/card network's own merchant string — never author-edited). Set via
  // `finances.setTransactionNote`; capped at `MAX_NOTE_LENGTH`.
  note: v.optional(v.string()),

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
  // WP-4.1/4.2/4.5: the shared reference linking the two legs of a
  // central↔chapter transfer pair (a skim, launch grant, or settlement). Both
  // legs carry the SAME deterministic id (see `skimTransferGroupId`/
  // `launchTransferGroupId`/`settlementTransferGroupId`), which also serves as
  // the Increase account-transfer Idempotency-Key + the re-record guard. The
  // leg's `source` (`skim`/`launch_grant`/`settlement`) names the kind; its
  // `chapterId` (a real chapter vs the `"central"` sentinel) names the side.
  transferGroupId: v.optional(v.string()),
  // WP-4.5 ONLY: which way a `settlement` pair moved money — `skim`/
  // `launch_grant` never need this (their direction is FIXED by kind: a skim
  // is always chapter→central, a launch grant always central→chapter), but a
  // settlement can true-up the imbalance either way, and both legs otherwise
  // carry identical `flow:"transfer"` + `source:"settlement"` with no way to
  // tell which side paid. Both legs of a pair carry the SAME value (it
  // describes the pair, not the individual leg) — a reader resolves "did MY
  // scope give or receive" by comparing its own `chapterId` against this.
  transferDirection: v.optional(
    v.union(v.literal("central_to_chapter"), v.literal("chapter_to_central")),
  ),

  status: v.union(...TRANSACTION_STATUSES.map((s) => v.literal(s))),

  // AI auto-coding proposal (a human confirms; the model never moves money).
  aiSuggestion: v.optional(
    v.object({
      fundId: v.optional(v.id("funds")),
      categoryId: v.optional(v.id("budgetCategories")),
      // WP-U (one home per dollar): the model now proposes a BUDGET directly
      // instead of a separate event/project link — budgetId subsumes both.
      // `projectId`/`eventId` are kept below only so an OLD stored suggestion
      // (written before this PR) still validates; nothing writes them anymore
      // (see `aiCodingData.writeSuggestion`) — phase B drops them.
      budgetId: v.optional(v.id("budgets")),
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
      // Snapshot of the txn's OWN status/fund/category/budget at the exact
      // moment the model read it (`gatherSuggestionContext`, BEFORE the
      // OpenRouter call) — PR fix-suggest-broaden. `acceptSuggestion` diffs
      // this against the txn's LIVE values to detect a real human edit that
      // raced the suggestion (a stale `writeSuggestion` landing after a
      // manual edit already cleared the old suggestion), field-by-field —
      // not just a status flip, since a `categorized`-origin suggestion
      // (broadened eligibility) can be invalidated by a category/fund/budget
      // change alone without the status itself moving again. Optional: a
      // suggestion written before this field existed (or seeded directly in
      // a test) has none, and `acceptSuggestion` falls back to its original
      // unreviewed-only gate in that case.
      baseline: v.optional(
        v.object({
          status: v.union(...TRANSACTION_STATUSES.map((s) => v.literal(s))),
          fundId: v.union(v.id("funds"), v.null()),
          categoryId: v.union(v.id("budgetCategories"), v.null()),
          budgetId: v.union(v.id("budgets"), v.null()),
        }),
      ),
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
  .index("by_reimbursement", ["reimbursementId"])
  .index("by_transfer_group", ["transferGroupId"]);

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
  // Pre-approval-to-spend: when the claimant PLANS to make the purchase (ms
  // timestamp, noon-local by convention like line `transactionDate`). Only
  // ever set on a request created with `requestPreApproval` (enforced in
  // `createReimbursement`) — a normal submission is for money already spent,
  // so a "planned" date is meaningless there.
  plannedPurchaseDate: v.optional(v.number()),
  // When the ONE-SHOT "your planned purchase date has passed — submit your
  // receipts" follow-up email was sent (the daily reimbursement-reminder
  // cron). `undefined` = not sent yet; its presence is what makes the
  // follow-up fire exactly once (the recurring staleness nag is separate and
  // keeps applying afterwards).
  purchaseFollowUpSentAt: v.optional(v.number()),
  // What the spend was for (categorization is per line item). Mutually
  // exclusive (enforced in `createReimbursement`): at most ONE of
  // event/project/budget. `budgetId` must be a RECURRING budget belonging to
  // this chapter (an event/project's own budget is reached via
  // `eventId`/`projectId` instead, never `budgetId` directly).
  eventId: v.optional(v.id("events")),
  projectId: v.optional(v.id("projects")),
  budgetId: v.optional(v.id("budgets")),

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
  // REQUIRED (server-enforced in `createReimbursement`) for any line created
  // through the submit mutations — `v.optional` only so a pre-existing legacy
  // row (created before this field existed) still validates.
  receiptStorageId: v.optional(v.id("_storage")),
  // The date the money was actually spent — REQUIRED (server-enforced in
  // `createReimbursement`, sanity-checked: a finite ms timestamp, not more
  // than 48h in the future, not older than 3 years) for any line created
  // through the submit mutations. `v.optional` only so a pre-existing legacy
  // row (created before this field existed) still validates.
  transactionDate: v.optional(v.number()),
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
  // WP-C.1: true iff the card is `status:"locked"` because the CARDHOLDER
  // self-serve froze it (suspected foul play) — distinct from a manager's
  // `lockCard` and the receipt auto-lock (neither of which set this). Only the
  // SAME holder's `unfreezeCard` (or a manager's `unlockCard`, which clears
  // every lock reason at once) may reverse it. Absent/false for every other
  // "locked" reason.
  frozenByHolder: v.optional(v.boolean()),
  createdBy: v.optional(v.id("users")),
  createdAt: v.number(),
})
  .index("by_chapter", ["chapterId"])
  .index("by_cardholder", ["cardholderPersonId"])
  .index("by_increase_card", ["increaseCardId"])
  // Legacy-card matching: find a chapter's linked card by its last-4.
  .index("by_chapter_and_last4", ["chapterId", "last4"]);

// ── Card requests (WP-C.1: request-a-card) ───────────────────────────────────
/** A member's request for a card, decided by an FM/Treasurer — approving
 *  triggers the existing `issueCard` flow for `personId` (never self-serve
 *  issuance). At most one `"requested"` (open) row per person at a time
 *  (`cards.requestCard` enforces it). */
export const cardRequests = defineTable({
  chapterId: v.id("chapters"),
  personId: v.id("people"),
  status: v.union(...CARD_REQUEST_STATUSES.map((s) => v.literal(s))),
  note: v.optional(v.string()),
  requestedAt: v.number(),
  decidedBy: v.optional(v.id("people")),
  decidedAt: v.optional(v.number()),
  // The card `issueCard` created once approved.
  cardId: v.optional(v.id("cards")),
})
  .index("by_chapter", ["chapterId"])
  .index("by_person", ["personId"])
  // The manager Cards view's pending-requests list: one chapter's open requests.
  .index("by_chapter_and_status", ["chapterId", "status"]);

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
 *  decline from the monthly cap + validity + receipt-lock + merchant
 *  allow-list rules). Kept for audit + to reconcile against the eventual
 *  posted transaction. */
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

// ── Card merchant allow-list (chapter policy) ────────────────────────────────
/** The chapter's merchant allow-list for real-time card authorizations. ONE
 *  row per chapter (the `approvalPolicy` shape), managed by a finance manager.
 *  When `enforced` is true AND the list is non-empty,
 *  `cards.decideCardAuthorization` DECLINES any authorization whose merchant
 *  matches NO entry — name entries are case-insensitive substrings of the
 *  merchant descriptor, category entries exact 4-digit MCC matches. Unenforced
 *  (or empty) the list changes nothing. The arrays live on this one config doc
 *  deliberately: they're BOUNDED SMALL (entry-count + per-entry length caps in
 *  `cards.setMerchantPolicy`), far from any document limit. */
export const cardMerchantPolicy = defineTable({
  chapterId: v.id("chapters"),
  enforced: v.boolean(),
  // Case-insensitive substrings matched against the merchant descriptor.
  allowedMerchantNames: v.array(v.string()),
  // Exact 4-digit merchant category codes (MCCs).
  allowedMerchantCategories: v.array(v.string()),
  updatedByPersonId: v.optional(v.id("people")),
  updatedAt: v.number(),
}).index("by_chapter", ["chapterId"]);

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

// ── Reattribution audit (the split's ledger) ─────────────────────────────────
/** WP-2.2: one append-only row per BULK reattribution operation — the audit
 *  trail behind the retroactive split. A bulk `reassignTransactions` (many txns
 *  cross the central boundary), `transferProjectScope` (a project's budgets
 *  + txns move scope), or `transferEventScope` (the event twin) writes exactly
 *  ONE row here, capturing who, when, the txn ids touched (count =
 *  `transactionIds.length`), and a from→to summary.
 *
 *  ORG-LEVEL by nature: reattribution is a CENTRAL power that crosses the
 *  chapter boundary, so this table is NOT chapter-scoped like the rest of
 *  finance — it keys on the destination `target` (a real chapter, or the
 *  `"central"` sentinel) instead. The read query is central-gated. */
export const reattributionAudit = defineTable({
  // The kind of bulk operation this row records.
  kind: v.union(
    v.literal("bulk_reassign"),
    v.literal("project_transfer"),
    v.literal("event_transfer"),
  ),
  // Who did it: the auth user always; the roster person when the caller has one
  // (a superuser acting without a `people` row leaves `actorPersonId` unset).
  actorUserId: v.id("users"),
  actorPersonId: v.optional(v.id("people")),
  // The transactions moved by this operation (bounded per call; the count is the
  // array length). For a project transfer these are the project's linked txns.
  transactionIds: v.array(v.id("transactions")),
  // The destination scope the whole operation moved money TO.
  target: v.union(v.id("chapters"), v.literal("central")),
  // A human-readable from→to summary, e.g. "New York (12), Central (1) → Central".
  summary: v.string(),
  // TRUE UNDO (WP-2.2 fix): one entry per moved txn, snapshotting its EXACT
  // pre-move attribution (captured in the same mutation, before the
  // reassignment patch clears anything). Reattribution is lossy — category is
  // always cleared, fund is reset, project/event/team/person are cleared on a
  // move to central — so a swapped-target re-run of the forward op only
  // restores `chapterId`, not the coding it cleared. `restoreReattribution`
  // reads this array to put every field back exactly as it was. 1:1 with
  // `transactionIds` (same length, same order); bounded the same way the
  // forward ops are (`REASSIGN_BATCH_CAP` / `ROLLUP_SCAN_LIMIT`).
  priorStates: v.array(
    v.object({
      transactionId: v.id("transactions"),
      chapterId: v.union(v.id("chapters"), v.literal("central")),
      budgetId: v.optional(v.id("budgets")),
      fundId: v.optional(v.id("funds")),
      categoryId: v.optional(v.id("budgetCategories")),
      projectId: v.optional(v.id("projects")),
      eventId: v.optional(v.id("events")),
      eventItemId: v.optional(v.id("eventItems")),
      teamId: v.optional(v.id("financeTeams")),
      personId: v.optional(v.id("people")),
    }),
  ),
  // `project_transfer` only: the project whose scope moved + how many of its
  // budgets moved with it (txn count is `transactionIds.length`).
  projectId: v.optional(v.id("projects")),
  // `event_transfer` only: the event twin of `projectId` above.
  eventId: v.optional(v.id("events")),
  budgetsMoved: v.optional(v.number()),
  // Optional operator note (why this split move was made).
  note: v.optional(v.string()),
  createdAt: v.number(),
})
  .index("by_created", ["createdAt"])
  .index("by_target", ["target"]);

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

// ── Inbound email receipts (backfill pipeline) ───────────────────────────────
/** ONE inbound email routed to the receipt-ingest webhook
 *  (`reply.publicworship.life` → Resend `email.received` → `/resend/inbound`).
 *  This table is BOTH the idempotency ledger (deduped on the provider's
 *  `emailId` via `by_email_id`, the same first-sight guard `webhookEvents`
 *  gives the Stripe/Increase handlers) AND the operational state of the
 *  OCR→match pipeline, so a redelivery no-ops and a human can see every email
 *  that ever came in and what became of it.
 *
 *  NOT strictly chapter-scoped at insert time: the webhook commits a `pending`
 *  row BEFORE the sender is resolved to a person/chapter (mirrors
 *  `webhookEvents`' "deduped before a chapter can be resolved" rule). Once the
 *  `processInboundReceipt` action resolves the sender it stamps `chapterId`
 *  (a real chapter — inbound card receipts are chapter-owned) so the review
 *  queue can scope by chapter.
 *
 *  Money is only ever MOVED by the existing `attachReceipt`-equivalent path
 *  (`receiptInbox.attachMatchedReceipt`); this table records provenance +
 *  the AI's OCR read, never a categorization the model made on its own. */
export const inboundReceipts = defineTable({
  // The PROVIDER'S unique message id — the idempotent dedup key. Resend's
  // `email_id` for an `email`-channel row; Twilio's `MessageSid` for an
  // `sms`-channel row (also mirrored onto `smsMessageSid` below, which carries
  // its own dedup index — belt-and-suspenders, since this field predates the
  // SMS channel and other code still keys off it as "the" provider id).
  emailId: v.string(),
  status: v.union(...INBOUND_RECEIPT_STATUSES.map((s) => v.literal(s))),
  // Envelope, captured verbatim from the webhook for the review queue + audit.
  // For an `sms` row `fromEmail` holds the sender's PHONE NUMBER (kept for
  // back-compat with every reader of this required field) — `fromPhone` below
  // is the honestly-typed field new code should read.
  fromEmail: v.string(),
  toEmail: v.optional(v.string()),
  subject: v.optional(v.string()),
  receivedAt: v.number(),

  // ── SMS/MMS channel (Twilio) ────────────────────────────────────────────────
  // Absent = `email` (the original, still-default channel — see `receiptInbox.ts`).
  // `sms` = the Twilio inbound webhook (`http.ts`'s `/twilio/receipts`,
  // `smsReceipts.ts`).
  channel: v.optional(v.union(v.literal("email"), v.literal("sms"))),
  // Twilio's `MessageSid` — the SMS-specific dedup key (`by_sms_sid`), kept
  // alongside the `emailId` reuse above so an SMS-specific lookup never has to
  // reason about the shared field's dual meaning.
  smsMessageSid: v.optional(v.string()),
  // The sender's phone number (E.164 or whatever Twilio's `From` sent) — the
  // honest field for an `sms` row. See `fromEmail`'s doc comment above for why
  // the phone is ALSO mirrored there.
  fromPhone: v.optional(v.string()),

  // Resolved sender + the chapter its transactions live in. Both absent until
  // the action runs; an UNKNOWN sender (no `people` match) is still processed
  // end-to-end (owner decision, 2026-07-23 — the sender gate is open) but has no
  // `personId` and, with no chapter to infer, no `chapterId` either. `ignored`
  // now means a bookkeeper dismissed the row (or it was non-receipt mail), not
  // "unknown sender".
  personId: v.optional(v.id("people")),
  chapterId: v.optional(v.id("chapters")),
  // How much the sender is trusted — the AUTOMATION axis (never a permission).
  // Only `team`/`roster` (a resolved roster member) may auto-attach; an
  // `internal`/`external` email always routes to human review. Optional so
  // legacy rows (predating classification) still validate.
  senderClass: v.optional(
    v.union(...RECEIPT_SENDER_CLASSES.map((c) => v.literal(c))),
  ),

  // The stored receipt file (first image/PDF attachment, or a rendered body
  // when the email itself IS the receipt). Absent on an `ignored`/`error` row
  // that never got as far as storing anything.
  receiptStorageId: v.optional(v.id("_storage")),
  // What kind of thing we OCR'd — an attachment vs the email body text — so the
  // review UI can show "photo" vs "email text" without re-deriving it.
  sourceKind: v.optional(v.union(v.literal("attachment"), v.literal("body"))),

  // ── OCR result (the model reads the receipt; a human/auto-match uses it) ────
  // Extracted TOTAL in integer cents (the invariant across finance), the
  // receipt DATE (ms, noon-local by the `transactionDate` convention), and the
  // merchant string. All optional — a low-quality scan may yield none.
  ocrAmountCents: v.optional(v.number()),
  ocrDate: v.optional(v.number()),
  ocrMerchant: v.optional(v.string()),
  ocrModel: v.optional(v.string()),
  // The model's own confidence (0–1) that it read a real, complete total.
  ocrConfidence: v.optional(v.number()),

  // ── Match outcome ──────────────────────────────────────────────────────────
  // The transaction the receipt was attached to (auto or via a manual pick).
  matchedTransactionId: v.optional(v.id("transactions")),
  // The candidates the matcher surfaced for a `needs_review` row (bounded —
  // the matcher caps how many it returns), so the review UI can render the
  // shortlist without re-scanning. 1:1 with what `findReceiptMatches` returned.
  candidateTransactionIds: v.optional(v.array(v.id("transactions"))),
  // Who resolved a `needs_review` row by hand, and when (audit).
  resolvedByPersonId: v.optional(v.id("people")),
  resolvedAt: v.optional(v.number()),

  // A human-readable note on WHY a row landed where it did (e.g. "sender
  // not on roster", "no unreceipted charge for $42.10 within 14 days",
  // "OCR could not read a total"). Surfaced in the review queue.
  detail: v.optional(v.string()),

  createdAt: v.number(),
  updatedAt: v.number(),
})
  // The idempotency guard: first-sight lookup by the provider's email id.
  .index("by_email_id", ["emailId"])
  // The idempotency guard for the SMS channel: first-sight lookup by Twilio's
  // MessageSid (`smsReceipts.ts#recordSmsReceipt`).
  .index("by_sms_sid", ["smsMessageSid"])
  // The review queue: "every inbound receipt in state X", newest first.
  .index("by_status", ["status"])
  // Scope the review queue to one chapter once the sender is resolved.
  .index("by_chapter", ["chapterId"]);

// ── Receipts (first-class documents, many-to-many with transactions) ─────────
/** A first-class receipt DOCUMENT — the source of truth a receipt is, decoupled
 *  from any single transaction. A receipt links to MANY transactions (a split
 *  bill, a shared card charge) and a transaction can carry MANY receipts, via
 *  `receiptLinks`. `transactions.receiptStorageId` survives as a DENORMALIZED
 *  cache of "a" (the first-linked) receipt's file, so every existing reader —
 *  the reconcile `missing_receipt` filter, the receipt reminders, the 7-day
 *  card auto-lock, the `hasReceipt` display — keeps working unchanged; the
 *  `receiptLinks` layer is the new source of truth those denorm writes flow
 *  from (see `lib/receiptLinks.ts`, the ONLY write path).
 *
 *  CANONICAL vs OCR fields: the `ocr*` fields are IMMUTABLE provenance — exactly
 *  what the model/parser read off the document, never edited after creation.
 *  The canonical `amountCents`/`receiptDate`/`merchant`/`note` are the
 *  HUMAN-CORRECTABLE truth: seeded FROM the OCR values at creation, then edited
 *  only by a later correction mutation (NOT in this PR) which stamps
 *  `correctedByPersonId`/`correctedAt` and touches canonical fields ALONE — the
 *  `ocr*` provenance stays frozen so "what did the model see" is always
 *  recoverable. `chapterId` mirrors `transactions.chapterId` (a real chapter or
 *  the `"central"` sentinel). */
export const receipts = defineTable({
  // A real chapter or the `"central"` sentinel. OPTIONAL because an email from
  // an UNKNOWN sender (no roster match) is still processed and stored (owner
  // decision, 2026-07-23) but has no chapter to infer — those rows surface only
  // in the org-wide receipt view, never a chapter-scoped read. Upload/backfill
  // and resolved-sender email receipts always carry a chapter.
  chapterId: v.optional(v.union(v.id("chapters"), v.literal("central"))),
  // The stored receipt file (image/PDF, or a rendered email body).
  storageId: v.id("_storage"),
  // How the document entered the system (email pipeline vs in-app upload).
  source: v.union(...RECEIPT_SOURCES.map((s) => v.literal(s))),
  // Provenance when this document came from the inbound-email pipeline — the
  // `inboundReceipts` row it was extracted from. Absent for direct uploads.
  inboundReceiptId: v.optional(v.id("inboundReceipts")),
  // Who uploaded it, when resolvable (the in-app upload path's caller).
  uploadedByPersonId: v.optional(v.id("people")),
  // For an email-sourced receipt: how much its sender was trusted (copied from
  // the `inboundReceipts` row). Governs whether the pipeline auto-attached it or
  // routed it to review. Absent for uploads/backfill. Optional for legacy rows.
  senderClass: v.optional(
    v.union(...RECEIPT_SENDER_CLASSES.map((c) => v.literal(c))),
  ),

  // ── CANONICAL (human-correctable) fields — seeded from OCR at creation ──────
  // The receipt's TOTAL in integer cents, its DATE (ms, noon-local by the
  // `transactionDate` convention), the merchant, and a freeform note. All
  // optional: a backfilled legacy document has no read total (we never
  // fabricate one), and a low-quality scan may yield none.
  amountCents: v.optional(v.number()),
  receiptDate: v.optional(v.number()),
  merchant: v.optional(v.string()),
  note: v.optional(v.string()),

  // ── IMMUTABLE OCR provenance — exactly what the model/parser read ───────────
  ocrAmountCents: v.optional(v.number()),
  ocrDate: v.optional(v.number()),
  ocrMerchant: v.optional(v.string()),
  ocrConfidence: v.optional(v.number()),
  ocrModel: v.optional(v.string()),
  // RECEIPT QUALITY PR: a human-readable reason extraction produced NOTHING —
  // a model/network error, an unsupported file type, a scanned PDF with no
  // text layer and an unreadable scan, an empty email body. Historically these
  // failures only ever hit `console.log` and the receipt detail just showed
  // blank OCR fields with no explanation (the "OCR read: — · — · —" bug).
  // Cleared (patched to `undefined`) the moment a LATER extraction (a retry,
  // or — for the upload path — the original pipeline run) succeeds, so a
  // stale failure never lingers next to a fresh, successful read.
  ocrError: v.optional(v.string()),
  // The ORIGINAL attachment filename this receipt came from (e.g.
  // "receipt.pdf"), or a synthetic label when there was no file name to carry
  // — "email body" (the message text itself was the receipt) / "text
  // message" (the SMS channel's body). Absent on legacy rows that predate
  // this field. Purely descriptive — never used for routing.
  filename: v.optional(v.string()),

  // Set by the (future) correction mutation when a human edits a canonical
  // field away from its OCR seed — audit of who last corrected it, and when.
  correctedByPersonId: v.optional(v.id("people")),
  correctedAt: v.optional(v.number()),

  // The match shortlist surfaced for review (per-receipt candidates the matcher
  // returned) — bounded, so it can live inline. Mirrors the copy the pipeline
  // keeps on `inboundReceipts.candidateTransactionIds` for the review queue.
  candidateTransactionIds: v.optional(v.array(v.id("transactions"))),

  // Denormalized count of `receiptLinks` rows pointing at this receipt — kept in
  // lock-step by `lib/receiptLinks.ts` (Convex has no count operator). Powers
  // the "unmatched receipts" query via `by_chapter_and_linkCount` without a scan.
  linkCount: v.number(),

  // ── CRM PR: duplicate detection ─────────────────────────────────────────────
  // The stored file's content hash (from the `_storage` system table's own
  // `sha256`, read at creation time — never computed by hand). Lets an EXACT
  // re-submission of the same bytes be caught regardless of how it arrived
  // (a mass-upload re-drop, or the same photo emailed twice) — see
  // `lib/receiptLinks.ts#findDuplicateReceiptBySha256` (chapter-scoped lookup)
  // and `receipts.ts#submitUploadedReceipts` / `receiptInbox.ts#commitInboundReceipts`
  // (both stamp it at creation). Optional: legacy receipts (pre-dating this
  // field) and any document whose storage metadata lookup failed have none.
  fileSha256: v.optional(v.string()),
  // Set when this receipt's file exactly duplicates an EARLIER receipt in the
  // same chapter (same `fileSha256`) — points at the earlier (kept) receipt.
  // A duplicate is still stored (never silently dropped — a human may still
  // want to see it) but is never auto-attached and is flagged for review.
  duplicateOfReceiptId: v.optional(v.id("receipts")),
  // RECEIPT QUALITY PR: a bookkeeper's "I checked, this isn't a duplicate"
  // — set by `receipts.dismissDuplicateFlag`. Additive + PER-RECEIPT: only
  // ever silences THIS receipt's own `softDuplicate` output (see
  // `computeSoftDuplicates`); an undismissed sibling that still collides on
  // the same amount+date keeps flagging on its own. Never touches the
  // EXACT-file `duplicateOfReceiptId` relationship above — that's a
  // different, stronger signal with its own "jump to original" UI, not
  // dismissible here. Absent (falsy) is the default — every existing row.
  duplicateDismissed: v.optional(v.boolean()),

  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index("by_chapter", ["chapterId"])
  // The "unmatched receipts" query: a chapter's receipts with linkCount 0.
  .index("by_chapter_and_linkCount", ["chapterId", "linkCount"])
  // Find the receipt(s) extracted from a given inbound email (manual-match).
  .index("by_inbound", ["inboundReceiptId"])
  // Exact-duplicate detection: find every receipt sharing a stored file's
  // content hash (chapter-filtered in JS by the caller — bounded, since a
  // real hash collision among a chapter's receipts is rare).
  .index("by_sha256", ["fileSha256"]);

/** ONE receipt↔transaction link — the many-to-many join that is the SOURCE OF
 *  TRUTH for which receipts back which charges. Written ONLY through
 *  `lib/receiptLinks.ts` (`linkReceiptToTransaction`/`unlinkReceiptFromTransaction`),
 *  which keeps `receipts.linkCount` and the `transactions.receiptStorageId`
 *  denorm cache consistent. `chapterId` is denormalized from the transaction so
 *  tenancy checks don't need to load either parent. */
export const receiptLinks = defineTable({
  receiptId: v.id("receipts"),
  transactionId: v.id("transactions"),
  // Denormalized from the linked transaction (a real chapter or "central").
  chapterId: v.union(v.id("chapters"), v.literal("central")),
  source: v.union(...RECEIPT_LINK_SOURCES.map((s) => v.literal(s))),
  linkedByPersonId: v.optional(v.id("people")),
  createdAt: v.number(),
})
  .index("by_receipt", ["receiptId"])
  .index("by_transaction", ["transactionId"]);

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
})
  .index("by_key_and_time", ["key", "createdAt"])
  // Deployment-wide TTL sweep (maintenance.ts): drop rows older than the rate
  // window regardless of key.
  .index("by_time", ["createdAt"]);

// ── Card details reveal rate limit (WP-C.3) ──────────────────────────────────
/** A single timestamped hit against the HOLDER-ONLY `cards.revealCardDetails`
 *  action — the most sensitive read in the app (a card's PAN + expiry + CVC).
 *  Same shape/index as `reimbursementSubmitAttempts` (#134): `key` is
 *  `"card:<cardId>"`, one row inserted per AUTHORIZED ATTEMPT — recorded once
 *  the holder-only + rate-limit checks pass, before the Increase details fetch
 *  even runs (not gated on that fetch succeeding) — checked+recorded
 *  atomically via `by_key_and_time` inside `cards.beginRevealCardDetails`. This
 *  table NEVER stores the card details themselves — only a timestamp. See
 *  `cards.ts` for the threshold + rationale. */
export const cardDetailsRevealAttempts = defineTable({
  key: v.string(),
  createdAt: v.number(),
})
  .index("by_key_and_time", ["key", "createdAt"])
  // Deployment-wide TTL sweep (maintenance.ts): drop rows older than the rate
  // window regardless of key.
  .index("by_time", ["createdAt"]);

// ── Manual receipt-nudge rate limit (Chase Receipts "Send reminder") ────────
/** A single timestamped hit against the FM-only manual chase nudge
 *  (`cards.sendReceiptNudge`, called from the Chase Receipts page's "Send
 *  reminder"/"Remind all" buttons) — SAME shape/index as
 *  `cardDetailsRevealAttempts`/`reimbursementSubmitAttempts`: `key` is
 *  `"person:<personId>"`, one row inserted per nudge actually SENT (email
 *  attempted), checked+recorded atomically inside
 *  `cards.beginManualNudgeAttempt`. Caps a cardholder at ONE manual nudge per
 *  24h — a second click inside the window is a no-op the UI reads as
 *  "Nudged today" rather than an error. Longer window than the other two
 *  attempt tables (1h), so it is swept on its OWN schedule, not folded into
 *  their shared sweep — see `maintenance.ts`. */
export const receiptNudgeAttempts = defineTable({
  key: v.string(),
  createdAt: v.number(),
})
  .index("by_key_and_time", ["key", "createdAt"])
  // TTL sweep (maintenance.ts): drop rows older than the 24h rate window.
  .index("by_time", ["createdAt"]);

/** Increase REVIEWS a Digital Card Profile before it can be attached to a
 *  card — it's minted `"pending"` and Increase (and/or the card network)
 *  resolves it to `"active"` (safe to attach) or `"rejected"` (re-upload art
 *  per Increase's feedback and re-mint). `increase.ts`'s
 *  `refreshCardArtProfileStatus` polls `GET /digital_card_profiles/{id}` and
 *  writes whatever it finds here. */
const cardArtProfileStatusValidator = v.union(
  v.literal("pending"),
  v.literal("active"),
  v.literal("rejected"),
);

/** One environment's worth of Digital Card Profile config (WP-C.2 — the PW
 *  card art pipeline): the two uploaded `POST /files` ids (card art `1536x969`
 *  + the `100x100` app icon) and, once minted, the Digital Card Profile id
 *  built from them. `profileId` is deliberately separate from the file ids —
 *  Digital Card Profiles are immutable, so re-uploading new art only refreshes
 *  the file ids; a NEW profile referencing them is a distinct, explicit step
 *  (`createDigitalCardProfile`) that leaves the old (now-stale) `profileId` in
 *  place until it's re-run. `profileStatus` tracks Increase's review of THAT
 *  profile (see `cardArtProfileStatusValidator`) — `increase.ts`'s
 *  `getCardArtProfileId` only surfaces `profileId` for attach once this reads
 *  `"active"`, so a pending/rejected profile never silently attaches to
 *  issued cards. */
const cardArtConfigValidator = v.object({
  fileId: v.string(),
  iconFileId: v.string(),
  profileId: v.optional(v.string()),
  profileStatus: v.optional(cardArtProfileStatusValidator),
});

// ── Finance settings (deployment-wide singleton) ─────────────────────────────
/** Deployment-wide finance settings (one row, the `aiSettings` pattern).
 *  `sandboxMode` is the runtime testing toggle: when true, NEW Increase account
 *  provisioning targets the Increase SANDBOX (sandbox entity + key + base) so the
 *  whole finance layer can be exercised without touching real money. Existing
 *  accounts always self-select their environment from their `sandbox_` id prefix,
 *  so flipping this can never misroute already-provisioned money. Superuser-only.
 *
 *  `cardArt`/`cardArtSandbox` (WP-C.2): mirrors `increaseAccounts.sandbox` — up
 *  to ONE config per Increase environment, so a sandbox test upload and the
 *  real production art can coexist without clobbering each other. Uploading
 *  and profile creation (no card exists yet) target whichever environment the
 *  live `sandboxMode` toggle points at, same as `runProvisionFlow`; attaching
 *  to a card (issuance or the backfill) instead reads the CARD's own
 *  `increaseCardId` prefix (see `increase.ts`'s `getCardArtProfileId`) — the
 *  same self-identifying-id convention as every other Increase object here. */
export const financeSettings = defineTable({
  sandboxMode: v.boolean(),
  updatedBy: v.optional(v.id("users")),
  updatedAt: v.number(),
  cardArt: v.optional(cardArtConfigValidator),
  cardArtSandbox: v.optional(cardArtConfigValidator),
  // Org-wide receipt policy: after this many days a card charge still missing a
  // receipt auto-converts to a personal repayment (the cardholder owes it back).
  // `undefined` = OFF (no auto-conversion) until central finance picks a number.
  // Enforced by the daily `cards.autoConvertOverdueReceipts` sweep.
  noReceiptAutoConvertDays: v.optional(v.number()),
  // Org-wide card prerequisite: the Academy course slug a member must complete
  // before a card can be issued/activated. `undefined` = no prerequisite gate
  // (issuance unaffected), so cards keep working until central finance points
  // this at Kansi's card-prerequisite course.
  cardPrerequisiteCourseSlug: v.optional(v.string()),
});
