/**
 * Repairing the collision between the July-2026 Givebutter CSV backfill and the
 * live campaign sync (2026-08-07).
 *
 * ── WHAT HAPPENED ───────────────────────────────────────────────────────────
 * Two importers wrote Givebutter money into this deployment, and they key their
 * rows on DIFFERENT identifiers for the same transaction:
 *
 *   - the one-time CSV backfill (all 107 of its rows were created on
 *     2026-07-19) keyed `gifts.externalRef` as `gb:txn:<CSV Reference Number>`
 *     — the 10-digit number the Givebutter EXPORT prints, e.g. `gb:txn:7868069846`;
 *   - the live sync (`givebutterSync.ts`) keys on the Givebutter API's own
 *     transaction id — a 16-character token, e.g. `FDjw6tNP1Vn6EusJ`.
 *
 * Those two id spaces do not overlap, so `applyGivebutterDonations`' dedup —
 * which is a lookup on `gifts.by_externalRef` — could not see the backfill's
 * rows. When the Pop The Balloon campaign was attached to its event and synced,
 * every PTB donation the backfill had already recorded was recorded a SECOND
 * time. Giving read $9,839.75 against an export total of $9,274.75.
 *
 * The guard added alongside this (see `givebutterSync.ts`) stops it recurring.
 * This module cleans up what already landed.
 *
 * ── WHY THE BACKFILL ROWS GO, NOT THE SYNCED ONES ───────────────────────────
 * The synced rows are strictly better: they carry the API transaction id that
 * every FUTURE sync will dedup against, and they carry `eventId` so the money
 * attributes to Pop The Balloon. The backfill rows carry neither. Keeping the
 * backfill row would leave the same landmine armed for the next re-sync.
 *
 * ── ALL 20 ARE SUPERFLUOUS — VERIFIED ROW BY ROW AGAINST THE EXPORT ─────────
 * Each of the 20 was checked individually against the Givebutter transaction
 * export rather than inferred from a pattern. They fall into three groups, and
 * every one is now represented correctly elsewhere:
 *
 *   9 PURE DONATIONS ($385) — the sync re-recorded these verbatim. The backfill
 *     copy is a straight duplicate.
 *   9 PURE TICKET PURCHASES ($185) — never donations at all. The backfill read
 *     a ticket sale as a gift; the ticket sweep now holds them as mirror
 *     `ticketOrders`, which is where ticket money belongs.
 *   2 TICKET + DONATION ($95) — the backfill took the transaction's FULL amount
 *     as a gift, ticket half included. The sync has since recorded the donation
 *     half correctly ($30 and $5) and the ticket half sits in `ticketOrders`,
 *     so the whole backfill row is superseded.
 *
 * `ticketCents` + `donationCents` are carried per row so the runner can restate
 * that split in the audit trail, and `amountCents` is re-verified against the
 * live row before anything is deleted — a row that no longer matches is
 * REPORTED, never removed. (An earlier pass in this reconciliation deleted a
 * real $500 bank deposit on an amount+date pattern match; nothing here is
 * removed on a pattern.)
 */

/** One backfill gift row superseded by the live sync. */
export type StaleBackfillGift = {
  /** `gifts.externalRef` written by the CSV backfill. The removal key. */
  externalRef: string;
  /** Expected `amountCents` — re-verified before the row is touched. */
  amountCents: number;
  /** Donor name from the export, for the dry-run report only. */
  donor: string;
  /** UTC `YYYY-MM-DD` of the Givebutter transaction, for the report only. */
  day: string;
  /** Ticket/bundle money inside this transaction (belongs in `ticketOrders`). */
  ticketCents: number;
  /** Donation money inside it (the sync has re-recorded this correctly). */
  donationCents: number;
};

