/**
 * Digital Card Profile — PW card art pipeline (WP-C.2). Part of the
 * `increase*` module family (see `increase.ts`'s header for the module map).
 *
 * Four ops steps, run in order once real card art exists (the final PNG with
 * the Visa logo placed is an owner/designer step — this pipeline just takes
 * any conforming PNG):
 *   1. `uploadCardArtAssets`   — POST /files (card art 1536x969 + a 100x100
 *                                icon), stores the returned file ids.
 *   2. `createDigitalCardProfile` — POST /digital_card_profiles from those
 *                                file ids, stores the returned profile id
 *                                (status starts "pending").
 *   3. `refreshCardArtProfileStatus` — GET /digital_card_profiles/{id},
 *                                stores whatever review status Increase (and/
 *                                or the card network) currently reports. Run
 *                                this repeatedly until it logs "active".
 *   4. `backfillCardWallets` — PATCH /cards/{id} on every existing
 *                                non-canceled card to write its whole
 *                                `digital_wallet` object (the cardholder's
 *                                wallet-verification email + this profile);
 *                                new cards get the same at issuance
 *                                (`cards.ts`'s `issueCard`, via
 *                                `getCardArtProfileId` + `buildDigitalWallet`).
 *                                Both this step and issuance only ever attach a
 *                                profile whose stored status is "active" — a
 *                                pending or rejected profile attaches to
 *                                nothing, but the email is still written (it is
 *                                what enables add-to-wallet at all, and does
 *                                not depend on card art existing).
 * All four are MODE-AWARE and DEGRADE (log + return, never throw) when the
 * relevant environment's Increase key isn't configured — same discipline as
 * `increaseProvision.ts`'s `runProvisionFlow`.
 */
import {
  internalQuery,
  internalMutation,
  internalAction,
} from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { isSandboxObjectId } from "@events-os/shared";
import {
  increaseEnvForMode,
  increaseEnvForObjectId,
  increaseGet,
  increasePost,
  increasePatch,
  buildDigitalWallet,
} from "./lib/increaseApi";
import { increasePostFile } from "./lib/increaseFiles";

/** The review states Increase's Digital Card Profile process moves through —
 *  `GET /digital_card_profiles/{id}`'s `status` field. Anything Increase
 *  returns that ISN'T `"active"`/`"rejected"` is treated as still `"pending"`
 *  (`normalizeCardArtProfileStatus`) — a conservative default, since only
 *  `"active"` ever unlocks attaching the profile to a card. */
type CardArtProfileStatus = "pending" | "active" | "rejected";

function normalizeCardArtProfileStatus(raw: unknown): CardArtProfileStatus {
  return raw === "active" || raw === "rejected" ? raw : "pending";
}

/** Read the current mode's card-art config (file ids + profile id/status, if
 *  minted) off the `financeSettings` singleton. Shared by `getCardArtFileIds`,
 *  `getCardArtProfileId`, and `getCardArtProfileRecord` below. */
async function readCardArtConfig(
  ctx: { db: QueryCtx["db"] },
  sandbox: boolean,
): Promise<{
  fileId: string;
  iconFileId: string;
  profileId?: string;
  profileStatus?: CardArtProfileStatus;
} | null> {
  const settings = await ctx.db.query("financeSettings").first();
  const config = sandbox ? settings?.cardArtSandbox : settings?.cardArt;
  return config ?? null;
}

/**
 * Store the given environment's freshly-uploaded file ids on the
 * `financeSettings` singleton. Upserts the row (mirrors `financeSettings.ts`'s
 * own `setSandboxMode`) — a fresh deployment may not have run that mutation
 * yet. Deliberately does NOT touch `profileId`: a re-upload only refreshes the
 * file ids, leaving any previously-minted profile in place (now stale, but a
 * profile is immutable — `createDigitalCardProfile` mints a fresh one from the
 * new ids when explicitly re-run).
 */
