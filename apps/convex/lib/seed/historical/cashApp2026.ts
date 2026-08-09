/**
 * A YEAR OF CASH APP MONEY THAT NEVER REACHED THE BOOKS (transcribed 2026-08-09).
 *
 * The org has taken money through Cash App since October 2025 and recorded none
 * of the individual payments. What IS in the ledger is the other end of the
 * pipe: three withdrawals moving the balance to a bank account. So the books
 * carry a lump of undifferentiated cash and none of what it was made of —
 * donors with no gift rows (and therefore no acknowledgement letters), Pop The
 * Balloon ticket revenue attributed to nobody, and merch/snack sales that never
 * reached the sales layer.
 *
 * This module is the transcription of the owner's ten Cash App Activity
 * screenshots, collapsed by (name, amount, date) across the overlapping frames.
 * 49 payments in three cohorts, each cohort ending in a withdrawal.
 *
 * ── THE COHORT IS THE UNIT OF PROOF ─────────────────────────────────────────
 * There is no balance in any screenshot, so nothing independently confirms that
 * every payment was captured. The ONE check available is the withdrawal: Cash
 * App's business fee is taken on the way in, so a cohort's payments less the fee
 * must equal the withdrawal that swept them, to the cent.
 *
 *     cohort gross − Cash App fee = the withdrawal already in the ledger
 *
 *     Oct 2025 PTB tickets    $900.00 − $29.40 = $870.60  posted 2025-11-06  New York
 *     Dec 2025 + Jan 2026     $297.00 −  $8.62 = $288.38  posted 2026-01-06  New York
 *     Feb + May 2026          $180.00 −  $5.13 = $174.87  posted 2026-08-07  CENTRAL
 *
 * ── THE WITHDRAWALS ARE NOT ALL ON THE SAME BOOK ────────────────────────────
 * The revenue is New York's — New York ran the events, so the tickets, gifts,
 * sales and the fee expense are all New-York-scoped. WHERE THE CASH LANDED is a
 * different question, and the answer changed when the banking did: the two older
 * sweeps arrived through Relay and were imported against New York, while the
 * newest arrived in the Increase account, and every payout lands in CENTRAL's
 * account — the premise the whole balance-settlement model rests on.
 *
 * So a scope-pinned search silently misses whichever era it is not looking at,
 * and the runner looks for each withdrawal ACROSS BOOKS. `landedOn` below
 * records what was observed; it is documentation, and nothing matches on it.
 *
 * That identity is asserted in `tests/cashAppBackfill.test.ts` against the rows
 * below rather than against hand-typed subtotals, so a transcription edit that
 * breaks the reconciliation fails CI instead of shipping.
 *
 * ── THE FEE IS 2.6% OF EACH PAYMENT PLUS $0.15, FROM SOURCE ────────────────
 * Read as a flat percentage the three cohorts look inconsistent — 3.27%, 2.90%
 * and 2.85% — and October looks $4.65 short of Cash App's published 2.75%. That
 * reading is wrong, and the inconsistency is the clue: a rate that falls as the
 * average payment RISES is a percentage plus a fixed charge per transaction.
 *
 * The owner's payment-detail screens give the two data points that pin it
 * exactly, so nothing here is fitted or inferred:
 *
 *     $50.00 payment  → $1.45 fee → $48.55 deposited
 *     $100.00 payment → $2.75 fee → $97.25 deposited
 *
 *     $2.75 − $1.45 = $1.30 over $50 of difference  → 2.6%
 *     $1.45 − 2.6% × $50                            → $0.15 fixed
 *
 * EVERY payment carries it ("all of these transactions have fees" — owner), so
 * the fee is computed PER PAYMENT (`paymentFeeCents`) and each cohort's total is
 * the sum of its rows. Nothing is hardcoded, which is what lets a reader check
 * any single line rather than take a cohort subtotal on faith. The three
 * withdrawals then reproduce EXACTLY:
 *
 *     40 payments · $900 → 2.6% × $900 + 40 × $0.15 = $29.40  ✓
 *      6 payments · $297 → 2.6% × $297 +  6 × $0.15 =  $8.62  ✓
 *      3 payments · $180 → 2.6% × $180 +  3 × $0.15 =  $5.13  ✓
 *
 * To the cent, three times, from a formula derived from two unrelated receipts.
 * Nothing is unexplained; the whole of each cohort's difference is fee, and
 * every assertion below is an equality with no tolerance in it.
 *
 * The formula also independently CONFIRMS the payment count (see next): the
 * fixed 15¢ per payment means a missing or duplicated row would throw October
 * off by exactly $0.15. It reconciles at 40 rows and only at 40 rows.
 *
 * ── THE TRANSCRIPTION SAYS 41 OCTOBER PAYMENTS. THERE ARE 40 ────────────────
 * The source note totals the October cohort as "41 payments · $900.00 · 45
 * admissions". Its own table has FORTY rows, and forty is what closes: 35 × $20
 * + 5 × $40 = $900 and 45 admissions. A 41st payment at any price would break
 * both figures, and the fee formula above reconciles at 40 rows and nowhere else.
 * So the count in the prose is a miscount and the money is right —
 * recorded here as the 40 rows that are actually listed, flagged rather than
 * silently corrected because the reader of a reconciliation deserves to know the
 * source disagreed with itself.
 *
 * ── OTHER CAVEATS THE OWNER FLAGGED, CARRIED FORWARD DELIBERATELY ───────────
 * Several payers gave first names only (Kyla, Faith, Steph, Marie, Mellie,
 * Rosa, Chavyn, Angel, Jek, Nafisa, Britney, Sherika, Tahlea, Junior, Seyi).
 * "Faith" appears twice and "Faith Holmes" once, and nothing in the screenshots
 * says whether they are one person. Names are stored EXACTLY as Cash App shows
 * them; merging two of them on a hunch would fabricate an identity, and the
 * ticket record only needs to say who paid.
 *
 * ── OWNER DECISIONS (2026-08-09), SETTLED ───────────────────────────────────
 * 1. Kafilat Oladiran's $50 "Crossover" and Tahlea's $50 "nye" are DONATIONS,
 *    not Crossover Night tickets. Gifts, no event attached.
 * 2. All three ambiguous October payments are PTB tickets — Lola Osunseemi's
 *    "public worship", Chavyn's "$givepw" and Seyi's "Event". Everyone paying
 *    $20 that week was buying admission whatever they typed in the memo.
 * 3. REPLACE the estimated $780 / 39-admission order (`ptb:cashapp:2025-12`,
 *    built from the Partiful guest list) with the 40 real payments — $900 and
 *    45 admissions.
 * 4. Book the full $900. The whole of each cohort's gross-to-withdrawal
 *    difference is Cash App's fee (see the fee model above) and is expensed as
 *    such — no payment is dropped to make a total come out tidy.
 *
 * Data only — no Convex imports — so the vitest unit suite can assert the
 * arithmetic without a database. The runner is `cashAppBackfill.ts`.
 */
