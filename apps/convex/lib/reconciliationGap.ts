/**
 * DOES IT ADD UP? — the org-wide reconciliation gap.
 *
 * The accounts page has always had every number a treasurer needs and has never
 * answered the only question they came to ask. The founder, 2026-08-08:
 *
 *   "the whole point of this section is to see whether our books match what's
 *    in the bank account. So I just want things put in a format that shows me —
 *    hey, if we take all the pending, all the stuff in payout, and all the
 *    stuff in Stripe, and all the stuff in the account, we're still missing
 *    $50. […] But right now it's just very abstract to get that information."
 *
 * This file is the arithmetic that answers it, pulled out of the query so it
 * can be unit-tested without a database and read without one either.
 *
 * ── WHY THIS IS AN ORG TOTAL AND NOT A PER-BOOK ONE ──────────────────────────
 * Per-book "book vs bank" is NOT a reconciliation and must never be presented
 * as one. Every processor payout lands in CENTRAL's account, so central
 * perpetually holds cash the chapters earned; a chapter's book legitimately
 * exceeds its bank until the morning settlement moves the difference, and
 * central's bank legitimately exceeds its book for exactly as long. Subtracting
 * those two per book produces a number that is large, always non-zero, and
 * means nothing.
 *
 * Summed across every book those two distortions cancel exactly — the dollar
 * central holds for New York is one dollar in one Increase account either way.
 * The org total is the only level at which the difference is a finding.
 *
 * ── THE TWO SIDES, AND WHY EACH TERM SITS WHERE IT DOES ──────────────────────
 *
 * BOOKS SAY  = Σ book value over every book
 *              (revenue earned − what the ledger says went out; see
 *              `lib/bookBalance.ts` for exactly what counts and what is
 *              deliberately zero).
 *
 * MONEY WE CAN POINT AT = bank available + held against pending + at Stripe
 *
 *   · BANK AVAILABLE — Increase's `available_balance` per account. This is
 *     what `increaseAccounts.balanceCents` caches.
 *
 *   · HELD AGAINST PENDING — Increase's `current_balance − available_balance`,
 *     but ONLY the part of it the ledger has not already booked. It belongs on
 *     the CASH side, added back, and getting this backwards is the single
 *     easiest way to write a wrong gap.
 *
 *     A card authorization has been deducted from `available_balance` ALREADY
 *     but has not posted, so it has not reached the reconcile ledger and book
 *     value has NOT deducted it. Comparing book value against
 *     `available_balance` alone therefore charges the org for that money twice
 *     over — once on the cash side, never on the books side — and reports a
 *     shortfall that is purely an artifact of the two figures being on
 *     different bases.
 *
 *     Adding it back puts both sides on the same basis: neither has recognized
 *     the pending item yet. (Subtracting it from BOTH sides is the same
 *     equation and gives the same difference — this way round just keeps every
 *     displayed line a real, findable pile of money.)
 *
 *     THAT REASONING DOES NOT HOLD FOR EVERY PENDING ITEM, and this line used
 *     to add back all of them. Once a reimbursement payout reaches `paid`, the
 *     ledger carries its expense (`increasePayoutMachine.ts#postReimbursementSpend`)
 *     while Increase still holds the ACH instruction in pending until it
 *     settles. For that overlap, book value has ALREADY dropped — so adding the
 *     instruction back to the cash side counts it once on each side, in
 *     opposite directions, and opens a gap the width of the transfer.
 *
 *     That is not hypothetical: on 2026-08-10 New York's $183.54 of pending was
 *     $138.55 of card authorizations and one $44.99 `ach_transfer_instruction` —
 *     Sayo Olujide's bus-ticket reimbursement, sent 2026-08-09 and booked the
 *     same day. The panel reported $44.99 of "unaccounted for" money that was
 *     nothing but this. See `addableBankPendingCents`.
 *
 *   · AT STRIPE — Stripe's `available` + `pending` balance. Revenue is counted
 *     at the gift/ticket/sale, which happens days before the payout, so money
 *     still sitting at the processor is already IN book value and is not yet in
 *     any bank account. Without this line it looks like it evaporated.
 *
 *   · AT GIVEBUTTER — the same argument as Stripe, for the second processor.
 *     Givebutter exposes NO balance endpoint (`/v1/balance`, `/v1/balances`,
 *     `/v1/wallet`, `/v1/accounts` all 404; `/v1/account` is org profile only;
 *     `/v1/funds` is empty), so the figure is DERIVED — see
 *     `givebutterSync.ts#fetchGivebutterUndepositedCents` for the derivation and
 *     the evidence it is sound.
 *
 *     It belongs on the CASH side, not as an adjustment to the books, for
 *     exactly Stripe's reason: the Givebutter sync writes each ticket and gift
 *     into `ticketOrders`/`gifts` when it happens, so the money is ALREADY in
 *     book value days before Givebutter remits it. Verified against production
 *     rather than assumed — the whole $75.00 outstanding on 2026-08-08 was three
 *     $25 tickets on the synced "Public Worship Field Day" campaign, and all
 *     three were present as `paid` `ticketOrders` rows (`gb:ticket:89134632A0027`,
 *     `gb:ticket:73325936A0026`, `gb:ticket:84796026A0025`). Book value counts
 *     paid ticket orders (`lib/bookBalance.ts`), so the revenue was counted and
 *     the cash was nowhere. Adding it to the books instead would have counted it
 *     twice; `tests/reconciliationGap.test.ts` pins the direction.
 *
 *   · AT RELAY — the org's pre-Increase bank account. Unlike every other term
 *     here this one is HAND-ENTERED, and the reason is narrower than it looks:
 *     Relay's TRANSACTIONS do sync (live, through Stripe Financial Connections,
 *     landing as `source:"stripe_fc"` rows — plus the historical `relay_csv`
 *     import for the years before that). What Relay has no API for is its
 *     BALANCE. Stripe FC hands us the feed, not the account total.
 *
 *     So the choice was to omit a real pile of money from a panel whose entire
 *     job is to locate every pile, or to silently call it zero. Both are worse
 *     than a number a named human typed on a stated date, so the figure carries
 *     `relayBalanceAsOf` and `relayBalanceSetBy` and the panel shows its age.
 *     See `reconciliation.ts#setRelayBalance`.
 *
 *     Because the feed and the balance now come from different places and go
 *     stale independently, the panel reports BOTH ages: a Relay balance typed
 *     three weeks ago is not made current by a transaction sync that ran a
 *     minute ago, and reading one as evidence for the other is the specific
 *     mistake this arrangement invites.
 *
 * ── BOTH GIVEBUTTER AND RELAY ARE BEING WOUND DOWN ───────────────────────────
 * The founder, 2026-08-08: "we plan to deprecate both givebutter and relay soon
 * but for now it still holds some of our funds." They are here because the money
 * is here, not because they are part of the target architecture. When the last
 * dollar leaves both, these two terms and their `financeSettings` fields should
 * be DELETED rather than left reading zero — a term that is permanently zero
 * teaches the reader it is safe to ignore, which is the opposite of what a
 * reconciliation panel is for. The deprecation is stated in the panel itself,
 * not only here, so the person reading the number knows it is temporary.
 *
 * ── MONEY VISIBLY ON ITS WAY IS EXPLAINED, NOT ALARMED ABOUT ─────────────────
 * An ACH gift spends 2–4 business days authorised-but-unsettled: Stripe already
 * counts it in its pending balance (so it is in MONEY WE CAN POINT AT), while
 * the books deliberately record nothing until it clears — a refused debit must
 * never need a reversal. For those days the cash side legitimately exceeds the
 * books by exactly the in-flight amount, and the org has usually already
 * emailed the donor a receipt for it.
 *
 * The owner's directive (2026-08-11, after a $309.27 in-flight ACH spent two
 * days headlined as "unaccounted for"): "an ACH transfer waiting to deliver is
 * not a cause for alarm … it should read 0 unaccounted for." So known in-flight
 * money is a TERM in the arithmetic, not a caption on the alarm: `inFlightCents`
 * is subtracted from a positive raw difference before the verdict is computed,
 * and the headline figure is the residual.
 *
 * Two safety properties, both load-bearing:
 *
 *   · IT ONLY EXPLAINS, NEVER FLIPS. The term is clamped to the positive part
 *     of the raw difference, so in-flight evidence can reduce a cash-high gap
 *     to zero but can never manufacture a `books_exceed_cash` verdict or mask
 *     one that exists. In the brief window after a debit settles (gift booked,
 *     Stripe's pending slice not yet refreshed) the raw difference has already
 *     closed, the clamp bottoms out at zero, and stale evidence explains
 *     nothing.
 *   · THE RAW ARITHMETIC STAYS VISIBLE. `rawDifferenceCents` and
 *     `inFlightExplainedCents` are both returned, so the panel can show the
 *     subtraction — located − in transit − books = residual — instead of a
 *     figure that quietly disagrees with the piles above it.
 *
 * The caller supplies the evidence; see `reconciliationSummary` for why it is
 * the LARGER of our own `pendingGifts` receipts and Stripe's `bank_account`
 * pending slice (our rows can be missing — any gift authorised before the
 * in-flight tracker shipped on 2026-08-10 never got one, and `completed`
 * events don't redeliver — while Stripe's own statement of ACH in transit
 * doesn't depend on our webhook history).
 *
 * ── WHAT IS DELIBERATELY *NOT* ADJUSTED FOR ──────────────────────────────────
 *
 * IN-KIND GIFTS. Someone buying $500 of gear for the org is $500 of revenue and
 * $500 of expense; no cash ever exists. That pair nets to zero INSIDE book
 * value already (`reconciliation.ts#computeBookBalances` phase 1 counts the
 * gift, the ledger carries the expense), so netting it out here a second time
 * would move the gap by the whole in-kind total in the wrong direction.
 *
 * It is reported alongside the gap instead, as context — because the netting
 * holds only when the offsetting expense was actually recorded. An in-kind gift
 * entered without its expense inflates book value by its full amount and lands
 * in this gap looking like missing cash. That is a REAL finding, and hiding it
 * behind an adjustment would be the one thing worse than not answering the
 * question at all.
 *
 * PROCESSOR FEES need no term here, on EITHER rail. Revenue is gross, payouts
 * are net, and the difference is booked as a real monthly expense row by
 * `processorFees.ts`, so it is already inside "what the ledger says went out".
 *
 * GIVEBUTTER'S FEES ARE BOOKED TOO, since 2026-08-10. This paragraph used to say
 * the opposite — that `processorFees.ts` covered Stripe only, that the resulting
 * unbooked Givebutter fee landed in the gap, and that this was "left visible on
 * purpose" because the fix was to book it rather than to quietly count the gross
 * here. That was the right call and the fix has now been made:
 * `processorFees.ts` sweeps Givebutter as well, reading each transaction's own
 * `amount` less its own `payout`.
 *
 * The mechanics below are UNCHANGED and still deliberate: the Givebutter term
 * counts what Givebutter will actually REMIT (its `payout` field, net of fee)
 * rather than the gross the giver paid, because the pile of money we can point
 * at is the pile they will send. What changed is the other side. On a
 * transaction whose fee the giver did NOT cover, book value holds the gross AND
 * now also holds the fee as an expense, so the two net out and the gap no longer
 * carries it.
 *
 * THE SIGN OF THAT FIX IS A TRAP WORTH NAMING. Booking an expense LOWERS book
 * value, and `differenceCents = located − books`, so booking Givebutter's fee
 * moves the headline UP by the fee. That is correct: the unbooked fee had been
 * MASKING part of the gap, making the books look closer to the cash than they
 * were. A gap that grows by exactly the fee on the day the fee is first booked
 * is the expected result, not a regression.
 *
 * Small today, on this deployment: $29.30, all of it one $1,000.00 gift remitted
 * as $970.70. Every other giver covered the fee, so `payout` equals `amount` to
 * the cent and contributes nothing — which is why this was invisible on
 * 2026-08-08, when every OUTSTANDING transaction happened to be fee-covered.
 *
 * ── THE SIGN CONVENTION ──────────────────────────────────────────────────────
 * `differenceCents = located − books`, and the SIGN is the diagnosis, so it is
 * never shown as a bare absolute value:
 *
 *   · positive → more cash exists than the books explain. Money came in that
 *     was never recorded as revenue, or an expense was recorded that never
 *     actually left. (This deployment's Givebutter deposits were the standing
 *     example, and are now the standing example of the gap DOING ITS JOB: it
 *     read $4,550.70, then $150.00 as the Cash App and Venmo work landed, and
 *     the 2026-08-10 pass named the last of it as three unrecorded student
 *     registrations. See `processorFees.ts`. Those three now have somewhere to
 *     live — `schema/registrations.ts`, the fourth revenue stream — and
 *     recording them moves this figure DOWN by $150.00, which is the direction
 *     the trap above warns about in reverse: revenue RAISES books, and books
 *     are subtracted here.)
 *   · negative → the books claim money that is nowhere. Revenue counted twice
 *     (a gift AND the bank credit that delivered it), an in-kind gift without
 *     its expense, or spend that was never actually made.
 *
 * No tolerance band. Every figure on both sides is an integer number of cents,
 * so a difference of one cent is a real difference and saying otherwise would
 * be inventing slack the data does not have. What legitimately makes the number
 * move is snapshot STALENESS, and the honest fix for that is the "as of"
 * timestamp and the refresh the page now performs — not a fudge factor.
 */

