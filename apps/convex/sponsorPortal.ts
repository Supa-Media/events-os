/**
 * THE PARTNER PORTAL — one sponsorship agreement, on a page the partner can
 * open without an account: read what was agreed, sign it, and pay it.
 *
 * Founder, 2026-08-20, on a $3,500 Production Partner spot just closed with
 * Ignite: "do we create portals with… in which the sponsors can go in and pay
 * for, like, the customized packages? … is there a place for them to put the
 * different terms and the different expectations … maybe attach a partnership
 * agreement that they can sign digitally."
 *
 * Before this file the answer was no on all three counts. A sponsorship could
 * hold a package tier, a pipeline stage, and a free-text `terms` note that
 * nobody outside the desk could ever see; money arrived only when a staffer
 * typed it in after the fact. This file is the other half: the agreement's own
 * proposal, the partner's own signature, and the partner's own payment.
 *
 * ── THE FIVE THINGS THIS FILE IS CAREFUL ABOUT ──────────────────────────────
 *
 * 1. THE TOKEN IS THE ONLY AUTHORITY, AND IT IS NARROW. It opens exactly one
 *    agreement and authorizes exactly two acts: signing it and paying it. It
 *    cannot list packages, read the donor CRM, see another agreement, or change
 *    a single term — there is no mutation here that takes a term as an argument
 *    from the public side. A crafted POST has nothing to aim at.
 *
 * 2. THE AMOUNT IS ALWAYS OURS. The client says which agreement and (for a
 *    part payment) how much it WANTS to send; the server resolves the
 *    agreement's committed figure, subtracts reviewed in-kind credit and
 *    settled cash, and clamps the request to what is actually owed. A page
 *    that could post its own price is a page that can be paid $0.01.
 *
 * 3. THE RAIL IS ENFORCED, NOT SUGGESTED. Stripe's ACH debit is 0.8% capped at
 *    $5; a card takes ~$101.80 of a $3,500 spot. New agreements offer bank
 *    transfer ALONE (`DEFAULT_SPONSOR_RAILS`), a manager must deliberately add
 *    card, and above `CARD_RAIL_MAX_CENTS` they cannot. `startPayment` re-checks
 *    all of that server-side — the button being absent from the page is a
 *    courtesy, never the guard.
 *
 * 4. A SIGNATURE IS AGAINST A VERSION. Editing anything the partner signed —
 *    amount, terms, benefits, commitments, summary, title — bumps
 *    `termsVersion` and CLEARS the signature, walking the portal back to
 *    "awaiting signature". Holding a signature against terms nobody agreed to
 *    is the failure this pair exists to prevent (the same rule
 *    `contractorPayments.updateTerms` documents). Nothing here lets a staffer
 *    sign on the partner's behalf: that mutation deliberately does not exist.
 *
 * 5. SETTLEMENT IS NOT REIMPLEMENTED. A portal payment becomes an ordinary
 *    `gifts` row through the same `recordGiftForDonor` every other giving rail
 *    uses, tagged with `sponsorshipId`, idempotent on the Stripe session id via
 *    `gifts.by_externalRef` (`sponsor:<session>`). A second money-writing path
 *    is how two paths drift, and this is money.
 */
import { ConvexError, v } from "convex/values";
import {
  CARD_RAIL_MAX_CENTS,
  MAX_IN_KIND_CREDITS,
  MAX_SPONSORSHIP_EVENTS,
  SPONSOR_AMOUNT_MAX_CENTS,
  SPONSOR_CONTACT_NAME_MAX,
  SPONSOR_CREDIT_LABEL_MAX,
  SPONSOR_LINE_MAX,
  SPONSOR_PAYMENT_RAILS,
  SPONSOR_SUMMARY_MAX,
  SPONSOR_TERMS_MAX,
  SPONSOR_TITLE_MAX,
  type SponsorPaymentRail,
  describeFeeRate,
  inKindTotalCents,
  railAllowedAtAmount,
  sponsorAmountProblems,
  sponsorFeeQuote,
  sponsorSignatureProblems,
} from "@events-os/shared";
import { internal } from "./_generated/api";
import { Doc } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { resolveFeeRate } from "./lib/feeSchedule";
import { recordGiftForDonor } from "./lib/givingDonors";
import {
  requirePartnershipCompose,
  requirePartnershipSend,
  requirePartnershipView,
} from "./lib/sponsorAccess";
import {
  creditedCents,
  loadAgreement,
  normalizeRails,
  portalLinkIsLive,
  resolveProposal,
  signatureIsCurrent,
  sponsorshipMoney,
  termsVersionOf,
} from "./lib/sponsorProposal";
import { sponsorPortalPath, sponsorPortalUrl } from "./lib/siteUrl";

// ── Bounds & rate limits ─────────────────────────────────────────────────────

/** A proposal's bullet lists — the same cap `sponsorships.ts` puts on a
 *  package's, because they render in the same place and mean the same thing. */
const MAX_PROPOSAL_LIST_ITEMS = 30;

