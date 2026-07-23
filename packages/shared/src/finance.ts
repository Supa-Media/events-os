/**
 * Shared finance domain model for Chapter OS.
 *
 * Pure constants + helpers used by BOTH the Convex backend and the Expo app so
 * the finance enums, role grading, and money formatting never drift between the
 * two. Every status/enum below is a readonly tuple; the Convex schema turns each
 * into a validator with `v.union(...TUPLE.map((s) => v.literal(s)))` (the
 * `EVENT_STATUSES` pattern), so the schema and app stay in lock-step without
 * pulling `convex/values` in here.
 *
 * MONEY IS ALWAYS INTEGER CENTS (USD) — never floats. Mirrors ticketing's
 * `priceCents`. `formatCents` is the single place cents become a display string.
 */

// ── Funds ────────────────────────────────────────────────────────────────────
// A fund is the top bucket money lives in. "unrestricted" is general operating
// money; "designated" money is earmarked for a purpose (a grant, a designated
// gift) and may only be spent against that purpose.
export const FUND_RESTRICTIONS = ["unrestricted", "designated"] as const;
export type FundRestriction = (typeof FUND_RESTRICTIONS)[number];

export const FUND_RESTRICTION_LABELS: Record<FundRestriction, string> = {
  unrestricted: "Unrestricted",
  designated: "Designated",
};

// ── Budget categories ────────────────────────────────────────────────────────
// Categories nest under a fund (self-nesting via parentCategoryId, kept
// acyclic). A "category" groups line items; a "lineItem" is a leaf you budget /
// spend against (Food, Ad spend, Software…).
export const BUDGET_CATEGORY_KINDS = ["category", "lineItem"] as const;
export type BudgetCategoryKind = (typeof BUDGET_CATEGORY_KINDS)[number];

// ── Budgets: type × cadence × tags (v2) ──────────────────────────────────────
// A budget v2 has three axes: its TYPE (one_time vs recurring — the source of
// truth, replacing the 6-value `scope`), its LEVEL (a real chapter or the
// `"central"` sentinel, stored in `chapterId`), and MULTIPLE managed TAGS (the
// flexible filter + rollup dimension). It still carries a CADENCE and optionally
// narrows to a fund + category.
export const BUDGET_TYPES = ["one_time", "recurring"] as const;
export type BudgetType = (typeof BUDGET_TYPES)[number];

export const BUDGET_TYPE_LABELS: Record<BudgetType, string> = {
  one_time: "One-time",
  recurring: "Recurring",
};

// A one_time budget points at a specific event or project (its `scopeRefId` is
// that instance's id); `refKind` says which table the ref points at.
export const BUDGET_REF_KINDS = ["event", "project"] as const;
export type BudgetRefKind = (typeof BUDGET_REF_KINDS)[number];

// Managed budget tags. `team`/`template` tags carry a `refId` (a financeTeams /
// eventType id) for auto-tag dedup; `events` is the auto-applied catch-all for
// event budgets; `custom` is a free author-created tag.
export const BUDGET_TAG_KINDS = [
  "team",
  "template",
  "events",
  "custom",
] as const;
export type BudgetTagKind = (typeof BUDGET_TAG_KINDS)[number];

// A budget is a flexible allocation. Its SCOPE says what it's attached to, its
// CADENCE says how often it recurs, and it optionally narrows to a fund +
// category. Any scope can take any cadence ("Development team = $2,000/mo",
// "Equipment = $4,000/yr", "Worship w/ Strangers = $500/instance").
/**
 * @deprecated Budgets v2 uses `BUDGET_TYPES` + multiple `BUDGET_TAG_KINDS` tags.
 * `scope` survives only as an optional legacy column + the migration mapping;
 * new code must switch on `type`, never `scope`.
 */
export const BUDGET_SCOPES = [
  "event", // one specific event instance
  "project", // one specific project
  "template", // every instance of an event template
  "team", // a finance team / department (Development, Marketing…)
  "bucket", // a general recurring bucket (a category over time)
  "chapter", // the whole chapter / org
] as const;
export type BudgetScope = (typeof BUDGET_SCOPES)[number];

/** @deprecated Legacy scope labels — kept for the migration + legacy column. */
export const BUDGET_SCOPE_LABELS: Record<BudgetScope, string> = {
  event: "Event",
  project: "Project",
  template: "Template",
  team: "Team",
  bucket: "Bucket",
  chapter: "Chapter",
};

export const BUDGET_CADENCES = [
  "per_instance",
  "monthly",
  "quarterly",
  "yearly",
  "one_off",
] as const;
export type BudgetCadence = (typeof BUDGET_CADENCES)[number];

export const BUDGET_CADENCE_LABELS: Record<BudgetCadence, string> = {
  per_instance: "Per instance",
  monthly: "Monthly",
  quarterly: "Quarterly",
  yearly: "Yearly",
  one_off: "One-off",
};

// Rollover policy is DEFERRED for v1 (spent-vs-allocated per period only, no
// rollover math). The tuple exists so the schema can carry an optional per-budget
// toggle now and the behavior can be built later without a migration.
export const BUDGET_ROLLOVER_POLICIES = ["none", "accumulate"] as const;
export type BudgetRolloverPolicy = (typeof BUDGET_ROLLOVER_POLICIES)[number];

// ── Budget approval workflow (WP-3.2) ────────────────────────────────────────
// State machine: draft → submitted → approved | changes_requested. A budget
// created before this feature shipped carries NO `approvalStatus` at all
// (`undefined`, not one of these four literals) — GRANDFATHERED, treated as
// "approved at its current amount" for display + cap purposes
// (`effectiveBudgetApprovalStatus`/`effectiveCapCents` in `finances.ts`) with
// zero workflow friction UNTIL its first edit: it can't be manually
// re-submitted, and a DECREASE never touches it. But an amount INCREASE
// retriggers on its FIRST occurrence (I1, review) exactly like a literally
// `"approved"` budget crossing its cap — `setBudgetAmount` stamps
// `approvedCents` at the pre-edit amount and flips it to `"submitted"`,
// joining the real workflow from then on. This is deliberate — shipping the
// feature must not suddenly gate hundreds of existing prod budgets that are
// never touched again, but the owner's "raising a cap needs a fresh look"
// rule still has to apply the moment one IS touched.
export const BUDGET_APPROVAL_STATUSES = [
  "draft",
  "submitted",
  "approved",
  "changes_requested",
] as const;
export type BudgetApprovalStatus = (typeof BUDGET_APPROVAL_STATUSES)[number];

