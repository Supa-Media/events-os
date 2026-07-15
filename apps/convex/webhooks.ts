/**
 * Shared inbound-webhook dedup ledger.
 *
 * Both the Stripe webhook (`/stripe/webhook`, ticketing + Financial Connections)
 * and the Increase webhook (`/increase/webhook`, Phase 4) can be redelivered by
 * the provider. `recordWebhookEvent` is the idempotency gate every handler calls
 * first: it records the provider's unique `event.id` in `webhookEvents` and
 * returns whether this is the FIRST time we've seen it, so the handler can skip
 * re-processing a redelivery.
 *
 * NOT chapter-scoped on purpose — a webhook is deduped before any chapter can be
 * resolved from its payload (see `schema/finances.ts`).
 */
import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

/**
 * Record an inbound webhook event and report whether it is new. Returns
 * `{ isNew: false }` if this `(provider, eventId)` was already recorded (a
 * redelivery), so callers no-op; `{ isNew: true }` on first sight, with the row
 * inserted + stamped `processedAt` so a concurrent redelivery loses the race
 * cleanly (the unique `by_provider_and_event` read below is the guard).
 */
export const recordWebhookEvent = internalMutation({
  args: {
    provider: v.union(v.literal("stripe"), v.literal("increase")),
    eventId: v.string(),
    summary: v.optional(v.string()),
  },
  returns: v.object({ isNew: v.boolean() }),
  handler: async (ctx, { provider, eventId, summary }) => {
    const existing = await ctx.db
      .query("webhookEvents")
      .withIndex("by_provider_and_event", (q) =>
        q.eq("provider", provider).eq("eventId", eventId),
      )
      .first();
    if (existing) return { isNew: false };
    const now = Date.now();
    await ctx.db.insert("webhookEvents", {
      provider,
      eventId,
      receivedAt: now,
      processedAt: now,
      summary,
    });
    return { isNew: true };
  },
});
