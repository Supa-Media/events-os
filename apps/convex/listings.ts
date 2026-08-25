/**
 * JOB LISTINGS — the postings on `/team`, managed live from the OS.
 *
 * These used to be markdown files in the landing repo (add-a-role-is-a-PR). The
 * recruiting desk had no way to open, close, edit, or add a posting from the
 * app, which is the whole reason this module exists. A listing is now a row in
 * `jobListings` (`schema/hiring.ts`), the public page reads it live over
 * `GET /api/team/roles` (`lib/listingApiRoutes.ts` → `publicListings`), and
 * every write is gated by `requireListingManage` (`lib/hiringAccess.ts`).
 *
 * TWO GATES ON VISIBILITY, deliberately separate:
 *  - `published` — the DRAFT gate. A recruiter can save a half-written role and
 *    come back to it; the public page never sees an unpublished listing at all.
 *  - `status` — the public LIFECYCLE (`ROLE_STATUSES`). A published role is
 *    open / interviewing / not-open-yet / filled; all four render, only the
 *    first two take applications.
 *
 * COMPLETENESS is enforced at PUBLISH, not at every save. A draft may be
 * missing sections; publishing one runs `problemsBlockingPublish` so a live
 * role page never renders an empty "What you'd be accountable for". This is the
 * executable copy of what the old content-collection Zod schema enforced with
 * `.min(1)` — moved to the moment it actually matters.
 */
import { ConvexError, v } from "convex/values";
import {
  mutation,
  query,
  internalQuery,
  internalMutation,
} from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import {
  ROLE_STATUSES,
  roleSlugFromTitle,
  type PublicJobListing,
  type RoleStatus,
} from "@events-os/shared";
import { requireHiringView, requireListingManage } from "./lib/hiringAccess";
import { PEOPLE_DIRECTOR_LISTING } from "./lib/seed/listings";

/** Generous bound — the whole org chart is a few dozen seats, never near this. */
const LISTING_SCAN_LIMIT = 500;

const statusValidator = v.union(...ROLE_STATUSES.map((s) => v.literal(s)));
const outcomeValidator = v.object({
  outcome: v.string(),
  doneWhen: v.string(),
});
const responsibilityValidator = v.object({
  area: v.string(),
  items: v.array(v.string()),
});

/** Format a stored ms timestamp as an ISO date (`YYYY-MM-DD`) for the page.
 *  Deterministic — a fixed ms in, a fixed string out — so it is query-safe. */
function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The wire shape the public page consumes (`PublicJobListing`). The ONE place
 *  a `jobListings` row becomes public JSON — the landing renderer speaks the
 *  same shared type, so this is the seam that must not drift. */
function serialize(doc: Doc<"jobListings">): PublicJobListing {
  return {
    slug: doc.slug,
    title: doc.title,
    status: doc.status,
    team: doc.team,
    commitment: doc.commitment,
    location: doc.location,
    hoursPerWeek: doc.hoursPerWeek,
    reportsTo: doc.reportsTo,
    worksWith: doc.worksWith,
    manages: doc.manages,
    trialTrack: doc.trialTrack,
    ...(doc.seatId ? { seatId: doc.seatId } : {}),
    order: doc.order,
    summary: doc.summary,
    whyThisSeatExists: doc.whyThisSeatExists,
    outcomes: doc.outcomes,
    authority: doc.authority,
    responsibilities: doc.responsibilities,
    rhythms: doc.rhythms,
    firstNinetyDays: doc.firstNinetyDays,
    required: doc.required,
    preferred: doc.preferred,
    notThisRole: doc.notThisRole,
    successLooks: doc.successLooks,
    ...(doc.growthPath ? { growthPath: doc.growthPath } : {}),
    ...(doc.body ? { body: doc.body } : {}),
    postedAt: isoDate(doc.postedAt),
    ...(doc.updatedAt && doc.updatedAt !== doc.createdAt
      ? { updatedAt: isoDate(doc.updatedAt) }
      : {}),
  };
}

/** Status order on the public index: apply-now first, then coming, then filled.
 *  Mirrors the landing site's old `STATUS_ORDER`. */
const STATUS_ORDER: Record<RoleStatus, number> = {
  open: 0,
  filling: 1,
  not_open: 2,
  closed: 3,
};

