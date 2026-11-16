/**
 * HIRING authorization — the People desk's gate.
 *
 * The named resolver pair CLAUDE.md's "Gate It Behind a Power" section
 * requires: nothing in `hiring.ts` checks a seat, a title, or a chapter
 * inline. Three rungs, because the Academy's pipeline has three distinct
 * jobs and the org already separates them:
 *
 *   `hiring.view`     read the desk — applications, rubric cards, timelines.
 *   `hiring.edit`     RUN the funnel — move a candidate, file a review, start
 *                     an Empowerment Trial. What a People Associate does.
 *   `hiring.approve`  make the CALL — close a file with an outcome and send
 *                     the message. The Director's, and only the Director's:
 *                     "the Director has the final say — this process supports
 *                     their prayerful decision, it doesn't replace it."
 *
 * `hiring.approve` explicitly implies `hiring.edit` (see `powers.ts`), so a
 * Director isn't locked out of their own pipeline; the split exists to stop an
 * associate closing a file, not to stop a Director running one.
 *
 * CENTRAL, with one read-only exception. One funnel, one standard, for roles
 * central and chapter alike: running and deciding (`hiring.edit`,
 * `hiring.approve`) are central-scope only, and a chapter grant of either
 * reaches nothing. `hiring.view` held at a CHAPTER scope (since 2026-11-16 —
 * a Chapter Director sees who is applying to their city) reads that chapter's
 * slice of the APPLICATIONS only: files for roles in the chapter's city, plus
 * everyone open to other roles (`applicationInChapterReach` in shared). That
 * reach is `canViewApplications`; `canView` stays the whole desk — volunteer
 * signups, the listings manager, the application form — and is central-only.
 *
 * Every refusal throws `ConvexError({ code, message })` (never a plain
 * `Error`) so the app's AuthErrorBoundary can surface it, exactly like the
 * finance and giving gates.
 */
import { ConvexError } from "convex/values";
import {
  applicationInChapterReach,
  chapterListingRegion,
  expandPowers,
  listingRegions,
  type ListingRegion,
  type Power,
} from "@events-os/shared";
import { Doc, Id } from "../_generated/dataModel";
import { QueryCtx } from "../_generated/server";
import { isSuperuser } from "./superuser";
import { requireUserId } from "./context";
import { getSeatDerivedHiringCapabilities } from "./seats";

/** The caller's resolved reach on the Hiring desk. */
export interface HiringAccess {
  /** Superuser — the bootstrap path, mirrored across the repo. */
  isSuperuser: boolean;
  /** Read the WHOLE desk (central `hiring.view`). */
  canView: boolean;
  /** Read at least some applications: the whole desk, or a chapter's slice.
   *  Implied by `canView`. */
  canViewApplications: boolean;
  /** One entry per chapter whose slice the caller reads (chapter-scoped
   *  `hiring.view`): the region that chapter recruits for, or `null` when it
   *  names none (it then sees only the open-to-other-roles pool). Empty for a
   *  whole-desk reader, whose reach needs no slicing. */
  chapterRegions: Array<ListingRegion | null>;
  /** Run the pipeline (implies `canView`). */
  canManage: boolean;
  /** Close a file (implies `canManage`). */
  canDecide: boolean;
}

const NONE: HiringAccess = {
  isSuperuser: false,
  canView: false,
  canViewApplications: false,
  chapterRegions: [],
  canManage: false,
  canDecide: false,
};

/**
 * Resolve the caller's hiring reach across every non-placeholder `people` row
 * their `userId` owns — the same whole-user walk `resolveGivingAccess` does,
 * so a seat held on a non-home roster row still counts. Central-scope grants
 * only; a chapter-scope hiring seat contributes nothing (see the module doc).
 * Pure read.
 */