export const BUDGET_APPROVAL_STATUS_LABELS: Record<BudgetApprovalStatus, string> = {
  draft: "Draft",
  submitted: "Awaiting approval",
  approved: "Approved",
  changes_requested: "Changes requested",
};

/** A budget's EFFECTIVE approval status: the stored value, or `"approved"` for
 *  a grandfathered legacy row that predates this feature (see the tuple's doc
 *  comment above). Display + cap resolution both go through this — never read
 *  `budget.approvalStatus` raw for either purpose. */
export function effectiveBudgetApprovalStatus(
  status: BudgetApprovalStatus | undefined,
): BudgetApprovalStatus {
  return status ?? "approved";
}

// ── Transactions ─────────────────────────────────────────────────────────────
// The unified ACTUAL spend/inflow record — the ONLY table summed for "actual".
// Estimated money (budgets, projects.budgetUsd, events.budget, item costs,
// engagement amounts) is never summed with this (anti-double-count).
export const TRANSACTION_SOURCES = [
  "increase_card", // a charge on an Increase-issued member card
  "increase_ach", // an ACH in/out on the chapter's Increase account
  "stripe_fc", // synced from a legacy external account via Stripe FC
  "relay_csv", // imported from a Relay monthly-statement CSV (full history)
  "manual", // hand-entered
  "reimbursement", // the payout leg of an approved reimbursement (a transfer)
  "repayment", // an offsetting credit from a personal-charge repayment
  "skim", // a leg of the monthly chapter→central City Launch Fund skim (WP-4.1)
  "launch_grant", // a leg of a one-time central→chapter launch grant (WP-4.2)
  "settlement", // a leg of a monthly central↔chapter inter-scope settlement (WP-4.5)
] as const;
export type TransactionSource = (typeof TRANSACTION_SOURCES)[number];

// Direction of money. `transfer` is money moving without being category spend
// (e.g. a reimbursement payout) — excluded from category/budget spend totals.
export const TRANSACTION_FLOWS = ["outflow", "inflow", "transfer"] as const;
export type TransactionFlow = (typeof TRANSACTION_FLOWS)[number];

export const TRANSACTION_STATUSES = [
  "unreviewed", // just synced/created, needs a human
  "categorized", // fund/category assigned
  "reconciled", // matched to a receipt + confirmed
  "excluded", // intentionally left out of totals (personal, duplicate…)
] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

// ── Inbound email receipts (backfill pipeline) ───────────────────────────────
// The lifecycle of ONE inbound email routed to the receipt-ingest webhook
// (reply.publicworship.life via Resend). A row is created the moment a signed
// `email.received` webhook lands and advances through OCR → match; its terminal
// state is either an auto-attach (`matched`) or a human touch-point
// (`needs_review`) / a dead end (`no_match`/`ignored`/`error`).
export const INBOUND_RECEIPT_STATUSES = [
  "pending", // received + deduped; OCR/match not run yet (scheduled)
  "matched", // OCR'd + attached to exactly one transaction (auto)
  "needs_review", // OCR'd but 0 or >1 candidates — a bookkeeper must pick
  "no_match", // OCR'd, a clean amount read, but no unreceipted txn fits at all
  "ignored", // sender not on the roster, or nothing to OCR (no attachment/body)
  "error", // the pipeline threw (fetch/OCR/store) — retriable
] as const;
export type InboundReceiptStatus = (typeof INBOUND_RECEIPT_STATUSES)[number];

// ── Receipts (first-class receipt documents) ─────────────────────────────────
// A `receipts` row is a first-class receipt DOCUMENT, linked many-to-many to
// `transactions` via `receiptLinks`. `RECEIPT_SOURCES` is how the document
// itself entered the system: from an inbound `email` (the OCR pipeline) or a
// direct in-app `upload` (the mobile attach path + the backfill of legacy
// `transactions.receiptStorageId` documents).
export const RECEIPT_SOURCES = ["email", "upload"] as const;
export type ReceiptSource = (typeof RECEIPT_SOURCES)[number];

// How a SINGLE receipt↔transaction link was made (`receiptLinks.source`):
//  - `auto_email`: the email→OCR pipeline auto-matched a unique candidate,
//  - `manual`: a bookkeeper picked the transaction by hand,
//  - `upload`: created alongside a direct in-app receipt upload,
//  - `backfill`: reconstructed from a legacy `transactions.receiptStorageId`
//    by the receipts-foundation migration.
export const RECEIPT_LINK_SOURCES = [
  "auto_email",
  "manual",
  "upload",
  "backfill",
] as const;
export type ReceiptLinkSource = (typeof RECEIPT_LINK_SOURCES)[number];

// How much a receipt EMAIL's sender is trusted — the axis the OCR pipeline's
// AUTOMATION policy keys off (never a permission grant). The inbound endpoint is
// public, so a `From:` header is spoofable: only a `team`/`roster` sender (one
// that resolves to a known `people` row) may EVER trigger an auto-attach; an
// `internal`/`external` email is always routed to human review, never
// auto-attached and never reconciled.
//  - `team`: resolves to a `people` row flagged `isTeamMember`,
//  - `roster`: resolves to a `people` row (not core team),
//  - `internal`: no person match, but the address is on the org email domain
//    (`ALLOWED_EMAIL_DOMAIN`),
//  - `external`: everything else (a stranger).
export const RECEIPT_SENDER_CLASSES = [
  "team",
  "roster",
  "internal",
  "external",
] as const;
export type ReceiptSenderClass = (typeof RECEIPT_SENDER_CLASSES)[number];

/** True iff a receipt-email sender is trusted enough to trigger an auto-attach
 *  (a resolved roster/team member). `internal`/`external` senders are always
 *  routed to human review — a spoofable From: must never move money. */
export function receiptSenderCanAutoAttach(
  senderClass: ReceiptSenderClass,
): boolean {
  return senderClass === "team" || senderClass === "roster";
}

// Flows that DON'T count toward category / budget spend. A reimbursement payout
// is money leaving the account but the underlying expense was already booked
// against its category on the line item, so counting the transfer too would
// double-count.
export const NON_SPEND_FLOWS: readonly TransactionFlow[] = ["transfer"];

