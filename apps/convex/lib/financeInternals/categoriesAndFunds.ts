import { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { ROLLUP_SCAN_LIMIT } from "./constants";
import { ensureDefaultFunds, insertDefaultExpenseCategories } from "../seed/finance";

/**
 * Resolve a chapter's General Fund to hang the default categories off of: prefer
 * the "General Fund" by name, else the lowest-sortOrder unrestricted fund, else
 * the lowest-sortOrder fund. Returns `null` for a fund-less chapter.
 *
 * NOT the same resolver as `lib/finance.ts#defaultFundId` (#145) — that one
 * auto-codes NEW spend and must never fall back to a restricted fund, so it
 * stops at `null` instead of picking one. This one is a migration/merge-target
 * picker (seeding default categories, merging funds into "General") where any
 * existing fund is an acceptable keeper, restricted or not.
 */
export async function findGeneralFundId(
  ctx: MutationCtx,
  chapterId: Id<"chapters">,
): Promise<Id<"funds"> | null> {
  const funds = await ctx.db
    .query("funds")
    .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
    .take(ROLLUP_SCAN_LIMIT);
  if (funds.length === 0) return null;
  const byName = funds.find((f) => f.name === "General Fund");
  if (byName) return byName._id;
  const byOrder = [...funds].sort((a, b) => a.sortOrder - b.sortOrder);
  const unrestricted = byOrder.find((f) => f.restriction === "unrestricted");
  return (unrestricted ?? byOrder[0])._id;
}

/**
 * Shared: seed one chapter's default fund + expense categories. First ensures
 * the chapter's default fund exists (General Fund — the only fund, see
 * WP-1.4) — so a chapter created before the finance seed (zero funds) is fixed
 * in one shot — then seeds the default categories under its General Fund.
 * Idempotent (skips funds / categories whose names already exist). Returns the
 * count of categories inserted (0 if, unexpectedly, no General Fund can be
 * resolved).
 */
export async function seedDefaultCategoriesForChapter(
  ctx: MutationCtx,
  chapterId: Id<"chapters">,
  now: number,
): Promise<number> {
  await ensureDefaultFunds(ctx, chapterId, now);
  const fundId = await findGeneralFundId(ctx, chapterId);
  if (!fundId) return 0;
  return await insertDefaultExpenseCategories(ctx, chapterId, fundId, now);
}

/** Walk up from `startId`; true iff `targetId` is reachable (would form a cycle). */
export async function categoryAncestorHits(
  ctx: QueryCtx,
  startId: Id<"budgetCategories"> | undefined,
  targetId: Id<"budgetCategories">,
): Promise<boolean> {
  let cursor = startId;
  let guard = 0;
  while (cursor && guard < 1000) {
    if (cursor === targetId) return true;
    const node: Doc<"budgetCategories"> | null = await ctx.db.get(cursor);
    cursor = node?.parentCategoryId;
    guard++;
  }
  return false;
}
