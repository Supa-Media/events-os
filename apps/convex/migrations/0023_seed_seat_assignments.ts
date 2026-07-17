import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";
import type { Id } from "../_generated/dataModel";

/**
 * Org chart v1: seed `seatAssignments` from legacy `specializedRoles` rows.
 *
 * Each `specializedRoles` row has a (personId, scope, title) triple. This
 * migration maps the title (optionally scoped) to a seat slug via legacyTitle,
 * resolves the corresponding `seatDefs` row, and inserts a `seatAssignments`
 * row with the same scope and personId.
 *
 * Title → seat slug mapping:
 * - `executive_director` @ central → `executive_director` seat
 * - `president` @ chapter → `chapter_director` seat
 * - `finance_manager` @ central → `financial_manager` seat
 * - `finance_manager` @ chapter → `treasurer` seat
 *
 * Unknown titles are skipped and counted; idempotency is achieved by checking
 * for an existing (seatDefId, scope, personId) triple before inserting. The
 * `createdAt` timestamp is preserved from the original `specializedRoles` row,
 * and `grantedBy` is populated from `createdBy` if present.
 *
 * This migration does NOT touch `financeRoles` or call any bridge — the legacy
 * rows already exist; this migration only mirrors them into seats.
 */
export async function runSeedSeatAssignments(ctx: MutationCtx) {
  let created = 0;
  let skipped = 0;
  let unknownTitles = 0;
  const now = Date.now();

  // Collect all legacy specializedRoles rows.
  const specializedRoles = await ctx.db.query("specializedRoles").collect();

  // Map title + scope → seat slug (resolved at runtime from seatDefs.legacyTitle).
  const titleToSeatSlug = new Map<string, string>();

  // Pre-populate the mapping from seatDefs.legacyTitle.
  const seatDefs = await ctx.db.query("seatDefs").collect();
  for (const seatDef of seatDefs) {
    if (seatDef.legacyTitle) {
      // Store both the title alone and a title@scope key for context-aware lookups.
      // For now, we'll use a simpler approach: build a map keyed by title + scope check.
      if (!titleToSeatSlug.has(seatDef.legacyTitle)) {
        titleToSeatSlug.set(seatDef.legacyTitle, seatDef.slug);
      }
    }
  }

  for (const role of specializedRoles) {
    const { title, scope, personId, createdBy, createdAt } = role;

    // Determine the target seat slug based on title and scope.
    let targetSlug: string | null = null;

    if (title === "executive_director" && scope === "central") {
      targetSlug = "executive_director";
    } else if (title === "president" && scope !== "central") {
      // president is only for chapters (scope is a chapterId, not "central").
      targetSlug = "chapter_director";
    } else if (title === "finance_manager" && scope === "central") {
      targetSlug = "financial_manager";
    } else if (title === "finance_manager" && scope !== "central") {
      // finance_manager at a chapter scope maps to treasurer.
      targetSlug = "treasurer";
    }

    if (!targetSlug) {
      unknownTitles++;
      continue;
    }

    // Resolve the seatDef by slug.
    const seatDef = await ctx.db
      .query("seatDefs")
      .withIndex("by_slug", (q) => q.eq("slug", targetSlug as string))
      .unique();

    if (!seatDef) {
      // This shouldn't happen if migrations are ordered correctly, but skip if it does.
      unknownTitles++;
      continue;
    }

    // Check for an existing identical (seatDefId, scope, personId) assignment.
    const allAssignments = await ctx.db
      .query("seatAssignments")
      .collect();

    const existing = allAssignments.find(
      (a) =>
        a.seatDefId === seatDef._id &&
        a.scope === scope &&
        a.personId === personId,
    );

    if (existing) {
      skipped++;
      continue;
    }

    // Insert the new seatAssignments row.
    await ctx.db.insert("seatAssignments", {
      seatDefId: seatDef._id,
      scope,
      personId,
      ...(createdBy !== undefined ? { grantedBy: createdBy } : {}),
      createdAt,
    });
    created++;
  }

  return { created, skipped, unknownTitles };
}

export const seedSeatAssignments: Migration = {
  name: "0023_seed_seat_assignments",
  run: runSeedSeatAssignments,
};
