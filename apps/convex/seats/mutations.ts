// ── Write mutations (assign / unassign) ─────────────────────────────────────
//
// Super-admin gated (v1 — mirrors `specializedRoles.ts`'s gating; a later PR
// may widen this to seat-capability-gated self-service delegation). A seat
// with a `legacyTitle` write-throughs to the legacy `specializedRoles` table
// (+ its finance bridge) via the SHARED implementation extracted above, so
// every existing finance gate that reads `specializedRoles`/`financeRoles`
// keeps seeing exactly the rows it sees today — assigning a seat and assigning
// the equivalent specialized role produce byte-for-byte the same legacy state.
import { mutation } from "../_generated/server";
import { ConvexError, v } from "convex/values";
import { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { MULTI_HOLDER_CAP } from "@events-os/shared";
import { requireUserId } from "../lib/context";
import { requireSuperuser } from "../lib/superuser";
import { assignSpecializedRoleImpl } from "../specializedRoles";
import {
  seatSodGroup,
  personHoldsOtherGroupSeatInScope,
  deleteSeatAssignment,
} from "./sodHelpers";

/** Bounded read of a (scope, seatDefId) slot's occupants — `MULTI_HOLDER_CAP`
 *  is the hard ceiling on any seat's holder count (single-holder seats never
 *  have more than one row in practice, but this bound is universal). */
const MAX_SLOT_READ = MULTI_HOLDER_CAP + 1;

/**
 * Shared implementation behind `assignSeat` AND the seat-change-proposal
 * approval flow (`seatProposals.approve`). Both entry points are gated by
 * their CALLERS before reaching here (super-admin for `assignSeat`; decider
 * eligibility for `approve`) — this helper itself does no auth check, so it
 * must never be exposed directly as a public mutation (mirrors
 * `specializedRoles.assignSpecializedRoleImpl`'s exact contract). `userId` is
 * the caller, recorded as `grantedBy`.
 *
 *  - Rejects a `derived` seat (its holders are computed, never assigned).
 *  - Rejects a chart/scope mismatch (central seat ⇔ `scope === "central"`;
 *    chapter seat ⇔ `scope` is a real chapter id).
 *  - Rejects a placeholder or nonexistent person.
 *  - Scope-local SoD: rejects if the person already holds a seat from the
 *    OTHER org-chart group (approve vs record) at this SAME scope.
 *  - `maxHolders === 1`: replaces the incumbent (today's `specializedRoles`
 *    slot semantics), reversing their write-through too. Assigning the
 *    CURRENT holder again is an idempotent no-op (re-affirms the bridge).
 *  - `maxHolders > 1`: rejects at cap; idempotent no-op if already a holder.
 *  - Write-through: a seat with a `legacyTitle` upserts the matching
 *    `specializedRoles` row (+ finance bridge) via the shared helper. Seats
 *    without a `legacyTitle` write nothing to legacy tables.
 *
 * CAVEAT — the "idempotent no-op" re-affirm can still mutate legacy tables
 * under DIVERGENCE. "Idempotent" describes `seatAssignments`: no new row, same
 * assignment id returned. But the re-affirm still calls
 * `assignSpecializedRoleImpl` for the seat's own holder, and that helper
 * enforces "one holder per (scope, legacyTitle) slot" — so if the legacy slot
 * has drifted to a DIFFERENT person B (e.g. reassigned directly through
 * `specializedRoles.assignSpecializedRole` after this seat was assigned to A),
 * re-affirming A's seat EVICTS B from the legacy slot and revokes B's finance
 * bridge, even though nothing changed in `seatAssignments`. This is
 * intentional "seat wins" write-through semantics (the seat is the source of
 * truth once assigned) and it preserves read-parity between the two tables —
 * but it means a caller relying on the no-op label to mean "no legacy-table
 * side effects" would be wrong under divergence. Divergence itself should be
 * rare/transient (both paths write through the same helper), but it IS
 * reachable, e.g. by another actor calling `specializedRoles.
 * assignSpecializedRole` directly on a slot this seat already occupies.
 */
export async function assignSeatImpl(
  ctx: MutationCtx,
  userId: Id<"users">,
  {
    seatDefId,
    scope,
    personId,
  }: {
    seatDefId: Id<"seatDefs">;
    scope: Id<"chapters"> | "central";
    personId: Id<"people">;
  },
): Promise<Id<"seatAssignments">> {
  const def = await ctx.db.get(seatDefId);
  if (!def) {
    throw new ConvexError({ code: "NOT_FOUND", message: "That seat doesn't exist." });
  }
  if (def.derived === true) {
    throw new ConvexError({
      code: "DERIVED_SEAT",
      message: "This seat's holders are computed automatically and can't be assigned directly.",
    });
  }

  const scopeIsCentral = scope === "central";
  if (def.chart === "central" && !scopeIsCentral) {
    throw new ConvexError({
      code: "INVALID_SCOPE",
      message: "This seat belongs to the central chart.",
    });
  }
  if (def.chart === "chapter" && scopeIsCentral) {
    throw new ConvexError({
      code: "INVALID_SCOPE",
      message: "This seat belongs to a chapter chart — pass a chapter id.",
    });
  }
  if (!scopeIsCentral) {
    const chapter = await ctx.db.get(scope as Id<"chapters">);
    if (!chapter) {
      throw new ConvexError({ code: "NOT_FOUND", message: "That chapter doesn't exist." });
    }
  }

  const person = await ctx.db.get(personId);
  if (!person) {
    throw new ConvexError({ code: "NOT_FOUND", message: "That person doesn't exist." });
  }
  if (person.isPlaceholder === true) {
    throw new ConvexError({
      code: "INVALID_PERSON",
      message: "A placeholder person can't be assigned a seat.",
    });
  }

  // Existing occupants of this exact (scope, seatDefId) slot.
  const existing = await ctx.db
    .query("seatAssignments")
    .withIndex("by_scope_and_seat", (q) =>
      q.eq("scope", scope).eq("seatDefId", seatDefId),
    )
    .take(MAX_SLOT_READ);
  const sameHolder = existing.find((a) => a.personId === personId);

  // Scope-local SoD — skipped for the idempotent same-holder case (no NEW
  // conflict is introduced by reaffirming a seat someone already holds).
  if (!sameHolder) {
    const group = seatSodGroup(def);
    if (group) {
      const otherGroup = group === "approve" ? "record" : "approve";
      if (await personHoldsOtherGroupSeatInScope(ctx, personId, scope, otherGroup)) {
        throw new ConvexError({
          code: "SOD_VIOLATION",
          message:
            "Separation of duties: one person can't hold both an approve-side and a record-side seat in the same scope.",
        });
      }
    }
  }

  if (sameHolder) {
    // Idempotent no-op for `seatAssignments` — but re-affirm the
    // write-through, mirroring `assignSpecializedRoleImpl`'s own idempotent
    // re-affirm. NOTE: if the legacy (scope, legacyTitle) slot has diverged
    // to a DIFFERENT person, this re-affirm call evicts them and revokes
    // their finance bridge (one-holder-per-slot) — see the CAVEAT on this
    // function's doc comment. Legacy tables are NOT guaranteed no-op here.
    if (def.legacyTitle) {
      await assignSpecializedRoleImpl(ctx, userId, {
        personId,
        scope,
        title: def.legacyTitle,
      });
    }
    return sameHolder._id;
  }

  if (def.maxHolders === 1) {
    // Replace the incumbent (today's specializedRoles slot semantics),
    // reversing their write-through the same way `unassignSeat` would.
    for (const incumbent of existing) {
      await deleteSeatAssignment(ctx, incumbent, def);
    }
  } else if (existing.length >= def.maxHolders) {
    throw new ConvexError({
      code: "SEAT_FULL",
      message: `This seat already has its maximum of ${def.maxHolders} holders.`,
    });
  }

  const assignmentId = await ctx.db.insert("seatAssignments", {
    seatDefId,
    scope,
    personId,
    grantedBy: userId,
    createdAt: Date.now(),
  });

  if (def.legacyTitle) {
    await assignSpecializedRoleImpl(ctx, userId, {
      personId,
      scope,
      title: def.legacyTitle,
    });
  }

  return assignmentId;
}

/**
 * Assign a person to a seat, at a scope. Super-admin only — thin wrapper
 * around `assignSeatImpl` (see its doc comment for the full validation this
 * enforces).
 */
export const assignSeat = mutation({
  args: {
    seatDefId: v.id("seatDefs"),
    scope: v.union(v.id("chapters"), v.literal("central")),
    personId: v.id("people"),
  },
  returns: v.id("seatAssignments"),
  handler: async (ctx, { seatDefId, scope, personId }) => {
    await requireSuperuser(ctx);
    const userId = (await requireUserId(ctx)) as Id<"users">;
    return await assignSeatImpl(ctx, userId, { seatDefId, scope, personId });
  },
});

/**
 * Shared implementation behind `unassignSeat` AND the seat-change-proposal
 * approval flow (`seatProposals.approve`, for a `"vacate"` proposal). No auth
 * check — callers gate (mirrors `removeSpecializedRoleImpl`'s exact
 * contract). Deletes the assignment and reverses its write-through (if the
 * seat has a `legacyTitle`) through the same shared helper
 * `assignSeatImpl`'s incumbent-replacement path uses.
 */
export async function unassignSeatImpl(
  ctx: MutationCtx,
  assignmentId: Id<"seatAssignments">,
): Promise<null> {
  const assignment = await ctx.db.get(assignmentId);
  if (!assignment) {
    throw new ConvexError({
      code: "NOT_FOUND",
      message: "That seat assignment doesn't exist.",
    });
  }

  const def = await ctx.db.get(assignment.seatDefId);
  if (!def) {
    // Stale assignment on a deleted def — nothing to write-through-reverse.
    await ctx.db.delete(assignmentId);
    return null;
  }

  await deleteSeatAssignment(ctx, assignment, def);
  return null;
}

/**
 * Unassign a seat holder. Super-admin only — thin wrapper around
 * `unassignSeatImpl`.
 */
export const unassignSeat = mutation({
  args: { assignmentId: v.id("seatAssignments") },
  returns: v.null(),
  handler: async (ctx, { assignmentId }) => {
    await requireSuperuser(ctx);
    return await unassignSeatImpl(ctx, assignmentId);
  },
});
