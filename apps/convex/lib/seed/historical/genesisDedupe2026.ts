/**
 * Genesis duplicate removal (2026-08-06). Private repo.
 *
 * THE BUG. The 2026 bank import (`financeGenesisBackfill.ts`) deduped each of its 213
 * rows against the ledger AS IT STOOD AT THAT MOMENT — exact amount, same flow,
 * postedAt within ±2 days. That correctly skipped 201 rows the Relay/Stripe feed had
 * already ingested. The other 12 were charges the feed had NOT yet ingested, so they
 * inserted cleanly; when the feed caught up days later it inserted them a second time.
 * A one-time import racing a live feed, with the dedup only ever evaluated at insert.
 *
 * HOW WE KNOW they are duplicates and not coincidences:
 *   - 12 of 12 surviving `genesis-bank:*` rows have a same-amount, same-flow twin
 *     within two days. Not one stands alone. Real distinct charges would leave some.
 *   - Every import copy has NO `cardId` (Kansi's CSV carried no card data) while every
 *     twin names a cardholder. That asymmetry is the import's fingerprint.
 *   - The import copies carry generic merchant words ("Doordash", "MTA", "Fiverr");
 *     the twins carry what the bank actually reported.
 *
 * RECEIPTS MOVE, THEY DO NOT DIE. Five import copies have real documents attached
 * (two Chick-fil-A receipts among them). The runner RE-LINKS each to the surviving
 * twin before deleting, so a document that proves a real charge is never orphaned by a
 * cleanup. This is the whole reason deletion goes through a migration rather than the
 * dashboard.
 *
 * WRONG BOOK, TOO. Five copies sit on New York only because the import hardcoded every
 * row to New York; the real charge belongs to Central. Today that reads as New York
 * having fronted $679.25 for Central, which inflates the inter-scope settlement.
 * Deleting the copies removes the phantom receivable.
 *
 * DELIBERATELY NOT TOUCHED — the giving-side `genesis:truist:1` / `genesis:truist:2`
 * pair. Both are $500 on 2025-09-19 from the same donor and the source dataset labels
 * them "(1 of 2)" and "(2 of 2)", so the curator meant two transfers. But Relay shows
 * only ONE $500 ACH Pull that day (plus a separate $1,000 on 09-17). One of those
 * facts is wrong and the evidence doesn't say which, so the gifts stay as they are and
 * the question goes to the owner. Deleting the duplicate TRANSACTION is safe
 * regardless — no gift is linked to it by `transactionId`.
 */
import type { DedupePair, DedupeDeletion, DedupePatch } from "./types";

/**
 * The 12 duplicated rows. `keepExternalId` names the surviving twin so the runner can
 * move receipts onto it and assert the pair still matches before deleting anything —
 * it never deletes on the strength of this file alone.
 */
