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
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
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

/** Assert every id in `seatDefIds` names a real, non-DERIVED `seatDefs` row.
 *  Seat defs are a single GLOBAL table (the chart's shape is shared across
 *  every chapter — see `schema/seats.ts`), so the existence half of this is
 *  not a chapter-ownership check like `requireOwned`.
 *
 *  A `derived` seat (e.g. the central chart's `chapter_directors` mirror —
 *  its holders are COMPUTED, rolled up from every chapter's real
 *  `chapter_director` seat, never assigned) can never carry a duty: mapping
 *  one there would silently split "Chapter Director" into two duty targets
 *  for what the owner has decided is ONE role with identical expectations
 *  everywhere. This is the belt to `seatOptions`/`dutiesForSeat` never
 *  OFFERING a derived seat as a target — a defense-in-depth guard against any
 *  future picker that hands this mutation a derived seat's id directly. */
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
    if (seat.derived === true) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: `"${seat.title}" is a computed seat and can't carry duties directly — map the duty to the real seat instead.`,
      });
    }
  }
}

// Editing responsibilities is for managers and admins (requireManagerOrAdmin):
// these rows feed the check-in accountability loop, so the person being held
// to a duty must not be able to quietly delete or unassign it before their 1:1.

/** Bound on the cross-chapter scan every org-wide seat-mapped-duty path does
 *  (`orgWideCatalog`, `dutiesForSeat`) — every `responsibilities` row across
 *  every chapter, since (per `orgWideCatalog`'s doc) a seat-mapped duty's
 *  applicability is no longer confined to its authoring chapter. Generous
 *  headroom for a mid-size org; mirrors `finances.ts`'s `ROLLUP_SCAN_LIMIT`
 *  bounded-scan-with-truncation-warning convention (see `seats.ts`'s
 *  `boundedChapters`, which this deliberately parallels but scans
 *  `responsibilities` directly rather than enumerating `chapters`, since
 *  applicability here turns on the DUTY rows, not per-chapter occupancy). */
const MAX_CROSS_CHAPTER_DUTY_SCAN = 2000;

/** Every `responsibilities` row across the WHOLE org, bounded — the one scan
 *  site every org-wide duty path reads through (`orgWideCatalog`,
 *  `dutiesForSeat`), so there's a single truncation-warning log instead of
 *  one per caller. `context` names the caller for that warning, matching the
 *  `[seats]`/`[finances]`-prefixed convention used elsewhere. */
async function scanAllResponsibilities(
  ctx: QueryCtx,
  context: string,
): Promise<Doc<"responsibilities">[]> {
  const rows = await ctx.db
    .query("responsibilities")
    .take(MAX_CROSS_CHAPTER_DUTY_SCAN);
  if (rows.length === MAX_CROSS_CHAPTER_DUTY_SCAN) {
    console.warn(
      `[responsibilities] ${context} hit MAX_CROSS_CHAPTER_DUTY_SCAN (${MAX_CROSS_CHAPTER_DUTY_SCAN}) rows; cross-chapter seat-mapped duties may be truncated until paginated enumeration lands.`,
    );
  }
  return rows;
}

/**
 * The responsibilities catalog relevant to `chapterId`: every row AUTHORED
 * there (role/person/seat-mapped alike — the chapter's own business) UNION
 * every SEAT-MAPPED row authored in ANY OTHER chapter.
 *
 * Owner decision (2026-07-17, verbatim): "the expectation for Chapter
 * Director at one place is gonna be the same for the expectation somewhere
 * else. If they need a fork in the road somewhere we'll deal with that
 * later." So once a duty is mapped to a seat — chapter-chart OR central,
 * no chart-type distinction — it is an ORG-WIDE expectation for every
 * holder of that seat def, not scoped to whichever chapter happened to
 * author it: the row's `chapterId` is authorship/home metadata for a
 * seat-mapped duty, NOT an applicability filter. (Letting two chapters
 * diverge on the same seat's expectations — "a fork in the road" — is
 * explicitly deferred; there is no mechanism for it today.) PERSON/ROLE
 * assignments (`assigneeSeatIds` unset) are UNCHANGED — they keep their
 * existing chapter-local semantics; they were never meant to travel.
 *
 * This is the single source every duty-catalog consumer reads through —
 * `list`, `dutiesForSeat` (which needs the org-wide half only, not the
 * per-chapter union — see its own scan), and `org.ts`'s `deriveTier` all
 * resolve through this or `scanAllResponsibilities`, so the rule lives in
 * exactly one place.
 */
export async function orgWideCatalog(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
  context: string,
): Promise<Doc<"responsibilities">[]> {
  const own = await ctx.db
    .query("responsibilities")
    .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
    .collect();
  const all = await scanAllResponsibilities(ctx, context);
  const foreignSeatMapped = all.filter(
    (r) => r.chapterId !== chapterId && (r.assigneeSeatIds?.length ?? 0) > 0,
  );
  return [...own, ...foreignSeatMapped];
}

