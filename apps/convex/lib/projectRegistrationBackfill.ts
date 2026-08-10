/**
 * The Worship Beyond The Walls registration fixture, and the pure planner that
 * turns it into rows — the decision half of `backfillWorshipRegistrations.ts`,
 * split out so the arithmetic and the SKIP rules can be tested without a
 * deployment (the mutation's ids are production ids; convex-test can't mint
 * them). Same shape `gear2024Split.ts` uses: a one-time runner beside a
 * separate dataset module, dry-run by default, refusing rather than
 * half-applying.
 *
 * DELETE THIS FILE WITH ITS MUTATION once the backfill has run — that is the
 * house rule, and #596 ("A one-off that has finished its job is dead code")
 * deleted fourteen of them at once to make the point.
 *
 * ── WHAT HAPPENED ───────────────────────────────────────────────────────────
 * "Worship Beyond The Walls" was a multi-session class with a $50 Student
 * Registration fee, sold through a Givebutter campaign of the same name. Six
 * people paid ($300.00 across six transactions). Three were refunded as
 * scholarships ($150.00). The remaining $150.00 was remitted in payout
 * `KKJ3TQ`. Givebutter's side is provably correct; our books had none of it,
 * because the class was a `projects` row and there was no person↔project link
 * in the schema to record a registration against.
 *
 * That $150.00 is the last of the org-wide reconciliation gap. `gap = cash −
 * books`, the cash already arrived, so booking the revenue moves the gap DOWN
 * by $150.00 — see `lib/reconciliationGap.ts`'s sign convention.
 *
 * ── WHY THERE ARE NO NAMES IN THIS FILE ─────────────────────────────────────
 * Only opaque Givebutter transaction ids live here. The registrants' names and
 * emails are supplied at RUN TIME.
 *
 * The emails are obvious: six real people's addresses don't belong in source
 * control. The names are the same call for a less obvious reason — three of
 * these six rows say `refunded (scholarship)`, and "this named person received
 * a scholarship" is financial-need information about a real individual. That is
 * at least as sensitive as an address, and a repo is forever while a one-off
 * module is not. A transaction id is meaningless without the export; a name
 * beside the word "scholarship" is not.
 *
 * The cost is that the operator supplies more at run time. For a module headed
 * "delete this once run", that is the right trade.
 */
import type { RegistrationStatus } from "@events-os/shared";

/** The project the class ran as, and the book its money belongs to. */
export const WBTW_PROJECT_ID = "rd776xf2snzx3nw5sqqb2r0kn18aqnhn";
export const WBTW_CHAPTER_ID = "kh73xrr66rxt2wzr3ny5c2c4kh88n06n";
/** Every row is one $50.00 "Student Registration" item. Asserted, not assumed. */
export const REGISTRATION_CENTS = 5_000;
/** Givebutter's payout that remitted the three that stuck. */
export const PAYOUT_REF = "KKJ3TQ";

export interface RegistrationFixtureRow {
  /** The Givebutter transaction id — the idempotency key, namespaced into
   *  `externalRef` as `gb:txn:<id>` by `externalRefFor` below, and the join key
   *  the operator supplies names/emails against. */
  givebutterTxnId: string;
  /** UTC midnight of the day the registration was taken. Dates come from
   *  Givebutter's transaction list; the class had no timestamp finer than the
   *  day, and inventing one would be inventing precision. Rendered back in UTC
   *  for the same reason — see
   *  `apps/mobile/components/money/registrationDisplay.ts`. */
  registeredAt: number;
  status: RegistrationStatus;
  refundReason?: string;
}

/** UTC midnight for a `YYYY-MM-DD` day — no local-timezone drift, which on a
 *  date-only source is the difference between Jan 26 and Jan 25. */
function utcDay(iso: string): number {
  return Date.parse(`${iso}T00:00:00.000Z`);
}

