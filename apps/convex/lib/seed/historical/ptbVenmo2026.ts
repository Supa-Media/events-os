/**
 * THE FOURTH POP THE BALLOON RAIL: $820 OF VENMO TICKETS BOOKED AS A GIFT
 * (transcribed 2026-08-09 from the owner's guest list + the live Givebutter row).
 *
 * Pop The Balloon (2025-12-06) sold tickets on four rails. Three are recorded
 * correctly — Givebutter's own checkout, Stripe Tap-to-Pay, and the Cash App
 * payments `cashApp2026.ts` transcribed. The fourth is not.
 *
 * Charisma Stevens collected the Venmo money by hand and forwarded the whole
 * pile as ONE $820.00 Givebutter payment on 2025-11-30. The Givebutter sync
 * recorded it the only way it could: a personal donation from Charisma, tagged
 * to the Pop The Balloon event, because that is precisely what the Givebutter
 * transaction says it is. Nothing in the API could have told it otherwise.
 *
 * Three things are wrong today because of it:
 *   1. Charisma is credited with an $820 gift she never personally gave. It is
 *      in her lifetime total and would print on an acknowledgement letter.
 *   2. Pop The Balloon's ticket revenue is understated by $820.
 *   3. Forty-one attendees have no ticket record at all.
 *
 * ── THE EVIDENCE THAT IT IS TICKETS, NOT A GIFT ─────────────────────────────
 *  - The owner's guest list has FORTY rows with `Platform` = Venmo, every one
 *    with `Verified Payment` = Yes. They are transcribed below verbatim.
 *  - Tickets were $20, and 41 × $20 = $820.00 — the forwarded payment, to the
 *    dollar. There is no rounding, no fee subtraction and no remainder.
 *  - The owner confirmed the arrangement directly: she collected via Venmo and
 *    sent it on as a lump sum.
 *
 * The arithmetic is what carries this, not the narrative. `EXPECTED_ADMISSIONS`
 * is derived from the forwarded amount rather than hand-typed, so a
 * transcription that stops dividing evenly by $20 fails the unit suite instead
 * of shipping.
 *
 * ── BOOK VALUE MUST NOT MOVE, AND THAT IS THE POINT ─────────────────────────
 * Book value counts gifts, sales and PAID ticket orders once each at the
 * revenue layer (`reconciliation.ts#computeBookBalances`). An $820 gift and an
 * $820 paid ticket order in the SAME scope contribute the same $820. So this is
 * a reclassification and nothing else: same money, same book, same day, a
 * different layer and a different set of names.
 *
 * `EXPECTED_BOOK_VALUE_DELTA_CENTS` is 0 deliberately, and the runner both
 * reports it and the test suite asserts it by computing book value before and
 * after through the real `accountBalances` query. If the number moves, the
 * change is wrong — there is no reading of this correction where the org got
 * richer or poorer.
 *
 * The EVENT PAGE's two counters do move, in opposite directions and by the same
 * $820: Revenue (ticket-only) rises, Given (`externalGiftsCents`, which the
 * gift was bumping) falls. The event's "raised" total is unchanged too.
 *
 * ── THE 41ST ADMISSION IS NOT NAMED, AND THAT IS DELIBERATE ─────────────────
 * The money says 41 admissions. The guest list names 40 of them. The obvious
 * candidate for the 41st is Charisma herself: her row reads `Platform` =
 * Cashapp but her handle field reads "@charismastevens venmo", and 40 + her is
 * exactly 41.
 *
 * The Cash App payment feed contradicts that. `cashApp2026.ts` transcribed
 * `Charis Stevens · $20 · 2025-10-31 · memo "charisma ticket"`, and that
 * payment is LIVE — it is one of the 45 admissions on the `ptb:cashapp:2025-10`
 * order in production. Charisma's admission is therefore already recorded, on
 * another rail. Naming her here would put the same person in two admission
 * slots on one event, which is exactly the kind of duplicate the owner has
 * spent two days clearing out of these books.
 *
 * Nor is she the only candidate. Two more guests are marked `Verified Payment`
 * = Yes with NO platform recorded and handles in Venmo's own username format —
 * `Brenell Harrison` (Bre-Harrison-1) and `Fancy` (Fanise-Cannon). Neither
 * appears in the Cash App feed, the Givebutter ticket rows, or the Zelle rows.
 * Either could be the 41st; both cannot be, because 42 admissions would be $840.
 *
 * So there are three candidates for one slot and the sources disagree. The
 * money is certain, the count is certain, and the NAME is not. The slot is
 * therefore filled with a DESCRIPTION of an unidentified admission rather than
 * a person — the same choice `cashApp2026.ts` made with its `Guest of <payer>`
 * slots, and for the same reason: a blank or a description is recoverable by a
 * human who knows the answer, where a wrong name is not. The runner reports the
 * three candidates in `problems` on every run, dry or real, so it is a question
 * put to the owner rather than a decision taken quietly on her behalf.
 *
 * ── THE PLUS-ONE, AND WHY 41 IS STILL RIGHT ─────────────────────────────────
 * Two of the forty rows are one party: `selly` ("Is bringing a +1 (paid)") and
 * `Melos Ambaye` ("Is Plus One Of: Selly"), sharing the Venmo handle
 * `seliom-gobeze`. That is ONE payment of $40 buying TWO admissions — and both
 * people have their OWN row in the guest list, so both are already counted once
 * each in the forty. Nothing needs adding for the plus-one and nothing needs
 * collapsing: admissions are counted per person, payments are not counted at
 * all here, and $20 × 41 is the only figure that has to close.
 *
 * This is why the module counts ADMISSIONS rather than payers. The number of
 * distinct Venmo payments is 39 (Selly paid twice over in one transfer) plus
 * whoever the 41st is — but nobody can reconstruct that split from a lump sum,
 * and nothing in the books needs it.
 *
 * ── NAMES ARE VERBATIM ──────────────────────────────────────────────────────
 * Capitalisation included ("selly", "tarah"), abbreviations included ("Amy V.",
 * "Chika D."), and the two near-identical spellings "Vannesa" and "Vanessa" are
 * two DIFFERENT rows with two different handles and are kept apart. Guessing
 * that one is a typo of the other would silently drop an admission and break
 * the $820.
 *
 * Four of the forty did not attend or were panelists rather than paying
 * audience — `Emmanuella Nnuji-John` and `Cecilee` are marked "Can't Come",
 * `Raymond Gyabeng`, `Taegan`, `Donn Boddie` and `Laetitia A` are panelists.
 * They stay: all six are `Verified Payment` = Yes, so their money is in the
 * lump whether or not they walked through the door. A ticket order records what
 * was BOUGHT; attendance lives on `rsvps`.
 *
 * Data only — no Convex imports — so the vitest unit suite can assert the
 * arithmetic without a database. The runner is `ptbVenmoBackfill.ts`.
 */

