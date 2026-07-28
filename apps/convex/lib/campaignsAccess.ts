/**
 * Access gate for the email-campaigns surface (`audiences.ts`, `campaigns.ts`)
 * — and, at the bottom of this file, for the one other BULK-MAIL send in the
 * app, the event blast (`blasts.ts#sendBlast`).
 *
 * ── The ladder ─────────────────────────────────────────────────────────────
 * Three NESTED capabilities, weakest first (see `SEAT_CAPABILITIES`'s doc in
 * `@events-os/shared` for the full prose):
 *
 *   `campaigns.design`  — own the shared design system: themes, saved
 *                         templates, the reusable image library.
 *   `campaigns.compose` — implies design; draft/submit/send a campaign.
 *   `campaigns.approve` — implies compose; be a campaign's reviewer.
 *
 * DESK VISIBILITY (`hasCampaignsAccess`/`requireCampaignsAccess`) — superuser,
 * OR a central Executive Director / Financial Manager
 * (`lib/finance.ts#isCentralEdOrFm`, the legacy title-based path, kept for
 * backward compat), OR a person holding a CENTRAL seat carrying ANY rung of
 * the ladder (today: `executive_director`, `financial_manager`,
 * `marketing_director` at approve; `graphic_designer`, `social_media_manager`
 * at design — see `SEAT_DEFS`). Widened from "ED/FM only" by the founder's
 * two-party campaign-approval requirement (2026-07-24), which named the
 * Marketing Director as a valid approver alongside the ED/FM — that only
 * works if a Marketing Director's seat can open the desk in the first place —
 * and widened again (2026-07-28) to the design rung, because the person who
 * actually builds the newsletter is the Graphic Designer and gating the desk
 * on compose-or-above locked them out of their own tools.
 *
 * THE THREE POWERS (`has/requireCampaignDesign`, `has/requireCampaignCompose`,
 * `has/requireCampaignApprovalPower`) are DELIBERATELY seat-capability-only
 * (superuser bootstrap aside — no legacy-title fallback), unlike desk
 * visibility. Two reasons, and they apply to all three identically:
 *
 *   1. They exist so they can be granted/revoked per-seat at runtime
 *      (`seats.ts#setSeatCampaignPower`), exactly like the giving desk's
 *      view/manage power (`lib/givingAccess.ts`'s doc). A power that a
 *      legacy `specializedRoles` title can satisfy isn't revocable from the
 *      org chart, which defeats the point.
 *   2. Gating the shared design system on plain `requireCampaignsAccess`
 *      made the write gate WEAKER than `campaigns.compose` — the legacy
 *      ED/FM title path satisfies desk visibility while holding no
 *      capability at all, so anyone who could open the desk could archive
 *      the shared built-in newsletter template or hard-delete an image
 *      library blob. Those writes now sit behind `requireCampaignDesign`.
 *
 * Consequence worth stating plainly, because it is BROAD: a central ED/FM
 * identified ONLY by a legacy `specializedRoles` title, with no seat
 * assignment, can still open and READ the desk — and can do NOTHING ELSE
 * there. Every write on the surface now sits behind one of the three powers,
 * none of which the title satisfies. That is not just the design system:
 * `createCampaign`, `updateCampaignMeta`, `updateCampaignDoc`,
 * `setCampaignTheme`, `submitForApproval`, `cancelApprovalRequest`,
 * `revertToDraft`, `send`, `sendTest` (via `assertAccessForAction`) and
 * `markReplyRead` in `campaigns.ts`, plus
 * `campaignTemplates.createCampaignFromTemplate` and
 * `emailSuppressions.suppressEmail`/`unsuppressEmail`, all require
 * `campaigns.compose`; themes, saved templates and the image library require
 * `campaigns.design`; approving requires `campaigns.approve`. A title-only
 * ED/FM is therefore a READ-ONLY desk visitor. The fix is to take the ED/FM
 * seat — whose template carries all three rungs — not to widen the power.
 *
 * The caller's people rows are resolved the SAME union-across-every-
 * non-placeholder-`people`-row-for-the-userId way `lib/givingAccess.ts`
 * (:54-99) does, rather than `lib/finance.ts#resolveCallerPersonId`'s
 * single-chapter lookup — campaigns is CENTRAL-only and has no
 * chapter/scope context of its own to anchor a single roster row against.
 */
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { isCentralEdOrFm } from "./finance";
import { isSuperuser } from "./superuser";
import { requireEvent, requireUserId } from "./context";