/**
 * Rate limits for the unauthenticated endpoints, on the SAME
 * `reimbursementSubmitAttempts` table + `by_key_and_time` mechanism the
 * reimburse and contract pages use — one rate-limit store, already swept daily
 * by `maintenance.sweepRateLimitAttempts`, rather than a third table with its
 * own sweep and its own bug.
 *
 * Keyed per endpoint so signing can't burn the payment budget: a partner who
 * fat-fingers a signature four times must still be able to pay.
 */
const PORTAL_RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const PORTAL_SIGN_MAX = 15;
const PORTAL_PAY_MAX = 15;

async function assertPortalNotRateLimited(
  ctx: MutationCtx,
  key: string,
  max: number,
): Promise<void> {
  const windowStart = Date.now() - PORTAL_RATE_WINDOW_MS;
  const recent = await ctx.db
    .query("reimbursementSubmitAttempts")
    .withIndex("by_key_and_time", (q) =>
      q.eq("key", key).gte("createdAt", windowStart),
    )
    .take(max);
  if (recent.length >= max) {
    throw new ConvexError({
      code: "RATE_LIMITED",
      message: "Too many attempts recently. Please try again in a bit.",
    });
  }
  await ctx.db.insert("reimbursementSubmitAttempts", { key, createdAt: Date.now() });
}

// ── Small helpers ────────────────────────────────────────────────────────────

function cap(value: string | undefined, max: number): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

/** Trim, drop blanks, cap each line, cap the list. Used for both bullet
 *  lists — a manager pasting from a deck brings empty lines with them. */
function cleanList(items: string[] | undefined, what: string): string[] | undefined {
  if (items === undefined) return undefined;
  const cleaned = items
    .map((i) => i.trim().slice(0, SPONSOR_LINE_MAX))
    .filter(Boolean);
  if (cleaned.length > MAX_PROPOSAL_LIST_ITEMS) {
    throw new ConvexError({
      code: "TOO_MANY_ITEMS",
      message: `A proposal may list at most ${MAX_PROPOSAL_LIST_ITEMS} ${what}.`,
    });
  }
  return cleaned;
}

/**
 * Resolve a portal token to its agreement, or null.
 *
 * A REVOKED LINK IS A DEAD LINK, checked here rather than at each call site so
 * a route added next year cannot forget. Null (not a throw) so the page renders
 * "this link isn't active" instead of a stack trace — and so a guessed token
 * and a revoked one are indistinguishable from outside.
 */
async function agreementForToken(
  ctx: QueryCtx,
  token: string,
): Promise<Doc<"sponsorships"> | null> {
  const trimmed = token.trim();
  if (!trimmed) return null;
  const row = await ctx.db
    .query("sponsorships")
    .withIndex("by_portalToken", (q) => q.eq("portalToken", trimmed))
    .unique();
  if (!row || !portalLinkIsLive(row)) return null;
  return row;
}

// ── STAFF: composing the proposal ────────────────────────────────────────────

/**
 * Everything the staff composer renders: the resolved proposal, the money, the
 * portal's state, the live link (if any), and the signature on file.
 *
 * Separate from `sponsorships.getSponsorship` on purpose — that query is the
 * relationship view (donor, events, owner, gift history) and is read by people
 * with `giving.view` anywhere. This one is the partnership desk's own surface
 * and gates through `requirePartnershipView`, so the day the two powers split
 * (see `lib/sponsorAccess.ts`) they already have separate doors.
 */
export const portalAdmin = query({
  args: { sponsorshipId: v.id("sponsorships") },
  handler: async (ctx, { sponsorshipId }) => {
    await requirePartnershipView(ctx);
    const loaded = await loadAgreement(ctx, sponsorshipId);
    if (!loaded) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "That sponsorship doesn't exist.",
      });
    }
    const { sponsorship, package: pkg, proposal } = loaded;
    const money = await sponsorshipMoney(ctx, sponsorship, proposal);
    const donor = await ctx.db.get(sponsorship.donorId);

    // The events this partnership covers, resolved server-side so the composer
    // can render the current selection by NAME rather than holding a list of
    // ids it would have to look up itself. Dangling ids (an event deleted after
    // it was attached) are dropped here rather than rendered as a blank row.
    const events = (
      await Promise.all(
        (sponsorship.eventIds ?? []).map((id) => ctx.db.get(id)),
      )
    )
      .filter((e): e is Doc<"events"> => e !== null)
      .map((e) => ({ _id: e._id, name: e.name, eventDate: e.eventDate }));

    const token = portalLinkIsLive(sponsorship) ? sponsorship.portalToken! : null;
    return {
      proposal,
      events,
      packageName: pkg?.name ?? null,
      packagePriceCents: pkg?.pricing.amountCents ?? null,
      donorName: donor?.name ?? null,
      contact: {
        name: sponsorship.contactName ?? null,
        title: sponsorship.contactTitle ?? null,
        email: sponsorship.contactEmail ?? null,
      },
      balance: money.balance,
      pendingCents: money.pendingCents,
      state: money.state,
      // The link, and the RELATIVE path alongside it: the absolute form needs
      // PUBLIC_SITE_URL, which is unset in a preview deployment, and a composer
      // that shows nothing at all there is a composer nobody can test.
      portal: token
        ? {
            token,
            path: sponsorPortalPath(token),
            url: sponsorPortalUrl(token),
            issuedAt: sponsorship.portalIssuedAt ?? null,
            firstViewedAt: sponsorship.portalFirstViewedAt ?? null,
            lastViewedAt: sponsorship.portalLastViewedAt ?? null,
          }
        : null,
      revokedAt: sponsorship.portalRevokedAt ?? null,
      signature: signatureIsCurrent(sponsorship)
        ? {
            name: sponsorship.signedName ?? "",
            title: sponsorship.signedTitle ?? null,
            email: sponsorship.signedEmail ?? null,
            at: sponsorship.signedAt!,
            termsVersion: sponsorship.signedTermsVersion!,
          }
        : null,
      /** A signature that a terms edit invalidated — shown as "they signed
       *  v2, the page now says v3", never silently dropped. Somebody has to
       *  know a partner needs to re-sign. */
      staleSignature:
        sponsorship.signedAt != null && !signatureIsCurrent(sponsorship)
          ? {
              name: sponsorship.signedName ?? "",
              at: sponsorship.signedAt,
              termsVersion: sponsorship.signedTermsVersion ?? 1,
            }
          : null,
      cardCeilingCents: CARD_RAIL_MAX_CENTS,
    };
  },
});

