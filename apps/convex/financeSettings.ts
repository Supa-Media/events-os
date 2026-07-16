/**
 * Finance settings — the deployment-wide finance singleton (the `aiSettings`
 * pattern; ONE row for the whole deployment). Today it carries a single runtime
 * toggle: `sandboxMode`.
 *
 * When `sandboxMode` is on, NEW Increase account provisioning targets the
 * Increase SANDBOX (sandbox entity + key + base) so the whole money layer can be
 * exercised without touching real funds. EXISTING accounts always self-select
 * their environment from their `sandbox_` id prefix (see `increaseEnvForObjectId`
 * in `increase.ts`), so flipping this can never misroute already-provisioned
 * money — it only changes which environment the next `provisionChapterAccount`
 * opens an account in.
 *
 * Reads are finance-VIEWER gated (the finances UI shows the toggle state);
 * flipping it is SUPERUSER-ONLY (the `ai.setActiveModel` precedent). Actions have
 * no `ctx.db`, so they read the flag through the `readSandboxMode` internalQuery.
 */
import { query, mutation, internalQuery } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";
import { requireUserId, getChapterIdOrNull } from "./lib/context";
import { getFinanceRole } from "./lib/finance";
import { requireSuperuser } from "./lib/superuser";

/** Read the deployment-wide sandbox flag (default false). Shared by the public
 *  viewer-gated query, the internal action-facing query, and the finance list
 *  queries that filter Increase records to the current environment. */
export async function readSandbox(ctx: QueryCtx): Promise<boolean> {
  const settings = await ctx.db.query("financeSettings").first();
  return settings?.sandboxMode ?? false;
}

/**
 * The deployment-wide finance settings the finances UI reads. Not gated on a
 * finance role — the flag is a non-sensitive dev/testing banner state, and the
 * SandboxModeBanner is mounted for every finance-tab visitor (including the
 * no-finance-role member persona, D3). A caller with no finance role (and no
 * chapter, or no superuser/central reach) gets the safe default
 * `{sandboxMode:false}` instead of a FORBIDDEN throw — throwing here crashed
 * the whole app for that persona (see the [hotfix] postmortem: an
 * unconditionally-mounted, role-gated query re-threw into render and hit the
 * root ErrorBoundary). Superusers/finance-role holders still get the real
 * value.
 */
export const getFinanceSettings = query({
  args: {},
  returns: v.object({ sandboxMode: v.boolean() }),
  handler: async (ctx): Promise<{ sandboxMode: boolean }> => {
    const chapterId = (await getChapterIdOrNull(ctx)) as Id<"chapters"> | null;
    if (!chapterId) return { sandboxMode: false };
    const access = await getFinanceRole(ctx, chapterId);
    if (access.role == null) return { sandboxMode: false };
    return { sandboxMode: await readSandbox(ctx) };
  },
});

/**
 * Flip the deployment-wide finance sandbox mode. SUPERUSER-ONLY. Upserts the
 * singleton row, stamping `updatedBy` + `updatedAt`.
 */
export const setSandboxMode = mutation({
  args: { sandboxMode: v.boolean() },
  returns: v.object({ sandboxMode: v.boolean() }),
  handler: async (ctx, { sandboxMode }): Promise<{ sandboxMode: boolean }> => {
    await requireSuperuser(ctx);
    const updatedBy = (await requireUserId(ctx)) as Id<"users">;
    const existing = await ctx.db.query("financeSettings").first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        sandboxMode,
        updatedBy,
        updatedAt: Date.now(),
      });
    } else {
      await ctx.db.insert("financeSettings", {
        sandboxMode,
        updatedBy,
        updatedAt: Date.now(),
      });
    }
    return { sandboxMode };
  },
});

/** Action-facing read of the sandbox flag (actions have no `ctx.db`, so
 *  provisioning consults this via `ctx.runQuery`). Default false. */
export const readSandboxMode = internalQuery({
  args: {},
  returns: v.boolean(),
  handler: async (ctx): Promise<boolean> => readSandbox(ctx),
});