export async function resolveHiringAccess(ctx: QueryCtx): Promise<HiringAccess> {
  if (await isSuperuser(ctx)) {
    return {
      isSuperuser: true,
      canView: true,
      canViewApplications: true,
      chapterRegions: [],
      canManage: true,
      canDecide: true,
    };
  }

  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return { ...NONE }; // signed out — no reach (quiet, not a throw)

  const userId = (await requireUserId(ctx)) as Id<"users">;
  const people = await ctx.db
    .query("people")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();

  const access: HiringAccess = { ...NONE, chapterRegions: [] };
  const chapterIds = new Set<Id<"chapters">>();
  for (const person of people) {
    if (person.isPlaceholder === true) continue;
    const caps = await getSeatDerivedHiringCapabilities(ctx, person._id);
    if (caps.view) access.canView = true;
    if (caps.manage) access.canManage = true;
    if (caps.decide) access.canDecide = true;
    for (const id of caps.viewChapterIds) chapterIds.add(id);
  }
  if (access.canView) {
    access.canViewApplications = true; // the whole desk; no slice needed
  } else {
    for (const id of chapterIds) {
      const chapter = await ctx.db.get(id);
      if (!chapter) continue; // a grant on a deleted chapter reaches nothing
      access.chapterRegions.push(chapterListingRegion(chapter));
      access.canViewApplications = true;
    }
  }
  return access;
}

/** Assert the caller may READ the Hiring desk, else throw. */
export async function requireHiringView(ctx: QueryCtx): Promise<HiringAccess> {
  const access = await resolveHiringAccess(ctx);
  if (!access.canView) {
    throw new ConvexError({
      code: "FORBIDDEN",
      message: "You don't have access to the hiring desk.",
    });
  }
  return access;
}

/** What a caller who may read applications can see: everything, or a
 *  chapter's slice. `sees` is the one filter every application read applies. */
export interface ApplicationsReach {
  access: HiringAccess;
  /** `false` for a chapter-slice reader — the UI says what it is showing. */
  wholeDesk: boolean;
  sees: (row: Doc<"jobApplications">) => boolean;
}

/** Bound on the listings read to place a role in a city. The org posts a few
 *  dozen roles; this is far above that. */
const LISTING_SCAN_LIMIT = 500;

/**
 * Assert the caller may read APPLICATIONS — the whole desk, or a chapter's
 * slice of it (chapter-scoped `hiring.view`) — and return the filter that
 * draws the slice. Every application read (the list, the counts, one file)
 * goes through this rather than `requireHiringView`, which stays the gate for
 * the rest of the desk.
 */
export async function requireApplicationsView(
  ctx: QueryCtx,
): Promise<ApplicationsReach> {
  const access = await resolveHiringAccess(ctx);
  if (!access.canViewApplications) {
    throw new ConvexError({
      code: "FORBIDDEN",
      message: "You don't have access to the hiring desk.",
    });
  }
  if (access.canView) return { access, wholeDesk: true, sees: () => true };

  const listings = await ctx.db.query("jobListings").take(LISTING_SCAN_LIMIT);
  const regionsBySlug = new Map(
    listings.map((l) => [l.slug, listingRegions(l.location)] as const),
  );
  const regionsOfRole = (slug: string) => regionsBySlug.get(slug) ?? null;
  const regions = access.chapterRegions;
  return {
    access,
    wholeDesk: false,
    sees: (row) =>
      regions.some((region) =>
        applicationInChapterReach(row, region, regionsOfRole),
      ),
  };
}

/** Assert the caller may RUN the pipeline (move a file, file a review, start a
 *  trial), else throw. */
export async function requireHiringManage(ctx: QueryCtx): Promise<HiringAccess> {
  const access = await resolveHiringAccess(ctx);
  if (!access.canManage) {
    throw new ConvexError({
      code: "FORBIDDEN",
      message: "You don't have permission to run the hiring pipeline.",
    });
  }
  return access;
}

/**
 * Assert the caller may MANAGE the postings on `/team` — create, edit, open,
 * close, publish, or delete a job listing.
 *
 * Today this is exactly "run the hiring desk" (`hiring.edit`): the person who
 * works the pipeline is the person who owns what's posted, and splitting the
 * two would gate nothing anyone asked to have gated. It is its OWN named
 * resolver anyway, per CLAUDE.md — the day posting management wants its own
 * key (say, an associate who works candidates but can't change what's
 * advertised), this graduates to a `hiring.listings.edit` power on the seats
 * that should carry it and this body changes; no call site does.
 */
