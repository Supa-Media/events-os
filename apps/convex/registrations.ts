/**
 * Registrations — paid places on a project (a class, cohort or course with a
 * fee). See `schema/registrations.ts` for the model and for why these can't be
 * `ticketOrders` rows.
 *
 * READ ONLY, on purpose. The owner, 2026-08-10: "there would need to be a
 * course registration page where we can collect payments… I don't want people
 * to manually record payments, I want it all to flow through the system." So
 * there is no `create`, no `refund`, and no "+ Add" affordance anywhere in the
 * UI. The only writer today is the one-time Givebutter backfill
 * (`backfillWorshipRegistrations.ts`); the next one will be the checkout
 * webhook, writing the Stripe columns the schema already carries.
 */
import { v } from "convex/values";
import { query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { summarizeRegistrations } from "@events-os/shared";
import { hasRegistrationView } from "./lib/registrationsAccess";

/** A project's registrations are a cohort, not a mailing list — a class that
 *  outgrows this is a paginated screen, not a bigger take(). */
const PROJECT_REGISTRATION_LIMIT = 500;

/**
 * Every registration on one project, plus the money summary the project page
 * shows above them.
 *
 * Returns the EMPTY shape (not a throw) for a project that doesn't exist or a
 * caller without reach — same reasoning as `moneyViews.ts#resolveRefAuthz`:
 * distinguishing the two would let anyone probe project ids.
 */
export const forProject = query({
  args: { projectId: v.string() },
  returns: v.object({
    /** Σ `amountCents` of the `paid` rows — the only slice that is revenue. */
    collectedCents: v.number(),
    paidCount: v.number(),
    refundedCount: v.number(),
    compedCount: v.number(),
    rows: v.array(
      v.object({
        id: v.id("registrations"),
        name: v.string(),
        personId: v.union(v.id("people"), v.null()),
        registeredAt: v.number(),
        amountCents: v.number(),
        status: v.union(
          v.literal("paid"),
          v.literal("refunded"),
          v.literal("comped"),
        ),
        refundReason: v.union(v.string(), v.null()),
      }),
    ),
  }),
  handler: async (ctx, { projectId }) => {
    const empty = {
      collectedCents: 0,
      paidCount: 0,
      refundedCount: 0,
      compedCount: 0,
      rows: [] as never[],
    };

    const id = ctx.db.normalizeId("projects", projectId);
    const project = id ? await ctx.db.get(id) : null;
    if (!project) return empty;
    if (!(await hasRegistrationView(ctx, project.chapterId))) return empty;

    const rows = await ctx.db
      .query("registrations")
      .withIndex("by_project", (q) => q.eq("projectId", project._id))
      .take(PROJECT_REGISTRATION_LIMIT);
    if (rows.length === PROJECT_REGISTRATION_LIMIT) {
      console.warn(
        `[registrations] forProject hit PROJECT_REGISTRATION_LIMIT (${PROJECT_REGISTRATION_LIMIT}) for project ${project._id}; the list is truncated.`,
      );
    }

    const summary = summarizeRegistrations(rows);
    return {
      ...summary,
      // Newest first — the same direction every other money list on this page
      // reads, so the eye doesn't have to change gear between sections.
      rows: [...rows]
        .sort((a, b) => b.registeredAt - a.registeredAt)
        .map((r) => ({
          id: r._id,
          name: r.name,
          personId: (r.personId ?? null) as Id<"people"> | null,
          registeredAt: r.registeredAt,
          amountCents: r.amountCents,
          status: r.status,
          refundReason: r.refundReason ?? null,
        })),
    };
  },
});