import { defaultFeeRate, feeOnCents } from "@events-os/shared";

/** The three sweeps, each the settlement of the payments before it. */
export const COHORT_KEYS = ["oct2025", "dec2025_jan2026", "feb_may2026"] as const;
export type CohortKey = (typeof COHORT_KEYS)[number];

/** UTC noon on a `YYYY-MM-DD` day — the house convention for a date-only fact. */
export function utcNoon(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return Date.UTC(y, m - 1, d, 12, 0, 0);
}

// ── COHORT 1 · October 2025 · Pop The Balloon tickets ────────────────────────

/** One Cash App payment for a Pop The Balloon ticket. $20 = one admission. */
export type TicketPayment = {
  /** UTC `YYYY-MM-DD` the payment shows in Cash App. */
  day: string;
  /** The payer, exactly as Cash App renders it (capitalisation included). */
  payer: string;
  /** $20 or $40 — $40 is two admissions, which the memos usually say outright. */
  amountCents: number;
  /** The payer's memo. Never interpreted (owner decision 2), kept as evidence. */
  memo: string;
};

export const TICKET_PRICE_CENTS = 2000;

/**
 * The 40 October payments, in the order they appear in the Activity feed.
 *
 * `Chris Haroldina Haris $40 Oct 28` appears in two overlapping frames and is
 * ONE payment — confirmed against the frame boundaries, not deduped on a
 * name+amount hunch.
 */
