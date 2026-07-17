import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Two-party seat-change proposals.
 *
 * A seat holder PROPOSES filling or vacating a seat strictly BELOW one of
 * their own seats in the org-chart tree; a holder of a seat ABOVE the
 * proposer must APPROVE before the change takes effect. See
 * `seatProposals.ts` (root) for the full authorization semantics: the tree
 * walk over the live `seatDefs` rows (NOT the static `@events-os/shared`
 * template, so runtime-added seats participate), the chapter→central rollup
 * bridge (`CHAPTER_ROLLUP_PARENT`), and "nearest occupied ancestor of the
 * proposer's qualifying seat, skipping the proposer themself" approver
 * resolution.
 *
 * Approving a proposal is meant to EXECUTE the change atomically via the
 * exact same validated path `seats.assignSeat`/`unassignSeat` enforce
 * (maxHolders replace-or-cap, scope-local SoD, derived-seat rejection, the
 * `specializedRoles`/finance write-through bridge) — a proposal must never
 * bypass a check direct assignment enforces. `seats.ts` doesn't yet expose
 * that validated logic as an auth-free helper the way
 * `specializedRoles.assignSpecializedRoleImpl` does, so as of this table's
 * landing the `approve` mutation itself is NOT YET SHIPPED (see the doc
 * comment at the top of `seatProposals.ts` for the precise export needed).
 * `status` nonetheless has an `"approved"` value reserved for it.
 *
 * `scope` mirrors `seatAssignments.scope` — a real chapter id, or the
 * `"central"` sentinel (this repo never uses null for "no chapter").
 */

const scopeValidator = v.union(v.id("chapters"), v.literal("central"));
const actionValidator = v.union(v.literal("fill"), v.literal("vacate"));
const statusValidator = v.union(
  v.literal("pending"),
  v.literal("approved"),
  v.literal("declined"),
  v.literal("cancelled"),
);

export const seatProposals = defineTable({
  seatDefId: v.id("seatDefs"),
  scope: scopeValidator,
  action: actionValidator,
  // Who the proposal is ABOUT: for `"fill"`, the person to assign; for
  // `"vacate"`, the current holder to remove (validated at propose time).
  subjectPersonId: v.id("people"),
  // The proposer's OWN roster row — derived server-side from the caller's
  // identity (never accepted as a raw input), picked as the nearest of the
  // caller's own seats that's a strict ancestor of `seatDefId`/`scope`.
  proposedByPersonId: v.id("people"),
  status: statusValidator,
  decidedByPersonId: v.optional(v.id("people")),
  note: v.optional(v.string()),
  createdAt: v.number(),
  decidedAt: v.optional(v.number()),
})
  // Pending-by-scope: `pendingProposals({scope})` and the duplicate-pending
  // check at propose time. Also queried with just the `status` prefix for
  // `pendingProposals({})` (every scope).
  .index("by_status_and_scope", ["status", "scope"])
  // `myProposals()` — every proposal (any status) the caller made.
  .index("by_proposer", ["proposedByPersonId"]);
