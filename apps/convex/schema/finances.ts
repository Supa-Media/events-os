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
  PAYOUT_PROCESSORS,
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
  RECEIPT_EXCEPTION_REASONS,
  RECEIPT_EXCEPTION_STATUSES,
  EXPENSE_TYPES,
  ATTENDEE_AFFILIATIONS,
  TRANSACTION_CODING_STATUSES,
  LEGACY_ACCOUNT_STATUSES,
  FINANCE_ROLES,
  FINANCE_ROLE_SCOPES,
  SPECIALIZED_ROLE_TITLES,
  SPECIALIZED_ROLE_KINDS,
  FINANCE_AUDIT_ACTIONS,
  AUTO_TRANSFER_ORIGINS,
  STRIPE_PAYOUT_PROCESS_STATES,
  RECONCILIATION_FLAG_KINDS,
  RECONCILIATION_FLAG_STATUSES,
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
  // The bookkeeper's READABLE rename of the row's merchant slot — "Costco" for
  // `IC* COSTCO BY IN CAR`, "Amazon" for `AMAZON MKTPL*56OXD2TB2`. Written
  // ONLY by `finances.renameMerchant`; cleared by `clearMerchantRename`.
  //
  // A SEPARATE FIELD, deliberately, rather than an edit to `merchantName`
  // above. `merchantName`/`description` are what the bank or processor
  // actually sent — that is provenance, and it is not ours to destroy. An
  // auditor asking "what did the statement say" must always be able to get the
  // original back, and a rename must never be able to launder a row into
  // looking like something else. Storing the human name BESIDE the provider's
  // makes that property structural instead of a rule someone has to remember:
  // no code path can overwrite the original, because no code path writes to
  // it. Every reader resolves the two through `displayMerchantName`
  // (`@events-os/shared`).
  //
  // Contrast `finances.correctTransaction`, which DOES rewrite `merchantName`
  // — it is restricted to `manual` rows (`lib/financeEditAccess.ts`), which
  // are standalone human assertions with no provider claim to preserve.
  merchantNameOverride: v.optional(v.string()),
  // When this row was last renamed. Set (never cleared) by BOTH
  // `renameMerchant` and `clearMerchantRename`, because the trail outlives the
  // override: rename-then-clear leaves no override but still has a history
  // worth reading.
  //
  // Denormalized purely so the Reconcile grid can decide whether to render the
  // history icon at all — the owner asked for the affordance only on rows that
  // actually have history, and an icon on every row is noise. The history
  // ITSELF lives in `financeAuditLog` (one shared audit table every finance
  // surface writes to — see that table's doc comment); the alternative here
  // was a `by_subject` lookup PER ROW on every grid render, i.e. a hundred
  // extra reads to answer one boolean. This field is a rendering hint and
  // nothing else — never the record of a rename.
  merchantNameRenamedAt: v.optional(v.number()),
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
  // RETIRED DIMENSION (2026-08-05). This is a cost-center field — code a charge
  // to a department — and it has never been written by anything: no screen sets
  // it, and the one query that read it (`finances.teamActuals`, now deleted)
  // filtered on it and so could only ever return zero, with no callers.
  //
  // The column stays because legacy rows may hold a value and dropping an
  // optional field that live documents carry would break their validation; it
  // is NOT a supported input. `categorizeTransaction` and
  // `createManualTransaction` reject it explicitly rather than silently
  // accepting a value nothing reads.
  //
  // If a real cost-center dimension is ever wanted, this is the field to
  // revive — but note the app already classifies spend three other ways
  // (budget = what for, `budgetCategories` = what kind, `budgetTags` =
  // cross-cutting rollups), so the first question is whether a fourth earns
  // its place on every row of the reconcile queue.
  teamId: v.optional(v.id("financeTeams")),
  personId: v.optional(v.id("people")),
  engagementId: v.optional(v.id("engagements")),
  cardId: v.optional(v.id("cards")),
  reimbursementId: v.optional(v.id("reimbursementRequests")),
  // The shared reference linking the two legs of a central↔chapter transfer
  // pair. Both legs carry the SAME id (see `transfers.ts#genericTransferGroupId`
  // — random-but-explicit, not deterministic; a generic transfer has no
  // natural per-period key the way the retired skim/launch-grant/settlement
  // kinds did). The leg's `source` (`"transfer"` for every new row; the
  // historical `skim`/`launch_grant`/`settlement` literals only appear on
  // rows written before the 2026-07-26 collapse to one generic transfer —
  // see `transfers.ts`'s header comment) names the kind; its `chapterId` (a
  // real chapter vs the `"central"` sentinel) names the side.
  transferGroupId: v.optional(v.string()),
  // Which way a transfer pair moved money. Every NEW transfer sets this
  // (there's no more "direction implied by kind" — a skim was always
  // chapter→central, a launch grant always central→chapter; a generic
  // transfer states it explicitly every time, same as the historical
  // `settlement` kind always did). Both legs otherwise carry identical
  // `flow:"transfer"` + `source:"transfer"` with no way to tell which side
  // paid. Both legs of a pair carry the SAME value (it describes the pair,
  // not the individual leg) — a reader resolves "did MY scope give or
  // receive" by comparing its own `chapterId` against this.
  //
  // UNSET for a MARKED internal transfer (`finances.markAsTransfer`): both
  // literals describe a central<->chapter crossing, and a bookkeeper marking
  // two already-ingested bank rows is usually moving money between two of the
  // org's OWN accounts inside ONE scope, where neither is true. Direction is
  // already unambiguous there without it — a marked pair is required to be one
  // `outflow` leg and one `inflow` leg, so the sign names the side. A marked
  // leg also KEEPS its ingest `source` (`stripe_fc`, `relay_csv`, ...) rather
  // than being rewritten to `"transfer"`: the row really did come from the
  // bank feed and provenance is not ours to overwrite. (`source` is NOT how a
  // marked leg is identified though — `preMarkFlow` below is; see
  // `finances.ts#isMarkedTransfer`.)
  transferDirection: v.optional(
    v.union(v.literal("central_to_chapter"), v.literal("chapter_to_central")),
  ),
  // The leg's ingest-time `flow`, captured when `finances.markAsTransfer`
  // overwrote it with `"transfer"`. Marking is REVERSIBLE and `flow` is the
  // bank's own statement of direction, so it has to survive the round trip:
  // once both legs read `flow:"transfer"` there is otherwise nothing left
  // anywhere to say which side paid — `amountCents` is always non-negative,
  // and `transferDirection` is unset on a marked (same-scope) pair. Set ONLY
  // on a marked leg; `unmarkTransfer` restores it and clears this.
  //
  // Doubles as THE marker for "this transfer was marked, not created" —
  // `finances.ts#isMarkedTransfer` keys off its presence. That matters because
  // the app writes `flow:"transfer"` legs under several sources
  // (`reimbursement`, `repayment`, the retired `skim`/`launch_grant`/
  // `settlement` kinds on historical rows), and none of those are markable or
  // un-markable; only a row this feature touched carries this field.
  preMarkFlow: v.optional(v.union(v.literal("outflow"), v.literal("inflow"))),
  // Which automatic process booked this transfer pair, when one did. ABSENT =
  // a human recorded it (`transfers.recordTransfer`, and every pre-engine
  // row). Set on BOTH legs by the morning reconciliation engine
  // (`reconciliation.ts`) — `"payout_allocation"` distributes a Stripe
  // payout's per-chapter revenue shares; `"auto_settlement"` trues up
  // `interScopeBalances`' cross-book card spend. Readers that interpret
  // transfer pairs as HUMAN money decisions must exclude engine rows:
  // the City Launch Fund position skips both origins (revenue distribution
  // is not a skim/grant), and `interScopeBalances`' settling legs skip
  // `payout_allocation` (revenue doesn't pay down a card imbalance).
  transferOrigin: v.optional(
    v.union(...AUTO_TRANSFER_ORIGINS.map((o) => v.literal(o))),
  ),
  // The Stripe payout this row was matched to by the reconciliation engine —
  // set on the central bank DEPOSIT row (`increase_ach`/`stripe_fc` inflow)
  // when the engine identifies it as the arrival of payout `po_…`, alongside
  // `payoutProcessor:"stripe"`. Display/audit link only; the payout's own
  // record lives in `stripePayouts` (which stores the reverse link).
  stripePayoutId: v.optional(v.string()),

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

  // Processor payout marking (`finances.markAsPayout`): a settlement deposit
  // from Givebutter/Stripe, batching many donations into one bank inflow.
  //
  // This is a LABEL — a marked payout keeps `flow:"inflow"` and is never
  // rewritten to `flow:"transfer"` (a transfer is money between two of the
  // org's own accounts; this arrived from outside). Under the 2026-08-07
  // book-value model the label is also the anti-double-count switch: revenue
  // is counted at the GIVING layer (`gifts` + ticket orders), so a LABELED
  // deposit contributes zero to book value (`lib/bookBalance.ts`) while an
  // unmarked one still counts as plain inflow until a human marks it. See
  // `PAYOUT_PROCESSORS` (`@events-os/shared`) for the full model.
  payoutProcessor: v.optional(
    v.union(...PAYOUT_PROCESSORS.map((p) => v.literal(p))),
  ),

  // RECONSTRUCTED HISTORY marker: which historical import wrote this row (a
  // batch label, e.g. "genesis-2026-08"). Absent on everything observed as it
  // happened — a bank sync, a card charge, an in-app manual entry.
  //
  // Not a permission field: correcting a row is gated on `source` (see
  // `isCorrectableSource`), not on this. It exists so the ledger can SAY which
  // of its rows were rebuilt from a spreadsheet or a Notion doc rather than
  // watched. A published ledger that silently mixes the two is overclaiming.
  //
  // Rows from the ORIGINAL genesis backfill carry no value here and don't need
  // one — their `externalId` already starts with `genesis-`, which
  // `isReconstructedHistory` recognizes, so nothing had to be migrated.
  historicalImportBatch: v.optional(v.string()),

  // Provenance / dedup. `externalId` is the provider's unique id for the row
  // (Increase transaction id, Stripe FC transaction id) — the idempotent sync
  // dedup key. `sourceAccountId` is the Increase/legacy account it came from.
  externalId: v.optional(v.string()),
  sourceAccountId: v.optional(v.string()),
  // A REFUND pairing, marked by a human in Reconcile (`finances.markAsRefund`).
  // The charge carries `refundedByTransactionId`; the credit that reversed it
  // carries `refundsTransactionId`. Both, so either row can be read on its own.
  //
  // Book value never needed this — a charge and its refund already net to zero
  // there. BUDGETS did: `isSpend` is outflow-only, so a credit can't reduce a
  // category no matter how it's coded, and a refunded charge went on counting
  // against its budget forever. A $676.40 Peerspace booking that was refunded
  // the next day still showed as $676.40 spent on Pop The Balloon.
  //
  // FULL refunds only. A partial one has to leave the charge counting for the
  // part that stuck, which needs signed spend sums rather than a boolean — a
  // much larger change, and refusing it outright beats half-doing it.
  refundedByTransactionId: v.optional(v.id("transactions")),
  refundsTransactionId: v.optional(v.id("transactions")),

  // Pending (authorization) vs posted (settled) lifecycle from the card network.
  pending: v.optional(v.boolean()),
  authorizedAt: v.optional(v.number()),

  // A single attached receipt (line-level receipts live on reimbursement lines).
  receiptStorageId: v.optional(v.id("_storage")),

  // The APPROVED receipt exception standing in for a receipt on this row —
  // the documentation of record when no receipt can be produced (see the
  // `receiptExceptions` table below and `docs/plans/receipt-exceptions.md`).
  //
  // DENORMALIZED POINTER, single-writer: set ONLY while an exception is
  // `approved`, cleared the moment it's withdrawn/superseded, and written by
  // exactly ONE module (`lib/receiptExceptions.ts`). The field name says
  // `approved` precisely so no reader has to go re-check the row's status to
  // learn what the pointer means — the same discipline `repaymentId` uses,
  // and the reason the pure predicates (`needsDocumentation`,
  // `cards.ts#isMissingReceiptCharge`) can consult it without a db read. A
  // PENDING exception is deliberately NOT reflected here: it isn't
  // documentation yet, and a row shouldn't leave the chase because someone
  // asked to be let off. Pending rows are found via `by_transaction`.
  approvedReceiptExceptionId: v.optional(v.id("receiptExceptions")),

  // The transaction's CODING state — where its substantiation record
  // (`transactionCodings`, at most one row per transaction) sits in review.
  // DENORMALIZED, single-writer (`lib/transactionCoding.ts`), same discipline
  // as `approvedReceiptExceptionId` above: mirrors the coding row's `status`
  // exactly, so the reconcile grid's `uncoded`/`coding_review` facets and the
  // `CODING_REQUIRED` reconcile gate read it without a join. `undefined` =
  // no coding has ever been submitted (whether that means "uncoded backlog"
  // is the POLICY's call — `requiresCoding` in `finances.ts` consults
  // `codingRequiredSinceMs`, so pre-policy history doesn't light up).
  codingState: v.optional(
    v.union(...TRANSACTION_CODING_STATUSES.map((s) => v.literal(s))),
  ),

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

