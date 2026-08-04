import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";

/**
 * Split legacy (Relay) card rows that `issueCard` wrongly fused with a real
 * Increase card.
 *
 * WHY. `beginIssueCard`'s duplicate-prevention used to match ANY active card
 * for the holder — including a `source:"legacy"` Relay row linked by
 * `legacyCards.linkRelayCard`. A Relay row has no `increaseCardId`, so it also
 * satisfied the vendor-retry branch (meant for a previously-DEGRADED Increase
 * row): issuance minted a real Increase card and `finishIssueCard` patched the
 * vendor id + Increase last-4 ONTO THE RELAY ROW. Result: the new card existed
 * at Increase but never appeared in the app (the UI renders a `source:"legacy"`
 * row as Relay-only — no card art, no controls), and the row's Relay last-4 —
 * the key that attributes `stripe_fc`/`relay_csv` bank-feed transactions to a
 * person — was overwritten. The dedup is fixed (increase-source only); this is
 * the one-time repair for rows the bug already fused.
 *
 * WHAT. For every card with `source:"legacy"` AND an `increaseCardId`:
 *  1. The row KEEPS its Increase identity — vendor id, Increase last-4, status,
 *     cap/validity, and everything hanging off its `_id` (`cardAuthorizations`,
 *     `increase_card` transactions, webhook routing via `by_increase_card`) —
 *     and its `source` flips to `"increase"`, so the app finally shows it.
 *  2. Its Relay linkage is re-created as a FRESH `source:"legacy"` row. The
 *     original Relay last-4 is recovered from the row's own attributed
 *     bank-feed transactions (`stripe_fc`/`relay_csv` rows carry `cardLast4`,
 *     stamped by `linkRelayCard`'s `by_chapter_and_last4` match — the most
 *     frequent value wins, guarding against a stray hand-edited row); those
 *     transactions are re-pointed to the new legacy row (`personId` already
 *     names the same holder, so it stays).
 *  3. A fused row with NO attributed bank-feed transactions has nothing to
 *     preserve — no legacy row is created (counted in `relayLast4Unrecovered`);
 *     `listRelayCardCandidates` will re-surface the last-4 for re-linking if
 *     its transactions ever arrive.
 *
 * IDEMPOTENT: a repaired row is `source:"increase"` and never matches again;
 * the created legacy rows carry no `increaseCardId` so they never match either.
 *
 * BOUNDS: `cards` is a small table (same CARD_SCAN cap as `cards.ts` reads);
 * per-card transactions use the same cap as `legacyCards.ts`'s attribution.
 */
const CARD_SCAN_LIMIT = 2000;
const TXN_SCAN_LIMIT = 5000;
/** The bank-feed sources whose rows carry a Relay-parsed `cardLast4`. */
const RELAY_TXN_SOURCES = new Set(["stripe_fc", "relay_csv"]);

export type SplitLegacyIncreaseCardsResult = {
  /** Fused rows found (legacy source + an Increase card id). */
  repaired: number;
  /** Fresh legacy rows minted to carry the recovered Relay linkage. */
  relayRowsCreated: number;
  /** Bank-feed transactions re-pointed onto the fresh legacy rows. */
  txnsRepointed: number;
  /** Fused rows with no attributed bank-feed txns — no Relay last-4 to
   *  recover, so no legacy row was created. */
  relayLast4Unrecovered: number;
};

export async function runSplitLegacyIncreaseCards(
  ctx: MutationCtx,
): Promise<SplitLegacyIncreaseCardsResult> {
  const cards = await ctx.db.query("cards").take(CARD_SCAN_LIMIT);
  const result: SplitLegacyIncreaseCardsResult = {
    repaired: 0,
    relayRowsCreated: 0,
    txnsRepointed: 0,
    relayLast4Unrecovered: 0,
  };

  for (const card of cards) {
    if (card.source !== "legacy" || !card.increaseCardId) continue;
    result.repaired++;

    const txns = await ctx.db
      .query("transactions")
      .withIndex("by_card", (q) => q.eq("cardId", card._id))
      .take(TXN_SCAN_LIMIT);
    const relayTxns = txns.filter(
      (t) => RELAY_TXN_SOURCES.has(t.source) && t.cardLast4,
    );

    // Recover the original Relay last-4: the most frequent `cardLast4` among
    // the attributed bank-feed rows (they were matched BY that last-4, so in
    // practice there's exactly one distinct value).
    const counts = new Map<string, number>();
    for (const t of relayTxns) {
      counts.set(t.cardLast4!, (counts.get(t.cardLast4!) ?? 0) + 1);
    }
    let relayLast4: string | null = null;
    let best = 0;
    for (const [last4, n] of counts) {
      if (n > best) {
        relayLast4 = last4;
        best = n;
      }
    }

    if (relayLast4) {
      // Mirror `linkRelayCard`'s insert; keep the original `createdAt` (this
      // row IS the original linkage, re-materialized).
      const legacyId = await ctx.db.insert("cards", {
        chapterId: card.chapterId,
        cardholderPersonId: card.cardholderPersonId,
        type: "physical",
        source: "legacy",
        last4: relayLast4,
        status: "active",
        createdAt: card.createdAt,
      });
      result.relayRowsCreated++;
      for (const t of relayTxns) {
        await ctx.db.patch(t._id, { cardId: legacyId });
        result.txnsRepointed++;
      }
    } else {
      result.relayLast4Unrecovered++;
    }

    await ctx.db.patch(card._id, { source: "increase" });
  }

  return result;
}

export const splitLegacyIncreaseCards: Migration = {
  name: "0059_split_legacy_increase_cards",
  run: runSplitLegacyIncreaseCards,
};
