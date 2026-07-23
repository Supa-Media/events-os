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
import { ConvexError } from "convex/values";
import { Id } from "./_generated/dataModel";
import { requireUserId, getChapterIdOrNull } from "./lib/context";
import { getFinanceRole, requireCentralEdOrFm } from "./lib/finance";
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

// ── Org-wide finance policy (receipt deadline + card prerequisite) ────────────

/** Largest permitted no-receipt auto-convert window, in days. A charge should
 *  convert well within a normal statement cycle; anything past a year is a
 *  fat-finger, not a policy. */
export const MAX_NO_RECEIPT_CONVERT_DAYS = 365;

/**
 * Read the org-wide "auto-convert a still-un-receipted charge to a personal
 * repayment after N days" window. `null` = the policy is OFF (the default —
 * nothing auto-converts until central finance picks a number). Shared by the
 * daily sweep (`cards.autoConvertOverdueReceipts`) and the policy UI.
 */
export async function readNoReceiptAutoConvertDays(
  ctx: QueryCtx,
): Promise<number | null> {
  const settings = await ctx.db.query("financeSettings").first();
  return settings?.noReceiptAutoConvertDays ?? null;
}

/**
 * Read the org-wide Academy course slug a member must complete before a card
 * can be issued/activated. `null` = no prerequisite gate (issuance unaffected).
 * Shared by the card-issuance gate and the policy UI.
 */
export async function readCardPrerequisiteCourseSlug(
  ctx: QueryCtx,
): Promise<string | null> {
  const settings = await ctx.db.query("financeSettings").first();
  return settings?.cardPrerequisiteCourseSlug ?? null;
}

/**
 * The org-wide finance policy the settings UI reads. Same safe-default posture
 * as `getFinanceSettings`: a caller with no finance role (or no chapter) gets
 * the inert defaults (`{ noReceiptAutoConvertDays: null,
 * cardPrerequisiteCourseSlug: null }`) instead of a throw, so an
 * unconditionally-mounted policy panel can't crash a no-role persona.
 */
export const getFinancePolicy = query({
  args: {},
  returns: v.object({
    noReceiptAutoConvertDays: v.union(v.number(), v.null()),
    cardPrerequisiteCourseSlug: v.union(v.string(), v.null()),
  }),
  handler: async (
    ctx,
  ): Promise<{
    noReceiptAutoConvertDays: number | null;
    cardPrerequisiteCourseSlug: string | null;
  }> => {
    const chapterId = (await getChapterIdOrNull(ctx)) as Id<"chapters"> | null;
    const inert = { noReceiptAutoConvertDays: null, cardPrerequisiteCourseSlug: null };
    if (!chapterId) return inert;
    const access = await getFinanceRole(ctx, chapterId);
    if (access.role == null) return inert;
    return {
      noReceiptAutoConvertDays: await readNoReceiptAutoConvertDays(ctx),
      cardPrerequisiteCourseSlug: await readCardPrerequisiteCourseSlug(ctx),
    };
  },
});

/**
 * Set (or clear) the org-wide finance policy fields. Deployment-wide finance
 * policy is central finance's call, so this is gated on a central ED/FM (the
 * same gate the other org-wide finance levers use). Each arg is independently
 * optional: omit a field to leave it unchanged, pass `null` to clear it (turn
 * the policy off), or a value to set it. Upserts the singleton row.
 */
export const setFinancePolicy = mutation({
  args: {
    noReceiptAutoConvertDays: v.optional(v.union(v.number(), v.null())),
    cardPrerequisiteCourseSlug: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.object({
    noReceiptAutoConvertDays: v.union(v.number(), v.null()),
    cardPrerequisiteCourseSlug: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    await requireCentralEdOrFm(ctx);
    const updatedBy = (await requireUserId(ctx)) as Id<"users">;

    const patch: {
      noReceiptAutoConvertDays?: number | undefined;
      cardPrerequisiteCourseSlug?: string | undefined;
    } = {};

    if (args.noReceiptAutoConvertDays !== undefined) {
      if (args.noReceiptAutoConvertDays === null) {
        patch.noReceiptAutoConvertDays = undefined; // clear → policy off
      } else {
        const days = args.noReceiptAutoConvertDays;
        if (!Number.isInteger(days) || days < 1 || days > MAX_NO_RECEIPT_CONVERT_DAYS) {
          throw new ConvexError({
            code: "INVALID_ARGUMENT",
            message: `The no-receipt deadline must be a whole number of days between 1 and ${MAX_NO_RECEIPT_CONVERT_DAYS}.`,
          });
        }
        patch.noReceiptAutoConvertDays = days;
      }
    }

    if (args.cardPrerequisiteCourseSlug !== undefined) {
      if (args.cardPrerequisiteCourseSlug === null) {
        patch.cardPrerequisiteCourseSlug = undefined; // clear → no prerequisite
      } else {
        const slug = args.cardPrerequisiteCourseSlug.trim();
        if (slug.length === 0) {
          throw new ConvexError({
            code: "INVALID_ARGUMENT",
            message: "The card prerequisite course slug can't be empty.",
          });
        }
        patch.cardPrerequisiteCourseSlug = slug;
      }
    }

    const existing = await ctx.db.query("financeSettings").first();
    if (existing) {
      await ctx.db.patch(existing._id, { ...patch, updatedBy, updatedAt: Date.now() });
    } else {
      await ctx.db.insert("financeSettings", {
        sandboxMode: false,
        ...patch,
        updatedBy,
        updatedAt: Date.now(),
      });
    }

    // Return the TRUE merged state: a patched field reflects its new value; an
    // omitted field keeps whatever was already stored (don't report it null).
    const finalDays = "noReceiptAutoConvertDays" in patch
      ? (patch.noReceiptAutoConvertDays ?? null)
      : (existing?.noReceiptAutoConvertDays ?? null);
    const finalSlug = "cardPrerequisiteCourseSlug" in patch
      ? (patch.cardPrerequisiteCourseSlug ?? null)
      : (existing?.cardPrerequisiteCourseSlug ?? null);
    return {
      noReceiptAutoConvertDays: finalDays,
      cardPrerequisiteCourseSlug: finalSlug,
    };
  },
});
