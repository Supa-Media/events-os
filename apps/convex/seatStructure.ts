/**
 * Org chart STRUCTURE editor — mutations that reshape the tree of seats
 * itself (add/rename/update/reparent/remove a seat), plus the audit-log
 * read. Distinct from `seats.ts` (occupancy: who sits in a seat).
 *
 * Gated by the `org.editChart` POWER, not a role name: the caller must hold
 * a seat whose def's capabilities include `"org.editChart"` (today only
 * `executive_director`), or be a superuser (backstop). See
 * `lib/seatStructure.ts`'s `requireChartEditor`.
 *
 * Because `seatDefs` rows are SHARED by every chapter (the central chart is
 * defined once; the chapter chart is defined once and stamped identically
 * onto every chapter — see `schema/seats.ts`), every mutation here edits the
 * shared def row directly. A chapter-chart edit is therefore visible to
 * every chapter's `seats.chart` read AUTOMATICALLY, with no per-chapter fan
 * out and nothing to keep in sync — there's exactly one row to patch.
 *
 * SELF-LOCKOUT GUARD (`assertNoSelfLockout`, `lib/seatStructure.ts`): no
 * edit here may reduce the calling editor's OWN effective capability set.
 * Every mutation that could plausibly change what a seat grants (updateSeat,
 * reparentSeat, removeSeat) simulates the edit and re-derives the caller's
 * own capabilities against the SIMULATED state before committing anything.
 * `renameSeat` skips the simulation — a title never changes what a seat
 * grants, so there's nothing to simulate. `addSeat` only ever ADDS a new,
 * unassigned seat, so it can't reduce anyone's capabilities either.
 *
 * `legacyTitle` (the bridge to `specializedRoles.title`, see `schema/
 * seats.ts`) is NOT editable here on purpose — no mutation below accepts it
 * as an argument, and Convex's exact-shape arg validation rejects any extra
 * key a caller tries to smuggle in alongside the declared ones.
 */
import { mutation, query } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import {
  SEAT_CHARTS,
  SEAT_CAPABILITIES,
  SEAT_ROOT,
  MULTI_HOLDER_CAP,
} from "@events-os/shared";
import {
  requireChartEditor,
  assertNoSelfLockout,
  type ChartEditor,
  type DefOverride,
} from "./lib/seatStructure";
import { ROLLUP_SCAN_LIMIT } from "./finances";

const seatChartValidator = v.union(...SEAT_CHARTS.map((c) => v.literal(c)));
const seatCapabilityValidator = v.union(
  ...SEAT_CAPABILITIES.map((c) => v.literal(c)),
);
const mutationKindValidator = v.union(
  v.literal("addSeat"),
  v.literal("renameSeat"),
  v.literal("updateSeat"),
  v.literal("reparentSeat"),
  v.literal("removeSeat"),
);

/** Bound on how many defs a single chart scan reads — well above the
 *  template's largest chart (18 rows), room for runtime-added seats. Mirrors
 *  `seats.ts`'s own `MAX_CHART_SEATS`. */
const MAX_CHART_SEATS = 300;

/**
 * Fail-closed bound for SAFETY scans — the occupied-seat check, the
 * maxHolders floor, the duty-reference check, and the global-lockout scan
 * all need an EXHAUSTIVE answer ("does ANY row reference this def, anywhere,
 * full stop") to be correct. A truncated scan there isn't a slightly-stale
 * read, it's UNVERIFIABLE: hitting this bound means the true answer could be
 * either way, so `assertScanCompleteOrThrow` below REJECTS the mutation
 * rather than silently proceeding on partial data. This is the opposite of
 * `ROLLUP_SCAN_LIMIT`-bounded DISPLAY reads elsewhere in this app (e.g.
 * `seats.ts`'s chapter/holder rollups), which warn-and-truncate because a
 * stale READ is an acceptable UX cost — these are WRITE-gating safety
 * invariants on a real-money-adjacent permission, where a false "clear" can
 * delete an occupied seat or under-count holders.
 *
 * `let`, not `const`, ONLY so `tests/seatStructure.test.ts` can shrink it to
 * something practically hittable without inserting thousands of rows — see
 * `__setSafetyScanLimitForTests`/`__resetSafetyScanLimitForTests`. Never
 * reassigned from production code.
 */
