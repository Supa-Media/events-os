/**
 * Integration settings (Attendance E) — the deployment-wide singleton (the
 * `financeSettings`/`aiSettings` pattern) for third-party API credentials
 * configured IN-APP instead of only via a deployment env var. Today: the
 * Givebutter API key (see `givebutterSync.ts`), settable at
 * profile > integrations by a superuser.
 *
 * The stored key is WRITE-ONLY from the client's perspective:
 *  - `getIntegrationsStatus` (SUPERUSER-gated) returns a status projection
 *    only — `{configured, last4, updatedAt}` — NEVER the key itself.
 *  - `setGivebutterApiKey` (SUPERUSER-gated) upserts the singleton; passing
 *    `apiKey: null` clears it.
 *  - `readGivebutterApiKey` (internalQuery) is the ONLY way to read the raw
 *    key, and it's reachable solely from `givebutterSync.ts`'s action
 *    (actions have no `ctx.db`). A mutation/query that only needs to CHECK
 *    whether a key is configured should read `ctx.db.query("integrationSettings")`
 *    directly rather than going through this internalQuery.
 *
 * Resolution order for the actual sync (see `givebutterSync.ts`): the stored
 * setting, else `process.env.GIVEBUTTER_API_KEY`, else a logged no-op degrade
 * — mirrors `financeSettings.readSandboxMode`.
 */
import { query, mutation, internalQuery } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { Id } from "./_generated/dataModel";
import { requireUserId } from "./lib/context";
import { requireSuperuser } from "./lib/superuser";

/** Read the singleton row (or `null` when never configured). */
async function getSettings(ctx: QueryCtx) {
  return await ctx.db.query("integrationSettings").first();
}

/** Last 4 characters of a key, for display only — never the key itself. */
function last4(key: string): string {
  return key.slice(-4);
}

/**
 * Superuser-only status projection for the in-app integrations screen. NEVER
 * returns the stored key — only whether it's configured, its last 4
 * characters, and when it was last updated.
 */
export const getIntegrationsStatus = query({
  args: {},
  returns: v.object({
    givebutter: v.object({
      configured: v.boolean(),
      last4: v.union(v.string(), v.null()),
      updatedAt: v.union(v.number(), v.null()),
    }),
  }),
  handler: async (ctx) => {
    await requireSuperuser(ctx);
    const settings = await getSettings(ctx);
    const key = settings?.givebutterApiKey;
    return {
      givebutter: {
        configured: !!key,
        last4: key ? last4(key) : null,
        updatedAt: settings?.updatedAt ?? null,
      },
    };
  },
});

/**
 * Set or clear the Givebutter API key. SUPERUSER-ONLY. `apiKey: null` clears
 * it (the sync then falls back to `GIVEBUTTER_API_KEY` env, or no-ops); a
 * non-null value must be non-empty after trimming. Upserts the singleton,
 * stamping `updatedBy` + `updatedAt`.
 */
export const setGivebutterApiKey = mutation({
  args: { apiKey: v.union(v.string(), v.null()) },
  returns: v.null(),
  handler: async (ctx, { apiKey }) => {
    await requireSuperuser(ctx);
    const updatedBy = (await requireUserId(ctx)) as Id<"users">;

    let trimmed: string | undefined;
    if (apiKey !== null) {
      trimmed = apiKey.trim();
      if (!trimmed) {
        throw new ConvexError({
          code: "INVALID_ARGUMENT",
          message: "API key can't be empty.",
        });
      }
    }
    // `trimmed === undefined` (the `apiKey: null` clear path) unsets the
    // optional field on patch — same null-sentinel convention as
    // `givebutterSync.finishGivebutterSync`'s `givebutterLastSyncError`.

    const existing = await getSettings(ctx);
    if (existing) {
      await ctx.db.patch(existing._id, {
        givebutterApiKey: trimmed,
        updatedBy,
        updatedAt: Date.now(),
      });
    } else {
      await ctx.db.insert("integrationSettings", {
        givebutterApiKey: trimmed,
        updatedBy,
        updatedAt: Date.now(),
      });
    }
    return null;
  },
});

/**
 * Action-facing read of the raw Givebutter key (or `null`). Actions have no
 * `ctx.db`, so `givebutterSync.ts` consults this via `ctx.runQuery` before
 * falling back to `process.env.GIVEBUTTER_API_KEY`. NEVER exposed as a public
 * function — this is the only place the raw key ever leaves the table.
 */
export const readGivebutterApiKey = internalQuery({
  args: {},
  returns: v.union(v.string(), v.null()),
  handler: async (ctx): Promise<string | null> => {
    const settings = await getSettings(ctx);
    return settings?.givebutterApiKey ?? null;
  },
});