/** True iff a transaction's flow counts toward category/budget spend. */
export function countsAsSpend(flow: TransactionFlow): boolean {
  return !NON_SPEND_FLOWS.includes(flow);
}

// ── Reimbursements ───────────────────────────────────────────────────────────
// Public-form submissions (accountless, secret token). Optional pre-approval
// gate, then the approval → payout lifecycle. Terminal: paid / rejected /
// failed / canceled.
export const REIMBURSEMENT_STATUSES = [
  "pending_preapproval",
  "preapproved",
  "submitted",
  "approved",
  "paying",
  "paid",
  "rejected",
  "failed",
  "canceled",
] as const;
export type ReimbursementStatus = (typeof REIMBURSEMENT_STATUSES)[number];

export const REIMBURSEMENT_STATUS_LABELS: Record<ReimbursementStatus, string> = {
  pending_preapproval: "Pending pre-approval",
  preapproved: "Pre-approved",
  submitted: "Submitted",
  approved: "Approved",
  paying: "Paying",
  paid: "Paid",
  rejected: "Rejected",
  failed: "Failed",
  canceled: "Canceled",
};

/** Statuses at which a reimbursement is finished (no further transitions). */
export const REIMBURSEMENT_TERMINAL_STATUSES: readonly ReimbursementStatus[] = [
  "paid",
  "rejected",
  "canceled",
];

// ── Cards (person-owned) ─────────────────────────────────────────────────────
export const CARD_TYPES = ["virtual", "physical"] as const;
export type CardType = (typeof CARD_TYPES)[number];

export const CARD_STATUSES = ["active", "locked", "canceled"] as const;
export type CardStatus = (typeof CARD_STATUSES)[number];

// Where a card came from. A NATIVE card is issued on Increase (`increase`, the
// default when the marker is absent); a LEGACY card is an external/Relay card
// linked by its last-4 (no Increase object) so its transactions can be
// attributed to a person. Legacy cards carry no Increase controls.
export const CARD_SOURCES = ["increase", "legacy"] as const;
export type CardSource = (typeof CARD_SOURCES)[number];

/** Late-receipt auto-lock window: a card locks if a receipt is >7 days late. */
export const RECEIPT_GRACE_DAYS = 7;

/** Escalation checkpoint ahead of the day-7 auto-lock: a card charge still
 *  missing its receipt past this many days gets nudged harder (a "day-3"
 *  reminder timeline stage + email), before the terminal auto-lock at
 *  `RECEIPT_GRACE_DAYS`. */
export const RECEIPT_ESCALATE_DAYS = 3;

/** R1a — a transaction note is a short "who/why" justification, not a
 *  document: capped so a runaway paste can't bloat the row. Shared by
 *  `finances.setTransactionNote` (server-side enforcement) and
 *  `TransactionNoteModal` (the `TextField`'s `maxLength`) so the two never
 *  drift apart. */
export const MAX_NOTE_LENGTH = 2000;

// ── Card requests (WP-C.1: request-a-card) ──────────────────────────────────
// A member's request for a card, decided by an FM/Treasurer (never self-serve).
// "requested" is the only OPEN state — a person may hold at most one at a time
// (`cards.requestCard` enforces it). Terminal: "approved" (issues the card via
// the existing `issueCard` flow) or "denied".
export const CARD_REQUEST_STATUSES = ["requested", "approved", "denied"] as const;
export type CardRequestStatus = (typeof CARD_REQUEST_STATUSES)[number];

// ── Card eligibility + last-4 extraction ─────────────────────────────────────
// Cards (native + legacy) are restricted to Public Worship staff — people with
// an `@publicworship.life` email. `isCardEligible` is the single gate the card
// pickers + issuance/link mutations share so the rule can't drift.

/** True iff a Public Worship email makes a person eligible to hold a card. */
export function isCardEligible(pwEmail?: string | null): boolean {
  return (
    !!pwEmail && pwEmail.trim().toLowerCase().endsWith("@publicworship.life")
  );
}

/**
 * Parse a card's last-4 out of a synced transaction description. FC-synced rows
 * carry the card only inside the merchant/description string (e.g.
 * `"POS PURCHASE … | **2702"`) — there's no structured field. Matches the
 * `**NNNN` masked-card pattern and returns the LAST (trailing) 4-digit group,
 * which is where the card number sits when a description holds several numbers.
 * Returns null when no masked last-4 is present.
 */
export function extractCardLast4(text?: string | null): string | null {
  if (!text) return null;
  const re = /\*{2,}\s*(\d{4})(?!\d)/g;
  let last: string | null = null;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    last = match[1];
  }
  return last;
}

// ── Relay statement CSV import ────────────────────────────────────────────────
/**
 * Parse a Relay monthly-statement `Reference` string into its cardholder
 * attribution. A CARD charge's reference is
 * `"<Person Name> - <last4> (<Card Name>)"`
 * (e.g. `"Oluseyi Olujide - 2702 (Seyi's PW Card)"`) — the last-4 + trailing
 * `(Card Name)` are the tell. A PAYOUT/transfer reference is
 * `"<recipient> - <memo> - Sent By <person>"` with NO ` - <digits> (…)` tail, so
 * it never matches and returns `null` (no card attribution — Relay payouts are
 * non-card money movements).
 *
 * Returns `{ personName, cardLast4, cardName }` for a card charge, or `null` for
 * a payout-style / unparseable reference. `person` is non-greedy so a hyphenated
 * name (`"Agujudah Okey-Uche - 2588 (AJ's Card)"`) still splits at the ` - NNNN `
 * boundary, not the intra-name hyphen (which carries no surrounding spaces).
 */
export function parseRelayReference(
  ref?: string | null,
): { personName?: string; cardLast4?: string; cardName?: string } | null {
  if (!ref) return null;
  const match = ref.trim().match(/^(.+?)\s+-\s+(\d{3,4})\s+\((.+)\)\s*$/);
  if (!match) return null;
  return {
    personName: match[1].trim(),
    cardLast4: match[2],
    cardName: match[3].trim(),
  };
}

// ── Personal-charge repayment ────────────────────────────────────────────────
export const REPAYMENT_METHODS = ["card", "ach"] as const;
export type RepaymentMethod = (typeof REPAYMENT_METHODS)[number];

export const REPAYMENT_STATUSES = ["pending", "paid", "failed"] as const;
export type RepaymentStatus = (typeof REPAYMENT_STATUSES)[number];