let SAFETY_SCAN_LIMIT: number = ROLLUP_SCAN_LIMIT;

/** TEST-ONLY seam for `SAFETY_SCAN_LIMIT` (see above) — lets a test actually
 *  drive a safety scan past its bound without a multi-thousand-row fixture.
 *  Never called from production code; only imported by
 *  `tests/seatStructure.test.ts`. */
export function __setSafetyScanLimitForTests(limit: number): void {
  SAFETY_SCAN_LIMIT = limit;
}

/** Restores `SAFETY_SCAN_LIMIT` to its production value. Call in `afterEach`
 *  whenever a test calls `__setSafetyScanLimitForTests`. */
export function __resetSafetyScanLimitForTests(): void {
  SAFETY_SCAN_LIMIT = ROLLUP_SCAN_LIMIT;
}

/** Throws if a SAFETY scan (see `SAFETY_SCAN_LIMIT` above) came back exactly
 *  at the bound — meaning it may have been truncated, so the caller's "no
 *  match found" (or "count is N") can't be trusted. `context` names the
 *  check for the error message. */
function assertScanCompleteOrThrow(rowCount: number, context: string): void {
  if (rowCount === SAFETY_SCAN_LIMIT) {
    throw new ConvexError({
      code: "SCAN_LIMIT_EXCEEDED",
      message: `Too many records to verify this safely (${context}) — contact an admin.`,
    });
  }
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/** A seat def by slug, globally (not chart-scoped) — slugs are unique across
 *  both charts (seeded `SEAT_IDS` + `generateUniqueSlug` below both enforce
 *  this). `null` if not found. */
async function defBySlug(
  ctx: QueryCtx | MutationCtx,
  slug: string,
): Promise<Doc<"seatDefs"> | null> {
  return await ctx.db
    .query("seatDefs")
    .withIndex("by_slug", (q) => q.eq("slug", slug))
    .first();
}

/** `defBySlug`, throwing NOT_FOUND instead of returning null. */
async function requireDefBySlug(
  ctx: QueryCtx | MutationCtx,
  slug: string,
): Promise<Doc<"seatDefs">> {
  const def = await defBySlug(ctx, slug);
  if (!def) {
    throw new ConvexError({ code: "NOT_FOUND", message: `No seat with slug "${slug}".` });
  }
  return def;
}

/** Every def in `chart`, keyed by slug — used for cycle detection and
 *  child-lookup, which both need to walk the WHOLE chart's shape. */
async function chartDefsBySlug(
  ctx: QueryCtx | MutationCtx,
  chart: Doc<"seatDefs">["chart"],
): Promise<Map<string, Doc<"seatDefs">>> {
  const rows = await ctx.db
    .query("seatDefs")
    .withIndex("by_chart", (q) => q.eq("chart", chart))
    .take(MAX_CHART_SEATS);
  return new Map(rows.map((d) => [d.slug, d]));
}

/** True iff reparenting `movingSlug` under `newParentSlug` would introduce a
 *  cycle (including the trivial self-parent case) — walks `newParentSlug`'s
 *  ancestor chain up to `SEAT_ROOT`, same shape as `@events-os/shared`'s
 *  `seatAncestors`, but against the LIVE (DB-editable) chart shape rather
 *  than the static `SEAT_DEFS` template. */
function wouldCreateCycle(
  bySlug: Map<string, Doc<"seatDefs">>,
  movingSlug: string,
  newParentSlug: string,
): boolean {
  if (newParentSlug === movingSlug) return true;
  let current = newParentSlug;
  const seen = new Set<string>();
  while (current !== SEAT_ROOT) {
    if (current === movingSlug) return true;
    if (seen.has(current)) return true; // pre-existing cycle safety net
    seen.add(current);
    const def = bySlug.get(current);
    if (!def) break; // dangling parent — nothing further to walk
    current = def.parentSlug;
  }
  return false;
}

/** Bounded, FAIL-CLOSED scan over EVERY `seatAssignments` row (no index keys
 *  on `seatDefId` alone — see `schema/seats.ts`'s indexes), used by the
 *  occupied-seat removal guard, the maxHolders floor, and the global-lockout
 *  check below. All three need "every holder of this def, across every
 *  scope", which the schema can only answer with a full scan — see
 *  `SAFETY_SCAN_LIMIT` for why hitting the bound throws instead of warning. */
async function allAssignmentsForDef(
  ctx: QueryCtx | MutationCtx,
  seatDefId: Id<"seatDefs">,
  context: string,
): Promise<Doc<"seatAssignments">[]> {
  const rows = await ctx.db.query("seatAssignments").take(SAFETY_SCAN_LIMIT);
  assertScanCompleteOrThrow(rows.length, context);
  return rows.filter((r) => r.seatDefId === seatDefId);
}

/** True iff `seatDefId` has ANY current holder, in ANY scope. */
async function seatHasAnyAssignment(
  ctx: QueryCtx | MutationCtx,
  seatDefId: Id<"seatDefs">,
): Promise<boolean> {
  return (await allAssignmentsForDef(ctx, seatDefId, "occupied-seat check")).length > 0;
}

/** The largest per-scope holder count `seatDefId` has anywhere — the floor a
 *  new `maxHolders` value can't drop below. */
async function maxHolderCountAnyScope(
  ctx: QueryCtx | MutationCtx,
  seatDefId: Id<"seatDefs">,
): Promise<number> {
  const rows = await allAssignmentsForDef(ctx, seatDefId, "maxHolders floor check");
  const counts = new Map<string, number>();
  for (const r of rows) {
    const key = String(r.scope);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts.size === 0 ? 0 : Math.max(...counts.values());
}

/** True iff any `responsibilities` row still maps a duty to `seatDefId` via
 *  `assigneeSeatIds` (added by #188, "duties attach to seats"). There's no
 *  index into that array field (Convex indexes can't key on array contents),
 *  so this is a bounded, FAIL-CLOSED full-table scan — same
 *  `SAFETY_SCAN_LIMIT` rule as `allAssignmentsForDef` above: a truncated scan
 *  can't be trusted to say "no references", so it throws instead. */
async function seatHasDutyReferences(
  ctx: QueryCtx | MutationCtx,
  seatDefId: Id<"seatDefs">,
): Promise<boolean> {
  const rows = await ctx.db.query("responsibilities").take(SAFETY_SCAN_LIMIT);
  assertScanCompleteOrThrow(rows.length, "duty-reference check");
  return rows.some((r) => r.assigneeSeatIds?.includes(seatDefId) === true);
}

/** Every OTHER seat def (any chart) that currently carries `org.editChart`,
 *  excluding `excludeDefId` — the candidate pool for the global-lockout
 *  check below. Bounded/fail-closed like the scans above: org charts are a
 *  few dozen seats, nowhere near `SAFETY_SCAN_LIMIT`, but the same rule
 *  applies for consistency and future-proofing. */
async function otherEditChartDefs(
  ctx: QueryCtx | MutationCtx,
  excludeDefId: Id<"seatDefs">,
): Promise<Doc<"seatDefs">[]> {
  const rows = await ctx.db.query("seatDefs").take(SAFETY_SCAN_LIMIT);
  assertScanCompleteOrThrow(rows.length, "global org.editChart lockout check");
  return rows.filter(
    (d) => d._id !== excludeDefId && d.capabilities.includes("org.editChart"),
  );
}

/** True iff at least one of `defs` currently has any holder, anywhere. */
async function anyDefHasAHolder(
  ctx: QueryCtx | MutationCtx,
  defs: Doc<"seatDefs">[],
): Promise<boolean> {
  for (const d of defs) {
    if (await seatHasAnyAssignment(ctx, d._id)) return true;
  }
  return false;
}

/** Bound on how many duties an audit snapshot keeps IN FULL, and how many
 *  characters of each — the log stores a preview, not the whole list, so a
 *  seat with a long duties array can't blow up `seatStructureLog` row size
 *  (see finding 5 on PR #190). */
const AUDIT_DUTIES_PREVIEW_COUNT = 5;
const AUDIT_DUTY_CHARS = 80;

/** A small, bounded stand-in for a `duties` array in an audit snapshot: a
 *  total count (so nothing about "how many" is lost) plus a short preview of
 *  the first few, each truncated. Never the full array. */
function summarizeDuties(duties: readonly string[]): { count: number; preview: string[] } {
  return {
    count: duties.length,
    preview: duties
      .slice(0, AUDIT_DUTIES_PREVIEW_COUNT)
      .map((d) => (d.length > AUDIT_DUTY_CHARS ? `${d.slice(0, AUDIT_DUTY_CHARS)}…` : d)),
  };
}

/** `title`, lowercased and stripped to `[a-z0-9_]`, falling back to `"seat"`
 *  if that strips it to nothing (e.g. an all-emoji title). */
function slugify(title: string): string {
  const base = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return base || "seat";
}

/** A slug guaranteed unique across BOTH charts (slugs are global — see
 *  `defBySlug`), derived from `title` with a numeric suffix on collision. */
async function generateUniqueSlug(
  ctx: MutationCtx,
  title: string,
): Promise<string> {
  const base = slugify(title);
  let candidate = base;
  let suffix = 2;
  while (await defBySlug(ctx, candidate)) {
    candidate = `${base}_${suffix}`;
    suffix++;
  }
  return candidate;
}

/** Insert one `seatStructureLog` row. `before`/`after` are small, mutation-
 *  specific snapshots — never the full def. */
async function writeAuditLog(
  ctx: MutationCtx,
  editor: ChartEditor,
  mutationKind: Doc<"seatStructureLog">["mutation"],
  slug: string,
  before: unknown,
  after: unknown,
): Promise<void> {
  await ctx.db.insert("seatStructureLog", {
    editorUserId: editor.userId,
    editorPersonId: editor.editorPersonId,
    mutation: mutationKind,
    slug,
    before,
    after,
    createdAt: Date.now(),
  });
}

/** Validate a `maxHolders` value's shape (integer, `1..MULTI_HOLDER_CAP`). */
function assertValidMaxHolders(maxHolders: number): void {
  if (!Number.isInteger(maxHolders) || maxHolders < 1 || maxHolders > MULTI_HOLDER_CAP) {
    throw new ConvexError({
      code: "INVALID_MAX_HOLDERS",
      message: `maxHolders must be a whole number between 1 and ${MULTI_HOLDER_CAP}.`,
    });
  }
}

// ── Mutations ────────────────────────────────────────────────────────────────

/**
 * Add a new seat to a chart, under an EXISTING parent seat (never as a
 * second root — see `SECOND_ROOT` below). Generates a unique slug from
 * `title` and appends it to the chart's `sortOrder`. Never `derived`, never
 * carries a `legacyTitle` (not accepted as an argument).
 *
 * Can never reduce anyone's capabilities (it only ever ADDS an unassigned
 * seat), so it skips the self-lockout simulation.
 */
export const addSeat = mutation({
  args: {
    chart: seatChartValidator,
    parentSlug: v.string(),
    title: v.string(),
    maxHolders: v.number(),
    duties: v.array(v.string()),
    capabilities: v.array(seatCapabilityValidator),
  },
  returns: v.id("seatDefs"),
  handler: async (ctx, args) => {
    const editor = await requireChartEditor(ctx);

    const title = args.title.trim();
    if (!title) {
      throw new ConvexError({ code: "INVALID_TITLE", message: "Title can't be empty." });
    }
    assertValidMaxHolders(args.maxHolders);

    if (args.parentSlug === SEAT_ROOT) {
      throw new ConvexError({
        code: "SECOND_ROOT",
        message: "Each chart already has a root seat — pick an existing seat as the parent.",
      });
    }
    const parentDef = await requireDefBySlug(ctx, args.parentSlug);
    if (parentDef.chart !== args.chart) {
      throw new ConvexError({
        code: "CROSS_CHART_PARENT",
        message: "A seat's parent must be in the same chart.",
      });
    }

    const slug = await generateUniqueSlug(ctx, title);
    const chartDefs = await chartDefsBySlug(ctx, args.chart);
    const sortOrder =
      Math.max(-1, ...[...chartDefs.values()].map((d) => d.sortOrder)) + 1;

    const now = Date.now();
    const seatDefId = await ctx.db.insert("seatDefs", {
      slug,
      title,
      chart: args.chart,
      parentSlug: args.parentSlug,
      maxHolders: args.maxHolders,
      duties: args.duties,
      capabilities: args.capabilities,
      sortOrder,
      derived: false,
      createdAt: now,
      updatedAt: now,
    });

    await writeAuditLog(ctx, editor, "addSeat", slug, undefined, {
      title,
      chart: args.chart,
      parentSlug: args.parentSlug,
      maxHolders: args.maxHolders,
      duties: summarizeDuties(args.duties),
      capabilities: args.capabilities,
    });

    return seatDefId;
  },
});

/**
 * Rename a seat — including the ED seat itself (owner-approved: renaming
 * never changes what a seat GRANTS, only its display title, so it's always
 * safe for the editor to do to their own seat). No self-lockout simulation:
 * a title change can never move a capability.
 */
export const renameSeat = mutation({
  args: { slug: v.string(), title: v.string() },
  returns: v.null(),
  handler: async (ctx, { slug, title }) => {
    const editor = await requireChartEditor(ctx);
    const def = await requireDefBySlug(ctx, slug);

    const trimmed = title.trim();
    if (!trimmed) {
      throw new ConvexError({ code: "INVALID_TITLE", message: "Title can't be empty." });
    }
    if (trimmed === def.title) return null; // no-op, nothing to log

    await ctx.db.patch(def._id, { title: trimmed, updatedAt: Date.now() });
    await writeAuditLog(
      ctx,
      editor,
      "renameSeat",
      def.slug,
      { title: def.title },
      { title: trimmed },
    );
    return null;
  },
});

/**
 * Update a seat's `maxHolders`/`duties`/`capabilities` (any subset — omitted
 * fields are left untouched). Rejects a `derived` seat (its holders — and
 * hence its effective `maxHolders`/floor — are computed, not editable;
 * mirrors `reparentSeat`/`removeSeat`'s guard). Enforces the `maxHolders`
 * floor (can't drop below the seat's current largest per-scope holder
 * count), the GLOBAL org.editChart lockout guard (below), and runs the
 * self-lockout simulation before committing (a capabilities change is
 * exactly the case that guard exists for).
 */
export const updateSeat = mutation({
  args: {
    slug: v.string(),
    maxHolders: v.optional(v.number()),
    duties: v.optional(v.array(v.string())),
    capabilities: v.optional(v.array(seatCapabilityValidator)),
  },
  returns: v.null(),
  handler: async (ctx, { slug, maxHolders, duties, capabilities }) => {
    const editor = await requireChartEditor(ctx);
    const def = await requireDefBySlug(ctx, slug);

    if (def.derived === true) {
      throw new ConvexError({
        code: "DERIVED_SEAT",
        message:
          "This seat's holders are computed automatically — its duties/capabilities/maxHolders can't be edited.",
      });
    }

    const patch: Partial<Pick<Doc<"seatDefs">, "maxHolders" | "duties" | "capabilities">> = {};
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};

    if (maxHolders !== undefined) {
      assertValidMaxHolders(maxHolders);
      const currentMax = await maxHolderCountAnyScope(ctx, def._id);
      if (maxHolders < currentMax) {
        throw new ConvexError({
          code: "MAX_HOLDERS_BELOW_CURRENT",
          message: `This seat has ${currentMax} holder(s) in at least one scope — vacate down to ${maxHolders} first.`,
        });
      }
      patch.maxHolders = maxHolders;
      before.maxHolders = def.maxHolders;
      after.maxHolders = maxHolders;
    }
    if (duties !== undefined) {
      patch.duties = duties;
      before.duties = summarizeDuties(def.duties);
      after.duties = summarizeDuties(duties);
    }
    if (capabilities !== undefined) {
      // GLOBAL org.editChart LOCKOUT GUARD — distinct from (and checked
      // before) the self-lockout simulation below: self-lockout protects
      // only the CALLER's own powers; this protects the ORG's, when the
      // caller doesn't hold the seat being stripped but it's the last one
      // carrying org.editChart with any active holder anywhere. A
      // superuser may still do this knowingly (they're the backstop for
      // exactly this state) — loudly logged, never silent.
      const losingEditChart =
        def.capabilities.includes("org.editChart") && !capabilities.includes("org.editChart");
      if (losingEditChart) {
        const others = await otherEditChartDefs(ctx, def._id);
        const someoneElseStillHolds = await anyDefHasAHolder(ctx, others);
        if (!someoneElseStillHolds) {
          if (editor.isSuperuser) {
            console.warn(
              `[seatStructure] updateSeat(${def.slug}) by superuser ${editor.userId} removes the LAST seat carrying org.editChart with any active holder — no one will be able to edit the org chart's structure until a superuser restores it.`,
            );
          } else {
            throw new ConvexError({
              code: "GLOBAL_EDITCHART_LOCKOUT",
              message:
                "This would remove org-chart editing power from EVERYONE — no seat would carry org.editChart with an active holder anymore. Only a superuser can make this change.",
            });
          }
        }
      }
      patch.capabilities = capabilities;
      before.capabilities = def.capabilities;
      after.capabilities = capabilities;
    }

    if (Object.keys(patch).length === 0) return null; // no-op, nothing to log

    const overrides = new Map<Id<"seatDefs">, DefOverride>([[def._id, { ...def, ...patch }]]);
    await assertNoSelfLockout(ctx, editor, overrides);

    await ctx.db.patch(def._id, { ...patch, updatedAt: Date.now() });
    await writeAuditLog(ctx, editor, "updateSeat", def.slug, before, after);
    return null;
  },
});

/**
 * Move a seat to a new parent, within the SAME chart. Rejects: a `derived`
 * seat, moving a chart's root, moving TO become a second root, a self-parent,
 * a cross-chart parent, or any move that would introduce a cycle. Runs the
 * self-lockout simulation (a no-op in practice today, since capabilities
 * live on the seat itself and aren't inherited from position — but kept
 * uniform with `updateSeat`/`removeSeat` as a defense-in-depth guard against
 * that ever changing silently).
 */
export const reparentSeat = mutation({
  args: { slug: v.string(), newParentSlug: v.string() },
  returns: v.null(),
  handler: async (ctx, { slug, newParentSlug }) => {
    const editor = await requireChartEditor(ctx);
    const def = await requireDefBySlug(ctx, slug);

    if (def.derived === true) {
      throw new ConvexError({
        code: "DERIVED_SEAT",
        message: "This seat's holders are computed automatically — its position can't be edited.",
      });
    }
    if (def.parentSlug === SEAT_ROOT) {
      throw new ConvexError({
        code: "CANNOT_REPARENT_ROOT",
        message: "This chart's root seat can't be reparented.",
      });
    }
    if (newParentSlug === SEAT_ROOT) {
      throw new ConvexError({
        code: "SECOND_ROOT",
        message: "Each chart already has a root seat — pick an existing seat as the new parent.",
      });
    }

    const newParentDef = await requireDefBySlug(ctx, newParentSlug);
    if (newParentDef.chart !== def.chart) {
      throw new ConvexError({
        code: "CROSS_CHART_PARENT",
        message: "A seat's parent must be in the same chart.",
      });
    }

    const bySlug = await chartDefsBySlug(ctx, def.chart);
    if (wouldCreateCycle(bySlug, def.slug, newParentSlug)) {
      throw new ConvexError({
        code: "CYCLE",
        message: "This move would create a cycle in the org chart.",
      });
    }

    const overrides = new Map<Id<"seatDefs">, DefOverride>([
      [def._id, { ...def, parentSlug: newParentSlug }],
    ]);
    await assertNoSelfLockout(ctx, editor, overrides);

    await ctx.db.patch(def._id, { parentSlug: newParentSlug, updatedAt: Date.now() });
    await writeAuditLog(
      ctx,
      editor,
      "reparentSeat",
      def.slug,
      { parentSlug: def.parentSlug },
      { parentSlug: newParentSlug },
    );
    return null;
  },
});

/**
 * Remove a seat. Rejects: a `derived` seat, a chart's root, a seat with ANY
 * current holder in ANY scope (vacate first via `seats.unassignSeat`), a
 * seat that still has a duty mapped to it (unmap it in the Duties grid
 * first — see `seatHasDutyReferences`), or a seat that's still someone
 * else's parent (reparent/remove children first — removing it would
 * otherwise dangle their `parentSlug`, breaking the chart's tree shape).
 *
 * Self-lockout is checked BEFORE the occupied-seat check, so removing a seat
 * the EDITOR THEMSELVES holds surfaces the specific "you'd lock yourself
 * out" message rather than the generic "still occupied" one.
 */
export const removeSeat = mutation({
  args: { slug: v.string() },
  returns: v.null(),
  handler: async (ctx, { slug }) => {
    const editor = await requireChartEditor(ctx);
    const def = await requireDefBySlug(ctx, slug);

    if (def.derived === true) {
      throw new ConvexError({
        code: "DERIVED_SEAT",
        message: "This seat's holders are computed automatically — it can't be removed.",
      });
    }
    if (def.parentSlug === SEAT_ROOT) {
      throw new ConvexError({
        code: "CANNOT_REMOVE_ROOT",
        message: "This chart's root seat can't be removed.",
      });
    }

    const overrides = new Map<Id<"seatDefs">, DefOverride>([[def._id, null]]);
    await assertNoSelfLockout(ctx, editor, overrides);

    if (await seatHasAnyAssignment(ctx, def._id)) {
      throw new ConvexError({
        code: "SEAT_OCCUPIED",
        message: "This seat still has a holder — vacate it first (in every scope) before removing it.",
      });
    }

    if (await seatHasDutyReferences(ctx, def._id)) {
      throw new ConvexError({
        code: "SEAT_HAS_DUTIES",
        message:
          "This seat still has duties mapped to it — unmap them (Duties grid) before removing it.",
      });
    }

    const bySlug = await chartDefsBySlug(ctx, def.chart);
    const hasChildren = [...bySlug.values()].some((d) => d.parentSlug === def.slug);
    if (hasChildren) {
      throw new ConvexError({
        code: "SEAT_HAS_CHILDREN",
        message: "This seat has other seats reporting to it — reparent or remove them first.",
      });
    }

    await ctx.db.delete(def._id);
    await writeAuditLog(
      ctx,
      editor,
      "removeSeat",
      def.slug,
      {
        title: def.title,
        chart: def.chart,
        parentSlug: def.parentSlug,
        maxHolders: def.maxHolders,
        duties: summarizeDuties(def.duties),
        capabilities: def.capabilities,
      },
      undefined,
    );
    return null;
  },
});

// ── Queries ──────────────────────────────────────────────────────────────────

/** The most recent structure-editing audit log rows, newest first. Gated the
 *  same as every write above — reading the log requires edit power too. */
export const structureLog = query({
  args: { limit: v.optional(v.number()) },
  returns: v.array(
    v.object({
      logId: v.id("seatStructureLog"),
      editorUserId: v.id("users"),
      editorPersonId: v.union(v.id("people"), v.null()),
      mutation: mutationKindValidator,
      slug: v.string(),
      before: v.optional(v.any()),
      after: v.optional(v.any()),
      createdAt: v.number(),
    }),
  ),
  handler: async (ctx, { limit }) => {
    await requireChartEditor(ctx);
    const bound = Math.min(Math.max(limit ?? 50, 1), 500);
    const rows = await ctx.db
      .query("seatStructureLog")
      .withIndex("by_createdAt")
      .order("desc")
      .take(bound);
    return rows.map((r) => ({
      logId: r._id,
      editorUserId: r.editorUserId,
      editorPersonId: r.editorPersonId ?? null,
      mutation: r.mutation,
      slug: r.slug,
      before: r.before,
      after: r.after,
      createdAt: r.createdAt,
    }));
  },
});