/**
 * One guest whose Venmo payment went into Charisma's lump sum, exactly as the
 * owner's guest list records them. `handle` and `note` are EVIDENCE — nothing
 * matches on them — kept so a reader can check any single row against the
 * source rather than take the list on faith.
 */
export type VenmoGuest = {
  /** Name verbatim from the guest list's first column. */
  name: string;
  /** The Cashapp/Venmo Username column, verbatim (owner's own annotations
   *  included — "Venmo: Kayla-Parker-77712", "@ leslie-edward"). */
  handle: string;
  /** Anything the guest list says that isn't a plain "Going" audience row. */
  note?: string;
};

/**
 * The forty `Platform` = Venmo rows, in guest-list (RSVP) order.
 *
 * All forty are `Verified Payment` = Yes. `selly` and `Melos Ambaye` share a
 * handle because Selly paid $40 for the pair — see the plus-one note above.
 */
export const VENMO_GUESTS: VenmoGuest[] = [
  { name: "Kellyne Stephens", handle: "Its_kellyne" },
  { name: "Tiara German", handle: "@tiara-german" },
  { name: "Seyi Olu", handle: "venmo @lilseyi" },
  { name: "Emmanuella Nnuji-John", handle: "@Emmanuella-Nnuji-John", note: "Can't Come" },
  { name: "Kayt", handle: "kaytraquel" },
  { name: "Bambinoh", handle: "lcharles98" },
  { name: "Talia", handle: "@talia-jeanty" },
  { name: "Amy V.", handle: "@amy-villatoro-1" },
  { name: "Destiny Alanna", handle: "@Destiny-Tucker-95" },
  { name: "Favour Agunu", handle: "Favour-Agunu" },
  { name: "tarah", handle: "tarah-paul" },
  { name: "Klaleh", handle: "@Klaleh" },
  { name: "Shekinah", handle: "@hallsg18 (Venmo)" },
  { name: "Shelby", handle: "@sdugas" },
  { name: "Raymond Gyabeng", handle: "Rhaypapenfuss", note: "Panelist" },
  { name: "Ato", handle: "Ato-Aidoo-1" },
  { name: "Victory", handle: "vyinkabanjo" },
  { name: "Chika D.", handle: "ch1ka" },
  { name: "Kayla", handle: "Venmo: Kayla-Parker-77712" },
  { name: "Tems", handle: "Temi- Akanni" },
  { name: "Ellie", handle: "Venmo @ElllieGibson1" },
  { name: "Bithja", handle: "@bithja-pierre" },
  { name: "Taegan", handle: "@taemyers", note: "Panelist" },
  { name: "Cecilee", handle: "Cecileemaxbrown", note: "Can't Come" },
  { name: "Donn Boddie", handle: "@DonnBoddie", note: "Panelist" },
  { name: "Jasmine Shields", handle: "@jasmine-shields-1" },
  { name: "Billy Jean", handle: "@BillyJean23" },
  { name: "Christy", handle: "Christy-Dambleu" },
  { name: "Vannesa", handle: "@Vanhut" },
  { name: "Kendra", handle: "Kendra-Kassim" },
  { name: "Doreen Frempomah", handle: "heydoreen" },
  { name: "Danielle", handle: "@danielle-nwosa" },
  { name: "Leslie", handle: "@ leslie-edward" },
  { name: "Comfort", handle: "@Comfort-Kalu" },
  { name: "Vanessa", handle: "@vanessawanyandeh" },
  { name: "Keianna McCormick", handle: "Keianna-mccormick" },
  { name: "selly", handle: "seliom-gobeze", note: "Is bringing a +1 (paid)" },
  { name: "Laetitia A", handle: "Tisha-Auguste", note: "Panelist" },
  { name: "Sean Brzezinski", handle: "@SeanBrz", note: "Not on partiful" },
  { name: "Melos Ambaye", handle: "seliom-gobeze", note: "Is Plus One Of: Selly" },
];

