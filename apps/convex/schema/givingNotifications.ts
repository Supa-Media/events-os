/**
 * Giving notification rules — "tell me when money comes in."
 *
 * One row is one standing instruction: *these people* hear about *these gifts*
 * at *this frequency*. Nothing here decides what a gift IS; eligibility is
 * deliberately total — every row `lib/givingDonors.ts#recordGiftForDonor`
 * writes is a candidate, including an add-on gift bundled into a ticket order
 * (which settles `donations` → gift) and an in-kind gift (a purchase made on
 * the org's behalf). A rule narrows that set by scope and by amount, and by
 * nothing else, because "which gifts count" is a question the giving ledger
 * already answers and this table has no business answering it twice.
 *
 * ── Scope carries an explicit sentinel, never a null ────────────────────────
 * `scope` is `"all" | "central" | Id<"chapters">`. The neighbouring giving
 * tables (`donors.scope`, `gifts.scope`) use the two-way
 * `Id<"chapters"> | "central"` union; a rule needs a third state — "every
 * book" — and that state is a STRING, not an absent field. A nullable
 * `chapterId` would make "central" and "everywhere" indistinguishable at the
 * validator, and every read would have to re-derive the difference from
 * context. See `lib/givingAccess.ts#GivingScope` for the two-way twin.
 *
 * ── `isActive`, never a delete ──────────────────────────────────────────────
 * The giving desk soft-deactivates everywhere (`sponsorPackages.active`,
 * `pledges.status`) and offers reactivation. A rule that fired for six months
 * is a record of who was told what, so it is turned OFF, not removed.
 *
 * ── Send-time fields ───────────────────────────────────────────────────────
 * `sendHourLocal`/`sendWeekday` are meaningless for `cadence: "immediate"` and
 * are simply ignored there. Both are in the org's timezone
 * (`America/New_York`, the same one `reminders.ts` and `crons.ts` reason in) —
 * a fundraising team reading "the Monday morning email" means Monday morning
 * where they are, not 08:00 UTC.
 *
 * `lastSentAt` is the digest watermark AND the idempotency key: a digest run
 * collects gifts created since it, and stamps it on success. See
 * `lib/givingNotificationRules.ts` for the window arithmetic and for why an
 * empty DAILY digest deliberately leaves the watermark alone.
 */
import { defineTable } from "convex/server";
import { v } from "convex/values";

/** How often a rule's recipients hear from it. */
export const GIVING_NOTIFICATION_CADENCES = [
  "immediate",
  "daily",
  "weekly",
] as const;

export type GivingNotificationCadence =
  (typeof GIVING_NOTIFICATION_CADENCES)[number];

/** A rule's reach: every book, the central book, or one chapter's book. */
export const givingNotificationScope = v.union(
  v.literal("all"),
  v.literal("central"),
  v.id("chapters"),
);

export const givingNotificationRules = defineTable({
  /** Human label — "Every gift to the dev team", "Big gifts to Shay + AJ". */
  name: v.string(),
  /** Lowercased, de-duplicated email addresses. Never empty (enforced at the
   *  mutation; a validator can't express "at least one"). */
  recipients: v.array(v.string()),
  cadence: v.union(
    ...GIVING_NOTIFICATION_CADENCES.map((c) => v.literal(c)),
  ),
  /** Floor in integer cents, INCLUSIVE — a rule set to $500 fires on a gift of
   *  exactly $500. Absent means every gift, at any amount. */
  minAmountCents: v.optional(v.number()),
  scope: givingNotificationScope,
  isActive: v.boolean(),
  /** 0–23 in `America/New_York`. Daily/weekly only; defaults to 8. */
  sendHourLocal: v.optional(v.number()),
  /** 0 = Sunday … 6 = Saturday, in `America/New_York`. Weekly only; defaults
   *  to 1 (Monday). */
  sendWeekday: v.optional(v.number()),
  /** The digest watermark — the instant the last digest covered up to. Absent
   *  until the first digest sends. Never set for `immediate` rules. */
  lastSentAt: v.optional(v.number()),
  createdBy: v.id("users"),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  // The digest sweep's read: "every rule on this cadence" (a handful of rows).
  .index("by_cadence", ["cadence"])
  // The desk's list, and the immediate path's "which rules could care about a
  // gift in this book" — rules are per-scope and there are few of them.
  .index("by_scope", ["scope"]);
