/**
 * The Worship Beyond The Walls registration fixture, and the pure planner that
 * turns it into rows — the decision half of `backfillWorshipRegistrations.ts`,
 * split out so the arithmetic and the SKIP rules can be tested without a
 * deployment (the mutation's ids are production ids; convex-test can't mint
 * them).
 *
 * DELETE THIS FILE WITH ITS MUTATION once the backfill has run.
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
 */
import type { RegistrationStatus } from "@events-os/shared";

/** The project the class ran as, and the book its money belongs to. */
export const WBTW_PROJECT_ID = "rd776xf2snzx3nw5sqqb2r0kn18aqnhn";
export const WBTW_CHAPTER_ID = "kh73xrr66rxt2wzr3ny5c2c4kh88n06n";
/** Every row is one $50.00 "Student Registration" item. Asserted, not assumed. */
export const REGISTRATION_CENTS = 5_000;
/** Givebutter's payout that remitted the three that stuck. Recorded on the
 *  rows' provenance note in the PR, not in the table — the table's job is the
 *  registration, and the payout is already a reconciled deposit. */
export const PAYOUT_REF = "KKJ3TQ";

export interface RegistrationFixtureRow {
  name: string;
  /** The Givebutter transaction id — the idempotency key, namespaced into
   *  `externalRef` as `gb:txn:<id>` by `externalRefFor` below. */
  givebutterTxnId: string;
  /** UTC midnight of the day the registration was taken. Dates come from
   *  Givebutter's transaction list; the class had no timestamp finer than the
   *  day, and inventing one would be inventing precision. */
  registeredAt: number;
  status: RegistrationStatus;
  refundReason?: string;
}

/** UTC midnight for a `YYYY-MM-DD` day — no local-timezone drift, which on a
 *  date-only source is the difference between Jan 26 and Jan 25. */
function utcDay(iso: string): number {
  return Date.parse(`${iso}T00:00:00.000Z`);
}

export function externalRefFor(givebutterTxnId: string): string {
  return `gb:txn:${givebutterTxnId}`;
}

/**
 * The six. Names and dates are as they appear on the Givebutter campaign; the
 * three refunds were all scholarships, which is why the org kept exactly half.
 */
export const WBTW_REGISTRATIONS: RegistrationFixtureRow[] = [
  {
    name: "Jasmine Diaz",
    givebutterTxnId: "4284185383",
    registeredAt: utcDay("2026-01-29"),
    status: "paid",
  },
  {
    name: "Julia Kudlick",
    givebutterTxnId: "3267180644",
    registeredAt: utcDay("2026-01-26"),
    status: "paid",
  },
  {
    name: "Dominique Hyppolite",
    givebutterTxnId: "6680142853",
    registeredAt: utcDay("2026-01-26"),
    status: "paid",
  },
  {
    name: "Trinitee Alston",
    givebutterTxnId: "8784708028",
    registeredAt: utcDay("2026-01-29"),
    status: "refunded",
    refundReason: "scholarship",
  },
  {
    name: "Jocelyn Naranjo",
    givebutterTxnId: "4030672614",
    registeredAt: utcDay("2026-01-26"),
    status: "refunded",
    refundReason: "scholarship",
  },
  {
    name: "Esosa Asemota",
    givebutterTxnId: "7372397745",
    registeredAt: utcDay("2026-01-26"),
    status: "refunded",
    refundReason: "scholarship",
  },
];

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
   * Givebutter transaction id → the registrant's email, SUPPLIED BY THE
   * OPERATOR at run time (`emails` on the mutation).
   *
   * Not hard-coded in the fixture below because the table this backfill was
   * specified from carried names, dates, amounts and transaction ids — no
   * addresses. Two of the six (Dominique Hyppolite and Esosa Asemota) are known
   * to be on the roster already, but "known to be on the roster" is a NAME
   * match, and matching a payment to a person by name is the one thing this
   * backfill must not do. So the emails come from whoever runs it, keyed on the
   * transaction id (two people can share a name; they cannot share a txn id),
   * and a run with none supplied links nobody and says so.
   */
  emailByTxnId: ReadonlyMap<string, string>;
}

export interface PlannedRegistration {
  name: string;
  externalRef: string;
  amountCents: number;
  status: RegistrationStatus;
  refundReason?: string;
  registeredAt: number;
  refundedAt?: number;
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
  /** Emails the operator supplied that match nobody on the roster. NOT a
   *  problem — a registrant who isn't a person yet is the normal case, and the
   *  row stands on its own — but worth saying out loud so a typo'd address
   *  doesn't silently look like "not on the roster". */
  emailsWithNoPerson: string[];
  /**
   * Anything that didn't match. NON-EMPTY MEANS NOTHING IS WRITTEN — the
   * house rule from `reverseBadSettlement.ts`: a backfill that half-applies
   * against a deployment it doesn't recognise is worse than one that stops.
   */
  problems: string[];
}

/**
 * Decide what the backfill would do. Pure: no ctx, no writes, no clock.
 *
 * `refundedAt` is deliberately absent on the refunded rows. Givebutter's export
 * gave the refund a status but not a date, and a `refundedAt` copied from
 * `registeredAt` would be a fabricated fact on a money row — the field is
 * optional precisely so it can be honestly missing.
 */
export function planRegistrationBackfill(world: BackfillWorld): BackfillPlan {
  const problems: string[] = [];
  const empty: BackfillPlan = {
    inserts: [],
    alreadyPresent: [],
    paidCents: 0,
    grossCents: 0,
    linkedPeople: 0,
    emailsWithNoPerson: [],
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
  if (problems.length > 0) return empty;

  const inserts: PlannedRegistration[] = [];
  const alreadyPresent: string[] = [];
  let paidCents = 0;
  let grossCents = 0;
  let linkedPeople = 0;
  const emailsWithNoPerson: string[] = [];

  for (const row of WBTW_REGISTRATIONS) {
    const externalRef = externalRefFor(row.givebutterTxnId);
    grossCents += REGISTRATION_CENTS;
    if (row.status === "paid") paidCents += REGISTRATION_CENTS;
    if (world.existingExternalRefs.has(externalRef)) {
      alreadyPresent.push(externalRef);
      continue;
    }
    const email = world.emailByTxnId.get(row.givebutterTxnId)?.trim().toLowerCase();
    const personId = email ? world.personIdByEmail.get(email) : undefined;
    if (personId) linkedPeople += 1;
    else if (email) emailsWithNoPerson.push(email);
    inserts.push({
      name: row.name,
      externalRef,
      amountCents: REGISTRATION_CENTS,
      status: row.status,
      ...(row.refundReason ? { refundReason: row.refundReason } : {}),
      registeredAt: row.registeredAt,
      ...(personId ? { personId } : {}),
      ...(email ? { email } : {}),
    });
  }

  return {
    inserts,
    alreadyPresent,
    paidCents,
    grossCents,
    linkedPeople,
    emailsWithNoPerson,
    problems,
  };
}