/** What Charisma forwarded through Givebutter on 2025-11-30, to the cent. */
export const FORWARDED_CENTS = 82000;

/** Pop The Balloon's audience ticket price. Every rail sold at $20. */
export const TICKET_PRICE_CENTS = 2000;

/**
 * How many admissions the forwarded money is — DERIVED, never typed.
 *
 * A stored 41 would be a second transcription of the same fact and could drift
 * from the amount it is supposed to describe. Dividing instead means the only
 * way the count can be wrong is if the money is wrong, and the unit suite
 * asserts that the division is exact (`$820 / $20` leaves no remainder).
 */
export const EXPECTED_ADMISSIONS = FORWARDED_CENTS / TICKET_PRICE_CENTS;

/**
 * The label for the one admission the guest list cannot name.
 *
 * A DESCRIPTION, not a person — see the header's "41st admission" note. Phrased
 * so that anyone reading the order's attendee list on the event page knows
 * immediately that it is an open question rather than someone called Unnamed.
 */
export const UNIDENTIFIED_ADMISSION_LABEL = "Unidentified Venmo payer (41st admission)";

/** The three people the 41st admission could belong to, for the runner's
 *  report. Documentation of an open question — nothing matches on it. */
export const UNIDENTIFIED_ADMISSION_CANDIDATES = [
  "Charisma Stevens (her own row says Cashapp, and a $20 Cash App payment memo'd " +
    "\"charisma ticket\" is already recorded on ptb:cashapp:2025-10)",
  "Brenell Harrison (verified paid, no platform recorded, handle \"Bre-Harrison-1\")",
  "Fancy (verified paid, no platform recorded, handle \"Fanise-Cannon\")",
];