// ── Processor-fee entries (the evidence behind one monthly fee row) ──────────
/** ONE row per fee-bearing processor ledger entry — the receipt for the single
 *  monthly `transactions` row `processorFees.ts` books.
 *
 *  That row is a rollup on purpose (264 sub-dollar charges would bury the
 *  reconcile grid), but a rollup with nothing under it is a number you have to
 *  take on faith: "it doesn't keep a record of which transactions have fees, so
 *  it feels like a made up number" (owner, 2026-08-08). This table is that
 *  record. `sum(feeCents) WHERE month = M` EQUALS the month's fee row
 *  `amountCents` — that equality is the whole point, and
 *  `processorFees.feeRowDetail` is what a treasurer reads to check it.
 *
 *  NOT chapter-scoped, deliberately. These entries belong to the Stripe ACCOUNT
 *  (org-level); which chapter's book the rollup lands in is a downstream
 *  booking decision that could change without the evidence changing. Tenancy is
 *  resolved through the parent fee transaction (found by `externalId`
 *  `stripe-fees:<month>`), so there is no denormalized chapter that can drift.
 *
 *  `type` is Stripe's own balance-transaction type, stored as a free string
 *  rather than a union: Stripe adds types, and an unrecognised one must be
 *  RECORDABLE (it contributes nothing to the fee — see `FEE_ONLY_TYPES` — but
 *  its existence is exactly what someone would want to see). */
