/**
 * Registration arithmetic — pure, so the server's revenue sum and the project
 * page's "$150.00 collected · 3 paid, 3 scholarship" line can never disagree
 * about what "collected" means.
 *
 * ONE RULE, said once: `status: "paid"` is money the org kept and is revenue;
 * `refunded` and `comped` are not. A refunded registration gave the money back
 * and a comped one never took any, but BOTH stay on the project — a scholarship
 * is a decision worth seeing, and a table that only remembers the money erases
 * the org's own generosity from its record.
 *
 * Lives in `packages/shared` rather than either app because both sides need it:
 * `apps/convex/registrations.ts` sums it for the API, and the mobile section
 * renders the caption from it. It is also the only piece of this feature that
 * `apps/mobile` can unit-test at all — `jest.config.js` is
 * `testEnvironment: "node"`, so there are no rendered-component tests in that
 * app and display logic has to be pure to be covered.
 */

export type RegistrationStatus = "paid" | "refunded" | "comped";

/** The minimum a row needs for the arithmetic — deliberately narrower than
 *  `Doc<"registrations">` so this file has no Convex dependency. */
export interface RegistrationLike {
  amountCents: number;
  status: RegistrationStatus;
}

export interface RegistrationSummary {
  /** Σ `amountCents` over the `paid` rows. THE revenue figure — the same number
   *  `reconciliation.ts#computeBookBalances` adds to the chapter's book. */
  collectedCents: number;
  paidCount: number;
  refundedCount: number;
  compedCount: number;
}

export function summarizeRegistrations(
  rows: readonly RegistrationLike[],
): RegistrationSummary {
  let collectedCents = 0;
  let paidCount = 0;
  let refundedCount = 0;
  let compedCount = 0;
  for (const r of rows) {
    if (r.status === "paid") {
      collectedCents += r.amountCents;
      paidCount += 1;
    } else if (r.status === "refunded") {
      refundedCount += 1;
    } else {
      compedCount += 1;
    }
  }
  return { collectedCents, paidCount, refundedCount, compedCount };
}

/**
 * The count line under the collected total: "3 paid, 3 scholarship".
 *
 * "scholarship" rather than "refunded" for the refunded rows because that is
 * what the org actually did — the owner's own framing was "this person paid for
 * it but it was refunded through a scholarship". Says "refunded" only when a
 * row's reason is something else, so a genuine cancellation is never dressed up
 * as generosity. Returns "" for an empty cohort; the caller renders nothing.
 */
export function registrationCountLine(
  summary: RegistrationSummary,
  /** True when EVERY refunded row was refunded as a scholarship. */
  refundsAreScholarships: boolean,
): string {
  const parts: string[] = [];
  if (summary.paidCount > 0) parts.push(`${summary.paidCount} paid`);
  if (summary.refundedCount > 0) {
    parts.push(
      `${summary.refundedCount} ${refundsAreScholarships ? "scholarship" : "refunded"}`,
    );
  }
  if (summary.compedCount > 0) parts.push(`${summary.compedCount} comped`);
  return parts.join(", ");
}

/**
 * NET COST — what this project actually cost the org once the money it took in
 * is set against the money it spent.
 *
 * A SECOND AXIS, NOT A BIGGER BUDGET. This deliberately does NOT feed the
 * budget bar. A budget is a SPEND AUTHORISATION — approvals hang off it
 * (`budgets.approvalStatus`, the two-party path, `effectiveCapCents`), and
 * "$671.72 spent of $1,300.00" is a statement about how much of that
 * authorisation is used up. Netting income into it would quietly raise the
 * ceiling: collect $150 and you may now spend $1,450 without anyone approving
 * $150 more. It would also make one bar mean two things — how much is left to
 * spend, and how much the thing cost — which are different questions with
 * different answers. So the bar stays spend-vs-cap, and net cost is stated
 * underneath as its own number.
 */
export function netCostCents(spentCents: number, collectedCents: number): number {
  return spentCents - collectedCents;
}