/** Bound on how many seat assignments a single person can hold — mirrors
 *  `lib/seats.ts#PERSON_SEAT_ASSIGNMENT_LIMIT` / `holdsApprovalSeatAt`. */
const PERSON_SEAT_ASSIGNMENT_LIMIT = 200;

type CampaignCapability =
  | "campaigns.design"
  | "campaigns.compose"
  | "campaigns.approve";

/**
 * Which capabilities SATISFY a requested rung — the ladder's implications,
 * written once so no call site has to remember them. `campaigns.approve`
 * implies `campaigns.compose`, which in turn implies `campaigns.design`.
 *
 * The seat TEMPLATES list every implied rung explicitly (see `SEAT_DEFS`), so
 * for a freshly-seeded org this map is redundant — it's what keeps a row
 * written by an older migration, or by a hand edit that only added
 * `campaigns.approve`, resolving correctly.
 */
const CAMPAIGN_CAPABILITY_SATISFIERS: Record<
  CampaignCapability,
  readonly CampaignCapability[]
> = {
  "campaigns.approve": ["campaigns.approve"],
  "campaigns.compose": ["campaigns.compose", "campaigns.approve"],
  "campaigns.design": ["campaigns.design", "campaigns.compose", "campaigns.approve"],
};

/**
 * True iff `personId` holds ANY seat AT `scope` whose def carries `cap` or
 * anything that implies it (`CAMPAIGN_CAPABILITY_SATISFIERS`). Models
 * `lib/seats.ts#holdsApprovalSeatAt`'s shape (indexed `by_person` scan, skip
 * `derived` seats — computed/rolled-up seats are never real occupancy) for
 * the campaign ladder, which lives outside that file's finance-only one.
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

  const satisfiers = CAMPAIGN_CAPABILITY_SATISFIERS[cap];
  for (const assignment of assignments) {
    if (assignment.scope !== scope) continue;
    const def = await ctx.db.get(assignment.seatDefId);
    if (!def) continue;
    if (def.derived) continue; // computed/rolled-up seats are never real occupancy
    if (satisfiers.some((c) => def.capabilities.includes(c))) return true;
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
  // ONE check, not three: `campaigns.design` is the ladder's bottom rung and
  // compose/approve both imply it (`CAMPAIGN_CAPABILITY_SATISFIERS`), so
  // "holds design-or-above" is exactly "holds any campaign capability".
  return holdsCentralCampaignCapability(ctx, "campaigns.design");
}

/** The throwing gate for every campaigns/audiences READ, and for desk
 *  visibility generally. Use `hasCampaignsAccess` directly (soft,
 *  non-throwing) for a passive visibility check like `myCampaignsAccess`.
 *
 *  NOT the right gate for a WRITE to the shared design system (themes,
 *  templates, the image library) — that's `requireCampaignDesign`, which is
 *  strictly stronger; see the module doc. */
export async function requireCampaignsAccess(ctx: QueryCtx): Promise<void> {
  if (!(await hasCampaignsAccess(ctx))) {
    throw new ConvexError({
      code: "FORBIDDEN",
      message:
        "Email campaigns are available to the Executive Director / Financial Manager, or a seat granted campaign design, compose, or approve power.",
    });
  }
}

/** True iff the caller holds CENTRAL `campaigns.design` power — or anything
 *  that implies it (compose, approve) — superuser included (the bootstrap
 *  path mirrored across the repo). Distinct from `hasCampaignsAccess`: the
 *  legacy central-ED/FM TITLE path opens the desk but does NOT carry this
 *  power (module doc, reason 2). */
export async function hasCampaignDesign(ctx: QueryCtx): Promise<boolean> {
  if (await isSuperuser(ctx)) return true;
  return holdsCentralCampaignCapability(ctx, "campaigns.design");
}