/**
 * Split one account's pending total into the part that is still ours to count
 * on the cash side and the part the books have already spent.
 *
 * ── WHY THIS IS A LOOKUP AND NOT A CALCULATION ──────────────────────────────
 * There is nothing to decide here. Both numbers are measured during one pass of
 * the snapshot (`reconciliation.ts#snapshotBalances`) and written by ONE
 * mutation, and a pass that can't measure both writes neither. They still come
 * from two separate HTTP calls, so this is not a transactional read of the bank;
 * the guarantee is narrower and sufficient — whatever a row holds came from one
 * pass, seconds apart, never a survivor of an older one. This function only has
 * to spend them safely.
 *
 * The measurement matches each pending item's `source.<category>.transfer_id`
 * against `payouts.increaseTransferId` where the payout has reached `paid`.
 * THE CATEGORY IS NOT THE ANSWER: an earlier cut of this excluded four outbound
 * categories outright, on the theory that an outbound transfer is booked when
 * it is sent. Three of the four are never booked at send time — the app has no
 * `/wire_transfers`, `/check_transfers` or `/real_time_payments_transfers` call
 * at all, so those can only come from a human in the Increase dashboard and
 * reach the ledger at SETTLEMENT. Refusing them would have opened a
 * `books_exceed_cash` gap the size of a mailed check for as long as it stayed
 * uncashed.
 *
 * ── WHY ABSENT ADDS THE WHOLE TOTAL BACK ────────────────────────────────────
 * `pendingAlreadyBookedCents` is absent when no snapshot has ever measured it,
 * or when the one that wrote this `pendingCents` could not reach
 * `/pending_transactions` (it is cleared, never left stale).
 *
 * That is not a narrow window — it is this field's entire observed history. The
 * itemisation call sent `status.in[]` instead of `status.in` from the day it
 * shipped, which Increase 400s, so every pass for months came back with no
 * split at all (see the note on the query string in `snapshotBalances`). The
 * default has to be the one that is safe to live on for months, because it
 * already has been.
 *
 * Absent means "unknown", and the two available answers are both wrong in some
 * case — so pick the one that fails safely.
 *
 * Adding it all back overstates cash by any in-flight booked transfer, which
 * shows up as `cash_exceeds_books`: an unexplained surplus that invites someone
 * to look. Subtracting an unmeasured figure would invent a number and report
 * `books_exceed_cash` — money apparently missing — on no evidence. An audit
 * panel may overstate what it can point at; it must never accuse the org of a
 * shortfall it made up. So absent adds it all back, and the drill-down says the
 * split has not been read yet rather than implying a zero.
 */
