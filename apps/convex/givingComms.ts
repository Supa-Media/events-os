/**
 * What a donor HEARS when they give by bank transfer (ACH Debit).
 *
 * A card either works or it doesn't, in about a second. An ACH debit is a
 * different shape of promise: it is submitted, it settles about 2–4 business
 * days later, and it can still be returned after that. If we say nothing, the
 * donor's honest reading of the silence is "did that work?" — so there are
 * four moments and this file owns the words for all of them:
 *
 *  - `onAchSubmitted` — we have it, here's how long banks take, nothing to do.
 *  - `onAchSettled`   — it cleared.
 *  - `onAchFailed`    — it didn't, here's roughly why, here's how to retry.
 *  - `onAchReturned`  — it cleared, and then weeks later the bank took it back.
 *
 * The last two are NOT the same email and must not be merged. "It didn't go
 * through" and "you haven't been charged" are true for a debit that never
 * cleared and false for one that did — and the returned-gift donor is holding
 * an email from us that says it cleared.
 *
 * SEAM. The ACH payment LIFECYCLE (the `checkout.session.async_payment_*`
 * webhook branches, the `payment_status` gate, post-settlement returns) lives
 * elsewhere and is owned by other work. This file owns only the donor
 * communication, and the seam between them is these three entry points. They
 * are deliberately safe to call before, after, or entirely independent of that
 * lifecycle: each one re-derives everything it needs from the Stripe session
 * id alone and NO-OPS QUIETLY if it can't (no key configured, session gone,
 * not a give-donation session, donor deleted). A missing precondition must
 * never fail a webhook — the payment is the important thing; the email is not.
 *
 * The Stripe Checkout Session is the source of truth here rather than our own
 * tables, on purpose: at `onAchSubmitted` time the gift row does not exist yet
 * (nothing is booked until the debit settles), so there is nothing of ours to
 * read. `metadata.giveShowOnWall` — written at checkout-start by
 * `givingDonations`/`givingPledges` — is how we know whether the public giving
 * wall is even worth mentioning to this person.
 *
 * Transactional, not marketing: these are receipts for a payment the donor
 * just made, so they carry no unsubscribe footer and consult no suppression
 * list, matching every other receipt in this codebase (see `emailShell`'s
 * opt-in `bulk` argument for why that split is structural).
 */
import { v } from "convex/values";
import { internalAction, internalQuery } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { escapeHtml } from "./lib/html";
import { givePageUrl } from "./lib/siteUrl";
import {
  emailButton,
  emailCode,
  emailHeading,
  emailPanel,
  emailParagraph,
  emailShell,
} from "./lib/emailShell";
import { sendEmail } from "./ticketingEmails";

const STRIPE_API = "https://api.stripe.com/v1";

// ── Plain language for a bank's reason ───────────────────────────────────────

/**
 * Turn whatever Stripe hands us into a sentence a person can read.
 *
 * A donor should never see `R01`. Those codes mean something to a bank and
 * nothing to anyone else, and a bare code in a failure email reads like an
 * accusation you can't even parse. Anything unrecognised — and there are many
 * more ACH return codes than are worth enumerating — falls back to the generic
 * sentence rather than leaking the raw string.
 *
 * Kept deliberately non-accusatory. A failed bank debit is a typo or a timing
 * problem far more often than it is anything about the person.
 */