export const TICKET_PAYMENTS: TicketPayment[] = [
  { day: "2025-10-26", payer: "Shannon Marshall", amountCents: 2000, memo: "🎈" },
  { day: "2025-10-26", payer: "Lola Osunseemi", amountCents: 2000, memo: "public worship" },
  { day: "2025-10-26", payer: "Kyla", amountCents: 2000, memo: "pop the ballon" },
  { day: "2025-10-26", payer: "Siabhan B.", amountCents: 2000, memo: "Pop the balloon ticket" },
  { day: "2025-10-27", payer: "Ilines Matos", amountCents: 2000, memo: "pop the balloon" },
  { day: "2025-10-27", payer: "Chimaobim", amountCents: 2000, memo: "Pop the Balloon" },
  { day: "2025-10-27", payer: "Anaika Bien-Aime", amountCents: 2000, memo: "pop the balloon" },
  { day: "2025-10-27", payer: "Faith Holmes", amountCents: 2000, memo: "ticket" },
  { day: "2025-10-27", payer: "Christie Jean Louis", amountCents: 2000, memo: "Christian pop the balloon" },
  { day: "2025-10-27", payer: "Jasmine Robinson", amountCents: 2000, memo: "Pop the Balloon Dec. 6th event" },
  { day: "2025-10-27", payer: "Linn Desmarais", amountCents: 2000, memo: "pop the balloon" },
  { day: "2025-10-27", payer: "Styve Orel Zeumo Lekane", amountCents: 2000, memo: "pop the balloon" },
  { day: "2025-10-27", payer: "nene ma", amountCents: 2000, memo: "pop balloon" },
  { day: "2025-10-27", payer: "Sherika", amountCents: 2000, memo: "Pop The Balloon event 12/06/25" },
  { day: "2025-10-27", payer: "Steph", amountCents: 4000, memo: "pop the ballon" },
  { day: "2025-10-27", payer: "claudia duverglas", amountCents: 4000, memo: "pop the balloon for 2" },
  { day: "2025-10-28", payer: "Chris Haroldina Haris", amountCents: 4000, memo: "RSVP POP the balloon" },
  { day: "2025-10-28", payer: "Faith", amountCents: 2000, memo: "Pop the Balloon (Christian Edition)" },
  { day: "2025-10-28", payer: "Aliah M Kimbro", amountCents: 2000, memo: "📌🎈" },
  { day: "2025-10-28", payer: "Gozie Okeke", amountCents: 2000, memo: "pop the balloon event" },
  { day: "2025-10-28", payer: "Shania Kenion", amountCents: 2000, memo: "pop the balloon" },
  { day: "2025-10-28", payer: "Marie", amountCents: 2000, memo: "December 6 Event" },
  { day: "2025-10-28", payer: "Mellie", amountCents: 2000, memo: "pop the balloon event" },
  { day: "2025-10-28", payer: "Blessing Aodu", amountCents: 2000, memo: "pop the balloon" },
  { day: "2025-10-29", payer: "Rosa", amountCents: 2000, memo: "ticket for event" },
  { day: "2025-10-29", payer: "Antony Nyagah", amountCents: 2000, memo: "pop the balloon" },
  { day: "2025-10-29", payer: "Ibukunoluwa Atolagbe", amountCents: 2000, memo: "pop the ballon event_ Ibukun" },
  { day: "2025-10-29", payer: "Chavyn", amountCents: 2000, memo: "$givepw" },
  { day: "2025-10-29", payer: "Angel", amountCents: 2000, memo: "pop the balloon" },
  { day: "2025-10-29", payer: "Jek", amountCents: 2000, memo: "pop ballon event ( I'd like to participate )" },
  { day: "2025-10-29", payer: "Nafisa", amountCents: 2000, memo: "🎈" },
  { day: "2025-10-29", payer: "Kanika Wright", amountCents: 2000, memo: "Pop th Balloon (Christian Edition)" },
  { day: "2025-10-29", payer: "Britney", amountCents: 4000, memo: "Pop the balloon" },
  { day: "2025-10-30", payer: "Faith", amountCents: 2000, memo: "Christian Pop the Balloon for Esther Osemwe…" },
  { day: "2025-10-30", payer: "Jade McClary-Mullis", amountCents: 2000, memo: "pop the ballon" },
  { day: "2025-10-31", payer: "Charis Stevens", amountCents: 2000, memo: "charisma ticket" },
  { day: "2025-10-31", payer: "Seyi", amountCents: 2000, memo: "Event" },
  { day: "2025-10-31", payer: "Jeanne Ngoma", amountCents: 2000, memo: "pop the balloon Christian edition" },
  { day: "2025-10-31", payer: "Zipporah Olukanni", amountCents: 4000, memo: "pop the balloon" },
  { day: "2025-10-31", payer: "Neema Mungai", amountCents: 2000, memo: "🎈" },
];