export const processorFeeEntries = defineTable({
  // "stripe" today. Givebutter deliberately isn't covered — see processorFees.ts.
  processor: v.literal("stripe"),
  // YYYY-MM — the bucket, and the suffix of the parent row's `externalId`.
  month: v.string(),
  // Stripe's balance-transaction id (`txn_...`). The dedup key: an entry is
  // written once and re-found by this on every later sweep.
  balanceTransactionId: v.string(),
  type: v.string(),
  // This entry's contribution to the month's total. Always positive.
  feeCents: v.number(),
  // The ledger entry's own `amount` — for a payment, the sale the fee was taken
  // out of. Signed: a standalone fee row's amount is negative and IS the fee.
  grossCents: v.number(),
  // Stripe's `created`, in ms.
  occurredAt: v.number(),
  // `bt.source` (`ch_...`, `py_...`) — what to look up in the Stripe dashboard.
  sourceId: v.optional(v.string()),
  // Stripe's own words ("Terminal reader fee"), when it gives any.
  description: v.optional(v.string()),
  createdAt: v.number(),
})
  .index("by_balance_transaction", ["balanceTransactionId"])
  .index("by_processor_and_month", ["processor", "month"]);

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
  // The reviewer's latest send-back note while `status:"changes_requested"`
  // ("receipt must show exact amount"). Required to send back, cleared on the
  // claimant's resubmission — the round-by-round history lives in
  // `approvals`/`financeAuditLog`, not here. Distinct from `rejectedReason`,
  // which is terminal.
  reviewNote: v.optional(v.string()),

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

  // ── Substantiation (transaction-coding parity, phase 3) ───────────────────
  // The SAME §274(d) elements a card charge's `transactionCodings` row
  // carries, applied per LINE because a reimbursement routinely mixes kinds
  // (a fare, a hotel night, and a team dinner on one request). Validated by
  // the shared `codingFieldProblems` so the public token page, the in-app
  // form, and the server can't drift.
  //
  // REQUIRED (server-enforced in `createReimbursement`) for lines created
  // after the coding policy date; `v.optional` so pre-existing legacy rows
  // still validate — the same posture `receiptStorageId` above already
  // takes. There is no separate review state here: the REQUEST's own
  // `submitted → changes_requested → approved` lifecycle is the review loop,
  // so a line's substantiation is judged with the request it belongs to.
  //
  // Attendee names are internal-only, exactly as on `transactionCodings` —
  // a public ledger renders the headcount and affiliation breakdown.
  expenseType: v.optional(v.union(...EXPENSE_TYPES.map((t) => v.literal(t)))),
  businessPurpose: v.optional(v.string()),
  travelFrom: v.optional(v.string()),
  travelTo: v.optional(v.string()),
  headcount: v.optional(v.number()),
  attendees: v.optional(
    v.array(
      v.object({
        personId: v.optional(v.id("people")),
        name: v.string(),
        affiliation: v.union(
          ...ATTENDEE_AFFILIATIONS.map((a) => v.literal(a)),
        ),
      }),
    ),
  ),
  groupDescription: v.optional(v.string()),

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
  // The Stripe Checkout Session id for the "card" repayment method (a
  // distinct rail from the ACH fields above — see `cards.ts`'s "Stripe
  // repayment" section). May be shared across several repayments settled by
  // ONE bundled checkout (`stripe.ts#createRepaymentCheckout`), so it's not a
  // unique key. Set when a checkout is created; NOT cleared on expiry (a new
  // checkout simply overwrites it) — settlement only ever happens through the
  // webhook, which is idempotent regardless of this field's history.
  stripeCheckoutSessionId: v.optional(v.string()),
  // The Stripe PaymentIntent id, stamped once the checkout actually pays
  // (mirrors `increaseRef` for the ACH rail, kept as a separate field rather
  // than overloading `increaseRef` so a reader never has to guess which
  // provider a ref belongs to).
  stripePaymentIntentId: v.optional(v.string()),
  // The offsetting credit transaction posted once the repayment settles.
  creditTransactionId: v.optional(v.id("transactions")),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index("by_chapter", ["chapterId"])
  .index("by_person", ["payerPersonId"])
  .index("by_transaction", ["transactionId"])
  // Match an ingested Increase account entry (its `ach_transfer_intention.
  // transfer_id`) back to the repayment whose ACH debit it settles, so
  // `increaseLedger.applyIncreaseAccountTransaction` can skip it — the
  // offsetting credit already posts as `source:"repayment"` at settle.
  .index("by_increase_ref", ["increaseRef"]);

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
  // Cached BANK balance (Increase's own number, cents), refreshed best-effort
  // by the morning reconciliation engine's snapshot step — display only, never
  // summed into the ledger. `balanceAsOf` stamps when it was last fetched so
  // the accounts page can say how stale it is. Both absent until the engine's
  // first successful snapshot for this account.
  balanceCents: v.optional(v.number()),
  balanceAsOf: v.optional(v.number()),
  // Money the bank has set aside but not posted — `current_balance` minus
  // `available_balance`, so no extra call.
  //
  // NOT "card authorizations", which is what this field claimed until
  // 2026-08-08 and what the accounts page told the reader. Increase's own docs
  // are explicit: available balance is "the current balance minus the sum of
  // all negative Pending Transactions", and `card_authorization` is ONE of
  // roughly sixteen Pending Transaction categories. The others are ordinary
  // here: an outbound ACH/wire/check sits as a `*_transfer_instruction` until
  // it posts, and an ACH debit we PULL creates an `inbound_funds_hold` for the
  // return window. Calling the total "card authorizations" invites a reader to
  // go looking for card spend that does not exist.
  //
  // Worth surfacing at all because these amounts exist NOWHERE else in the app.
  // The webhook fan-out only handles `transaction.created` (posted), so a
  // pending item never reaches Reconcile and never reaches book value, while
  // the bank figure has ALREADY had it deducted. That asymmetry made book value
  // read high against the bank with nothing on screen to explain it.
  //
  // Always ≥ 0: positive Pending Transactions (an unsettled card refund) do not
  // raise the available balance, so available can never exceed current.
  pendingCents: v.optional(v.number()),
  // What that pending total is actually MADE OF, by Increase Pending
  // Transaction category — read from `GET /pending_transactions` during the
  // snapshot and rolled up so the per-book drill-down can itemise it.
  //
  // Exists because a bare total is not auditable: the founder's question about
  // this page was "is the pending even accurate? It doesn't really show up in
  // the breakdown when I click on it, and it's a little confusing." A category
  // rollup is the smallest thing that answers it. Per-item detail is
  // deliberately NOT persisted — Increase stays the system of record, and a
  // pending item is by definition about to become a transaction anyway.
  //
  // `amountCents` is the SIGNED sum Increase reports for that category (debits
  // are negative), so the categories sum to −`pendingCents` when nothing is
  // positive. Absent until the first snapshot that reaches the endpoint; a
  // failed fetch leaves the previous rollup rather than blanking it, so
  // `pendingBreakdownAsOf` says how old it is.
  pendingBreakdown: v.optional(
    v.array(
      v.object({
        category: v.string(),
        amountCents: v.number(),
        count: v.number(),
      }),
    ),
  ),
  pendingBreakdownAsOf: v.optional(v.number()),
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

