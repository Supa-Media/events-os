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
import { requireFinanceManager } from "./lib/finance";

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
    return []; // Phase 0 stub
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
    const access = await requireFinanceManager(ctx, chapterId);

    const person = await ctx.db.get(personId);
    if (!person || person.chapterId !== chapterId) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "That person isn't on your chapter's roster.",
      });
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
