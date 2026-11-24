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
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { sendEmailReporting } from "./ticketingEmails";
import { appUrl } from "./lib/siteUrl";
import { buildCardStatusEmail, linkPathFor, statusAfter } from "./lib/cardStatusEmail";
import {
  cardStatusEventValidator,
  lastStatusEmailValidator,
  type CardStatusEmailOutcome,
  type CardStatusEvent,
} from "./lib/cardStatusEvents";

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

/** Who to email. Null when the card has already moved on from the status this
 *  event left it in (e.g. unlocked again before the lock email went out — then
 *  there's nothing true to tell them, and nothing is recorded). `email` is null
 *  when the cardholder has no address on file. Prefers `pwEmail`, same as
 *  `getPersonalChargeFlagContact`. */
export const getCardStatusContact = internalQuery({
  args: {
    cardId: v.id("cards"),
    event: cardStatusEventValidator,
    actorPersonId: v.optional(v.id("people")),
  },
  returns: v.union(
    v.object({
      email: v.union(v.string(), v.null()),
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
    if (!person) return null;
    const actor = actorPersonId ? await ctx.db.get(actorPersonId) : null;
    return {
      email: person.pwEmail ?? person.email ?? null,
      cardholderName: person.name,
      last4: card.last4 ?? null,
      actorName: actor?.name ?? null,
    };
  },
});

/** Stamp what happened on the card row, for the manager's Cards list. */
export const recordCardStatusEmail = internalMutation({
  args: { cardId: v.id("cards"), record: lastStatusEmailValidator },
  returns: v.null(),
  handler: async (ctx, { cardId, record }) => {
    if (await ctx.db.get(cardId)) {
      await ctx.db.patch(cardId, { lastStatusEmail: record });
    }
    return null;
  },
});

/** Best-effort, never throws (it's a fire-and-forget job off the mutation that
 *  changed the card). Records the outcome either way so a manager can see
 *  whether the cardholder was actually told. */
export const notifyCardStatus = internalAction({
  args: {
    cardId: v.id("cards"),
    event: cardStatusEventValidator,
    actorPersonId: v.optional(v.id("people")),
  },
  returns: v.null(),
  handler: async (ctx, { cardId, event, actorPersonId }) => {
    let outcome: CardStatusEmailOutcome = "failed";
    let to: string | undefined;
    try {
      const contact = await ctx.runQuery(
        internal.cardStatusNotices.getCardStatusContact,
        { cardId, event, actorPersonId },
      );
      if (!contact) return null;
      if (!contact.email) {
        outcome = "no_address";
      } else {
        to = contact.email;
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
        outcome = (await sendEmailReporting(ctx, { to, subject, html }))
          ? "sent"
          : "failed";
      }
    } catch (err) {
      console.error("[cardStatusNotices] notifyCardStatus failed", cardId, event, err);
    }
    try {
      await ctx.runMutation(internal.cardStatusNotices.recordCardStatusEmail, {
        cardId,
        record: { event, outcome, at: Date.now(), ...(to ? { to } : {}) },
      });
    } catch (err) {
      console.error("[cardStatusNotices] recording the outcome failed", cardId, err);
    }
    return null;
  },
});
