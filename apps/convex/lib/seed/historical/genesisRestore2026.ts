/**
 * Six charges the books lost twice (2026-08-09). Private repo.
 *
 * These are not new expenses. Each is a row `financeGenesisBackfill.ts` wrote
 * correctly and `genesisDedupe2026.ts` then deleted as a duplicate — the second
 * pass to get this wrong, after `restoreTruistDeposit.ts` put back a $500 Truist
 * deposit for the same reason. Twelve rows were deleted; eleven of those were
 * right, and the twelfth is already back. These six were wrong too, which makes
 * the real score 6 of 12.
 *
 * ── WHY THE DEDUPE THOUGHT THEY WERE DUPLICATES, AND WHY THEY ARE NOT ────────
 * The dedupe's evidence was "every surviving `genesis-bank:*` row has a
 * same-amount, same-flow twin within two days; not one stands alone." That was
 * true and still is. What it missed is that the twin these six matched had
 * ALREADY BEEN SPOKEN FOR.
 *
 * `financeGenesisBackfill.ts#claimExisting` consumes a live-feed row when a
 * curated row matches it, precisely so two genuinely distinct same-day charges
 * cannot both collapse onto one real row. So when Kansi's export holds TWO
 * identical charges and the ledger holds ONE, the backfill correctly skipped the
 * first (it was already in the ledger) and INSERTED the second (nothing left to
 * match). The dedupe pass then looked at that inserted row, found the same
 * live-feed twin the backfill had already consumed, and deleted it — matching
 * one ledger row against two curated rows, which is the exact mistake
 * `claimExisting` exists to prevent. It never re-derived the pairing; it read
 * "has a twin" as "is a copy".
 *
 * ── WHY THE LEDGER HELD ONE WHERE THE BANK HELD TWO ─────────────────────────
 * Upstream of all of it: `stripeFinance.ts#applyRelayImport` keyed each Relay
 * CSV row on day + amount + merchant + card reference. Two genuinely distinct
 * identical charges on the same day and card produce the SAME key, so the second
 * was counted `skipped` as a re-import and never landed. That is fixed in the
 * same change as this restore — see `relayExternalId`'s `occurrence` argument —
 * but the fix cannot retroactively insert what was dropped a year ago, which is
 * what this module is for.
 *
 * Verified against production (2026-08-09): on each of the five affected days
 * the ledger carries EXACTLY ONE row at that amount, where `genesisBank.ts`
 * carries two. Nothing about that is ambiguous.
 *
 * ── TWO INDEPENDENT SOURCES SAY $55.00 ──────────────────────────────────────
 * The six sum to exactly $55.00, and the owner's hand-typed Relay balance
 * ($56.93) sits exactly $55.00 below what the ledger implies. Two figures
 * arrived at from different directions agreeing to the cent is the strongest
 * evidence available on a rail with no API, and it is why this restore proceeds
 * on an amount assertion rather than a judgement call.
 *
 * And they are ordinary on their face: two NYC Parks permits bought in one
 * sitting (each with its own 50¢ service fee) and four repeat subway fares. A
 * person buying two permits at once and riding the subway twice in a day is not
 * a data-entry anomaly — it is what the day looked like.
 *
 * BOOK VALUE FALLS $55.00. That is the correct direction: these are real
 * expenses the books were missing.
 *
 * ── ONE HAZARD THIS DELIBERATELY DOES NOT SOLVE ─────────────────────────────
 * These six go back under their `genesis-bank:*` keys, because that is what
 * they were and a row that reads as a new manual entry would be a worse record
 * than one that reads as itself. But the importer fix means a FULL RE-IMPORT of
 * the old Relay statements would now insert the second copies too, as
 * `…#1` — and the importer dedups on `externalId` and an FC overlap only, so it
 * would not see these genesis rows and would land a third copy of each charge.
 *
 * That is a live hazard rather than a theoretical one, and the mitigation is
 * knowledge rather than code: Relay is a CLOSED rail (the org banks on Increase
 * now — the 2026-08-07 money landed there), so re-importing a 2025 Relay
 * statement is a deliberate ops action, not something that happens on its own.
 * Anyone about to take it should delete these six first, or expect duplicates.
 * Teaching `applyRelayImport` to also match genesis rows was considered and
 * rejected: it would put a fuzzy amount/date heuristic back into the importer,
 * which is the same class of reasoning that deleted this money in the first
 * place.
 */
