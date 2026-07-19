import { query } from "../_generated/server";
import { ConvexError, v } from "convex/values";
import { Doc, Id } from "../_generated/dataModel";
import { requireAccess, requireUserId } from "../lib/context";
import { SPECIALIZED_ROLE_TITLES, type SpecializedRoleTitle } from "@events-os/shared";
import { seatChartValidator, chartHolderValidator } from "./validators";
import { boundedChapters } from "./internal";

/**
 * The caller's own seat assignments, across every roster (`people`) row tied
 * to their user — mirrors `financeRoles.mySeats`' user→people walk, skipping
 * placeholder rows. Unlike `mySeats` (which resolves the strongest role PER
 * scope), this returns every individual assignment row: a person can hold
 * several distinct seats at once (e.g. `treasurer` and `event_organizers`).
 */
export const mySeatAssignments = query({
  args: {},
  returns: v.array(
    v.object({
      assignmentId: v.id("seatAssignments"),
      seatDefId: v.id("seatDefs"),
      slug: v.string(),
      title: v.string(),
      chart: seatChartValidator,
      scope: v.union(v.id("chapters"), v.literal("central")),
      scopeName: v.string(),
      createdAt: v.number(),
    }),
  ),
  handler: async (ctx) => {
    // Aligns with `chart`/`seatDetail`: every read here is gated ONLY by
    // `requireAccess` (org-transparent), never a bare `requireUserId` — a
    // signed-in-but-unapproved caller (Convex auth has no framework-level
    // domain restriction; see `lib/access.ts`) must not slip through.
    await requireAccess(ctx);
    const userId = (await requireUserId(ctx)) as Id<"users">;
    const peopleRows = await ctx.db
      .query("people")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const realPeople = peopleRows.filter((p) => p.isPlaceholder !== true);

    const assignments = (
      await Promise.all(
        realPeople.map((p) =>
          ctx.db
            .query("seatAssignments")
            .withIndex("by_person", (q) => q.eq("personId", p._id))
            .collect(),
        ),
      )
    ).flat();

    const results = [];
    for (const a of assignments) {
      const def = await ctx.db.get(a.seatDefId);
      if (!def) continue; // stale assignment on a deleted def

      let scopeName: string;
      if (a.scope === "central") {
        scopeName = "Central";
      } else {
        const chapter = await ctx.db.get(a.scope);
        if (!chapter) continue; // stale assignment on a deleted chapter
        scopeName = chapter.name;
      }

      results.push({
        assignmentId: a._id,
        seatDefId: def._id,
        slug: def.slug,
        title: def.title,
        chart: def.chart,
        scope: a.scope,
        scopeName,
        createdAt: a.createdAt,
      });
    }
    results.sort((a, b) => a.createdAt - b.createdAt);
    return results;
  },
});

const specializedTitleValidator = v.union(
  ...SPECIALIZED_ROLE_TITLES.map((t) => v.literal(t)),
);

/**
 * The distinct desk SCOPES (WP-S switcher fix) the caller holds ANY org-chart
 * seat assignment in — one entry for `"central"` and/or one per chapter,
 * deduped from `mySeatAssignments`' per-assignment rows (a person can hold
 * several seats in the same scope, e.g. `chapter_director` + `event_lead`;
 * this collapses those into one desk entry). `title` is the assignment's
 * seat's `legacyTitle` where one exists (e.g. `chapter_director` ->
 * `"president"`, displayed as "Chapter Director" — see
 * `specializedRoleLabel`), read straight off `SEAT_DEFS` rather than the
 * `specializedRoles` table, so it's correct even if that table's write-through
 * mirror is stale. When a scope has several seats, whichever assignment is
 * read LAST wins the title shown — seat order isn't meaningful here, this is
 * display enrichment only.
 *
 * THIS IS DESK MEMBERSHIP ONLY — it says nothing about finance CAPABILITY. A
 * seat like `chapter_director` carries `nav.finances` (shows the Finances
 * tab) and `finance.approve`, but NOT `finance.manager` — holding it alone
 * does not grant a `financeRoles` read/write floor (see `lib/finance.ts`'s
 * `getFinanceRole` — a seat only derives a finance role when it carries the
 * `finance.manager` capability). `ChapterContext` unions this list with
 * `financeRoles.mySeats` (which independently grants a desk to finance-only
 * grant holders with no org-chart seat) purely to decide what counts as a
 * "your seats" desk vs. read-only peek — every finance WRITE/READ gate stays
 * exactly as it is today, keyed off `financeRoles`/seat-derived CAPABILITIES,
 * never this list.
 */