/** Assert `hasCampaignDesign`, else throw. The gate on every write to the
 *  SHARED design system — `emailThemes.ts`'s mutations,
 *  `campaignTemplates.ts`'s create/update/archive, and `emailImages.ts`'s
 *  add/update/delete. Every one of those edits something the whole desk
 *  shares (an archived built-in template, a hard-deleted image blob), which
 *  is why it's a named power rather than a side effect of being able to see
 *  the desk. Reads of those same surfaces stay on `requireCampaignsAccess` —
 *  a composer with no design power still has to be able to PICK a theme. */
export async function requireCampaignDesign(ctx: QueryCtx): Promise<void> {
  if (!(await hasCampaignDesign(ctx))) {
    throw new ConvexError({
      code: "FORBIDDEN",
      message:
        "Editing campaign templates, themes, and the image library requires campaign design power.",
    });
  }
}

/** True iff the caller holds CENTRAL `campaigns.compose` power — or
 *  `campaigns.approve`, which implies it — superuser included. A
 *  design-only holder (the Graphic Designer / Social Media Manager) is
 *  FALSE here: they own the design system, never a send. */
export async function hasCampaignCompose(ctx: QueryCtx): Promise<boolean> {
  if (await isSuperuser(ctx)) return true;
  return holdsCentralCampaignCapability(ctx, "campaigns.compose");
}

/** Assert `hasCampaignCompose`, else throw. The gate on anything that brings
 *  a CAMPAIGN into existence or moves it along — notably
 *  `campaignTemplates.createCampaignFromTemplate`, which despite living in
 *  the templates module creates a draft campaign and so is a compose action,
 *  not a design one. */