/** Admissions a payment bought — $40 is two, which several memos say outright. */
export function admissionsFor(p: TicketPayment): number {
  return p.amountCents / TICKET_PRICE_CENTS;
}

export const TICKET_GROSS_CENTS = TICKET_PAYMENTS.reduce((a, p) => a + p.amountCents, 0);
export const TICKET_ADMISSIONS = TICKET_PAYMENTS.reduce((a, p) => a + admissionsFor(p), 0);

/**
 * The per-admission names, index-aligned to the 45 tickets the order carries —
 * the slot `ticketOrders.items[].attendeeNames` is defined for.
 *
 * ONE NAME PER ADMISSION, not one per payment, because the field is aligned to
 * admissions. The 40 payers come first in payment order; the five extra
 * admissions bought at $40 follow as `Guest of <payer>`. That phrasing is
 * deliberate: it is a DESCRIPTION of an unclaimed seat, not a person's name.
 * Repeating the payer's name in both slots would assert two attendees called
 * Steph, and leaving the slots blank would lose which payer paid for the pair —
 * the only fact about the second admission we actually have.
 */
export const TICKET_ATTENDEE_NAMES: string[] = [
  ...TICKET_PAYMENTS.map((p) => p.payer),
  ...TICKET_PAYMENTS.filter((p) => admissionsFor(p) > 1).flatMap((p) =>
    Array.from({ length: admissionsFor(p) - 1 }, () => `Guest of ${p.payer}`),
  ),
];

/** The estimated order being replaced (owner decision 3): $780, 39 admissions,
 *  built from the Partiful guest list by `septemberAndCashApp.ts`. Re-verified
 *  against the live row before anything is deleted. */
export const ESTIMATED_ORDER_REF = "ptb:cashapp:2025-12";
export const ESTIMATED_ORDER_CENTS = 78000;
export const ESTIMATED_ORDER_ADMISSIONS = 39;

/** The replacement — the actual October money, keyed on the month it arrived. */
export const TICKET_ORDER_REF = "ptb:cashapp:2025-10";
/** The event page whose event holds Pop The Balloon's ticketing. */
export const PTB_PAGE_SLUG = "pop-the-balloon";
/**
 * The order is dated 2025-10-31 — the day the last payment landed, and so the
 * day the collection closed. The order it replaces was dated 2025-12-07 (the
 * event), which is when the tickets were USED, not when the money was earned.
 * The reconciliation panel sorts earned revenue by this date and pairs it
 * against the 2025-11-04 withdrawal; October is where it belongs.
 */
export const TICKET_ORDER_DAY = "2025-10-31";

// ── COHORTS 2 & 3 · gifts ────────────────────────────────────────────────────

/** A donation that arrived by Cash App. */
export type CashAppGift = {
  cohort: CohortKey;
  day: string;
  /** Donor name as Cash App shows it — matched/created through `matchOrCreateDonor`. */
  donor: string;
  amountCents: number;
  /** The payer's memo, quoted into the gift note as the evidence for it. */
  memo: string;
  /** `gifts.externalRef` — the idempotency key that makes a re-run a no-op. */
  externalRef: string;
};