/**
 * Write this partner's version of the deal.
 *
 * EVERY ARG IS OPTIONAL AND `undefined` MEANS "LEAVE IT". `null` is not
 * accepted for the text fields; clearing one is done by sending an empty
 * string, which normalizes back to "follow the package tier". That asymmetry is
 * deliberate — a composer that PATCHes only what the user touched cannot
 * accidentally blank a field it never rendered.
 *
 * ── THE TERMS BUMP ──────────────────────────────────────────────────────────
 * Changing anything the partner SIGNS (title, summary, benefits, commitments,
 * terms, amount) bumps `termsVersion` and clears the signature. Changing
 * anything they don't (the contact block, the rails, in-kind credits) does not.
 *
 * In-kind credits are the interesting exclusion, and it is a judgement rather
 * than an oversight: a reviewed production credit REDUCES what the partner owes
 * against terms they already agreed to. Making a $2,500 credit invalidate their
 * signature would mean the act of giving them money back forced them to re-sign
 * — which is both absurd and the surest way to make the desk stop recording
 * credits. The amount they committed to is what they signed; how much of it
 * they have already covered is not.
 */
export const saveProposal = mutation({
  args: {
    sponsorshipId: v.id("sponsorships"),
    title: v.optional(v.string()),
    amountCents: v.optional(v.number()),
    summary: v.optional(v.string()),
    benefits: v.optional(v.array(v.string())),
    commitments: v.optional(v.array(v.string())),
    terms: v.optional(v.string()),
    /**
     * WHICH EVENTS THIS PARTNERSHIP COVERS. The Ignite deal is the case: one
     * agreement standing behind Love Thy Neighbor on Sept 26 AND the hosted
     * Worship with Strangers on Sept 18. A partnership is routinely more than
     * one date, and the partner is entitled to see exactly which ones.
     *
     * Bounded by `MAX_SPONSORSHIP_EVENTS` and every id is checked to exist —
     * this list renders on a page a partner reads, and a dangling id there is
     * an event that silently disappears from what they were promised.
     */
    eventIds: v.optional(v.array(v.id("events"))),
    contactName: v.optional(v.string()),
    contactTitle: v.optional(v.string()),
    contactEmail: v.optional(v.string()),
    paymentRails: v.optional(
      v.array(v.union(...SPONSOR_PAYMENT_RAILS.map((r) => v.literal(r)))),
    ),
    inKindCredits: v.optional(
      v.array(
        v.object({
          label: v.string(),
          amountCents: v.number(),
          note: v.optional(v.string()),
        }),
      ),
    ),
  },
  returns: v.object({ termsVersion: v.number(), signatureCleared: v.boolean() }),
  handler: async (ctx, args) => {
    await requirePartnershipCompose(ctx);
    const loaded = await loadAgreement(ctx, args.sponsorshipId);
    if (!loaded) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "That sponsorship doesn't exist.",
      });
    }
    const { sponsorship, package: pkg } = loaded;

    if (args.amountCents !== undefined) {
      const problems = sponsorAmountProblems(args.amountCents);
      if (problems.length) {
        throw new ConvexError({ code: "INVALID_AMOUNT", message: problems[0] });
      }
    }

    const patch: Partial<Doc<"sponsorships">> = {};
    // `""` clears back to the tier's copy; a value overrides it. `undefined`
    // (the arg absent) touches nothing — see this mutation's doc.
    if (args.title !== undefined) patch.title = cap(args.title, SPONSOR_TITLE_MAX);
    if (args.summary !== undefined) {
      patch.summary = cap(args.summary, SPONSOR_SUMMARY_MAX);
    }
    if (args.terms !== undefined) patch.terms = cap(args.terms, SPONSOR_TERMS_MAX);
    if (args.amountCents !== undefined) patch.amountCents = args.amountCents;
    if (args.benefits !== undefined) {
      patch.benefits = cleanList(args.benefits, "benefits");
    }
    if (args.commitments !== undefined) {
      patch.commitments = cleanList(args.commitments, "commitments");
    }
    if (args.contactName !== undefined) {
      patch.contactName = cap(args.contactName, SPONSOR_CONTACT_NAME_MAX);
    }
    if (args.contactTitle !== undefined) {
      patch.contactTitle = cap(args.contactTitle, SPONSOR_CONTACT_NAME_MAX);
    }
    if (args.contactEmail !== undefined) {
      patch.contactEmail = cap(args.contactEmail, SPONSOR_CONTACT_NAME_MAX)?.toLowerCase();
    }

    if (args.eventIds !== undefined) {
      const eventIds = Array.from(new Set(args.eventIds));
      if (eventIds.length > MAX_SPONSORSHIP_EVENTS) {
        throw new ConvexError({
          code: "TOO_MANY_EVENTS",
          message: `A partnership may cover at most ${MAX_SPONSORSHIP_EVENTS} events.`,
        });
      }
      for (const eventId of eventIds) {
        if (!(await ctx.db.get(eventId))) {
          throw new ConvexError({
            code: "NOT_FOUND",
            message: "One of those events doesn't exist any more.",
          });
        }
      }
      patch.eventIds = eventIds;
    }

    // The amount that will be in force AFTER this patch — what the rail check
    // must be made against, not the amount before it. Otherwise raising an
    // agreement past the card ceiling in the same save that keeps card ticked
    // would slip a $101 fee through the guard.
    const effectiveAmount =
      patch.amountCents ??
      sponsorship.amountCents ??
      pkg?.pricing.amountCents ??
      0;

    if (args.paymentRails !== undefined) {
      const rails = normalizeRails(args.paymentRails);
      for (const rail of rails) {
        if (!railAllowedAtAmount(rail, effectiveAmount)) {
          throw new ConvexError({
            code: "RAIL_NOT_ALLOWED",
            message:
              "Card isn't available on a partnership this size — the processor's cut would be about 3%. Bank transfer caps the fee at $5.00.",
          });
        }
      }
      patch.paymentRails = rails;
    } else if (
      // A raise past the ceiling drops card even when the manager didn't touch
      // the rails, because leaving it on would be exactly the fee the ceiling
      // exists to prevent — silently, on the agreement most able to afford a
      // careful decision.
      patch.amountCents !== undefined &&
      normalizeRails(sponsorship.paymentRails).includes("card") &&
      !railAllowedAtAmount("card", effectiveAmount)
    ) {
      patch.paymentRails = ["ach"];
    }

    if (args.inKindCredits !== undefined) {
      if (args.inKindCredits.length > MAX_IN_KIND_CREDITS) {
        throw new ConvexError({
          code: "TOO_MANY_CREDITS",
          message: `An agreement may carry at most ${MAX_IN_KIND_CREDITS} in-kind credit lines.`,
        });
      }
      const credits = args.inKindCredits
        .map((c) => ({
          label: c.label.trim().slice(0, SPONSOR_CREDIT_LABEL_MAX),
          amountCents: Math.max(0, Math.round(c.amountCents)),
          ...(c.note?.trim() ? { note: c.note.trim().slice(0, SPONSOR_LINE_MAX) } : {}),
        }))
        .filter((c) => c.label && c.amountCents > 0);
      const total = inKindTotalCents(credits);
      if (total > SPONSOR_AMOUNT_MAX_CENTS) {
        throw new ConvexError({
          code: "INVALID_AMOUNT",
          message: "Those in-kind credits add up to more than we can record.",
        });
      }
      patch.inKindCredits = credits;
    }

    // ── Does this invalidate the signature? ──────────────────────────────
    const SIGNED_FIELDS = [
      "title",
      "summary",
      "terms",
      "amountCents",
      "benefits",
      "commitments",
      // WHICH EVENTS is a signed term, not metadata. "Ignite is standing
      // behind Love Thy Neighbor and the Sept 18 gathering" is the substance
      // of what they agreed to; quietly dropping one afterwards would leave a
      // signature against a promise the page no longer makes.
      "eventIds",
    ] as const;
    const signedTermChanged = SIGNED_FIELDS.some((field) => {
      if (!(field in patch)) return false;
      const before = sponsorship[field];
      const after = patch[field];
      return JSON.stringify(before ?? null) !== JSON.stringify(after ?? null);
    });

    const currentVersion = termsVersionOf(sponsorship);
    let signatureCleared = false;
    if (signedTermChanged) {
      patch.termsVersion = currentVersion + 1;
      if (sponsorship.signedAt != null) signatureCleared = true;
    } else if (sponsorship.termsVersion == null) {
      // Stamp the implicit v1 the first time this row is composed, so the
      // stored value and `termsVersionOf`'s fallback stop being two answers.
      patch.termsVersion = currentVersion;
    }

    patch.updatedAt = Date.now();
    await ctx.db.patch(args.sponsorshipId, patch);
    return {
      termsVersion: patch.termsVersion ?? currentVersion,
      signatureCleared,
    };
  },
});