/** The desk's sort: by status, then the listing's own order, then title, so the
 *  list is stable and reads the way `/team` reads. */
function byDeskOrder(a: Doc<"jobListings">, b: Doc<"jobListings">): number {
  const byStatus = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
  if (byStatus !== 0) return byStatus;
  if (a.order !== b.order) return a.order - b.order;
  return a.title.localeCompare(b.title);
}

/**
 * What is still missing before a listing may go PUBLIC, as human sentences.
 *
 * These are the sections a role page renders as its own headed block; a live
 * page with any of them empty reads as broken, which is exactly what the old
 * Zod `.min(1)` prevented. Returned as a list (not thrown) so the OS editor can
 * show a recruiter everything left to do at once, rather than one error per
 * save.
 */
function problemsBlockingPublish(doc: Doc<"jobListings">): string[] {
  const problems: string[] = [];
  const need = (ok: boolean, what: string) => {
    if (!ok) problems.push(what);
  };
  need(doc.title.trim().length > 0, "a title");
  need(doc.team.trim().length > 0, "a team");
  need(doc.location.trim().length > 0, "a location");
  need(doc.reportsTo.trim().length > 0, "who it reports to");
  need(doc.summary.trim().length > 0, "the short version");
  need(doc.whyThisSeatExists.trim().length > 0, "why this seat exists");
  need(doc.outcomes.length > 0, "at least one accountability (outcome)");
  need(doc.authority.length > 0, "at least one thing it gets to decide");
  need(doc.responsibilities.length > 0, "at least one area of the work");
  need(doc.rhythms.length > 0, "the rhythms");
  need(doc.firstNinetyDays.length > 0, "the first 90 days");
  need(doc.required.length > 0, "at least one requirement");
  need(doc.notThisRole.length > 0, "what this role is not");
  need(doc.successLooks.length > 0, "what success looks like");
  return problems;
}

// ── PUBLIC read (no auth) — the /team wire ───────────────────────────────────

/**
 * Every PUBLISHED listing, serialized for the public page, in `/team` order.
 *
 * `internalQuery`, not `query`: the only caller is the `GET /api/team/roles`
 * HTTP route (`lib/listingApiRoutes.ts`). Keeping it internal means the public
 * surface is exactly that one relative endpoint the landing site fetches, the
 * same shape as every other `/api/*` the site talks to — not a second,
 * directly-callable Convex function that could drift out of the route's
 * framing. Returns only `published` rows; a draft is not content.
 */
export const publicListings = internalQuery({
  args: {},
  returns: v.array(v.any()),
  handler: async (ctx): Promise<PublicJobListing[]> => {
    const rows = await ctx.db
      .query("jobListings")
      .withIndex("by_published", (q) => q.eq("published", true))
      .take(LISTING_SCAN_LIMIT);
    return rows.sort(byDeskOrder).map(serialize);
  },
});

// ── DESK reads (gated) ───────────────────────────────────────────────────────

/**
 * Every listing — drafts included — for the OS manager, in desk order.
 *
 * Gated on `hiring.view`: seeing what's posted is part of reading the desk.
 * Returns the raw rows (with `_id`, `published`, timestamps) because the
 * manager needs to edit them, unlike the public serializer which strips to
 * content.
 */
export const listListings = query({
  args: {},
  handler: async (ctx): Promise<Doc<"jobListings">[]> => {
    await requireHiringView(ctx);
    const rows = await ctx.db.query("jobListings").take(LISTING_SCAN_LIMIT);
    return rows.sort(byDeskOrder);
  },
});

/** One listing by id, for the editor. Gated on `hiring.view`. */
export const getListing = query({
  args: { listingId: v.id("jobListings") },
  handler: async (ctx, args): Promise<Doc<"jobListings"> | null> => {
    await requireHiringView(ctx);
    return await ctx.db.get(args.listingId);
  },
});

// ── DESK writes (gated on manage) ────────────────────────────────────────────