/**
 * Six gifts, $440 total, from five donors.
 *
 * NO EMAILS, and none invented. `matchOrCreateDonor` matches on email → phone →
 * name, so a name-only donor either joins an existing record or creates one that
 * a later gift with an email can be reconciled onto by hand. A placeholder
 * address would poison that match permanently and put a fake contact into the
 * acknowledgement mailing list.
 *
 * ── THE NAME IS THE ONLY KEY, AND IT IS MATCHED EXACTLY ─────────────────────
 * `findDonorInScope` falls back to an EXACT string equality on name — no case
 * folding, no punctuation normalising. With no email and no phone that is the
 * only key these gifts have, and every name below was checked by hand against
 * the 123 production donors before this shipped:
 *
 *   Lola Osunseemi      → existing donor, $25.00 lifetime. Merges.
 *   Ja’Brilyn Chandler  → existing donor, $100.00 lifetime. Merges — but only
 *                         because of the apostrophe, see below.
 *   Kafilat Oladiran    → new
 *   Tahlea              → new
 *   David Aodu          → new
 *
 * ── THE APOSTROPHE IS LOAD-BEARING. DO NOT "FIX" IT ────────────────────────
 * The production donor is `Ja’Brilyn Chandler` with a CURLY apostrophe (U+2019).
 * The screenshot transcription used a straight one (U+0027). Those are different
 * bytes, exact matching misses, and her two Cash App gifts would have opened a
 * SECOND donor record and split her giving history — the exact class of
 * duplicate the owner has spent two days clearing out. The curly character below
 * is deliberate and is asserted in `tests/cashAppBackfill.test.ts` so an editor
 * or a lint autofix cannot quietly straighten it.
 *
 * Normalised HERE rather than by widening `findDonorInScope`: that function is a
 * shared primitive on the giving hot path, and making it fuzzy would silently
 * merge donors for every other caller — a far bigger decision than a one-time
 * backfill gets to make.
 *
 * ── AND EXACT MATCHING IS THE RIGHT BEHAVIOUR FOR THE REST ─────────────────
 * Several payers gave a first name only (Tahlea here; Kyla, Faith, Steph and a
 * dozen more among the ticket payers). A bare first name is a weak key. Creating
 * a donor called "Tahlea" is fine — it is what the evidence says. Matching her
 * onto some other Tahlea because the strings looked close would be a fabricated
 * identity. Exact matching gets that right, and nothing here should be made
 * clever enough to break it.
 *
 * Note also that the FORTY ticket payers never reach the donors table at all:
 * they are `attendeeNames` on a ticket order, and a ticket buyer is not a donor.
 * Only these five names can create or match a donor record.
 *
 * Kafilat's "Crossover" and Tahlea's "nye" both name Crossover Night, and both
 * are donations rather than ticket purchases — owner decision 1. They carry NO
 * `eventId` for that reason: attaching the event would read as event revenue.
 */
export const GIFTS: CashAppGift[] = [
  {
    cohort: "dec2025_jan2026",
    day: "2025-12-31",
    donor: "Kafilat Oladiran",
    amountCents: 5000,
    memo: "Crossover",
    externalRef: "cashapp:gift:2025-12-31:kafilat-oladiran",
  },
  {
    cohort: "dec2025_jan2026",
    day: "2026-01-01",
    donor: "Ja’Brilyn Chandler",
    amountCents: 15000,
    memo: "Public Workship donations",
    externalRef: "cashapp:gift:2026-01-01:jabrilyn-chandler",
  },
  {
    cohort: "dec2025_jan2026",
    day: "2026-01-01",
    donor: "Tahlea",
    amountCents: 5000,
    memo: "nye",
    externalRef: "cashapp:gift:2026-01-01:tahlea",
  },
  {
    cohort: "dec2025_jan2026",
    day: "2026-01-01",
    donor: "David Aodu",
    amountCents: 4000,
    memo: "God Almighty will continue to use you all IJN",
    externalRef: "cashapp:gift:2026-01-01:david-aodu",
  },
  {
    cohort: "feb_may2026",
    day: "2026-02-08",
    donor: "Ja’Brilyn Chandler",
    amountCents: 5000,
    memo: "Public Worship Donation",
    externalRef: "cashapp:gift:2026-02-08:jabrilyn-chandler",
  },
  {
    cohort: "feb_may2026",
    day: "2026-05-30",
    donor: "Lola Osunseemi",
    amountCents: 10000,
    memo: "PW",
    externalRef: "cashapp:gift:2026-05-30:lola-osunseemi",
  },
];