export const finishUploadCardArtAssets = internalMutation({
  args: { sandbox: v.boolean(), fileId: v.string(), iconFileId: v.string() },
  returns: v.null(),
  handler: async (ctx, { sandbox, fileId, iconFileId }): Promise<null> => {
    const existing = await ctx.db.query("financeSettings").first();
    const key: "cardArt" | "cardArtSandbox" = sandbox
      ? "cardArtSandbox"
      : "cardArt";
    const prior = existing
      ? sandbox
        ? existing.cardArtSandbox
        : existing.cardArt
      : undefined;
    const patch = {
      [key]: {
        fileId,
        iconFileId,
        profileId: prior?.profileId,
        profileStatus: prior?.profileStatus,
      },
    };
    if (existing) {
      await ctx.db.patch(existing._id, patch);
    } else {
      await ctx.db.insert("financeSettings", {
        sandboxMode: false,
        updatedAt: Date.now(),
        ...patch,
      });
    }
    return null;
  },
});

/**
 * Upload the two Digital Wallet card-art assets (WP-C.2) to Increase's Files
 * API and store the returned file ids. Args are base64-encoded PNG bytes (no
 * `data:` prefix) so this is workflow-passable (`run-convex-function.yml` can
 * pass string args) without ever putting the image bytes in the repo.
 * `cardArtBase64` must be the 1536x969 landscape card image; `iconBase64` the
 * 100x100 app icon (both PNG, both grounded against increase.com/documentation
 * /card-art). MODE-AWARE: targets whichever environment the live
 * `financeSettings.sandboxMode` toggle points at (same as `runProvisionFlow`)
 * — flip it before running to target sandbox vs. production. DEGRADES (logs +
 * returns null ids) when that environment's Increase key is unset.
 *
 * CLI/CI-runnable:
 *   npx convex run increaseCardArt:uploadCardArtAssets -- '{"cardArtBase64":"...","iconBase64":"..."}'
 */
export const uploadCardArtAssets = internalAction({
  args: { cardArtBase64: v.string(), iconBase64: v.string() },
  returns: v.object({
    sandbox: v.boolean(),
    fileId: v.union(v.string(), v.null()),
    iconFileId: v.union(v.string(), v.null()),
  }),
  handler: async (
    ctx,
    { cardArtBase64, iconBase64 },
  ): Promise<{
    sandbox: boolean;
    fileId: string | null;
    iconFileId: string | null;
  }> => {
    const sandbox = await ctx.runQuery(
      internal.financeSettings.readSandboxMode,
      {},
    );
    const { key, base } = increaseEnvForMode(sandbox);
    if (!key) {
      console.warn(
        `[increase] uploadCardArtAssets skipped: Increase API key not configured for ${sandbox ? "sandbox" : "production"}`,
      );
      return { sandbox, fileId: null, iconFileId: null };
    }

    const fileId = await increasePostFile(
      key,
      base,
      cardArtBase64,
      "card-art.png",
      "digital_wallet_artwork",
    );
    const iconFileId = await increasePostFile(
      key,
      base,
      iconBase64,
      "card-icon.png",
      "digital_wallet_app_icon",
    );
    await ctx.runMutation(internal.increaseCardArt.finishUploadCardArtAssets, {
      sandbox,
      fileId,
      iconFileId,
    });
    console.log(
      `[increase] uploadCardArtAssets: stored ${sandbox ? "sandbox" : "production"} file ids (art=${fileId}, icon=${iconFileId})`,
    );
    return { sandbox, fileId, iconFileId };
  },
});

/** Patch the freshly-minted Digital Card Profile id onto the current mode's
 *  config — the `profileId` field of the schema's card-art config shape; the
 *  file ids are already set by `finishUploadCardArtAssets` and untouched
 *  here. A fresh profile always starts `profileStatus: "pending"` — Increase
 *  hasn't reviewed it yet; `refreshCardArtProfileStatus` is the only thing
 *  that ever advances it to `"active"`/`"rejected"`. */