export const DEDUPE_PAIRS: DedupePair[] = [
  { deleteExternalId: "genesis-bank:4",   keepExternalId: "relay_csv:1752595200000:50:1e44il8",      amountCents: 50,    note: "PARKS SPECEVNTPRMT SVCF vs Idara's card" },
  { deleteExternalId: "genesis-bank:5",   keepExternalId: "relay_csv:1752595200000:2500:s2jczo",     amountCents: 2500,  note: "NYC PARKS SPEC EVNT PRM vs Idara's card" },
  { deleteExternalId: "genesis-bank:42",  keepExternalId: "relay_csv:1758297600000:50000:1lqylss",   amountCents: 50000, note: "TRUIST COMMUNITY CHECKING vs Relay's own 'ACH Pull' label — one deposit, two descriptions" },
  { deleteExternalId: "genesis-bank:104", keepExternalId: "relay_csv:1769616000000:21733:127qnx8",   amountCents: 21733, note: "Fiverr vs AJ's card (Central)" },
  { deleteExternalId: "genesis-bank:108", keepExternalId: "relay_csv:1769961600000:2050:1rxc43o",    amountCents: 2050,  note: "MTA eTix vs AJ's card" },
  { deleteExternalId: "genesis-bank:117", keepExternalId: "relay_csv:1770480000000:300:w857ul",      amountCents: 300,   note: "MTA vs Michael's card, 2026-02-07" },
  { deleteExternalId: "genesis-bank:139", keepExternalId: "relay_csv:1773590400000:300:w857ul",      amountCents: 300,   note: "MTA vs Michael's card, 2026-03-15" },
  { deleteExternalId: "genesis-bank:140", keepExternalId: "relay_csv:1773590400000:13074:nsbsr2",    amountCents: 13074, note: "Doordash vs Sayo's card (Central)" },
  { deleteExternalId: "genesis-bank:143", keepExternalId: "relay_csv:1774195200000:8085:zpz1l9",     amountCents: 8085,  note: "Doordash vs Seyi's PW card (Central)" },
  { deleteExternalId: "genesis-bank:161", keepExternalId: "relay_csv:1776009600000:300:w857ul",      amountCents: 300,   note: "MTA vs Michael's card, 2026-04-12" },
  { deleteExternalId: "genesis-bank:180", keepExternalId: "stripe_fc:fctxn_1TtY3eQv9S5xW6eKMQ01AZCN", amountCents: 15886, note: "Doordash vs DD*DOORDASH CHICK-FIL (Central)" },
  { deleteExternalId: "genesis-bank:187", keepExternalId: "stripe_fc:fctxn_1TtY3eQv9S5xW6eKFpnGKcKD", amountCents: 9147,  note: "Doordash vs DD*DOORDASH CHICK-FIL (Central)" },
];

/**
 * Rows the owner asked to remove outright, WITH their mirrored gift. Both legs go
 * together — same rule as every other correction in this cleanup: a gift with no
 * expense behind it would leave the giving ledger claiming money the books don't show.
 */
export const DEDUPE_DELETIONS: DedupeDeletion[] = [
  {
    externalId: "genesis-inkind-exp:don24:layomi-food",
    giftRef: "genesis:don24:layomi-food",
    amountCents: 44530,
    reason:
      "Owner decision 2026-08-06: not a real expense. Removed with Layomi's matching " +
      "$445.30 gift so both ledgers move together.",
  },
  {
    externalId: "genesis-inkind-exp:buy25:13",
    giftRef: "genesis:buy25:13",
    amountCents: 8954,
    reason:
      "Uber from Perspective Saints, recorded as the owner's in-kind gift — but Layomi " +
      "bought that leg, so it was never his to give. Owner decision 2026-08-06: remove. " +
      "If Layomi supplies the receipt it can be re-recorded as hers.",
  },
];

/**
 * Amount corrections measured against a document, applied to the expense AND its
 * mirrored gift so the two legs stay equal.
 */
export const DEDUPE_PATCHES: DedupePatch[] = [
  {
    externalId: "genesis-inkind-exp:don25:layomi-lens2",
    giftRef: "genesis:don25:layomi-lens2",
    amountCents: 3520,
    description: "Camera lens rental — ShareGrid #1328194, Sony Zeiss 24-70mm f/4 ZA OSS",
    reason:
      "ShareGrid rental #1328194 (Mar 29–30) totals $35.20, not $74.59. The $39.39 " +
      "difference was an unevidenced '+ Transport' bundled into the row; no document " +
      "supports it, so it comes off rather than being carried as lens cost.",
    receiptFile: "Screenshot 2026-08-06 at 9.52.39 PM.png",
  },
  {
    // Amount already correct to the cent; this row is here only for its document.
    externalId: "genesis-inkind-exp:don25:layomi-lens1",
    amountCents: 9987,
    reason: "ShareGrid rental #1325060 (Mar 22–23), Sony FE 24-70mm f/2.8 GM II — $99.87, already exact.",
    receiptFile: "Screenshot 2026-08-06 at 9.52.49 PM.png",
  },
];