/**
 * Create or edit a listing.
 *
 * CREATE (no `listingId`): a `title` is required — it is the posting's
 * identity, and the immutable slug is minted from it here. Everything else
 * defaults empty so a recruiter can save a stub and fill it in; the listing is
 * born a DRAFT (`published: false`) whatever else is passed, because a first
 * save is never a decision to go live. `postedAt` is stamped now.
 *
 * EDIT (with `listingId`): every field is patched only when its arg was sent —
 * a partial save leaves the rest as-is (the same `undefined`-means-leave-it
 * rule the sponsorships writer uses), so the editor can save one section
 * without blanking the others. The slug never changes.
 *
 * Publishing is NOT done here — it has its own gate (`setListingPublished`) so
 * completeness is checked at exactly the moment it matters.
 */
export const upsertListing = mutation({
  args: {
    listingId: v.optional(v.id("jobListings")),
    title: v.optional(v.string()),
    status: v.optional(statusValidator),
    team: v.optional(v.string()),
    commitment: v.optional(v.string()),
    location: v.optional(v.string()),
    hoursPerWeek: v.optional(v.number()),
    reportsTo: v.optional(v.string()),
    worksWith: v.optional(v.array(v.string())),
    manages: v.optional(v.array(v.string())),
    trialTrack: v.optional(
      v.union(v.literal("team_member"), v.literal("director")),
    ),
    seatId: v.optional(v.union(v.string(), v.null())),
    order: v.optional(v.number()),
    summary: v.optional(v.string()),
    whyThisSeatExists: v.optional(v.string()),
    outcomes: v.optional(v.array(outcomeValidator)),
    authority: v.optional(v.array(v.string())),
    responsibilities: v.optional(v.array(responsibilityValidator)),
    rhythms: v.optional(v.array(v.string())),
    firstNinetyDays: v.optional(v.array(v.string())),
    required: v.optional(v.array(v.string())),
    preferred: v.optional(v.array(v.string())),
    notThisRole: v.optional(v.array(v.string())),
    successLooks: v.optional(v.array(v.string())),
    growthPath: v.optional(v.union(v.string(), v.null())),
    body: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.id("jobListings"),
  handler: async (ctx, args) => {
    await requireListingManage(ctx);
    const now = Date.now();

    if (args.listingId) {
      const existing = await ctx.db.get(args.listingId);
      if (!existing) {
        throw new ConvexError({
          code: "NOT_FOUND",
          message: "That listing doesn't exist.",
        });
      }
      // Patch only what was sent. `undefined` = leave as-is; an explicit empty
      // string / array / null is a real edit and comes through.
      await ctx.db.patch(args.listingId, {
        ...(args.title !== undefined ? { title: args.title.trim() } : {}),
        ...(args.status !== undefined ? { status: args.status } : {}),
        ...(args.team !== undefined ? { team: args.team.trim() } : {}),
        ...(args.commitment !== undefined
          ? { commitment: args.commitment.trim() || "Volunteer" }
          : {}),
        ...(args.location !== undefined
          ? { location: args.location.trim() }
          : {}),
        ...(args.hoursPerWeek !== undefined
          ? { hoursPerWeek: args.hoursPerWeek }
          : {}),
        ...(args.reportsTo !== undefined
          ? { reportsTo: args.reportsTo.trim() }
          : {}),
        ...(args.worksWith !== undefined
          ? { worksWith: cleanList(args.worksWith) }
          : {}),
        ...(args.manages !== undefined
          ? { manages: cleanList(args.manages) }
          : {}),
        ...(args.trialTrack !== undefined
          ? { trialTrack: args.trialTrack }
          : {}),
        ...(args.seatId !== undefined
          ? { seatId: args.seatId?.trim() || undefined }
          : {}),
        ...(args.order !== undefined ? { order: args.order } : {}),
        ...(args.summary !== undefined
          ? { summary: args.summary.trim() }
          : {}),
        ...(args.whyThisSeatExists !== undefined
          ? { whyThisSeatExists: args.whyThisSeatExists.trim() }
          : {}),
        ...(args.outcomes !== undefined
          ? { outcomes: cleanOutcomes(args.outcomes) }
          : {}),
        ...(args.authority !== undefined
          ? { authority: cleanList(args.authority) }
          : {}),
        ...(args.responsibilities !== undefined
          ? { responsibilities: cleanResponsibilities(args.responsibilities) }
          : {}),
        ...(args.rhythms !== undefined
          ? { rhythms: cleanList(args.rhythms) }
          : {}),
        ...(args.firstNinetyDays !== undefined
          ? { firstNinetyDays: cleanList(args.firstNinetyDays) }
          : {}),
        ...(args.required !== undefined
          ? { required: cleanList(args.required) }
          : {}),
        ...(args.preferred !== undefined
          ? { preferred: cleanList(args.preferred) }
          : {}),
        ...(args.notThisRole !== undefined
          ? { notThisRole: cleanList(args.notThisRole) }
          : {}),
        ...(args.successLooks !== undefined
          ? { successLooks: cleanList(args.successLooks) }
          : {}),
        ...(args.growthPath !== undefined
          ? { growthPath: args.growthPath?.trim() || undefined }
          : {}),
        ...(args.body !== undefined
          ? { body: args.body?.trim() || undefined }
          : {}),
        updatedAt: now,
      });
      // The publish gate has exactly one hole: an edit that EMPTIES a required
      // section of an already-LIVE listing would otherwise leave it published
      // yet incomplete — a public role page with a headed-but-empty section,
      // the one thing publishing is supposed to prevent. So a live listing that
      // an edit makes incomplete drops back to draft (off the public feed)
      // until it's whole again and re-published. A draft edited incomplete is
      // fine — that's what a draft is for.
      if (existing.published) {
        const updated = await ctx.db.get(args.listingId);
        if (updated && problemsBlockingPublish(updated).length > 0) {
          await ctx.db.patch(args.listingId, { published: false, updatedAt: now });
        }
      }
      return args.listingId;
    }

    // CREATE
    const title = (args.title ?? "").trim();
    if (!title) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: "Give the listing a title to start.",
      });
    }
    const slug = await uniqueSlug(ctx, roleSlugFromTitle(title));
    return await ctx.db.insert("jobListings", {
      slug,
      title,
      status: args.status ?? "not_open",
      published: false,
      team: (args.team ?? "").trim(),
      commitment: (args.commitment ?? "").trim() || "Volunteer",
      location: (args.location ?? "").trim(),
      hoursPerWeek: args.hoursPerWeek ?? 0,
      reportsTo: (args.reportsTo ?? "").trim(),
      worksWith: cleanList(args.worksWith ?? []),
      manages: cleanList(args.manages ?? []),
      trialTrack: args.trialTrack ?? "team_member",
      ...(args.seatId?.trim() ? { seatId: args.seatId.trim() } : {}),
      order: args.order ?? 100,
      summary: (args.summary ?? "").trim(),
      whyThisSeatExists: (args.whyThisSeatExists ?? "").trim(),
      outcomes: cleanOutcomes(args.outcomes ?? []),
      authority: cleanList(args.authority ?? []),
      responsibilities: cleanResponsibilities(args.responsibilities ?? []),
      rhythms: cleanList(args.rhythms ?? []),
      firstNinetyDays: cleanList(args.firstNinetyDays ?? []),
      required: cleanList(args.required ?? []),
      preferred: cleanList(args.preferred ?? []),
      notThisRole: cleanList(args.notThisRole ?? []),
      successLooks: cleanList(args.successLooks ?? []),
      ...(args.growthPath?.trim() ? { growthPath: args.growthPath.trim() } : {}),
      ...(args.body?.trim() ? { body: args.body.trim() } : {}),
      postedAt: now,
      createdAt: now,
      updatedAt: now,
    });
  },
});