export function addableBankPendingCents(account: {
  pendingCents?: number | null;
  pendingAlreadyBookedCents?: number | null;
}): { addableCents: number; alreadyBookedCents: number } {
  // `pendingCents` is `current − available` clamped at the writer, but a legacy
  // row predating that clamp must not turn into a negative pile of cash.
  const pendingCents = Math.max(0, account.pendingCents ?? 0);
  const measured = account.pendingAlreadyBookedCents;
  if (measured == null) return { addableCents: pendingCents, alreadyBookedCents: 0 };
  // Can't be booked for more than the bank is holding, and can't be negative:
  // the displayed lines have to stay real piles of money.
  const alreadyBookedCents = Math.min(Math.max(0, measured), pendingCents);
  return { addableCents: pendingCents - alreadyBookedCents, alreadyBookedCents };
}

/** Everything the gap is computed from. All fields are integer cents. */
export type ReconciliationInput = {
  /** Σ book value across every book (central + active chapters). */
  bookValueCents: number;
  /** Σ Increase `available_balance` across the org's accounts. */
  bankAvailableCents: number;
  /** Σ (`current_balance` − `available_balance`) — see the doc above. */
  bankPendingCents: number;
  /** Stripe's `available` balance; null until the first snapshot lands. */
  stripeAvailableCents: number | null;
  /** Stripe's `pending` balance; null until the first snapshot lands. */
  stripePendingCents: number | null;
  /**
   * Givebutter's derived undeposited balance; null until the first snapshot
   * lands (or forever, on a deployment with no Givebutter).
   */
  givebutterUndepositedCents: number | null;
  /**
   * True when a Givebutter API key is configured, i.e. we EXPECT to be able to
   * read that balance and a null is a GAP IN OUR KNOWLEDGE. False means this
   * org simply doesn't use Givebutter, and a null is the correct and complete
   * answer — the distinction exists so a deployment that never touched
   * Givebutter isn't permanently told its reconciliation is incomplete.
   */
  givebutterConfigured: boolean;
  /**
   * The hand-entered Relay balance; null until someone records one. Counted
   * when present, and NEVER treated as a missing term when absent — see the
   * note on `missingTerms`.
   */
  relayBalanceCents: number | null;
  /**
   * ACH money in transit — authorised, counted in Stripe's pending balance,
   * and deliberately not yet booked. Subtracted from a POSITIVE raw difference
   * (clamped, see the module doc) so money the panel can fully explain never
   * headlines as "unaccounted for". Absent/0 = no evidence, old behavior.
   */
  inFlightCents?: number;
};