// ── ACH destination capture (Increase External Accounts) ─────────────────────
// The funding-type Increase records on an External Account (`POST
// /external_accounts`). Increase itself also allows `general_ledger`/`other`,
// but those never apply to a person's personal bank account, so capture is
// restricted to the two a human actually has.
export const EXTERNAL_ACCOUNT_FUNDINGS = ["checking", "savings"] as const;
export type ExternalAccountFunding = (typeof EXTERNAL_ACCOUNT_FUNDINGS)[number];

// ── Payouts (ACH from the chapter's Increase account) ────────────────────────
export const PAYOUT_PROVIDERS = ["increase", "manual"] as const;
export type PayoutProvider = (typeof PAYOUT_PROVIDERS)[number];

export const PAYOUT_STATUSES = [
  "pending",
  "processing",
  "paid",
  "failed",
  "returned",
  "canceled",
] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

// ── Sandbox ↔ production environment hygiene ─────────────────────────────────
// Increase objects created in the SANDBOX come back with ids prefixed
// `sandbox_` (accounts, cards, transfers, real-time decisions); production ids
// have no such prefix. The environment lives ENTIRELY in that id prefix —
// nothing is stored per-record. A record with a NULL/empty Increase id is a
// manual/degraded record (no vendor object) and is environment-NEUTRAL: it must
// show in BOTH modes.
/** True iff an Increase object id is a sandbox object (prefixed `sandbox_`). */
export function isSandboxObjectId(id?: string | null): boolean {
  return !!id?.startsWith("sandbox_");
}

/**
 * Whether a record carrying `increaseId` should be VISIBLE in the current mode.
 * A null/empty id is env-neutral (manual/degraded) → ALWAYS visible. Otherwise
 * it shows only when its sandbox-ness matches the mode: in production
 * (`sandboxMode === false`) non-sandbox + null ids show and `sandbox_` ids hide;
 * in sandbox mode the inverse.
 */
export function matchesMode(
  increaseId: string | null | undefined,
  sandboxMode: boolean,
): boolean {
  if (!increaseId) return true; // env-neutral (manual/degraded) — always show
  return isSandboxObjectId(increaseId) === sandboxMode;
}

// ── Increase account onboarding (one Account per chapter PER ENVIRONMENT) ────
// A chapter may hold BOTH a sandbox and a production Increase account (up to one
// per environment). Each finance view acts on the account matching the current
// `sandboxMode`; the off-mode account is hidden.
export const INCREASE_ONBOARDING_STATUSES = [
  "not_started",
  "pending",
  "active",
  "disabled",
] as const;
export type IncreaseOnboardingStatus =
  (typeof INCREASE_ONBOARDING_STATUSES)[number];

/**
 * Which environment an `increaseAccounts` row belongs to. The explicit
 * `sandbox` field (stamped at provision time from the mode) is the source of
 * truth. LEGACY rows provisioned before the field existed have it unset — for
 * those we fall back to the `sandbox_` id prefix (`isSandboxObjectId`). A
 * null/pending id with no field defaults to production (`false`). The backfill
 * (`increase:runBackfillIncreaseAccountEnv`) stamps the field on legacy rows so
 * the prefix fallback is only ever a transient safety net.
 */
export function accountIsSandbox(account: {
  sandbox?: boolean | null;
  increaseAccountId?: string | null;
}): boolean {
  if (account.sandbox != null) return account.sandbox;
  return isSandboxObjectId(account.increaseAccountId);
}

// ── Legacy external accounts (Stripe Financial Connections read-sync) ────────
export const LEGACY_ACCOUNT_STATUSES = [
  "active",
  "disconnected",
  "error",
] as const;
export type LegacyAccountStatus = (typeof LEGACY_ACCOUNT_STATUSES)[number];

// ── Finance roles (graded) ───────────────────────────────────────────────────
// A graded capability ladder, evaluated by RANK. Superusers + chapter admins
// are implicitly `manager`. A separate central/org tier (financeRoles.scope
// === "central") layers org-wide roll-up access on top.
export const FINANCE_ROLES = ["viewer", "bookkeeper", "manager"] as const;
export type FinanceRole = (typeof FINANCE_ROLES)[number];

export const FINANCE_ROLE_LABELS: Record<FinanceRole, string> = {
  viewer: "Viewer",
  bookkeeper: "Bookkeeper",
  manager: "Manager",
};

/** Numeric rank for the graded ladder (higher = more capable). */
export const FINANCE_ROLE_RANK: Record<FinanceRole, number> = {
  viewer: 1,
  bookkeeper: 2,
  manager: 3,
};

/** True iff `role` is at least as capable as `min` on the graded ladder. */
export function financeRoleAtLeast(
  role: FinanceRole | null | undefined,
  min: FinanceRole,
): boolean {
  if (!role) return false;
  return FINANCE_ROLE_RANK[role] >= FINANCE_ROLE_RANK[min];
}

/** Whether a finance role grants org-wide (central) reach. */
export const FINANCE_ROLE_SCOPES = ["chapter", "central"] as const;
export type FinanceRoleScope = (typeof FINANCE_ROLE_SCOPES)[number];

// ── Central (org-level) sentinel ─────────────────────────────────────────────
// The org level ("central") is represented by the string literal `"central"`
// stored in a `chapterId` field — NEVER null/absent, and NOT a real `chapters`
// row. The value is self-describing. On the Convex side a chapter-or-central
// scope is `Id<"chapters"> | typeof CENTRAL`; we never import Convex `Id` here.
/** The org level ("central") as a chapterId sentinel — see finance-handoff. */
export const CENTRAL = "central" as const;
export type Central = typeof CENTRAL;
/** True iff a chapterId field points at the org (central) level. */
export function isCentral(chapterId: string | null | undefined): boolean {
  return chapterId === CENTRAL;
}

// ── Specialized roles (leadership + finance, at central/chapter scope) ───────
// Super-admin-managed org roles layered on top of the graded finance ladder.
// A TITLE has a fixed KIND (leadership vs finance) and a valid SCOPE constraint
// (central-only, chapter-only, or either). Leadership titles (ED/president) drive
// oversight + the scope-local separation-of-duties constraint; the finance title
// (finance_manager) additionally BRIDGES to a `financeRoles` manager grant, so it
// confers real finance-write capability. Stored on `specializedRoles` with the
// `"central"` sentinel for org scope (never null), mirroring the finance layer.
export const SPECIALIZED_ROLE_TITLES = [
  "executive_director",
  "president",
  "finance_manager",
] as const;
export type SpecializedRoleTitle = (typeof SPECIALIZED_ROLE_TITLES)[number];