/**
 * One name per admission, index-aligned to the order's 41 tickets — the slot
 * `ticketOrders.items[].attendeeNames` is defined for.
 *
 * The forty named guests in guest-list order, then the unidentified one. Built
 * from `VENMO_GUESTS` rather than typed out again so the list and the count can
 * never disagree.
 */
export const TICKET_ATTENDEE_NAMES: string[] = [
  ...VENMO_GUESTS.map((g) => g.name),
  UNIDENTIFIED_ADMISSION_LABEL,
];

/**
 * The Givebutter TRANSACTION ID of Charisma's forwarded payment, read from the
 * live gift row on 2026-08-09.
 *
 * This is the whole idempotency story. It is `gifts.externalRef` on the row
 * being converted, it is the key `applyGivebutterDonations` dedups on, and it
 * is what goes into `givebutterConvertedDonations` so the sync knows never to
 * write this donation again. Sixteen characters, not the ten-digit
 * `gb:txn:<Reference Number>` the 2026-07 CSV backfill used — this gift came
 * from the LIVE sync, so it carries the API's own id.
 */
export const GIVEBUTTER_TRANSACTION_ID = "FDjw6tNP1Vn6EusJ";

/** 2025-11-30 05:58:05 UTC — `gifts.receivedAt` on the live row, which is the
 *  moment Givebutter took the forwarded payment. The replacement ticket order
 *  is dated the SAME instant: the classification changed, the date did not, and
 *  the reconciliation panel sorts earned revenue by exactly this field. */
export const FORWARDED_AT_MS = 1764482285000;

/** The event page whose event holds Pop The Balloon's ticketing. */
export const PTB_PAGE_SLUG = "pop-the-balloon";

/** `ticketOrders.externalRef` — this run's idempotency key, in the same shape
 *  as its siblings (`ptb:cashapp:2025-10`, `ptb:cashapp:2025-12`). */
export const TICKET_ORDER_REF = "ptb:venmo:2025-11-30";

/**
 * A ticket tier of its own rather than the Cash App one.
 *
 * `cashAppBackfill.ts` argued against minting a second tier, and was right for
 * its case: it was replacing an estimate of the SAME money on the SAME rail, so
 * two tiers would have split one thing in every per-tier report forever. This
 * is a different rail. The live "Audience Ticket (paid outside Givebutter)"
 * tier is described as "Tickets collected by Cash App", so folding Venmo money
 * into it would mislabel the rail — and the rail is exactly what the owner is
 * reconciling against right now. One tier per rail keeps the event's tier
 * breakdown readable as the four-way split it actually was.
 */
export const VENMO_TYPE_NAME = "Audience Ticket (Venmo)";

/** Who collected the money — the honest stand-in for a `ticketOrders.email`
 *  the payers never gave. See the runner's own note on why it is hers. */
export const COLLECTOR_NAME = "Charisma Stevens";
export const COLLECTOR_EMAIL = "charismastev@gmail.com";

/** What the order is called wherever an order name is rendered. */
export const TICKET_ORDER_NAME =
  "Pop The Balloon — Venmo tickets collected by Charisma Stevens";

/**
 * ZERO, and the whole change is built to keep it there.
 *
 * $820 leaves the gifts ledger and $820 arrives as paid ticket revenue, in the
 * same scope. `reconciliation.ts#computeBookBalances` sums both at face value,
 * so the two cancel exactly. The runner reports the delta it actually computed
 * from the rows it touched, and `tests/ptbVenmoBackfill.test.ts` proves it by
 * reading book value out of the real query before and after.
 */
export const EXPECTED_BOOK_VALUE_DELTA_CENTS = 0;

/** Everything the replacement ticket order is worth — derived from the names,
 *  so a dropped or duplicated row cannot leave the total looking right. */
export function ticketGrossCents(): number {
  return TICKET_ATTENDEE_NAMES.length * TICKET_PRICE_CENTS;
}

/** The one identity this module stands on: the tickets are the money. */
export function reconciles(): boolean {
  return ticketGrossCents() === FORWARDED_CENTS;
}