// ── Finance audit log (field-change trail) ───────────────────────────────────
/** APPEND-ONLY trail of individual FIELD CHANGES on a transaction or budget —
 *  founder ask: "let's get more audit trails when people update reconcile
 *  rows... whatever you feel like would be most important for the financial
 *  part of this app." Deliberately a NEW, separate table rather than an
 *  extension of the three that already exist, each of which models something
 *  else entirely:
 *   - `approvals` — APPROVAL DECISIONS (who approved/rejected/paid a
 *     reimbursement/payout/budget). Its unused `subjectType:"transaction"` /
 *     `action:"edit"` literals were never wired to a writer — this table is
 *     that missing piece, kept SEPARATE so "decided" and "changed a value"
 *     never muddy one shape.
 *   - `budgetApprovalLog` — one row per budget workflow decision
 *     (sent/approved/changes_requested), written only by
 *     `submitBudgetForApproval`/`approveBudget`/`requestBudgetChanges`. NOT
 *     duplicated here — a budget's approval decisions stay that table's story.
 *   - `reattributionAudit` — one row per BULK cross-scope reattribution
 *     (`reassignTransactions`/`transferProjectScope`/`transferEventScope`).
 *     NOT duplicated here — a bulk move stays that table's story (it already
 *     captures a full pre-move snapshot for undo, which this table doesn't).
 *
 *  Written by (see each mutation's own comment): `setTransactionStatus`
 *  (`status_change` — excluding a transaction REQUIRES a non-blank `reason`,
 *  every other transition logs without one), `categorizeTransaction`/
 *  `bulkCategorize`/`setTransactionCategory` (`recode`, one row per changed
 *  attribution field), `flagPersonal` (`personal_flag`), `setTransactionNote`
 *  (`note_edit`), `createManualTransaction` (`manual_create`), `attachReceipt`/
 *  `receipts.linkReceipt` (`receipt_attach`), `receipts.unlinkReceipt`
 *  (`receipt_detach`), `updateBudget` (`budget_amount_change`, only when
 *  `amountCents` actually changes), and `deleteBudget` (`budget_delete`).
 *  NEVER updated or deleted once written.
 *
 *  `before`/`after` are always human-readable (a category NAME, a formatted
 *  dollar amount, a status label) — never a raw id — so the trail still reads
 *  years later without joining back to a row that may no longer exist.
 *  `actorPersonId` is optional (not every finance write comes from a caller
 *  with a roster row — a superuser acting on a chapter's finances with no
 *  `people` row is a real, supported path; mirrors `reattributionAudit`'s own
 *  optional `actorPersonId`), but every writer supplies it whenever one is
 *  resolvable. */
export const financeAuditLog = defineTable({
  chapterId: v.union(v.id("chapters"), v.literal("central")),
  subjectType: v.union(v.literal("transaction"), v.literal("budget")),
  // `Id<"transactions">` or `Id<"budgets">` stored as a plain string — a single
  // `by_subject` index over both subject types needs one homogeneous field
  // type (mirrors `approvals.subjectId`'s own string-not-id shape).
  subjectId: v.string(),
  action: v.union(...FINANCE_AUDIT_ACTIONS.map((a) => v.literal(a))),
  // WHO — two identities, both stored on purpose, mirroring
  // `reattributionAudit` above (the existing house precedent for exactly this
  // problem).
  //
  // `actorUserId` is REQUIRED and is this trail's integrity anchor: every
  // mutation that logs here runs behind auth, so an authenticated user id
  // always exists, and an audit row that can't name anyone is worthless
  // precisely when it matters most ("$303.86 left the budget and nobody knows
  // who"). `actorPersonId` is the friendly, DISPLAYABLE identity and stays
  // optional — legitimately absent for a superuser with no roster row — which
  // is exactly why it can't be the anchor on its own.
  actorUserId: v.id("users"),
  actorPersonId: v.optional(v.id("people")),
  // The changed field's name (e.g. "status", "category", "budget", "amount",
  // "note", "receipt", "isPersonal") — omitted for an action with no single
  // changed field (e.g. `manual_create`).
  field: v.optional(v.string()),
  before: v.optional(v.string()),
  after: v.optional(v.string()),
  // Required (non-blank, enforced by `setTransactionStatus`) for a
  // `status_change` row whose `after` is "Excluded"; optional everywhere else.
  reason: v.optional(v.string()),
  // The transaction's amount (or, for a `budget_amount_change` row, the
  // budget's NEW amount) — a quick-scan number alongside the formatted
  // `before`/`after` strings, never the sole record of it.
  amountCents: v.optional(v.number()),
  createdAt: v.number(),
})
  .index("by_subject", ["subjectType", "subjectId"])
  .index("by_chapter_and_createdAt", ["chapterId", "createdAt"]);

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
 *  resolved from its payload. Used by the Stripe, Increase, Twilio
 *  (`/twilio/webhook`, keyed on `MessageSid`), and Resend
 *  (`/resend/webhook`, keyed on the Svix `svix-id` header) handlers. */