export const SPECIALIZED_ROLE_KINDS = ["leadership", "finance"] as const;
export type SpecializedRoleKind = (typeof SPECIALIZED_ROLE_KINDS)[number];

// Which scope(s) a title may be assigned at: only the org level, only a chapter,
// or either. Central is the `"central"` sentinel; a chapter is a real chapter id.
export type SpecializedRoleScopeConstraint = "central" | "chapter" | "any";

export interface SpecializedRoleMeta {
  /** The kind this title belongs to (drives SoD + the finance bridge). */
  kind: SpecializedRoleKind;
  /** The scope(s) this title may be assigned at. */
  scope: SpecializedRoleScopeConstraint;
  /** Human-readable label for governance surfaces. */
  label: string;
}

export const SPECIALIZED_ROLE_META: Record<
  SpecializedRoleTitle,
  SpecializedRoleMeta
> = {
  executive_director: {
    kind: "leadership",
    scope: "central",
    label: "Executive Director",
  },
  president: {
    kind: "leadership",
    scope: "chapter",
    // Owner-approved naming (WP-1.1): the org chart calls this seat "Chapter
    // Director" — the owner says "president" verbally, but that's not what
    // ships in UI copy. The identifier stays `president` (schema/authz
    // untouched); only the display label changed.
    label: "Chapter Director",
  },
  finance_manager: {
    kind: "finance",
    scope: "any",
    label: "Finance Manager",
  },
};

/** The kind (leadership | finance) a specialized-role title belongs to. */
export function titleKind(title: SpecializedRoleTitle): SpecializedRoleKind {
  return SPECIALIZED_ROLE_META[title].kind;
}

/**
 * WP-1.1: the single source of truth for a specialized-role title's org-chart
 * display name — SCOPE-aware, because `finance_manager` is one title/grant
 * assigned at either level (`scope: "any"`) but reads differently depending
 * on which: "Finance Manager" at central, "Treasurer" at a chapter (the PRD's
 * seat-table mapping — treasurer IS the chapter finance_manager seat, not a
 * parallel title). Every other title's label is scope-invariant, so this
 * falls back to `SPECIALIZED_ROLE_META[title].label` for those.
 */
export function specializedRoleLabel(
  title: SpecializedRoleTitle,
  scopeIsCentral: boolean,
): string {
  if (title === "finance_manager" && !scopeIsCentral) return "Treasurer";
  return SPECIALIZED_ROLE_META[title].label;
}

/**
 * True iff `title` may be assigned at the given scope. `scopeIsCentral` is true
 * for the org level (`"central"`), false for a chapter. `"any"` titles fit both.
 */
export function titleAllowsScope(
  title: SpecializedRoleTitle,
  scopeIsCentral: boolean,
): boolean {
  const constraint = SPECIALIZED_ROLE_META[title].scope;
  if (constraint === "any") return true;
  return scopeIsCentral ? constraint === "central" : constraint === "chapter";
}

// ── Money formatting (single source of truth) ────────────────────────────────
/**
 * Format integer cents as a USD string. `cents` is always an integer amount in
 * cents (never a float dollar value). Defaults to no decimal places when the
 * amount is a whole number of dollars and `compact` is set, else 2 dp.
 */
export function formatCents(
  cents: number,
  opts: { showCents?: boolean } = {},
): string {
  const showCents = opts.showCents ?? true;
  const dollars = cents / 100;
  return dollars.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: showCents ? 2 : 0,
    maximumFractionDigits: showCents ? 2 : 0,
  });
}

/** Sum a list of integer-cent amounts (guards against float drift). */
export function sumCents(amounts: readonly number[]): number {
  return amounts.reduce((total, c) => total + Math.round(c), 0);
}

// ── Period bucketing (America/New_York) ──────────────────────────────────────
// Budgets bucket by month / quarter / year in the chapter's home timezone
// (America/New_York), then convert to UTC ms for range indexes on transactions.
// These helpers derive the (year, month, quarter) a timestamp falls in when
// read in Eastern time, so a late-night charge doesn't slip into the wrong month.
export const FINANCE_TIMEZONE = "America/New_York";

/** The Eastern-time calendar parts (year, 1-based month, day) of a timestamp. */
export function easternParts(ts: number): {
  year: number;
  month: number;
  day: number;
} {
  // `en-CA` yields ISO-ish `YYYY-MM-DD`, which is trivial to split.
  const s = new Date(ts).toLocaleDateString("en-CA", {
    timeZone: FINANCE_TIMEZONE,
  });
  const [year, month, day] = s.split("-").map((n) => parseInt(n, 10));
  return { year, month, day };
}

/** The 1-based quarter (1–4) a month (1-based) falls in. */
export function quarterOfMonth(month: number): number {
  return Math.floor((month - 1) / 3) + 1;
}

// ── Split reattribution heuristics (WP-2.2) ──────────────────────────────────
// The playbook's boundary rules for the retroactive split (Phase 2). These are
// SUGGESTION heuristics only — `suggestSplitAssignments` uses them to bucket a
// chapter's history into "likely central" vs "likely chapter"; a human always
// confirms before `reassignTransactions` moves anything. Kept here (not inline)
// so the boundary list is one editable constant the owner can tune per the
// City Launch Playbook, never a magic string buried in a query.

/**
 * Merchant-name keywords that suggest a CENTRAL charge (org-wide spend the
 * playbook keeps at central: expansion, conference, brand). A case-insensitive
 * substring match on `transactions.merchantName` (or `description`) proposes
 * "central". Editable — add the org's real recurring central merchants here.
 */
export const CENTRAL_MERCHANT_KEYWORDS: readonly string[] = [
  "expansion",
  "conference",
  "brand",
  "city launch",
  "training",
];

/**
 * Project-name keywords that mark a project as CENTRAL-owned (owner decision #2,
 * 2026-07-16): the Music/recording project is organized ACROSS chapters, so it's
 * central — the one explicit exception to "all NY projects transfer to the
 * chapter". A case-insensitive substring match on the project name proposes
 * "central" for that project's txns; every other project defaults to "chapter".
 * The UI exposes the full project list so a human can override per-project.
 */
export const CENTRAL_PROJECT_KEYWORDS: readonly string[] = ["music", "record"];

