/**
 * The card status changes a cardholder is emailed about, and the record of
 * the last such email kept on the card row (`cards.lastStatusEmail`) so the
 * manager's Cards list can show whether it went out. A tiny module of its own
 * so the schema can import it without pulling in the email renderer.
 */
import { v } from "convex/values";

export const CARD_STATUS_EVENTS = [
  "locked_manager",
  "locked_receipt",
  "unlocked_manager",
  "unlocked_receipt",
  "canceled",
] as const;
export type CardStatusEvent = (typeof CARD_STATUS_EVENTS)[number];

export const cardStatusEventValidator = v.union(
  ...CARD_STATUS_EVENTS.map((e) => v.literal(e)),
);

/** `sent` — our email provider accepted it. `failed` — it rejected it or
 *  couldn't be reached (or no provider key is configured). `no_address` — the
 *  cardholder has no email on file, so nothing was sent. */
export const CARD_STATUS_EMAIL_OUTCOMES = ["sent", "failed", "no_address"] as const;
export type CardStatusEmailOutcome = (typeof CARD_STATUS_EMAIL_OUTCOMES)[number];

export const lastStatusEmailValidator = v.object({
  event: cardStatusEventValidator,
  outcome: v.union(...CARD_STATUS_EMAIL_OUTCOMES.map((o) => v.literal(o))),
  at: v.number(),
  to: v.optional(v.string()),
});
