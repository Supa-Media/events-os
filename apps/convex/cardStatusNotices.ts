/**
 * Tell a cardholder their card was locked, unlocked, or canceled — the
 * scheduled, best-effort email behind those paths in `cards.ts` (`lockCard`,
 * `unlockCard`, `beginCancelCard`, the receipt sweep `autoLockOverdueCards`,
 * and `unlockCardIfReceiptsResolved`). Copy lives in `lib/cardStatusEmail.ts`.
 *
 * Kept out of `cards.ts` because that file is far past the size budget.
 */
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { sendEmail } from "./ticketingEmails";
import { appUrl } from "./lib/siteUrl";
import {
  CARD_STATUS_EVENTS,
  buildCardStatusEmail,
  linkPathFor,
  statusAfter,
  type CardStatusEvent,
} from "./lib/cardStatusEmail";

const eventValidator = v.union(...CARD_STATUS_EVENTS.map((e) => v.literal(e)));

/** Queue the email. Call from the mutation that changed the card's status. */
export async function scheduleCardStatusEmail(
  ctx: MutationCtx,
  cardId: Id<"cards">,
  event: CardStatusEvent,
  actorPersonId?: Id<"people"> | null,
): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.cardStatusNotices.notifyCardStatus, {
    cardId,
    event,
    ...(actorPersonId ? { actorPersonId } : {}),
  });
}

/** Who to email, or null when the cardholder has no address or the card has
 *  already moved on from the status this event left it in (e.g. unlocked again
 *  before the lock email went out — then there's nothing true to tell them).
 *  Prefers `pwEmail`, same as `getPersonalChargeFlagContact`. */
export const getCardStatusContact = internalQuery({
  args: {
    cardId: v.id("cards"),
    event: eventValidator,
    actorPersonId: v.optional(v.id("people")),
  },
  returns: v.union(
    v.object({
      email: v.string(),
      cardholderName: v.string(),
      last4: v.union(v.string(), v.null()),
      actorName: v.union(v.string(), v.null()),
    }),
    v.null(),
  ),
  handler: async (ctx, { cardId, event, actorPersonId }) => {
    const card = await ctx.db.get(cardId);
    if (!card || card.status !== statusAfter(event)) return null;
    const person = await ctx.db.get(card.cardholderPersonId);
    const email = person?.pwEmail ?? person?.email;
    if (!person || !email) return null;
    const actor = actorPersonId ? await ctx.db.get(actorPersonId) : null;
    return {
      email,
      cardholderName: person.name,
      last4: card.last4 ?? null,
      actorName: actor?.name ?? null,
    };
  },
});

/** Best-effort: no-ops without `RESEND_API_KEY`, and never throws (it's a
 *  fire-and-forget job off the mutation that changed the card). */
export const notifyCardStatus = internalAction({
  args: {
    cardId: v.id("cards"),
    event: eventValidator,
    actorPersonId: v.optional(v.id("people")),
  },
  returns: v.null(),
  handler: async (ctx, { cardId, event, actorPersonId }) => {
    try {
      const contact = await ctx.runQuery(
        internal.cardStatusNotices.getCardStatusContact,
        { cardId, event, actorPersonId },
      );
      if (!contact) return null;
      const link = appUrl(linkPathFor(event));
      if (!link) {
        console.error(
          "[cardStatusNotices] APP_URL is unset — sending without a link",
          cardId,
        );
      }
      const { subject, html } = buildCardStatusEmail({
        event,
        cardholderName: contact.cardholderName,
        last4: contact.last4,
        actorName: contact.actorName,
        link,
      });
      await sendEmail(ctx, { to: contact.email, subject, html });
    } catch (err) {
      console.error("[cardStatusNotices] notifyCardStatus failed", cardId, event, err);
    }
    return null;
  },
});