export const myDeskChapters = query({
  args: {},
  returns: v.array(
    v.union(
      v.object({
        scope: v.literal("central"),
        title: v.optional(specializedTitleValidator),
      }),
      v.object({
        scope: v.id("chapters"),
        chapterName: v.string(),
        title: v.optional(specializedTitleValidator),
      }),
    ),
  ),
  handler: async (ctx) => {
    // Mirrors `mySeatAssignments`: org-transparent read, gated only by
    // `requireAccess` (no chapter-/central-scoping beyond that).
    await requireAccess(ctx);
    const userId = (await requireUserId(ctx)) as Id<"users">;
    const peopleRows = await ctx.db
      .query("people")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const realPeople = peopleRows.filter((p) => p.isPlaceholder !== true);

    const assignments = (
      await Promise.all(
        realPeople.map((p) =>
          ctx.db
            .query("seatAssignments")
            .withIndex("by_person", (q) => q.eq("personId", p._id))
            .collect(),
        ),
      )
    ).flat();

    let hasCentral = false;
    let centralTitle: SpecializedRoleTitle | undefined;
    const chapterTitles = new Map<Id<"chapters">, SpecializedRoleTitle | undefined>();
    for (const a of assignments) {
      const def = await ctx.db.get(a.seatDefId);
      if (!def) continue; // stale assignment on a deleted def
      if (a.scope === "central") {
        hasCentral = true;
        if (def.legacyTitle) centralTitle = def.legacyTitle;
      } else {
        if (!chapterTitles.has(a.scope) || def.legacyTitle) {
          chapterTitles.set(
            a.scope,
            def.legacyTitle ?? chapterTitles.get(a.scope),
          );
        }
      }
    }

    const chapters = [];
    for (const [chapterId, title] of chapterTitles) {
      const chapter = await ctx.db.get(chapterId);
      if (!chapter) continue; // stale assignment on a deleted chapter
      chapters.push({
        scope: chapterId,
        chapterName: chapter.name,
        ...(title !== undefined ? { title } : {}),
      });
    }
    chapters.sort((a, b) => a.chapterName.localeCompare(b.chapterName));

    return [
      ...(hasCentral
        ? [
            {
              scope: "central" as const,
              ...(centralTitle !== undefined ? { title: centralTitle } : {}),
            },
          ]
        : []),
      ...chapters,
    ];
  },
});

/** Bound on how many people a single (per-chapter, or central) scan of
 *  `assignablePeople` reads before slicing to the returned cap — generous
 *  headroom over any realistic chapter roster, mirroring `MAX_CHART_SEATS`'s
 *  convention. */
const MAX_PEOPLE_SCAN_PER_CHAPTER = 300;

/** Final cap on how many people `assignablePeople` hands back to the client —
 *  it feeds a picker UI, not an export, so this is capped well below the
 *  per-chapter scan bound above even for a large org. */
const MAX_ASSIGNABLE_PEOPLE = 500;

/**
 * The roster a seat-change picker (propose or direct-assign) may choose from,
 * at a given seat SCOPE — the scope-aware counterpart to `people.list` (which
 * is hardcoded to the CALLER's own chapter, wrong for proposing/assigning into
 * a different chapter or into central). Non-placeholder, non-sample-person
 * only (mirrors `people.list`'s own filter).
 *
 *  - `scope: <chapterId>` → that chapter's roster only.
 *  - `scope: "central"` → EVERY chapter's roster, org-wide — mirrors the
 *    org-transparency precedent `seats.chart`'s full-tree read already
 *    established (a central seat, or a central holder proposing into any
 *    chapter via the rollup bridge, can draw from anyone in the org, not just
 *    the caller's own chapter).
 *
 * Gated by `requireAccess` only (signed-in + allowed) — same as `chart` /
 * `seatDetail` / `mySeatAssignments`: this powers the propose flow, which any
 * signed-in member may use, not just a superuser.
 */
export const assignablePeople = query({
  args: {
    scope: v.union(v.id("chapters"), v.literal("central")),
  },
  returns: v.array(chartHolderValidator),
  handler: async (ctx, { scope }) => {
    await requireAccess(ctx);

    let people: Doc<"people">[];
    if (scope === "central") {
      const chapters = await boundedChapters(ctx, "assignablePeople central scope");
      const perChapter = await Promise.all(
        chapters.map((c) =>
          ctx.db
            .query("people")
            .withIndex("by_chapter", (q) => q.eq("chapterId", c._id))
            .take(MAX_PEOPLE_SCAN_PER_CHAPTER),
        ),
      );
      people = perChapter.flat();
    } else {
      const chapter = await ctx.db.get(scope);
      if (!chapter) {
        throw new ConvexError({
          code: "NOT_FOUND",
          message: "That chapter doesn't exist.",
        });
      }
      people = await ctx.db
        .query("people")
        .withIndex("by_chapter", (q) => q.eq("chapterId", scope))
        .take(MAX_PEOPLE_SCAN_PER_CHAPTER);
    }

    const eligible = people
      .filter((p) => p.isPlaceholder !== true && p.isSamplePerson !== true)
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, MAX_ASSIGNABLE_PEOPLE);

    return await Promise.all(
      eligible.map(async (p) => ({
        personId: p._id,
        name: p.name,
        imageUrl: p.image ? await ctx.storage.getUrl(p.image) : null,
      })),
    );
  },
});
