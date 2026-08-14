/**
 * Giving Platform (F-6, Phase 2) — recurring backer billing on Stripe
 * subscriptions (PRD §2). A BACKER is a donor with an `active` monthly pledge
 * to a city at/above `BACKER_UNIT_CENTS`; the affordability tiers count them.
 *
 * House Stripe style (mirrors `stripe.ts` + `giving.ts`): REST over `fetch` in
 * the default Convex runtime — no SDK, no `"use node"`. Card data never touches
 * our code (Stripe-hosted Checkout + billing portal). Never trust a client
 * amount on settle: every cycle's money is read from the Stripe invoice object.
 *
 * Flow:
 *   startPledgeCheckout (public action) → preparePledge (incomplete row) →
 *   Stripe Checkout `mode=subscription` → the shared `/stripe/webhook` fan-out
 *   in http.ts drives the lifecycle:
 *     - checkout.session.completed  → activatePledgeFromCheckout (→ active)
 *     - invoice.paid                → recordPledgeInvoice (one gift per cycle)
 *     - invoice.payment_failed      → markPledgePastDue
 *     - customer.subscription.updated → syncPledgeSubscription
 *     - customer.subscription.deleted → cancelPledgeSubscription
 *   Each handler no-ops if the object isn't a pledge's (the established "safe
 *   fan-out" pattern), so it can't touch a ticket/donation session.
 *
 * `chapters.backerCount` is DERIVED here, and ONLY here: recomputed from active
 * pledges on every pledge write — status, amount, insert, repoint, delete
 * (`recomputeChapterBackerCount`). Money is always integer cents; `transactions`
 * stays the only actuals ledger (PRD §7). See docs/plans/giving-platform.md §2.
 */
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
// Triggers-wrapped builder for `preparePledge` below (writes `people` via
// `matchOrCreateDonor`/`linkDonorToPerson`) — see
// `lib/peopleAggregate.ts`'s module doc.
import { internalMutation as triggerInternalMutation } from "./lib/peopleAggregate";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { BACKER_UNIT_CENTS, formatCents } from "@events-os/shared";
import { normalizeEmail } from "./lib/access";
import {
  requireGivingManage,
  requireGivingView,
  type GivingScope,
} from "./lib/givingAccess";
import { matchOrCreateDonor, recordGiftForDonor } from "./lib/givingDonors";
import { PLEDGE_STATUSES } from "./schema/givingPlatform";
import {
  siteUrl,
  givePagePath,
  givePageUrl,
  backerPortalUrl,
} from "./lib/siteUrl";
import {
  requireBackerModule,
  requireBackerSession,
} from "./lib/backerAccess";
import { greetingName, renderBackerWelcomeEmail } from "./lib/backerWelcomeEmail";
import { renderPaymentFailedEmail } from "./lib/backerPortalEmails";
import {
  MAX_RULES,
  ruleMatchesBackerSignup,
} from "./lib/givingNotificationRules";
import { sendEmail } from "./ticketingEmails";
import { territoryForChapter } from "./territories";
import { requireUserId } from "./lib/context";
import { writePledgeEvent, GIVING_AUDIT_READ_CAP } from "./lib/givingAudit";
import { auditCents } from "./lib/giftAudit";

const STRIPE_API = "https://api.stripe.com/v1";

/** The monthly pledge FLOOR, in cents ($5 — a fee-sane processing minimum;
 *  Stripe's ~$0.45 on a $5/mo charge nets ~91%). Lowered from $20 (2026-07-21,
 *  owner request) so a "recurring giver" can give a genuinely small monthly
 *  amount — the public `/give` copy no longer advertises a lower bound. A pledge
 *  below `BACKER_UNIT_CENTS` still counts the donor as a donor, just not as a
 *  backer (see `recomputeChapterBackerCount`). Exported for `givingImport.ts`
 *  (territories P6), which enforces the same floor on a canonical `recurring`
 *  row's `recurringMonthlyCents`. */
export const PLEDGE_FLOOR_CENTS = 500;

/** Bounded read for the derived backer-count recompute — mirrors the
 *  `GIFT_WINDOW_LIMIT` bounded-recompute precedent in `givingPlatform.ts`. A
 *  chapter's active-pledge set is far smaller than this in practice. */
const BACKER_RECOUNT_LIMIT = 10000;

/** A generous bound on an admin pledge list (mirrors `listDonors`'s 500). */
const PLEDGE_LIST_LIMIT = 500;

/** Pledges shown on a donor's detail (a donor holds very few). */
const DONOR_PLEDGE_LIMIT = 50;

const scopeValidator = v.union(v.id("chapters"), v.literal("central"));
const pledgeStatusValidator = v.union(
  ...PLEDGE_STATUSES.map((s) => v.literal(s)),
);
type PledgeStatus = (typeof PLEDGE_STATUSES)[number];

/** Display labels for a pledge status (the audit/history render). */
const PLEDGE_STATUS_LABELS: Record<PledgeStatus, string> = {
  incomplete: "Incomplete",
  active: "Active",
  past_due: "Past due",
  canceled: "Canceled",
  paused: "Paused",
};

/**
 * Write a `status` pledge-lifecycle event (owner feedback #5d). `actorUserId`
 * ABSENT = a system/billing transition (every webhook handler below); a manual
 * desk transition passes the acting user. Called ONLY when the status actually
 * changed, so the timeline has no phantom rows.
 */
async function logPledgeStatus(
  ctx: MutationCtx,
  pledge: Doc<"pledges">,
  from: PledgeStatus,
  to: PledgeStatus,
  opts?: { actorUserId?: Id<"users">; note?: string },
): Promise<void> {
  await writePledgeEvent(ctx, {
    pledgeId: pledge._id,
    scope: pledge.scope as GivingScope,
    kind: "status",
    from: PLEDGE_STATUS_LABELS[from],
    to: PLEDGE_STATUS_LABELS[to],
    ...(opts?.actorUserId ? { actorUserId: opts.actorUserId } : {}),
    ...(opts?.note ? { note: opts.note } : {}),
  });
}

// ── Becoming a backer: the one-time announcement ──────────────────────────────

/**
 * Claim the "this pledge just became real" moment — ONCE per pledge — and
 * schedule both things that moment owes: the backer's own welcome email, and
 * the giving desk's "somebody became a backer" notification.
 *
 * ── WHY A CLAIM, RATHER THAN A CALL AT THE OBVIOUS PLACE ───────────────────
 * There is no single obvious place. Two Stripe events each legitimately mean
 * "they're a backer now" — `checkout.session.completed` (the subscription
 * exists) and `invoice.paid` (the first month is actually paid) — and Stripe
 * does not guarantee their order; `recoverPledgeInvoice` exists precisely
 * because the second can arrive first. Both call this. The transaction that
 * finds `announcedAt` absent stamps it and schedules the mail; the other finds
 * it set and does nothing. Mutations are transactional, so the stamp settles
 * the race with no cross-action coordination — and the backer gets exactly one
 * welcome whichever event won.
 *
 * ── WHAT IT DELIBERATELY DOESN'T DO ────────────────────────────────────────
 * It is never called from an IMPORT (`givingImport.ts`, `historicalBackfill.ts`
 * both write pledges directly). A backer the org has had for two years is not
 * news, and a migration that mails two hundred welcomes is an outbound-email
 * incident rather than a feature — the same discipline `recordGiftForDonor`'s
 * `notify: false` exists for. Those rows keep `announcedAt` absent forever,
 * which is exactly what "never announced" means.
 *
 * ── IT CAN NEVER COST THE MONEY THAT CAUSED IT ─────────────────────────────
 * Both sends are SCHEDULED, not awaited. Scheduling is a write inside this
 * transaction; the actions run afterwards, in their own contexts, once the
 * pledge has committed. A Resend outage fails an email and nothing else — and
 * if this transaction rolls back, the jobs roll back with it, so nobody is ever
 * welcomed to a pledge that doesn't exist. (`givingNotifications.ts`'s module
 * doc makes the same argument for gifts.)
 *
 * Returns whether THIS call won the claim, so the caller can decide what else
 * the moment means — see `recordPledgeInvoice`, which uses it to send the
 * welcome INSTEAD of the ordinary monthly receipt on a first cycle.
 */
async function claimBackerAnnouncement(
  ctx: MutationCtx,
  pledge: Doc<"pledges">,
): Promise<boolean> {
  if (pledge.announcedAt !== undefined) return false;
  await ctx.db.patch(pledge._id, { announcedAt: Date.now() });

  // The BACKER's email. Unconditional: this one is the whole point, and it does
  // not depend on anybody having configured a notification rule.
  await ctx.scheduler.runAfter(
    0,
    internal.givingPledges.sendBackerWelcomeEmail,
    { pledgeId: pledge._id },
  );

  // The DESK's email, pre-filtered so a signup nobody asked about schedules
  // nothing — the same discipline `recordGiftForDonor` uses, with the same pure
  // predicate on both sides so the filter can never disagree with the send.
  const immediateRules = await ctx.db
    .query("givingNotificationRules")
    .withIndex("by_cadence", (q) => q.eq("cadence", "immediate"))
    .take(MAX_RULES);
  if (immediateRules.some((rule) => ruleMatchesBackerSignup(rule, pledge))) {
    await ctx.scheduler.runAfter(
      0,
      internal.givingNotifications.notifyBackerSignup,
      { pledgeId: pledge._id },
    );
  }
  return true;
}

