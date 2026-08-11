/**
 * Blog authorization — who may see the reaction ledger and clear rows off it.
 *
 * Two audiences, deliberately split:
 *
 *  - READING and LEAVING a reaction is fully public and unauthenticated. That
 *    path never comes through here; it's the anonymous `/api/blog/reactions`
 *    surface (see lib/blogApiRoutes.ts). There is no login on
 *    publicworship.life to gate it with.
 *
 *  - SEEING the aggregate (which posts landed, per-post totals) and CLEARING
 *    reactions off a post is staff work, and it goes through the pair below.
 *
 * Today the answer to "who is staff here?" is "anyone signed in with a
 * chapter" — the blog has one author team and no reason for a narrower gate
 * yet. Per CLAUDE.md's "gate it behind a power, even when it's open today",
 * that answer still lives behind a NAMED resolver rather than an inline check
 * at each call site, so tightening it later is this file's body and nothing
 * else. When it needs to be a real seat capability, the graduation is:
 *
 *   1. add `"blog.moderate"` to SEAT_CAPABILITIES (packages/shared/src/seats.ts),
 *   2. list it on the seats that should carry it in SEAT_DEFS,
 *   3. swap `requireChapterId` below for the effective-capability check —
 *      copy `lib/campaignsAccess.ts`, which is the same shape already graduated.
 *
 * Refusals throw `ConvexError({ code, message })`, never a plain `Error`, so
 * the app's AuthErrorBoundary can surface them like every other gate here.
 */
import { ConvexError } from "convex/values";
import { QueryCtx } from "../_generated/server";
import { requireChapterId } from "./context";
import { isSuperuser } from "./superuser";

/**
 * Does the caller hold the blog-moderation power?
 *
 * Non-throwing form, for queries that want to SHOW or HIDE a surface rather
 * than refuse it. Superusers pass — the bootstrap path mirrored across the
 * repo's other gates.
 */
export async function hasBlogModerate(ctx: QueryCtx): Promise<boolean> {
  if (await isSuperuser(ctx)) return true;
  try {
    // Today: any signed-in member of a chapter. Graduates to the
    // `blog.moderate` seat capability — see this module's doc.
    await requireChapterId(ctx);
    return true;
  } catch {
    return false;
  }
}

/** Throwing form. Every moderation call site uses THIS, never the check. */
export async function requireBlogModerate(ctx: QueryCtx): Promise<void> {
  if (await hasBlogModerate(ctx)) return;
  throw new ConvexError({
    code: "FORBIDDEN",
    message: "You don't have access to the blog's reactions.",
  });
}
