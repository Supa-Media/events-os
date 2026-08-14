/**
 * PAY-BACK LINKS — settling a personal charge without signing in.
 *
 * Founder, 2026-08-14: "these might be past team members even. So it should
 * literally just be a rendered page where I could just copy a link, where they
 * can see the charge they're being charged for and go to the Stripe checkout.
 * Similar to our giving page, except it has the details for how much they need
 * to pay back. And that way, if I wanted to pay on behalf of someone, I could
 * do that as well."
 *
 * The in-app repayments page assumes the payer has an account and will log
 * into it. That assumption fails on exactly the person most likely to owe
 * money and least likely to log in: someone who left the team in March. This
 * file is the giving page's model applied to a debt — a token in a URL, a page
 * anyone holding it can open, Stripe Checkout at the end, and settlement
 * through the SAME webhook every other rail already uses.
 *
 * ── THREE THINGS THIS FILE IS CAREFUL ABOUT ─────────────────────────────────
 *
 * 1. IT NAMES NOBODY. The public read returns amounts, dates and a chapter
 *    name — never the payer's name, never the merchant, never who sent the
 *    link (founder: "we don't need to put, like, 'hey Michael, you have these
 *    charges'"). A link that ends up in a group chat leaks some amounts, not
 *    an identity. An amount and a date is enough for the payer to recognise
 *    their own charge.
 *
 * 2. THE TOKEN IS THE ONLY AUTHORITY, AND IT AUTHORIZES EXACTLY ONE THING:
 *    paying these charges. It cannot read a ledger, cannot list other people,
 *    cannot un-flag anything, and cannot be used to pay a charge belonging to
 *    anyone but its own person — every id the client submits is re-checked
 *    against the token's `payerPersonId` server-side. The client supplies
 *    which charges to settle; it never supplies an amount.
 *
 * 3. SETTLEMENT IS NOT REIMPLEMENTED. The checkout it starts is the same
 *    bundled Stripe session the authed page starts, carrying the same
 *    `repaymentIds` metadata, settled by the same `applyRepaymentPaidFromStripe`
 *    with the same idempotency and the same fee-coverage reconciliation. A
 *    second settlement path is how the two would drift, and this is money.
 *
 * "Paying on behalf of someone" needs no feature of its own: a manager opens
 * the same link and pays it.
 */
import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { requireChapterId } from "./lib/context";
import { resolveCallerPersonId } from "./lib/finance";
import { requireRepaymentsCollect } from "./lib/repaymentsAccess";
import {
  repaymentRailQuote,
  repaymentRailQuotes,
  stripePaymentMethodTypes,
} from "./lib/repaymentFees";
import { appUrl } from "./lib/siteUrl";

/** Bounds one person's charges on the public page (they are few by nature —
 *  mirrors `cards.ts#MY_REPAYMENTS_LIMIT`). */
const LINK_CHARGE_LIMIT = 500;

/** The public path a token resolves to. One definition, used by the mint
 *  mutation's returned URL and by the checkout's return URLs, so the three can
 *  never point at different pages. */
export function repaymentLinkPath(token: string): string {
  return `/pay/${token}`;
}

// ── Minting (manager, authed) ────────────────────────────────────────────────

/**
 * Get this person's pay-back link, creating it on first use.
 *
 * IDEMPOTENT PER PERSON, deliberately: a manager who presses "Copy pay link"
 * twice must get the same URL both times. Minting a fresh token on every press
 * would silently invalidate the one they texted five minutes ago — a link that
 * stops working for the recipient with no way for either of them to know why.
 * A revoked link is the one case that mints a new token, because that is the
 * point of revoking.
 *
 * Gated by `requireRepaymentsCollect` (finance manager), the same power that
 * sends a reminder: handing out a URL that settles somebody's debt is the same
 * act as emailing them about it.
 */
