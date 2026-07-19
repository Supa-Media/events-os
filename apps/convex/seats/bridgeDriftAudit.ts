// ── Bridge drift audit (READ-ONLY) ──────────────────────────────────────────
//
// Post-B10 (PR #195), `lib/finance.ts#getFinanceRole` / `#isCentralEdOrFm`
// UNION seat-derived capabilities with the stored `financeRoles`/
// `specializedRoles` tables directly — the flip already shipped, so a
// today-vs-post-flip SIMULATION (this audit's original design) is
// permanently stale: its "today" replica hard-codes the PRE-flip formulas,
// which no longer describe what the real gates do. Comparing "today" against
// itself would be meaningless, so that comparison is gone entirely — not
// replaced with a live-formula version, because `getSeatDerivedCapabilities`
// is already dogfooded directly inside the real gates (see `lib/finance.ts`'s
// "B10" doc comment); there is no separate "would this change anything"
// question left to ask.
//
// What's left, and what this audit now IS: `assignSeat`'s write-through
// keeps a `seatAssignments` row (on a `legacyTitle`-bearing seat def)
// mirrored onto a `specializedRoles` row at the same (scope, title) — see
// `assignSpecializedRoleImpl` / `removeSpecializedRoleImpl` in
// `specializedRoles.ts`, which `seats.ts`'s assign/unassign mutations call
// through. That mirror can drift out of sync with the seat layer (e.g. a
// migration or direct DB edit bypassing the write-through), and the bridge —
// `specializedRoles` still backs the title-based separation-of-duties checks
// (`APPROVE_SEAT_SLUGS`/`RECORD_SEAT_SLUGS`, `assignSpecializedRoleImpl`'s
// scope-local SoD) — stays live until that table is retired in a later
// milestone. Until then, drift here is a real data-integrity bug, not a
// historical curiosity, so this audit keeps watching for exactly two shapes:
//
//  - a `seatAssignments` row on a `legacyTitle`-bearing def with NO matching
//    `specializedRoles` mirror (the write-through never ran, or ran and was
//    since deleted).
//  - a `specializedRoles` row with NO matching `seatAssignments` row (an
//    orphaned mirror — the seat was unassigned/reassigned but the mirror
//    survived, or the row was hand-inserted with no seat behind it at all).
//
// Both directions are reported, at the (personId, scope) granularity, same
// response shape the audit always had (`mismatches`/`checkedPeople`/
// `status`) — only the CONTENT changed. The finance-role/central-reach/
// accounts-access flip-simulation kinds, and every helper that computed
// them (`todaysRoleAtScope`/`todaysIsCentral`/`todaysAccountsAccessForPerson`/
// `maxRole`/`scopeFromKey`), are gone along with the `financeRoles` table
// read they depended on — this audit no longer touches `financeRoles` or
// `getSeatDerivedCapabilities` at all.
import { query, internalQuery } from "../_generated/server";
import { v } from "convex/values";
import { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { requireSuperuser } from "../lib/superuser";

/** Bound on how many rows each of the two source tables (`seatAssignments`,
 *  `specializedRoles`) is scanned to build the "every person with SOME grant"
 *  universe — generous headroom over `ROLLUP_SCAN_LIMIT`'s 5000 chapter-scan
 *  convention used elsewhere in finance. Hitting a cap sets `status:
 *  "truncated"` (see the query doc) so a truncated audit can never be read as
 *  `"clean"`. */
const AUDIT_TABLE_SCAN_LIMIT = 5000;

/** Bound on how many mismatches a single audit run reports — protects the
 *  response payload from an unbounded blowup if drift is much larger than
 *  expected. `checkedPeople` still counts every person scanned even past this
 *  cap; only the mismatch LIST is capped. Hitting it forces `status:
 *  "truncated"` too. */
const AUDIT_MISMATCH_CAP = 2000;

const bridgeDriftMismatchKindValidator = v.union(
  v.literal("seat_legacy_title_missing_specializedRoles_mirror"),
  v.literal("specializedRoles_row_missing_seat_mirror"),
);

/** Shared response shape for `bridgeDriftAudit` and its ops-only twin
 *  `bridgeDriftAuditSystem` — see the doc comment above `bridgeDriftAudit`
 *  for the full framing of what's returned. */
const bridgeDriftAuditReturns = v.object({
  checkedPeople: v.number(),
  mismatches: v.array(
    v.object({
      personId: v.id("people"),
      scope: v.union(v.id("chapters"), v.literal("central")),
      kind: bridgeDriftMismatchKindValidator,
      // `seatSide`/`storedSide` are both a `legacyTitle` string on whichever
      // side HAS the row, `null` on the side that's missing it — never both
      // non-null (that would be parity, not a mismatch) and never both null.
      seatSide: v.union(v.string(), v.null()),
      storedSide: v.union(v.string(), v.null()),
    }),
  ),
  status: v.union(
    v.literal("clean"),
    v.literal("mismatches"),
    v.literal("truncated"),
  ),
});

/**
 * The actual bridge-drift audit — extracted out of `bridgeDriftAudit` so
 * `bridgeDriftAuditSystem` (the ops-only `internalQuery` twin below) can
 * reuse the EXACT same logic instead of a hand-copied fork that could drift.
 * Takes NO auth dependency and performs NO auth check itself — every caller
 * of this function is responsible for its own gate (see the two exports
 * below for what each one uses).
 */
async function bridgeDriftAuditImpl(ctx: QueryCtx) {
  const seatAssignmentRows = await ctx.db
    .query("seatAssignments")
    .take(AUDIT_TABLE_SCAN_LIMIT);
  const specializedRoleRows = await ctx.db
    .query("specializedRoles")
    .take(AUDIT_TABLE_SCAN_LIMIT);

  let truncated = false;
  if (seatAssignmentRows.length === AUDIT_TABLE_SCAN_LIMIT) {
    truncated = true;
    console.warn(
      `[seats.bridgeDriftAudit] hit AUDIT_TABLE_SCAN_LIMIT (${AUDIT_TABLE_SCAN_LIMIT}) reading seatAssignments; audit may be incomplete.`,
    );
  }
  if (specializedRoleRows.length === AUDIT_TABLE_SCAN_LIMIT) {
    truncated = true;
    console.warn(
      `[seats.bridgeDriftAudit] hit AUDIT_TABLE_SCAN_LIMIT (${AUDIT_TABLE_SCAN_LIMIT}) reading specializedRoles; audit may be incomplete.`,
    );
  }

  // Group every already-loaded row by personId (avoids re-querying per
  // person — both tables above are the FULL bounded universe already).
  const assignmentsByPerson = new Map<Id<"people">, Doc<"seatAssignments">[]>();
  for (const r of seatAssignmentRows) {
    const arr = assignmentsByPerson.get(r.personId) ?? [];
    arr.push(r);
    assignmentsByPerson.set(r.personId, arr);
  }
  const specializedByPerson = new Map<Id<"people">, Doc<"specializedRoles">[]>();
  for (const r of specializedRoleRows) {
    const arr = specializedByPerson.get(r.personId) ?? [];
    arr.push(r);
    specializedByPerson.set(r.personId, arr);
  }

  // The union: every person with SOME row, from EITHER table.
  const personIds = new Set<Id<"people">>([
    ...assignmentsByPerson.keys(),
    ...specializedByPerson.keys(),
  ]);

  const mismatches: {
    personId: Id<"people">;
    scope: Id<"chapters"> | "central";
    kind:
      | "seat_legacy_title_missing_specializedRoles_mirror"
      | "specializedRoles_row_missing_seat_mirror";
    seatSide: string | null;
    storedSide: string | null;
  }[] = [];
  const recordMismatch = (entry: (typeof mismatches)[number]) => {
    if (mismatches.length >= AUDIT_MISMATCH_CAP) {
      truncated = true;
      return;
    }
    mismatches.push(entry);
  };

  for (const personId of personIds) {
    const personAssignments = assignmentsByPerson.get(personId) ?? [];
    const personSpecialized = specializedByPerson.get(personId) ?? [];

    // legacyTitle seat -> specializedRoles mirror, both directions.
    const legacyPairs: { scope: Id<"chapters"> | "central"; legacyTitle: string }[] = [];
    for (const a of personAssignments) {
      const def = await ctx.db.get(a.seatDefId);
      if (!def || !def.legacyTitle) continue;
      legacyPairs.push({ scope: a.scope, legacyTitle: def.legacyTitle });

      const hasMirror = personSpecialized.some(
        (r) => r.scope === a.scope && r.title === def.legacyTitle,
      );
      if (!hasMirror) {
        recordMismatch({
          personId,
          scope: a.scope,
          kind: "seat_legacy_title_missing_specializedRoles_mirror",
          seatSide: def.legacyTitle,
          storedSide: null,
        });
      }
    }
    for (const r of personSpecialized) {
      const hasMirror = legacyPairs.some(
        (p) => p.scope === r.scope && p.legacyTitle === r.title,
      );
      if (!hasMirror) {
        recordMismatch({
          personId,
          scope: r.scope,
          kind: "specializedRoles_row_missing_seat_mirror",
          seatSide: null,
          storedSide: r.title,
        });
      }
    }
  }

  const status: "clean" | "mismatches" | "truncated" = truncated
    ? "truncated"
    : mismatches.length > 0
      ? "mismatches"
      : "clean";

  return {
    checkedPeople: personIds.size,
    mismatches,
    status,
  };
}

/**
 * Bridge drift audit — superuser-gated (same check `assignSeat`/
 * `unassignSeat` use), 100% READ-ONLY. Checks that every `seatAssignments`
 * row on a `legacyTitle`-bearing seat def stays mirrored onto a
 * `specializedRoles` row at the same (scope, title) — `assignSeat`'s
 * write-through contract (`assignSpecializedRoleImpl` /
 * `removeSpecializedRoleImpl` in `specializedRoles.ts`) — in BOTH
 * directions: a seat with no mirror, and a mirror with no seat. See the
 * section doc above the constants for the full framing, including why this
 * replaced the old flip-simulation audit (the B10 flip in PR #195 already
 * shipped, so simulating it is permanently stale).
 *
 * This is a DATA-INTEGRITY check, not a capability-outcome comparison — it
 * says nothing about what anyone can currently DO (that's `lib/finance.ts`'s
 * live union formula, verified independently by
 * `tests/financeGatesSeatUnion.test.ts`). It exists only because
 * `specializedRoles` remains the live source of truth for title-based
 * separation-of-duties (`APPROVE_SEAT_SLUGS`/`RECORD_SEAT_SLUGS`) until that
 * table is retired in a later milestone — while it's live, a drifted mirror
 * is a real bug (e.g. someone who still holds a seat losing SoD-relevant
 * standing, or a departed holder's title lingering).
 *
 * Never enforces, throws-on-drift, or writes anything — it's a report, not a
 * gate. Bounded reads throughout (see `AUDIT_TABLE_SCAN_LIMIT` /
 * `AUDIT_MISMATCH_CAP`). `status: "truncated"` (rather than `"clean"` or
 * `"mismatches"`) means the report is a LOWER BOUND on actual drift, not a
 * complete accounting — a caller checking only `mismatches.length === 0`
 * would otherwise misread a truncated run as clean, which is exactly why
 * `status` exists instead of a bare boolean.
 */
export const bridgeDriftAudit = query({
  args: {},
  returns: bridgeDriftAuditReturns,
  handler: async (ctx) => {
    await requireSuperuser(ctx);
    return await bridgeDriftAuditImpl(ctx);
  },
});

/**
 * Ops-only twin of `bridgeDriftAudit` — an `internalQuery`, not a `query`.
 * Internal functions carry no client-reachable HTTP/API surface at all: only
 * `query`/`mutation`/`action` exports are exposed to the public API Convex
 * generates, so `internalQuery` exports are unreachable from the mobile/web
 * app or any outside caller by construction, regardless of auth state. The
 * only ways to reach one are other server-side Convex functions (via
 * `ctx.runQuery(internal...)`) or `npx convex run`/the dashboard, both of
 * which already require a deploy key / admin access to the deployment
 * itself. That's why this has NO `requireSuperuser` call — there is no
 * end-user identity to gate here (`npx convex run --prod` has none, which is
 * exactly why `bridgeDriftAudit` can't be run that way); the access control
 * for this surface is deployment access, not an in-app role check.
 *
 * Exists so ops can run the bridge-drift audit against prod
 * (`npx convex run --prod seats/bridgeDriftAudit:bridgeDriftAuditSystem`)
 * without a superuser-authenticated user session. Calls the identical
 * `bridgeDriftAuditImpl` `bridgeDriftAudit` does — same reads, same
 * formulas, same output shape — so the two are guaranteed to agree; pinned
 * by a test in `bridgeDriftAudit.test.ts` asserting byte-identical results
 * for the same data.
 */
export const bridgeDriftAuditSystem = internalQuery({
  args: {},
  returns: bridgeDriftAuditReturns,
  handler: async (ctx) => {
    return await bridgeDriftAuditImpl(ctx);
  },
});