export const webhookEvents = defineTable({
  provider: v.union(
    v.literal("stripe"),
    v.literal("increase"),
    v.literal("twilio"),
    v.literal("resend"),
  ),
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
  // Set ONLY when the message reached us via a MAILING LIST that rewrote its
  // `From:` — the `receipts@publicworship.life` Google Group does this for
  // posters on DMARC-strict domains, so `fromEmail` above is the LIST and the
  // real poster is recovered from `X-Original-Sender`
  // (`receiptInbox.ts#resolveListSender`). Both are kept: `fromEmail` stays
  // the verbatim envelope (audit), and this is who the pipeline classified,
  // matched, and replied to. Absent on mail sent straight to the inbox.
  originalSenderEmail: v.optional(v.string()),

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

/**
 * DEBOUNCE BATCH for the courtesy reply an emailed receipt earns its sender
 * (`receiptInbox.ts`'s `enqueueReplyItem` / `flushReplyBatch`).
 *
 * Without it, a person who forwards eight receipts in one sitting gets eight
 * near-identical robot emails, and a BACKFILL sweep of months-old receipts
 * would blast a whole burst of them at once. Instead, the first receipt from a
 * given address OPENS a batch and schedules its flush `REPLY_DEBOUNCE_MS`
 * later; every receipt from that same address in the meantime joins the same
 * batch, and the flush sends exactly ONE digest covering all of them.
 *
 * Keyed on the RECIPIENT ADDRESS (normalized), not on a person: the digest is
 * an email, and the address is where it goes — someone sending from two
 * addresses is two conversations and gets two digests.
 *
 * The window is fixed from the FIRST item rather than extended by each new
 * one, so a steady trickle can never postpone a reply indefinitely — the
 * sender always hears back within `REPLY_DEBOUNCE_MS` of their first receipt.
 * A batch is OPEN while `sentAt` is unset; the flush claims it by stamping
 * `sentAt` in the same transaction it reads the items, so a double-fired
 * schedule can never send the same digest twice.
 */
export const receiptReplyBatches = defineTable({
  // Normalized address the digest goes to — the batch key.
  recipientEmail: v.string(),
  // Every receipt outcome accumulated in this window, in arrival order.
  items: v.array(
    v.object({
      outcome: v.union(
        v.literal("matched"),
        v.literal("no_match"),
        v.literal("needs_review"),
      ),
      amountCents: v.optional(v.number()),
      merchant: v.optional(v.string()),
    }),
  ),
  windowStartedAt: v.number(),
  // Set the moment the flush claims the batch. Unset = still open.
  sentAt: v.optional(v.number()),
  // Receipts that arrived past the per-batch item cap — counted, never
  // silently dropped (the digest says "+N more").
  overflowCount: v.optional(v.number()),
})
  // The open-batch lookup: "is there an unflushed batch for this address?"
  .index("by_recipient_and_sent", ["recipientEmail", "sentAt"]);

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
  // PROVENANCE, NOT TENANCY (founder decision, 2026-07-24). A real chapter or
  // the `"central"` sentinel: where this document probably belongs, inferred
  // from who uploaded it or whose email it arrived from. It is a HINT — it
  // ranks the attach-a-receipt picker (a Boston member's upload is most likely
  // a Boston purchase) and labels the row; it NEVER hides a receipt from
  // anyone. Every receipt is visible to every finance-seat holder org-wide.
  //
  // This used to be a hard tenancy filter, which broke the actual workflow:
  // every receipt lands in ONE shared no-reply inbox, people double-hat
  // Central and New York, and an unknown-sender email carries no chapter at
  // all — so a receipt and its transaction routinely sat in different buckets
  // and could never be matched. `linkReceipt` gates on the TRANSACTION's scope
  // (the real money boundary); the document itself is org-wide.
  //
  // Still OPTIONAL: an email from an UNKNOWN sender (no roster match) has no
  // chapter to infer (owner decision, 2026-07-23). Such a row now simply
  // shows as "Unassigned" rather than being invisible everywhere.
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
  // ── Extraction IN FLIGHT — what the UI shows instead of a dead card ─────────
  // Extraction is asynchronous (a scheduled action, often several seconds of
  // vision call), and before this field the UI had no way to know that: the
  // Retry button's spinner tracked the MUTATION, which returns the instant
  // the action is scheduled, so a receipt looked "done" while its read was
  // still running — and an automatic retry (`lib/receiptRetry.ts`), which can
  // be minutes away, was invisible entirely.
  //  - `queued`: scheduled, not started. `nextAttemptAt` is when it fires, so
  //    the UI can count down to it honestly.
  //  - `running`: the extraction action is executing right now.
  // `attempt`/`maxAttempts` are set only for the AUTOMATIC retry chain, so the
  // UI can say "attempt 2 of 3" rather than a bare spinner. ALWAYS cleared by
  // the two commit mutations (`applyUploadOcrAndAttach`, `applyRetryExtraction`)
  // — every terminal path runs through one of them. Readers must still treat a
  // stale value as inactive (see `isReceiptExtractionActive`): a lost scheduled
  // function must never strand a receipt spinning forever.
  extraction: v.optional(
    v.object({
      status: v.union(v.literal("queued"), v.literal("running")),
      since: v.number(),
      attempt: v.optional(v.number()),
      maxAttempts: v.optional(v.number()),
      nextAttemptAt: v.optional(v.number()),
    }),
  ),
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
  // Set when this receipt duplicates an EARLIER (kept) receipt in the same
  // chapter — points at that primary receipt. Written two ways: (1) derived,
  // automatically, when this receipt's file exactly matches an earlier one's
  // `fileSha256` (`lib/receiptLinks.ts#findDuplicateReceiptBySha256`) — no
  // `duplicateConfirmed*` stamp; or (2) a HUMAN confirmation via
  // `receipts.markAsDuplicate` — a bookkeeper who can't merge two receipts
  // (e.g. a soft/possible-duplicate match that turns out to really be the
  // same purchase) instead points this one at the primary, stamping
  // `duplicateConfirmed*` below. Either way the record is never DELETED —
  // hiding (see `listReceipts`'s default exclusion) is not deleting; the row,
  // its file, and any existing `receiptLinks` all survive untouched (a
  // confirmed duplicate is a review action, not a retroactive unlink).
  duplicateOfReceiptId: v.optional(v.id("receipts")),
  // Set ONLY by `receipts.markAsDuplicate` (a human's confirmation) —
  // distinguishes a HUMAN-confirmed duplicate from the derived sha256
  // exact-file match above (which leaves these two fields unset). Governs
  // `receipts.unmarkDuplicate`: only a human-confirmed duplicate (these two
  // fields set) can be un-marked; a derived exact-file match cannot (it isn't
  // a human assertion to retract — the bytes are still identical).
  duplicateConfirmedByPersonId: v.optional(v.id("people")),
  duplicateConfirmedAt: v.optional(v.number()),
  // RECEIPT QUALITY PR: a bookkeeper's "I checked, this isn't a duplicate"
  // — set by `receipts.dismissDuplicateFlag`. Additive + PER-RECEIPT: only
  // ever silences THIS receipt's own `softDuplicate` output (see
  // `computeSoftDuplicates`); an undismissed sibling that still collides on
  // the same amount+date keeps flagging on its own. Never touches the
  // EXACT-file `duplicateOfReceiptId` relationship above — that's a
  // different, stronger signal with its own "jump to original" UI, not
  // dismissible here. Absent (falsy) is the default — every existing row.
  duplicateDismissed: v.optional(v.boolean()),

  // ── Founder feedback PR (2026-07-24): archiving ─────────────────────────────
  // "we should just have a concept of archiving receipt entries, and the
  // ability to unarchive." The GENERAL soft-hide for a nonsense receipt (a
  // blank photo, a stray screenshot — nothing a duplicate/edit flow covers)
  // AND — since the founder also flagged the duplicate flow as "weird" —
  // the resolution mechanism a CONFIRMED duplicate now goes through too (see
  // `receipts.markAsDuplicate`): archiving is set alongside the duplicate
  // stamps, so "mark duplicate" and "archive the known duplicate" are the
  // same act. Never deletes the row or its stored file — mirrors
  // `duplicateOfReceiptId`'s philosophy exactly: hiding, not deleting.
  // Existing `receiptLinks` are left untouched by archiving alone; a linked-
  // and-archived receipt must be unlinked explicitly (see `getReceipt`'s
  // `duplicateStillLinked`/UI "still attached" warning) — archiving is a
  // visibility decision, not a money one. Absent (falsy) is the default.
  archived: v.optional(v.boolean()),
  archivedAt: v.optional(v.number()),
  archivedByPersonId: v.optional(v.id("people")),

  createdAt: v.number(),
  updatedAt: v.number(),
})
  // Provenance lookups only (e.g. "which chapter did this come from") — NEVER
  // a visibility filter for the library; see `chapterId`'s own doc above.
  .index("by_chapter", ["chapterId"])
  .index("by_chapter_and_linkCount", ["chapterId", "linkCount"])
  // The real "unmatched receipts" worklist, ORG-WIDE: every receipt nobody has
  // attached yet, regardless of which chapter it came from. Replaces
  // `by_chapter_and_linkCount` for `listReceipts`' `unlinked` filter.
  .index("by_linkCount", ["linkCount"])
  // Find the receipt(s) extracted from a given inbound email (manual-match).
  .index("by_inbound", ["inboundReceiptId"])
  // Exact-duplicate detection: find every receipt sharing a stored file's
  // content hash (chapter-filtered in JS by the caller — bounded, since a
  // real hash collision among a chapter's receipts is rare).
  .index("by_sha256", ["fileSha256"]);

