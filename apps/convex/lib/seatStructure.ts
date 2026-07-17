/**
 * Shared helpers for the org-chart STRUCTURE editor (`seatStructure.ts`):
 * the `org.editChart` permission gate and the self-lockout capability-diff
 * simulation. Split out so the read query (`structureLog`) and every write
 * mutation share the exact same gate, and every mutation shares the exact
 * same "did this edit just brick my own access" check.
 *
 * REAL-MONEY-ADJACENT: seat definitions carry finance powers (see
 * `SEAT_CAPABILITIES` in `@events-os/shared`), so structural edits here are
 * gated as tightly as `seats.assignSeat`'s super-admin gate, PLUS the
 * self-lockout guard below — a permission invariant, not just a UX nicety.
 */
import { ConvexError } from "convex/values";
import type { SeatCapability } from "@events-os/shared";
import { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { requireAccess, requireUserId } from "./context";
import { isSuperuser } from "./superuser";

/** Bound on how many `seatAssignments` rows a single roster person can hold
 *  — generous headroom over any real org (mirrors `seats.ts`'s own
 *  `personHoldsOtherGroupSeatInScope` bound of 200). */
const MAX_PERSON_ASSIGNMENTS = 200;

/** The caller's own (non-placeholder) roster rows, across every chapter —
 *  mirrors `seats.ts`'s `mySeatAssignments` user→people walk. Usually 0 or 1
 *  row; more than one only for a person on more than one chapter's roster. */
async function callerPersonIds(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
): Promise<Id<"people">[]> {
  const rows = await ctx.db
    .query("people")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  return rows.filter((p) => p.isPlaceholder !== true).map((p) => p._id);
}

/** A def, keyed by its id, standing in for the REAL row during a
 *  self-lockout SIMULATION — `null` means "this seat no longer exists"
 *  (`removeSeat`). Nothing here touches the database; it's a pure
 *  what-if substitution used only inside `effectiveCapabilities`. */
export type DefOverride = Doc<"seatDefs"> | null;

/**
 * The union of capabilities every one of `personIds`' CURRENT seat
 * assignments carries. `overrides` lets a caller substitute a SIMULATED def
 * for the one (or few) rows an in-flight mutation is about to change,
 * without writing anything — the self-lockout check runs entirely "on
 * paper" before any write commits.
 */
export async function effectiveCapabilities(
  ctx: QueryCtx | MutationCtx,
  personIds: Id<"people">[],
  overrides?: Map<Id<"seatDefs">, DefOverride>,
): Promise<Set<SeatCapability>> {
  const caps = new Set<SeatCapability>();
  for (const personId of personIds) {
    const assignments = await ctx.db
      .query("seatAssignments")
      .withIndex("by_person", (q) => q.eq("personId", personId))
      .take(MAX_PERSON_ASSIGNMENTS);
    for (const a of assignments) {
      const def = overrides?.has(a.seatDefId)
        ? overrides.get(a.seatDefId)!
        : await ctx.db.get(a.seatDefId);
      if (!def) continue;
      for (const c of def.capabilities) caps.add(c);
    }
  }
  return caps;
}

export interface ChartEditor {
  userId: Id<"users">;
  /** Every roster row belonging to the caller — used both to resolve an
   *  `editorPersonId` for the audit log and to run the self-lockout
   *  simulation against the caller's OWN capability set. */
  personIds: Id<"people">[];
  /** One of `personIds` for the audit log — the caller's FIRST roster row,
   *  or `undefined` for a superuser backstop edit with no roster row at all. */
  editorPersonId: Id<"people"> | undefined;
}

/**
 * Gate for every org-chart STRUCTURE mutation (and the audit-log read):
 * the caller must hold a seat whose def carries `org.editChart`, OR be a
 * superuser (backstop, mirrors `seats.assignSeat`'s super-admin gate).
 * Throws a `ConvexError` (recoverable client-side) otherwise.
 */
export async function requireChartEditor(
  ctx: QueryCtx | MutationCtx,
): Promise<ChartEditor> {
  await requireAccess(ctx);
  const userId = (await requireUserId(ctx)) as Id<"users">;
  const personIds = await callerPersonIds(ctx, userId);
  const editorPersonId = personIds[0];

  if (await isSuperuser(ctx)) {
    return { userId, personIds, editorPersonId };
  }

  const caps = await effectiveCapabilities(ctx, personIds);
  if (!caps.has("org.editChart")) {
    throw new ConvexError({
      code: "FORBIDDEN",
      message:
        "Only a seat holder with org-chart editing power can edit the org chart's structure.",
    });
  }
  return { userId, personIds, editorPersonId };
}

/**
 * SELF-LOCKOUT GUARD — the critical invariant. Simulates the in-flight edit
 * (via `overrides`) and rejects if the CALLER's own effective capability set
 * would SHRINK: if any capability they hold right now (most importantly
 * `org.editChart` itself) would no longer be reachable through ANY of their
 * seats after the edit. Deliberately capability-set-general, not
 * `org.editChart`-specific, per the owner-approved semantics — losing ANY
 * currently-held capability is blocked, not just the edit power itself.
 *
 * A no-op (never throws) for a caller who holds none of the seats an edit
 * touches — this must NEVER block an edit that only affects someone else's
 * powers, only the caller's own.
 */
export async function assertNoSelfLockout(
  ctx: MutationCtx,
  editor: ChartEditor,
  overrides: Map<Id<"seatDefs">, DefOverride>,
): Promise<void> {
  if (editor.personIds.length === 0) return; // no seats held → nothing to lose
  const before = await effectiveCapabilities(ctx, editor.personIds);
  const after = await effectiveCapabilities(ctx, editor.personIds, overrides);
  for (const cap of before) {
    if (!after.has(cap)) {
      throw new ConvexError({
        code: "SELF_LOCKOUT",
        message: `This change would remove your own "${cap}" power — a Board seat above the ED will unlock this later. Ask another org-chart editor to make this change instead.`,
      });
    }
  }
}
