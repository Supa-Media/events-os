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
import {
  FINANCE_ROLES,
  FINANCE_ROLE_SCOPES,
  FINANCE_ROLE_RANK,
  type FinanceRole,
} from "@events-os/shared";
import { Id } from "./_generated/dataModel";
import {
  getChapterIdOrNull,
  requireChapterId,
  requireUserId,
} from "./lib/context";
import {
  requireFinanceManager,
  requireFinanceCentral,
  isCentralEdOrFm,
} from "./lib/finance";
import { isSuperuser } from "./lib/superuser";

const roleValidator = v.union(...FINANCE_ROLES.map((r) => v.literal(r)));
const scopeValidator = v.union(...FINANCE_ROLE_SCOPES.map((s) => v.literal(s)));

/**
 * The caller's REAL finance seats (WP-0.2) — what the dashboard routes by,
 * replacing the fake "Preview as" role simulation.
 *
 * A seat is a desk the caller actually sits at:
 *  - `{scope:"central"}` — any `scope:"central"` grant (whichever chapterId the
 *    row is keyed on: `grantFinanceRole` keys it on the granting chapter, the
 *    specialized-roles bridge on the `"central"` sentinel), or the superuser
 *    allowlist (implicit central manager — the bootstrap path).
 *  - `{scope:"chapter"}` — one per chapter with a `scope:"chapter"` grant.
 *
 * Central first (the UI's default desk), then chapters by name. Placeholder
 * roster rows never count (mirrors `viewerPerson`). No grants → `[]` → member.
 */
export const mySeats = query({
  args: {},
  returns: v.array(
    v.union(
      v.object({ scope: v.literal("central"), role: roleValidator }),
      v.object({
        scope: v.literal("chapter"),
        chapterId: v.id("chapters"),
        chapterName: v.string(),
        role: roleValidator,
      }),
    ),
  ),
  handler: async (ctx) => {
    const userId = (await requireUserId(ctx)) as Id<"users">;
    const people = await ctx.db
      .query("people")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const grants = (
      await Promise.all(
        people
          .filter((p) => p.isPlaceholder !== true)
          .map((p) =>
            ctx.db
              .query("financeRoles")
              .withIndex("by_person", (q) => q.eq("personId", p._id))
              .collect(),
          ),
      )
    ).flat();

    const stronger = (a: FinanceRole, b: FinanceRole | null) =>
      b == null || FINANCE_ROLE_RANK[a] > FINANCE_ROLE_RANK[b];

    // Central seat: superuser short-circuit, else the strongest central grant.
    let centralRole: FinanceRole | null = (await isSuperuser(ctx))
      ? "manager"
      : null;
    for (const g of grants) {
      if (g.scope === "central" && stronger(g.role, centralRole)) {
        centralRole = g.role;
      }
    }

    // Chapter seats: the strongest chapter-scoped grant per chapter.
    const chapterRoles = new Map<Id<"chapters">, FinanceRole>();
    for (const g of grants) {
      if (g.scope !== "chapter" || g.chapterId === "central") continue;
      if (stronger(g.role, chapterRoles.get(g.chapterId) ?? null)) {
        chapterRoles.set(g.chapterId, g.role);
      }
    }

    const chapterSeats = [];
    for (const [chapterId, role] of chapterRoles) {
      const chapter = await ctx.db.get(chapterId);
      if (!chapter) continue; // stale grant on a deleted chapter
      chapterSeats.push({
        scope: "chapter" as const,
        chapterId,
        chapterName: chapter.name,
        role,
      });
    }
    chapterSeats.sort((a, b) => a.chapterName.localeCompare(b.chapterName));

    return [
      ...(centralRole != null
        ? [{ scope: "central" as const, role: centralRole }]
        : []),
      ...chapterSeats,
    ];
  },
});

/**
 * WP-1.2: whether the caller may see the Accounts tab (+ the Cards tab's
 * Relay/legacy section) — CENTRAL `executive_director` or `finance_manager`
 * specialized-role holders only (or a superuser). Tighter than a plain
 * central-scope finance-manager grant (`stripeFinance.canConnectAccount`'s
 * gate): a chapter-scope manager, or even a central `financeRoles` grant with
 * no ED/FM title, gets `false` — see `lib/finance.ts#isCentralEdOrFm`.
 *
 * A signed-out caller gets `false` too, not a thrown error: `isCentralEdOrFm`
 * bottoms out in `requireUserId` (throws `NOT_AUTHENTICATED`), but this is a
 * visibility check the client polls to decide whether to render the Accounts
 * tab at all — it should degrade quietly like every other "can I see this"
 * query, not surface an auth error before the caller has even loaded.
 */
export const canViewAccounts = query({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return false;
    return isCentralEdOrFm(ctx);
  },
});

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
