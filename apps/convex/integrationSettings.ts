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
 * Twilio SMS (Attendance F) follows the SAME discipline: the AUTH TOKEN is the
 * secret and never leaves the table except through `readTwilioCredentials`
 * (the sending actions). `setTwilioCredentials` sets/clears all three fields
 * together; `getIntegrationsStatus` projects only `{configured, accountSid
 * last4, messagingServiceSid present, updatedAt}`.
 *
 * Resend email (own-key integration) follows the SAME discipline: the API KEY
 * is the secret and never leaves the table except through
 * `readResendSettings` (the sending actions/helpers in `lib/resend.ts`). The
 * FROM ADDRESS is not secret — it's the sender line every recipient already
 * sees — so `getIntegrationsStatus` returns it in full, not redacted.
 * `setResendSettings` sets/clears both fields together: `apiKey: null` clears
 * both (falls back to `RESEND_API_KEY`/`AUTH_EMAIL_FROM` env, or the logged
 * no-op degrade); a non-null key may be saved with or without a from-address
 * (blank/omitted from-address falls back to the env default at send time).
 *
 * Resolution order for the actual sync/send (see `givebutterSync.ts` /
 * `lib/twilio.ts` / `lib/resend.ts`): the stored setting, else the deployment
 * env var(s), else a logged no-op degrade — mirrors
 * `financeSettings.readSandboxMode`.
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
 * Loosely validate + normalize a Resend "From" address: must look like an
 * email (`addr@dom`) or the `"Name <addr@dom>"` form Resend also accepts —
 * checked only by presence of `@`, not a full RFC 5322 parse (Resend itself
 * is the source of truth on send). A blank value (after trim) means "unset",
 * not an error — the caller falls back to the env default.
 */