/** A machine-fetched pile whose absence means we haven't looked, not that it's
 *  empty. Named so the UI can say WHICH one it's missing. */
export type ReconciliationTerm = "stripe" | "givebutter";

export type ReconciliationVerdict =
  /** Books and cash agree to the cent. */
  | "balanced"
  /** More cash than the books explain — look for unrecorded income. */
  | "cash_exceeds_books"
  /** The books claim money that is not anywhere — look for a double count. */
  | "books_exceed_cash";

export type ReconciliationResult = {
  /** bank available + pending held + everything at Stripe. */
  locatedCents: number;
  /** `locatedCents − bookValueCents`, BEFORE the in-flight netting — the raw
   *  subtraction of the two piles, kept so the working can show its steps. */
  rawDifferenceCents: number;
  /** The slice of a positive raw difference explained by in-flight money:
   *  `min(inFlightCents, max(rawDifferenceCents, 0))`. Zero whenever the raw
   *  difference isn't positive — in-flight evidence only ever EXPLAINS a
   *  cash-high gap, it never flips or masks a verdict. */
  inFlightExplainedCents: number;
  /** `rawDifferenceCents − inFlightExplainedCents` — what is actually
   *  unaccounted for. Sign carries the diagnosis. This is the headline. */
  differenceCents: number;
  verdict: ReconciliationVerdict;
  /** Stripe's two balances added, or null when no snapshot has ever landed. */
  stripeTotalCents: number | null;
  /**
   * Every EXPECTED machine-fetched term that has never been read, so the
   * "located" side is knowably short and the gap must not be presented as a
   * finding. Named rather than counted so the panel can tell the reader which
   * vendor to go look at instead of a generic "something is missing".
   *
   * A bank balance that has never synced is NOT here — it reads as 0 and is
   * reported separately, by book name, because a missing account is a different
   * problem from a missing processor.
   *
   * NEITHER IS AN UNRECORDED RELAY BALANCE, deliberately. Relay is hand-entered,
   * so "nobody has typed a number" and "this org has no Relay money" are the
   * same state and we cannot tell them apart. Blocking the verdict on it would
   * permanently mark every deployment that never used Relay as unreconcilable;
   * silently counting zero would hide real money. The panel takes the third
   * option and NAMES the absence in its leads without touching the verdict.
   */
  missingTerms: ReconciliationTerm[];
  /** `missingTerms.length > 0` — kept as a boolean because most callers only
   *  need "can this be presented as a reconciliation at all?". */
  incomplete: boolean;
};

