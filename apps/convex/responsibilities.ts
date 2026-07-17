/**
 * Responsibilities — recurring org duties, fanned out by role.
 *
 * Rows are DEFINITIONS: "Meet with directs, bi-weekly, all Directors" is one
 * row that shows up as an individual responsibility for every person whose
 * role matches (plus anyone assigned directly). Managers and admins work the
 * whole catalog (the Duties tab); everyone else only receives the duties that
 * land on them, and editing is manager/admin-only throughout.
 */
import { query, mutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { ConvexError, v } from "convex/values";
import { RESPONSIBILITY_CADENCES, SEAT_CHARTS } from "@events-os/shared";
import {
  requireUserId,
  requireChapterId,
  requireOwned,
  getChapterIdOrNull,
} from "./lib/context";
import {
  requireManagerOrAdmin,
  canViewChapterWork,
} from "./lib/org";
import { makeShareId } from "./lib/platformGuides";

/**
 * Materialize plain how-to TEXT into a standalone `note` doc and return its id,
 * so a duty points at a doc via `howToDocId` (the legacy plain-text `howTo`
 * field is never written). Mirrors the `materializeHowToDocs` migration: a doc
 * is authored AS a roster person (`docs.createdBy` is an `Id<"people">`), so we
 * attribute it to the creating user's linked roster person, else the oldest
 * person in the chapter. Returns null when the text is empty or the chapter has
 * no roster person to own the doc (caller leaves `howToDocId` unset).
 */
async function materializeHowToDoc(
  ctx: MutationCtx,
  chapterId: Id<"chapters">,
  userId: Id<"users">,
  title: string,
  text: string | null | undefined,
): Promise<Id<"docs"> | null> {
  const body = text?.trim();
  if (!body) return null;
  const linked = await ctx.db
    .query("people")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();
  let author: Id<"people"> | null =
    linked && linked.chapterId === chapterId ? linked._id : null;
  if (!author) {
    const anyPerson = await ctx.db
      .query("people")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .first();
    author = anyPerson?._id ?? null;
  }
  if (!author) return null;
  const now = Date.now();
  return (await ctx.db.insert("docs", {
    chapterId,
    kind: "note",
    title: title || "How-to",
    body,
    shareId: makeShareId(),
    createdBy: author,
    createdAt: now,
    updatedAt: now,
  })) as Id<"docs">;
}

const cadence = v.union(...RESPONSIBILITY_CADENCES.map((c) => v.literal(c)));
const seatChart = v.union(...SEAT_CHARTS.map((c) => v.literal(c)));

/** Assert every id in `seatDefIds` names a real `seatDefs` row. Seat defs are a
 *  single GLOBAL table (the chart's shape is shared across every chapter — see
 *  `schema/seats.ts`), so this is an existence check, not a chapter-ownership
 *  check like `requireOwned`. */
async function requireSeatDefs(
  ctx: MutationCtx,
  seatDefIds: readonly Id<"seatDefs">[],
): Promise<void> {
  for (const seatDefId of seatDefIds) {
    const seat = await ctx.db.get(seatDefId);
    if (!seat) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "One of those seats no longer exists.",
      });
    }
  }
}

// Editing responsibilities is for managers and admins (requireManagerOrAdmin):
// these rows feed the check-in accountability loop, so the person being held
// to a duty must not be able to quietly delete or unassign it before their 1:1.

/**
 * The chapter's responsibility definitions, oldest first, each with a summary
 * of its How-To doc (kind/title/url) joined in so list surfaces can render the
 * affordance without a doc query per row.
 *
 * Read is transparent: admins and every roster member get the whole catalog, so
 * any person's workload page can show the duties they carry — part of seeing the
 * work everyone has. (Editing still gates on manager/admin in the mutations.) A
 * caller with no roster row and no admin rights gets nothing.
 */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const chapterId = await getChapterIdOrNull(ctx);
    if (!chapterId) return [];
    if (!(await canViewChapterWork(ctx, chapterId as Id<"chapters">))) {
      return [];
    }
    const rows = await ctx.db
      .query("responsibilities")
      .withIndex("by_chapter", (q) =>
        q.eq("chapterId", chapterId as Id<"chapters">),
      )
      .collect();
    return await Promise.all(
      rows.map(async (r) => {
        if (!r.howToDocId) return { ...r, howToDoc: null };
        const doc = await ctx.db.get(r.howToDocId);
        return {
          ...r,
          howToDoc:
            doc && doc.chapterId === chapterId
              ? {
                  _id: doc._id,
                  kind: doc.kind,
                  title: doc.title,
                  url: doc.url ?? null,
                  // Only notes render their body on list surfaces — don't
                  // stream every markdown runbook to every subscriber.
                  body: doc.kind === "note" ? (doc.body ?? null) : null,
                }
              : null,
        };
      }),
    );
  },
});