// ── STAFF: the link ──────────────────────────────────────────────────────────

/**
 * Get this agreement's portal link, creating it on first use.
 *
 * IDEMPOTENT, exactly as `repaymentLinks.mintLink` is and for the identical
 * reason: a manager who presses "Copy link" twice must get the same URL both
 * times, because minting a fresh token on the second press would silently kill
 * the one they emailed the partner five minutes ago — a link that stops working
 * for the recipient with no way for either side to know why. Revoking is the
 * one act that mints a new token next time, because that is what revoking is
 * for.
 */
export const issuePortalLink = mutation({
  args: { sponsorshipId: v.id("sponsorships") },
  returns: v.object({
    token: v.string(),
    path: v.string(),
    url: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, { sponsorshipId }) => {
    await requirePartnershipSend(ctx);
    const sponsorship = await ctx.db.get(sponsorshipId);
    if (!sponsorship) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "That sponsorship doesn't exist.",
      });
    }
    if (portalLinkIsLive(sponsorship)) {
      const token = sponsorship.portalToken!;
      return { token, path: sponsorPortalPath(token), url: sponsorPortalUrl(token) };
    }
    const token = crypto.randomUUID();
    await ctx.db.patch(sponsorshipId, {
      portalToken: token,
      portalIssuedAt: Date.now(),
      portalRevokedAt: undefined,
      // A re-issue after a revoke is a NEW link to a new reader: the old link's
      // read receipts describe a page that no longer exists, and leaving them
      // would have the desk believe this partner had already opened something
      // they have not.
      portalFirstViewedAt: undefined,
      portalLastViewedAt: undefined,
      ...(sponsorship.termsVersion == null
        ? { termsVersion: termsVersionOf(sponsorship) }
        : {}),
      updatedAt: Date.now(),
    });
    return { token, path: sponsorPortalPath(token), url: sponsorPortalUrl(token) };
  },
});

