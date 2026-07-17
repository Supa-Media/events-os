import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";

/**
 * Org chart v1: seed `seatAssignments` from legacy `specializedRoles` rows.
 *
 * Each `specializedRoles` row has a (personId, scope, title) triple. This
 * migration maps the title (optionally scoped) to a seat slug, resolves the
 * corresponding `seatDefs` row, and inserts a `seatAssignments` row with the
 * same scope and personId.
 *
 * Title → seat slug mapping:
 * - `executive_director` @ central → `executive_director` seat
 * - `president` @ chapter → `chapter_director` seat
 * - `finance_manager` @ central → `financial_manager` seat
 * - `finance_manager` @ chapter → `treasurer` seat
 *
 * Malformed rows (title/scope combinations that don't map, or seatDefs
 * lookup failures) are skipped and logged. Idempotency is achieved by
 * checking for pre-existing (seatDefId, scope, personId) assignments via
 * index query. The `createdAt` timestamp is preserved from the original
 * `specializedRoles` row, and `grantedBy` is populated from `createdBy`
 * if present.
 *
 * This migration mirrors legacy data without touching `financeRoles` or
 * calling any bridge — the legacy rows already exist; this migration only
 * populates the new seats table.
 */
export async function runSeedSeatAssignments(ctx: MutationCtx) {
  let created = 0;
  let skipped = 0;
  let skippedMalformed = 0;
  const skippedMalformedIds: string[] = [];

  // Collect all legacy specializedRoles rows.
  const specializedRoles = await ctx.db.query("specializedRoles").collect();

  for (const role of specializedRoles) {
    const { _id: roleId, title, scope, personId, createdBy, createdAt } = role;

    // Determine the target seat slug based on title and scope.
    let targetSlug: string | null = null;
    let malformationReason: string | null = null;

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
    } else {
      // Malformed: title/scope combo doesn't map to any seat.
      malformationReason = `unhandled title/scope: ${title}@${
        scope === "central" ? "central" : "chapter"
      }`;
    }

    if (!targetSlug) {
      skippedMalformed++;
      skippedMalformedIds.push(`${roleId} (${malformationReason})`);
      continue;
    }

    // Resolve the seatDef by slug.
    const seatDef = await ctx.db
      .query("seatDefs")
      .withIndex("by_slug", (q) => q.eq("slug", targetSlug as string))
      .unique();

    if (!seatDef) {
      // This shouldn't happen if migrations are ordered correctly (0022 must
      // run before 0023), but log it if it does so we can diagnose.
      skippedMalformed++;
      skippedMalformedIds.push(`${roleId} (seatDef not found: slug ${targetSlug})`);
      continue;
    }

    // Check for an existing identical (seatDefId, scope, personId) assignment
    // using the index for O(1) lookups that scale with data growth.
    const candidates = await ctx.db
      .query("seatAssignments")
      .withIndex("by_scope_and_seat", (q) =>
        q.eq("scope", scope).eq("seatDefId", seatDef._id),
      )
      .collect();

    const existing = candidates.find((a) => a.personId === personId);

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

  // Log malformed rows if any, so operators can investigate.
  if (skippedMalformed > 0) {
    console.warn(
      `[0023_seed_seat_assignments] Skipped ${skippedMalformed} malformed specializedRoles:`,
      skippedMalformedIds,
    );
  }

  return { created, skipped, skippedMalformed };
}

export const seedSeatAssignments: Migration = {
  name: "0023_seed_seat_assignments",
  run: runSeedSeatAssignments,
};