/** Everything the welcome email needs, or `null` when the pledge or its donor
 *  is gone, or the donor has no address to write to. Mirrors
 *  `getPledgeReceiptPayload` — the email it stands in for on a first cycle. */
export const getBackerWelcomePayload = internalQuery({
  args: { pledgeId: v.id("pledges") },
  returns: v.union(
    v.null(),
    v.object({
      email: v.string(),
      name: v.string(),
      monthlyCents: v.number(),
      chapterName: v.union(v.string(), v.null()),
      territorySlug: v.union(v.string(), v.null()),
      isBacker: v.boolean(),
    }),
  ),
  handler: async (ctx, { pledgeId }) => {
    const pledge = await ctx.db.get(pledgeId);
    if (!pledge) return null;
    const donor = await ctx.db.get(pledge.donorId);
    if (!donor?.email) return null;

    let chapterName: string | null = null;
    let territorySlug: string | null = null;
    if (pledge.scope !== "central") {
      const chapter = await ctx.db.get(pledge.scope);
      chapterName = chapter?.name ?? null;
      const territory = await territoryForChapter(ctx, pledge.scope);
      // Only a PUBLIC territory earns a link — the button would otherwise point
      // a brand-new backer at a page they can't see.
      territorySlug =
        territory && territory.publiclyVisible ? territory.slug : null;
    }

    return {
      email: donor.email,
      name: donor.name,
      monthlyCents: pledge.amountCents,
      chapterName,
      territorySlug,
      // The org's own vocabulary, and the donor's email has to hold it as
      // carefully as the staff one does: the pledge floor is $5 and the BACKER
      // floor is $50. Telling a $10/month giver they're "a backer of Brooklyn"
      // is a promise about a public count they don't appear in.
      isBacker: pledge.amountCents >= BACKER_UNIT_CENTS,
    };
  },
});

/**
 * Tell a backer their card was declined — rung one of the dunning ladder.
 * Scheduled by `markPledgePastDue`, only on the transition into `past_due`.
 *
 * Reuses `getBackerWelcomePayload`: it already resolves exactly the four facts
 * this email needs (address, name, amount, city) behind one bounded read, and
 * two resolvers for one shape is how they drift.
 */
export const sendPaymentFailedEmail = internalAction({
  args: { pledgeId: v.id("pledges") },
  returns: v.null(),
  handler: async (ctx, { pledgeId }) => {
    const payload = await ctx.runQuery(
      internal.givingPledges.getBackerWelcomePayload,
      { pledgeId },
    );
    if (!payload) return null;
    const { subject, html } = renderPaymentFailedEmail({
      firstName: greetingName(payload.name),
      monthlyCents: payload.monthlyCents,
      chapterName: payload.chapterName,
      portalUrl: backerPortalUrl(),
    });
    await sendEmail(ctx, { to: payload.email, subject, html });
    return null;
  },
});

/**
 * Welcome a brand-new backer — the email the owner asked for, and the one this
 * flow was missing entirely. Scheduled exactly once per pledge by
 * `claimBackerAnnouncement`.
 *
 * On a first billing cycle this REPLACES the ordinary monthly receipt (see
 * `recordPledgeInvoice`), so it has to carry the receipt's facts too: what will
 * be charged, that the first month is in, and how to change it. `sendEmail`
 * degrades to a logged no-op with no Resend key configured, like every other
 * transactional send here.
 */
export const sendBackerWelcomeEmail = internalAction({
  args: { pledgeId: v.id("pledges") },
  returns: v.null(),
  handler: async (ctx, { pledgeId }) => {
    const payload = await ctx.runQuery(
      internal.givingPledges.getBackerWelcomePayload,
      { pledgeId },
    );
    if (!payload) return null;
    const { subject, html } = renderBackerWelcomeEmail({
      name: payload.name,
      monthlyCents: payload.monthlyCents,
      chapterName: payload.chapterName,
      isBacker: payload.isBacker,
      givePageUrl: payload.territorySlug
        ? givePageUrl(payload.territorySlug)
        : null,
      portalUrl: backerPortalUrl(),
    });
    await sendEmail(ctx, { to: payload.email, subject, html });
    return null;
  },
});

// ── Guards ────────────────────────────────────────────────────────────────────

/** Guard: a monthly pledge is a whole number of cents at/above the $5 floor. */
function assertPledgeFloor(amountCents: number): void {
  if (!Number.isInteger(amountCents) || amountCents < PLEDGE_FLOOR_CENTS) {
    throw new ConvexError({
      code: "INVALID_AMOUNT",
      message: "A monthly pledge must be at least $5.",
    });
  }
}

// ── Derived backer count ──────────────────────────────────────────────────────

/**
 * Recompute + persist a chapter's derived `backerCount`: the count of `active`
 * pledges scoped to the chapter whose `amountCents >= BACKER_UNIT_CENTS`. This
 * is the ONLY writer of `chapters.backerCount` — the hand-set
 * `finances.setBackerCount` was deleted (see `recomputeAllBackerCounts` below
 * for what its last write cost us). Call it from EVERY path that inserts,
 * transitions, repoints, or deletes a pledge, so the affordability header, skim
 * math, and transfer automation read a truthful, live number.
 *
 * `central` has no `chapters.backerCount` to derive, so it's a no-op there.
 */
export async function recomputeChapterBackerCount(
  ctx: MutationCtx,
  scope: GivingScope,
): Promise<void> {
  if (scope === "central") return; // only real chapters carry a backer count
  const active = await ctx.db
    .query("pledges")
    .withIndex("by_scope_and_status", (q) =>
      q.eq("scope", scope).eq("status", "active"),
    )
    .take(BACKER_RECOUNT_LIMIT);
  // ── WHY `active` ONLY, AND WHY `past_due` DOES NOT COUNT ───────────────────
  // A backer count is a PROMISE OF RECURRING MONEY ARRIVING, not a headcount of
  // people who once said yes. Two user-facing surfaces make that promise out
  // loud, and both would lie if this predicate were any looser:
  //
  //  - The public give page prints "{backerCount} of {targetBackers} backers"
  //    under "Monthly backers funding the team that will launch this chapter"
  //    (`lib/givePage.ts`), and invites the reader to "Become a backer at
  //    $50/mo". That sentence claims a chapter is funded.
  //  - The milestone ladder prints "{N} more backers guarantee {commitment}"
  //    (`lib/givePage.ts`) — crossing a rung UNLOCKS a commitment the org then
  //    owes a city.
  //
  // A `past_due` pledge is a subscription whose payment FAILED. No money is
  // arriving. Counting it would let a chapter unlock a guaranteed commitment on
  // money that isn't coming, and would tell the public a city is funded when it
  // is not. Same logic excludes `incomplete` (checkout never finished),
  // `canceled` (over), and `paused` (a deliberate hold — see `setPledgeStatus`).
  //
  // The amount floor is the same promise in dollars: below BACKER_UNIT_CENTS
  // ($50/mo) the giver is a real, valued DONOR but not a BACKER, because the
  // affordability tiers price a backer at exactly one unit (PRD Appendix C#2).
  //
  // Consequence, stated plainly: an imported Givebutter recurrence lands
  // `past_due` (its card can't be ported) and contributes ZERO until that donor
  // re-signs on our Stripe rails. New York's honest number is 0, not 2.
  const count = active.filter((p) => p.amountCents >= BACKER_UNIT_CENTS).length;
  await ctx.db.patch(scope, {
    backerCount: Math.max(0, count),
    backerCountUpdatedAt: Date.now(),
    // Legacy attribution from the deleted manual setter. A recompute is the
    // only authority now, so any surviving "edited by" stamp is a lie about who
    // owns this number — clear it whenever we rewrite the count.
    backerCountUpdatedBy: undefined,
  });
}

/**
 * Recompute every counter a pledge transition can move. With Territories, a
 * pledge ALWAYS scopes to a real chapter (a prospect territory's shadow chapter
 * or a live one), so this collapses to the chapter recompute — a no-op for
 * `"central"`, per `recomputeChapterBackerCount` above. (Pre-Territories
 * prospect-city pledges carried a `cityCampaignId`; migration 0029 re-scopes
 * those onto their chapter, so there's no separate campaign counter to move.)
 */
async function recomputePledgeCounters(
  ctx: MutationCtx,
  pledge: Doc<"pledges">,
): Promise<void> {
  await recomputeChapterBackerCount(ctx, pledge.scope);
}

/** A generous bound on the chapter walk in `recomputeAllBackerCounts` — the
 *  fleet is four cities plus shadow chapters, so this can only ever fire if
 *  something has gone very wrong upstream. */
const CHAPTER_SCAN_LIMIT = 1000;

