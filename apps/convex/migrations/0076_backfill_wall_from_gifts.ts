import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";

/**
 * Give the public giving wall its history, so the feed is a feed on the day it
 * ships rather than an empty box under a live total.
 *
 * ── WHY THERE IS ANYTHING TO BACKFILL ───────────────────────────────────────
 * `givingActivity` was an OPT-IN echo: `recordPendingActivity` wrote a row only
 * when the giver ticked "show my name" AND typed a name or a message, and only
 * for a gift scoped to a chapter — a `"central"` gift had nowhere to go,
 * because the column could not hold the scope. So the table holds a thin
 * highlight reel of the most extroverted fraction of a fraction of the org's
 * giving.
 *
 * give-redesign-v3 (D6) inverts that: every gift through the give checkout
 * gets a row, anonymous
 * by default, and consent gates only whether the row carries a name. The
 * sibling change makes that true going forward. Without this, the page shipping
 * would open showing a handful of rows from whenever someone last filled in
 * the optional box, beneath a live total counting every gift the org has ever
 * received — a feed that visibly fails to explain its own number.
 *
 * ── EVERY ROW IT WRITES IS ANONYMOUS, AND THAT IS NOT AN OMISSION ───────────
 * A historical gift carries no answer to "may we name you on a public page",
 * so the only honest answer is no. `consent` and `consentIndexable` are left
 * ABSENT rather than written `false`, which is the same thing under this
 * table's "absent is a NO" rule (`schema/givingActivity.ts#consent`) and reads
 * more truthfully: nobody was asked. No `displayName`, no `message` — there is
 * no self-provided public handle on a `gifts` row to copy, and the donor's CRM
 * name is exactly the thing this table must never contain.
 *
 * ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────
 * It moves NO money and touches NO rollup. `getPublicWall`'s totals come from
 * `givingScopeRollups` (D8), never from these rows, so a wall row is pure
 * display and a missed or duplicated one cannot make a number wrong.
 *
 * ── THE refKey IS A HANDLE, NOT A NAME ──────────────────────────────────────
 * A backfilled row is keyed `gift.externalRef` whenever the gift has one, and
 * only falls back to `gift:<giftId>` when it doesn't. That is not cosmetic.
 * `refKey` is the ONLY way anything ever finds a wall row again: every
 * take-down path looks the row up by the key it can reconstruct from the
 * payment, and for a Stripe gift that key is `give:<checkout session>` —
 * `gifts.externalRef` exactly:
 *  - `givingReversals.ts` (a dispute/ACH return that reversed the money) calls
 *    `withdrawActivity({ refKey: "give:" + sessionId })`;
 *  - `givingComms.ts#onAchFailed` (the bank refused the debit) does the same.
 * Key these rows `gift:<giftId>` and both of those lookups miss for ever: the
 * money goes back, `givingScopeRollups` drops, and the wall keeps publishing
 * "A gift to New York — $250" underneath a total that no longer contains it.
 * The table's stated invariant — an entry means a real, settled payment
 * (`schema/givingActivity.ts`) — would be false, and nothing would ever notice.
 * So the rule is: carry the SAME key the live paths already reach for, and use
 * a synthetic one only where there is no such key to carry.
 *
 * (A gift whose `externalRef` came from an import rather than Checkout — a
 * Givebutter transaction id — is keyed on that id. No take-down path names it
 * today, but it is still that gift's one external identity, and using it keeps
 * this migration's rule a single sentence rather than a special case. What is
 * NOT covered by any key: deleting a gift at the giving desk
 * (`givingPlatform.ts#deleteGift`) withdraws nothing from the wall at all, for
 * live and backfilled rows alike — a real gap, and a separate fix.)
 *
 * ── IDEMPOTENCY ─────────────────────────────────────────────────────────────
 * Keyed on `refKey`, checked against `by_refKey` before every insert, exactly
 * like the live write path. Two keys can point at one gift and both are
 * checked:
 *  - the LIVE key, `gifts.externalRef` (`give:<stripe session>`), which is the
 *    same string `recordPendingActivity` used — so a gift that already has a
 *    real wall row (with its giver's name and consent on it) is skipped, never
 *    shadowed by an anonymous duplicate. It is also the key this migration now
 *    WRITES, so that check is both the "already echoed?" test and this row's
 *    own uniqueness test;
 *  - the legacy `gift:<giftId>` key, which is what an earlier cut of this
 *    migration wrote — so a re-run against a deployment that took that version
 *    re-finds its own rows instead of doubling them.
 * The migration ledger stops a second run; these checks are what make a re-run
 * harmless anyway.
 *
 * ── WHY A RECENT WINDOW RATHER THAN ALL OF HISTORY ──────────────────────────
 * The wall is a FEED, hard-capped at `PUBLIC_WALL_MAX_LIMIT` (30) rows per
 * read, with no pagination — nothing can ever page past the window this
 * writes. Echoing every gift the org has ever received would write thousands of
 * rows that no reader can reach, in one mutation, to no effect on any number on
 * the page. So it takes the most recent `BACKFILL_WINDOW` gifts by
 * `receivedAt` (the whole ledger, at the org's current size) and stops.
 *
 * They are inserted OLDEST FIRST on purpose: the per-city feed reads
 * `by_scope_and_status`, whose implicit tiebreak is `_creationTime`, so
 * inserting in settle order keeps creation order agreeing with settle order
 * for these rows rather than exactly reversing it. (`getPublicWall` re-sorts on
 * `settledAt` regardless — this just means the sort has nothing to fix, and
 * that a reader of the raw table isn't looking at history upside down.)
 */

