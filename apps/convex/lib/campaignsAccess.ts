/**
 * Access gate for the email-campaigns surface (`audiences.ts`, `campaigns.ts`).
 *
 * DESK VISIBILITY (`hasCampaignsAccess`/`requireCampaignsAccess`) — superuser,
 * OR a central Executive Director / Financial Manager
 * (`lib/finance.ts#isCentralEdOrFm`, the legacy title-based path, kept for
 * backward compat), OR a person holding a CENTRAL seat carrying
 * `campaigns.compose` or `campaigns.approve` (today: `executive_director`,
 * `financial_manager`, `marketing_director` — see `SEAT_DEFS`). Widened from
 * "ED/FM only" by the founder's two-party campaign-approval requirement
 * (2026-07-24), which named the Marketing Director as a valid approver
 * alongside the ED/FM — that only works if a Marketing Director's seat can
 * open the desk in the first place.
 *
 * APPROVAL POWER (`hasCampaignApprovalPower`/`requireCampaignApprovalPower`)
 * is DELIBERATELY seat-capability-only (no legacy-title fallback) — unlike
 * desk visibility, this is a BRAND NEW power this PR introduces, so there's
 * no pre-existing title-based behavior to stay backward compatible with; it
 * exists purely so it can be granted/revoked per-seat at runtime
 * (`seats.ts#setSeatCampaignPower`), exactly like the giving desk's
 * view/manage power (`lib/givingAccess.ts`'s doc).
 *
 * The caller's people rows are resolved the SAME union-across-every-
 * non-placeholder-`people`-row-for-the-userId way `lib/givingAccess.ts`
 * (:54-99) does, rather than `lib/finance.ts#resolveCallerPersonId`'s
 * single-chapter lookup — campaigns is CENTRAL-only and has no
 * chapter/scope context of its own to anchor a single roster row against.
 */
import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { isCentralEdOrFm } from "./finance";
import { isSuperuser } from "./superuser";
import { requireUserId } from "./context";

/** Bound on how many seat assignments a single person can hold — mirrors
 *  `lib/seats.ts#PERSON_SEAT_ASSIGNMENT_LIMIT` / `holdsApprovalSeatAt`. */
const PERSON_SEAT_ASSIGNMENT_LIMIT = 200;

type CampaignCapability = "campaigns.compose" | "campaigns.approve";

/**
 * True iff `personId` holds ANY seat AT `scope` whose def carries `cap` (or,
 * for `"campaigns.compose"`, `"campaigns.approve"` — approve implies
 * compose). Models `lib/seats.ts#holdsApprovalSeatAt`'s shape (indexed
 * `by_person` scan, skip `derived` seats — computed/rolled-up seats are
 * never real occupancy) for the two campaign capabilities, which live
 * outside that file's finance-only ladder.
 */
export async function holdsCampaignCapabilityAt(
  ctx: QueryCtx,
  personId: Id<"people">,
  scope: Id<"chapters"> | "central",
  cap: CampaignCapability,
): Promise<boolean> {
  const assignments = await ctx.db
    .query("seatAssignments")
    .withIndex("by_person", (q) => q.eq("personId", personId))
    .take(PERSON_SEAT_ASSIGNMENT_LIMIT);

  for (const assignment of assignments) {
    if (assignment.scope !== scope) continue;
    const def = await ctx.db.get(assignment.seatDefId);
    if (def?.derived) continue; // computed/rolled-up seats are never real occupancy
    if (def?.capabilities.includes(cap)) return true;
    if (cap === "campaigns.compose" && def?.capabilities.includes("campaigns.approve")) {
      return true; // approve implies compose
    }
  }
  return false;
}

/** True iff the caller holds `cap` at CENTRAL scope, unioned across every
 *  non-placeholder `people` row their userId owns (`lib/givingAccess.ts`'s
 *  resolution pattern). Campaigns is central-only, so `"central"` is the
 *  only scope this ever needs to consult. Signed-out is a quiet `false`, not
 *  a throw — mirrors `resolveGivingAccess`. */
