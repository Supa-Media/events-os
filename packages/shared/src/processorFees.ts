/**
 * THE fee schedule — what each payment rail costs, in one place.
 *
 * Before this, a rate was whatever the file needed at the time: the Cash App
 * formula (2.6% + $0.15) was reverse-engineered from two payment-detail
 * screenshots during the 2026-08 reconciliation and lived in a historical seed
 * module, and Stripe's card rate was written down nowhere at all — every
 * mention of "2.9% + 30¢" in the repo was prose in a comment. A rate nobody can
 * look up is a rate that gets retyped wrong.
 *
 * Three things consume this and they must agree, or the org quotes one number
 * and charges another:
 *   1. the gross-up when a donor opts to cover fees,
 *   2. the ACH recommendation on the giving page ("this would cost $5, not $145"),
 *   3. the blended effective-rate monitor on the finance dashboard.
 *
 * ── PREDICTION ONLY. THE ACTUAL ALWAYS WINS ─────────────────────────────────
 * This schedule says what a payment SHOULD cost. It never re-derives what one
 * DID cost. `sales.feeCents` and `processorFeeEntries` are read from the
 * processor's own ledger and documented as never-derived — that rule exists
 * because an earlier attempt inferred fees by subtracting recorded revenue from
 * banked deposits, which measures "fees minus unrecorded sales" rather than
 * fees. Nothing here may be used to write a fee figure into the books.
 *
 * ── DELIBERATELY NOT BUILT ──────────────────────────────────────────────────
 * No effective-dating, no per-chapter overrides, no version history. One org,
 * one set of merchant agreements, and a rate change is a rare event a treasurer
 * makes once. The stored rows (`processorFeeSchedule`) exist so a rate change
 * doesn't need a deploy; the typed defaults below stay the source of shape and
 * of sanity, so a stored row can never introduce a rail that has no code behind
 * it or a percentage above 100%.
 *
 * ── GIVEBUTTER IS ABSENT ON PURPOSE ─────────────────────────────────────────
 * Givebutter is being retired, and its fee was never modelled as a RATE here:
 * `givebutterSync.ts` reads an explicit `subtype:"fee"` line off each
 * transaction, i.e. an actual, and its fees are deducted before the payout
 * lands so the org never books them. There is no rate to promote to a schedule,
 * and inventing one for a rail nobody will take new money through would be a
 * number with no source.
 */

/** A rail we can quote a price for. */
export const FEE_PROCESSORS = ["stripe", "cash_app"] as const;
export type FeeProcessor = (typeof FEE_PROCESSORS)[number];

/**
 * How the money arrives. `wallet` is a stored-balance rail (Cash App), which
 * prices like a card but is neither a card nor a bank debit.
 */
export const FEE_METHODS = ["card", "ach_debit", "wallet"] as const;
export type FeeMethod = (typeof FEE_METHODS)[number];

export const FEE_METHOD_LABELS: Record<FeeMethod, string> = {
  card: "Card",
  ach_debit: "Bank transfer (ACH)",
  wallet: "Wallet balance",
};

export const FEE_PROCESSOR_LABELS: Record<FeeProcessor, string> = {
  stripe: "Stripe",
  cash_app: "Cash App",
};

/**
 * What one payment costs on a rail.
 *
 * `capCents` is FIRST-CLASS, not a special case. Stripe's ACH debit is 0.8%
 * capped at $5.00, which means above $625 the fee stops growing at all — the
 * single most consequential fact about the rail, and the one a "percent + fixed"
 * shape would have silently dropped. Every function in this file that touches a
 * rate handles the cap explicitly; see `grossUpCents` for why the algebra
 * changes shape inside the capped region.
 */
export type FeeRate = {
  /** Basis points of the gross. 290 = 2.90%. */
  percentBps: number;
  /** Flat per-payment cents, charged on top of the percentage. */
  fixedCents: number;
  /** The most this rail can charge on one payment. Absent = uncapped. */
  capCents?: number;
};

export type FeeRail = FeeRate & {
  processor: FeeProcessor;
  method: FeeMethod;
};

/**
 * The rails, at their published rates (2026-08).
 *
 * These are the DEFAULTS. A stored `processorFeeSchedule` row for the same
 * processor+method wins at runtime; a rail with no stored row uses what is here.
 * A rail that is not in this list does not exist — a stored row for one is
 * ignored, so a typo in the database cannot conjure a rail.
 */
