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

// The dashboard perspective a viewer sees, from their tier + finance role.
export const FINANCE_PERSPECTIVES = ["central", "chapter", "member"] as const;
export type FinancePerspective = (typeof FINANCE_PERSPECTIVES)[number];

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
    label: "President",
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