/**
 * Kill a link that has gone somewhere it shouldn't. The next issue mints a
 * fresh token.
 *
 * THE SIGNATURE SURVIVES, deliberately. Revoking a URL is an access decision;
 * it does not un-sign an agreement the partner signed, and clearing the
 * signature here would destroy evidence as a side effect of tidying up a link.
 */
export const revokePortalLink = mutation({
  args: { sponsorshipId: v.id("sponsorships") },
  returns: v.null(),
  handler: async (ctx, { sponsorshipId }) => {
    await requirePartnershipSend(ctx);
    const sponsorship = await ctx.db.get(sponsorshipId);
    if (!sponsorship) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "That sponsorship doesn't exist.",
      });
    }
    if (!portalLinkIsLive(sponsorship)) return null;
    await ctx.db.patch(sponsorshipId, {
      portalRevokedAt: Date.now(),
      updatedAt: Date.now(),
    });
    return null;
  },
});

/** Email the live portal link to the contact on file. Requires both a link and
 *  an address; says which is missing rather than failing silently. */
export const sendPortalInvite = mutation({
  args: { sponsorshipId: v.id("sponsorships") },
  returns: v.object({ sentTo: v.string() }),
  handler: async (ctx, { sponsorshipId }) => {
    await requirePartnershipSend(ctx);
    const loaded = await loadAgreement(ctx, sponsorshipId);
    if (!loaded) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "That sponsorship doesn't exist.",
      });
    }
    const { sponsorship } = loaded;
    if (!portalLinkIsLive(sponsorship)) {
      throw new ConvexError({
        code: "NO_LINK",
        message: "Create the portal link first, then send it.",
      });
    }
    const to = sponsorship.contactEmail?.trim();
    if (!to) {
      throw new ConvexError({
        code: "NO_CONTACT",
        message: "Add the partner contact's email address first.",
      });
    }
    await ctx.scheduler.runAfter(0, internal.sponsorPortalNotices.sendInvite, {
      sponsorshipId,
    });
    return { sentTo: to };
  },
});

// ── PUBLIC: the partner's own page ───────────────────────────────────────────

/**
 * The partner's view of their own agreement.
 *
 * ALLOW-LIST SHAPED. What is deliberately absent and cannot be added by
 * accident: the donor's CRM record, due-diligence notes (which are OUR private
 * assessment of them and would be the single worst thing to leak through a
 * partnership portal), the owner's identity, other agreements, and the token
 * itself echoed back. Someone who guesses a token learns what the partner on
 * the other end of it already knows.
 */