export const DEFAULT_FEE_SCHEDULE: readonly FeeRail[] = [
  // Stripe standard US card pricing.
  { processor: "stripe", method: "card", percentBps: 290, fixedCents: 30 },
  // Stripe ACH direct debit. The cap is the whole reason ACH is worth offering:
  // a $5,000 gift costs $5.00 here and $145.30 on the card line above.
  { processor: "stripe", method: "ach_debit", percentBps: 80, fixedCents: 0, capCents: 500 },
  // Cash App for Business. Confirmed off the owner's own payment-detail screens
  // ($50.00 → $1.45, $100.00 → $2.75) and it reproduces all three 2026
  // withdrawals to the cent — as close to reading it as a rail with no API
  // allows. The 2026-08 Cash App backfill (a one-off since removed) read the
  // rate from here rather than keeping its own copy.
  { processor: "cash_app", method: "wallet", percentBps: 260, fixedCents: 15 },
] as const;

/** Stable key for a rail, for maps and stored rows. */
export function feeRailKey(processor: FeeProcessor, method: FeeMethod): string {
  return `${processor}:${method}`;
}

/** The published rate for a rail, or `null` if this codebase has no such rail. */
export function defaultFeeRate(
  processor: FeeProcessor,
  method: FeeMethod,
): FeeRate | null {
  const rail = DEFAULT_FEE_SCHEDULE.find(
    (r) => r.processor === processor && r.method === method,
  );
  if (!rail) return null;
  const { percentBps, fixedCents, capCents } = rail;
  return capCents == null
    ? { percentBps, fixedCents }
    : { percentBps, fixedCents, capCents };
}

/**
 * Is this a rate a treasurer could plausibly have meant?
 *
 * The stored table is editable without a deploy, which is the point — but it
 * also means a fat finger becomes the price the giving page quotes. These
 * bounds reject the shapes that are certainly wrong (a negative fee, a
 * percentage over 100%, a cap of zero) rather than trying to guess a plausible
 * range; 100% is not a real rate but it IS an arithmetic boundary — above it
 * `grossUpCents` has no solution at all.
 */
export function feeRateProblems(rate: FeeRate): string[] {
  const problems: string[] = [];
  if (!Number.isInteger(rate.percentBps) || rate.percentBps < 0) {
    problems.push("percentBps must be a whole number of basis points, 0 or more");
  } else if (rate.percentBps >= 10_000) {
    problems.push("percentBps must be under 10000 (100%) — at or above it a gross-up has no answer");
  }
  if (!Number.isInteger(rate.fixedCents) || rate.fixedCents < 0) {
    problems.push("fixedCents must be a whole number of cents, 0 or more");
  }
  if (rate.capCents != null && (!Number.isInteger(rate.capCents) || rate.capCents <= 0)) {
    problems.push("capCents, when set, must be a whole number of cents above 0");
  }
  return problems;
}

/**
 * What the rail takes out of a payment of `grossCents`.
 *
 * The percentage is computed as `gross * bps / 10000` with the multiply FIRST,
 * so it stays integer arithmetic and cannot drift the way `gross * 0.026` can.
 * Rounded per payment, because that is how a processor charges: 40 separate $20
 * tickets are rounded 40 times, not once on $800.
 */
export function feeOnCents(grossCents: number, rate: FeeRate): number {
  if (grossCents <= 0) return 0;
  const raw = Math.round((grossCents * rate.percentBps) / 10_000) + rate.fixedCents;
  return rate.capCents != null ? Math.min(raw, rate.capCents) : raw;
}

/** What lands in the bank from a payment of `grossCents`. */
export function netOfFeeCents(grossCents: number, rate: FeeRate): number {
  return grossCents - feeOnCents(grossCents, rate);
}

/**
 * Solve for the charge that NETS `intendedCents` — the "cover the fees" math.
 *
 * THE OBVIOUS ANSWER IS WRONG, and it is wrong in the org's favour-losing
 * direction, so it is worth spelling out. Adding the fee on the intended amount
 * (`intended + intended*p + f`) undercharges, because the rail then charges its
 * percentage on the LARGER number too. For $100 on Stripe card that is $103.20
 * charged, $103.20 - $3.29 = $99.91 netted — nine cents short of the whole point
 * of the feature, on every single gift.
 *
 * Solve instead for the gross `G` where `G - fee(G) = intended`:
 *
 *     G - (G × p + f) = intended
 *     G × (1 - p)     = intended + f
 *     G               = (intended + f) / (1 - p)
 *
 * so $100 intended on 2.9% + 30¢ is (10000 + 30) / (1 - 0.029) = 10329.55… →
 * **$103.30**, netting exactly $100.00.
 *
 * ── INSIDE THE CAP THE ALGEBRA CHANGES SHAPE ────────────────────────────────
 * Once the cap binds, the fee is a CONSTANT, so the percentage term drops out
 * of the equation entirely and the answer is simply `intended + cap`. Running
 * the formula above anyway would overcharge — for $621 on ACH it returns
 * $626.01 where $626.00 nets the same $621.00. That is a cent, but it is a cent
 * the donor did not agree to and it recurs on every gift over $625. So the cap
 * is checked FIRST and the closed form is only reached when the cap is not
 * binding.
 *
 * ── THE LOOPS ARE THE INVARIANT, NOT THE ALGORITHM ──────────────────────────
 * The closed form lands on the right cent essentially always; the two loops
 * afterwards exist so that "the net is never less than intended, and never more
 * than one rounding step over" is enforced by construction rather than argued
 * from the algebra. `net` is non-decreasing in `gross`, so the trim loop finds
 * the SMALLEST gross that still clears `intended` — the donor is never charged a
 * cent more than covering the fee requires. Each loop runs zero or one times in
 * practice; they are cheap and they mean a future rate shape cannot silently
 * produce a wrong charge.
 */