export function donorFacingAchFailureReason(reason?: string): string {
  const key = reason?.trim().toLowerCase() ?? "";
  switch (key) {
    case "insufficient_funds":
      return "There wasn't enough in the account when the transfer ran.";
    case "account_closed":
    case "bank_ownership_changed":
      return "The account the transfer came from is closed.";
    case "no_account":
    case "invalid_account_number":
    case "account_number_invalid":
    // Stripe's DISPUTE reason for the same thing. A post-settlement bank
    // return arrives as a dispute, not a payment failure, and it uses its own
    // vocabulary — without these two the late-return email falls back to the
    // generic sentence for the two most common reasons a return happens.
    case "incorrect_account_details":
      return "The account details didn't match an open account.";
    case "debit_not_authorized":
    case "authorization_revoked":
    case "unauthorized":
      return "The bank didn't have authorization for this debit.";
    case "payment_stopped":
    case "refer_to_customer":
      return "The payment was stopped before it went through.";
    case "account_frozen":
    case "bank_account_restricted":
    case "custom_account_verification_required":
      return "The account can't take this kind of transfer right now.";
    case "could_not_process":
    case "processing_error":
    case "bank_cannot_process":
      return "The bank couldn't process the transfer.";
    default:
      // Includes every raw ACH return code (R01, R07, …) and anything new
      // Stripe starts sending. Say something true and unhelpful rather than
      // something precise and unreadable.
      return "The bank couldn't complete the transfer.";
  }
}

// ── Shared lookup ────────────────────────────────────────────────────────────

const commsPayloadValidator = v.union(
  v.object({
    email: v.string(),
    name: v.string(),
    chapterName: v.union(v.string(), v.null()),
    slug: v.union(v.string(), v.null()),
  }),
  v.null(),
);

/**
 * Resolve the donor + territory behind a give checkout's metadata.
 *
 * `donorId`/`scope` arrive as raw strings off the Stripe session, so both go
 * through `normalizeId` rather than being trusted as ids — metadata is
 * attacker-adjacent (anyone can create a session against our publishable
 * surface) and a malformed value must return `null`, not throw inside a
 * webhook.
 *
 * `slug` is the territory's `/give/<slug>` segment, used to point a retry link
 * back at the page the donor actually gave from. `null` for a central gift,
 * which has no territory page — the caller falls back to the give map.
 */
export const getGiveCommsPayload = internalQuery({
  args: { donorId: v.string(), scope: v.string() },
  returns: commsPayloadValidator,
  handler: async (ctx, args) => {
    const donorId = ctx.db.normalizeId("donors", args.donorId);
    if (!donorId) return null;
    const donor = await ctx.db.get(donorId);
    if (!donor?.email) return null;

    let chapterName: string | null = null;
    let slug: string | null = null;
    const chapterId = ctx.db.normalizeId("chapters", args.scope);
    if (chapterId) {
      const chapter = await ctx.db.get(chapterId);
      chapterName = chapter?.name ?? null;
      const territory = await ctx.db
        .query("territories")
        .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
        .first();
      slug = territory?.slug ?? null;
    }

    return { email: donor.email, name: donor.name, chapterName, slug };
  },
});

// ── Stripe session read ──────────────────────────────────────────────────────

type GiveSessionContext = {
  email: string;
  firstName: string;
  amount: string;
  city: string;
  slug: string | null;
  /** The donor ticked "Show my name and gift amount on our public giving
   *  wall" at checkout. Drives whether the wall is mentioned at all — we do
   *  not raise the subject with someone who declined it. */
  showOnWall: boolean;
  /**
   * How much of `amount` the donor added to cover the processing fee, already
   * formatted — or `null` when they didn't cover.
   *
   * SAID OUT LOUD, because `amount` is the whole charge and the donor is
   * entitled to see the difference between it and the figure they typed
   * without doing arithmetic against their bank statement. The receipt that
   * prompted all this simply announced "your gift of $309.27" to somebody who
   * had typed 300 (#732).
   */
  coverage: string | null;
  refKey: string;
};

/** `$50` / `$47.50` — whole dollars when it divides evenly, matching every
 *  other receipt in this codebase. */
function formatAmount(amountCents: number): string {
  return `$${(amountCents / 100).toFixed(amountCents % 100 === 0 ? 0 : 2)}`;
}

/**
 * Everything the three emails need, derived from a Stripe session id.
 *
 * Returns `null` — never throws — for every "can't do this" case, so a caller
 * inside a webhook can `if (!ctx) return null;` and move on. The cases:
 * Stripe isn't configured, the session doesn't exist or Stripe errored, the
 * session isn't one of our give donations, or the donor behind it is gone.
 */
