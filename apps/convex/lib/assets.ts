/**
 * Asset registry helpers shared by `inventory.ts` (the Inventory grid) and
 * `items.ts` (creating an asset from a supply row) — one insert path so the
 * append/order logic and input hygiene never fork.
 */
import { MutationCtx } from "../_generated/server";
import { ConvexError } from "convex/values";
import { Doc, Id } from "../_generated/dataModel";

/** Normalize a tags array: trim, drop empties, de-dupe, cap length. */
export function cleanTags(tags: string[] | undefined): string[] {
  if (!tags) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const t = raw.trim();
    if (t && !seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase());
      out.push(t);
    }
  }
  return out.slice(0, 24);
}

/**
 * Guard: an asset's owned quantity is a whole number that is NOT negative. 0 IS
 * allowed — a Chapter-Kit item you're targeting but don't own yet sits at 0.
 * Mirrors budget's `assertNonNegativeCents`.
 */
export function assertNonNegInt(quantity: number): void {
  if (quantity < 0 || !Number.isInteger(quantity)) {
    throw new ConvexError({
      code: "INVALID_QUANTITY",
      message: "Quantity must be a whole number (zero or more).",
    });
  }
}

/**
 * Insert an asset at the end of the chapter registry (order = current count;
 * bounded read — a chapter's gear list is a handful of rows). Name must already
 * be trimmed/validated non-empty and quantity a non-negative int; tags are
 * cleaned here.
 */
export async function insertAsset(
  ctx: MutationCtx,
  args: {
    chapterId: Id<"chapters">;
    userId: Id<"users">;
    name: string;
    tags?: string[];
    quantity: number;
    acquired?: boolean;
    consumable?: boolean;
    lowStockThreshold?: number;
    condition?: Doc<"assets">["condition"];
    stateNote?: string;
    note?: string;
    photoStorageId?: Id<"_storage">;
  },
): Promise<Id<"assets">> {
  const existing = await ctx.db
    .query("assets")
    .withIndex("by_chapter", (q) => q.eq("chapterId", args.chapterId))
    .collect();
  const now = Date.now();
  return await ctx.db.insert("assets", {
    chapterId: args.chapterId,
    name: args.name,
    tags: cleanTags(args.tags),
    quantity: args.quantity,
    acquired: args.acquired ?? true,
    consumable: args.consumable,
    lowStockThreshold: args.lowStockThreshold,
    condition: args.condition,
    stateNote: args.stateNote,
    note: args.note,
    photoStorageId: args.photoStorageId,
    order: existing.length,
    createdBy: args.userId,
    createdAt: now,
    updatedAt: now,
  });
}
