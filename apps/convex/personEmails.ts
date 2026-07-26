/**
 * Person Emails — the public write surface for `schema/people.ts#personEmails`
 * (person-centric audiences Phase 2, specs/person-centric-audiences.md Phase 2
 * item 2). Every ROW is written by a write-through helper
 * (`lib/personEmails.ts#recordPersonEmail`, called from `people.ts`'s
 * create/update, `lib/givingDonors.ts#linkDonorToPerson`, and
 * `lib/rsvpPeople.ts#linkRsvpToPerson`) — this module only ever flips which
 * EXISTING row is the person's chosen send address.
 */
import { mutation, query } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { requireOwned } from "./lib/context";

/** How many known-email rows a person's detail sheet renders — generous for
 *  a human-curated ledger (see `schema/people.ts#personEmails`'s doc; rows
 *  only ever accrue via write-through + upgrade-in-place, never spam). */
const PERSON_EMAILS_READ_CAP = 20;

/**
 * A person's known emails (People-CRM UX) — every row in the
 * `personEmails` ledger (`schema/people.ts#personEmails`), primary first.
 * Gated exactly like `setPrimaryEmail`/`people.update` — chapter membership
 * via the linked person, no extra seat/power check. Bounded `by_person`
 * read (never a full-table scan).
 */
export const listForPerson = query({
  args: { personId: v.id("people") },
  handler: async (ctx, { personId }) => {
    await requireOwned(ctx, "people", personId, "Person");
    const rows = await ctx.db
      .query("personEmails")
      .withIndex("by_person", (q) => q.eq("personId", personId))
      .take(PERSON_EMAILS_READ_CAP);
    return rows
      .map((r) => ({
        _id: r._id,
        address: r.email,
        source: r.source,
        verified: r.verified,
        isPrimary: r.isPrimary === true,
        addedAt: r.addedAt,
      }))
      .sort((a, b) => {
        if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
        return b.addedAt - a.addedAt;
      });
  },
});

/**
 * Mark one of a person's known emails as the explicit send-address override
 * (`lib/personEmails.ts#resolveSendAddress`'s top precedence tier). Gated
 * exactly like `people.update` — chapter membership via the linked person, no
 * extra seat/power check (this app doesn't gate ordinary roster contact edits
 * beyond chapter ownership; see `people.ts`'s module doc). Enforces AT MOST
 * ONE `isPrimary: true` row per person by clearing every sibling first.
 */
export const setPrimaryEmail = mutation({
  args: { personEmailId: v.id("personEmails") },
  handler: async (ctx, { personEmailId }) => {
    const row = await ctx.db.get(personEmailId);
    if (!row) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Email not found." });
    }
    await requireOwned(ctx, "people", row.personId, "Person");

    const siblings = await ctx.db
      .query("personEmails")
      .withIndex("by_person", (q) => q.eq("personId", row.personId))
      .collect();
    for (const sib of siblings) {
      if (sib._id !== row._id && sib.isPrimary === true) {
        await ctx.db.patch(sib._id, { isPrimary: undefined });
      }
    }
    await ctx.db.patch(row._id, { isPrimary: true });
    return null;
  },
});