/**
 * Re-derive `chapters.backerCount` for EVERY chapter, and report/fix drift.
 *
 * ── WHAT DRIFTED, AND WHY ───────────────────────────────────────────────────
 * New York's stored count read 2 while its derived count was 0. Two independent
 * faults produced that, and it took both:
 *
 *  1. A SECOND WRITER. `finances.setBackerCount` let a human hand-write the
 *     number; someone wrote 2 on 2026-07-17 (the chapter doc still carried the
 *     `backerCountUpdatedBy` stamp). Its own doc comment admitted the two
 *     writers "must not be used in parallel long-term". They were.
 *  2. NO RECOMPUTE ON INSERT. New York's only pledges — 3 Givebutter
 *     recurrences imported 2026-07-19 as `past_due` — were INSERTED, never
 *     transitioned. `recomputeChapterBackerCount` fired only on status/amount
 *     transitions, so it had never once run for New York, and the hand-set 2
 *     simply sat there for three weeks telling the public a city was 10% funded
 *     on money that had already failed to arrive.
 *
 * The manual setter is gone and every insert/repoint/delete path now recomputes,
 * so nothing can drift this way again. This tool exists for what ALREADY did.
 *
 * ── THIS IS NOT A THROWAWAY ─────────────────────────────────────────────────
 * Unlike `reverseBadSettlement.ts` (a one-off keyed to specific rows, deleted
 * once run), this is a STANDING repair tool: it names no chapter, no date, and
 * no amount — it just asks every chapter whether its stored number still equals
 * its derived one. Keep it. It is the answer to "is the backer count honest?",
 * and there was no way to ask that question before.
 *
 * ── DISCIPLINE (house one-off shape) ────────────────────────────────────────
 * `execute` omitted/false is a DRY RUN: zero writes, and it reports exactly what
 * a real run would do. Preconditions SKIP rather than write a number we don't
 * trust — a chapter with more active pledges than `BACKER_RECOUNT_LIMIT` would
 * derive a TRUNCATED count, which is worse than the stale one, so it is reported
 * and left alone. Idempotent: a second run reports `drifted: 0`.
 */
export const recomputeAllBackerCounts = internalMutation({
  args: { execute: v.optional(v.boolean()) },
  returns: v.object({
    dryRun: v.boolean(),
    chaptersChecked: v.number(),
    drifted: v.number(),
    fixed: v.number(),
    chapters: v.array(
      v.object({
        chapter: v.string(),
        stored: v.number(),
        derived: v.number(),
        willFix: v.boolean(),
      }),
    ),
    problems: v.array(v.string()),
  }),
  handler: async (ctx, { execute }) => {
    const write = execute ?? false;
    const problems: string[] = [];
    const report: {
      chapter: string;
      stored: number;
      derived: number;
      willFix: boolean;
    }[] = [];

    // Deliberately NOT `listActiveChapters`: a prospect territory's shadow
    // chapter is inactive by design and is exactly where a public "N of M
    // backers" promise gets rendered, so it must be repaired too. This is a
    // repair tool, not a fleet surface — the `isActive` gate doesn't apply.
    const chapters = await ctx.db.query("chapters").take(CHAPTER_SCAN_LIMIT);
    if (chapters.length === CHAPTER_SCAN_LIMIT) {
      problems.push(
        `hit the ${CHAPTER_SCAN_LIMIT}-chapter scan cap — later chapters were NOT checked`,
      );
    }

    // `central` is a real pledge scope but carries no `chapters` row and no
    // backer count, so there is nothing to derive there. Say so out loud rather
    // than silently ignoring pledges the operator can see in the table.
    const centralPledge = await ctx.db
      .query("pledges")
      .withIndex("by_scope_and_status", (q) => q.eq("scope", "central"))
      .first();
    if (centralPledge) {
      problems.push(
        "scope 'central' holds pledges but carries no backerCount — SKIPPED",
      );
    }

    let drifted = 0;
    let fixed = 0;
    for (const chapter of chapters) {
      const stored = chapter.backerCount ?? 0;
      // One more than the bound the live recompute uses: if we get that many
      // back, the live recompute would truncate and this number is a guess.
      const active = await ctx.db
        .query("pledges")
        .withIndex("by_scope_and_status", (q) =>
          q.eq("scope", chapter._id).eq("status", "active"),
        )
        .take(BACKER_RECOUNT_LIMIT + 1);
      if (active.length > BACKER_RECOUNT_LIMIT) {
        problems.push(
          `${chapter.name}: more than ${BACKER_RECOUNT_LIMIT} active pledges — a derived count would be truncated — SKIPPED`,
        );
        continue;
      }
      const derived = active.filter(
        (p) => p.amountCents >= BACKER_UNIT_CENTS,
      ).length;
      const isDrifted = derived !== stored;
      if (isDrifted) drifted += 1;
      report.push({
        chapter: chapter.name,
        stored,
        derived,
        willFix: isDrifted,
      });
      if (isDrifted && write) {
        await ctx.db.patch(chapter._id, {
          backerCount: derived,
          backerCountUpdatedAt: Date.now(),
          // The hand-set attribution goes with the hand-set number.
          backerCountUpdatedBy: undefined,
        });
        fixed += 1;
      }
    }

    return {
      dryRun: !write,
      // Every chapter this run asked about, including any it SKIPPED — a
      // skipped chapter that vanished from the count would make the tool look
      // like it had checked fewer books than it opened.
      chaptersChecked: chapters.length,
      drifted,
      fixed,
      chapters: report,
      problems,
    };
  },
});

/** Resolve a pledge by its Stripe subscription id (webhook object → pledge). */
async function pledgeBySubscription(
  ctx: MutationCtx,
  subscriptionId: string,
): Promise<Doc<"pledges"> | null> {
  if (!subscriptionId) return null;
  return await ctx.db
    .query("pledges")
    .withIndex("by_stripe_subscription", (q) =>
      q.eq("stripeSubscriptionId", subscriptionId),
    )
    .unique();
}

/** Map a Stripe subscription `status` onto our pledge status; unknown Stripe
 *  states leave the pledge where it is (`fallback`). */
function mapStripeSubStatus(
  stripeStatus: string,
  fallback: PledgeStatus,
): PledgeStatus {
  switch (stripeStatus) {
    case "active":
    case "trialing":
      return "active";
    case "past_due":
    case "unpaid":
      return "past_due";
    case "canceled":
    case "incomplete_expired":
      return "canceled";
    case "incomplete":
      return "incomplete";
    default:
      return fallback;
  }
}

// ── Public: subscribe ─────────────────────────────────────────────────────────

/**
 * Validate a backer signup and create an `incomplete` pledge (+ match-or-create
 * the donor). Called by `startPledgeCheckout` right before Stripe. Mirrors
 * `giving.prepareDonation`.
 *
 * A pledge ALWAYS backs a real chapter (`chapterId`) — a territory maps 1:1
 * with a chapter, and a prospect territory's shadow chapter is a real
 * (inactive) `chapters` row that donors/pledges/gifts scope DIRECTLY to (the
 * old "central + cityCampaignId" convention is gone). Guard: an INACTIVE
 * chapter is only backable if it has a `publiclyVisible` territory still in
 * `prospect`/`raising` (its shadow-chapter phase) — otherwise it's NOT_FOUND,
 * so a random inactive/demo chapter can't be pledged to.
 */
export const preparePledge = triggerInternalMutation({
  args: {
    chapterId: v.id("chapters"),
    amountCents: v.number(),
    name: v.string(),
    email: v.string(),
  },
  handler: async (ctx, args) => {
    assertPledgeFloor(args.amountCents);
    const name = args.name.trim();
    const email = normalizeEmail(args.email);
    if (!name || !email || !email.includes("@")) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: "A name and valid email are required.",
      });
    }

    const chapter = await ctx.db.get(args.chapterId);
    if (!chapter) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "That territory isn't available for backing.",
      });
    }

    // A territory maps 1:1 with the chapter (present for prospect + launched
    // alike); its slug is the return-URL segment for the /give thank-you.
    const territory = await territoryForChapter(ctx, args.chapterId);

    // An inactive (shadow) chapter is only backable through a visible,
    // still-raising territory — never a bare inactive/demo chapter.
    if (chapter.isActive === false) {
      if (
        !territory ||
        !territory.publiclyVisible ||
        (territory.stage !== "prospect" && territory.stage !== "raising")
      ) {
        throw new ConvexError({
          code: "NOT_FOUND",
          message: "That territory isn't available for backing.",
        });
      }
    }

    const scope: GivingScope = args.chapterId;
    const territorySlug =
      territory && territory.publiclyVisible ? territory.slug : undefined;
    // A shadow-chapter (prospect-territory) backer came off the public map;
    // a live-chapter backer is a direct signup.
    const source: Doc<"donors">["source"] =
      chapter.isActive === false ? "map" : "manual";

    const donorId = await matchOrCreateDonor(ctx, {
      scope,
      name,
      email,
      source,
    });
    // No `recomputeChapterBackerCount` here, deliberately: an `incomplete`
    // pledge is a checkout that hasn't finished, and the derive counts `active`
    // only — so this insert cannot move the number. The very next event
    // (`activatePledgeFromCheckout`) recomputes. Contrast the IMPORT paths,
    // which insert `past_due` rows that likewise can't count but land in
    // chapters whose stored number may already be wrong, and so must recompute.
    const pledgeId = await ctx.db.insert("pledges", {
      donorId,
      scope,
      amountCents: args.amountCents,
      status: "incomplete",
      origin: "stripe",
      createdAt: Date.now(),
    });
    // Lifecycle history starts here (system-authored — the public checkout flow).
    await writePledgeEvent(ctx, {
      pledgeId,
      scope,
      kind: "created",
      to: PLEDGE_STATUS_LABELS.incomplete,
    });
    return {
      pledgeId,
      amountCents: args.amountCents,
      chapterName: chapter.name,
      territorySlug,
    };
  },
});

