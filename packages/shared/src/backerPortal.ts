/**
 * The backer portal's MODULES — the named powers a signed-in giver's page is
 * assembled from.
 *
 * ── WHY A TUPLE AND NOT A BOOLEAN AT EACH CALL SITE ────────────────────────
 * CLAUDE.md's rule: put a capability behind a named power from the start, even
 * when the answer today is "anyone who's signed in". A backer holds no SEAT, so
 * the seat chart cannot be the register — this tuple is, and
 * `apps/convex/lib/backerAccess.ts#requireBackerModule` is the one place that
 * decides who gets which. Every portal read asks it; nothing checks `isBacker`
 * or a scope inline.
 *
 * What that buys, concretely: "turn the books off for a city that hasn't
 * launched", or "let non-backer givers see their own history but not the
 * ladder", is a change to one resolver body. Today most of these are open to
 * any authenticated giver and two of them require an active backing — see the
 * resolver for which, and why.
 *
 * Shared rather than backend-local because the page's own client script and
 * (later) the staff-side management screen both need to name the same modules.
 */
export const BACKER_PORTAL_MODULES = [
  /** Your own giving history — gifts, reversals, in-flight ACH. */
  "giving",
  /** Your pledge: the amount, the card, the status, the cancel. */
  "backing",
  /** A chapter's published books. */
  "books",
  /** A chapter's position — the gap, the affordability tier. */
  "health",
  /** What's coming up in a chapter. */
  "events",
  /** Who runs a chapter, by name. */
  "people",
] as const;

export type BackerPortalModule = (typeof BACKER_PORTAL_MODULES)[number];

/**
 * How long after a pledge stops that its holder keeps full portal access.
 *
 * SIXTY DAYS (owner's call, 2026-08-14 — he moved off the proposed 90). The
 * reasoning is worth keeping next to the number: a `past_due` pledge is usually
 * a bank, not a decision, and cutting somebody out of their own record on the
 * day their card expires is the opposite of a relationship. After the window
 * their giving HISTORY stays open — that is their record, not a perk — and only
 * the backer-only modules close.
 */
export const BACKER_ACCESS_GRACE_MS = 60 * 24 * 60 * 60 * 1000;