export const finishCreateDigitalCardProfile = internalMutation({
  args: { sandbox: v.boolean(), profileId: v.string() },
  returns: v.null(),
  handler: async (ctx, { sandbox, profileId }): Promise<null> => {
    const existing = await ctx.db.query("financeSettings").first();
    const prior = sandbox ? existing?.cardArtSandbox : existing?.cardArt;
    if (!existing || !prior) {
      // Shouldn't happen (createDigitalCardProfile only reaches here once
      // uploadCardArtAssets already stored file ids) — log and no-op rather
      // than insert a config row with no file ids.
      console.error(
        "[increase] finishCreateDigitalCardProfile: no card-art file ids on record — skipping",
      );
      return null;
    }
    const key: "cardArt" | "cardArtSandbox" = sandbox
      ? "cardArtSandbox"
      : "cardArt";
    await ctx.db.patch(existing._id, {
      [key]: { ...prior, profileId, profileStatus: "pending" },
    });
    return null;
  },
});

/**
 * Create the Digital Card Profile (WP-C.2) from the current mode's uploaded
 * file ids — `POST /digital_card_profiles`, grounded against
 * `increase-typescript`'s `DigitalCardProfileCreateParams`: required
 * `background_image_file_id` (the card art), `app_icon_file_id`,
 * `card_description` + `issuer_name` (both "Public Worship" — the app-facing
 * name shown in the wallet) and an internal `description`; `text_color`
 * defaults to white but is set explicitly per the PRD ({red,green,blue}:255).
 *
 * The profile comes back `status:"pending"` — Increase (and/or the card
 * network) reviews it before it can be assigned to cards; see the PR
 * description for that process. MODE-AWARE / DEGRADES like
 * `uploadCardArtAssets`; additionally degrades (logs + returns null) when
 * this mode has no uploaded file ids yet.
 *
 * CLI/CI-runnable: npx convex run increaseCardArt:createDigitalCardProfile
 */
export const createDigitalCardProfile = internalAction({
  args: {},
  returns: v.union(v.string(), v.null()),
  handler: async (ctx): Promise<string | null> => {
    const sandbox = await ctx.runQuery(
      internal.financeSettings.readSandboxMode,
      {},
    );
    const { key, base } = increaseEnvForMode(sandbox);
    if (!key) {
      console.warn(
        `[increase] createDigitalCardProfile skipped: Increase API key not configured for ${sandbox ? "sandbox" : "production"}`,
      );
      return null;
    }
    const config = await ctx.runQuery(internal.increaseCardArt.getCardArtFileIds, {
      sandbox,
    });
    if (!config) {
      console.warn(
        `[increase] createDigitalCardProfile skipped: no card-art file ids uploaded yet for ${sandbox ? "sandbox" : "production"} — run uploadCardArtAssets first`,
      );
      return null;
    }

    const profile = await increasePost(key, base, "/digital_card_profiles", {
      background_image_file_id: config.fileId,
      app_icon_file_id: config.iconFileId,
      card_description: "Public Worship",
      issuer_name: "Public Worship",
      description: "Public Worship — card art (WP-C.2)",
      text_color: { red: 255, green: 255, blue: 255 },
    });
    const profileId =
      typeof profile.id === "string" && profile.id ? profile.id : null;
    if (!profileId) {
      console.error(
        "[increase] createDigitalCardProfile: response carried no usable id; raw response:",
        JSON.stringify(profile),
      );
      return null;
    }
    await ctx.runMutation(
      internal.increaseCardArt.finishCreateDigitalCardProfile,
      {
        sandbox,
        profileId,
      },
    );
    console.log(
      `[increase] createDigitalCardProfile: created ${profileId} (status=${String(profile.status ?? "unknown")}) for ${sandbox ? "sandbox" : "production"}`,
    );
    return profileId;
  },
});