/**
 * PUBLIC entry point for the become-a-backer flow (no auth — like
 * `createDonationCheckout`). Creates an `incomplete` pledge, then a Stripe
 * Checkout Session in `mode=subscription` with an inline monthly recurring
 * price. `metadata.pledgeId` is set on BOTH the session (for
 * `checkout.session.completed`) and the subscription (`subscription_data`), so
 * every downstream subscription event resolves back to this pledge.
 *
 * Always backs a real chapter — see `preparePledge`. The public `/give/<slug>`
 * route resolves the slug to its chapter id
 * (`territories.resolveTerritoryForCheckout`) before calling this.
 */
export const startPledgeCheckout = action({
  args: {
    chapterId: v.id("chapters"),
    amountCents: v.number(),
    name: v.string(),
    email: v.string(),
    // Wave 2 (F6, activity wall): opt in to a public, PII-free echo of this
    // backing on the territory's `/give/<slug>` activity wall — see
    // `givingActivity.ts`. All three are optional and additive; omitting them
    // (the pre-wave-2 client) behaves exactly as before.
    shareOnWall: v.optional(v.boolean()),
    publicName: v.optional(v.string()),
    message: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ url: string }> => {
    const prepared: {
      pledgeId: Id<"pledges">;
      amountCents: number;
      chapterName: string;
      territorySlug?: string;
    } = await ctx.runMutation(internal.givingPledges.preparePledge, {
      chapterId: args.chapterId,
      amountCents: args.amountCents,
      name: args.name,
      email: args.email,
    });

    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) {
      throw new ConvexError({
        code: "PAYMENTS_NOT_CONFIGURED",
        message: "Backing isn't available yet — payments are still being set up.",
      });
    }

    // Return to the site with a thank-you state. A territory-backed pledge
    // returns to its own `/give/<slug>` page (which reads `?pledge=` to show
    // the thank-you banner); a chapter with no public territory falls back to
    // the site root.
    const base = siteUrl();
    const returnPath = prepared.territorySlug
      ? givePagePath(prepared.territorySlug)
      : "/";
    const body = new URLSearchParams();
    body.set("mode", "subscription");
    body.set("customer_email", args.email.trim().toLowerCase());
    body.set("success_url", `${base}${returnPath}?pledge=success`);
    body.set("cancel_url", `${base}${returnPath}?pledge=canceled`);
    body.set("metadata[pledgeId]", String(prepared.pledgeId));
    // Whether this backer agreed to appear on the public giving wall, carried
    // on the Stripe session so any settle-time consumer (the webhook fan-out,
    // the ACH comms) can answer "should we mention the wall to them?" without
    // re-reading our own tables. Always set — "0" is a recorded no, not a
    // silence to be interpreted.
    body.set("metadata[giveShowOnWall]", args.shareOnWall ? "1" : "0");
    // Inline recurring price — one monthly line, unit = the pledge amount.
    body.set("line_items[0][quantity]", "1");
    body.set("line_items[0][price_data][currency]", "usd");
    body.set(
      "line_items[0][price_data][unit_amount]",
      String(prepared.amountCents),
    );
    body.set("line_items[0][price_data][recurring][interval]", "month");
    body.set(
      "line_items[0][price_data][product_data][name]",
      `Monthly backer — ${prepared.chapterName}`,
    );
    // Propagate the pledge id onto the subscription so subscription.* webhooks
    // (which carry no session) can also resolve to this pledge.
    body.set("subscription_data[metadata][pledgeId]", String(prepared.pledgeId));

    const response = await fetch(`${STRIPE_API}/checkout/sessions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    if (!response.ok) {
      console.error("[stripe] pledge session failed:", await response.text());
      throw new ConvexError({
        code: "STRIPE_ERROR",
        message: "Couldn't start backing. Please try again.",
      });
    }
    const session = (await response.json()) as { id: string; url: string };

    // Wave 2 (F6, activity wall), recomposed by give-redesign-v3 (D6): record
    // a PENDING wall entry — never shown until the webhook settles it
    // (`markActivityVisible`), so an abandoned checkout never reaches the wall.
    // A pledge always backs a real chapter (never `"central"` — see
    // `preparePledge`), so `kind` is always `"backer"` here.
    //
    // UNCONDITIONAL NOW. `shareOnWall` used to gate whether the row existed at
    // all, which meant a new backer who didn't want their name printed didn't
    // count on a page whose hero is "back a city". It gates ATTRIBUTION only:
    // the backing posts either way, and `getPublicWall` decides on every read
    // whether it carries a name.
    await ctx.runMutation(internal.givingActivity.recordPendingActivity, {
      refKey: String(prepared.pledgeId),
      scope: args.chapterId,
      kind: "backer",
      amountCents: prepared.amountCents,
      ...(args.publicName ? { displayName: args.publicName } : {}),
      ...(args.message ? { message: args.message } : {}),
      // "May we name you?" — the backer's explicit answer, carried through
      // rather than inferred. A `false` is a recorded no, not a silence.
      consent: args.shareOnWall === true,
      // "…on a page search engines can find?" — see the matching comment in
      // `givingDonations.startGiveDonationCheckout`: the flag is a claim about
      // what the consent copy told them, so it tracks that copy.
      consentIndexable: args.shareOnWall === true,
    });

    return { url: session.url };
  },
});

// ── Webhook handlers (internal, idempotent, wired into /stripe/webhook) ───────

/**
 * Activate a pledge from `checkout.session.completed`, linking the Stripe
 * customer + subscription. Resolves the pledge by the session's
 * `metadata.pledgeId` (via `normalizeId`, so a ticket/donation session — which
 * carries none — is a safe no-op). Idempotent on webhook redelivery.
 */
export const activatePledgeFromCheckout = internalMutation({
  args: {
    pledgeId: v.string(),
    stripeCustomerId: v.optional(v.string()),
    stripeSubscriptionId: v.optional(v.string()),
    currentPeriodEnd: v.optional(v.number()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const pledgeId = ctx.db.normalizeId("pledges", args.pledgeId);
    if (!pledgeId) return false; // not one of our pledge sessions — safe no-op
    const pledge = await ctx.db.get(pledgeId);
    if (!pledge) return false;
    // Idempotent: a redelivered completion doesn't re-transition or re-count.
    if (pledge.status === "active" && pledge.stripeSubscriptionId) return true;

    await ctx.db.patch(pledgeId, {
      status: "active",
      ...(args.stripeCustomerId
        ? { stripeCustomerId: args.stripeCustomerId }
        : {}),
      ...(args.stripeSubscriptionId
        ? { stripeSubscriptionId: args.stripeSubscriptionId }
        : {}),
      ...(args.currentPeriodEnd ? { currentPeriodEnd: args.currentPeriodEnd } : {}),
      startedAt: pledge.startedAt ?? Date.now(),
    });
    if (pledge.status !== "active") {
      await logPledgeStatus(ctx, pledge, pledge.status, "active");
    }
    await recomputePledgeCounters(ctx, pledge);
    // THE MOMENT SOMEBODY BECOMES A BACKER — welcome them, and tell the desk.
    // Claimed rather than simply called, because `invoice.paid` can beat this
    // event to it and means the same thing; see `claimBackerAnnouncement`.
    await claimBackerAnnouncement(ctx, pledge);
    return true;
  },
});

/**
 * Record ONE `gifts` row per paid billing cycle (`invoice.paid`), resolving the
 * pledge by the invoice's subscription id (no-op for a subscription that isn't
 * ours). Idempotent on `stripeInvoiceId` — a redelivered invoice inserts
 * nothing. The amount is read from the invoice's `amount_paid` (never a client
 * value). Bumps the donor + scope CRM rollups via the shared primitive, recovers
 * a `past_due` pledge to `active`, and schedules a receipt email.
 */
export const recordPledgeInvoice = internalMutation({
  args: {
    subscriptionId: v.string(),
    invoiceId: v.string(),
    amountPaidCents: v.number(),
    currentPeriodEnd: v.optional(v.number()),
    // Out-of-order guard (finding A): when the subscription can't be resolved
    // to a pledge yet — an `invoice.paid` that raced ahead of the
    // `checkout.session.completed` that links the subscription — schedule a
    // one-shot recovery (`recoverPledgeInvoice`) that links the pledge from the
    // subscription's `metadata.pledgeId` and re-records this invoice. The
    // recovery's own re-call passes `false` so it can never loop.
    attemptRecovery: v.optional(v.boolean()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const pledge = await pledgeBySubscription(ctx, args.subscriptionId);
    if (!pledge) {
      // Not linked to a pledge (yet). Kick off metadata-based recovery unless
      // this IS the recovery's terminal re-call. A truly foreign subscription
      // (no pledgeId metadata) is a clean no-op inside the recovery action.
      if (args.attemptRecovery !== false) {
        await ctx.scheduler.runAfter(
          0,
          internal.givingPledges.recoverPledgeInvoice,
          {
            subscriptionId: args.subscriptionId,
            invoiceId: args.invoiceId,
            amountPaidCents: args.amountPaidCents,
            ...(args.currentPeriodEnd
              ? { currentPeriodEnd: args.currentPeriodEnd }
              : {}),
          },
        );
      }
      return false; // safe no-op for now — recovery makes the real decision
    }

    // Idempotent on the invoice id — exactly one gift per billing cycle.
    const existing = await ctx.db
      .query("gifts")
      .withIndex("by_stripeInvoice", (q) =>
        q.eq("stripeInvoiceId", args.invoiceId),
      )
      .first();
    if (existing) return true;

    // Trust only the invoice's own amount. A zero/negative/non-integer amount
    // (a $0 proration or a malformed payload) records no gift but still no-ops
    // cleanly.
    if (args.amountPaidCents > 0 && Number.isInteger(args.amountPaidCents)) {
      const giftId = await recordGiftForDonor(ctx, {
        donorId: pledge.donorId,
        amountCents: args.amountPaidCents,
        receivedAt: Date.now(),
        method: "stripe",
        pledgeId: pledge._id,
        stripeInvoiceId: args.invoiceId,
        note: "Monthly backer gift",
      });
      // ── THE FIRST CYCLE GETS A WELCOME; EVERY CYCLE AFTER IT GETS A RECEIPT ──
      //
      // Never both. Two emails in the same minute about the same $50 — one
      // saying "welcome, this matters enormously" and one saying "your monthly
      // gift came through" — is how a thank-you gets read as an auto-reply. The
      // welcome carries the receipt's facts (amount, first month received, how
      // to change it) precisely so it can stand in for it once.
      //
      // "First cycle" is asked of the LEDGER, not of the pledge's status: the
      // gift above is already written, so a `by_pledge` read of two rows answers
      // "is this the only gift this pledge has ever produced?" — which is true
      // exactly once, whatever order Stripe delivered the events in, and stays
      // true for a pledge whose checkout event never arrived at all.
      const priorCycles = await ctx.db
        .query("gifts")
        .withIndex("by_pledge", (q) => q.eq("pledgeId", pledge._id))
        .take(2);
      if (priorCycles.length <= 1) {
        // The claim settles the race with `activatePledgeFromCheckout`, which
        // means the same thing and can arrive either side of this. Whether this
        // call wins it or finds it already won, the outcome for this cycle is
        // the same and is deliberate: the welcome is the email, and no receipt
        // follows it.
        await claimBackerAnnouncement(ctx, pledge);
      } else {
        await ctx.scheduler.runAfter(
          0,
          internal.ticketingEmails.sendPledgeReceiptEmail,
          { giftId },
        );
      }
    }

    // A paid cycle recovers a past_due pledge and refreshes the period end.
    // A manually `paused` pledge is NOT auto-resumed by a stray paid cycle — the
    // gift above is still recorded (money is money), but the owner's deliberate
    // pause holds until they resume it or cancel in Stripe (see setPledgeStatus's
    // "Stripe interaction" note). A `canceled` pledge is terminal.
    const patch: Partial<Doc<"pledges">> = {};
    if (
      pledge.status !== "active" &&
      pledge.status !== "canceled" &&
      pledge.status !== "paused"
    ) {
      patch.status = "active";
    }
    if (args.currentPeriodEnd && args.currentPeriodEnd !== pledge.currentPeriodEnd) {
      patch.currentPeriodEnd = args.currentPeriodEnd;
    }
    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(pledge._id, patch);
      if (patch.status) {
        await logPledgeStatus(ctx, pledge, pledge.status, patch.status);
        await recomputePledgeCounters(ctx, pledge);
      }
    }
    return true;
  },
});

/**
 * Out-of-order recovery for `invoice.paid` (finding A). Stripe does NOT
 * guarantee event ordering, so an `invoice.paid` can be delivered BEFORE the
 * `checkout.session.completed` that links a pledge's Stripe subscription — in
 * which case `recordPledgeInvoice` can't resolve the subscription and would
 * otherwise drop the first cycle's gift for good.
 *
 * This one-shot action (scheduled by `recordPledgeInvoice` only when no pledge
 * resolves) closes that race WITHOUT touching the shared `/stripe/webhook`
 * fan-out: it fetches the subscription from the Stripe REST API, reads the
 * `metadata.pledgeId` that `startPledgeCheckout` stamps via
 * `subscription_data[metadata]`, links + activates the pledge through the SAME
 * `activatePledgeFromCheckout` the session path uses (so the two land in either
 * order, idempotently), then re-records the invoice with `attemptRecovery:
 * false` (terminal — never re-schedules). A subscription with no `pledgeId`
 * metadata isn't ours: a clean no-op.
 */
export const recoverPledgeInvoice = internalAction({
  args: {
    subscriptionId: v.string(),
    invoiceId: v.string(),
    amountPaidCents: v.number(),
    currentPeriodEnd: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) return null; // payments not configured — nothing to recover

    const response = await fetch(
      `${STRIPE_API}/subscriptions/${encodeURIComponent(args.subscriptionId)}`,
      { headers: { Authorization: `Bearer ${secretKey}` } },
    );
    if (!response.ok) {
      console.error(
        "[stripe] pledge invoice recovery — subscription fetch failed:",
        await response.text(),
      );
      return null;
    }
    const sub = (await response.json()) as {
      id: string;
      customer?: string | null;
      current_period_end?: number | null;
      metadata?: Record<string, string> | null;
    };
    const pledgeId = sub.metadata?.pledgeId;
    if (!pledgeId) return null; // not one of our subscriptions — safe no-op

    // Link + activate exactly as `checkout.session.completed` would (idempotent
    // — a later session-completed for the same pledge then no-ops).
    const linked: boolean = await ctx.runMutation(
      internal.givingPledges.activatePledgeFromCheckout,
      {
        pledgeId,
        ...(sub.customer ? { stripeCustomerId: sub.customer } : {}),
        stripeSubscriptionId: args.subscriptionId,
        ...(sub.current_period_end
          ? { currentPeriodEnd: sub.current_period_end * 1000 }
          : {}),
      },
    );
    if (!linked) return null; // the pledgeId didn't resolve — nothing to record

    // The subscription now resolves to a pledge — re-record the invoice. The
    // `attemptRecovery: false` guard makes this terminal (no re-schedule loop).
    const recorded: boolean = await ctx.runMutation(
      internal.givingPledges.recordPledgeInvoice,
      {
        subscriptionId: args.subscriptionId,
        invoiceId: args.invoiceId,
        amountPaidCents: args.amountPaidCents,
        ...(args.currentPeriodEnd
          ? { currentPeriodEnd: args.currentPeriodEnd }
          : {}),
        attemptRecovery: false,
      },
    );
    void recorded;
    return null;
  },
});

/** Move a pledge to `past_due` on `invoice.payment_failed` (Stripe Smart
 *  Retries handles the dunning). No-op for a non-pledge subscription. */
export const markPledgePastDue = internalMutation({
  args: { subscriptionId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const pledge = await pledgeBySubscription(ctx, args.subscriptionId);
    if (!pledge) return false;
    // A manually `paused` pledge isn't billing, so a dunning event doesn't move
    // it to past_due — the pause holds. `canceled` is terminal.
    if (
      pledge.status !== "past_due" &&
      pledge.status !== "canceled" &&
      pledge.status !== "paused"
    ) {
      await ctx.db.patch(pledge._id, { status: "past_due" });
      await logPledgeStatus(ctx, pledge, pledge.status, "past_due");
      await recomputePledgeCounters(ctx, pledge);
      // AND TELL THEM. Until this line, a declined card flipped the status,
      // dropped the chapter's public backer count and moved its milestone
      // ladder BACKWARDS on a page anyone can read — while the person whose
      // card it was heard nothing at all, sometimes until the cancellation
      // weeks later. Scheduled, so a mail failure can never fail the webhook
      // that recorded the decline (`givingNotifications.ts`'s module doc makes
      // the same argument for gifts).
      //
      // Only on the TRANSITION into past_due, which is what this branch
      // already is: Stripe retries a failed charge several times and each
      // retry re-delivers `invoice.payment_failed`, so mailing on every
      // delivery would be four emails about one decline. The weekly ladder
      // (rungs 2–4) is Phase 2 and needs a sweep of its own — see
      // `lib/backerPortalEmails.ts`.
      await ctx.scheduler.runAfter(
        0,
        internal.givingPledges.sendPaymentFailedEmail,
        { pledgeId: pledge._id },
      );
    }
    return true;
  },
});

/** Sync a pledge from `customer.subscription.updated`: status (active/past_due/
 *  canceled), current period end, and amount changes. No-op for a non-pledge. */
export const syncPledgeSubscription = internalMutation({
  args: {
    subscriptionId: v.string(),
    stripeStatus: v.string(),
    currentPeriodEnd: v.optional(v.number()),
    amountCents: v.optional(v.number()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const pledge = await pledgeBySubscription(ctx, args.subscriptionId);
    if (!pledge) return false;

    const mapped = mapStripeSubStatus(args.stripeStatus, pledge.status);
    // A manually `paused` pledge is a LOCAL overlay Stripe knows nothing about
    // (we don't pause_collection on the subscription — that's a documented
    // follow-up). So a benign `subscription.updated` that maps to `active`/
    // `past_due` must NOT clobber the pause; only a genuine Stripe `canceled`
    // overrides it (the subscription really ended). This is what keeps a manual
    // pause from "fighting the billing cycle" (owner feedback #5a).
    const status =
      pledge.status === "paused" && mapped !== "canceled" ? "paused" : mapped;
    const patch: Partial<Doc<"pledges">> = {};
    if (status !== pledge.status) patch.status = status;
    if (
      args.currentPeriodEnd &&
      args.currentPeriodEnd !== pledge.currentPeriodEnd
    ) {
      patch.currentPeriodEnd = args.currentPeriodEnd;
    }
    if (
      args.amountCents &&
      Number.isInteger(args.amountCents) &&
      args.amountCents !== pledge.amountCents
    ) {
      patch.amountCents = args.amountCents;
    }
    if (status === "canceled" && !pledge.canceledAt) {
      patch.canceledAt = Date.now();
    }
    if (Object.keys(patch).length === 0) return true;

    await ctx.db.patch(pledge._id, patch);
    if (patch.status !== undefined) {
      await logPledgeStatus(ctx, pledge, pledge.status, patch.status);
    }
    // A status or amount change can move a backer in/out of the derived count.
    if (patch.status !== undefined || patch.amountCents !== undefined) {
      await recomputePledgeCounters(ctx, pledge);
    }
    return true;
  },
});

/** Cancel a pledge on `customer.subscription.deleted`. No-op for a non-pledge. */
export const cancelPledgeSubscription = internalMutation({
  args: { subscriptionId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const pledge = await pledgeBySubscription(ctx, args.subscriptionId);
    if (!pledge) return false;
    if (pledge.status !== "canceled") {
      await ctx.db.patch(pledge._id, {
        status: "canceled",
        canceledAt: Date.now(),
      });
      await logPledgeStatus(ctx, pledge, pledge.status, "canceled");
      await recomputePledgeCounters(ctx, pledge);
    }
    return true;
  },
});

// ── Self-serve management (the backer portal + Stripe) ───────────────────────

/**
 * The pledge behind a portal request, PROVEN to belong to the caller.
 *
 * ── THIS REPLACED AN OPEN DOOR ─────────────────────────────────────────────
 * The old resolver took `{ email, chapterId }` from anybody and returned that
 * person's Stripe customer id, which `createPortalSession` then turned into a
 * live billing-portal link: card last four, invoice history, the cancel button.
 * Anyone who knew a backer's email address could mint it. It was unreachable
 * only because nothing linked to it — which is not a security control, it is an
 * absence of one, and the moment the portal shipped it would have become a real
 * hole. It is closed here, in the same change that gives the portal a door.
 *
 * The proof is the session: `requireBackerSession` resolves the token to a set
 * of `donors` rows (every book the proven email gives in), and the pledge must
 * belong to one of them. A session for one person can therefore never reach
 * another person's subscription, whatever id the client posts.
 */
async function pledgeForSession(
  ctx: QueryCtx,
  sessionToken: string,
  pledgeId: Id<"pledges">,
): Promise<Doc<"pledges">> {
  const session = await requireBackerSession(ctx, sessionToken);
  requireBackerModule(session, "backing");
  const pledge = await ctx.db.get(pledgeId);
  // ONE MESSAGE FOR BOTH CASES — "no such pledge" and "not yours" are the same
  // sentence on purpose, so this can't be used to test whether a pledge id
  // exists.
  if (!pledge || !session.donorIds.includes(pledge.donorId)) {
    throw new ConvexError({
      code: "NOT_FOUND",
      message: "We couldn't find that monthly gift on your record.",
    });
  }
  return pledge;
}

/** The Stripe customer behind one of the caller's own pledges, or `null` when
 *  it has none (an imported pledge that never moved onto our rails). */
export const portalCustomerForSession = internalQuery({
  args: { sessionToken: v.string(), pledgeId: v.id("pledges") },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    const pledge = await pledgeForSession(ctx, args.sessionToken, args.pledgeId);
    return pledge.stripeCustomerId ?? null;
  },
});

/** The Stripe subscription behind one of the caller's own pledges, for the
 *  cancel flow. Same proof, same refusal. */
export const subscriptionForSession = internalQuery({
  args: { sessionToken: v.string(), pledgeId: v.id("pledges") },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    const pledge = await pledgeForSession(ctx, args.sessionToken, args.pledgeId);
    return pledge.stripeSubscriptionId ?? null;
  },
});

/**
 * Open a Stripe-hosted billing flow for one of the caller's own pledges — the
 * card, or the cancellation. We never store card data and never build a card
 * UI; that half of the job is Stripe's and stays Stripe's.
 *
 * The AMOUNT is deliberately not among the flows offered here — see the
 * `flow_data` comment in the body, and `changePledgeAmount` below.
 */
export const createPortalSession = action({
  args: {
    sessionToken: v.string(),
    pledgeId: v.id("pledges"),
    /** Which Stripe-hosted flow to open. See the `flow_data` comment below —
     *  the portal is entered for one job at a time, deliberately. */
    flow: v.union(v.literal("card"), v.literal("cancel")),
  },
  handler: async (ctx, args): Promise<{ url: string }> => {
    // THE SESSION IS THE AUTHORIZATION. See this function's doc — it used to
    // take `{ email, chapterId }` from anybody at all.
    const customerId: string | null = await ctx.runQuery(
      internal.givingPledges.portalCustomerForSession,
      { sessionToken: args.sessionToken, pledgeId: args.pledgeId },
    );
    if (!customerId) {
      throw new ConvexError({
        code: "NO_STRIPE_CUSTOMER",
        message:
          "This monthly gift isn't billed through us, so there's nothing to manage here.",
      });
    }
    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) {
      throw new ConvexError({
        code: "PAYMENTS_NOT_CONFIGURED",
        message: "Backing management isn't available yet.",
      });
    }
    const body = new URLSearchParams();
    body.set("customer", customerId);
    body.set("return_url", backerPortalUrl());
    // ── THE PORTAL IS ENTERED FOR ONE JOB AT A TIME ────────────────────────
    // AMOUNT CHANGES ARE NOT STRIPE'S TO TAKE. Stripe's portal has no
    // minimum-amount setting — the only lever is an allow-list of catalogue
    // `Price` objects, and `startPledgeCheckout` mints an INLINE ad-hoc price
    // per backer (`price_data`), so there is no catalogue to list. Left on the
    // default configuration, the portal's "update subscription" would happily
    // accept $5 and quietly drop somebody below the floor that makes them a
    // backer at all. `changePledgeAmount` below owns the amount instead, where
    // the rule can actually be enforced.
    //
    // `flow_data` rather than a stored `billing_portal.configuration`: a
    // configuration is dashboard state that has to be created, referenced by
    // id, and kept in sync across two Stripe accounts (test and live), and if
    // it ever drifts the failure is silent and expensive. A flow is decided
    // per session, here, in code that can be read.
    if (args.flow === "cancel") {
      const subscriptionId: string | null = await ctx.runQuery(
        internal.givingPledges.subscriptionForSession,
        { sessionToken: args.sessionToken, pledgeId: args.pledgeId },
      );
      if (!subscriptionId) {
        throw new ConvexError({
          code: "NO_SUBSCRIPTION",
          message: "There's no live subscription on this monthly gift to stop.",
        });
      }
      body.set("flow_data[type]", "subscription_cancel");
      body.set("flow_data[subscription_cancel][subscription]", subscriptionId);
    } else {
      body.set("flow_data[type]", "payment_method_update");
    }
    body.set("flow_data[after_completion][type]", "redirect");
    body.set(
      "flow_data[after_completion][redirect][return_url]",
      backerPortalUrl(),
    );
    const response = await fetch(`${STRIPE_API}/billing_portal/sessions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    if (!response.ok) {
      console.error("[stripe] portal session failed:", await response.text());
      throw new ConvexError({
        code: "STRIPE_ERROR",
        message: "Couldn't open the billing portal. Please try again.",
      });
    }
    const session = (await response.json()) as { url: string };
    return { url: session.url };
  },
});