export const mintLink = mutation({
  args: { payerPersonId: v.id("people") },
  returns: v.object({ token: v.string(), url: v.union(v.string(), v.null()) }),
  handler: async (ctx, { payerPersonId }) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireRepaymentsCollect(ctx, chapterId);

    const person = await ctx.db.get(payerPersonId);
    if (!person || person.chapterId !== chapterId) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "That person isn't on this chapter's roster.",
      });
    }

    const existing = await ctx.db
      .query("repaymentLinks")
      .withIndex("by_person", (q) => q.eq("payerPersonId", payerPersonId))
      .collect();
    const live = existing.find(
      (l) => l.chapterId === chapterId && l.revokedAt == null,
    );
    if (live) return { token: live.token, url: linkUrl(live.token) };

    const token = crypto.randomUUID();
    await ctx.db.insert("repaymentLinks", {
      chapterId,
      payerPersonId,
      token,
      createdByPersonId: await resolveCallerPersonId(ctx, chapterId),
      createdAt: Date.now(),
    });
    return { token, url: linkUrl(token) };
  },
});

/** Kill a link that has gone somewhere it shouldn't. The next mint issues a
 *  fresh token; the old URL renders "no longer active" rather than 404ing, so
 *  whoever is holding it knows to ask rather than assume they're square. */
export const revokeLink = mutation({
  args: { payerPersonId: v.id("people") },
  returns: v.null(),
  handler: async (ctx, { payerPersonId }) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireRepaymentsCollect(ctx, chapterId);
    const links = await ctx.db
      .query("repaymentLinks")
      .withIndex("by_person", (q) => q.eq("payerPersonId", payerPersonId))
      .collect();
    const now = Date.now();
    for (const link of links) {
      if (link.chapterId !== chapterId || link.revokedAt != null) continue;
      await ctx.db.patch(link._id, { revokedAt: now });
    }
    return null;
  },
});

function linkUrl(token: string): string | null {
  const base = appUrl(repaymentLinkPath(token));
  if (!base) {
    // Degrade LOUDLY: a "copied!" toast holding a relative path nobody can
    // open is worse than saying the feature isn't configured. Same rule the
    // flagged-charge email follows.
    console.error(
      "[repaymentLinks] APP_URL is unset — cannot build a shareable pay-back URL",
    );
  }
  return base;
}

// ── The public page (no auth) ────────────────────────────────────────────────

const publicChargeValidator = v.object({
  id: v.id("personalRepayments"),
  amountCents: v.number(),
  /** When the charge posted. With the amount, this is how a payer recognises
   *  their own charge — and it is ALL they are given (see the file header on
   *  why there is no merchant name and no payer name). */
  postedAt: v.number(),
  /** True while a bank transfer for this charge is clearing: shown, not
   *  selectable, so nobody pays the same debt twice during the days a debit
   *  takes to land. */
  clearing: v.boolean(),
});

const publicLinkValidator = v.object({
  /** "New York" — the only proper noun on the page, and it names the ORG's
   *  side of the debt, not the payer. */
  chapterName: v.string(),
  charges: v.array(publicChargeValidator),
  /** What's still owed across every payable charge. */
  totalCents: v.number(),
  /** True once nothing is left — the page says thank you instead of asking
   *  again, which is what a payer returning to an old link should see. */
  settled: v.boolean(),
});

/**
 * Resolve a token to what its page renders. NO AUTH — the token is the
 * authority.
 *
 * Returns `null` for an unknown or revoked token, which the page renders as
 * one indistinguishable "this link isn't active" state: telling the difference
 * between "never existed" and "was revoked" only helps someone probing tokens.
 */