async function holdsCentralCampaignCapability(
  ctx: QueryCtx,
  cap: CampaignCapability,
): Promise<boolean> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return false;
  const userId = (await requireUserId(ctx)) as Id<"users">;
  const people = await ctx.db
    .query("people")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();

  for (const person of people) {
    if (person.isPlaceholder === true) continue;
    if (await holdsCampaignCapabilityAt(ctx, person._id, "central", cap)) return true;
  }
  return false;
}

export async function hasCampaignsAccess(ctx: QueryCtx): Promise<boolean> {
  if (await isSuperuser(ctx)) return true;
  if (await isCentralEdOrFm(ctx)) return true;
  return (
    (await holdsCentralCampaignCapability(ctx, "campaigns.compose")) ||
    (await holdsCentralCampaignCapability(ctx, "campaigns.approve"))
  );
}

/** The throwing gate for every campaigns/audiences read+write. Use
 *  `hasCampaignsAccess` directly (soft, non-throwing) for a passive
 *  visibility check like `myCampaignsAccess`. */
export async function requireCampaignsAccess(ctx: QueryCtx): Promise<void> {
  if (!(await hasCampaignsAccess(ctx))) {
    throw new ConvexError({
      code: "FORBIDDEN",
      message:
        "Email campaigns are available to the Executive Director / Financial Manager, or a seat granted campaign compose or approve power.",
    });
  }
}

/** True iff the caller holds CENTRAL `campaigns.approve` power — superuser
 *  included (the bootstrap path mirrored across the repo). Distinct from
 *  `hasCampaignsAccess`: a compose-only holder may open the desk, draft, and
 *  submit, but can never be picked as (or act as) a campaign's reviewer. */
export async function hasCampaignApprovalPower(ctx: QueryCtx): Promise<boolean> {
  if (await isSuperuser(ctx)) return true;
  return holdsCentralCampaignCapability(ctx, "campaigns.approve");
}

/** Assert `hasCampaignApprovalPower`, else throw. Used for surfaces gated on
 *  approval power IN GENERAL (e.g. `listPendingApprovals`, `listCampaignApprovers`'s
 *  underlying access) — the per-campaign "are YOU the chosen reviewer" check
 *  is separate (`campaigns.ts`'s `assertCallerIsChosenReviewer`), since
 *  holding approval power somewhere doesn't mean a particular campaign
 *  picked you. */
export async function requireCampaignApprovalPower(ctx: QueryCtx): Promise<void> {
  if (!(await hasCampaignApprovalPower(ctx))) {
    throw new ConvexError({
      code: "FORBIDDEN",
      message: "Approving campaigns requires campaign-approval power.",
    });
  }
}

/**
 * Resolve the personId to stamp as ACTOR on a campaign write (the submitter)
 * — campaigns has no chapter/scope context of its own
 * (`lib/finance.ts#resolveCallerPersonId` needs a `chapterId`; this doesn't),
 * so this walks every non-placeholder `people` row the caller's userId owns
 * and picks the first one that itself carries a central campaign capability
 * (compose or approve) — falling back to the first non-placeholder row (the
 * "access came from `isCentralEdOrFm`'s legacy title, not a seat on this
 * particular roster row" case, and the superuser bootstrap case) so a
 * caller who cleared `requireCampaignsAccess` is never blocked from acting
 * for lack of a roster row that happens to carry the capability itself.
 * Throws `NO_PERSON` only when the caller has no roster profile at all.
 */
export async function resolveCampaignCallerPersonId(
  ctx: QueryCtx,
): Promise<Id<"people">> {
  const userId = (await requireUserId(ctx)) as Id<"users">;
  const people = await ctx.db
    .query("people")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  const real = people.filter((p) => p.isPlaceholder !== true);

  for (const person of real) {
    if (
      (await holdsCampaignCapabilityAt(ctx, person._id, "central", "campaigns.compose")) ||
      (await holdsCampaignCapabilityAt(ctx, person._id, "central", "campaigns.approve"))
    ) {
      return person._id;
    }
  }
  if (real.length > 0) return real[0]._id;
  throw new ConvexError({
    code: "NO_PERSON",
    message: "You don't have a roster profile yet.",
  });
}