export function reconcileOrgMoney(
  input: ReconciliationInput,
): ReconciliationResult {
  const {
    bookValueCents,
    bankAvailableCents,
    bankPendingCents,
    stripeAvailableCents,
    stripePendingCents,
    givebutterUndepositedCents,
    givebutterConfigured,
    relayBalanceCents,
  } = input;
  // Evidence, not a balance: a negative or absent figure means "none known".
  const inFlightCents = Math.max(0, input.inFlightCents ?? 0);

  // Null means "never fetched", which is NOT the same as zero and must not be
  // silently coerced to it — a zero would quietly manufacture a gap the size of
  // whatever is actually sitting at Stripe. Treated as 0 for the arithmetic so
  // the page still shows something, and flagged `incomplete` so the copy can
  // say the total is provisional.
  const stripeTotalCents =
    stripeAvailableCents == null && stripePendingCents == null
      ? null
      : (stripeAvailableCents ?? 0) + (stripePendingCents ?? 0);

  // Same null-is-not-zero rule as Stripe, for the same reason. A null here is
  // "we never asked", and coercing it to 0 would report whatever Givebutter is
  // holding as a shortfall with the same confidence as a real one.
  const locatedCents =
    bankAvailableCents +
    bankPendingCents +
    (stripeTotalCents ?? 0) +
    (givebutterUndepositedCents ?? 0) +
    (relayBalanceCents ?? 0);
  const rawDifferenceCents = locatedCents - bookValueCents;
  // The clamp IS the safety: in-flight money may only explain a cash-high gap,
  // up to the gap itself. A books-exceed-cash difference passes through
  // untouched, and stale evidence (a debit that settled since the snapshot)
  // bottoms out at zero instead of inventing a shortfall.
  const inFlightExplainedCents = Math.min(
    inFlightCents,
    Math.max(rawDifferenceCents, 0),
  );
  const differenceCents = rawDifferenceCents - inFlightExplainedCents;

  const missingTerms: ReconciliationTerm[] = [];
  if (stripeTotalCents == null) missingTerms.push("stripe");
  // Only a CONFIGURED Givebutter can be missing. Without a key there is no
  // balance to fetch and never will be, so nothing is absent.
  if (givebutterConfigured && givebutterUndepositedCents == null) {
    missingTerms.push("givebutter");
  }

  return {
    locatedCents,
    rawDifferenceCents,
    inFlightExplainedCents,
    differenceCents,
    verdict:
      differenceCents === 0
        ? "balanced"
        : differenceCents > 0
          ? "cash_exceeds_books"
          : "books_exceed_cash",
    stripeTotalCents,
    missingTerms,
    incomplete: missingTerms.length > 0,
  };
}