/** The current mode's uploaded card-art file ids (action-facing — actions have
 *  no `ctx.db`). Null when nothing's been uploaded yet for that mode. */
export const getCardArtFileIds = internalQuery({
  args: { sandbox: v.boolean() },
  returns: v.union(
    v.object({ fileId: v.string(), iconFileId: v.string() }),
    v.null(),
  ),
  handler: async (ctx, { sandbox }) => {
    const config = await readCardArtConfig(ctx, sandbox);
    return config
      ? { fileId: config.fileId, iconFileId: config.iconFileId }
      : null;
  },
});

/**
 * The current mode's Digital Card Profile id, if one has been minted AND
 * Increase has reviewed it as `"active"` — read by `cards.ts`'s `issueCard`
 * (mode from the account it's issuing on) and `backfillCardWallets` below
 * (mode from each existing card's own id prefix). Null both when no profile
 * exists yet for that mode AND when one exists but is still `"pending"`/was
 * `"rejected"` — issuance/backfill then omit `digital_wallet` entirely rather
 * than attach a profile Increase hasn't cleared (which would otherwise
 * silently attach to every issued card with no signal it isn't really live).
 * Use `getCardArtProfileRecord` instead when the id is needed regardless of
 * status (`refreshCardArtProfileStatus` polling).
 */
export const getCardArtProfileId = internalQuery({
  args: { sandbox: v.boolean() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, { sandbox }) => {
    const config = await readCardArtConfig(ctx, sandbox);
    return config?.profileId && config.profileStatus === "active"
      ? config.profileId
      : null;
  },
});

/**
 * The current mode's minted Digital Card Profile id + its last-known review
 * status, UNGATED (unlike `getCardArtProfileId` above, which only surfaces
 * the id once `profileStatus === "active"`). Used exclusively by
 * `refreshCardArtProfileStatus` below, which needs to know WHICH profile to
 * poll regardless of whether it's cleared review yet. Null when no profile
 * has been minted for this mode.
 */
export const getCardArtProfileRecord = internalQuery({
  args: { sandbox: v.boolean() },
  returns: v.union(
    v.object({
      profileId: v.string(),
      profileStatus: v.union(
        v.literal("pending"),
        v.literal("active"),
        v.literal("rejected"),
      ),
    }),
    v.null(),
  ),
  handler: async (ctx, { sandbox }) => {
    const config = await readCardArtConfig(ctx, sandbox);
    if (!config?.profileId) return null;
    return {
      profileId: config.profileId,
      profileStatus: config.profileStatus ?? "pending",
    };
  },
});

/** Patch the current mode's stored `profileStatus` — the result of
 *  `refreshCardArtProfileStatus`'s `GET /digital_card_profiles/{id}` poll. */
export const finishRefreshCardArtProfileStatus = internalMutation({
  args: {
    sandbox: v.boolean(),
    status: v.union(
      v.literal("pending"),
      v.literal("active"),
      v.literal("rejected"),
    ),
  },
  returns: v.null(),
  handler: async (ctx, { sandbox, status }): Promise<null> => {
    const existing = await ctx.db.query("financeSettings").first();
    const prior = sandbox ? existing?.cardArtSandbox : existing?.cardArt;
    if (!existing || !prior) {
      // Shouldn't happen (refreshCardArtProfileStatus only reaches here once
      // getCardArtProfileRecord already found a minted profile) — log and
      // no-op rather than insert a config row with no file ids.
      console.error(
        "[increase] finishRefreshCardArtProfileStatus: no card-art config on record — skipping",
      );
      return null;
    }
    const key: "cardArt" | "cardArtSandbox" = sandbox
      ? "cardArtSandbox"
      : "cardArt";
    await ctx.db.patch(existing._id, {
      [key]: { ...prior, profileStatus: status },
    });
    return null;
  },
});