export async function requireCampaignCompose(ctx: QueryCtx): Promise<void> {
  if (!(await hasCampaignCompose(ctx))) {
    throw new ConvexError({
      code: "FORBIDDEN",
      message: "Creating or editing a campaign requires campaign compose power.",
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

/** Assert `hasCampaignApprovalPower`, else throw. For a HARD gate on
 *  approval power IN GENERAL, where throwing is actually appropriate (an
 *  explicit user action, not a passively-rendered list) — `listPendingApprovals`
 *  (`campaigns.ts`) deliberately does NOT use this (it soft-gates via
 *  `hasCampaignApprovalPower` directly instead, returning `[]`, since it
 *  backs a strip a screen calls unconditionally and must never crash a
 *  caller who simply lacks the power — see that query's own doc, 2026-07-24).
 *  The per-campaign "are YOU the chosen reviewer" check is separate
 *  (`campaigns.ts`'s `assertCallerIsChosenReviewer`), since holding approval
 *  power somewhere doesn't mean a particular campaign picked you. */
export async function requireCampaignApprovalPower(ctx: QueryCtx): Promise<void> {
  if (!(await hasCampaignApprovalPower(ctx))) {
    throw new ConvexError({
      code: "FORBIDDEN",
      message: "Approving campaigns requires campaign-approval power.",
    });
  }
}

// ── Event blasts (`blasts.ts`) ──────────────────────────────────────────────
//
// An EMAIL BLAST is bulk mail by every test that matters — organiser-composed
// promotional copy to a whole event audience — and `blasts.ts`'s module doc
// says so itself, which is why a blast carries the same unsubscribe tokens,
// RFC 8058 headers and postal address a campaign does. Its authorization,
// though, was an INLINE `requireEvent` at the mutation: "any admin of this
// event's chapter", written nowhere and named nothing. That is exactly the
// shape CLAUDE.md's "gate it behind a power, even when it's open today"
// section exists to prevent — when the day comes that a blast needs compose
// power, or its own two-party sign-off, the change should be this file's body,
// not a hunt through call sites.
//
// TODAY'S ANSWER IS DELIBERATELY UNCHANGED: event admins keep the power. This
// is a seam, not a restriction — organisers are not being locked out of their
// own announcements.
//
// GRADUATING THIS (the `lib/formsAccess.ts` three-step, no call-site churn):
//   1. Add `"campaigns.blast"` to `SEAT_CAPABILITIES` (`packages/shared/src/seats.ts`).
//   2. List it on whichever `SEAT_DEFS` entries should carry it.
//   3. Change ONLY the body below. Do NOT add the capability string until that
//      decision is actually made.

/**
 * The gate on FIRING a blast at an event's audience (`blasts.ts#sendBlast`).
 * Returns the event, so the call site needs no second lookup.
 *
 * TODAY: bare event access — any admin of the event's own chapter
 * (`lib/context.ts#requireEvent`'s membership check), which is precisely what
 * `sendBlast` asserted inline before. `requireEvent`'s own errors pass through
 * unchanged (a `NOT_FOUND` for an event outside the caller's chapter stays a
 * `NOT_FOUND`). Graduates to `"campaigns.blast"` — see the section note above.
 */
export async function requireBlastSend(
  ctx: QueryCtx,
  eventId: Id<"events">,
): Promise<Doc<"events">> {
  return await requireEvent(ctx, eventId);
}

/** Soft, non-throwing form of `requireBlastSend` — for a passively-rendered
 *  composer affordance, the way `hasCampaignsAccess` backs `myCampaignsAccess`.
 *  DERIVED from the throwing form on purpose: there is exactly one body to
 *  change when this graduates. */
export async function hasBlastSend(
  ctx: QueryCtx,
  eventId: Id<"events">,
): Promise<boolean> {
  try {
    await requireBlastSend(ctx, eventId);
    return true;
  } catch {
    return false;
  }
}

/** Every non-placeholder `people` row the caller's userId owns. Factored out
 *  so `resolveCampaignCallerPersonId` and `resolveCampaignCallerPersonIds`
 *  (below) — and anything else that needs "every roster row this human
 *  controls" — never duplicate the query. */
async function ownPeopleRows(ctx: QueryCtx): Promise<Doc<"people">[]> {
  const userId = (await requireUserId(ctx)) as Id<"users">;
  const people = await ctx.db
    .query("people")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  return people.filter((p) => p.isPlaceholder !== true);
}

/**
 * Every non-placeholder `people` row id the caller's userId owns, as a Set —
 * the SAME roster a person can hold MULTIPLE rows under (schema has no
 * uniqueness on `people.userId`), so this is "every identity this one human
 * could act as," not just one. Callers use this to exclude/reject "yourself"
 * as a distinct entity: `listCampaignApprovers` (the reviewer-picker dropdown)
 * excludes every id in this set from the candidate list, and
 * `submitForApproval`/`assertCallerIsChosenReviewer` (`campaigns.ts`) reject a
 * `reviewerPersonId` that's in this set OUTRIGHT — a single human holding two
 * `campaigns.approve` rows can't launder self-approval through the SECOND row
 * (a same-personId-only SOD check would miss that; see the SOD_VIOLATION
 * fix, 2026-07-24).
 */
export async function resolveCampaignCallerPersonIds(
  ctx: QueryCtx,
): Promise<Set<Id<"people">>> {
  const rows = await ownPeopleRows(ctx);
  return new Set(rows.map((p) => p._id));
}

/**
 * Resolve the personId to stamp as ACTOR on a campaign write (the submitter)
 * — campaigns has no chapter/scope context of its own
 * (`lib/finance.ts#resolveCallerPersonId` needs a `chapterId`; this doesn't),
 * so this walks every non-placeholder `people` row the caller's userId owns
 * and picks the first one that itself can COMPOSE at central (compose, or
 * approve which implies it) — deliberately NOT the weaker `campaigns.design`
 * rung, because the row this returns is stamped as the campaign's actor, and
 * a design-only roster row has no business being recorded as a campaign's
 * submitter — falling back to the first non-placeholder row (the
 * "access came from `isCentralEdOrFm`'s legacy title, not a seat on this
 * particular roster row" case, and the superuser bootstrap case) so a
 * caller who cleared `requireCampaignsAccess` is never blocked from acting
 * for lack of a roster row that happens to carry the capability itself.
 * Throws `NO_PERSON` only when the caller has no roster profile at all.
 */
export async function resolveCampaignCallerPersonId(
  ctx: QueryCtx,
): Promise<Id<"people">> {
  const real = await ownPeopleRows(ctx);

  for (const person of real) {
    if (await holdsCampaignCapabilityAt(ctx, person._id, "central", "campaigns.compose")) {
      return person._id;
    }
  }
  if (real.length > 0) return real[0]._id;
  throw new ConvexError({
    code: "NO_PERSON",
    message: "You don't have a roster profile yet.",
  });
}