/** Create a responsibility definition. */
export const create = mutation({
  args: {
    title: v.string(),
    description: v.optional(v.string()),
    howTo: v.optional(v.string()),
    cadence: v.optional(cadence),
    assigneeSeatIds: v.optional(v.array(v.id("seatDefs"))),
    // Legacy — kept for pre-seats callers/tests. Dropped at insert time when
    // `assigneeSeatIds` is also given (seats win from the start; see
    // `responsibilityAppliesTo`).
    assigneeRoles: v.optional(v.array(v.string())),
    assigneePersonIds: v.optional(v.array(v.id("people"))),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const chapterId = await requireChapterId(ctx);
    const userId = await requireUserId(ctx);
    await requireManagerOrAdmin(ctx, chapterId as Id<"chapters">);
    for (const personId of args.assigneePersonIds ?? []) {
      await requireOwned(ctx, "people", personId, "Assignee");
    }
    await requireSeatDefs(ctx, args.assigneeSeatIds ?? []);
    const hasSeats = (args.assigneeSeatIds ?? []).length > 0;
    // Legacy plain-text `howTo` is no longer written; materialize any supplied
    // text into a note doc and point at it via `howToDocId`.
    const howToDocId =
      (await materializeHowToDoc(
        ctx,
        chapterId as Id<"chapters">,
        userId as Id<"users">,
        args.title,
        args.howTo,
      )) ?? undefined;
    const now = Date.now();
    return await ctx.db.insert("responsibilities", {
      chapterId: chapterId as Id<"chapters">,
      title: args.title,
      description: args.description,
      howToDocId,
      cadence: args.cadence ?? "ad_hoc",
      assigneeSeatIds:
        (args.assigneeSeatIds?.length ?? 0) > 0
          ? args.assigneeSeatIds
          : undefined,
      // Seats win from the moment they're given — don't also store legacy
      // roles a caller passed alongside them.
      assigneeRoles: hasSeats ? undefined : args.assigneeRoles,
      assigneePersonIds: args.assigneePersonIds,
      notes: args.notes,
      createdBy: userId as Id<"users">,
      createdAt: now,
      updatedAt: now,
    });
  },
});

/** Patch a responsibility. `null` = explicit clear; `undefined` = unchanged. */
export const update = mutation({
  args: {
    responsibilityId: v.id("responsibilities"),
    title: v.optional(v.string()),
    description: v.optional(v.union(v.string(), v.null())),
    howTo: v.optional(v.union(v.string(), v.null())),
    howToDocId: v.optional(v.union(v.id("docs"), v.null())),
    cadence: v.optional(cadence),
    assigneeSeatIds: v.optional(v.union(v.array(v.id("seatDefs")), v.null())),
    assigneeRoles: v.optional(v.union(v.array(v.string()), v.null())),
    assigneePersonIds: v.optional(
      v.union(v.array(v.id("people")), v.null()),
    ),
    notes: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, { responsibilityId, ...patch }) => {
    const row = await requireOwned(
      ctx,
      "responsibilities",
      responsibilityId,
      "Responsibility",
    );
    await requireManagerOrAdmin(ctx, row.chapterId);
    if (Array.isArray(patch.assigneePersonIds)) {
      for (const personId of patch.assigneePersonIds) {
        await requireOwned(ctx, "people", personId, "Assignee");
      }
    }
    if (patch.howToDocId != null) {
      await requireOwned(ctx, "docs", patch.howToDocId, "How-To doc");
    }
    if (Array.isArray(patch.assigneeSeatIds)) {
      await requireSeatDefs(ctx, patch.assigneeSeatIds);
    }
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      // null = explicit clear (store undefined); undefined = leave unchanged.
      if (value !== undefined) fields[key] = value === null ? undefined : value;
    }
    // Empty array normalizes to undefined, matching every other list field's
    // "no rows → absent" convention (see addAssignee/removeAssignee).
    if (
      Array.isArray(fields.assigneeSeatIds) &&
      fields.assigneeSeatIds.length === 0
    ) {
      fields.assigneeSeatIds = undefined;
    }
    // THE MAPPING FLOW: the instant a duty has seats, legacy role strings are
    // cleared — seats are authoritative from here on (`responsibilityAppliesTo`
    // already ignores `assigneeRoles` whenever `assigneeSeatIds` is non-empty,
    // so this isn't strictly required for matching correctness, but leaving
    // dead legacy chips around after an owner explicitly maps a duty to seats
    // is confusing debris no surface should still render).
    if (
      Array.isArray(fields.assigneeSeatIds) &&
      fields.assigneeSeatIds.length > 0
    ) {
      fields.assigneeRoles = undefined;
    }
    // Legacy plain-text `howTo` is no longer written. Accept the arg (OTA-lagged
    // clients) but drop it; when it carries text and no doc is being set, fold
    // it into a note doc and point the duty at it via `howToDocId`.
    delete fields.howTo;
    if (
      typeof patch.howTo === "string" &&
      patch.howTo.trim() &&
      patch.howToDocId === undefined &&
      !row.howToDocId
    ) {
      const docId = await materializeHowToDoc(
        ctx,
        row.chapterId,
        (await requireUserId(ctx)) as Id<"users">,
        patch.title ?? row.title,
        patch.howTo,
      );
      if (docId) fields.howToDocId = docId;
    }
    fields.updatedAt = Date.now();
    await ctx.db.patch(responsibilityId, fields);
    return responsibilityId;
  },
});