/**
 * Ops step (WP-C.2, run repeatedly between `createDigitalCardProfile` and
 * `backfillCardWallets`): poll Increase's review status for the current
 * mode's minted Digital Card Profile — `GET /digital_card_profiles/{id}` —
 * and store whatever status it currently reports. A profile starts
 * `"pending"`; Increase (and/or the card network) eventually resolves it to
 * `"active"` (safe to attach — `getCardArtProfileId` then starts returning
 * it) or `"rejected"` (re-upload art per Increase's feedback and re-mint via
 * `createDigitalCardProfile`). LOGS LOUDLY on every call, success or
 * skip/degrade — this is a manual ops poll the operator watches to know when
 * to move to the next step, not a background job. MODE-AWARE / DEGRADES like
 * the rest of the pipeline: no key configured, or no profile minted yet for
 * this mode, logs a warning and returns null rather than throwing.
 *
 * CLI/CI-runnable:
 *   npx convex run increaseCardArt:refreshCardArtProfileStatus
 *   gh workflow run run-convex-function.yml -f function=increaseCardArt:refreshCardArtProfileStatus
 */
export const refreshCardArtProfileStatus = internalAction({
  args: {},
  returns: v.union(
    v.object({
      profileId: v.string(),
      status: v.union(
        v.literal("pending"),
        v.literal("active"),
        v.literal("rejected"),
      ),
    }),
    v.null(),
  ),
  handler: async (
    ctx,
  ): Promise<{ profileId: string; status: CardArtProfileStatus } | null> => {
    const sandbox = await ctx.runQuery(
      internal.financeSettings.readSandboxMode,
      {},
    );
    const { key, base } = increaseEnvForMode(sandbox);
    if (!key) {
      console.warn(
        `[increase] refreshCardArtProfileStatus skipped: Increase API key not configured for ${sandbox ? "sandbox" : "production"}`,
      );
      return null;
    }
    const record = await ctx.runQuery(
      internal.increaseCardArt.getCardArtProfileRecord,
      {
        sandbox,
      },
    );
    if (!record) {
      console.warn(
        `[increase] refreshCardArtProfileStatus skipped: no Digital Card Profile minted yet for ${sandbox ? "sandbox" : "production"} — run createDigitalCardProfile first`,
      );
      return null;
    }

    const profile = await increaseGet(
      key,
      base,
      `/digital_card_profiles/${record.profileId}`,
    );
    const status = normalizeCardArtProfileStatus(profile.status);
    await ctx.runMutation(
      internal.increaseCardArt.finishRefreshCardArtProfileStatus,
      {
        sandbox,
        status,
      },
    );
    console.log(
      `[increase] refreshCardArtProfileStatus: ${record.profileId} (${sandbox ? "sandbox" : "production"}) is now "${status}" (raw Increase status: ${String(profile.status ?? "unknown")})`,
    );
    return { profileId: record.profileId, status };
  },
});

/** Every card (any chapter) eligible for the `digital_wallet` backfill: a real
 *  Increase card (`increaseCardId` set — a "legacy" Relay card has none and no
 *  vendor object to PATCH) that isn't canceled (a canceled card will never
 *  authorize again; attaching art or a wallet contact to it is pointless).
 *  Carries the cardholder's `pwEmail` for `buildDigitalWallet` — null only for
 *  a card whose `people` row vanished, or one issued before `isCardEligible`
 *  made the address mandatory. */
export const listCardsForArtBackfill = internalQuery({
  args: {},
  returns: v.array(
    v.object({
      cardId: v.id("cards"),
      increaseCardId: v.string(),
      cardholderEmail: v.union(v.string(), v.null()),
    }),
  ),
  handler: async (ctx) => {
    const rows = await ctx.db.query("cards").collect();
    const eligible = rows.filter(
      (c) => c.status !== "canceled" && !!c.increaseCardId,
    );
    return await Promise.all(
      eligible.map(async (c) => {
        const person = await ctx.db.get(c.cardholderPersonId);
        return {
          cardId: c._id,
          increaseCardId: c.increaseCardId!,
          cardholderEmail: person?.pwEmail ?? null,
        };
      }),
    );
  },
});