// ── Failed-extraction sweep marker (RATE-LIMIT-SAFE bulk re-extract) ────────
/** ONE row per chapter — is a `receipts.ts#runFailedRetrySweep` chain
 *  currently running? The owner's mass-upload (~80 receipts) scheduled every
 *  extraction at `runAfter(0)` and tripped Ollama's rate limit; the sweep
 *  fixes that by re-extracting FAILED receipts one at a time with a throttle,
 *  self-rescheduling until done. This row exists purely so a double-tap on
 *  "Re-extract failed" (or two bookkeepers clicking it seconds apart) can't
 *  spin up a SECOND overlapping chain that would double the request rate
 *  right back into the same rate limit — see `receipts.ts#retryFailedExtractions`.
 *
 *  `inProgress` is cleared by the sweep's own terminal step (no failures
 *  left, its scan cap hit, or its consecutive-backoff cap hit — see
 *  `finishFailedRetrySweep`). `updatedAt` is a HEARTBEAT the sweep bumps on
 *  every self-reschedule (`touchFailedRetrySweep`), not just at start/end —
 *  `retryFailedExtractions` treats an `inProgress` row whose `updatedAt` is
 *  older than `SWEEP_STALE_MS` as an abandoned chain (the action crashed past
 *  its own try/catch) and lets a fresh sweep start rather than blocking
 *  forever on a marker nothing will ever clear. */
export const receiptSweepState = defineTable({
  chapterId: v.id("chapters"),
  inProgress: v.boolean(),
  startedAt: v.number(),
  updatedAt: v.number(),
}).index("by_chapter", ["chapterId"]);

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

// ── Receipt exceptions (documented "there is no receipt") ────────────────────
/** The documentation of record for a transaction that can never carry a
 *  receipt. NOT a "missing receipt" marker — a SUBSTITUTE DOCUMENT: a named
 *  person attesting what the spend was for and why no receipt exists, decided
 *  on by someone else. See `docs/plans/receipt-exceptions.md` for the full
 *  design and `RECEIPT_EXCEPTION_REASONS` (`@events-os/shared`) for why
 *  "missing" and "unattainable" are one reason axis rather than two states.
 *
 *  WHY A TABLE AND NOT A TRANSACTION STATUS: documentation state is orthogonal
 *  to review state — a row can be `reconciled` AND receipt-less. Same call the
 *  personal-expense lifecycle made (see `PERSONAL_EXPENSE_STATES`' doc comment
 *  on why a 5th `TRANSACTION_STATUS` was rejected).
 *
 *  APPEND-MOSTLY: a row's `status` moves `pending` → `approved`/`rejected`/
 *  `withdrawn` exactly once and its attestation fields are never rewritten. A
 *  rejected attestation is re-filed as a NEW row, so "what did they claim, and
 *  who decided" stays recoverable rather than being edited into agreement.
 *  `transactions.approvedReceiptExceptionId` points back at the at-most-one
 *  row that is currently `approved`; `lib/receiptExceptions.ts` is the ONLY
 *  writer of either side, which is what keeps them in lock-step. */
export const receiptExceptions = defineTable({
  transactionId: v.id("transactions"),
  // Denormalized from the transaction (a real chapter or "central") so the
  // exception queue can be scoped without loading every transaction — same
  // pattern as `receiptLinks.chapterId`.
  chapterId: v.union(v.id("chapters"), v.literal("central")),
  // Denormalized at attest time so a period's exception TOTAL is readable
  // without re-reading every transaction. Never rewritten — if a transaction's
  // amount is corrected the exception is re-filed, not patched.
  amountCents: v.number(),
  reason: v.union(...RECEIPT_EXCEPTION_REASONS.map((r) => v.literal(r))),
  // THE SUBSTITUTE FOR THE DOCUMENT: what this spend was for, in the filer's
  // words. Required and length-floored (`MIN_EXCEPTION_NOTE_LENGTH`) — a
  // blank note turns the whole feature back into "no receipt, shrug", which
  // is the thing this exists to prevent.
  note: v.string(),
  // EVIDENCE OF THE PURCHASE — the photos and documents standing in for the
  // receipt. Owner framing (2026-08-05): "we bought flowers for an event, we
  // didn't get the receipt but have pictures of the flowers at the event."
  // That's the strongest artifact an exception can carry, and it's routinely
  // several photos, not one — hence a list.
  //
  // Also holds the paper-ish substitutes: a bank statement line, a
  // confirmation email, a calendar invite.
  //
  // NOT receipts. Deliberately never written to
  // `transactions.receiptStorageId` and never inserted into the `receipts`
  // library: evidence must never be counted as a receipt, feed the
  // documentation denorm cache, or be auto-matched to another charge. A photo
  // of flowers proves the flowers existed — it doesn't prove what was paid,
  // which is exactly the difference a published ledger should keep visible.
  evidenceStorageIds: v.optional(v.array(v.id("_storage"))),
  status: v.union(...RECEIPT_EXCEPTION_STATUSES.map((s) => v.literal(s))),
  // Who put their name on it, and when.
  attestedByPersonId: v.optional(v.id("people")),
  attestedByUserId: v.id("users"),
  attestedAt: v.number(),
  // The decision. Set together, exactly once, when `status` leaves `pending`.
  // `decidedByPersonId` is what the separation-of-duties check compares
  // against `attestedByPersonId` (see `exceptionNeedsSecondApprover`).
  decidedByPersonId: v.optional(v.id("people")),
  decidedByUserId: v.optional(v.id("users")),
  decidedAt: v.optional(v.number()),
  // An approver's reason, required on a rejection (the filer needs to know
  // what would make it approvable) and optional on an approval.
  decisionNote: v.optional(v.string()),
})
  // "Every exception on this transaction" — the detail panel's history, and
  // the pending-duplicate check `attestReceiptException` runs before filing.
  .index("by_transaction", ["transactionId"])
  // The approval queue: pending exceptions for one scope, oldest first.
  .index("by_chapter_and_status", ["chapterId", "status"]);

// ── Transaction codings (IRS-grade substantiation) ───────────────────────────
/** The structured, HUMAN-AUTHORED answer to "what was this, why, and who was
 *  involved" — the §274(d) substantiation elements — with its own review
 *  lifecycle. See `docs/plans/transaction-coding.md` and the enums' doc
 *  comments in `@events-os/shared`.
 *
 *  ONE ROW PER TRANSACTION, revised in place. Unlike `receiptExceptions`
 *  (append-mostly, re-filed on rejection) the send-back loop here is an EDIT
 *  conversation — "receipt must show exact amount" → fix → resubmit — so the
 *  row's fields ARE rewritten across rounds and the revision history lives in
 *  `financeAuditLog` (`coding_submit` per round, `coding_decide` per
 *  decision). Same orthogonality argument as exceptions: coding state is not
 *  a 5th `TRANSACTION_STATUS`; the denormalized `transactions.codingState`
 *  mirrors `status` here, and `lib/transactionCoding.ts` is the ONLY writer
 *  of both sides.
 *
 *  PRIVACY: `attendees` names are INTERNAL-ONLY, forever (owner decision,
 *  2026-08-08 — members/guests didn't consent to a public financial record,
 *  and some are minors). A public ledger renders `businessPurpose`, the
 *  headcount, and the affiliation breakdown — never a name. Reads gate names
 *  behind `lib/transactionCodingAccess.ts#hasCodingNamesView`. */