/**
 * Directly assign one person to a duty. Targeted — membership is read and
 * rewritten inside this transaction — so two people editing assignments at
 * once can't clobber each other the way whole-array `update` patches computed
 * from stale client state can. No-op when already assigned.
 */
export const addAssignee = mutation({
  args: {
    responsibilityId: v.id("responsibilities"),
    personId: v.id("people"),
  },
  handler: async (ctx, { responsibilityId, personId }) => {
    const row = await requireOwned(
      ctx,
      "responsibilities",
      responsibilityId,
      "Responsibility",
    );
    await requireManagerOrAdmin(ctx, row.chapterId);
    await requireOwned(ctx, "people", personId, "Assignee");
    const current = row.assigneePersonIds ?? [];
    if (!current.includes(personId)) {
      await ctx.db.patch(responsibilityId, {
        assigneePersonIds: [...current, personId],
        updatedAt: Date.now(),
      });
    }
    return responsibilityId;
  },
});

/**
 * Remove one person's DIRECT assignment from a duty. Role-derived application
 * is deliberately untouched: a duty that reaches them via their title keeps
 * applying until the definition's roles change (Duties grid) or their title
 * does — unassigning a role-match per person would silently fork the fan-out.
 * No-op when not directly assigned.
 */
export const removeAssignee = mutation({
  args: {
    responsibilityId: v.id("responsibilities"),
    personId: v.id("people"),
  },
  handler: async (ctx, { responsibilityId, personId }) => {
    const row = await requireOwned(
      ctx,
      "responsibilities",
      responsibilityId,
      "Responsibility",
    );
    await requireManagerOrAdmin(ctx, row.chapterId);
    const current = row.assigneePersonIds ?? [];
    if (current.includes(personId)) {
      const next = current.filter((id) => id !== personId);
      await ctx.db.patch(responsibilityId, {
        assigneePersonIds: next.length > 0 ? next : undefined,
        updatedAt: Date.now(),
      });
    }
    return responsibilityId;
  },
});

/**
 * Add one seat to a duty's fan-out. Targeted — read-modify-write inside this
 * transaction, mirroring `addAssignee` — so two managers picking seats on the
 * same duty at once can't clobber each other's picks the way a whole-array
 * `update({ assigneeSeatIds })` computed from stale client state can.
 * Adding the FIRST seat is THE MAPPING FLOW: legacy `assigneeRoles` is
 * cleared in the same edit (mirrors `update`'s mapping-flow clearing). No-op
 * if the seat is already assigned.
 */