async function loadGiveSessionContext(
  ctx: ActionCtx,
  sessionId: string,
): Promise<GiveSessionContext | null> {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    console.log(`[givingComms] no Stripe key configured — skipping ${sessionId}`);
    return null;
  }

  const response = await fetch(
    `${STRIPE_API}/checkout/sessions/${encodeURIComponent(sessionId)}`,
    { headers: { Authorization: `Bearer ${secretKey}` } },
  );
  if (!response.ok) {
    console.error(
      `[givingComms] couldn't read session ${sessionId}: ${response.status}`,
    );
    return null;
  }

  const session = (await response.json()) as {
    amount_total?: number | null;
    customer_email?: string | null;
    metadata?: Record<string, string> | null;
  };
  const metadata = session.metadata ?? {};
  // Not one of ours (a ticket checkout, a sponsorship, anything else on the
  // same Stripe account) — silently not our business.
  if (metadata.giveDonation !== "1") return null;

  const payload = await ctx.runQuery(
    internal.givingComms.getGiveCommsPayload,
    {
      donorId: metadata.giveDonorId ?? "",
      scope: metadata.giveScope ?? "",
    },
  );

  // Fall back to the address Stripe collected if our donor row is gone; with
  // no address at all there is nobody to write to.
  const email = payload?.email ?? session.customer_email ?? null;
  if (!email) return null;

  // Only a positive, whole-cent figure strictly inside the charge is worth
  // repeating back; anything else is metadata we can't explain, and a
  // confusing sentence is worse than no sentence.
  const coverageCents = Number(metadata.giveCoverageCents ?? 0);
  const coverageIsSane =
    Number.isInteger(coverageCents) &&
    coverageCents > 0 &&
    coverageCents < (session.amount_total ?? 0);

  return {
    email,
    firstName: payload?.name.split(/\s+/)[0] || "friend",
    amount: formatAmount(session.amount_total ?? 0),
    city: payload?.chapterName ?? "Public Worship",
    slug: payload?.slug ?? null,
    showOnWall: metadata.giveShowOnWall === "1",
    coverage: coverageIsSane ? formatAmount(coverageCents) : null,
    refKey: `give:${sessionId}`,
  };
}

/**
 * Ask Stripe why the bank refused the debit.
 *
 * `checkout.session.async_payment_failed` carries the Session, and a Session
 * says only that the payment failed — the reason lives one level down, on the
 * PaymentIntent's `last_payment_error`. Without this lookup every ACH failure
 * email says the same generic sentence, and the whole reason table in
 * `donorFacingAchFailureReason` is unreachable code that looks alive.
 *
 * Best-effort by design: `undefined` on any problem, which lands the caller on
 * exactly that generic sentence. Nothing here is allowed to be the reason a
 * donor hears nothing at all. Separate from `loadGiveSessionContext` so the
 * submitted/settled paths — which have no failure to explain — don't pay for
 * an expansion they never read.
 */
async function fetchAchFailureCode(
  sessionId: string,
): Promise<string | undefined> {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) return undefined;
  const response = await fetch(
    `${STRIPE_API}/checkout/sessions/${encodeURIComponent(sessionId)}` +
      `?expand[]=payment_intent`,
    { headers: { Authorization: `Bearer ${secretKey}` } },
  );
  if (!response.ok) return undefined;
  const session = (await response.json()) as {
    payment_intent?:
      | string
      | null
      | { last_payment_error?: { code?: string | null } | null };
  };
  const intent = session.payment_intent;
  // Unexpanded (a bare `pi_…` string) or absent — nothing to read.
  if (!intent || typeof intent === "string") return undefined;
  return intent.last_payment_error?.code ?? undefined;
}

// ── 1. Submitted ─────────────────────────────────────────────────────────────

/**
 * The debit is submitted and the money is in flight.
 *
 * Sets the expectation the owner asked for: bank transfers take about 2–4
 * business days, that is normal, and there is nothing for the donor to do. The
 * wall sentence appears ONLY for a donor who actually opted in — for everyone
 * else it would be raising a subject they already declined.
 */