/** Case-insensitive: does `text` contain ANY of `keywords`? (Empty → false.) */
export function matchesAnyKeyword(
  text: string | null | undefined,
  keywords: readonly string[],
): boolean {
  if (!text) return false;
  const haystack = text.toLowerCase();
  return keywords.some((k) => haystack.includes(k.toLowerCase()));
}

/** The max number of transaction ids one bulk-reattribution call accepts. The
 *  UI paginates larger split runs; a hard cap keeps a single mutation bounded
 *  (invariant: reads/writes stay bounded). */
export const REASSIGN_BATCH_CAP = 200;

// ── Affordability (WP-4.3: "can we afford this event?") ─────────────────────
// The City Launch Playbook's chapter-affordability model (PRD §0.1): a manual
// backer HEADCOUNT (never dollars — the future Giving page, F-6, is the real
// backer platform) drives monthly revenue → a tier label → the monthly
// operating floor → the central skim → what's left over (discretionary).
// Every constant below is a playbook fact, kept here (not inline in a query or
// component) so the owner can tune it in one place.

/** One backer's monthly pledge, in cents ($50/mo). Headcount × this = revenue.
 *  Mirrors the playbook's "$50/mo" backer unit — never a floating dollar. */
export const BACKER_UNIT_CENTS = 5000;

/** The chapter → central "City Launch Fund" skim, as a fraction of a chapter's
 *  monthly backer revenue. Playbook: flat 15%, owner-confirmed 2026-07-16 (§3.3
 *  — "Skim: flat 15% confirmed"). Modeled as a `flow:"transfer"` pair once
 *  accounts are live (WP-4.1); this constant is the one place both the
 *  affordability header and the transfer automation read the rate from. */
export const CENTRAL_SKIM_PCT = 0.15;

/** Monthly operating floor's FIXED (headcount-independent) component, in cents
 *  ($570). The City Launch Playbook's "fixed base": WWS film $200 · WWS event
 *  food $160 · equipment transport $100 · storage $60 · software $50. Meeting
 *  food is the PER-TEAMMATE component below (it scales with team size), not part
 *  of this base. (Updated 2026-07-21 to the leaner software stack — was $520
 *  with a $150 software line and meeting food folded into the base.) */
export const OPERATING_FLOOR_FIXED_CENTS = 57_000;

/** Monthly operating floor's PER-TEAMMATE component, in cents ($20/teammate) —
 *  the monthly team-meeting meal at $20/person. Sanity check against the
 *  playbook's stated $670 floor for a 5-person team:
 *  `OPERATING_FLOOR_FIXED_CENTS + 5 * OPERATING_FLOOR_PER_TEAMMATE_CENTS`
 *  = $570 + 5×$20 = $670. ✓ (30 backers/~6 team → $690; 50/~7 → $710.) */
export const OPERATING_FLOOR_PER_TEAMMATE_CENTS = 2000;

/**
 * Backer-count tier thresholds (the playbook's deep-dive numbers, owner-
 * confirmed 2026-07-16 — supersedes the stale one-pager's 25/50/75). Ordered
 * HIGHEST THRESHOLD FIRST — `affordabilityTierLabel` walks it top-down and
 * returns the first threshold met.
 */
export const AFFORDABILITY_TIERS: readonly {
  minBackers: number;
  label: string;
}[] = [
  { minBackers: 50, label: "+LTN" },
  { minBackers: 30, label: "+Eden" },
  { minBackers: 20, label: "WWS" },
];

// ── City Launch Playbook: public transparency breakdowns ─────────────────────
// Single-sourced figures for the public `/give` page's "where your giving goes"
// sections, so the page can NEVER drift from the real model. Every number below
// is from the City Launch Playbook (Backer Model, Chapter Budget & Finances,
// Chapter Team & Roles). Amounts are integer cents. Keep these truthful — the
// giving page renders them verbatim.

/** One labeled money line in a transparency breakdown. */
export interface MoneyLine {
  label: string;
  amountCents: number;
  note?: string;
}

/**
 * The ~$670/mo monthly operating floor for a 5-person, 20-backer chapter — what
 * recurring backers sustain every month. Sums to
 * `OPERATING_FLOOR_FIXED_CENTS + 5 * OPERATING_FLOOR_PER_TEAMMATE_CENTS` = $670.
 */
export const MONTHLY_OPERATING_LINES: readonly MoneyLine[] = [
  { label: "Film crew & editing (Worship With Strangers)", amountCents: 20_000 },
  { label: "Food — team, musicians & volunteers", amountCents: 16_000 },
  { label: "Equipment transport (gas + rideshare)", amountCents: 10_000 },
  { label: "Monthly team-meeting meal ($20 × 5)", amountCents: 10_000 },
  { label: "Storage unit (5×5)", amountCents: 6_000 },
  { label: "Software & subscriptions", amountCents: 5_000 },
];

/**
 * The one-time starter EQUIPMENT package (~$4,287) the central City Launch Fund
 * buys so a new city owns its production kit from day one — the "what we're
 * trying to buy" list. Durable, one-time; the chapter keeps it for years.
 */
export const LAUNCH_EQUIPMENT_LINES: readonly MoneyLine[] = [
  { label: "4× Shure SM58 microphones", amountCents: 44_000 },
  { label: "Keyboard", amountCents: 50_000 },
  { label: "Guitar", amountCents: 50_000 },
  { label: "Mixer", amountCents: 50_000 },
  { label: "2× Speakers", amountCents: 100_000 },
  { label: "200W battery", amountCents: 20_000 },
  { label: "2000W battery", amountCents: 50_000 },
  { label: "XLR cables, ties & accessories", amountCents: 20_000 },
  { label: "Storage racks", amountCents: 10_000 },
  { label: "Tax & shipping (est.)", amountCents: 34_700 },
];

/**
 * The one-time NYC TRAINING TRIP (~$3,700) — the founding team of five comes to
 * the mothership to learn the model firsthand before launching locally. Carried
 * by central, never the new city's monthly budget.
 */
export const LAUNCH_TRAINING_TRIP_LINES: readonly MoneyLine[] = [
  { label: "Flights (5 × ~$300 round-trip)", amountCents: 150_000 },
  { label: "Lodging (shared, ~4 nights)", amountCents: 120_000 },
  { label: "Local transit & meals (5 people)", amountCents: 100_000 },
];