export const addSeat = mutation({
  args: {
    responsibilityId: v.id("responsibilities"),
    seatDefId: v.id("seatDefs"),
  },
  handler: async (ctx, { responsibilityId, seatDefId }) => {
    const row = await requireOwned(
      ctx,
      "responsibilities",
      responsibilityId,
      "Responsibility",
    );
    await requireManagerOrAdmin(ctx, row.chapterId);
    await requireSeatDefs(ctx, [seatDefId]);
    const current = row.assigneeSeatIds ?? [];
    if (!current.includes(seatDefId)) {
      await ctx.db.patch(responsibilityId, {
        assigneeSeatIds: [...current, seatDefId],
        // Seats become authoritative the instant there's any — same rule
        // `update` enforces for a whole-array patch.
        assigneeRoles: undefined,
        updatedAt: Date.now(),
      });
    }
    return responsibilityId;
  },
});

/**
 * Remove one seat from a duty's fan-out. Targeted, mirrors `removeAssignee`.
 * Deliberately does NOT restore legacy `assigneeRoles` even when this empties
 * `assigneeSeatIds` — the mapping flow clears them permanently; there's no UI
 * to re-add a legacy role string. No-op if the seat isn't assigned.
 */
export const removeSeat = mutation({
  args: {
    responsibilityId: v.id("responsibilities"),
    seatDefId: v.id("seatDefs"),
  },
  handler: async (ctx, { responsibilityId, seatDefId }) => {
    const row = await requireOwned(
      ctx,
      "responsibilities",
      responsibilityId,
      "Responsibility",
    );
    await requireManagerOrAdmin(ctx, row.chapterId);
    const current = row.assigneeSeatIds ?? [];
    if (current.includes(seatDefId)) {
      const next = current.filter((id) => id !== seatDefId);
      await ctx.db.patch(responsibilityId, {
        assigneeSeatIds: next.length > 0 ? next : undefined,
        updatedAt: Date.now(),
      });
    }
    return responsibilityId;
  },
});

/** Delete a responsibility definition (check-in history keeps its snapshot). */
export const remove = mutation({
  args: { responsibilityId: v.id("responsibilities") },
  handler: async (ctx, { responsibilityId }) => {
    const row = await requireOwned(
      ctx,
      "responsibilities",
      responsibilityId,
      "Responsibility",
    );
    await requireManagerOrAdmin(ctx, row.chapterId);
    await ctx.db.delete(responsibilityId);
    return responsibilityId;
  },
});

// ── Seats (duties-on-seats) ─────────────────────────────────────────────────
//
// The Duties grid needs two things the seats table itself doesn't hand back:
// (1) every seat def as flat, pickable options (grouped Central/Chapter), and
// (2) which people hold which seats, to compute per-duty holder counts and to
// resolve `responsibilityAppliesTo`'s `person.seatIds` argument. Both live
// here (not `seats.ts`, which is read/seed-only for the chart itself) since
// they're consumption-shaped for the duties surfaces, not chart surfaces.

/** Bound on how many seat defs / assignments a chapter's picker or holder scan
 *  reads — generous headroom over the ~27-seat template (see `seats.ts`'s
 *  `MAX_CHART_SEATS`). */
const MAX_SEAT_SCAN = 500;

/** Every seat def, flattened for the Duties grid's seat picker (grouped
 *  Central/Chapter by the caller). Org-transparent like the chart itself —
 *  any roster member who can see the duty catalog can see the seat list. */
export const seatOptions = query({
  args: {},
  returns: v.array(
    v.object({
      seatDefId: v.id("seatDefs"),
      title: v.string(),
      chart: seatChart,
    }),
  ),
  handler: async (ctx) => {
    const chapterId = await getChapterIdOrNull(ctx);
    if (!chapterId) return [];
    if (!(await canViewChapterWork(ctx, chapterId as Id<"chapters">))) {
      return [];
    }
    const defs = await ctx.db.query("seatDefs").take(MAX_SEAT_SCAN);
    return defs
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((d) => ({ seatDefId: d._id, title: d.title, chart: d.chart }));
  },
});

/**
 * Every (person, seat) holding relevant to the caller's chapter: this
 * chapter's own chapter-chart occupancy, plus EVERY central-chart occupancy
 * — central rows are fetched unconditionally (not filtered by the assigned
 * person's home chapter), because central-seat occupancy is
 * chapter-independent by design (see the `responsibilities` schema doc
 * comment). So a central seat held by someone homed in a DIFFERENT chapter
 * than the caller still resolves here — the caller's own chapter only bounds
 * the CHAPTER-chart half of the result, never the central half.
 *
 * This is exactly the resolution `responsibilityAppliesTo` needs for
 * `person.seatIds`: build a `personId -> Set<seatDefId>` map from these rows
 * and pass each person's set through. A caller resolving a specific person's
 * OWN holdings should call this scoped to THAT PERSON'S home chapter (not
 * necessarily the viewer's) — e.g. a person's own Work page always resolves
 * their own seats correctly regardless of who's asking.
 */
