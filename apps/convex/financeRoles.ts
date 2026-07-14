/**
 * Finance role administration — grant / revoke the graded finance capability
 * (viewer < bookkeeper < manager) on a chapter's roster people.
 *
 * `listFinanceRoles` is a Phase-0 stub (empty projection). `grantFinanceRole`
 * and `revokeFinanceRole` are implemented for real — they're trivial row
 * insert/delete and let local dev + the seed wire up finance access now. All
 * three require a finance manager (the finance-admin gate).
 */
import { query, mutation } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { FINANCE_ROLES, FINANCE_ROLE_SCOPES } from "@events-os/shared";
import { Id } from "./_generated/dataModel";
import { getChapterIdOrNull, requireChapterId } from "./lib/context";
import { requireFinanceManager, requireFinanceCentral } from "./lib/finance";

const roleValidator = v.union(...FINANCE_ROLES.map((r) => v.literal(r)));
const scopeValidator = v.union(...FINANCE_ROLE_SCOPES.map((s) => v.literal(s)));

/** List every finance-role grant in the caller's chapter (manager only). */
export const listFinanceRoles = query({
  args: {},
  returns: v.array(
    v.object({
      id: v.id("financeRoles"),
      personId: v.id("people"),
      role: roleValidator,
      scope: scopeValidator,
      createdAt: v.number(),
    }),
  ),
  handler: async (ctx) => {
    const chapterId = (await getChapterIdOrNull(ctx)) as Id<"chapters"> | null;
    if (!chapterId) return [];
    await requireFinanceManager(ctx, chapterId);
    const grants = await ctx.db
      .query("financeRoles")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .collect();
    return grants.map((g) => ({
      id: g._id,
      personId: g.personId,
      role: g.role,
      scope: g.scope,
      createdAt: g.createdAt,
    }));
  },
});

/** Grant a person a finance role in the caller's chapter (manager only). */
export const grantFinanceRole = mutation({
  args: {
    personId: v.id("people"),
    role: roleValidator,
    scope: scopeValidator,
  },
  returns: v.id("financeRoles"),
  handler: async (ctx, { personId, role, scope }) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    // Any finance manager may grant chapter-scoped roles, but conferring
    // CENTRAL (org-wide) reach requires the granter to already hold it — else a
    // plain chapter manager could self-escalate to the org roll-up.
    const access = await requireFinanceManager(ctx, chapterId);
    if (scope === "central") {
      await requireFinanceCentral(ctx, chapterId);
    }

    const person = await ctx.db.get(personId);
    if (!person || person.chapterId !== chapterId) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "That person isn't on your chapter's roster.",
      });
    }

    // Upsert: one grant per (chapter, person) so a re-grant CHANGES the role in
    // place instead of stacking rows (which the effective-role resolver would
    // otherwise have to reconcile).
    const existing = await ctx.db
      .query("financeRoles")
      .withIndex("by_chapter_and_person", (q) =>
        q.eq("chapterId", chapterId).eq("personId", personId),
      )
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        role,
        scope,
        grantedByPersonId: access.personId ?? undefined,
      });
      return existing._id;
    }

    return await ctx.db.insert("financeRoles", {
      chapterId,
      personId,
      role,
      scope,
      grantedByPersonId: access.personId ?? undefined,
      createdAt: Date.now(),
    });
  },
});

/** Revoke a finance-role grant (manager only). */
export const revokeFinanceRole = mutation({
  args: { roleId: v.id("financeRoles") },
  returns: v.null(),
  handler: async (ctx, { roleId }) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceManager(ctx, chapterId);

    const grant = await ctx.db.get(roleId);
    if (!grant || grant.chapterId !== chapterId) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "That finance role grant isn't in your chapter.",
      });
    }
    await ctx.db.delete(roleId);
    return null;
  },
});