export const transactionCodings = defineTable({
  transactionId: v.id("transactions"),
  // Denormalized from the transaction (a real chapter or "central") — same
  // pattern + rationale as `receiptExceptions.chapterId`.
  chapterId: v.union(v.id("chapters"), v.literal("central")),
  // Which §274(d) branch applies — drives the required fields below. NOT a
  // category taxonomy (funds/categories/budgets own that).
  expenseType: v.union(...EXPENSE_TYPES.map((t) => v.literal(t))),
  // THE STRING THE PUBLIC LEDGER PRINTS — "travel to NY to film Eden event",
  // never "bus to NY". Human-authored (no AI pre-fill anywhere in this flow),
  // length-floored (`MIN_PURPOSE_LENGTH`).
  businessPurpose: v.string(),
  // Travel/lodging: the route (required for those types; city level is
  // enough, and city level is what publishes).
  travelFrom: v.optional(v.string()),
  travelTo: v.optional(v.string()),
  // Who traveled — optional context on travel rows (the spender is implied by
  // `transactions.personId`; extra travelers get listed when the fare covered
  // more than one person).
  travelers: v.optional(
    v.array(
      v.object({
        personId: v.optional(v.id("people")),
        name: v.string(),
        affiliation: v.union(
          ...ATTENDEE_AFFILIATIONS.map((a) => v.literal(a)),
        ),
      }),
    ),
  ),
  // Meals: headcount always; names+affiliations at/below the org threshold
  // (`mealAttendeeNamesMaxHeadcount`, default 15), an identifiable group
  // description above it. `attendees` is bounded by that same threshold —
  // over it the group is DESCRIBED, never enumerated — so the embedded array
  // can't grow past ~15 entries (the no-unbounded-arrays rule holds).
  headcount: v.optional(v.number()),
  attendees: v.optional(
    v.array(
      v.object({
        personId: v.optional(v.id("people")),
        name: v.string(),
        affiliation: v.union(
          ...ATTENDEE_AFFILIATIONS.map((a) => v.literal(a)),
        ),
      }),
    ),
  ),
  groupDescription: v.optional(v.string()),
  status: v.union(...TRANSACTION_CODING_STATUSES.map((s) => v.literal(s))),
  // Who authored it. A bookkeeper may code on someone's behalf (reality
  // demands it) — these fields say who actually typed, and the SoD check in
  // `transactionCodings.approve` compares the DECIDER against them.
  codedByPersonId: v.optional(v.id("people")),
  codedByUserId: v.id("users"),
  submittedAt: v.number(), // first submission
  updatedAt: v.number(), // latest edit/resubmission
  // The latest decision. Rewritten per round (history in `financeAuditLog`).
  decidedByPersonId: v.optional(v.id("people")),
  decidedByUserId: v.optional(v.id("users")),
  decidedAt: v.optional(v.number()),
  // The reviewer's latest send-back note ("receipt must show exact amount") —
  // required on `changes_requested`, cleared on approval.
  reviewNote: v.optional(v.string()),
})
  // At most one row per transaction (enforced by `lib/transactionCoding.ts`).
  .index("by_transaction", ["transactionId"])
  // The review queue: submitted codings for one scope, oldest first.
  .index("by_chapter_and_status", ["chapterId", "status"]);

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
  // Cached STRIPE balance (cents), refreshed by the morning engine's snapshot
  // step alongside the per-account bank balances. Org-level, not per-book:
  // there is one Stripe account and its balance can't be attributed to a
  // chapter until it pays out. Display only, never summed into any ledger.
  // `available` is what a payout could take today; `pending` is money from
  // charges Stripe hasn't released yet.
  stripeAvailableCents: v.optional(v.number()),
  stripePendingCents: v.optional(v.number()),
  stripeBalanceAsOf: v.optional(v.number()),
  // ── Balance-snapshot throttle (see `reconciliation.ts#refreshBalancesNow`) ──
  // The accounts page refreshes balances when it OPENS, because figures hours
  // old can't answer "do the books match the bank right now". That means a page
  // load reaches out to Increase (once per account) and Stripe (once), so it
  // needs a brake that survives remounts, several viewers, and a web refresh —
  // which client-side state does not. These two fields are that brake, and they
  // live in the database precisely so it is shared.
  //   · `balanceSnapshotAt`      — when a snapshot last COMPLETED. Doubles as
  //                                the "as of" the page shows, and as the
  //                                throttle's clock.
  //   · `balanceSnapshotRunningSince` — set while one is in flight and cleared
  //                                when it finishes, so two page opens a second
  //                                apart don't both call out. Treated as stale
  //                                (and overridden) after a couple of minutes so
  //                                a crashed action can't wedge refreshes
  //                                forever.
  balanceSnapshotAt: v.optional(v.number()),
  balanceSnapshotRunningSince: v.optional(v.number()),
  // Org-wide card prerequisite: the Academy course slug a member must complete
  // before a card can be issued/activated. `undefined` = no prerequisite gate
  // (issuance unaffected), so cards keep working until central finance points
  // this at Kansi's card-prerequisite course.
  cardPrerequisiteCourseSlug: v.optional(v.string()),
  // Org-wide receipt-exception policy: at or above this amount, an exception
  // must be approved by someone OTHER than the person who attested it.
  // `undefined` falls back to `DEFAULT_EXCEPTION_APPROVAL_THRESHOLD_CENTS`
  // ($75, the IRS accountable-plan substantiation line) — a fallback, not
  // "off": there is no way to switch separation of duties off entirely, which
  // is the point. Enforced in `receiptExceptions.approveReceiptException`.
  receiptExceptionApprovalThresholdCents: v.optional(v.number()),
  // Org-wide coding policy start: spend posted at/after this instant REQUIRES
  // an approved coding before it can be reconciled (`CODING_REQUIRED` gate in
  // `finances.setTransactionStatus`). `undefined` falls back to
  // `DEFAULT_CODING_REQUIRED_SINCE_MS` (2026-09-01, the owner-decided policy
  // date) — a fallback, not "off": the policy arms itself on the date with no
  // config step, and moving it is a deliberate central-finance act. Pre-date
  // history never lights up (`docs/plans/transaction-coding.md`,
  // "grandfathering").
  codingRequiredSinceMs: v.optional(v.number()),
  // Org-wide meal-names threshold: at/below this headcount a meal coding must
  // name every attendee (with affiliation); above it, headcount + group
  // description. `undefined` falls back to
  // `DEFAULT_MEAL_ATTENDEE_NAMES_MAX_HEADCOUNT` (15, owner decision
  // 2026-08-08).
  mealAttendeeNamesMaxHeadcount: v.optional(v.number()),
  // Org-wide substantiation deadline: a post-policy charge still uncoded this
  // many days after posting auto-converts to a personal repayment (the
  // cardholder owes it back). `undefined` falls back to
  // `DEFAULT_CODING_OVERDUE_DAYS` (60 — the IRS accountable-plan safe
  // harbor). Enforced by the daily `cards.autoConvertOverdueReceipts` sweep,
  // alongside the existing `noReceiptAutoConvertDays` documentation clock.
  codingOverdueDays: v.optional(v.number()),
  // Morning reconciliation engine kill switch (accounts page, ED/FM). The
  // engine defaults to RUNNING — it books ledger transfer pairs, never real
  // bank movement, so the money-gating rule doesn't apply — but the Financial
  // Manager can pause it while investigating a flagged allocation.
  autoReconciliationPaused: v.optional(v.boolean()),
  // Only Stripe payouts ARRIVING at/after this instant are auto-allocated.
  // Stamped to "now" by the engine's first run (so deploying the feature
  // never retroactively books transfers against months of already-hand-coded
  // history); the FM can move it back deliberately from the accounts page to
  // allocate older payouts — after checking those deposits weren't already
  // manually settled (see the mutation's doc).
  autoReconciliationSinceMs: v.optional(v.number()),
  // REAL cash follows the books: when true, the morning engine EXECUTES each
  // engine-booked transfer pair as an actual Increase account-to-account
  // transfer (central ↔ chapter, production accounts only) and stamps the
  // pair's legs with the transfer id. DEFAULT OFF — flipping it on from the
  // accounts page is the standing human authorization the money-gating rule
  // requires; a merge alone never moves real money. Manual `recordTransfer`
  // pairs are never executed (they record movements that already happened
  // outside the app).
  autoTransferRealMovement: v.optional(v.boolean()),
  // Stamped to "now" every time real movement is ENABLED. Only pairs BOOKED
  // at/after this instant execute — the historical backlog (pairs booked
  // while the toggle was off, including pre-Increase-era allocations whose
  // cash never reached the central Increase account) NEVER auto-moves.
  // Anything older that should physically move is a deliberate manual
  // transfer in the bank, recorded the normal way.
  autoTransferRealMovementSinceMs: v.optional(v.number()),
});