export const publicByToken = query({
  args: { token: v.string() },
  returns: v.union(publicLinkValidator, v.null()),
  handler: async (ctx, { token }) => {
    const link = await loadLiveLink(ctx, token);
    if (!link) return null;

    const chapter = await ctx.db.get(link.chapterId);
    const rows = await loadLinkRepayments(ctx, link);
    const charges = rows.map((r) => ({
      id: r._id,
      amountCents: r.amountCents,
      postedAt: r.postedAt,
      clearing: r.row.status === "processing",
    }));
    const totalCents = charges
      .filter((c) => !c.clearing)
      .reduce((sum, c) => sum + c.amountCents, 0);
    return {
      chapterName: chapter?.name ?? "Public Worship",
      charges,
      totalCents,
      settled: charges.length === 0,
    };
  },
});

/**
 * What this selection would cost on each rail — the same two-rail quote the
 * authed page shows, resolved through a token instead of a session.
 *
 * Every id is re-checked against the token's own person, so a caller who
 * guesses another repayment's id gets it silently dropped rather than quoted.
 */
export const publicQuote = query({
  args: {
    token: v.string(),
    repaymentIds: v.array(v.id("personalRepayments")),
  },
  returns: v.union(
    v.object({
      count: v.number(),
      totalCents: v.number(),
      card: railQuoteShape(),
      ach: railQuoteShape(),
    }),
    v.null(),
  ),
  handler: async (ctx, { token, repaymentIds }) => {
    const link = await loadLiveLink(ctx, token);
    if (!link) return null;
    const billable = await selectBillable(ctx, link, repaymentIds);
    const totalCents = billable.reduce((sum, r) => sum + r.amountCents, 0);
    const rails = await repaymentRailQuotes(ctx, totalCents);
    return { count: billable.length, totalCents, ...rails };
  },
});

function railQuoteShape() {
  return v.object({
    feeCents: v.number(),
    chargeCents: v.number(),
    rateLabel: v.union(v.string(), v.null()),
  });
}

/**
 * Validate a public checkout and hand the action what Stripe needs.
 *
 * The authed twin (`cards.prepareRepaymentCheckout`) authorizes on the
 * caller's session; this one authorizes on the token and NOTHING else. It is
 * deliberately a separate function rather than a flag on that one: a shared
 * preparer with an "or a token" branch is one edit away from letting a token
 * skip a check it was never meant to skip.
 */
export const preparePublicCheckout = internalMutation({
  args: {
    token: v.string(),
    repaymentIds: v.array(v.id("personalRepayments")),
    method: v.union(v.literal("card"), v.literal("ach")),
  },
  returns: v.object({
    repaymentIds: v.array(v.id("personalRepayments")),
    lines: v.array(v.object({ amountCents: v.number() })),
    totalCents: v.number(),
    feeCents: v.number(),
    chargeCents: v.number(),
    feeRateLabel: v.union(v.string(), v.null()),
    paymentMethodTypes: v.union(v.array(v.string()), v.null()),
    chapterName: v.string(),
  }),
  handler: async (ctx, { token, repaymentIds, method }) => {
    const link = await loadLiveLink(ctx, token);
    if (!link) {
      throw new ConvexError({
        code: "LINK_INACTIVE",
        message: "This payment link is no longer active.",
      });
    }
    const billable = await selectBillable(ctx, link, repaymentIds);
    if (billable.length === 0) {
      throw new ConvexError({
        code: "NOTHING_OWED",
        message: "Nothing outstanding to pay back.",
      });
    }
    const totalCents = billable.reduce((sum, r) => sum + r.amountCents, 0);
    const quote = await repaymentRailQuote(ctx, totalCents, method);
    const now = Date.now();
    for (const r of billable) {
      await ctx.db.patch(r._id, { method, updatedAt: now });
    }
    const chapter = await ctx.db.get(link.chapterId);
    return {
      repaymentIds: billable.map((r) => r._id),
      // Amounts only — the Stripe line item names must not carry a merchant
      // or a person either, since they appear on the checkout page and the
      // receipt email. Same rule as the page itself.
      lines: billable.map((r) => ({ amountCents: r.amountCents })),
      totalCents,
      feeCents: quote.feeCents,
      chargeCents: quote.chargeCents,
      feeRateLabel: quote.rateLabel,
      paymentMethodTypes: stripePaymentMethodTypes(method),
      chapterName: chapter?.name ?? "Public Worship",
    };
  },
});

