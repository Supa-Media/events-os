/**
 * User profile + onboarding.
 *
 * Access is gated to @publicworship.life accounts (see lib/access.ts). These
 * functions do their OWN auth + access checks and do NOT go through
 * `requireChapterId` — they're what a brand-new (pre-chapter) user calls to
 * onboard.
 */
import {
  query,
  mutation,
  internalMutation,
  QueryCtx,
  MutationCtx,
} from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { v, ConvexError } from "convex/values";
import { getOptionalAuth } from "@supa-media/convex/auth";
import { requireUserId, requireAccess, isAllowedEmail } from "./lib/context";
import { findUnlinkedPersonByLoginEmail, claimFields } from "./lib/people";

/** Load the current user's profile row (or null). */
async function getProfile(ctx: QueryCtx, userId: string) {
  return await ctx.db
    .query("userProfiles")
    .withIndex("by_userId", (q) => q.eq("userId", userId as Id<"users">))
    .first();
}

/** Does the user have a chapter membership yet? */
async function getMembership(ctx: QueryCtx, userId: string) {
  return await ctx.db
    .query("userChapters")
    .withIndex("by_userId", (q) => q.eq("userId", userId as Id<"users">))
    .first();
}

/**
 * Mirror a logged-in staff member into the People roster as a TEAM MEMBER,
 * linked back to their account via `people.userId`. This is what lets them be
 * set as an event owner or hold a lead role (both reference `people`, not the
 * auth account). Upserts the linked row and keeps name/phone in sync.
 *
 * To avoid duplicating someone who's already on the roster (e.g. they were
 * imported as core team by email/pwEmail before they ever signed in), we first
 * look for a row already linked to this account, then fall back to matching an
 * UNLINKED row in the same chapter by EITHER their personal `email` or their
 * publicworship `pwEmail` — the login email is always the publicworship one, so
 * matching pwEmail is what catches an imported team member. Only when neither
 * exists do we insert a fresh row.
 *
 * `fields.email` is the login (publicworship) address; we record it as `pwEmail`
 * and never overwrite an existing personal `email` with it.
 */
async function syncStaffPerson(
  ctx: MutationCtx,
  userId: string,
  chapterId: string,
  fields: { name?: string; email?: string | null; phone?: string | null },
) {
  const existing =
    (await ctx.db
      .query("people")
      .withIndex("by_user", (q) => q.eq("userId", userId as Id<"users">))
      .first()) ??
    (await findUnlinkedPersonByLoginEmail(ctx, chapterId, fields.email));

  if (existing) {
    await ctx.db.patch(existing._id, {
      chapterId: chapterId as Id<"chapters">,
      isActive: existing.isActive ?? true,
      // Claim the row for this account + sync pwEmail without clobbering email.
      ...claimFields(existing, userId, fields.email),
      ...(fields.name !== undefined ? { name: fields.name } : null),
      ...(fields.phone !== undefined ? { phone: fields.phone ?? undefined } : null),
    });
    return existing._id;
  }

  const loginEmail = fields.email ?? undefined;
  return await ctx.db.insert("people", {
    chapterId: chapterId as Id<"chapters">,
    userId: userId as Id<"users">,
    name: fields.name ?? "Team member",
    email: loginEmail,
    pwEmail: loginEmail,
    phone: fields.phone ?? undefined,
    isTeamMember: true,
    isActive: true,
    createdAt: Date.now(),
  });
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
      .filter((c) => c.isActive !== false)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((c) => ({ _id: c._id as Id<"chapters">, name: c.name as string }));
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

    // Mirror this staff member into the chapter's People roster (team member).
    const auth = await getOptionalAuth(ctx);
    await syncStaffPerson(ctx, userId, args.chapterId, {
      name,
      email: (auth?.email as string | undefined) ?? null,
      phone,
    });

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

    // Keep the linked People-roster row in sync.
    const membership = await getMembership(ctx, userId);
    if (membership) {
      const auth = await getOptionalAuth(ctx);
      await syncStaffPerson(ctx, userId, membership.chapterId as string, {
        name: patch.name,
        phone: patch.phone,
        email: (auth?.email as string | undefined) ?? null,
      });
    }

    return { ok: true };
  },
});

/**
 * Dev/admin backfill: ensure every onboarded staff member has a linked People
 * row (team member) in their chapter. Idempotent. Run once after deploying the
 * People-sync change. Internal-only (one-off migration), invoked from the
 * Convex dashboard or another backend function — never exposed to clients.
 */
export const backfillStaffPeople = internalMutation({
  args: {},
  handler: async (ctx) => {
    const profiles = await ctx.db.query("userProfiles").collect();
    let synced = 0;
    for (const p of profiles) {
      const membership = await getMembership(ctx, p.userId);
      if (!membership) continue; // not onboarded into a chapter yet
      const user = await ctx.db.get(p.userId as Id<"users">);
      await syncStaffPerson(ctx, p.userId as string, membership.chapterId as string, {
        name: p.name as string,
        phone: p.phone as string,
        email: (user?.email as string | undefined) ?? null,
      });
      synced++;
    }
    return { profiles: profiles.length, synced };
  },
});