export const onAchSubmitted = internalAction({
  args: { sessionId: v.string() },
  returns: v.null(),
  handler: async (ctx, { sessionId }) => {
    const give = await loadGiveSessionContext(ctx, sessionId);
    if (!give) return null;

    await sendEmail(ctx, {
      to: give.email,
      subject: `Your gift to ${give.city} is on its way`,
      html: emailShell(`
      ${emailHeading(`Thanks, ${escapeHtml(give.firstName)} 🙏`, { size: 26 })}
      ${emailParagraph(
        `Your gift of <b>${give.amount}</b> to <b>${escapeHtml(give.city)}</b> is on its way. It's coming by bank transfer, and banks take about <b>2–4 business days</b> to clear one — so it won't show up as complete right away. That's normal, and there's nothing for you to do.`,
        { margin: "0 0 20px" },
      )}
      ${emailPanel(emailCode(give.amount), { dashed: true, center: true, margin: "0 0 20px" })}
      ${
        give.coverage
          ? emailParagraph(
              `That includes the <b>${give.coverage}</b> you added to cover the processing fee, so the whole of what you meant to give reaches us.`,
              { size: 13, margin: "0 0 20px" },
            )
          : ""
      }
      ${
        give.showOnWall
          ? emailParagraph(
              `You asked to be shown on our public giving wall. Your name won't appear there until the transfer clears.`,
              { margin: "0 0 20px" },
            )
          : ""
      }
      ${emailParagraph(
        `We'll email you the moment it lands. If something goes wrong on the way, we'll email you about that too — with a link to try again.`,
        { size: 13, margin: "0" },
      )}`),
    });
    return null;
  },
});

// ── 2. Settled ───────────────────────────────────────────────────────────────

/**
 * It cleared. Short on purpose — the donor already got the long email.
 *
 * The wall entry becoming eligible is done elsewhere (the settle fan-out flips
 * it); this only says so.
 */
export const onAchSettled = internalAction({
  args: { sessionId: v.string() },
  returns: v.null(),
  handler: async (ctx, { sessionId }) => {
    const give = await loadGiveSessionContext(ctx, sessionId);
    if (!give) return null;

    await sendEmail(ctx, {
      to: give.email,
      subject: `Your gift to ${give.city} cleared`,
      html: emailShell(`
      ${emailHeading(`Thank you, ${escapeHtml(give.firstName)} 🙏`, { size: 26 })}
      ${emailParagraph(
        `Your gift of <b>${give.amount}</b> to <b>${escapeHtml(give.city)}</b> cleared. That's everything — nothing else to do.`,
        { margin: "0 0 20px" },
      )}
      ${emailPanel(emailCode(give.amount), { dashed: true, center: true, margin: "0" })}
      ${
        give.coverage
          ? emailParagraph(
              `That includes the <b>${give.coverage}</b> you added to cover the processing fee, so the whole of what you meant to give reaches us. Thank you for that too.`,
              { size: 13, margin: "20px 0 0" },
            )
          : ""
      }
      ${
        give.showOnWall
          ? emailParagraph(
              `You're on the public giving wall now, just as you asked.`,
              { size: 13, margin: "20px 0 0" },
            )
          : ""
      }`),
    });
    return null;
  },
});

// ── 3. Failed ────────────────────────────────────────────────────────────────

/**
 * The debit didn't go through.
 *
 * Two jobs: tell them kindly, and give them a working way back. The reason is
 * mapped to plain language (`donorFacingAchFailureReason`) — never a raw
 * Stripe or ACH code.
 *
 * Also pulls any wall entry for this gift. A gift that didn't happen must not
 * leave a public echo of itself, whatever state the entry was in — this is the
 * one side effect in this file, and it exists because "nothing may remain
 * visible on the wall after a failure" is a promise the comms path can keep
 * unconditionally, without waiting on the lifecycle work.
 */
export const onAchFailed = internalAction({
  args: { sessionId: v.string(), reason: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { sessionId, reason }) => {
    const give = await loadGiveSessionContext(ctx, sessionId);
    if (!give) return null;

    // Withdraw first, then write. If the send throws, the wall is still clean.
    await ctx.runMutation(internal.givingActivity.withdrawActivity, {
      refKey: give.refKey,
    });

    // A caller that already knows why (the dispute path passes Stripe's
    // dispute reason) wins; otherwise go and find out.
    const failureCode = reason ?? (await fetchAchFailureCode(sessionId));
    const retryUrl = givePageUrl(give.slug ?? undefined);

    await sendEmail(ctx, {
      to: give.email,
      subject: `Your gift to ${give.city} didn't go through`,
      html: emailShell(`
      ${emailHeading(`Hi ${escapeHtml(give.firstName)} —`, { size: 26 })}
      ${emailParagraph(
        `Your <b>${give.amount}</b> gift to <b>${escapeHtml(give.city)}</b> didn't go through. ${escapeHtml(donorFacingAchFailureReason(failureCode))} This is usually a small mismatch or a timing thing, and it's easy to sort out.`,
        { margin: "0 0 20px" },
      )}
      ${emailParagraph(`If you'd still like to give, you can try again here:`, {
        margin: "0 0 16px",
      })}
      ${emailButton(retryUrl, "Try again")}
      ${emailParagraph(
        `You haven't been charged. If any money did leave your account, your bank returns it.`,
        { size: 13, margin: "24px 0 0" },
      )}
      ${
        give.showOnWall
          ? emailParagraph(
              `We've taken your entry off the public giving wall. If you give again and ask to be shown, it'll go back up once that gift clears.`,
              { size: 13, margin: "12px 0 0" },
            )
          : ""
      }`),
    });
    return null;
  },
});

// ── 4. Returned after it had already cleared ─────────────────────────────────

/**
 * It cleared, we thanked them for it, and weeks later the bank took it back.
 *
 * THIS IS NOT `onAchFailed`, and the difference is not cosmetic. `onAchFailed`
 * says "your gift didn't go through" and "you haven't been charged" — both of
 * which are FALSE here. This donor's money did leave their account, we did
 * confirm it, and they have an email from us saying so. Sending them the
 * never-cleared wording would contradict something we already told them, which
 * is exactly how a person concludes the org has lost track of their money.
 *
 * A bank can return an ACH debit for up to 60 calendar days after it settles.
 * When that happens Stripe raises it as a dispute, the gift comes back off the
 * books (`givingReversals.ts`), and this is what the donor hears about it.
 *
 * Deliberately does NOT ask for the money. A returned debit is usually a
 * closed account, a bank's own timing, or someone who changed their mind and
 * used the tool their bank gave them — none of which is an invoice. The retry
 * link is an offer, not a demand, and the email says outright that nothing is
 * owed.
 */
export const onAchReturned = internalAction({
  args: { sessionId: v.string(), reason: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { sessionId, reason }) => {
    const give = await loadGiveSessionContext(ctx, sessionId);
    if (!give) return null;

    const retryUrl = givePageUrl(give.slug ?? undefined);

    await sendEmail(ctx, {
      to: give.email,
      subject: `About your gift to ${give.city}`,
      html: emailShell(`
      ${emailHeading(`Hi ${escapeHtml(give.firstName)} —`, { size: 26 })}
      ${emailParagraph(
        `Your <b>${give.amount}</b> gift to <b>${escapeHtml(give.city)}</b> cleared a while back, but your bank has since returned it — so the money is back with you, and we've taken the gift off our records. ${escapeHtml(donorFacingAchFailureReason(reason))}`,
        { margin: "0 0 20px" },
      )}
      ${emailParagraph(
        `There's nothing owing and nothing you need to do. We're telling you because you got an email from us saying it had cleared, and that's no longer true.`,
        { margin: "0 0 16px" },
      )}
      ${emailParagraph(`If you'd still like to give, you can here:`, {
        margin: "0 0 16px",
      })}
      ${emailButton(retryUrl, "Give again")}
      ${
        give.showOnWall
          ? emailParagraph(
              `We've also taken your entry off the public giving wall.`,
              { size: 13, margin: "24px 0 0" },
            )
          : ""
      }`),
    });
    return null;
  },
});