/**
 * How many of the most recent gifts get a wall row. Generous next to the
 * 30-row read cap and to the org's whole gift history; bounded so this can
 * never be the mutation that trips a transaction limit on a deploy.
 */
const BACKFILL_WINDOW = 500;

export async function runBackfillWallFromGifts(ctx: MutationCtx): Promise<{
  inserted: number;
  skippedExisting: number;
  scanned: number;
}> {
  // Newest-first off `by_received`, then flipped — see the header's note on
  // insert order.
  const recent = await ctx.db
    .query("gifts")
    .withIndex("by_received")
    .order("desc")
    .take(BACKFILL_WINDOW);
  const oldestFirst = [...recent].reverse();

  let inserted = 0;
  let skippedExisting = 0;

  for (const gift of oldestFirst) {
    // The gift's own external identity when it has one — the string the
    // reversal paths will hand to `withdrawActivity` if this money ever goes
    // back. See the header: the key is how the row is found again, so a
    // synthetic one is a last resort, not a default.
    const refKey = gift.externalRef ?? `gift:${gift._id}`;
    // The live path's key first: if this gift already produced a wall entry at
    // checkout time, that row is the better record (it may carry a consented
    // name) and must not be duplicated anonymously beside itself. Since that
    // key is now also the key this migration writes, the same read doubles as
    // the uniqueness check for the insert below.
    const existing = await ctx.db
      .query("givingActivity")
      .withIndex("by_refKey", (q) => q.eq("refKey", refKey))
      .unique();
    if (existing) {
      skippedExisting += 1;
      continue;
    }

    // The key an earlier cut of this migration used. Checked whenever it
    // differs from the key above, so a re-run after that version shipped
    // re-finds its own rows rather than writing a second, differently-keyed
    // echo of the same gift.
    const legacyRefKey = `gift:${gift._id}`;
    if (legacyRefKey !== refKey) {
      const legacy = await ctx.db
        .query("givingActivity")
        .withIndex("by_refKey", (q) => q.eq("refKey", legacyRefKey))
        .unique();
      if (legacy) {
        skippedExisting += 1;
        continue;
      }
    }

    await ctx.db.insert("givingActivity", {
      scope: gift.scope,
      // A gift's scope is the only thing history can tell us about what it
      // was. `"fundraiser"` is deliberately NOT inferred from `gift.eventId`:
      // an attached event id means the gift was ATTRIBUTED to an event, which
      // is not the same as having been given against a published money goal,
      // and a goal card that turns out to be wrong is worse than none.
      kind: gift.scope === "central" ? "central" : "gift",
      amountCents: gift.amountCents,
      status: "visible",
      refKey,
      // A gift row means the money arrived; `receivedAt` is when. Both fields
      // get it so the row cannot claim to have been created after it settled.
      createdAt: gift.receivedAt,
      settledAt: gift.receivedAt,
      // No consent, no attribution — see the header. Absent, not `false`.
    });
    inserted += 1;
  }

  console.log(
    `[0076] scanned ${oldestFirst.length} recent gifts: inserted ${inserted} ` +
      `anonymous wall rows, skipped ${skippedExisting} already echoed`,
  );
  return {
    inserted,
    skippedExisting,
    scanned: oldestFirst.length,
  };
}

export const backfillWallFromGifts: Migration = {
  name: "0076_backfill_wall_from_gifts",
  run: runBackfillWallFromGifts,
};
