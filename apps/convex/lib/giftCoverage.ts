/**
 * HOW MUCH OF A BANK DEPOSIT IS ALREADY COUNTED AS GIVING.
 *
 * Revenue is counted at the giving layer, so a donation that arrives as a
 * direct bank credit (a wire, a Zelle, an ACH pull) exists twice: once as the
 * `gifts` row the development desk recorded, and once as the plain inflow the
 * bank sync wrote. `gifts.transactionId` is the human-confirmed statement that
 * the second IS the first, and every book-value surface has to subtract it or
 * the dollar counts twice.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 * Four places asked that question and answered it four ways: the org-wide gap
 * panel, `accountBalances`, `bookValueBreakdown`, and the public statement
 * builder. Three of them read a scope's own gifts and so could not see a link
 * from another book; all four zeroed the WHOLE credit the moment any gift
 * pointed at it. That was safe only because linking demanded the gift and the
 * credit be the same amount to the cent.
 *
 * That rule is what this replaces. One wire is routinely several gifts —
 * a founder sends $7,000 that is $5,000 for central and $2,000 for New York —
 * and under exact-match-or-nothing there was no way to say so: neither gift
 * equalled the deposit, and a deposit could hold only one gift anyway. So the
 * deposit stayed unlinked and the money stayed counted twice, which is the
 * state that published New York's March as $9,050 of income against a real
 * $2,050.
 *
 * ── THE MODEL ───────────────────────────────────────────────────────────────
 * A deposit is covered by the SUM of the gifts that point at it, and it
 * contributes only the part nobody has claimed:
 *
 *     contribution = signedBookCents(tr) − Σ(linked gifts)
 *
 * Fully covered → zero, exactly as before. Partly covered → the remainder
 * still shows, which is the honest reading: that part of the deposit is money
 * this book received and has not explained. Nothing ever goes negative,
 * because `linkGiftToTransaction` refuses a link that would over-cover.
 *
 * Gifts are gathered through `gifts.by_transaction`, which is scope-blind on
 * purpose: the $5,000 above is CENTRAL's revenue sitting in New York's bank
 * account, and a query over New York's own gifts can never find it. Reading
 * per-transaction also beats gathering a period's gifts by date — a wire
 * received on the 31st can post on the 1st, and the link, not the calendar, is
 * what makes it the same money.
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { signedBookCents } from "./bookBalance";

/**
 * Ceiling on gifts read per deposit. A deposit split across a handful of books
 * is the real case; anything near this is a data problem, and taking a bounded
 * page keeps the read cost of a big ledger scan predictable.
 */
export const GIFTS_PER_TRANSACTION_LIMIT = 32;

/** Every gift that claims this bank row as its arrival, in ANY book. */
export async function giftsCoveringTransaction(
  ctx: QueryCtx,
  transactionId: Id<"transactions">,
): Promise<Doc<"gifts">[]> {
  return await ctx.db
    .query("gifts")
    .withIndex("by_transaction", (q) => q.eq("transactionId", transactionId))
    .take(GIFTS_PER_TRANSACTION_LIMIT);
}

/** Cents of this bank row already counted as giving, in any book. */
export async function giftCoverageCents(
  ctx: QueryCtx,
  transactionId: Id<"transactions">,
): Promise<number> {
  const gifts = await giftsCoveringTransaction(ctx, transactionId);
  return gifts.reduce((sum, g) => sum + g.amountCents, 0);
}

/**
 * Coverage for a batch of ledger rows, keyed by transaction id. Only inflows
 * are looked up — a link may only ever be written against a credit, so an
 * outflow's coverage is zero without asking the database.
 */
export async function giftCoverageByTransaction(
  ctx: QueryCtx,
  txns: Doc<"transactions">[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const tr of txns) {
    if (tr.flow !== "inflow") continue;
    const covered = await giftCoverageCents(ctx, tr._id);
    if (covered > 0) out.set(tr._id as string, covered);
  }
  return out;
}

/**
 * What this ledger row contributes to its book's value once the giving layer
 * has taken its share. Clamped at zero from whichever side the row sits on, so
 * a stale over-link can never flip a credit into a debit.
 */
export function coveredSignedBookCents(
  tr: Doc<"transactions">,
  coveredCents: number,
): number {
  const signed = signedBookCents(tr);
  if (coveredCents <= 0 || signed <= 0) return signed;
  return Math.max(0, signed - coveredCents);
}

/** How this row reads to a human once coverage is applied. */
export type GiftCoverageState = "none" | "partial" | "full";

export function giftCoverageState(
  tr: Doc<"transactions">,
  coveredCents: number,
): GiftCoverageState {
  if (coveredCents <= 0) return "none";
  return coveredSignedBookCents(tr, coveredCents) === 0 ? "full" : "partial";
}