export const publicByToken = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const sponsorship = await agreementForToken(ctx, token);
    if (!sponsorship) return null;
    const pkg = await ctx.db.get(sponsorship.packageId);
    const proposal = resolveProposal(sponsorship, pkg);
    const money = await sponsorshipMoney(ctx, sponsorship, proposal);
    const donor = await ctx.db.get(sponsorship.donorId);

    const events = (
      await Promise.all(
        (sponsorship.eventIds ?? []).map((id) => ctx.db.get(id)),
      )
    )
      .filter((e): e is Doc<"events"> => e !== null)
      .map((e) => ({ name: e.name, eventDate: e.eventDate }));

    // Both rails' quotes, so the page can show what each one costs before the
    // partner picks — the honest version of "we'd rather you used the bank".
    const rails = await Promise.all(
      proposal.rails
        .filter((r) => railAllowedAtAmount(r, proposal.amountCents))
        .map(async (rail) => {
          const rate = await resolveFeeRate(
            ctx,
            "stripe",
            rail === "ach" ? "ach_debit" : "card",
          );
          const quote = sponsorFeeQuote(money.balance.balanceCents, rate);
          return { rail, feeCents: quote.feeCents, chargeCents: quote.chargeCents };
        }),
    );

    return {
      orgName: donor?.name ?? "Our partner",
      title: proposal.title,
      summary: proposal.summary,
      benefits: proposal.benefits,
      commitments: proposal.commitments,
      terms: proposal.terms,
      termsVersion: proposal.termsVersion,
      events,
      contactName: sponsorship.contactName ?? null,
      amountCents: proposal.amountCents,
      inKindCredits: proposal.inKindCredits,
      balance: money.balance,
      pendingCents: money.pendingCents,
      state: money.state,
      rails,
      signed: signatureIsCurrent(sponsorship)
        ? {
            name: sponsorship.signedName ?? "",
            title: sponsorship.signedTitle ?? null,
            at: sponsorship.signedAt!,
          }
        : null,
      // Payment history, in the partner's terms: what they sent and when. No
      // gift ids, no donor rollups, no notes the desk wrote about them.
      payments: money.gifts.map((g) => ({
        amountCents: creditedCents(g),
        receivedAt: g.receivedAt,
        method: g.method,
      })),
    };
  },
});

/**
 * "They opened it." Best-effort read receipt, called once per page load.
 *
 * A MUTATION FROM AN UNAUTHENTICATED PAGE, so it is deliberately the smallest
 * possible one: it writes two timestamps on a row the token already names, and
 * nothing else. It is not rate-limited, because the worst a flood achieves is
 * moving one number that was going to move anyway — and rate-limiting it would
 * cost an insert per page view to protect a patch per page view.
 */
export const noteView = mutation({
  args: { token: v.string() },
  returns: v.null(),
  handler: async (ctx, { token }) => {
    const sponsorship = await agreementForToken(ctx, token);
    if (!sponsorship) return null;
    const now = Date.now();
    await ctx.db.patch(sponsorship._id, {
      ...(sponsorship.portalFirstViewedAt == null
        ? { portalFirstViewedAt: now }
        : {}),
      portalLastViewedAt: now,
    });
    return null;
  },
});

/**
 * The partner signs.
 *
 * Stores the typed name, who typed it, the terms version on the page at the
 * time, and the IP — the four facts that make this evidence rather than a
 * boolean. `signedTermsVersion` is read from the AGREEMENT, never from the
 * client: a page that could post which version it was agreeing to could agree
 * to a version it never displayed.
 *
 * IDEMPOTENT-ISH: signing again against the same version overwrites the same
 * fields with the same meaning (a partner who double-taps, or a second person
 * at the org who opens the link and signs it properly). It does NOT append a
 * signature history — one agreement, one current signature, and the audit of
 * what it replaced belongs in a ledger we do not have yet.
 */
export const signAgreement = mutation({
  args: {
    token: v.string(),
    name: v.string(),
    title: v.optional(v.string()),
    email: v.optional(v.string()),
    clientIp: v.optional(v.string()),
  },
  returns: v.object({ signedAt: v.number(), termsVersion: v.number() }),
  handler: async (ctx, args) => {
    await assertPortalNotRateLimited(
      ctx,
      `sponsor_sign_ip:${args.clientIp ?? "unknown"}`,
      PORTAL_SIGN_MAX,
    );
    const sponsorship = await agreementForToken(ctx, args.token);
    if (!sponsorship) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "This link isn't active. Ask your contact for a fresh one.",
      });
    }
    const problems = sponsorSignatureProblems(args.name);
    if (problems.length) {
      throw new ConvexError({ code: "INVALID_SIGNATURE", message: problems[0] });
    }

    const now = Date.now();
    const termsVersion = termsVersionOf(sponsorship);
    await ctx.db.patch(sponsorship._id, {
      signedAt: now,
      signedName: args.name.trim().slice(0, SPONSOR_CONTACT_NAME_MAX),
      signedTitle: cap(args.title, SPONSOR_CONTACT_NAME_MAX),
      signedEmail: cap(args.email, SPONSOR_CONTACT_NAME_MAX)?.toLowerCase(),
      ...(args.clientIp ? { signedIp: args.clientIp.slice(0, 100) } : {}),
      signedTermsVersion: termsVersion,
      // A signed agreement is a COMMITMENT by anyone's definition, so the
      // pipeline moves itself. Only forward, and only from the two stages that
      // precede it: an `active` agreement (money already landed) must not walk
      // backwards, and a `declined` one that somebody later signs is a
      // conversation for a human, not a status flip.
      ...(sponsorship.status === "prospect" || sponsorship.status === "pitched"
        ? { status: "committed" as const }
        : {}),
      updatedAt: now,
    });

    await ctx.scheduler.runAfter(0, internal.sponsorPortalNotices.onSigned, {
      sponsorshipId: sponsorship._id,
    });
    return { signedAt: now, termsVersion };
  },
});

