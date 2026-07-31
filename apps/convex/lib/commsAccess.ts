/**
 * Access gate for sending a Comms Schedule row's copy to Google Chat
 * (`commsSend.ts#sendCommsToGoogleChat`).
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { requireEvent } from "./context";

/**
 * The gate on FIRING a comms send at a Google Chat channel
 * (`commsSend.ts#sendCommsToGoogleChat`). Returns the event, so the call site
 * needs no second lookup.
 *
 * TODAY: bare event access — any admin of the event's own chapter
 * (`lib/context.ts#requireEvent`'s membership check) — copying
 * `lib/campaignsAccess.ts#requireBlastSend`'s shape exactly, including its
 * "not yet a named capability" stance (CLAUDE.md's "gate it behind a power,
 * even when it's open today").
 *
 * GRADUATING THIS (the same three-step `requireBlastSend` documents):
 *   1. Add `"comms.send"` to `SEAT_CAPABILITIES` (`packages/shared/src/seats.ts`).
 *   2. List it on whichever `SEAT_DEFS` entries should carry it.
 *   3. Change ONLY the body below. Do NOT add the capability string until
 *      that decision is actually made.
 */
export async function requireCommsSend(
  ctx: QueryCtx,
  eventId: Id<"events">,
): Promise<Doc<"events">> {
  return await requireEvent(ctx, eventId);
}