/**
 * Parse a monthly amount as a human types it — "50", "$50", "1,200", "12.50" —
 * into integer cents.
 *
 * Off the DIGITS, never `Math.round(Number(x) * 100)`: `1.005 * 100` is
 * 100.49999999999999 in binary floating point and rounds DOWN, which on a
 * threshold field is exactly the off-by-one nobody ever finds. Same arithmetic,
 * and the same reasoning, as the notification-rules form's
 * `parseDollarsToCents`.
 */
export function parseMonthlyAmountCents(raw: string): number {
  const cleaned = raw.trim().replace(/^\$/, "").replace(/,/g, "").trim();
  const bad = new ConvexError({
    code: "INVALID_AMOUNT",
    message: "Enter a dollar amount, like 50.",
  });
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(cleaned)) throw bad;
  const [whole, fraction = ""] = cleaned.split(".");
  const centsPart = `${fraction}00`.slice(0, 2);
  const beyond = fraction.slice(2);
  let cents = Number(whole) * 100 + Number(centsPart);
  if (beyond.length > 0 && Number(beyond[0]) >= 5) cents += 1;
  if (!Number.isSafeInteger(cents)) throw bad;
  return cents;
}

/**
 * Decide whether a backer may move to a new monthly amount, and say why not.
 *
 * ── THE ONE RULE THE OWNER ASKED FOR, IN ONE PURE FUNCTION ─────────────────
 * "Make sure people can't update it under $50 or else they're not a backer."
 * Held here rather than at the call site so it is testable without Stripe, and
 * so the page, the API and the action can never disagree about it.
 *
 * It is a RATCHET, not a floor for everybody: somebody already at or above
 * `BACKER_UNIT_CENTS` cannot drop below it through this door, because doing so
 * silently removes them from a city's public backer count and from the
 * milestone ladder that count feeds — a consequence no amount field explains.
 * Somebody giving $30 a month is a real, supported, deliberately-distinguished
 * thing in this codebase (see `PLEDGE_FLOOR_CENTS`), and they can move freely
 * below the backer floor; they simply aren't counted as backers, which was
 * already true.
 *
 * Stopping altogether is not this function's business and never should be —
 * that is Stripe's cancel flow, one button away, with no minimum at all. The
 * rule must not become a trap.
 */
