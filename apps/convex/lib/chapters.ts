/**
 * Chapter-fleet enumeration for Chapter OS.
 *
 * Prospect territories pre-create "shadow" `chapters` rows (`isActive: false`)
 * before a city actually launches — see `schema/chapters.ts`'s doc comment on
 * `isActive`. Those shadow rows must NEVER appear on a fleet surface (finance
 * roll-ups, org charts, dashboard rollups, cron fanouts, ops seeding, …):
 * `listActiveChapters` is the ONE helper every such enumerator uses so the
 * gate lives in a single place instead of being re-derived at each call site.
 *
 * House convention: `isActive` is optional and `isActive !== false` means
 * active (absent = active, matching every other `isActive` field in this
 * codebase). Do NOT flip this to `isActive === true` — that would silently
 * exclude every pre-existing chapter that predates the column.
 */
import { Doc } from "../_generated/dataModel";
import { QueryCtx } from "../_generated/server";

/** Active chapters only (excludes shadow/pre-launch territory rows), bounded
 *  by `limit`. In-memory filter after `.take()` — the house pattern for this
 *  codebase (no `.filter()` on db queries). */
export async function listActiveChapters(
  ctx: QueryCtx,
  limit = 200,
): Promise<Doc<"chapters">[]> {
  const chapters = await ctx.db.query("chapters").take(limit);
  return chapters.filter((c) => c.isActive !== false);
}
