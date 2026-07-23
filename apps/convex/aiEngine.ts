/**
 * Public AI-engine actions for the in-app integrations screen (superuser only).
 *
 *  - `listAvailableModels` — the LIVE model list for the ACTIVE provider, fed
 *    straight into the global model picker. The provider's `/v1/models` is
 *    AUTHORITATIVE: every id it returns is shown, unfiltered (plus the UI's
 *    free-text override), because these cloud model families postdate this
 *    code's training data — any hardcoded catalog would be stale on arrival.
 *  - `testAiConnection` — the "Test connection" probe. The dev environment
 *    can't reach the providers, so this is how the owner validates a live key.
 *
 * Both gate on superuser by first calling `getIntegrationsStatus` (which throws
 * for a non-superuser), then read the raw config — including the secret key —
 * via the internal `readAiEngineConfig`. Neither action ever returns the key.
 *
 * No `"use node"`: `fetch` works in the default Convex runtime.
 */
import { action } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { v } from "convex/values";
import { listModels, testConnection, type AiEngineConfig } from "./lib/aiEngine";

/** Load the raw engine config, superuser-gated. `getIntegrationsStatus` throws
 *  a ConvexError for a non-superuser, so this doubles as the auth gate; the raw
 *  config (incl. the secret key) never leaves the server. */
async function requireEngineConfig(ctx: any): Promise<AiEngineConfig> {
  await ctx.runQuery(api.integrationSettings.getIntegrationsStatus, {});
  return (await ctx.runQuery(
    internal.integrationSettings.readAiEngineConfig,
    {},
  )) as AiEngineConfig;
}

/**
 * Live model ids for the active provider. Returns `{ok, provider, models?,
 * error?}` — a graceful error STRING (never a throw) when the provider is
 * unreachable or no key is configured, so the picker can show it inline.
 */
export const listAvailableModels = action({
  args: {},
  returns: v.object({
    ok: v.boolean(),
    provider: v.string(),
    models: v.array(v.string()),
    error: v.union(v.string(), v.null()),
  }),
  handler: async (
    ctx,
  ): Promise<{
    ok: boolean;
    provider: string;
    models: string[];
    error: string | null;
  }> => {
    const config = await requireEngineConfig(ctx);
    const res = await listModels(config);
    if (res.ok) {
      return { ok: true, provider: config.provider, models: res.models, error: null };
    }
    return { ok: false, provider: config.provider, models: [], error: res.message };
  },
});

/**
 * Test the active provider's connection by hitting `/v1/models`. Returns
 * `{ok, provider, modelCount?, error?}`. This is the owner's live-validation
 * path (the dev backend is proxy-blocked from the providers).
 */
export const testAiConnection = action({
  args: {},
  returns: v.object({
    ok: v.boolean(),
    provider: v.string(),
    modelCount: v.union(v.number(), v.null()),
    error: v.union(v.string(), v.null()),
  }),
  handler: async (
    ctx,
  ): Promise<{
    ok: boolean;
    provider: string;
    modelCount: number | null;
    error: string | null;
  }> => {
    const config = await requireEngineConfig(ctx);
    const res = await testConnection(config);
    return {
      ok: res.ok,
      provider: config.provider,
      modelCount: res.modelCount ?? null,
      error: res.error ?? null,
    };
  },
});