/** Change the public lifecycle status (open / interviewing / not-open / filled)
 *  without touching the body. The most common desk action — "we filled it". */
export const setListingStatus = mutation({
  args: { listingId: v.id("jobListings"), status: statusValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireListingManage(ctx);
    const listing = await ctx.db.get(args.listingId);
    if (!listing) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "That listing doesn't exist.",
      });
    }
    await ctx.db.patch(args.listingId, {
      status: args.status,
      updatedAt: Date.now(),
    });
    return null;
  },
});

/**
 * Publish or unpublish a listing.
 *
 * Publishing runs the completeness check the old Zod `.min(1)` used to run at
 * build time — a live role page with an empty section is the failure this
 * prevents, so a listing missing any required part is refused here with a
 * message naming everything still needed. Unpublishing is always allowed:
 * pulling a role off the site is never something to block.
 */
export const setListingPublished = mutation({
  args: { listingId: v.id("jobListings"), published: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireListingManage(ctx);
    const listing = await ctx.db.get(args.listingId);
    if (!listing) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "That listing doesn't exist.",
      });
    }
    if (args.published) {
      const problems = problemsBlockingPublish(listing);
      if (problems.length > 0) {
        throw new ConvexError({
          code: "INCOMPLETE_LISTING",
          message: `This listing still needs ${problems.join(", ")} before it can go live.`,
        });
      }
    }
    await ctx.db.patch(args.listingId, {
      published: args.published,
      updatedAt: Date.now(),
    });
    return null;
  },
});

