import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Integration settings — the deployment-wide singleton (the `financeSettings`
 * / `aiSettings` pattern; ONE row for the whole deployment) that stores
 * third-party API credentials configured IN-APP (profile > integrations, by a
 * superuser) instead of only via a deployment env var.
 *
 * Today: the Givebutter API key (`givebutterSync.ts` resolves the stored
 * setting first, falling back to `process.env.GIVEBUTTER_API_KEY`).
 *
 * NEVER returned to clients — `integrationSettings.getIntegrationsStatus`
 * only ever projects `{configured, last4, updatedAt}`. The raw key is
 * readable ONLY through the `readGivebutterApiKey` internalQuery, which is
 * reachable solely from the sync action.
 */
export const integrationSettings = defineTable({
  givebutterApiKey: v.optional(v.string()),
  updatedAt: v.number(),
  updatedBy: v.id("users"),
});