/** Stamp the Checkout Session id on the rows it bundled, so a refused bank
 *  debit can release exactly those (`cards.releaseRepaymentCheckout`). */
export const attachPublicSession = internalMutation({
  args: {
    repaymentIds: v.array(v.id("personalRepayments")),
    sessionId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, { repaymentIds, sessionId }) => {
    for (const id of repaymentIds) {
      const row = await ctx.db.get(id);
      if (!row || row.status === "paid") continue;
      await ctx.db.patch(id, {
        stripeCheckoutSessionId: sessionId,
        updatedAt: Date.now(),
      });
    }
    return null;
  },
});

// ── Shared internals ─────────────────────────────────────────────────────────

/** A live (existing, un-revoked) link for a token, or null. */
async function loadLiveLink(
  ctx: QueryCtx,
  token: string,
): Promise<Doc<"repaymentLinks"> | null> {
  if (!token) return null;
  const link = await ctx.db
    .query("repaymentLinks")
    .withIndex("by_token", (q) => q.eq("token", token))
    .unique();
  if (!link || link.revokedAt != null) return null;
  return link;
}

/** Every repayment this link covers, with its charge's posted date. Ordered
 *  newest charge first — the one a payer is most likely to be asking about. */
async function loadLinkRepayments(
  ctx: QueryCtx,
  link: Doc<"repaymentLinks">,
): Promise<
  { _id: Id<"personalRepayments">; amountCents: number; postedAt: number; row: Doc<"personalRepayments"> }[]
> {
  const rows = await ctx.db
    .query("personalRepayments")
    .withIndex("by_person", (q) => q.eq("payerPersonId", link.payerPersonId))
    .take(LINK_CHARGE_LIMIT);
  const out: {
    _id: Id<"personalRepayments">;
    amountCents: number;
    postedAt: number;
    row: Doc<"personalRepayments">;
  }[] = [];
  for (const row of rows) {
    if (row.chapterId !== link.chapterId) continue;
    // Settled charges drop off the page entirely. On the authed page they stay
    // as a receipt the payer can scroll back to; here, a stranger's-eye view of
    // a debt someone already cleared is disclosure with no purpose.
    if (row.status === "paid" || row.creditTransactionId) continue;
    const txn = await ctx.db.get(row.transactionId);
    out.push({
      _id: row._id,
      amountCents: row.amountCents,
      postedAt: txn?.postedAt ?? row.createdAt,
      row,
    });
  }
  out.sort((a, b) => b.postedAt - a.postedAt);
  return out;
}

/**
 * The submitted ids, narrowed to what this token may actually bill: the
 * token's OWN person, this chapter, still outstanding, and not already
 * clearing through another checkout. Anything else is dropped silently — a
 * stale checkbox or a guessed id must degrade, never throw a message that
 * confirms the id exists.
 */
async function selectBillable(
  ctx: QueryCtx,
  link: Doc<"repaymentLinks">,
  repaymentIds: Id<"personalRepayments">[],
): Promise<Doc<"personalRepayments">[]> {
  const out: Doc<"personalRepayments">[] = [];
  const seen = new Set<string>();
  for (const id of repaymentIds) {
    if (seen.has(id)) continue; // a duplicated id must not double the charge
    seen.add(id);
    const row = await ctx.db.get(id);
    if (!row) continue;
    if (row.payerPersonId !== link.payerPersonId) continue;
    if (row.chapterId !== link.chapterId) continue;
    if (row.status === "paid" || row.creditTransactionId) continue;
    if (row.status === "processing") continue;
    out.push(row);
  }
  return out;
}

