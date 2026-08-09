/**
 * One Field Day payment that was two things (2026-08-08).
 *
 * At Field Day someone bought a $30 PW Tee and also wanted to give $20. The
 * merch table runs on a third-party Tap-to-Pay app (`com.pocketvendor.payment`)
 * that sends Stripe a single amount and has no idea what a donation is, so there
 * was nowhere for the second half to go. The owner, in his own words:
 *
 *     "The $50 was someone wanting to buy a shirt but also give a donation,
 *      I had no way to really do that so I just typed in 50"
 *
 * It came in as one $50 card-present charge and the sales sync booked it the
 * only way it could: $50 of merch revenue, `itemSource: "unresolved"`. The org's
 * total was right the whole time — which is exactly why this would never have
 * surfaced on its own. What was wrong is which stream it sat in, and who got
 * credit: $20 that was GIVEN never reached the giving ledger, and the woman who
 * gave it never had it added to her record.
 *
 * ── WHAT THE EVIDENCE ACTUALLY SUPPORTS ─────────────────────────────────────
 * The $30/$20 split is not a decomposition of $50 against a price list — there
 * is no Field Day catalogue in `lib/salesCatalog.ts`, and $50 against the tee
 * price alone decomposes no way at all. It rests on two independent things:
 *
 *  1. The owner's account of the transaction, above: a shirt plus a donation.
 *  2. Stripe's own record of the FOUR OTHER charges from that same day, which
 *     since #574 read as `stripe_line_items` — each $30.00, each naming the real
 *     Stripe Price object for one PW Tee. So the $30 half is corroborated by the
 *     price Stripe itself charged four other people for the same product hours
 *     either side of this tap, not by anyone's memory of what a tee costs. The
 *     $20 is then forced: $50 − $30.
 *
 * That is why the sale half is asserted as a real item (`1 × PW Tee`) rather
 * than left `unresolved`. Where the catalogue module declines to pick between
 * several exact readings, here there is one reading and two sources agreeing on
 * it.
 *
 * ── THE DONOR ALREADY EXISTS, AND HER NAME HAS A THIRD PART ─────────────────
 * The owner named the giver as "Jordanella Maluka". The donor record in
 * production reads `Jordanella Maluka Chagiye` — $150.00 lifetime across 2
 * gifts, on the New York book. `matchOrCreateDonor` dedups by lowercased email,
 * then exact phone, then EXACT trimmed name, so passing the two-part name would
 * miss the third part, fall through to create, and leave one person holding two
 * donor records with her giving history cut between them. So the match is made
 * on her EMAIL, which is the primary dedup key and hits regardless of spelling,
 * and the runner additionally re-verifies the row it lands on before writing —
 * see `EXPECTED_DONOR_*`. Merging two donors afterwards is a manual, lossy job;
 * not splitting her in the first place is the whole point of this paragraph.
 *
 * ── THE FEE IS NOT DIVIDED ──────────────────────────────────────────────────
 * $2.00 of fee attaches to the $50 payment, and there is one of it. It stays
 * whole on the sale row. Stripe stated that number for the charge and never
 * stated a per-half breakdown, so any division would be invented; `gifts` has no
 * fee field to receive the other piece; and it changes no total either way,
 * because `processorFees.ts` books fees as their own monthly expense swept from
 * Stripe's balance-transaction ledger and book value never nets fees out of
 * revenue. See `salesDonations.ts`'s header.
 *
 * ── BOOK VALUE MUST NOT MOVE ────────────────────────────────────────────────
 * `reconciliation.ts#computeBookBalances` counts `sales.grossCents` and
 * `gifts.amountCents` at face value, once each. $20 off one and $20 onto the
 * other is worth exactly $0, and that is the test of whether this is a
 * correction or a mistake. `tests/fieldDayBundledSplit.test.ts` reads book value
 * out of the real `accountBalances` query before and after and requires
 * equality.
 *
 * Contains contact PII — private repo. Delete this module and its runner once
 * the correction has been run in production.
 */

/** The payment. The idempotency key for everything below: the runner finds the
 *  sale by this and by nothing else — never by amount and date, which is how a
 *  real $500 bank deposit got deleted earlier in this reconciliation for
 *  matching a duplicate's amount and date. */
export const STRIPE_CHARGE_ID = "ch_3U2EgzQv9S5xW6eK00dIIcJ9";