/**
 * The namespaced idempotency key.
 *
 * ⚠ `gb:txn:<id>` IS NOT UNIQUE ACROSS TABLES. `gifts.externalRef` already uses
 * exactly this prefix for Givebutter transactions (see
 * `lib/seed/historical/giving.ts` and `givebutterSync.ts`), so the string
 * identifies a Givebutter TRANSACTION, not a row in one table. Dedup is
 * per-table by construction — this backfill checks `registrations`'
 * `by_external_ref` index and nothing else — which is correct here (a
 * transaction that produced a registration produced no gift), but it means
 * "does this externalRef exist?" is never a question you can ask globally.
 */
export function externalRefFor(givebutterTxnId: string): string {
  return `gb:txn:${givebutterTxnId}`;
}

/**
 * The six, as transaction ids only. Dates and statuses are facts about the
 * money; the humans behind them arrive at run time (see the header).
 */
export const WBTW_REGISTRATIONS: RegistrationFixtureRow[] = [
  { givebutterTxnId: "4284185383", registeredAt: utcDay("2026-01-29"), status: "paid" },
  { givebutterTxnId: "3267180644", registeredAt: utcDay("2026-01-26"), status: "paid" },
  { givebutterTxnId: "6680142853", registeredAt: utcDay("2026-01-26"), status: "paid" },
  {
    givebutterTxnId: "8784708028",
    registeredAt: utcDay("2026-01-29"),
    status: "refunded",
    refundReason: "scholarship",
  },
  {
    givebutterTxnId: "4030672614",
    registeredAt: utcDay("2026-01-26"),
    status: "refunded",
    refundReason: "scholarship",
  },
  {
    givebutterTxnId: "7372397745",
    registeredAt: utcDay("2026-01-26"),
    status: "refunded",
    refundReason: "scholarship",
  },
];

/** What the operator supplies for one transaction id. */
export interface RegistrantIdentity {
  name: string;
  /** Normalised (trimmed, lowercased) by the caller. Optional — a registration
   *  with no address still records, just unlinked. */
  email?: string;
}

/** What the planner was told about the deployment. Deliberately plain data —
 *  the mutation does every read, this function does every decision. */
export interface BackfillWorld {
  /** The project at `WBTW_PROJECT_ID`, or null if it isn't there. */
  project: { id: string; chapterId: string; name: string } | null;
  /** External refs of registrations that already exist, from the
   *  `by_external_ref` index. Membership = "already imported". */
  existingExternalRefs: ReadonlySet<string>;
  /** Lowercased email → `people` id, for the rows we can link. Built from the
   *  roster by EMAIL ONLY — never by name. `findDonorInScope`'s exact-string
   *  name fallback has matched the wrong human in this deployment before, and
   *  a registration is a money row: a wrong link puts someone else's payment on
   *  a stranger's record. An unlinked row is complete on its own, which is why
   *  `personId` is optional in the schema. */
  personIdByEmail: ReadonlyMap<string, string>;
  /**
   * Givebutter transaction id → who that registration belongs to, SUPPLIED BY
   * THE OPERATOR at run time. Keyed on the transaction id because two people
   * can share a name; they cannot share a txn id.
   *
   * Source: the `Name` and `Email` columns of
   * `3-worship-beyond-the-walls-1786127710.csv` in the 2026-08-07 Givebutter
   * export. See this file's header for why they are not checked in.
   */
  registrantByTxnId: ReadonlyMap<string, RegistrantIdentity>;
}

export interface PlannedRegistration {
  name: string;
  externalRef: string;
  amountCents: number;
  status: RegistrationStatus;
  refundReason?: string;
  registeredAt: number;
  /** The `people` row this registration links to, matched on EMAIL. */
  personId?: string;
  email?: string;
}