// ── COHORTS 2 & 3 · sales ────────────────────────────────────────────────────

/** A merch/snack sale paid by Cash App rather than by card. */
export type CashAppSale = {
  cohort: CohortKey;
  day: string;
  buyer: string;
  amountCents: number;
  memo: string;
  /** `sales.externalRef` — this rail's equivalent of a Stripe charge id. */
  externalRef: string;
  /** Attach to the Pop The Balloon event, or leave the sale unattributed. */
  attachToPtb: boolean;
  /** Resolved line items, or `[]` when the amount doesn't resolve to exactly one
   *  reading (`lib/salesCatalog.ts`'s rule, applied by hand to three rows). */
  items: { label: string; quantity: number; unitPriceCents: number; candidates: string[] }[];
  itemSource: "amount_decomposition" | "unresolved";
};

/**
 * Three sales, $37 total.
 *
 * ITEMS ARE ONLY ASSERTED WHERE THE AMOUNT RESOLVES TO EXACTLY ONE READING —
 * the same rule `lib/salesCatalog.ts` enforces for the card sales, applied here
 * by hand because there are three rows rather than 178:
 *
 *  - Beza's $4 "snacks" is ambiguous against Pop The Balloon's snack prices
 *    ($1/$2/$3/$5): 1+3, 2+2, 1+1+2 and 1+1+1+1 all make $4. Plural "snacks"
 *    confirms it was a basket and says nothing about which. Unresolved.
 *  - Junior's $3 "water" CONTRADICTS the catalogue, which prices Water at $1.
 *    Three waters, or one $3 drink he called water — the memo cannot settle it
 *    and neither can the amount. Unresolved. The $3 of revenue is certain
 *    either way, which is the part that matters to the books.
 *  - Lola's $30 "shirt" is unambiguous: the PW Tee is $30, it is the only $30
 *    unit in any catalogue, and the memo independently says shirt.
 *
 * EVENT ATTRIBUTION follows the schema's rule — by date. The two snack sales
 * fall on 2025-12-06, Pop The Balloon's own day, so they attach. Lola's tee was
 * bought 2026-05-30, the day BEFORE Eden; "the day before" is not attribution by
 * date, and the tee was on sale outside Eden too, so it stays unattributed
 * rather than being assigned to an event on a guess. Book value is identical
 * either way — only the per-event breakdown differs, and a blank there is
 * recoverable where a wrong event is not.
 */
export const SALES: CashAppSale[] = [
  {
    cohort: "dec2025_jan2026",
    day: "2025-12-06",
    buyer: "Beza Solomon",
    amountCents: 400,
    memo: "snacks",
    externalRef: "cashapp:sale:2025-12-06:beza-solomon",
    attachToPtb: true,
    items: [],
    itemSource: "unresolved",
  },
  {
    cohort: "dec2025_jan2026",
    day: "2025-12-06",
    buyer: "Junior",
    amountCents: 300,
    memo: "water",
    externalRef: "cashapp:sale:2025-12-06:junior",
    attachToPtb: true,
    items: [],
    itemSource: "unresolved",
  },
  {
    cohort: "feb_may2026",
    day: "2026-05-30",
    buyer: "Lola Osunseemi",
    amountCents: 3000,
    memo: "shirt",
    externalRef: "cashapp:sale:2026-05-30:lola-osunseemi",
    attachToPtb: false,
    items: [{ label: "PW Tee", quantity: 1, unitPriceCents: 3000, candidates: ["PW Tee"] }],
    itemSource: "amount_decomposition",
  },
];

// ── The withdrawals, and the fee each one implies ────────────────────────────