import type { GenesisRestoreRow } from "./types";

/**
 * The six rows to put back, each named by its index in `GENESIS_BANK_ROWS` —
 * which is also the `<n>` in its `genesis-bank:<n>` key.
 *
 * `expect` restates the source row's own values so the runner can prove it is
 * restoring the row this file is talking about. `GENESIS_BANK_ROWS` is a
 * position-keyed list: inserting a row into it would silently renumber every
 * `genesis-bank:*` key after the insertion point, and this correction would then
 * write a DIFFERENT charge under the right-looking id. The assertion turns that
 * into a refusal instead of a wrong row.
 *
 * `collidedExternalId` names the single surviving ledger row that both copies
 * were folded onto — the one the dedupe pass double-counted. The runner requires
 * it to still be present and to be the ONLY row at that amount on that day, so a
 * ledger that has moved on since this was written stops the run rather than
 * being written into blind.
 */
export const GENESIS_RESTORE_ROWS: GenesisRestoreRow[] = [
  {
    bankIndex: 4,
    expect: { date: "Jul 15, 2025", description: "PARKS SPECEVNTPRMT SVCF", amountCents: -50 },
    twinBankIndex: 2,
    collidedExternalId: "relay_csv:1752595200000:50:1e44il8",
    why: "The 50¢ service fee on the second of two NYC Parks permits bought that day — one fee per permit.",
  },
  {
    bankIndex: 5,
    expect: { date: "Jul 15, 2025", description: "NYC PARKS SPEC EVNT PRM", amountCents: -2500 },
    twinBankIndex: 3,
    collidedExternalId: "relay_csv:1752595200000:2500:s2jczo",
    why: "The second $25 NYC Parks special-event permit of 2025-07-15, on Idara's card. Two permits, bought together.",
  },
  {
    bankIndex: 108,
    expect: { date: "Feb 1, 2026", description: "MTA eTix", amountCents: -2050 },
    twinBankIndex: 107,
    collidedExternalId: "relay_csv:1769961600000:2050:1rxc43o",
    why: "A second $20.50 MTA eTix purchase on AJ's card, same day — two tickets bought in one trip.",
  },
  {
    bankIndex: 117,
    expect: { date: "Feb 7, 2026", description: "MTA", amountCents: -300 },
    twinBankIndex: 115,
    collidedExternalId: "relay_csv:1770480000000:300:w857ul",
    why: "The return leg: a second $3.00 subway fare on Michael's card on 2026-02-07.",
  },
  {
    bankIndex: 139,
    expect: { date: "Mar 15, 2026", description: "MTA", amountCents: -300 },
    twinBankIndex: 138,
    collidedExternalId: "relay_csv:1773590400000:300:w857ul",
    why: "The return leg: a second $3.00 subway fare on Michael's card on 2026-03-15.",
  },
  {
    bankIndex: 161,
    expect: { date: "Apr 12, 2026", description: "MTA", amountCents: -300 },
    twinBankIndex: 160,
    collidedExternalId: "relay_csv:1776009600000:300:w857ul",
    why: "The return leg: a second $3.00 subway fare on Michael's card on 2026-04-12.",
  },
];

/**
 * What restoring all six moves book value by, in signed cents — NEGATIVE, they
 * are expenses. The runner refuses to write unless the six rows it resolved from
 * `GENESIS_BANK_ROWS` add up to exactly this, so a renumbered source list or a
 * mistyped amount here cannot quietly restore a different $55.
 *
 * It is also the number the owner's Relay balance independently predicts, which
 * is why it is asserted as an exact identity and not a tolerance.
 */
export const EXPECTED_RESTORE_CENTS = -5500;

/** The sentence appended to each restored row's original note, so the ledger
 *  itself says why a year-old row has today's `createdAt`. */
export const RESTORE_NOTE_SUFFIX =
  "Restored 2026-08-09 after being deleted in error as a duplicate — the bank " +
  "history shows TWO identical charges that day and the ledger only ever held " +
  "one, because the Relay CSV importer's dedup key could not tell two genuinely " +
  "distinct same-day, same-amount, same-card charges apart.";