export interface BackfillPlan {
  /** Rows that would be inserted (dry run) or were inserted (execute). */
  inserts: PlannedRegistration[];
  /** Rows already present under the same `externalRef` — the idempotency
   *  evidence. A second run puts all six here and inserts nothing. */
  alreadyPresent: string[];
  /** Revenue this plan adds to the chapter's book: the `paid` rows only. */
  paidCents: number;
  /** What the six rows are worth in total, paid + refunded. Not revenue —
   *  reported so the $300.00 Givebutter collected is visible in the output. */
  grossCents: number;
  /** How many rows found a `people` row to link to. */
  linkedPeople: number;
  /**
   * Anything that didn't match. NON-EMPTY MEANS NOTHING IS WRITTEN — the house
   * rule from `gear2024Split.ts`: a backfill that half-applies against a
   * deployment it doesn't recognise is worse than one that stops.
   */
  problems: string[];
}

/**
 * Decide what the backfill would do. Pure: no ctx, no writes, no clock.
 *
 * NOTE ON `refundedAt`: never set. Givebutter's export gave the refund a status
 * but not a date, and a `refundedAt` copied from `registeredAt` would be a
 * fabricated fact on a money row. The schema documents the field as "when
 * known" for exactly this reason.
 */
export function planRegistrationBackfill(world: BackfillWorld): BackfillPlan {
  const problems: string[] = [];
  const empty: BackfillPlan = {
    inserts: [],
    alreadyPresent: [],
    paidCents: 0,
    grossCents: 0,
    linkedPeople: 0,
    problems,
  };

  if (!world.project) {
    problems.push(
      `project ${WBTW_PROJECT_ID} not found in this deployment — SKIPPED`,
    );
    return empty;
  }
  if (world.project.chapterId !== WBTW_CHAPTER_ID) {
    problems.push(
      `project ${WBTW_PROJECT_ID} belongs to chapter ${world.project.chapterId}, expected ${WBTW_CHAPTER_ID} — SKIPPED`,
    );
  }
  if (!/worship beyond the walls/i.test(world.project.name)) {
    problems.push(
      `project ${WBTW_PROJECT_ID} is named "${world.project.name}", expected "Worship Beyond the walls" — SKIPPED`,
    );
  }
  // A name is REQUIRED by the schema and lives only in the operator's export,
  // so a missing one is a precondition failure, not a row to guess at. Reported
  // by transaction id — never by any identifying detail we do hold.
  for (const row of WBTW_REGISTRATIONS) {
    const identity = world.registrantByTxnId.get(row.givebutterTxnId);
    if (identity == null || identity.name.trim() === "") {
      problems.push(
        `no registrant name supplied for ${externalRefFor(row.givebutterTxnId)} — SKIPPED`,
      );
    }
  }
  if (problems.length > 0) return empty;

  const inserts: PlannedRegistration[] = [];
  const alreadyPresent: string[] = [];
  let paidCents = 0;
  let grossCents = 0;
  let linkedPeople = 0;

  for (const row of WBTW_REGISTRATIONS) {
    const externalRef = externalRefFor(row.givebutterTxnId);
    grossCents += REGISTRATION_CENTS;
    if (row.status === "paid") paidCents += REGISTRATION_CENTS;
    if (world.existingExternalRefs.has(externalRef)) {
      alreadyPresent.push(externalRef);
      continue;
    }
    // Non-null by the precondition loop above.
    const identity = world.registrantByTxnId.get(row.givebutterTxnId) as RegistrantIdentity;
    const email = identity.email?.trim().toLowerCase();
    const personId = email ? world.personIdByEmail.get(email) : undefined;
    if (personId) linkedPeople += 1;
    inserts.push({
      name: identity.name.trim(),
      externalRef,
      amountCents: REGISTRATION_CENTS,
      status: row.status,
      ...(row.refundReason ? { refundReason: row.refundReason } : {}),
      registeredAt: row.registeredAt,
      ...(personId ? { personId } : {}),
      ...(email ? { email } : {}),
    });
  }

  return { inserts, alreadyPresent, paidCents, grossCents, linkedPeople, problems };
}
