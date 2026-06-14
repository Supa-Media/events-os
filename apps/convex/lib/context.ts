/**
 * Request context helpers for Events OS.
 *
 * Typed loosely (`ctx: any`) so this file doesn't depend on Convex's generated
 * types — it's pure helper code, not a registered function. Every app function
 * resolves the caller's chapter through `requireChapterId` so chapter scoping
 * is enforced in one place.
 */
import { requireAuthId } from "@supa-media/convex/auth";
import { ConvexError } from "convex/values";
import { requireAccess } from "./access";

export {
  ALLOWED_EMAIL_DOMAIN,
  isAllowedEmail,
  getUserEmail,
  requireAccess,
} from "./access";

/** The authenticated user's id (throws if signed out). */
export async function requireUserId(ctx: any): Promise<string> {
  return await requireAuthId(ctx);
}

/**
 * The chapter the caller belongs to (MVP: their first/only membership).
 * Multi-chapter switching is V3; until then a user has exactly one chapter.
 */
export async function requireChapterId(ctx: any): Promise<string> {
  await requireAccess(ctx);
  const userId = await requireAuthId(ctx);
  const membership = await ctx.db
    .query("userChapters")
    .withIndex("by_userId", (q: any) => q.eq("userId", userId))
    .first();
  if (!membership) {
    throw new ConvexError({
      code: "NO_CHAPTER",
      message: "You don't belong to a chapter yet.",
    });
  }
  return membership.chapterId as string;
}

/**
 * The caller's chapter, or null if they don't belong to one yet. Auth is still
 * required. Use in READ queries so a brand-new user (pre-seed / pre-onboarding)
 * gets empty results instead of a thrown error that crashes the screen.
 */
export async function getChapterIdOrNull(ctx: any): Promise<string | null> {
  await requireAccess(ctx);
  const userId = await requireAuthId(ctx);
  const membership = await ctx.db
    .query("userChapters")
    .withIndex("by_userId", (q: any) => q.eq("userId", userId))
    .first();
  return membership ? (membership.chapterId as string) : null;
}

/** Assert a document exists and belongs to the caller's chapter. */
export async function requireInChapter(
  ctx: any,
  chapterId: string,
  doc: { chapterId?: string } | null,
  label = "Record",
): Promise<void> {
  if (!doc || doc.chapterId !== chapterId) {
    throw new ConvexError({
      code: "NOT_FOUND",
      message: `${label} not found in your chapter.`,
    });
  }
}