/** A public backer tier — the canon event(s) a chapter GUARANTEES its backers at
 *  each headcount, and the monthly revenue that headcount represents. */
export interface PublicBackerTier {
  minBackers: number;
  monthlyCents: number;
  commitment: string;
}

/**
 * The three backer tiers as guarantees (not ceilings): the canon Public Worship
 * identity a chapter commits to deliver at each backer headcount. 20 → WWS,
 * 30 → +Eden, 50 → +Love Thy Neighbor. Monthly = headcount × `BACKER_UNIT_CENTS`.
 */
export const PUBLIC_BACKER_TIERS: readonly PublicBackerTier[] = [
  { minBackers: 20, monthlyCents: 100_000, commitment: "Worship With Strangers, every month" },
  { minBackers: 30, monthlyCents: 150_000, commitment: "+ Eden, the annual worship-and-picnic gathering" },
  { minBackers: 50, monthlyCents: 250_000, commitment: "+ Love Thy Neighbor, the neighborhood block party" },
];

/** A chapter's 5-person volunteer core-team role and what it owns. */
export interface ChapterCoreRole {
  role: string;
  owns: string;
}

/**
 * The 5-person volunteer core team every chapter runs on — each role mirrors a
 * central director. Leadership is volunteer; there is no chapter-level payroll.
 * Grows to ~10 (adds +3 events, +2 music) for Eden / Love Thy Neighbor scale.
 */
export const CHAPTER_CORE_ROLES: readonly ChapterCoreRole[] = [
  { role: "Chapter Director", owns: "Vision, alignment, leadership, fundraising & backers" },
  { role: "Music Lead", owns: "Worship, musicians, sound" },
  { role: "Event / Production Lead", owns: "Logistics, production, run of show" },
  { role: "Marketing Lead", owns: "Reach, content, turnout" },
  { role: "Treasurer", owns: "Budget, records, reimbursements" },
];

/** Tier label shown below the lowest threshold in `AFFORDABILITY_TIERS`
 *  (or the lowest threshold of whatever `tiers` array is in play). */
export const PRE_TIER_LABEL = "Pre-tier";

/** The `{minBackers, label}` shape a tier ladder needs — matches
 *  `AFFORDABILITY_TIERS`'s element type and the `backerMilestones` table's
 *  own two fields, so a Convex-side caller can map its rows straight into
 *  this without re-declaring the shape. */
export interface TierLike {
  minBackers: number;
  label: string;
}

/**
 * The tier label for a given backer count: the HIGHEST `minBackers`
 * threshold met in `tiers`, else `PRE_TIER_LABEL`. Order-independent (finds
 * the max qualifying threshold rather than walking in array order), so it
 * behaves the same whether `tiers` is sorted ascending (as
 * `backerMilestones` rows come back) or descending (as `AFFORDABILITY_TIERS`
 * is declared).
 *
 * `tiers` defaults to `AFFORDABILITY_TIERS` — the giving-platform PRD §3
 * milestone ladder (`apps/convex/backerMilestones.ts`) is configurable, but
 * this constant stays the fallback so finance never breaks if that config is
 * empty. Every existing call site (omitting `tiers`) is unchanged.
 */
export function affordabilityTierLabel(
  backerCount: number,
  tiers: readonly TierLike[] = AFFORDABILITY_TIERS,
): string {
  let label = PRE_TIER_LABEL;
  let bestMinBackers = -Infinity;
  for (const tier of tiers) {
    if (backerCount >= tier.minBackers && tier.minBackers > bestMinBackers) {
      bestMinBackers = tier.minBackers;
      label = tier.label;
    }
  }
  return label;
}

/** The full WP-4.3 computation's shape — see `chapterAffordability`. */
export interface ChapterAffordability {
  monthlyRevenueCents: number;
  tierLabel: string;
  floorCents: number;
  skimCents: number;
  /** `monthlyRevenueCents - floorCents - skimCents`. May be NEGATIVE (spend
   *  commitments exceed what backer revenue covers after the floor + skim) —
   *  callers clamp the DISPLAY ("under water by $X"), never this raw value. */
  discretionaryCents: number;
}

/**
 * The WP-4.3 "can we afford this?" computation: backers → revenue → tier →
 * operating floor → central skim → discretionary. Pure (no ctx, no rounding
 * surprises beyond the skim's cent rounding) so it's testable without
 * convex-test and reusable by both the `chapterAffordability` query and any
 * future consumer (e.g. an event's "can we afford this?" check).
 *
 * `backerCount` is the chapter's MANUAL entry (§0.1 — no Giving page yet).
 * `teammateCount` is the chapter's active team-member headcount; see
 * `finances.chapterAffordability` in the Convex backend for exactly which
 * roster rows count (documented there since it queries `people`, which this
 * pure module can't reach). `tiers` (giving-platform PRD §3) optionally
 * overrides the milestone ladder used for `tierLabel`; omitted, it defaults
 * to `AFFORDABILITY_TIERS` via `affordabilityTierLabel` — every existing call
 * site is unchanged.
 */
export function chapterAffordability(
  backerCount: number,
  teammateCount: number,
  tiers?: readonly TierLike[],
): ChapterAffordability {
  const monthlyRevenueCents = backerCount * BACKER_UNIT_CENTS;
  const floorCents =
    OPERATING_FLOOR_FIXED_CENTS +
    teammateCount * OPERATING_FLOOR_PER_TEAMMATE_CENTS;
  const skimCents = Math.round(monthlyRevenueCents * CENTRAL_SKIM_PCT);
  const discretionaryCents = monthlyRevenueCents - floorCents - skimCents;
  return {
    monthlyRevenueCents,
    tierLabel: affordabilityTierLabel(backerCount, tiers),
    floorCents,
    skimCents,
    discretionaryCents,
  };
}

// ── The City Launch Fund money flows (WP-4.1 skim · WP-4.2 launch grant) ──────
// The playbook models money moving BOTH ways between a chapter and central (PRD
// §0.1): UP is the monthly ~15% skim (chapter → central City Launch Fund); DOWN
// is a one-time launch grant (central → a new chapter, equipment + training
// trip). Both are recorded as a PAIR of `flow:"transfer"` transactions — an
// outflow leg on the source scope + an inflow leg on the destination scope —
// linked by a shared `transactions.transferGroupId`. Transfers never count as
// spend (`countsAsSpend`), so they distort no budget/category rollup.
//
// NOTE: `BACKER_UNIT_CENTS` and `CENTRAL_SKIM_PCT` are defined once, above, in
// the Affordability (WP-4.3) section — both the affordability header and this
// transfer automation read the same two constants.

