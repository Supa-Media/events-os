/**
 * User profile + onboarding.
 *
 * Access is gated to @publicworship.life accounts (see lib/access.ts). These
 * functions do their OWN auth + access checks and do NOT go through
 * `requireChapterId` — they're what a brand-new (pre-chapter) user calls to
 * onboard.
 */
import { query, mutation } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { v, ConvexError } from "convex/values";
import { getOptionalAuth } from "@supa-media/convex/auth";
import { requireUserId, requireAccess, isAllowedEmail } from "./lib/context";

/** Load the current user's profile row (or null). */
async function getProfile(ctx: any, userId: string) {
  return await ctx.db
    .query("userProfiles")
    .withIndex("by_userId", (q: any) => q.eq("userId", userId))
    .first();
}

/** Does the user have a chapter membership yet? */
async function getMembership(ctx: any, userId: string) {
  return await ctx.db
    .query("userChapters")
    .withIndex("by_userId", (q: any) => q.eq("userId", userId))
    .first();
}

/**
 * The signed-in user's onboarding/access status. Drives the app gate:
 *   - `allowed === false`  → access-denied screen
 *   - `!onboarded`         → onboarding screen
 *   - otherwise            → the app
 *
 * Uses the (non-throwing) optional-auth helper so it returns `null` gracefully
 * when signed out, and does NOT run the chapter gate (a new user has none yet).
 */
export const me = query({
  args: {},
  handler: async (ctx) => {
    const user = await getOptionalAuth(ctx);
    if (!user) return null;

    const email = (user.email as string | undefined) ?? null;
    const allowed = isAllowedEmail(email);

    const profile = allowed ? await getProfile(ctx, user._id) : null;
    const membership = allowed ? await getMembership(ctx, user._id) : null;

    const hasProfile = !!profile;
    const hasChapter = !!membership;

    return {
      userId: user._id as Id<"users">,
      email,
      allowed,
      hasProfile,
      hasChapter,
      onboarded: hasProfile && hasChapter,
      profile: profile
        ? { name: profile.name as string, phone: profile.phone as string }
        : null,
    };
  },
});

/**
 * Active chapters the onboarding picker offers. Requires an allowed account but
 * NOT chapter membership (the user is choosing one).
 */
export const listChapters = query({
  args: {},
  handler: async (ctx) => {
    await requireAccess(ctx);
    const chapters = await ctx.db.query("chapters").collect();
    return chapters
      .filter((c: any) => c.isActive !== false)
      .sort((a: any, b: any) => a.name.localeCompare(b.name))
      .map((c: any) => ({ _id: c._id as Id<"chapters">, name: c.name as string }));
  },
});

/**
 * First-time onboarding: save the user's profile (name + phone) and join the
 * chosen chapter. Idempotent on re-run (upserts the profile, only adds the
 * membership if missing).
 */
export const completeOnboarding = mutation({
  args: {
    name: v.string(),
    phone: v.string(),
    chapterId: v.id("chapters"),
  },
  handler: async (ctx, args) => {
    await requireAccess(ctx);
    const userId = await requireUserId(ctx);
    const now = Date.now();

    const name = args.name.trim();
    const phone = args.phone.trim();
    if (!name) {
      throw new ConvexError({ code: "INVALID_NAME", message: "Name is required." });
    }
    if (!phone) {
      throw new ConvexError({ code: "INVALID_PHONE", message: "Phone is required." });
    }

    const chapter = await ctx.db.get(args.chapterId);
    if (!chapter) {
      throw new ConvexError({
        code: "CHAPTER_NOT_FOUND",
        message: "That chapter no longer exists.",
      });
    }

    // Upsert the profile.
    const existing = await getProfile(ctx, userId);
    if (existing) {
      await ctx.db.patch(existing._id, { name, phone, updatedAt: now });
    } else {
      await ctx.db.insert("userProfiles", {
        userId: userId as Id<"users">,
        name,
        phone,
        createdAt: now,
      });
    }

    // Ensure a membership to the chosen chapter.
    const membership = await getMembership(ctx, userId);
    if (!membership) {
      await ctx.db.insert("userChapters", {
        userId: userId as Id<"users">,
        chapterId: args.chapterId,
        role: "member",
        isActive: true,
        joinedAt: now,
      });
    }

    return { ok: true };
  },
});

/** Edit the current user's profile (name + phone). Name can't be cleared. */
export const updateProfile = mutation({
  args: {
    name: v.optional(v.string()),
    phone: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAccess(ctx);
    const userId = await requireUserId(ctx);

    const profile = await getProfile(ctx, userId);
    if (!profile) {
      throw new ConvexError({
        code: "NO_PROFILE",
        message: "Finish onboarding before editing your profile.",
      });
    }

    const patch: { name?: string; phone?: string; updatedAt: number } = {
      updatedAt: Date.now(),
    };
    if (args.name !== undefined) {
      const name = args.name.trim();
      if (!name) {
        throw new ConvexError({
          code: "INVALID_NAME",
          message: "Name can't be empty.",
        });
      }
      patch.name = name;
    }
    if (args.phone !== undefined) {
      patch.phone = args.phone.trim();
    }

    await ctx.db.patch(profile._id, patch);
    return { ok: true };
  },
});