// ── PUBLIC → STRIPE: paying the balance ──────────────────────────────────────

/**
 * Resolve what a portal payment may actually charge. Called by
 * `stripe.createSponsorPortalCheckout` (an action cannot read the database,
 * and the browser must never be the thing that says how much it owes).
 *
 * Returns the intended amount, the fee-coverage line, and the Stripe
 * `payment_method_types` for the chosen rail — everything the action needs and
 * nothing it could get wrong.
 */
export const preparePayment = internalMutation({
  args: {
    token: v.string(),
    rail: v.union(...SPONSOR_PAYMENT_RAILS.map((r) => v.literal(r))),
    /** A part payment. Absent = the whole remaining balance. Clamped
     *  server-side to (0, balance]. */
    amountCents: v.optional(v.number()),
    coverFee: v.optional(v.boolean()),
    clientIp: v.optional(v.string()),
  },
  returns: v.object({
    sponsorshipId: v.id("sponsorships"),
    orgName: v.string(),
    title: v.string(),
    intendedCents: v.number(),
    feeCents: v.number(),
    feeRateLabel: v.union(v.string(), v.null()),
    paymentMethodTypes: v.union(v.array(v.string()), v.null()),
    payerEmail: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    await assertPortalNotRateLimited(
      ctx,
      `sponsor_pay_ip:${args.clientIp ?? "unknown"}`,
      PORTAL_PAY_MAX,
    );
    const sponsorship = await agreementForToken(ctx, args.token);
    if (!sponsorship) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "This link isn't active. Ask your contact for a fresh one.",
      });
    }
    const pkg = await ctx.db.get(sponsorship.packageId);
    const proposal = resolveProposal(sponsorship, pkg);

    // SIGN FIRST. Not a UI nicety: the terms are what the money is for, and a
    // payment against unsigned terms is a payment we cannot say what we owe in
    // return for. The page hides the panel; this is the guard.
    if (!signatureIsCurrent(sponsorship)) {
      throw new ConvexError({
        code: "NOT_SIGNED",
        message: "Please review and sign the agreement before paying.",
      });
    }

    if (!proposal.rails.includes(args.rail)) {
      throw new ConvexError({
        code: "RAIL_NOT_OFFERED",
        message: "That payment method isn't available on this agreement.",
      });
    }
    if (!railAllowedAtAmount(args.rail, proposal.amountCents)) {
      throw new ConvexError({
        code: "RAIL_NOT_ALLOWED",
        message:
          "Card isn't available on a partnership this size — please use a bank transfer.",
      });
    }

    const money = await sponsorshipMoney(ctx, sponsorship, proposal);
    if (money.balance.balanceCents <= 0) {
      throw new ConvexError({
        code: "NOTHING_DUE",
        message: "This partnership is fully covered — there's nothing left to pay.",
      });
    }

    // The client may ask for LESS (an instalment). It may never ask for more,
    // and it never supplies the ceiling.
    const requested =
      args.amountCents != null && Number.isFinite(args.amountCents)
        ? Math.round(args.amountCents)
        : money.balance.balanceCents;
    const intendedCents = Math.min(
      Math.max(requested, 1),
      money.balance.balanceCents,
    );

    const rate = await resolveFeeRate(
      ctx,
      "stripe",
      args.rail === "ach" ? "ach_debit" : "card",
    );
    const { feeCents } = args.coverFee
      ? sponsorFeeQuote(intendedCents, rate)
      : { feeCents: 0 };

    const donor = await ctx.db.get(sponsorship.donorId);
    return {
      sponsorshipId: sponsorship._id,
      orgName: donor?.name ?? "Partnership",
      title: proposal.title,
      intendedCents,
      feeCents,
      // `0.8%, capped at $5.00` — the SHARED formatter the repayment rails
      // already print, so a partner and a volunteer read the identical
      // sentence about the identical rail on Stripe's own page.
      feeRateLabel: rate ? describeFeeRate(rate) : null,
      // A card session sends NOTHING and takes Stripe's default, so the wallets
      // the account already accepts (Apple/Google Pay — same price as a card)
      // stay available. A bank session pins `us_bank_account`, which is what
      // makes Stripe collect bank credentials instead of a card number. Same
      // rule as `lib/repaymentFees.ts#stripePaymentMethodTypes`.
      paymentMethodTypes: args.rail === "ach" ? ["us_bank_account"] : null,
      payerEmail:
        sponsorship.signedEmail ?? sponsorship.contactEmail ?? donor?.email ?? null,
    };
  },
});