export function checkAmountChange(
  currentCents: number,
  nextCents: number,
): { ok: true } | { ok: false; message: string } {
  if (!Number.isInteger(nextCents) || nextCents < PLEDGE_FLOOR_CENTS) {
    return {
      ok: false,
      message: `A monthly gift is at least ${formatCents(PLEDGE_FLOOR_CENTS)}.`,
    };
  }
  if (currentCents >= BACKER_UNIT_CENTS && nextCents < BACKER_UNIT_CENTS) {
    return {
      ok: false,
      message: `Backers give ${formatCents(BACKER_UNIT_CENTS)} a month or more — going below that would take you out of your city's backer count. To stop your monthly gift altogether, use "Stop my monthly gift".`,
    };
  }
  if (nextCents === currentCents) {
    return { ok: false, message: "That's already your monthly amount." };
  }
  return { ok: true };
}

/**
 * Change a backer's monthly amount — OURS, not Stripe's.
 *
 * Stripe's billing portal cannot hold a minimum (no such setting exists; the
 * only lever is an allow-list of catalogue `Price` objects, and every pledge
 * here rides an inline ad-hoc price), so leaving amount changes to the portal
 * would mean a backer could quietly become a non-backer with no warning and no
 * record. Taking it ourselves costs one Stripe call and buys the rule.
 *
 * The subscription is updated with the SAME ad-hoc `price_data` shape
 * `startPledgeCheckout` creates, so there is no Price catalogue to build and no
 * migration for existing subscriptions. `proration_behavior=none` — a person
 * adjusting their monthly giving is not asking to be billed a strange amount
 * today; the new figure starts at the next cycle, which is what the page says.
 *
 * OUR ROW IS NOT PATCHED HERE. The `customer.subscription.updated` webhook is
 * the single writer of a pledge's amount (`syncPledgeSubscription`), and going
 * behind it would create the one state nobody can debug: a local amount that
 * disagrees with what Stripe will actually charge. If the webhook is delayed
 * the page shows the old figure for a moment, which is a cosmetic lag rather
 * than a lie.
 */