export const STALE_BACKFILL_GIFTS: StaleBackfillGift[] = [
  { externalRef: "gb:txn:7868069846", amountCents: 15000, donor: "Temiloluwa Akanni", day: "2025-12-06", ticketCents: 0, donationCents: 15000 },
  { externalRef: "gb:txn:8184949528", amountCents: 10000, donor: "Gabrielle Morrison", day: "2025-12-07", ticketCents: 0, donationCents: 10000 },
  { externalRef: "gb:txn:6235948069", amountCents: 7000, donor: "Gabrielle Morrison", day: "2025-11-21", ticketCents: 4000, donationCents: 3000 },
  { externalRef: "gb:txn:9152641734", amountCents: 5000, donor: "charisma stevens", day: "2025-12-07", ticketCents: 0, donationCents: 5000 },
  { externalRef: "gb:txn:7612299907", amountCents: 2500, donor: "Joseph Olujide", day: "2025-11-28", ticketCents: 2500, donationCents: 0 },
  { externalRef: "gb:txn:6512288196", amountCents: 2500, donor: "David Nebo", day: "2025-11-30", ticketCents: 2000, donationCents: 500 },
  { externalRef: "gb:txn:9201118890", amountCents: 2000, donor: "Dejah-Symphony Fenelon", day: "2025-11-01", ticketCents: 2000, donationCents: 0 },
  { externalRef: "gb:txn:9538507551", amountCents: 2000, donor: "Nia Stroy", day: "2025-11-05", ticketCents: 2000, donationCents: 0 },
  { externalRef: "gb:txn:3917976818", amountCents: 2000, donor: "Jasmine Smith", day: "2025-11-09", ticketCents: 2000, donationCents: 0 },
  { externalRef: "gb:txn:9037953871", amountCents: 2000, donor: "Katherine Raquel", day: "2025-11-22", ticketCents: 2000, donationCents: 0 },
  { externalRef: "gb:txn:6783991290", amountCents: 2000, donor: "Kya Nicholson", day: "2025-11-25", ticketCents: 2000, donationCents: 0 },
  { externalRef: "gb:txn:1232444321", amountCents: 2000, donor: "Mercedes Hilton", day: "2025-11-25", ticketCents: 2000, donationCents: 0 },
  { externalRef: "gb:txn:1838400223", amountCents: 2000, donor: "Nnenna Ene", day: "2025-11-27", ticketCents: 2000, donationCents: 0 },
  { externalRef: "gb:txn:1828259076", amountCents: 2000, donor: "Jennifer Medna", day: "2025-11-30", ticketCents: 2000, donationCents: 0 },
  { externalRef: "gb:txn:4314724391", amountCents: 2000, donor: "Eva Muraga", day: "2025-12-05", ticketCents: 0, donationCents: 2000 },
  { externalRef: "gb:txn:7967314582", amountCents: 2000, donor: "Ibukunoluwa Atolagbe", day: "2025-12-07", ticketCents: 0, donationCents: 2000 },
  { externalRef: "gb:txn:2411716476", amountCents: 1500, donor: "Bithja Pierre", day: "2025-12-07", ticketCents: 0, donationCents: 1500 },
  { externalRef: "gb:txn:6879167620", amountCents: 1000, donor: "Latoya Dobson", day: "2025-11-02", ticketCents: 0, donationCents: 1000 },
  { externalRef: "gb:txn:2282352155", amountCents: 1000, donor: "Styve Lekane", day: "2025-12-07", ticketCents: 0, donationCents: 1000 },
  { externalRef: "gb:txn:3734463205", amountCents: 1000, donor: "Vivian Chinoda", day: "2025-12-07", ticketCents: 0, donationCents: 1000 },
];

/** Derived so the expected total can never drift from the list above. */
export const STALE_BACKFILL_TOTAL_CENTS = STALE_BACKFILL_GIFTS.reduce(
  (sum, g) => sum + g.amountCents,
  0,
);

/**
 * The one donation in the export that NO importer can reach.
 *
 * It was given through the general "Public Worship" campaign, which is not
 * attached to any event — and the sync only ever walks campaigns that ARE. The
 * CSV backfill skipped it too (it postdates the 2026-07-19 run by three days).
 * So it is entered directly, keyed on the same `gb:txn:<reference>` convention
 * the backfill used, which is the id we actually hold for it.
 *
 * With this in and the 20 above out, `gifts` where `method === "givebutter"`
 * totals $9,274.75 — exactly the export's donation total across all campaigns.
 */
export const MISSING_GIFT = {
  externalRef: "gb:txn:4248951952",
  amountCents: 10000,
  donorName: "Sarah Gonzalez",
  email: "sarahgonz.pr@gmail.com",
  /** 2026-07-19 21:34:39 UTC. */
  receivedAt: 1784496879000,
  note: "Givebutter donation via the general Public Worship campaign, which has no event attached — outside the reach of both the CSV backfill and the campaign sync. Entered from the 2026-08-07 transaction export.",
} as const;

/**
 * Ticket prices the mirror booked at FACE VALUE, ignoring Givebutter discounts.
 *
 * `normalizeTicket` reads `price` off `GET /v1/tickets`, which is the tier's
 * list price. It is NOT what the buyer paid: Pop The Balloon issued personal
 * promo codes (SHAINA, SAMUEL, CHIKA, PLAS, NELLA, MICHAELA, PWTEAM,
 * LACEAFFAIRS), and the amount actually collected lives on the TRANSACTION's
 * line item `total`, one level down. So the event booked $3,260 of ticket
 * revenue against $2,945 Givebutter actually took — $315 of book value that
 * never existed.
 *
 * The discount is per BUYER, not per tier — two Legacy/Team tickets sold for
 * $20 each while four others were comped outright — so these corrections are
 * keyed on `ticketOrders.externalRef` (the individual ticket), never on the
 * tier name. `expectedCurrentCents` is re-verified before each patch.
 *
 * The two $0 tiers are the other half of the same bug in reverse: "His Ticket"
 * and "Her Ticket" are the two admissions of a $40 "His & Hers" BUNDLE. The
 * ticket sweep imports tickets and not bundles, so it booked the admissions at
 * their $0 face price and dropped the bundle's $40 entirely. Splitting the
 * bundle across its two admissions ($20 each) puts that money back where the
 * rest of the event's ticket revenue lives.
 *
 * `givebutterSync.ts` now reads the discounted line-item total for new imports;
 * this list repairs the 14 rows that came in before that fix.
 */
