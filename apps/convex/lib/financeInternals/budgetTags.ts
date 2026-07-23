import { ConvexError } from "convex/values";
import { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { type BUDGET_TAG_KINDS } from "@events-os/shared";
import { type BudgetLevel, tagLevelAllowed } from "./budgetCore";
import { ROLLUP_SCAN_LIMIT } from "./constants";

/** Load a tag and assert it's usable at the budget's level, else throw. */
export async function requireTagInLevel(
  ctx: QueryCtx,
  budgetLevel: BudgetLevel,
  tagId: Id<"budgetTags">,
): Promise<Doc<"budgetTags">> {
  const tag = await ctx.db.get(tagId);
  if (!tag || !tagLevelAllowed(tag.chapterId, budgetLevel)) {
    throw new ConvexError({
      code: "NOT_FOUND",
      message: "Tag not found at this budget's level.",
    });
  }
  return tag;
}

/**
 * Find-or-create a managed tag at a level. Dedups by (level, kind, refId) via
 * `by_chapter_and_ref` when a `refId` is given, else by (name, kind) within the
 * level. Used by the event auto-tag on create + the scope→type migration.
 */
export async function ensureTag(
  ctx: MutationCtx,
  args: {
    chapterId: BudgetLevel;
    name: string;
    kind: (typeof BUDGET_TAG_KINDS)[number];
    refId?: string;
    createdBy?: Id<"users">;
  },
): Promise<Id<"budgetTags">> {
  if (args.refId) {
    const byRef = await ctx.db
      .query("budgetTags")
      .withIndex("by_chapter_and_ref", (q) =>
        q.eq("chapterId", args.chapterId).eq("kind", args.kind).eq("refId", args.refId),
      )
      .first();
    if (byRef) return byRef._id;
  }
  const byName = (
    await ctx.db
      .query("budgetTags")
      .withIndex("by_chapter", (q) => q.eq("chapterId", args.chapterId))
      .take(ROLLUP_SCAN_LIMIT)
  ).find((t) => t.name === args.name && t.kind === args.kind);
  if (byName) return byName._id;
  return await ctx.db.insert("budgetTags", {
    chapterId: args.chapterId,
    name: args.name,
    kind: args.kind,
    refId: args.refId,
    createdBy: args.createdBy,
    createdAt: Date.now(),
  });
}

/** Insert a budget↔tag link unless one already exists in `seen`. */
export async function linkBudgetTag(
  ctx: MutationCtx,
  budgetId: Id<"budgets">,
  budgetLevel: BudgetLevel,
  tagId: Id<"budgetTags">,
  seen: Set<string>,
): Promise<void> {
  if (seen.has(tagId)) return;
  seen.add(tagId);
  await ctx.db.insert("budgetTagLinks", {
    budgetId,
    tagId,
    chapterId: budgetLevel,
    createdAt: Date.now(),
  });
}

/**
 * Auto-tag a one_time EVENT budget: ensure + link the event's eventType
 * `template` tag AND a catch-all `events` tag. No-op if `scopeRefId` doesn't
 * resolve to an event. Shared by `createBudget` and the migration.
 */
export async function autoTagEventBudget(
  ctx: MutationCtx,
  budgetId: Id<"budgets">,
  budgetLevel: BudgetLevel,
  scopeRefId: string | undefined,
  seen: Set<string>,
  createdBy?: Id<"users">,
): Promise<void> {
  const eventsTag = await ensureTag(ctx, {
    chapterId: budgetLevel,
    name: "Events",
    kind: "events",
    createdBy,
  });
  await linkBudgetTag(ctx, budgetId, budgetLevel, eventsTag, seen);
  if (!scopeRefId) return;
  const ev = await ctx.db.get(scopeRefId as Id<"events">);
  if (!ev || !("eventTypeId" in ev)) return;
  const et = await ctx.db.get((ev as Doc<"events">).eventTypeId);
  if (!et) return;
  const templateTag = await ensureTag(ctx, {
    chapterId: budgetLevel,
    name: (et as Doc<"eventTypes">).name,
    kind: "template",
    refId: (ev as Doc<"events">).eventTypeId,
    createdBy,
  });
  await linkBudgetTag(ctx, budgetId, budgetLevel, templateTag, seen);
}

/**
 * Auto-tag a one_time PROJECT budget with a catch-all "Projects" tag (kind
 * `"custom"` — projects get no dedicated tag kind; WP-3.4: "keep tags as-is,
 * no new tag investment"). Mirrors `autoTagEventBudget`'s "Events" catch-all;
 * unlike an event, a project has no per-instance "template" to also tag.
 * Shared by `projects.create` (the create-time hook) and `backfillProjectBudgets`.
 */
export async function autoTagProjectBudget(
  ctx: MutationCtx,
  budgetId: Id<"budgets">,
  budgetLevel: BudgetLevel,
  seen: Set<string>,
  createdBy?: Id<"users">,
): Promise<void> {
  const projectsTag = await ensureTag(ctx, {
    chapterId: budgetLevel,
    name: "Projects",
    kind: "custom",
    createdBy,
  });
  await linkBudgetTag(ctx, budgetId, budgetLevel, projectsTag, seen);
}

/** Load a budget's linked tags as `{ id, name, kind }`, via `by_budget`. */
export async function loadBudgetTags(
  ctx: QueryCtx,
  budgetId: Id<"budgets">,
  tagCache: Map<string, Doc<"budgetTags"> | null>,
): Promise<{ id: Id<"budgetTags">; name: string; kind: (typeof BUDGET_TAG_KINDS)[number] | null }[]> {
  const links = await ctx.db
    .query("budgetTagLinks")
    .withIndex("by_budget", (q) => q.eq("budgetId", budgetId))
    .take(ROLLUP_SCAN_LIMIT);
  const out: { id: Id<"budgetTags">; name: string; kind: (typeof BUDGET_TAG_KINDS)[number] | null }[] = [];
  for (const link of links) {
    let tag = tagCache.get(link.tagId);
    if (tag === undefined) {
      tag = await ctx.db.get(link.tagId);
      tagCache.set(link.tagId, tag);
    }
    if (tag) out.push({ id: tag._id, name: tag.name, kind: tag.kind ?? null });
  }
  return out;
}
