/**
 * ONE ANSWER to "what does this partnership actually say, and what is still
 * owed on it?" — used by the staff composer, the public portal, the payment
 * preparer, and the settle path.
 *
 * The alternative was each surface reading `sponsorships` + `sponsorPackages` +
 * `gifts` and doing its own fallback and its own subtraction. That is four
 * chances for the portal to quote a partner a balance the desk doesn't agree
 * with, on a page that then charges them for it. So the resolution lives here
 * and every caller takes what it returns.
 *
 * ── THE FALLBACK RULE ───────────────────────────────────────────────────────
 * An agreement's proposal fields are all optional and every one falls back to
 * the package tier: absent means "the tier's copy is still true for this
 * partner". Nothing is copied down at create time, deliberately — a copy would
 * freeze a typo into every agreement written before it was fixed, and would
 * make a tier edit silently stop reaching the agreements that never diverged.
 * The cost is this function; the benefit is that "which tier is this?" and
 * "what did we promise THEM?" stay separate questions with separate answers.
 */
import {
  DEFAULT_SPONSOR_RAILS,
  type SponsorInKindCredit,
  type SponsorPaymentRail,
  inKindTotalCents,
  sponsorBalance,
  sponsorPortalState,
  type SponsorBalance,
  type SponsorPortalState,
} from "@events-os/shared";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

/**
 * What a partnership PAYMENT credits against the agreement.
 *
 * The gift row is the WHOLE CHARGE — fee coverage included — because that is
 * what the ledger received and what `gifts.feeCoverageCents` documents. But the
 * AGREEMENT is only satisfied by what the partner meant to give: a $1,000
 * instalment on which they also covered a $5 fee is $1,000 of a $3,500 spot,
 * not $1,005. Subtracting the coverage here is what keeps "balance remaining"
 * honest without understating a gift the partner deliberately made larger.
 *
 * Lives beside the sum that uses it, deliberately: the moment this arithmetic
 * and `sponsorshipMoney` sit in different files, one of them gets edited.
 */
export function creditedCents(gift: Doc<"gifts">): number {
  return Math.max(0, gift.amountCents - (gift.feeCoverageCents ?? 0));
}

/** Bounds the gift walk behind a balance. A partnership settles in a handful
 *  of payments; this is "far above any real agreement", not a page size. */
const SPONSORSHIP_GIFT_SCAN_LIMIT = 500;

/** The agreement's terms as the partner sees them, tier fallbacks applied. */
export interface ResolvedProposal {
  title: string;
  amountCents: number;
  summary: string | null;
  benefits: string[];
  commitments: string[];
  terms: string | null;
  termsVersion: number;
  rails: SponsorPaymentRail[];
  inKindCredits: SponsorInKindCredit[];
  /** True when this agreement carries its own copy rather than the tier's —
   *  what the composer shows as "customized" vs "following the package". */
  isCustomized: boolean;
}

/**
 * A row's terms version, treating "absent" as 1.
 *
 * Rows written before the portal existed have no `termsVersion`, and a missing
 * number must read as "version one", never as 0 or NaN: `signedTermsVersion`
 * is compared against this to decide whether a signature is still valid, and a
 * comparison against NaN is false forever — a portal that could never leave
 * `awaiting_signature` no matter how many times the partner signed.
 */
export function termsVersionOf(sponsorship: Doc<"sponsorships">): number {
  const v = sponsorship.termsVersion;
  return Number.isInteger(v) && (v as number) > 0 ? (v as number) : 1;
}

/** Resolve the agreement's proposal against its package tier. */
export function resolveProposal(
  sponsorship: Doc<"sponsorships">,
  pkg: Doc<"sponsorPackages"> | null,
): ResolvedProposal {
  const benefits = sponsorship.benefits?.length
    ? sponsorship.benefits
    : (pkg?.benefits ?? []);
  const commitments = sponsorship.commitments?.length
    ? sponsorship.commitments
    : (pkg?.commitments ?? []);
  const amountCents =
    typeof sponsorship.amountCents === "number" && sponsorship.amountCents > 0
      ? sponsorship.amountCents
      : (pkg?.pricing.amountCents ?? 0);

  return {
    title: sponsorship.title?.trim() || pkg?.name || "Partnership",
    amountCents,
    summary: sponsorship.summary?.trim() || null,
    benefits,
    commitments,
    terms: sponsorship.terms?.trim() || null,
    termsVersion: termsVersionOf(sponsorship),
    rails: normalizeRails(sponsorship.paymentRails),
    inKindCredits: sponsorship.inKindCredits ?? [],
    isCustomized: Boolean(
      sponsorship.title ||
        sponsorship.summary ||
        sponsorship.amountCents ||
        sponsorship.benefits?.length ||
        sponsorship.commitments?.length,
    ),
  };
}

/**
 * The rails an agreement offers, with the safe default applied.
 *
 * An EMPTY stored array means the same thing as an absent one — bank transfer
 * only. That is not laziness about the difference: a portal with zero rails is
 * a page with no way to pay, and "the manager unticked everything" is not a
 * state worth being able to reach by accident. Whether card is *allowed* at
 * this agreement's size is a separate check (`railAllowedAtAmount`), made where
 * the amount is known.
 */