/** One sweep from Cash App to a bank account, and the fee it settles. */
export type Cohort = {
  key: CohortKey;
  /** How a human refers to this cohort in the reconciliation. */
  label: string;
  /** The withdrawal amount — the match key against the ledger. Distinctive
   *  enough to identify the row on its own; the runner refuses on any other
   *  count than exactly one. */
  withdrawalCents: number;
  /** UTC `YYYY-MM-DD` Cash App's own feed shows the withdrawal on — the day it
   *  was initiated, and the anchor for the ledger search window below. */
  initiatedDay: string;
  /** UTC `YYYY-MM-DD` the bank actually posted it, observed in the ledger. Two
   *  days after initiation for the two Relay ones, one day for the Increase
   *  one — which is why the row is searched over a WINDOW rather than a day. */
  ledgerDay: string;
  /**
   * Which book the cash landed on, observed — DOCUMENTATION ONLY. The lookup
   * deliberately does not pin scope; see `WITHDRAWAL_MATCH_WINDOW_DAYS`.
   */
  landedOn: string;
  /** Where the money went, from the Cash App feed. */
  destination: string;
  /** `transactions.externalId` for this cohort's fee row (the idempotency key). */
  feeExternalId: string;
};

/**
 * NOTE THE ABSENCE OF A `feeCents` FIELD. It was here, hand-typed, and it is
 * gone on purpose: a stored fee is a second transcription of the same fact and
 * can drift from the payments it is supposed to describe. `cohortFeeCents`
 * derives it from the rows, so the only way `cohortReconciles` can pass is if
 * the payments themselves are right.
 */

export const COHORTS: Cohort[] = [
  {
    key: "oct2025",
    label: "October 2025 Pop The Balloon tickets",
    withdrawalCents: 87060,
    initiatedDay: "2025-11-04",
    ledgerDay: "2025-11-06",
    landedOn: "New York (Relay, relay_csv)",
    destination: "Visa Debit 9370",
    feeExternalId: "cashapp-fees:2025-11-06",
  },
  {
    key: "dec2025_jan2026",
    label: "December 2025 + January 2026 gifts and sales",
    withdrawalCents: 28838,
    initiatedDay: "2026-01-04",
    ledgerDay: "2026-01-06",
    landedOn: "New York (Relay, relay_csv)",
    destination: "Visa debit 9370",
    feeExternalId: "cashapp-fees:2026-01-06",
  },
  {
    key: "feb_may2026",
    label: "February + May 2026 gifts and sales",
    withdrawalCents: 17487,
    initiatedDay: "2026-08-06",
    ledgerDay: "2026-08-07",
    landedOn: "Central (Increase, increase_ach)",
    destination: "Checking 3925",
    feeExternalId: "cashapp-fees:2026-08-07",
  },
];

/**
 * How far past the Cash App feed's own date to look for the bank row.
 *
 * Observed lags are +2, +2 and +1 days. Four days is comfortable headroom
 * without being so wide that a same-amount collision becomes likely — and a
 * collision is not tolerated anyway: the runner requires EXACTLY ONE match
 * across the whole org and refuses otherwise.
 */
export const WITHDRAWAL_MATCH_WINDOW_DAYS = 4;

/** The `postedAt` range to search a cohort's withdrawal in, inclusive. */
export function withdrawalWindow(c: Cohort): { fromMs: number; toMs: number } {
  const [y, m, d] = c.initiatedDay.split("-").map(Number);
  const fromMs = Date.UTC(y, m - 1, d);
  return {
    fromMs,
    toMs: fromMs + (WITHDRAWAL_MATCH_WINDOW_DAYS + 1) * 86_400_000 - 1,
  };
}

/**
 * Cash App's business fee: 2.6% of the payment, plus $0.15.
 *
 * NOT the 2.75% Cash App publishes, and not derived from the withdrawals — read
 * off two of the owner's payment-detail screens ($50.00 → $1.45, $100.00 →
 * $2.75), which have a fixed component the headline rate does not mention. See
 * this file's header for the two-equation solve.
 *
 * THE RATE NOW LIVES IN THE FEE SCHEDULE (`@events-os/shared`'s
 * `DEFAULT_FEE_SCHEDULE`), which is where every other consumer reads it from —
 * this module was the only place it was ever written down, and a rate in one
 * file that three features need is how the same number ends up retyped
 * differently in each.
 *
 * It reads the PUBLISHED default, never `processorFeeSchedule`'s stored
 * override. This module's job is to reproduce three 2026 withdrawals to the
 * cent; a treasurer re-pricing the rail for future giving must not retroactively
 * change what already happened.
 */