/**
 * A portal payment cleared. Books ONE `gifts` row through the same
 * `recordGiftForDonor` every other giving rail uses.
 *
 * IDEMPOTENT ON THE SESSION ID via `gifts.by_externalRef` (`sponsor:<session>`)
 * — Stripe delivers at least once, and both `checkout.session.completed` (card)
 * and `checkout.session.async_payment_succeeded` (bank debit, days later) route
 * here through the same fan-out. A second row would be a second $3,500 in the
 * ledger.
 *
 * THE AMOUNT COMES FROM STRIPE'S OWN `amount_total`, never from metadata a
 * client could have influenced. `feeCoverageCents` rides in metadata because it
 * is OUR arithmetic about a line item we added, and it is parsed defensively:
 * a malformed value degrades to "no coverage", never to a NaN in the ledger.
 */
export const recordPortalPaymentPaid = internalMutation({
  args: {
    sponsorshipId: v.string(),
    sessionId: v.string(),
    amountTotalCents: v.number(),
    feeCoverageCents: v.optional(v.number()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const sponsorshipId = ctx.db.normalizeId("sponsorships", args.sponsorshipId);
    if (!sponsorshipId) return false; // not one of our ids — safe no-op

    if (!Number.isInteger(args.amountTotalCents) || args.amountTotalCents <= 0) {
      console.error(
        `[sponsorPortal] refusing to book session ${args.sessionId} — ` +
          `amount_total ${args.amountTotalCents} is not a positive integer`,
      );
      return false;
    }

    const externalRef = `sponsor:${args.sessionId}`;
    const already = await ctx.db
      .query("gifts")
      .withIndex("by_externalRef", (q) => q.eq("externalRef", externalRef))
      .first();
    if (already) return true; // redelivery — already booked

    const sponsorship = await ctx.db.get(sponsorshipId);
    if (!sponsorship) return false;
    const donor = await ctx.db.get(sponsorship.donorId);
    if (!donor) return false;

    const rawFee = args.feeCoverageCents ?? 0;
    const feeCoverageCents =
      Number.isInteger(rawFee) && rawFee > 0 && rawFee < args.amountTotalCents
        ? rawFee
        : 0;

    const giftId = await recordGiftForDonor(ctx, {
      donorId: sponsorship.donorId,
      amountCents: args.amountTotalCents,
      receivedAt: Date.now(),
      method: "stripe",
      externalRef,
      ...(feeCoverageCents > 0 ? { feeCoverageCents } : {}),
      note: `Partnership payment — ${sponsorship.title ?? "sponsorship"}`,
    });
    await ctx.db.patch(giftId, { sponsorshipId });

    // The same auto-advance `recordSponsorshipGift` applies, and for the same
    // reason: a committed agreement is a written yes, and the first dollar
    // landing is the signal the partnership actually started.
    if (sponsorship.status === "committed") {
      await ctx.db.patch(sponsorshipId, { status: "active", updatedAt: Date.now() });
    }

    await ctx.scheduler.runAfter(0, internal.sponsorPortalNotices.onPaymentSettled, {
      sponsorshipId,
      giftId,
    });
    return true;
  },
});

// ── Internal: notice payloads ────────────────────────────────────────────────

/** Everything the portal's three emails need, projected once. Null when the
 *  agreement has vanished under a scheduled action. */
export const noticePayload = internalQuery({
  args: { sponsorshipId: v.id("sponsorships") },
  handler: async (ctx, { sponsorshipId }) => {
    const loaded = await loadAgreement(ctx, sponsorshipId);
    if (!loaded) return null;
    const { sponsorship, proposal } = loaded;
    const money = await sponsorshipMoney(ctx, sponsorship, proposal);
    const donor = await ctx.db.get(sponsorship.donorId);
    const owner = sponsorship.ownerPersonId
      ? await ctx.db.get(sponsorship.ownerPersonId)
      : null;
    const token = portalLinkIsLive(sponsorship) ? sponsorship.portalToken! : null;

    return {
      orgName: donor?.name ?? "Partner",
      title: proposal.title,
      amountCents: proposal.amountCents,
      balanceCents: money.balance.balanceCents,
      contactName: sponsorship.contactName ?? null,
      contactEmail: sponsorship.contactEmail ?? null,
      signedName: sponsorship.signedName ?? null,
      signedEmail: sponsorship.signedEmail ?? null,
      signedAt: sponsorship.signedAt ?? null,
      portalUrl: token ? sponsorPortalUrl(token) : null,
      ownerEmail: owner?.email ?? null,
      ownerName: owner?.name ?? null,
    };
  },
});

/** One settled payment, for the receipt email. */
export const paymentReceiptPayload = internalQuery({
  args: { giftId: v.id("gifts") },
  handler: async (ctx, { giftId }) => {
    const gift = await ctx.db.get(giftId);
    if (!gift) return null;
    return {
      amountCents: creditedCents(gift),
      chargedCents: gift.amountCents,
      feeCoverageCents: gift.feeCoverageCents ?? 0,
      receivedAt: gift.receivedAt,
    };
  },
});

/** Exported for the notices module — one definition of "who at this org is the
 *  human", so an invite and a receipt never reach different inboxes. */
export function portalRecipient(payload: {
  signedEmail: string | null;
  contactEmail: string | null;
}): string | null {
  return payload.signedEmail ?? payload.contactEmail ?? null;
}