export const chapterSeatHoldings = query({
  args: {},
  returns: v.array(
    v.object({
      personId: v.id("people"),
      seatDefId: v.id("seatDefs"),
      seatTitle: v.string(),
    }),
  ),
  handler: async (ctx) => {
    const chapterId = await getChapterIdOrNull(ctx);
    if (!chapterId) return [];
    if (!(await canViewChapterWork(ctx, chapterId as Id<"chapters">))) {
      return [];
    }
    const [centralRows, chapterRows] = await Promise.all([
      ctx.db
        .query("seatAssignments")
        .withIndex("by_scope", (q) => q.eq("scope", "central"))
        .take(MAX_SEAT_SCAN),
      ctx.db
        .query("seatAssignments")
        .withIndex("by_scope", (q) => q.eq("scope", chapterId as Id<"chapters">))
        .take(MAX_SEAT_SCAN),
    ]);
    const rows = [...centralRows, ...chapterRows];
    const defIds = Array.from(new Set(rows.map((r) => r.seatDefId)));
    const defs = await Promise.all(defIds.map((id) => ctx.db.get(id)));
    const titleByDef = new Map(
      defs
        .filter((d): d is NonNullable<typeof d> => d !== null)
        .map((d) => [d._id, d.title]),
    );
    return rows
      .filter((r) => titleByDef.has(r.seatDefId))
      .map((r) => ({
        personId: r.personId,
        seatDefId: r.seatDefId,
        seatTitle: titleByDef.get(r.seatDefId)!,
      }));
  },
});

/** Bound on the cross-chapter scan `dutiesForSeat` does for a CENTRAL seat
 *  (every chapter's duty catalog, since a central seat's occupancy is
 *  chapter-independent). Generous headroom for a mid-size org; matches the
 *  spirit of `finances.ts`'s `ROLLUP_SCAN_LIMIT`-style bounded full scans. */
const MAX_CROSS_CHAPTER_DUTY_SCAN = 2000;

/**
 * The duties attached to one seat (`assigneeSeatIds` contains it).
 *
 * A CHAPTER-chart seat's occupancy is per-chapter, so its duties are scoped
 * to the CALLER'S own chapter — mirrors `list`'s chapter scoping (a duty row
 * always belongs to one chapter; there's no chapter-independent duty table).
 *
 * A CENTRAL-chart seat's occupancy is chapter-INDEPENDENT (the same seat,
 * held by the same people, "central" scope, regardless of which chapter's
 * roster they're homed in) — so a duty ANY chapter mapped to that seat is
 * relevant, not just the caller's own chapter's. Restricting to the caller's
 * chapter here would mean a chapter-A-authored duty mapped to a central seat
 * never reaches that seat's panel when browsed from chapter B, even though
 * the seat (and its holder) are the same either way. Gated the same as every
 * other seat/duty read — org-transparent to any signed-in roster member, not
 * just the authoring chapter's.
 *
 * The org-chart UI (a later PR) is expected to call this while browsing a
 * seat's panel, central or chapter. Simple summary shape — no How-To doc
 * join, no holder resolution; that's `list`'s job.
 */
export const dutiesForSeat = query({
  args: { seatDefId: v.id("seatDefs") },
  returns: v.array(
    v.object({
      id: v.id("responsibilities"),
      title: v.string(),
      cadence,
      description: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, { seatDefId }) => {
    const chapterId = await getChapterIdOrNull(ctx);
    if (!chapterId) return [];
    if (!(await canViewChapterWork(ctx, chapterId as Id<"chapters">))) {
      return [];
    }
    const seat = await ctx.db.get(seatDefId);
    if (!seat) return [];

    const rows =
      seat.chart === "central"
        ? await ctx.db
            .query("responsibilities")
            .take(MAX_CROSS_CHAPTER_DUTY_SCAN)
        : await ctx.db
            .query("responsibilities")
            .withIndex("by_chapter", (q) =>
              q.eq("chapterId", chapterId as Id<"chapters">),
            )
            .collect();

    return rows
      .filter((r) => (r.assigneeSeatIds ?? []).includes(seatDefId))
      .map((r) => ({
        id: r._id,
        title: r.title,
        cadence: r.cadence,
        description: r.description,
      }));
  },
});
