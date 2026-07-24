/**
 * Person Emails — the public write surface for `schema/people.ts#personEmails`
 * (person-centric audiences Phase 2, specs/person-centric-audiences.md Phase 2
 * item 2). Every ROW is written by a write-through helper
 * (`lib/personEmails.ts#recordPersonEmail`, called from `people.ts`'s
 * create/update, `lib/givingDonors.ts#linkDonorToPerson`, and
 * `lib/rsvpPeople.ts#linkRsvpToPerson`) — this module only ever flips which
 * EXISTING row is the person's chosen send address.
 */
import { mutation } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { requireOwned } from "./lib/context";

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