/**
 * The integer-cents skim owed on a month's backer revenue. `Math.round` gives
 * banker-free round-half-up on the exact `revenue × 0.15` product (e.g.
 * 250_000 → 37_500; 333_333 → 50_000 — 49_999.95 rounds up). Always returns a
 * whole number of cents so the ledger never carries a fractional amount.
 */
export function skimAmountCents(monthlyBackerRevenueCents: number): number {
  return Math.round(monthlyBackerRevenueCents * CENTRAL_SKIM_PCT);
}

/** The kinds of money movement between a chapter and central. Stored on the
 *  transfer legs as `transactions.source` (mirroring `reimbursement`), so a leg
 *  is self-describing and the City Launch Fund position is a simple sum by
 *  source over central-scope legs — no group-id prefix parsing. `settlement`
 *  (WP-4.5) is the third kind: it true-ups the net cash imbalance created by
 *  cross-scope attribution (a card on one scope's account paying for the
 *  other scope's budget) — see `settlementTransferGroupId` below. */
export const TRANSFER_KINDS = ["skim", "launch_grant", "settlement"] as const;
export type TransferKind = (typeof TRANSFER_KINDS)[number];

/**
 * The deterministic id shared by both legs of a monthly skim pair — one per
 * (chapter, year, month). Doubles as the Increase account-transfer
 * `Idempotency-Key` and the re-record guard, so a given month's skim can be
 * recorded/initiated exactly once. Month is zero-padded for a stable key.
 */
export function skimTransferGroupId(
  chapterId: string,
  year: number,
  month: number,
): string {
  return `skim-${chapterId}-${year}-${String(month).padStart(2, "0")}`;
}

/**
 * The deterministic id shared by both legs of a launch grant — one per chapter,
 * FOR ALL TIME (a launch grant is a one-time event). Doubles as the Increase
 * `Idempotency-Key` and the re-record guard, so a chapter can be launch-granted
 * exactly once.
 */
export function launchTransferGroupId(chapterId: string): string {
  return `launch-${chapterId}`;
}

/** One planned line of the launch budget stamped on a newly-granted chapter. */
export interface LaunchBudgetLine {
  label: string;
  amountCents: number;
}

/**
 * The City Launch Playbook's one-time launch budget (PRD §0.1: equipment
 * ~$4,300 + an NYC training trip ~$3,500–4,000, ~$7,800–8,300/city total).
 * Editable product constant — stamped as `one_time` chapter budgets on the
 * chapter a launch grant funds (WP-4.2). Only NONZERO lines become budgets
 * (owner rule), so a line can be zeroed here to skip it without code changes.
 */
export const LAUNCH_BUDGET_TEMPLATE: readonly LaunchBudgetLine[] = [
  { label: "Launch equipment", amountCents: 430_000 },
  { label: "Training trip — travel", amountCents: 200_000 },
  { label: "Training trip — lodging", amountCents: 120_000 },
  { label: "Training trip — meals & local transport", amountCents: 50_000 },
];

/** The default launch-grant amount: the sum of the template's nonzero lines. */
export function launchTemplateTotalCents(): number {
  return LAUNCH_BUDGET_TEMPLATE.reduce(
    (sum, line) => sum + Math.max(0, line.amountCents),
    0,
  );
}

// ── Inter-scope settlement balances (WP-4.5) ──────────────────────────────────
// Owner policy: "Your card determines whose account paid; reconcile determines
// whose budget it was; Central settles the difference monthly alongside the
// skim." Cards stay account-scoped (cash physics) but attribution (a txn's
// `budgetId`) crosses scopes freely — a chapter's card can pay for a central
// budget line. That creates a net CASH imbalance between the two accounts,
// separate from the skim: a `settlement` transfer pair (like a skim/launch
// grant) true-ups the difference. See `apps/convex/transfers.ts#interScopeBalances`
// for the ledger-derived balance computation.

/**
 * The deterministic id shared by both legs of ONE MONTH's settlement between
 * central and a chapter — one per (chapter, year, month), regardless of
 * direction (a settlement can run either way in a given month). Doubles as
 * the Increase `Idempotency-Key` and the re-record guard, so a given month's
 * settlement can be recorded/initiated exactly once, mirroring
 * `skimTransferGroupId`.
 */
export function settlementTransferGroupId(
  chapterId: string,
  year: number,
  month: number,
): string {
  return `settle-${chapterId}-${year}-${String(month).padStart(2, "0")}`;
}

// ── Money-page unification (WP-money-unify PR1) ───────────────────────────────
// A cost-bearing row (`eventItems`, `engagements`) now carries an OPTIONAL
// `budgetCategoryId` override (see `schema/events.ts#eventItems` /
// `schema/people.ts#engagements`). When it's unset, a read-side consumer (the
// Money-page plan view, landing in a follow-up PR) falls back to a sensible
// DEFAULT category per module — good-enough categorization out of the box
// without forcing every row to be hand-categorized.

/**
 * Default budget-category NAME per module key, keyed by the item's `module`
 * string (`eventItems.module` — see `MODULE_KEYS` in `./index`). A module not
 * listed here (e.g. `volunteer_expectations`, `retro` — not typically
 * cost-bearing) or any future/custom module key falls back to `"Other"` at
 * the consumer.
 *
 * Names MUST match a chapter's seeded category names EXACTLY —
 * `DEFAULT_EXPENSE_CATEGORIES` in `apps/convex/lib/seed/finance.ts:28-42`
 * (Convex-side; not importable from this package) is the source of truth. A
 * unit test pins this coupling by comparing the two lists directly.
 */
export const MODULE_DEFAULT_CATEGORY_NAMES: Record<string, string> = {
  supplies: "Supplies",
  comms: "Marketing & Advertising",
  planning_doc: "Other",
  permits: "Other",
  run_of_show: "Other",
};

/**
 * Default budget-category name for a paid `engagements` row (a vendor) with
 * no `budgetCategoryId` override. Must also match a name in
 * `DEFAULT_EXPENSE_CATEGORIES` — see `MODULE_DEFAULT_CATEGORY_NAMES` above.
 */
export const VENDOR_DEFAULT_CATEGORY_NAME = "Professional Services";