export function grossUpCents(intendedCents: number, rate: FeeRate): number {
  if (intendedCents <= 0) return 0;

  let gross: number;
  const cappedGuess = rate.capCents != null ? intendedCents + rate.capCents : null;
  if (
    cappedGuess != null &&
    // Would the rail actually hit its cap at that charge? If yes the fee is
    // fixed at the cap and `intended + cap` is exactly right.
    Math.round((cappedGuess * rate.percentBps) / 10_000) + rate.fixedCents >= rate.capCents!
  ) {
    gross = cappedGuess;
  } else {
    // (intended + fixed) / (1 - bps/10000), kept in integers and rounded UP so
    // the net can only ever land on or above the intended amount.
    gross = Math.ceil(
      ((intendedCents + rate.fixedCents) * 10_000) / (10_000 - rate.percentBps),
    );
  }

  while (netOfFeeCents(gross, rate) < intendedCents) gross += 1;
  while (gross > 1 && netOfFeeCents(gross - 1, rate) >= intendedCents) gross -= 1;
  return gross;
}

/**
 * What covering the fees ADDS to the charge — the number the donor is agreeing
 * to. Always `grossUpCents(intended) - intended`, never computed separately,
 * so the two figures on the page cannot disagree.
 */
export function feeCoverageCents(intendedCents: number, rate: FeeRate): number {
  return grossUpCents(intendedCents, rate) - intendedCents;
}

/**
 * `2.9% + $0.30`, `0.8% capped at $5.00` — the rate as a person reads it.
 * Used in the giving page's plain-language explanation and in the fee-schedule
 * admin, so both describe the rail the same way.
 */
export function describeFeeRate(rate: FeeRate): string {
  const pct = `${(rate.percentBps / 100).toFixed(rate.percentBps % 100 === 0 ? 0 : 1)}%`;
  const parts = [pct];
  if (rate.fixedCents > 0) parts.push(`$${(rate.fixedCents / 100).toFixed(2)}`);
  const base = parts.join(" + ");
  return rate.capCents != null
    ? `${base}, capped at $${(rate.capCents / 100).toFixed(2)}`
    : base;
}

/**
 * The blended effective rate, in basis points — fees over what was processed.
 *
 * THE ACTIONABLE SIGNAL ON FEES IS A RATE, NOT A TOTAL. A fee total only ever
 * grows with revenue, so "fees are up 40%" describes a good month as readily as
 * a problem, and reacting to it is how a fee budget ends up capping a record
 * fundraising quarter. A blended rate moving from 2.7% to 3.4% has a CAUSE
 * somebody can act on: volume routed onto an expensive rail, a plan tier that
 * stopped making sense, wire fees an ACH would have avoided.
 *
 * Returns `null` for a period that processed nothing — a rate on zero volume is
 * not zero, it is undefined, and charting it as 0% draws a cliff that never
 * happened.
 */
export function effectiveRateBps(feeCents: number, grossCents: number): number | null {
  if (grossCents <= 0) return null;
  return Math.round((feeCents / grossCents) * 10_000);
}

/**
 * Above this, offer ACH on the giving page.
 *
 * ── THIS IS NOT A BREAK-EVEN. DO NOT "FIX" IT INTO ONE ──────────────────────
 * ACH is cheaper than card at EVERY amount — 0.8% beats 2.9% + 30¢ from one
 * cent upward, and past $625 the cap makes it not close. There is no crossover
 * to compute and a future reader who derives one will get a number that is
 * simply wrong.
 *
 * The threshold is a FRICTION judgement. Paying by bank means authorising a
 * bank account and waiting ~4 business days for the money to settle, so it is
 * not worth interrupting somebody's $25 gift to explain — the interruption
 * costs more in abandoned gifts than the 60¢ it saves. At $500 the saving is
 * ~$10.30 and the ask is proportionate. That is the entire basis for the
 * number, and it is a product judgement the owner can move at will.
 */
export const ACH_NUDGE_THRESHOLD_CENTS = 50_000;

/** What card would cost vs ACH on this amount — the nudge's whole argument. */
export function achSavingCents(
  grossCents: number,
  cardRate: FeeRate,
  achRate: FeeRate,
): number {
  return feeOnCents(grossCents, cardRate) - feeOnCents(grossCents, achRate);
}