/**
 * The chapter's responsibility CATALOG, oldest first, each with a summary of
 * its How-To doc (kind/title/url) joined in so list surfaces can render the
 * affordance without a doc query per row. Per `orgWideCatalog`, this is no
 * longer just the rows this chapter authored: a seat-mapped duty authored by
 * ANY chapter is part of every chapter's catalog too (one role, same
 * expectations everywhere), so a chapter-B caller sees a chapter-A-authored
 * "Chapter Director" duty right alongside chapter B's own. The How-To doc
 * join is scoped to each ROW's OWN home chapter (`doc.chapterId === r.chapterId`),
 * not the caller's — a foreign row's doc lives in ITS authoring chapter. Each
 * row also carries `authoredByChapterName`: `null` when the CALLER'S OWN
 * chapter authored it (editable everywhere the server allows), or the
 * authoring chapter's name when it's a foreign org-wide row — the Duties grid
 * (`DutiesGrid.tsx`) uses this to render foreign rows READ-ONLY (no inline
 * editors would work anyway: `update`/`addSeat`/`removeSeat`/`remove` all
 * gate on `requireOwned`, authoring-chapter-only) with a "Defined by
 * {chapter}" provenance label, without a separate query to figure out which
 * rows are "mine".
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
    const rows = await orgWideCatalog(
      ctx,
      chapterId as Id<"chapters">,
      "responsibilities.list",
    );

    // Resolve each FOREIGN row's authoring chapter NAME once per distinct
    // chapter (not once per row) — the Duties grid's read-only provenance
    // label ("Defined by {chapter}") for an org-wide duty this chapter
    // didn't author, so the client can render it read-only without a
    // separate query/context to figure out "is this mine". `null` on
    // `authoredByChapterName` below means the CALLER'S own chapter authored
    // it (the common case, and the only case pre-org-wide-catalog).
    const foreignChapterIds = Array.from(
      new Set(rows.filter((r) => r.chapterId !== chapterId).map((r) => r.chapterId)),
    );
    const foreignChapters = await Promise.all(
      foreignChapterIds.map((id) => ctx.db.get(id)),
    );
    const chapterNameById = new Map(
      foreignChapters
        .filter((c): c is NonNullable<typeof c> => c !== null)
        .map((c) => [c._id, c.name]),
    );

    return await Promise.all(
      rows.map(async (r) => {
        const authoredByChapterName: string | null =
          r.chapterId === chapterId
            ? null
            : (chapterNameById.get(r.chapterId) ?? "another chapter");
        if (!r.howToDocId) {
          return { ...r, howToDoc: null, authoredByChapterName };
        }
        const doc = await ctx.db.get(r.howToDocId);
        return {
          ...r,
          authoredByChapterName,
          howToDoc:
            doc && doc.chapterId === r.chapterId
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
 *  any roster member who can see the duty catalog can see the seat list.
 *
 *  DERIVED seats (holders computed/rolled-up, never assigned — e.g. the
 *  central chart's `chapter_directors` mirror of every chapter's real
 *  `chapter_director`) are excluded: they can never carry a duty of their
 *  own, so offering one here would let an owner map "the same duty" onto two
 *  separate targets (the mirror AND the real seat) for what is ONE role with
 *  identical expectations across every chapter. See `requireSeatDefs` for the
 *  mutation-side guard and the `0024_repoint_derived_seat_duties` migration
 *  for the historical cleanup. */
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
      .filter((d) => d.derived !== true)
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

/**
 * The duties attached to one seat (`assigneeSeatIds` contains it).
 *
 * Per `orgWideCatalog`'s owner-decision doc: a seat-mapped duty is an
 * ORG-WIDE expectation for every holder of that seat def, so this reaches
 * across EVERY chapter's duty catalog regardless of whether `seatDefId`
 * names a CENTRAL-chart seat (occupancy already chapter-independent — the
 * same seat, "central" scope, held by the same people regardless of which
 * chapter's roster they're homed in) or a CHAPTER-chart seat (occupancy is
 * per-chapter, but the DUTY mapped to it is no longer scoped to whichever
 * chapter happened to author it). There's no chart-type branch here anymore
 * — a chapter-A-authored duty mapped to a chapter-chart seat reaches that
 * seat's panel browsed from chapter B exactly like a central-seat duty
 * always did. Gated the same as every other seat/duty read — org-transparent
 * to any signed-in roster member, not just the authoring chapter's.
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
    // A derived seat's holders are computed, never assigned, so it can never
    // carry a duty of its own (see `seatOptions`/`requireSeatDefs`) — return
    // empty here too rather than surfacing stale pre-migration mappings.
    if (seat.derived === true) return [];

    const rows = await scanAllResponsibilities(ctx, "responsibilities.dutiesForSeat");

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