/** What the card was charged. `grossCents + donationCents` must equal this
 *  afterwards — the invariant the whole correction turns on. */
export const CHARGE_CENTS = 5_000;

/** Stripe's fee on the payment, as production holds it. Re-verified and then
 *  LEFT ALONE — it is here so a run can prove the row is the one this module was
 *  written against, not so it can be edited. */
export const CHARGE_FEE_CENTS = 200;

/** 2026-08-08 18:10:06 UTC — when the card was tapped. The gift is dated to this
 *  instant, not to the day someone got round to splitting it: the money was
 *  given at the merch table, and dating it later would move it into the wrong
 *  month for every giving report and make her `lastGiftAt` wrong. */
export const SOLD_AT_MS = 1_786_212_606_000;

/** The merch half: one PW Tee at the price Stripe charged four other people for
 *  the same product that same day. */
export const TEE_LABEL = "PW Tee";
export const TEE_UNIT_CENTS = 3_000;
export const TEE_QUANTITY = 1;

/** The merch half and the gift half. Both derived here from the two constants
 *  above rather than typed twice, so they cannot drift apart from each other or
 *  from `CHARGE_CENTS`. */
export const SALE_CENTS = TEE_UNIT_CENTS * TEE_QUANTITY;
export const DONATION_CENTS = CHARGE_CENTS - SALE_CENTS;

/** The item line written onto the sale, in the schema's own shape. One
 *  candidate, because Stripe named the product outright on that day's other
 *  charges — this is not a price point that several products share. */
export const TEE_ITEM = {
  label: TEE_LABEL,
  quantity: TEE_QUANTITY,
  unitPriceCents: TEE_UNIT_CENTS,
  candidates: [TEE_LABEL],
} as const;

/**
 * The donor as production holds her, TODAY. Every one of these is re-checked
 * against the live row before anything is written — not to find her (that is
 * done by email) but to prove the row found is the row this module was written
 * against. A lifetime or gift count that has moved is not a reason to stop; a
 * NAME or EMAIL that has moved is, because it means the identity underneath has
 * changed and the owner's "the donation is from Jordanella Maluka" no longer
 * demonstrably points here.
 */
export const EXPECTED_DONOR_NAME = "Jordanella Maluka Chagiye";
export const EXPECTED_DONOR_EMAIL = "jordanellamaluka@hotmail.com";
/** $150.00 across 2 gifts as of 2026-08-09 — reported before/after so the one
 *  number worth eyeballing before `execute: true` is the one that says her
 *  history grew by exactly one $20 gift and not by a whole second record. */
export const EXPECTED_DONOR_LIFETIME_CENTS = 15_000;
export const EXPECTED_DONOR_GIFT_COUNT = 2;

/** The name the owner used. Kept only to document the gap this module exists to
 *  navigate — it is NEVER passed to `matchOrCreateDonor`, because the exact-name
 *  fallback would miss `Chagiye` and mint a second donor. */
export const OWNER_SUPPLIED_NAME = "Jordanella Maluka";

/** What the gift's note will say. The runner and the module both get deleted;
 *  this sentence is the only place the reasoning survives on the row itself. */
export const GIFT_NOTE =
  "Given at the Field Day merch table on 2026-08-08, alongside a $30.00 PW Tee, " +
  "on one $50.00 card payment the tap-to-pay app could not split. Recorded " +
  "2026-08-09: $30.00 stays as merch revenue, this $20.00 becomes giving. The " +
  "payment total is unchanged.";

/** The whole point: 0. A non-zero value means this is not a reclassification. */
export const EXPECTED_BOOK_VALUE_DELTA_CENTS = 0;

/**
 * Does the split still add up? Arithmetic, so the test can assert the module's
 * own numbers are coherent before it ever touches a database, and the runner can
 * refuse to write if someone edits one constant without the other.
 */
export function reconciles(): boolean {
  return (
    Number.isInteger(SALE_CENTS) &&
    Number.isInteger(DONATION_CENTS) &&
    SALE_CENTS > 0 &&
    DONATION_CENTS > 0 &&
    SALE_CENTS + DONATION_CENTS === CHARGE_CENTS &&
    TEE_ITEM.quantity * TEE_ITEM.unitPriceCents === SALE_CENTS
  );
}
