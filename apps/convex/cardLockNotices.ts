/**
 * Tell a cardholder their card was locked — the scheduled, best-effort email
 * behind both lock paths in `cards.ts` (`lockCard` and the receipt sweep
 * `autoLockOverdueCards`). Copy lives in `lib/cardLockedEmail.ts`.
 *
 * Kept out of `cards.ts` because that file is far past the size budget.
 */
import { v } from "convex/values";
import { internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { sendEmail } from "./ticketingEmails";
import { appUrl } from "./lib/siteUrl";
import { buildCardLockedEmail } from "./lib/cardLockedEmail";

const reasonValidator = v.union(v.literal("manager"), v.literal("receipt"));

/** Who to email, or null when the cardholder has no address or the card is no
 *  longer locked (unlocked again before this job ran — then there's nothing to
 *  tell them). Prefers `pwEmail`, same as `getPersonalChargeFlagContact`. */
export const getCardLockContact = internalQuery({
  args: {
    cardId: v.id("cards"),
    lockedByPersonId: v.optional(v.id("people")),
  },
  returns: v.union(
    v.object({
      email: v.string(),
      cardholderName: v.string(),
      last4: v.union(v.string(), v.null()),
      lockedByName: v.union(v.string(), v.null()),
    }),
    v.null(),
  ),
  handler: async (ctx, { cardId, lockedByPersonId }) => {
    const card = await ctx.db.get(cardId);
    if (!card || card.status !== "locked") return null;
    const person = await ctx.db.get(card.cardholderPersonId);
    const email = person?.pwEmail ?? person?.email;
    if (!person || !email) return null;
    const locker = lockedByPersonId ? await ctx.db.get(lockedByPersonId) : null;
    return {
      email,
      cardholderName: person.name,
      last4: card.last4 ?? null,
      lockedByName: locker?.name ?? null,
    };
  },
});

/** Best-effort: no-ops without `RESEND_API_KEY`, and never throws (it's a
 *  fire-and-forget job off the locking mutation). */
export const notifyCardLocked = internalAction({
  args: {
    cardId: v.id("cards"),
    reason: reasonValidator,
    lockedByPersonId: v.optional(v.id("people")),
  },
  returns: v.null(),
  handler: async (ctx, { cardId, reason, lockedByPersonId }) => {
    try {
      const contact = await ctx.runQuery(
        internal.cardLockNotices.getCardLockContact,
        { cardId, lockedByPersonId },
      );
      if (!contact) return null;
      const link = appUrl(
        reason === "receipt" ? "/code?filter=uncoded" : "/finances/cards",
      );
      if (!link) {
        console.error(
          "[cardLockNotices] APP_URL is unset — sending without a link",
          cardId,
        );
      }
      const { subject, html } = buildCardLockedEmail({
        reason,
        cardholderName: contact.cardholderName,
        last4: contact.last4,
        lockedByName: reason === "manager" ? contact.lockedByName : null,
        link,
      });
      await sendEmail(ctx, { to: contact.email, subject, html });
    } catch (err) {
      console.error("[cardLockNotices] notifyCardLocked failed", cardId, err);
    }
    return null;
  },
});