export type TicketPriceCorrection = {
  /** `ticketOrders.externalRef` — `gb:ticket:<id>`. */
  externalRef: string;
  /** Face price the mirror stored. Re-verified before patching. */
  expectedCurrentCents: number;
  /** What Givebutter actually collected for this ticket. */
  correctedCents: number;
  /** For the dry-run report. */
  who: string;
  why: string;
};

export const TICKET_PRICE_CORRECTIONS: TicketPriceCorrection[] = [
  { externalRef: "gb:ticket:45023484A0048", expectedCurrentCents: 5000, correctedCents: 0, who: "Ibukunoluwa Atolagbe — Legacy Ticket", why: "comped in full (code LACEAFFAIRS)" },
  { externalRef: "gb:ticket:17382652A0084", expectedCurrentCents: 5000, correctedCents: 2000, who: "Jordanella Maluka Chagiye — Legacy Ticket", why: "$30 off (code NELLA)" },
  { externalRef: "gb:ticket:13249184A0123", expectedCurrentCents: 5000, correctedCents: 2500, who: "Seyi Olujide — Crewneck", why: "$25 off (code PWTEAM)" },
  { externalRef: "gb:ticket:49949677A0125", expectedCurrentCents: 5000, correctedCents: 0, who: "Michaela Lawson — Crewneck", why: "comped in full (code MICHAELA)" },
  { externalRef: "gb:ticket:48971910A0147", expectedCurrentCents: 5000, correctedCents: 0, who: "Laura Gomez — Legacy/Team", why: "comped in full (code PLAS)" },
  { externalRef: "gb:ticket:36610760A0148", expectedCurrentCents: 5000, correctedCents: 0, who: "Kemberly Pierre — Legacy/Team", why: "comped in full (code PLAS)" },
  { externalRef: "gb:ticket:84594140A0149", expectedCurrentCents: 5000, correctedCents: 2000, who: "Chika Dueke-Eze — Legacy/Team", why: "$30 off (code CHIKA)" },
  { externalRef: "gb:ticket:70572072A0150", expectedCurrentCents: 5000, correctedCents: 2000, who: "Samuel Nkama — Legacy/Team (1 of 2)", why: "$30 off each on a 2-ticket order (code SAMUEL)" },
  { externalRef: "gb:ticket:88422986A0151", expectedCurrentCents: 5000, correctedCents: 2000, who: "Samuel Nkama — Legacy/Team (2 of 2)", why: "$30 off each on a 2-ticket order (code SAMUEL)" },
  { externalRef: "gb:ticket:86575682A0152", expectedCurrentCents: 5000, correctedCents: 0, who: "Shaina Brown — Legacy/Team", why: "comped in full (code SHAINA)" },
  { externalRef: "gb:ticket:69407822A0093", expectedCurrentCents: 0, correctedCents: 2000, who: "Cameron Schuster — His Ticket", why: "half of Olivia Leamah's $40 His & Hers bundle" },
  { externalRef: "gb:ticket:69329730A0094", expectedCurrentCents: 0, correctedCents: 2000, who: "Olivia Leamah — Her Ticket", why: "half of Olivia Leamah's $40 His & Hers bundle" },
  { externalRef: "gb:ticket:66945078A0132", expectedCurrentCents: 0, correctedCents: 2000, who: "John Smith — His Ticket", why: "half of Fara F's $40 His & Hers bundle" },
  { externalRef: "gb:ticket:45102309A0133", expectedCurrentCents: 0, correctedCents: 2000, who: "Fara F — Her Ticket", why: "half of Fara F's $40 His & Hers bundle" },
];

/** Net change to the event's `revenueCents`. Derived, so it cannot drift. */
export const TICKET_REVENUE_DELTA_CENTS = TICKET_PRICE_CORRECTIONS.reduce(
  (sum, c) => sum + (c.correctedCents - c.expectedCurrentCents),
  0,
);

/** Pop The Balloon's ticket revenue once the corrections land — the figure the
 *  Givebutter export says the event actually collected. */
export const PTB_EXPECTED_TICKET_REVENUE_CENTS = 294500;
