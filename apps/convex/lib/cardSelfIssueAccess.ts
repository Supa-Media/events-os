/**
 * "May this person create their own card?" — the gate behind
 * `cards.createMyCard`, the self-serve path that replaced asking a finance
 * manager (founder call, 2026-10-02: "it shouldn't be request a card, it should
 * just create a card when someone doesn't have an Increase card even if they
 * have a Relay card").
 *
 * Today the answer is "anyone, for themselves": the caller must be the
 * cardholder (their own roster person in this chapter) — nobody self-issues a
 * card for someone else; that stays `requireFinanceManager`'s "Issue card".
 * Everything else that decides whether a card may exist at all (the
 * `@publicworship.life` email, the Academy prerequisite, the one-active-card
 * dedup) lives in `cards.ts#beginIssueCard` and applies to both paths.
 *
 * Per the house rule (CLAUDE.md, "Gate It Behind a Power"), this is a named
 * resolver even though it is open: the day self-issue needs narrowing, add
 * `cards.selfIssue` to `SEAT_CAPABILITIES`, list it on the seats that carry
 * it, and change `hasSelfIssueCard`'s body. No call site changes.
 */
import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { viewerPerson } from "./org";

export async function hasSelfIssueCard(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
  cardholderPersonId: Id<"people">,
): Promise<boolean> {
  const me = await viewerPerson(ctx, chapterId);
  return me !== null && me._id === cardholderPersonId;
}

export async function requireSelfIssueCard(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
  cardholderPersonId: Id<"people">,
): Promise<void> {
  if (!(await hasSelfIssueCard(ctx, chapterId, cardholderPersonId))) {
    throw new ConvexError({
      code: "FORBIDDEN",
      message: "You can only create a card for yourself.",
    });
  }
}