function normalizeFromAddress(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (!trimmed.includes("@")) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: 'From address must be an email or "Name <email>", e.g. "Chapter OS <os@publicworship.life>".',
    });
  }
  return trimmed;
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
    twilio: v.object({
      // Configured means the whole trio (sid + token + messaging service) is
      // present — a half-set Twilio can't send.
      configured: v.boolean(),
      accountSidLast4: v.union(v.string(), v.null()),
      messagingServiceConfigured: v.boolean(),
      updatedAt: v.union(v.number(), v.null()),
    }),
    resend: v.object({
      configured: v.boolean(),
      last4: v.union(v.string(), v.null()),
      // NOT secret — the sender line every recipient already sees — so it's
      // returned in full, unlike `last4`.
      fromAddress: v.union(v.string(), v.null()),
      updatedAt: v.union(v.number(), v.null()),
    }),
  }),
  handler: async (ctx) => {
    await requireSuperuser(ctx);
    const settings = await getSettings(ctx);
    const key = settings?.givebutterApiKey;
    const sid = settings?.twilioAccountSid;
    const token = settings?.twilioAuthToken;
    const messagingServiceSid = settings?.twilioMessagingServiceSid;
    const resendKey = settings?.resendApiKey;
    return {
      givebutter: {
        configured: !!key,
        last4: key ? last4(key) : null,
        updatedAt: settings?.updatedAt ?? null,
      },
      twilio: {
        // The account SID last4 + messaging-service presence are shown; the
        // AUTH TOKEN (the secret) is NEVER surfaced, not even as last4.
        configured: !!sid && !!token && !!messagingServiceSid,
        accountSidLast4: sid ? last4(sid) : null,
        messagingServiceConfigured: !!messagingServiceSid,
        updatedAt: settings?.updatedAt ?? null,
      },
      resend: {
        configured: !!resendKey,
        last4: resendKey ? last4(resendKey) : null,
        fromAddress: settings?.resendFromAddress ?? null,
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

/**
 * Set or clear the Twilio SMS credentials. SUPERUSER-ONLY. All three values
 * move together: passing `null` clears the whole trio (SMS then falls back to
 * the `TWILIO_*` env vars, or no-ops); a non-null value must be non-empty
 * after trimming and requires all three (a half-set Twilio can't send). The
 * auth token is the secret — same write-only discipline as the Givebutter key.
 */
export const setTwilioCredentials = mutation({
  args: {
    accountSid: v.union(v.string(), v.null()),
    authToken: v.union(v.string(), v.null()),
    messagingServiceSid: v.union(v.string(), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, { accountSid, authToken, messagingServiceSid }) => {
    await requireSuperuser(ctx);
    const updatedBy = (await requireUserId(ctx)) as Id<"users">;

    const anyNull =
      accountSid === null || authToken === null || messagingServiceSid === null;
    const anySet =
      accountSid !== null || authToken !== null || messagingServiceSid !== null;

    let sid: string | undefined;
    let token: string | undefined;
    let msid: string | undefined;
    if (anySet && anyNull) {
      // Mixed null/non-null is ambiguous — either set all three or clear all.
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "Set the account SID, auth token, and messaging service together.",
      });
    }
    if (anySet) {
      sid = (accountSid as string).trim();
      token = (authToken as string).trim();
      msid = (messagingServiceSid as string).trim();
      if (!sid || !token || !msid) {
        throw new ConvexError({
          code: "INVALID_ARGUMENT",
          message: "Twilio account SID, auth token, and messaging service can't be empty.",
        });
      }
    }
    // The all-null clear path leaves sid/token/msid `undefined`, unsetting the
    // optional fields on patch (same null-sentinel convention as the key).

    const existing = await getSettings(ctx);
    const fields = {
      twilioAccountSid: sid,
      twilioAuthToken: token,
      twilioMessagingServiceSid: msid,
      updatedBy,
      updatedAt: Date.now(),
    };
    if (existing) {
      await ctx.db.patch(existing._id, fields);
    } else {
      await ctx.db.insert("integrationSettings", fields);
    }
    return null;
  },
});

/**
 * Action-facing read of the raw Twilio credentials (or `null` when the trio
 * isn't fully configured). The only path the auth token ever leaves the table
 * through — `lib/twilio.ts`'s `resolveTwilioCredentials` consults this via
 * `ctx.runQuery` before falling back to the `TWILIO_*` env vars. NEVER exposed
 * as a public function.
 */
export const readTwilioCredentials = internalQuery({
  args: {},
  returns: v.union(
    v.object({
      accountSid: v.string(),
      authToken: v.string(),
      messagingServiceSid: v.string(),
    }),
    v.null(),
  ),
  handler: async (ctx) => {
    const settings = await getSettings(ctx);
    const accountSid = settings?.twilioAccountSid;
    const authToken = settings?.twilioAuthToken;
    const messagingServiceSid = settings?.twilioMessagingServiceSid;
    if (!accountSid || !authToken || !messagingServiceSid) return null;
    return { accountSid, authToken, messagingServiceSid };
  },
});

/**
 * Set or clear the Resend email settings (own-key integration). SUPERUSER-ONLY.
 * `apiKey: null` clears BOTH fields (send then falls back to the
 * `RESEND_API_KEY`/`AUTH_EMAIL_FROM` env vars, or the logged no-op degrade);
 * a non-null `apiKey` must be non-empty after trimming and sets the key. The
 * from-address can be set alongside the key, or updated on its own
 * afterward (`apiKey` omitted) — but only once a key is already on file,
 * since there's nothing to send with otherwise. At least one of `apiKey` /
 * `fromAddress` must be provided. `fromAddress` is validated loosely (must
 * look like an email or `"Name <email>"`); a blank value clears it rather
 * than erroring, falling back to the env default at send time.
 */
export const setResendSettings = mutation({
  args: {
    apiKey: v.optional(v.union(v.string(), v.null())),
    fromAddress: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.null(),
  handler: async (ctx, { apiKey, fromAddress }) => {
    await requireSuperuser(ctx);
    const updatedBy = (await requireUserId(ctx)) as Id<"users">;
    const existing = await getSettings(ctx);

    if (apiKey === undefined && fromAddress === undefined) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "Provide an API key or a from address to update.",
      });
    }

    let key: string | undefined;
    let from: string | undefined;

    if (apiKey === null) {
      // `apiKey: null` clears BOTH fields, regardless of `fromAddress`.
      key = undefined;
      from = undefined;
    } else if (apiKey !== undefined) {
      const trimmed = apiKey.trim();
      if (!trimmed) {
        throw new ConvexError({
          code: "INVALID_ARGUMENT",
          message: "API key can't be empty.",
        });
      }
      key = trimmed;
      from =
        fromAddress === undefined
          ? existing?.resendFromAddress
          : fromAddress === null
            ? undefined
            : normalizeFromAddress(fromAddress);
    } else {
      // `apiKey` omitted — updating the from-address alone requires a key
      // already on file.
      if (!existing?.resendApiKey) {
        throw new ConvexError({
          code: "INVALID_ARGUMENT",
          message: "Set a Resend API key before updating the from address.",
        });
      }
      key = existing.resendApiKey;
      from =
        fromAddress === null ? undefined : normalizeFromAddress(fromAddress as string);
    }

    const fields = {
      resendApiKey: key,
      resendFromAddress: from,
      updatedBy,
      updatedAt: Date.now(),
    };
    if (existing) {
      await ctx.db.patch(existing._id, fields);
    } else {
      await ctx.db.insert("integrationSettings", fields);
    }
    return null;
  },
});

/**
 * Action-facing read of the raw Resend settings (or `null` when no key is
 * stored). The only path the API key ever leaves the table through —
 * `lib/resend.ts`'s `resolveResendSettings` consults this via `ctx.runQuery`
 * before falling back to the `RESEND_API_KEY`/`AUTH_EMAIL_FROM` env vars.
 * NEVER exposed as a public function.
 */
export const readResendSettings = internalQuery({
  args: {},
  returns: v.union(
    v.object({
      apiKey: v.string(),
      fromAddress: v.union(v.string(), v.null()),
    }),
    v.null(),
  ),
  handler: async (ctx) => {
    const settings = await getSettings(ctx);
    const apiKey = settings?.resendApiKey;
    if (!apiKey) return null;
    return { apiKey, fromAddress: settings?.resendFromAddress ?? null };
  },
});