const CASH_APP_RATE = defaultFeeRate("cash_app", "wallet")!;
export const FEE_RATE = CASH_APP_RATE.percentBps / 10_000;
export const FEE_FIXED_CENTS = CASH_APP_RATE.fixedCents;

/**
 * What Cash App took out of ONE payment.
 *
 * PER PAYMENT, not per cohort, because that is how the fee is actually charged
 * ("all of these transactions have fees" — owner, 2026-08-09) and because it
 * makes every figure checkable: a reader who doubts a cohort's $29.40 can test
 * any single $20 ticket at 67¢ rather than having to accept a subtotal. The
 * cohort total is the SUM of these, never a hardcoded number.
 *
 * Rounded per payment, which matters: 40 × round(2000 × 0.026) is 2080, while
 * round(40 × 2000 × 0.026) is also 2080 here, but the two diverge on amounts
 * that don't round cleanly. The processor charges per payment, so the rounding
 * happens per payment. (`feeOnCents` rounds per call for exactly this reason.)
 */
export function paymentFeeCents(amountCents: number): number {
  return feeOnCents(amountCents, CASH_APP_RATE);
}

/** Every payment in a cohort, in the one shape the fee cares about. */
export function cohortPaymentAmounts(key: CohortKey): number[] {
  return [
    ...(key === "oct2025" ? TICKET_PAYMENTS.map((p) => p.amountCents) : []),
    ...GIFTS.filter((g) => g.cohort === key).map((g) => g.amountCents),
    ...SALES.filter((s) => s.cohort === key).map((s) => s.amountCents),
  ];
}

/** How many separate Cash App payments a cohort is made of. */
export function cohortPaymentCount(key: CohortKey): number {
  return cohortPaymentAmounts(key).length;
}

/**
 * The fee Cash App took on a cohort — the sum of its payments' fees.
 *
 * This is what the runner books as the expense. It is DERIVED, and the check
 * that it is right is `cohortReconciles`: gross minus this must equal the
 * withdrawal already sitting in the ledger, exactly, for all three cohorts.
 */
export function cohortFeeCents(key: CohortKey): number {
  return cohortPaymentAmounts(key).reduce((a, amt) => a + paymentFeeCents(amt), 0);
}

/**
 * Everything this backfill records into one cohort, summed from the rows —
 * never hand-typed, so the reconciliation assertion below is a real check on the
 * data rather than a check on a second transcription of it.
 */
export function cohortGrossCents(key: CohortKey): number {
  const tickets = key === "oct2025" ? TICKET_GROSS_CENTS : 0;
  const gifts = GIFTS.filter((g) => g.cohort === key).reduce((a, g) => a + g.amountCents, 0);
  const sales = SALES.filter((s) => s.cohort === key).reduce((a, s) => a + s.amountCents, 0);
  return tickets + gifts + sales;
}

/** The whole point: gross − fee must be the withdrawal already in the ledger. */
export function cohortReconciles(c: Cohort): boolean {
  return cohortGrossCents(c.key) - cohortFeeCents(c.key) === c.withdrawalCents;
}

export const TOTAL_GROSS_CENTS = COHORTS.reduce((a, c) => a + cohortGrossCents(c.key), 0);
export const TOTAL_FEE_CENTS = COHORTS.reduce((a, c) => a + cohortFeeCents(c.key), 0);

/**
 * What book value does when this runs, and why every term is there.
 *
 *   + $900.00  the October tickets, recorded for the first time
 *   − $780.00  the estimated order they replace
 *   + $440.00  six gifts
 *   +  $37.00  three sales
 *   −  $43.15  the Cash App fees, booked as an expense
 *   − $174.87  the third withdrawal, relabelled so it stops counting as income
 *              (the other two already carry `payoutProcessor` and count 0)
 *   ─────────
 *   + $378.98
 *
 * Which the cash side confirms independently: the three withdrawals total
 * $1,333.85 of real money, of which $954.87 was already in the books — $780 as
 * the estimated order and $174.87 as the unlabelled credit. $1,333.85 − $954.87
 * = $378.98, from figures that share no arithmetic with the list above.
 */
export const EXPECTED_BOOK_VALUE_DELTA_CENTS = 37898;