export function normalizeRails(
  stored: readonly string[] | undefined,
): SponsorPaymentRail[] {
  const rails = (stored ?? []).filter(
    (r): r is SponsorPaymentRail => r === "ach" || r === "card",
  );
  return rails.length ? Array.from(new Set(rails)) : [...DEFAULT_SPONSOR_RAILS];
}

/** What has actually landed against an agreement, and what is still in flight. */
export interface SponsorshipMoney {
  balance: SponsorBalance;
  /** Settled `gifts` rows carrying this `sponsorshipId`, newest first. */
  gifts: Doc<"gifts">[];
  /** Authorised bank debits that have not cleared — money that is NOT in
   *  `balance.paidCents` and must never be, but which the partner should see
   *  so they don't pay the same balance twice while it clears. */
  pendingCents: number;
  /**
   * What the partner may pay RIGHT NOW: the balance minus what is already in
   * flight. This is the figure every pay path must use, never `balanceCents`
   * — during an ACH debit's ~4-day clearing window the balance is still full
   * (a pending debit books no gift), so offering the full balance again is how
   * a partner pays a $3,500 spot twice. Zero while a debit covers the whole
   * balance; the remainder when only part is in flight.
   */
  payableNowCents: number;
  state: SponsorPortalState;
}

/**
 * Sum an agreement's money.
 *
 * PENDING IS NOT PAID, and the separation is the point. A bank debit takes
 * about four business days; counting it as paid would tell the desk a
 * partnership is funded on the strength of an authorisation the bank can still
 * refuse. But hiding it entirely is how a partner pays $3,500 twice — so it is
 * returned alongside, and every surface shows it as clearing rather than as
 * received. This mirrors `pendingGifts`' whole reason for existing.
 */
export async function sponsorshipMoney(
  ctx: QueryCtx,
  sponsorship: Doc<"sponsorships">,
  proposal: ResolvedProposal,
): Promise<SponsorshipMoney> {
  const sponsorshipId = sponsorship._id;
  const gifts = await ctx.db
    .query("gifts")
    .withIndex("by_sponsorship", (q) => q.eq("sponsorshipId", sponsorshipId))
    .order("desc")
    .take(SPONSORSHIP_GIFT_SCAN_LIMIT);

  // In-flight bank debits for THIS agreement, read through the dedicated
  // `by_sponsorship` index rather than a scan-and-filter of the shared
  // pending table — so a busy giving window can never push this agreement's
  // own clearing debit outside the read and undercount what is in flight
  // (which the double-pay guard in `sponsorPortal.preparePayment` depends on).
  const pending = await ctx.db
    .query("pendingGifts")
    .withIndex("by_sponsorship", (q) => q.eq("sponsorshipId", sponsorshipId))
    .take(SPONSORSHIP_GIFT_SCAN_LIMIT);
  const pendingCents = pending
    .filter((p) => p.status === "in_flight")
    .reduce((sum, p) => sum + p.amountCents, 0);

  const balance = sponsorBalance({
    committedCents: proposal.amountCents,
    inKindCents: inKindTotalCents(proposal.inKindCredits),
    paidCents: gifts.reduce((sum, g) => sum + creditedCents(g), 0),
  });

  return {
    balance,
    gifts,
    pendingCents,
    payableNowCents: Math.max(0, balance.balanceCents - pendingCents),
    state: sponsorPortalState({
      hasLiveLink: portalLinkIsLive(sponsorship),
      termsVersion: proposal.termsVersion,
      signedTermsVersion: sponsorship.signedTermsVersion ?? null,
      balanceCents: balance.balanceCents,
      pendingCents,
    }),
  };
}

/** Is there a link a partner could open right now? */
export function portalLinkIsLive(sponsorship: Doc<"sponsorships">): boolean {
  return Boolean(sponsorship.portalToken) && sponsorship.portalRevokedAt == null;
}

/** Has the partner signed the terms CURRENTLY on the page? The comparison the
 *  whole signature design exists for — see `schema/sponsorships.ts`. */
export function signatureIsCurrent(sponsorship: Doc<"sponsorships">): boolean {
  return (
    sponsorship.signedAt != null &&
    sponsorship.signedTermsVersion === termsVersionOf(sponsorship)
  );
}

/** Load an agreement + its tier + its resolved proposal in one place, or null. */
export async function loadAgreement(
  ctx: QueryCtx,
  sponsorshipId: Id<"sponsorships">,
): Promise<{
  sponsorship: Doc<"sponsorships">;
  package: Doc<"sponsorPackages"> | null;
  proposal: ResolvedProposal;
} | null> {
  const sponsorship = await ctx.db.get(sponsorshipId);
  if (!sponsorship) return null;
  const pkg = await ctx.db.get(sponsorship.packageId);
  return { sponsorship, package: pkg, proposal: resolveProposal(sponsorship, pkg) };
}