// ── Morning reconciliation engine ────────────────────────────────────────────
// The daily engine that (a) detects Stripe payouts and books each chapter's
// share of the deposit as central↔chapter transfer pairs, and (b) trues up
// `interScopeBalances`' cross-book card spend — so every book reflects its
// true value by morning instead of waiting for a human to record transfers.
// See `reconciliation.ts`'s module doc for the full model.

/**
 * One Stripe payout the engine has detected — the allocation record tying a
 * bank deposit to the per-book revenue it settles. `stripePayoutId` (`po_…`)
 * is the identity + idempotency key: one row per payout, ever; re-detection
 * (webhook redelivery, the daily poll) updates in place. The `allocation`
 * array is BOUNDED by the number of scopes (central + active chapters), never
 * by payout size — per-item detail is deliberately NOT persisted (Stripe
 * remains the system of record for charge-level data; `itemCount`s and the
 * loud `unmapped` bucket summarize it).
 */
export const stripePayouts = defineTable({
  stripePayoutId: v.string(),
  // The deposit amount Stripe reports (net of fees), non-negative cents;
  // direction lives in `stripeStatus`/allocation, matching the ledger's
  // flow-not-sign rule.
  amountCents: v.number(),
  currency: v.string(),
  // Stripe's own lifecycle string ("paid", "in_transit", "failed", …) as last
  // seen — kept verbatim so a status we've never heard of still stores.
  stripeStatus: v.string(),
  arrivalDate: v.number(), // epoch ms of Stripe's arrival_date
  // Stripe's `automatic` flag: false when a human pressed "pay out now" in the
  // Stripe dashboard rather than the payout schedule producing it.
  //
  // Recorded because it is the whole explanation for the one alarming red
  // "Failed" this page has ever shown. Stripe refuses to itemise a manual
  // payout ("Balance transaction history can only be filtered on automatic
  // transfers, not manual"), so the pre-#553 allocation step failed on
  // po_1U1qk8Qv9S5xW6eKsjkeLJvv and stored that blob. #553 deleted the need for
  // itemisation entirely — chapter attribution now comes from the revenue layer
  // — so the failure is obsolete, but nothing said so and the badge stayed red.
  // Storing the flag lets the row explain itself: "you initiated this one by
  // hand", which is a fact, not a fault. Absent for payouts detected before
  // this field existed.
  automatic: v.optional(v.boolean()),
  // OUR processing state — see `STRIPE_PAYOUT_PROCESS_STATES`.
  processState: v.union(
    ...STRIPE_PAYOUT_PROCESS_STATES.map((s) => v.literal(s)),
  ),
  // Per-scope breakdown once allocated. `transferGroupId` is set on entries
  // that booked a pair (central's own entry and zero-net entries book none).
  allocation: v.optional(
    v.array(
      v.object({
        scope: v.union(v.id("chapters"), v.literal("central")),
        grossCents: v.number(), // signed sum of item gross amounts
        feeCents: v.number(), // signed sum of Stripe fees on those items
        netCents: v.number(), // signed; what the scope is owed from this payout
        itemCount: v.number(),
        transferGroupId: v.optional(v.string()),
      }),
    ),
  ),
  // Item-kind rollup for the audit surface (how many ticket orders vs gifts vs
  // unmapped items composed this payout) — keys from `PAYOUT_ITEM_KINDS`.
  itemKindCounts: v.optional(v.record(v.string(), v.number())),
  // The loud buckets: money that stayed on central's book because it couldn't
  // be traced (`unmappedNetCents`) or because it's a repayment cash return
  // whose chapter book was already credited at settle (`repaymentNetCents`).
  unmappedNetCents: v.optional(v.number()),
  repaymentNetCents: v.optional(v.number()),
  // The central bank deposit row this payout was matched to, once found
  // (`transactions` gains the reverse `stripePayoutId` link + the
  // `payoutProcessor:"stripe"` label). Absent until the deposit syncs in —
  // the engine retries the match on every run.
  matchedTransactionId: v.optional(v.id("transactions")),
  error: v.optional(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index("by_stripe_payout", ["stripePayoutId"])
  .index("by_process_state", ["processState"])
  .index("by_arrival", ["arrivalDate"]);

/**
 * One run of the morning engine — the audit trail the accounts page renders
 * ("what did the robot do overnight"). Append-only; `notes` is a BOUNDED
 * human-readable log (the engine caps how many lines it writes per run).
 */
export const reconciliationRuns = defineTable({
  trigger: v.union(v.literal("cron"), v.literal("manual"), v.literal("webhook")),
  status: v.union(
    v.literal("running"),
    v.literal("ok"),
    v.literal("error"),
    v.literal("skipped"), // paused, or Stripe isn't configured
  ),
  startedAt: v.number(),
  finishedAt: v.optional(v.number()),
  payoutsProcessed: v.number(),
  transfersBooked: v.number(),
  settlementsBooked: v.number(),
  allocatedCents: v.number(), // total |net| moved by this run's transfers
  notes: v.array(v.string()),
  error: v.optional(v.string()),
}).index("by_startedAt", ["startedAt"]);

/**
 * A Financial Manager's audit flag on an engine artifact — "this allocation /
 * transfer needs a human decision." Flagging never rewrites the ledger; the
 * fix, when one is needed, is an offsetting entry per
 * docs/plans/transfers-ops-notes.md, and resolving the flag records what was
 * decided. `refKey` is a `transferGroupId` (kind "transfer") or a Stripe
 * payout id (kind "payout").
 */
export const reconciliationFlags = defineTable({
  kind: v.union(...RECONCILIATION_FLAG_KINDS.map((k) => v.literal(k))),
  refKey: v.string(),
  note: v.string(),
  status: v.union(...RECONCILIATION_FLAG_STATUSES.map((s) => v.literal(s))),
  createdBy: v.id("users"),
  createdAt: v.number(),
  resolvedBy: v.optional(v.id("users")),
  resolvedAt: v.optional(v.number()),
  resolutionNote: v.optional(v.string()),
})
  .index("by_status", ["status"])
  .index("by_refKey", ["refKey"]);