/**
 * Ops backfill: write the full `digital_wallet` object — the cardholder's
 * wallet-verification email plus the Digital Card Profile (WP-C.2 card art),
 * whichever of the two is available — onto every existing non-canceled card.
 * New cards get the same object at issuance (`cards.ts`'s `issueCard`); this
 * is the sweep for cards minted before that. `PATCH /cards/{id}`, grounded
 * against the Increase Cards resource's update endpoint (confirmed
 * `digital_wallet` IS patchable, not create-only).
 *
 * BOTH KEYS ALWAYS TRAVEL TOGETHER (`buildDigitalWallet`) — Increase takes
 * `digital_wallet` as a whole object, so a sweep that wrote only the profile
 * id would drop the email that makes "Add to Apple Wallet" work, and vice
 * versa. That is also why this no longer skips a card whose environment has no
 * minted profile: the email alone is worth writing, and it is the common case
 * until the card-art pipeline has been run.
 *
 * Each card is routed to ITS OWN environment by its `increaseCardId` prefix
 * (`increaseEnvForObjectId`) and reads THAT environment's profile id — a
 * sandbox card never gets the production profile id or vice versa. A card with
 * NEITHER an email nor a profile for its environment, or with no configured
 * key, is SKIPPED (not an error) — re-running after `uploadCardArtAssets` +
 * `createDigitalCardProfile` picks up the profile later. Idempotent: PATCHing
 * the same object twice is a no-op on Increase's side, so a re-run is always
 * safe.
 *
 * CLI/CI-runnable:
 *   npx convex run increaseCardArt:backfillCardWallets
 *   gh workflow run run-convex-function.yml -f function=increaseCardArt:backfillCardWallets
 */
export const backfillCardWallets = internalAction({
  args: {},
  returns: v.object({
    eligible: v.number(),
    patched: v.number(),
    skipped: v.number(),
  }),
  handler: async (
    ctx,
  ): Promise<{ eligible: number; patched: number; skipped: number }> => {
    const cards = await ctx.runQuery(
      internal.increaseCardArt.listCardsForArtBackfill,
      {},
    );
    let patched = 0;
    let skipped = 0;
    // One profile-id lookup per environment for the whole run — every card in
    // the same environment shares the same config.
    const profileIdByMode = new Map<boolean, string | null>();

    for (const c of cards) {
      const sandbox = isSandboxObjectId(c.increaseCardId);
      if (!profileIdByMode.has(sandbox)) {
        profileIdByMode.set(
          sandbox,
          await ctx.runQuery(internal.increaseCardArt.getCardArtProfileId, {
            sandbox,
          }),
        );
      }
      const profileId = profileIdByMode.get(sandbox) ?? null;
      if (!profileId && !c.cardholderEmail) {
        // Nothing to write — no wallet contact AND no art for this env.
        skipped += 1;
        continue;
      }
      const { key, base } = increaseEnvForObjectId(c.increaseCardId);
      if (!key) {
        console.warn(
          `[increase] backfillCardWallets: skipped card ${c.increaseCardId} — no Increase key for its environment`,
        );
        skipped += 1;
        continue;
      }
      try {
        await increasePatch(key, base, `/cards/${c.increaseCardId}`, {
          digital_wallet: c.cardholderEmail
            ? buildDigitalWallet(c.cardholderEmail, profileId)
            : { digital_card_profile_id: profileId! },
        });
        patched += 1;
      } catch (err) {
        console.error(
          `[increase] backfillCardWallets: PATCH failed for card ${c.increaseCardId}:`,
          err,
        );
        skipped += 1;
      }
    }
    return { eligible: cards.length, patched, skipped };
  },
});