export const changePledgeAmount = action({
  args: {
    sessionToken: v.string(),
    pledgeId: v.id("pledges"),
    /** As typed — parsed and validated server-side, never trusted as cents. */
    amount: v.string(),
  },
  returns: v.object({ amountCents: v.number() }),
  handler: async (ctx, args): Promise<{ amountCents: number }> => {
    const nextCents = parseMonthlyAmountCents(args.amount);
    const pledge: {
      amountCents: number;
      status: string;
      stripeSubscriptionId: string | null;
    } = await ctx.runQuery(internal.givingPledges.pledgeForAmountChange, {
      sessionToken: args.sessionToken,
      pledgeId: args.pledgeId,
    });

    const verdict = checkAmountChange(pledge.amountCents, nextCents);
    if (!verdict.ok) {
      throw new ConvexError({ code: "AMOUNT_REFUSED", message: verdict.message });
    }
    if (!pledge.stripeSubscriptionId) {
      throw new ConvexError({
        code: "NO_SUBSCRIPTION",
        message:
          "This monthly gift isn't billed through us, so its amount can't be changed here.",
      });
    }
    if (pledge.status === "canceled") {
      throw new ConvexError({
        code: "PLEDGE_ENDED",
        message: "This monthly gift has ended. Start a new one to give again.",
      });
    }

    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) {
      throw new ConvexError({
        code: "PAYMENTS_NOT_CONFIGURED",
        message: "Backing management isn't available yet.",
      });
    }

    // The subscription's single item, re-priced. Stripe needs the item's id to
    // replace its price, so read the subscription first.
    const subRes = await fetch(
      `${STRIPE_API}/subscriptions/${pledge.stripeSubscriptionId}`,
      { headers: { Authorization: `Bearer ${secretKey}` } },
    );
    if (!subRes.ok) {
      console.error("[stripe] subscription read failed:", await subRes.text());
      throw new ConvexError({
        code: "STRIPE_ERROR",
        message: "Couldn't change the amount. Please try again.",
      });
    }
    const sub = (await subRes.json()) as {
      items?: { data?: { id: string }[] };
    };
    const itemId = sub.items?.data?.[0]?.id;
    if (!itemId) {
      throw new ConvexError({
        code: "STRIPE_ERROR",
        message: "Couldn't change the amount. Please try again.",
      });
    }

    const body = new URLSearchParams();
    body.set("items[0][id]", itemId);
    body.set("items[0][price_data][currency]", "usd");
    body.set("items[0][price_data][unit_amount]", String(nextCents));
    body.set("items[0][price_data][recurring][interval]", "month");
    body.set("items[0][price_data][product_data][name]", "Monthly backer");
    body.set("proration_behavior", "none");
    const updateRes = await fetch(
      `${STRIPE_API}/subscriptions/${pledge.stripeSubscriptionId}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secretKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      },
    );
    if (!updateRes.ok) {
      console.error("[stripe] amount change failed:", await updateRes.text());
      throw new ConvexError({
        code: "STRIPE_ERROR",
        message: "Couldn't change the amount. Please try again.",
      });
    }
    return { amountCents: nextCents };
  },
});

/** The three facts `changePledgeAmount` needs, behind the same session proof
 *  every other portal read uses. */
export const pledgeForAmountChange = internalQuery({
  args: { sessionToken: v.string(), pledgeId: v.id("pledges") },
  returns: v.object({
    amountCents: v.number(),
    status: v.string(),
    stripeSubscriptionId: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const pledge = await pledgeForSession(ctx, args.sessionToken, args.pledgeId);
    return {
      amountCents: pledge.amountCents,
      status: pledge.status,
      stripeSubscriptionId: pledge.stripeSubscriptionId ?? null,
    };
  },
});

// ── Admin reads (gated) ───────────────────────────────────────────────────────

/** Enrich a pledge row with its donor's name/email for list rendering. */
async function withDonor(ctx: QueryCtx, pledge: Doc<"pledges">) {
  const donor = await ctx.db.get(pledge.donorId);
  return {
    ...pledge,
    donorName: donor?.name ?? "Unknown",
    donorEmail: donor?.email ?? null,
  };
}

/** The scope's pledges (optionally one status), newest first — the Backers
 *  desk list. Gated by `requireGivingView` at the scope. */
export const listPledges = query({
  args: { scope: scopeValidator, status: v.optional(pledgeStatusValidator) },
  handler: async (ctx, { scope, status }) => {
    await requireGivingView(ctx, scope as GivingScope);
    const rows = status
      ? await ctx.db
          .query("pledges")
          .withIndex("by_scope_and_status", (q) =>
            q.eq("scope", scope).eq("status", status),
          )
          .order("desc")
          .take(PLEDGE_LIST_LIMIT)
      : await ctx.db
          .query("pledges")
          .withIndex("by_scope_and_status", (q) => q.eq("scope", scope))
          .order("desc")
          .take(PLEDGE_LIST_LIMIT);
    return await Promise.all(rows.map((p) => withDonor(ctx, p)));
  },
});

/** A donor's pledges (for the donor detail screen). Gated by the donor's scope. */
export const getDonorPledges = query({
  args: { donorId: v.id("donors") },
  handler: async (ctx, { donorId }) => {
    const donor = await ctx.db.get(donorId);
    if (!donor) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Donor not found." });
    }
    await requireGivingView(ctx, donor.scope);
    return await ctx.db
      .query("pledges")
      .withIndex("by_donor", (q) => q.eq("donorId", donorId))
      .order("desc")
      .take(DONOR_PLEDGE_LIMIT);
  },
});

// ── Manual backer management (owner feedback #5, giving-manage gated) ─────────

/**
 * Manually PAUSE or RESUME a backer's pledge (owner feedback #5a). A `paused`
 * pledge does NOT count toward the chapter's `backerCount` (the derived
 * predicate only counts `active` pledges, so paused is excluded automatically —
 * no predicate change needed) but STAYS in the backers list (history preserved).
 * Manage-gated at the pledge's scope; writes a `status` lifecycle event.
 *
 * Stripe interaction (owner feedback #5a "so a manual pause doesn't fight the
 * billing cycle"): `paused` is a LOCAL overlay — we do NOT call Stripe
 * `pause_collection` (a follow-up). To stop the subscription from re-flipping
 * the pledge, the webhook handlers treat `paused` as sticky: a benign
 * `subscription.updated` (→ active/past_due) and a dunning `payment_failed`
 * leave a paused pledge paused; a paid `invoice.paid` still records the gift but
 * doesn't auto-resume; only a genuine Stripe `canceled` overrides the pause.
 * So the subscription may keep charging in the background — the owner should
 * cancel in the Stripe portal to fully stop billing; the pause just removes the
 * backer from the count immediately.
 *
 * Allowed transitions: pause from `active`/`past_due`; resume (→ `active`) from
 * `paused`. `incomplete`/`canceled` are Stripe-owned terminal-ish states and
 * aren't manually toggled here.
 */
export const setPledgeStatus = mutation({
  args: {
    pledgeId: v.id("pledges"),
    status: v.union(v.literal("active"), v.literal("paused")),
    why: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { pledgeId, status, why }) => {
    const pledge = await ctx.db.get(pledgeId);
    if (!pledge) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Pledge not found." });
    }
    await requireGivingManage(ctx, pledge.scope as GivingScope);
    const actorUserId = (await requireUserId(ctx)) as Id<"users">;

    if (pledge.status === status) return null; // no-op

    if (status === "paused") {
      if (pledge.status !== "active" && pledge.status !== "past_due") {
        throw new ConvexError({
          code: "INVALID_TRANSITION",
          message: "Only an active or past-due pledge can be paused.",
        });
      }
    } else {
      // Resume → active, only from paused (never force-activate a Stripe state).
      if (pledge.status !== "paused") {
        throw new ConvexError({
          code: "INVALID_TRANSITION",
          message: "Only a paused pledge can be resumed.",
        });
      }
    }

    await ctx.db.patch(pledgeId, { status });
    await logPledgeStatus(ctx, pledge, pledge.status, status, {
      actorUserId,
      note: why,
    });
    await recomputePledgeCounters(ctx, { ...pledge, status });
    return null;
  },
});

/**
 * Correct a pledge's "Since" date (owner feedback #5b — his `startedAt` data is
 * inaccurate). Manage-gated; requires a `why`; writes a `startedAt` event. Does
 * NOT touch counters (the backer count doesn't depend on the start date).
 */
export const editPledgeStartedAt = mutation({
  args: {
    pledgeId: v.id("pledges"),
    startedAt: v.number(),
    why: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, { pledgeId, startedAt, why }) => {
    const pledge = await ctx.db.get(pledgeId);
    if (!pledge) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Pledge not found." });
    }
    await requireGivingManage(ctx, pledge.scope as GivingScope);
    const reason = why.trim();
    if (!reason) {
      throw new ConvexError({
        code: "REASON_REQUIRED",
        message: "Say why you're changing the start date.",
      });
    }
    const actorUserId = (await requireUserId(ctx)) as Id<"users">;
    if (pledge.startedAt === startedAt) return null; // no-op

    await ctx.db.patch(pledgeId, { startedAt });
    await writePledgeEvent(ctx, {
      pledgeId,
      scope: pledge.scope as GivingScope,
      kind: "startedAt",
      from: pledge.startedAt
        ? new Date(pledge.startedAt).toLocaleDateString()
        : "—",
      to: new Date(startedAt).toLocaleDateString(),
      actorUserId,
      note: reason,
    });
    return null;
  },
});

/**
 * Delete a pledge (owner feedback #5c). Manage-gated; requires a `why`. Writes a
 * `deleted` lifecycle event carrying a SNAPSHOT (amount / status) + the reason
 * BEFORE the row is gone, then removes it and recomputes the backer count.
 *
 * NOTE: paid billing cycles already wrote their own `gifts` rows (with
 * `pledgeId` set) — those STAY as giving history; deleting the pledge only drops
 * the subscription-state row, not the money the backer actually gave.
 */
export const deletePledge = mutation({
  args: { pledgeId: v.id("pledges"), why: v.string() },
  returns: v.null(),
  handler: async (ctx, { pledgeId, why }) => {
    const pledge = await ctx.db.get(pledgeId);
    if (!pledge) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Pledge not found." });
    }
    await requireGivingManage(ctx, pledge.scope as GivingScope);
    const reason = why.trim();
    if (!reason) {
      throw new ConvexError({
        code: "REASON_REQUIRED",
        message: "Say why you're deleting this pledge.",
      });
    }
    const actorUserId = (await requireUserId(ctx)) as Id<"users">;

    await writePledgeEvent(ctx, {
      pledgeId,
      scope: pledge.scope as GivingScope,
      kind: "deleted",
      from: `${auditCents(pledge.amountCents)}/mo · ${
        PLEDGE_STATUS_LABELS[pledge.status]
      }`,
      actorUserId,
      note: reason,
    });
    await ctx.db.delete(pledgeId);
    await recomputePledgeCounters(ctx, pledge);
    return null;
  },
});

/**
 * A pledge's lifecycle HISTORY (owner feedback #5d) — every status transition
 * (manual AND system/billing) + field edit, newest-first. `actor` is the desk
 * user's name, or "System" for a billing transition. Gated by the pledge's scope.
 */
export const pledgeHistory = query({
  args: { pledgeId: v.id("pledges") },
  handler: async (ctx, { pledgeId }) => {
    const pledge = await ctx.db.get(pledgeId);
    if (!pledge) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Pledge not found." });
    }
    await requireGivingView(ctx, pledge.scope as GivingScope);
    const rows = await ctx.db
      .query("pledgeEvents")
      .withIndex("by_pledge", (q) => q.eq("pledgeId", pledgeId))
      .order("desc")
      .take(GIVING_AUDIT_READ_CAP);
    const actorNames = new Map<string, string>();
    for (const id of new Set(
      rows
        .map((e) => e.actorUserId)
        .filter((id): id is Id<"users"> => id !== undefined),
    )) {
      const profile = await ctx.db
        .query("userProfiles")
        .withIndex("by_userId", (q) => q.eq("userId", id))
        .unique();
      actorNames.set(
        id,
        profile?.name ?? (await ctx.db.get(id))?.email ?? "Someone",
      );
    }
    return rows.map((e) => ({
      _id: e._id,
      at: e.at,
      kind: e.kind,
      from: e.from ?? null,
      to: e.to ?? null,
      note: e.note ?? null,
      actor: e.actorUserId ? actorNames.get(e.actorUserId) ?? "Someone" : "System",
    }));
  },
});

// Territories P6: the Givebutter-specific `importGivebutterRecurring` cutover
// tool (match-or-create donor + dedup an `origin:"imported"` pledge on
// externalRef within the donor's pledges) is SUPERSEDED by the canonical
// import's `recurring` row type (`givingImport.ts#importCanonical` — same
// dedup rule, ported verbatim) — see that file's header comment.

// ── Receipt payload ───────────────────────────────────────────────────────────

/** Receipt-email payload for a paid backer cycle (read by
 *  `ticketingEmails.sendPledgeReceiptEmail`). */
export const getPledgeReceiptPayload = internalQuery({
  args: { giftId: v.id("gifts") },
  returns: v.union(
    v.object({
      email: v.string(),
      name: v.string(),
      amountCents: v.number(),
      chapterName: v.union(v.string(), v.null()),
    }),
    v.null(),
  ),
  handler: async (ctx, { giftId }) => {
    const gift = await ctx.db.get(giftId);
    if (!gift) return null;
    const donor = await ctx.db.get(gift.donorId);
    if (!donor || !donor.email) return null;
    let chapterName: string | null = null;
    if (gift.scope !== "central") {
      const chapter = await ctx.db.get(gift.scope);
      chapterName = chapter?.name ?? null;
    }
    return {
      email: donor.email,
      name: donor.name,
      amountCents: gift.amountCents,
      chapterName,
    };
  },
});
