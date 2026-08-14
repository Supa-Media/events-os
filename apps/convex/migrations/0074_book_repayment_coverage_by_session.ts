import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";
import { postRepaymentFeeCoverage } from "../cards";

/**
 * Book the fee coverage on the two repayment checkouts that settled before
 * there was a row to put it in — PINNED TO THE SESSION, which is what 0073
 * should have pinned to.
 *
 * ── WHY 0073 REFUSED ────────────────────────────────────────────────────────
 * It looked for one settled repayment of $6.00 and found none, so it refused
 * the entry and booked nothing. The guard was right; the pin was wrong, and
 * wrong in a way worth writing down: THE $6.00 WAS NEVER A ROW. It was two
 * $3.00 personal charges bundled into ONE checkout — `prepareRepaymentCheckout`
 * settles any number of debts through a single session, and the fee is quoted
 * once, on their total. Searching by a debt amount cannot find a payment whose
 * amount only exists as a sum.
 *
 * A session id can. It is also a far better pin on its own terms: an amount is
 * a coincidence waiting to happen (two $3.00 charges are not rare), while
 * `cs_live_…` names the exact payment and nothing else. The evidence came from
 * `cards.repaymentFeeCoverageAudit`, run against production through
 * `run-convex-function.yml`, because this data is not readable from a laptop.
 *
 * ── THE ARITHMETIC IS CHECKED, NOT ASSUMED ──────────────────────────────────
 * Each entry states the debts its session settled AND the coverage charged on
 * top. The first is verifiable here — the session's repayments must sum to
 * `debtTotalCents` or the entry is refused — and it is what makes the second
 * trustworthy: `grossUpCents(600, card) - 600` is 49¢, exactly the figure the
 * founder read off the payment ("the payback on the charge was $6.49"). The
 * same arithmetic over the second session's $101.74 gives $3.35. One checked
 * against a human's reading, the other against the identical rule.
 *
 * Refuses per entry, never partially: a session whose repayments do not sum to
 * what was recorded here is a session this migration no longer understands, and
 * booking a coverage figure onto it would be a guess about money.
 *
 * Idempotent twice over — the ledger, and `postRepaymentFeeCoverage`'s own
 * `externalId` dedup, which is the same guard the live webhook leans on.
 */

const KNOWN_SESSIONS: ReadonlyArray<{
  sessionId: string;
  debtTotalCents: number;
  coverageCents: number;
  why: string;
}> = [
  {
    sessionId: "cs_live_b1JlvVjpDnyYdLL9xqtuysYde4EahPkfGYIqS4WNc2YQW12DttT8aJWDOR",
    debtTotalCents: 600,
    coverageCents: 49,
    why:
      "Two $3.00 accidental personal charges repaid together on 2026-08-14. " +
      "Founder: 'the charge was $6… the payback on the charge was $6.49' — the " +
      "49¢ is the fee the payer covered, and with no row for it the fee sweep's " +
      "expense went unfunded and the 49¢ read as unaccounted-for cash.",
  },
  {
    sessionId: "cs_live_b1EHWxArP1h7X4YOG45IRX4ZCAPDKw6oEd5ooioaPpGBDyDkKOhfCMO0Jp",
    debtTotalCents: 10_174,
    coverageCents: 335,
    why:
      "Five personal charges ($19.08 ×3, $18.00, $26.50) repaid together on " +
      "2026-08-14, hours before the fix shipped — the same bug, found by the " +
      "audit rather than by anyone noticing $3.35.",
  },
];

export async function runBookRepaymentCoverageBySession(
  ctx: MutationCtx,
): Promise<{ booked: number; centsBooked: number; refused: number }> {
  let booked = 0;
  let centsBooked = 0;
  let refused = 0;

  for (const entry of KNOWN_SESSIONS) {
    const repayments = (await ctx.db.query("personalRepayments").collect()).filter(
      (r) =>
        r.stripeCheckoutSessionId === entry.sessionId &&
        r.status === "paid" &&
        r.creditTransactionId != null,
    );

    if (repayments.length === 0) {
      console.error(
        `[0074] no settled repayments found for session ${entry.sessionId} — ` +
          `REFUSING. ${entry.why}`,
      );
      refused += 1;
      continue;
    }

    // The check that makes the stated coverage trustworthy: this migration
    // knows what the payer owed, so if the rows no longer add up to it, it is
    // looking at a different payment than the one it was told about.
    const debtCents = repayments.reduce((sum, r) => sum + r.amountCents, 0);
    if (debtCents !== entry.debtTotalCents) {
      console.error(
        `[0074] session ${entry.sessionId} settles ${debtCents}c of debt, ` +
          `expected ${entry.debtTotalCents}c — REFUSING rather than booking ` +
          `${entry.coverageCents}c onto a payment this no longer describes. ${entry.why}`,
      );
      refused += 1;
      continue;
    }

    await postRepaymentFeeCoverage(ctx, {
      sessionId: entry.sessionId,
      coverageCents: entry.coverageCents,
      repayments,
    });
    console.log(
      `[0074] booked ${entry.coverageCents}c of fee coverage on session ` +
        `${entry.sessionId} (${repayments.length} debts, ${debtCents}c total).`,
    );
    booked += 1;
    centsBooked += entry.coverageCents;
  }

  console.log(
    `[0074] booked ${booked} coverage row(s) totalling ${centsBooked}c; ` +
      `${refused} refused.`,
  );
  return { booked, centsBooked, refused };
}

export const bookRepaymentCoverageBySession: Migration = {
  name: "0074_book_repayment_coverage_by_session",
  run: runBookRepaymentCoverageBySession,
};