export async function requireListingManage(
  ctx: QueryCtx,
): Promise<HiringAccess> {
  const access = await resolveHiringAccess(ctx);
  if (!access.canManage) {
    throw new ConvexError({
      code: "FORBIDDEN",
      message: "You don't have permission to manage job listings.",
    });
  }
  return access;
}

/**
 * Assert the caller may EDIT the `/team/apply` form — its questions, their
 * wording, and which fields are optional.
 *
 * Today this is "run the hiring desk" (`hiring.edit`), same as the postings:
 * the people who read the answers are the people who decide what to ask. Its
 * own named resolver per CLAUDE.md, so if the questions ever want a narrower
 * owner it graduates to a `hiring.form.edit` power here and no call site
 * changes.
 */
export async function requireApplicationFormManage(
  ctx: QueryCtx,
): Promise<HiringAccess> {
  const access = await resolveHiringAccess(ctx);
  if (!access.canManage) {
    throw new ConvexError({
      code: "FORBIDDEN",
      message: "You don't have permission to edit the application form.",
    });
  }
  return access;
}

/**
 * Assert the caller may CLOSE a file — place, not-now, or decline someone.
 * Separate from `requireHiringManage` on purpose: this is the one hiring act
 * the org reserves to a director, and the reservation is worth a gate rather
 * than a convention.
 */
export async function requireHiringDecide(ctx: QueryCtx): Promise<HiringAccess> {
  const access = await resolveHiringAccess(ctx);
  if (!access.canDecide) {
    throw new ConvexError({
      code: "FORBIDDEN",
      message:
        "Only a director can make the call on a candidate. Ask the People Director or the ED.",
    });
  }
  return access;
}

// ── Who to tell ──────────────────────────────────────────────────────────────

/** Generous bound on the central seat roster — the whole central chart is a
 *  few dozen assignments, nowhere near this. */
const CENTRAL_ASSIGNMENT_SCAN_LIMIT = 500;

/**
 * The email addresses of everyone who can act on a new application — i.e.
 * every central seat holder carrying `hiring.edit` (which `hiring.approve`
 * implies).
 *
 * Derived from the seat chart rather than a configured inbox list on purpose:
 * a notification list that is maintained separately from the powers goes stale
 * the first time someone changes seats, and then the desk quietly stops
 * telling the person who is actually responsible. Here, granting the power IS
 * subscribing, and removing it IS unsubscribing.
 *
 * Placeholder roster rows and rows with no email contribute nothing. Returns a
 * deduped list; may be empty (nobody holds the power yet), which callers must
 * treat as "send nothing", never as an error.
 */
export async function hiringDeskRecipients(ctx: QueryCtx): Promise<string[]> {
  return await centralHoldersOf(ctx, "hiring.edit");
}

/**
 * Who gets the daily applications digest: every central seat holder who can
 * SEE the pipeline (`hiring.view`, which `hiring.edit` and `hiring.approve`
 * imply). Wider than `hiringDeskRecipients` on purpose — the digest is a read
 * of the desk, so anyone who may open it is told what's in it. Same seat-chart
 * subscription rule; same "empty means send nothing".
 */
export async function hiringDigestRecipients(ctx: QueryCtx): Promise<string[]> {
  return await centralHoldersOf(ctx, "hiring.view");
}

/** Deduped, lowercased emails of real people on central seats whose expanded
 *  powers include `power`. */
async function centralHoldersOf(ctx: QueryCtx, power: Power): Promise<string[]> {
  const assignments = await ctx.db
    .query("seatAssignments")
    .withIndex("by_scope", (q) => q.eq("scope", "central"))
    .take(CENTRAL_ASSIGNMENT_SCAN_LIMIT);

  const emails = new Set<string>();
  const defCache = new Map<string, boolean>();

  for (const assignment of assignments) {
    const key = String(assignment.seatDefId);
    let carries = defCache.get(key);
    if (carries === undefined) {
      const def = await ctx.db.get(assignment.seatDefId);
      carries = def ? expandPowers(def.capabilities).has(power) : false;
      defCache.set(key, carries);
    }
    if (!carries) continue;

    const person = await ctx.db.get(assignment.personId);
    if (!person || person.isPlaceholder === true) continue;
    const email = person.email?.trim();
    if (email) emails.add(email.toLowerCase());
  }
  return [...emails];
}
