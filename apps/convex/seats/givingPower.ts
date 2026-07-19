// ── Giving power editor (owner decision 2026-07-19) ─────────────────────────
//
// The giving desk is an assignable per-role POWER: the ED (or a superuser)
// tunes which seats can see/manage the donor CRM straight from the org chart,
// at runtime, with no code deploy. Enforcement is UNCHANGED — giving access is
// already seat-capability-derived (`lib/givingAccess.ts` off
// `lib/seats.ts#getSeatDerivedGivingCapabilities` → a seat def's `capabilities`
// array), so patching that array here takes effect immediately with zero
// enforcement changes.
//
// This is the giving-scoped, safe sibling of `seatStructure.updateSeat` (which
// edits ANY capability wholesale, in structure-edit mode): it touches ONLY the
// three giving capabilities and never the finance/org powers on the same seat,
// so a single-tap "None / View / Manage" control can't accidentally strip an
// unrelated power. It reuses the SAME gate (`requireChartEditor`: superuser OR
// a held `org.editChart` seat) and the SAME self-lockout guard
// (`assertNoSelfLockout`) `updateSeat` uses.
import { mutation } from "../_generated/server";
import { ConvexError, v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { SeatCapability } from "@events-os/shared";
import {
  requireChartEditor,
  assertNoSelfLockout,
  type DefOverride,
} from "../lib/seatStructure";
import { seatCapabilityValidator } from "./validators";

/** The three giving capabilities this editor owns — the ONLY caps it ever
 *  touches. Every other capability on the seat is preserved verbatim. */
const GIVING_CAPS: readonly SeatCapability[] = [
  "giving.view",
  "giving.manage",
  "nav.giving",
];

const givingPowerValidator = v.union(
  v.literal("none"),
  v.literal("view"),
  v.literal("manage"),
);

/** The giving capabilities a given power level grants. `view` → read the CRM +
 *  surface the desk; `manage` → additionally write it; `none` → strip all
 *  three. `giving.manage` always implies `giving.view` (a manager can see what
 *  they manage — mirrors `getSeatDerivedGivingCapabilities`). */
function givingCapsForPower(power: "none" | "view" | "manage"): SeatCapability[] {
  if (power === "manage") return ["giving.manage", "giving.view", "nav.giving"];
  if (power === "view") return ["giving.view", "nav.giving"];
  return [];
}

/**
 * Set a seat's GIVING power to `none` / `view` / `manage`, rewriting ONLY the
 * three giving capabilities on the def and leaving every other capability
 * (finance, org.editChart, nav.finances, …) exactly as-is. Because `seatDefs`
 * rows are SHARED across every chapter (the chapter chart is defined once —
 * see `schema/seats.ts`), one edit applies to every chapter's occupancy of the
 * seat automatically, with nothing to fan out.
 *
 * Gate: `requireChartEditor` — superuser OR a caller holding a seat with
 * `org.editChart` (the ED today), the identical gate `seatStructure.ts`'s
 * structure mutations use. Also runs `assertNoSelfLockout` (mirrors
 * `updateSeat`): an editor can't strip a giving power OFF THEIR OWN seat and
 * silently lose it — another editor (or the same one, deliberately, on a seat
 * they don't hold) must make that change. Rejects a `derived` seat (its
 * holders — and so its powers' reach — are computed, never assigned).
 *
 * Returns the seat's FULL updated capabilities array (not just the giving
 * subset), so the caller can reflect the whole power set without a re-read.
 */
export const setSeatGivingPower = mutation({
  args: {
    seatDefId: v.id("seatDefs"),
    power: givingPowerValidator,
  },
  returns: v.array(seatCapabilityValidator),
  handler: async (ctx, { seatDefId, power }) => {
    const editor = await requireChartEditor(ctx);

    const def = await ctx.db.get(seatDefId);
    if (!def) {
      throw new ConvexError({ code: "NOT_FOUND", message: "That seat doesn't exist." });
    }
    if (def.derived === true) {
      throw new ConvexError({
        code: "DERIVED_SEAT",
        message:
          "This seat's holders are computed automatically — its powers can't be edited.",
      });
    }

    // Strip every giving cap, then re-add exactly the ones the target power
    // grants — so only the giving trio ever changes; all other caps (in their
    // original order) are preserved verbatim.
    const preserved = def.capabilities.filter((c) => !GIVING_CAPS.includes(c));
    const next: SeatCapability[] = [...preserved, ...givingCapsForPower(power)];

    // Same self-lockout simulation `updateSeat` runs for a capabilities change:
    // rejects an edit that would remove one of the CALLER's OWN currently-held
    // capabilities (a no-op for an edit to a seat they don't hold).
    const overrides = new Map<Id<"seatDefs">, DefOverride>([
      [def._id, { ...def, capabilities: next }],
    ]);
    await assertNoSelfLockout(ctx, editor, overrides);

    await ctx.db.patch(def._id, { capabilities: next, updatedAt: Date.now() });
    return next;
  },
});
