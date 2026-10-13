/**
 * Who may EDIT the Academy's courses in the app — the gate on every save and
 * publish in `academyEditor.ts`.
 *
 * Gate: superuser OR a held seat granting `people.academy.edit` ("Edit Academy
 * courses"). Seeded on the Executive Director, the Expansion Director and the
 * Training Associate; anyone holding the org chart power can hand it to any
 * other seat from that seat's Powers tab.
 *
 * Any scope counts, like `seatAssignAccess.ts`: there is one Academy, so a
 * chapter seat granted the power edits the org's courses, which are the only
 * courses there are (the brand kit's reasoning, `marketing.designs.edit`).
 *
 * READING the Academy is not gated here — every approved member reads it.
 */
import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { requireAccess, requireUserId } from "./context";
import { isSuperuser } from "./superuser";
import { callerPersonIds, effectiveCapabilities } from "./seatStructure";

/** Non-throwing: may the caller edit Academy courses? `false` for a
 *  signed-out or unapproved caller, so a screen can decide what to show. */
export async function hasAcademyEditPower(
  ctx: QueryCtx | MutationCtx,
): Promise<boolean> {
  try {
    await requireAccess(ctx);
  } catch {
    return false;
  }
  if (await isSuperuser(ctx)) return true;
  const userId = (await requireUserId(ctx)) as Id<"users">;
  const caps = await effectiveCapabilities(ctx, await callerPersonIds(ctx, userId));
  return caps.has("people.academy.edit");
}

/** Throwing form, for every editor query and mutation. */
export async function requireAcademyEditPower(
  ctx: QueryCtx | MutationCtx,
): Promise<void> {
  await requireAccess(ctx);
  if (!(await hasAcademyEditPower(ctx))) {
    throw new ConvexError({
      code: "FORBIDDEN",
      message:
        "Only someone with the Edit Academy courses power can change a course. Ask whoever runs the org chart to grant it to your seat.",
    });
  }
}