/**
 * Delete a listing.
 *
 * Safe to hard-delete: `jobApplications.roleSlug` is a denormalized snapshot,
 * never a foreign key (see `schema/hiring.ts`), so the files that came from a
 * posting outlive it untouched. Use for a mistaken or never-published draft;
 * to retire a filled role while keeping its page, set status `closed` instead.
 */
export const deleteListing = mutation({
  args: { listingId: v.id("jobListings") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireListingManage(ctx);
    const listing = await ctx.db.get(args.listingId);
    if (!listing) return null; // already gone — deleting twice is not an error
    await ctx.db.delete(args.listingId);
    return null;
  },
});

// ── one-time migration ───────────────────────────────────────────────────────

/**
 * Seed the ONE role that existed as markdown when listings moved into the OS,
 * but only into an empty table.
 *
 * Idempotent by the same "if empty" rule as `docs.seedPlatformGuides` /
 * `backerMilestones.seedMilestonesIfEmpty`: run it once per deployment after
 * the schema ships and the People Director posting is restored; run it again
 * and it no-ops. Once a director creates or edits any listing through the OS,
 * this never touches the table again. `internalMutation` — maintenance only,
 * never reachable from the UI:
 *
 *   npx convex run listings:seedListingsIfEmpty
 */
export const seedListingsIfEmpty = internalMutation({
  args: {},
  returns: v.object({ inserted: v.number() }),
  handler: async (ctx) => {
    const existing = await ctx.db.query("jobListings").first();
    if (existing) return { inserted: 0 };
    const now = Date.now();
    await ctx.db.insert("jobListings", {
      ...PEOPLE_DIRECTOR_LISTING,
      createdAt: now,
      updatedAt: now,
    });
    return { inserted: 1 };
  },
});

// ── input hygiene ────────────────────────────────────────────────────────────

/** Trim, drop blanks — every string-list field is stored clean so the page
 *  never renders an empty bullet. */
function cleanList(items: string[]): string[] {
  return items.map((s) => s.trim()).filter(Boolean);
}

/** Keep only outcomes that have both halves — an accountability with no
 *  definition of done is exactly what the template forbids. */
function cleanOutcomes(
  items: { outcome: string; doneWhen: string }[],
): { outcome: string; doneWhen: string }[] {
  return items
    .map((o) => ({ outcome: o.outcome.trim(), doneWhen: o.doneWhen.trim() }))
    .filter((o) => o.outcome || o.doneWhen);
}

/** Keep areas that have a name and at least one item; clean the items. */
function cleanResponsibilities(
  items: { area: string; items: string[] }[],
): { area: string; items: string[] }[] {
  return items
    .map((r) => ({ area: r.area.trim(), items: cleanList(r.items) }))
    .filter((r) => r.area && r.items.length > 0);
}

/** A slug no other listing holds. Appends `-2`, `-3`… on collision — two roles
 *  can share a title ("Chapter Director") and must not share a URL. */
async function uniqueSlug(ctx: MutationCtx, base: string): Promise<string> {
  const root = base || "role";
  let candidate = root;
  let n = 2;
  // Bounded: a realistic collision count is 1–2, and the org chart is tiny.
  for (let i = 0; i < 100; i++) {
    const clash = await ctx.db
      .query("jobListings")
      .withIndex("by_slug", (q) => q.eq("slug", candidate))
      .first();
    if (!clash) return candidate;
    candidate = `${root}-${n++}`;
  }
  return `${root}-${Date.now()}`;
}
