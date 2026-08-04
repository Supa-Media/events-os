import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";

/**
 * Relabel the `type` on cards repaired by 0059 from `"physical"` to
 * `"virtual"`.
 *
 * WHY. A row fused by the pre-#489 `issueCard` dedup bug began life as a Relay
 * link, and `legacyCards.linkRelayCard` stamps every Relay link
 * `type:"physical"` (a Relay card is a physical card). The buggy vendor-retry
 * reuse dropped the type the manager picked at issuance, and 0059's repair
 * deliberately preserved the row — so the repaired Increase card still shows
 * "Physical" even though the issuance flow only ever creates a virtual card
 * at Increase (no physical-card order is placed). The dropped-args hole is
 * plugged in `beginIssueCard`'s retry branch in this same change; this is the
 * one-time relabel for rows 0059 already produced.
 *
 * SCOPE — ONLY rows provably shaped by the 0059 split. Increase does support
 * physical cards, and the issue form lets a manager record `type:"physical"`
 * deliberately, so a blanket "vendor id + physical → virtual" would clobber
 * intent. The fingerprint: an increase-source row with an `increaseCardId`
 * and `type:"physical"` whose cardholder ALSO has a `source:"legacy"` row in
 * the same chapter with the IDENTICAL `createdAt` — 0059 copied the fused
 * row's `createdAt` onto the legacy row it split out, so the
 * millisecond-exact match identifies the pair (an independently linked Relay
 * card virtually never shares the exact insert timestamp). Anything else —
 * a deliberate physical-type card, or a 0059 row whose Relay last-4 was
 * unrecoverable (no sibling was created) — is left untouched and counted in
 * `physicalVendorRowsKept` for a human to eyeball in the deploy log.
 *
 * IDEMPOTENT: a relabeled row is `type:"virtual"` and never matches again.
 */
const CARD_SCAN_LIMIT = 2000;

export type FixRepairedCardTypesResult = {
  /** Fused-then-repaired rows relabeled physical → virtual. */
  relabeled: number;
  /** Vendor-linked physical rows left alone (no 0059 sibling — deliberate
   *  physical cards, or unrecovered-Relay repairs). */
  physicalVendorRowsKept: number;
};

export async function runFixRepairedCardTypes(
  ctx: MutationCtx,
): Promise<FixRepairedCardTypesResult> {
  const cards = await ctx.db.query("cards").take(CARD_SCAN_LIMIT);
  const result: FixRepairedCardTypesResult = {
    relabeled: 0,
    physicalVendorRowsKept: 0,
  };

  for (const card of cards) {
    if ((card.source ?? "increase") !== "increase") continue;
    if (!card.increaseCardId || card.type !== "physical") continue;

    const sibling = cards.find(
      (c) =>
        c._id !== card._id &&
        c.source === "legacy" &&
        !c.increaseCardId &&
        c.chapterId === card.chapterId &&
        c.cardholderPersonId === card.cardholderPersonId &&
        c.createdAt === card.createdAt,
    );
    if (!sibling) {
      result.physicalVendorRowsKept++;
      continue;
    }

    await ctx.db.patch(card._id, { type: "virtual" });
    result.relabeled++;
  }

  return result;
}

export const fixRepairedCardTypes: Migration = {
  name: "0060_fix_repaired_card_types",
  run: runFixRepairedCardTypes,
};
