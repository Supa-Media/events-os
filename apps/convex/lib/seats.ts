/**
 * Seat-derived finance capabilities.
 *
 * This is the SINGLE place a future "flip enforcement to seats" change would
 * call to answer "what SHOULD this person be allowed to do, per the org
 * chart?" — as opposed to `lib/finance.ts` (`getFinanceRole`,
 * `isCentralEdOrFm`), which answers "what does the STORED
 * `financeRoles`/`specializedRoles` state say they're allowed to do?" today.
 *
 * Until that flip happens, this module is READ-ONLY and UNUSED by any
 * enforcement path — its only caller is the capability shadow audit
 * (`seats.ts#capabilityAudit`), which diffs its output against the stored
 * tables to find drift before anything is ever gated on it. Keep this file
 * dependency-light (no writes, no throws beyond what `ctx.db.query` itself
 * can do, no imports beyond `_generated` + `@events-os/shared`) so it stays
 * trivially auditable — every future capability the seat chart can grant
 * should be addable here without touching the stored-side tables at all.
 *
 * ## Mapping rules (READ THIS before extending)
 *
 * A person's derived finance capability is computed PURELY from their
 * `seatAssignments` rows, joined to `seatDefs` for each assignment's
 * `capabilities` array (the `SEAT_CAPABILITIES` vocabulary in
 * `@events-os/shared/seats.ts`). Nothing here reads `financeRoles` or
 * `specializedRoles` — this file is exclusively the "what the chart implies"
 * side.
 *
 *  - `scopeKey`: the assignment's `scope` field verbatim — either the string
 *    sentinel `"central"` (the org level) or a real `Id<"chapters">` (one
 *    chapter). Same shape `seatAssignments.scope` / `financeRoles.chapterId`
 *    / `specializedRoles.scope` already use elsewhere in this repo (see
 *    `lib/finance.ts`'s `FinanceScope` union) — this file introduces no new
 *    scope representation. The returned record has one entry per DISTINCT
 *    scope the person holds ANY seat at; a person with seats at both
 *    `"central"` and a chapter gets two entries, computed independently.
 *  - `financeRole`: `"manager"` iff ANY seat the person holds AT THAT SCOPE
 *    carries the `"finance.manager"` capability (e.g. `treasurer` at a
 *    chapter, `financial_manager` at central) — else `null`. This is the
 *    ONLY graded value a seat can derive; seats never derive `"bookkeeper"`
 *    or `"viewer"`. Those two lower ranks are a STORED-ONLY residual layer —
 *    a finance manager can still hand-grant a read-only viewer or an ad-hoc
 *    bookkeeper via `financeRoles.grantFinanceRole` with no seat needing to
 *    represent it. The planned flip is `effective = max(seat-derived,
 *    residual stored grants)` (see `seats.ts#capabilityAudit`'s doc), so a
 *    bookkeeper/viewer grant with no seat simply survives the flip via the
 *    residual side — this file just never PRODUCES those two ranks itself.
 *  - `centralReach`: true iff ANY seat at that scope carries
 *    `"finance.central"` (org-wide roll-up reach — the seat-derived
 *    equivalent of `lib/finance.ts#getFinanceRole`'s `isCentral`, which is
 *    ROLE-AGNOSTIC and WHOLE-PERSON, not scope-keyed — see that function's
 *    line 174 and `seats.ts#todaysIsCentral`). Today only central-chart seats
 *    (`executive_director`, `financial_manager`) carry this capability, so in
 *    practice this is only ever `true` under the `"central"` scopeKey — but
 *    the derivation itself is scope-agnostic, so a future chapter-chart seat
 *    granted `"finance.central"` would just work.
 *  - `accountsAccess`: true iff ANY seat at that scope carries
 *    `"finance.accounts"` (the Accounts tab / Relay-cards gate — the
 *    seat-derived equivalent of `lib/finance.ts#isCentralEdOrFm`, which today
 *    derives this from a CENTRAL `specializedRoles` row titled
 *    `executive_director` or `finance_manager` instead of a seat).
 *    `isCentralEdOrFm` is USER-keyed (OR across every non-placeholder
 *    `people` row a user owns — lines 350-357), NOT person-keyed; this file
 *    stays person-keyed (a pure function of `personId`'s own seats) and
 *    leaves that user-level aggregation to the audit's
 *    `todaysAccountsAccessForPerson`, which replicates it exactly.
 *
 * Holding several seats at the same scope (or a multi-holder seat with
 * several occupants) just ORs together: one `true` / `"manager"` from ANY
 * one seat at a scope is enough to set that scope's flag. There is no
 * "un-deriving" a capability by ALSO holding a weaker seat at the same
 * scope — capabilities never subtract.
 *
 * ## Out of scope: 4 of the 7 `SEAT_CAPABILITIES`
 *
 * `SEAT_CAPABILITIES` also includes `finance.approve`, `finance.record`,
 * `nav.finances`, and `org.editChart` — this file derives NONE of them, and
 * `capabilityAudit` compares none of them. Not an oversight:
 *
 *  - `finance.approve` / `finance.record` mark the org chart's "approve-side"
 *    (leadership) vs "record-side" (finance) seats, but the actual
 *    separation-of-duties enforcement (`seats.ts`'s `APPROVE_SEAT_SLUGS` /
 *    `RECORD_SEAT_SLUGS`, and `assignSpecializedRoleImpl`'s scope-local SoD
 *    check) is derived from `legacyTitle` + `titleKind`, NOT from these
 *    capability strings. They aren't part of the graded finance-role ladder
 *    this flip targets, so they're out of scope for THIS flip specifically —
 *    a future SoD-flip would need its own derivation function.
 *  - `nav.finances` / `org.editChart` are UI-visibility / org-chart-editing
 *    gates, not money-access gates `getFinanceRole`/`isCentralEdOrFm` cover
 *    at all.
 *
 * As of this PR, none of these four strings are read by any enforcement path
 * anywhere in `apps/convex` — they're declared on seat defs
 * (`@events-os/shared/seats.ts`) but purely descriptive today. If that
 * changes, extend this file (and `capabilityAudit`) rather than assuming a
 * clean audit already covers them.
 */
import { Id } from "../_generated/dataModel";
import { QueryCtx } from "../_generated/server";

/** Bound on how many seat assignments a single person can hold — generous
 *  (mirrors `seats.ts#personHoldsOtherGroupSeatInScope`'s `take(200)`); in
 *  practice a real person holds a small handful of seats at most. */
const PERSON_SEAT_ASSIGNMENT_LIMIT = 200;

/** One scope's seat-derived finance capability. */
export interface SeatDerivedScopeCapabilities {
  /** `"manager"` iff some seat at this scope carries `finance.manager`,
   *  else `null`. Seats never derive `"bookkeeper"`/`"viewer"` — see the
   *  module doc's "Mapping rules". */
  financeRole: "manager" | null;
  /** True iff some seat at this scope carries `finance.central`. */
  centralReach: boolean;
  /** True iff some seat at this scope carries `finance.accounts`. */
  accountsAccess: boolean;
}

/**
 * Per-scope seat-derived capabilities, keyed by `scopeKey` — either the
 * literal string `"central"` or an `Id<"chapters">` (both are plain strings,
 * so both are valid object keys; see the module doc for how to turn a key
 * back into a typed scope value, e.g. `key === "central" ? "central" : (key
 * as Id<"chapters">)`).
 */
export type SeatDerivedCapabilities = Record<string, SeatDerivedScopeCapabilities>;

/**
 * The person's seat-derived finance capabilities, per scope. Pure read: one
 * indexed query on `seatAssignments` (bounded by
 * `PERSON_SEAT_ASSIGNMENT_LIMIT`) plus one `ctx.db.get` per assignment to
 * resolve its `seatDefs` row. Never throws on a stale/missing def — a seat
 * assignment pointing at a deleted def just contributes nothing.
 *
 * NO PLACEHOLDER FILTER — intentionally, and unlike the real gates this file
 * is compared against (`isCentralEdOrFm` skips `isPlaceholder === true`
 * rows; `viewerPerson`/`assignSeat` both refuse to treat/assign a placeholder
 * as a real occupant). This function answers "what does the org chart's DATA
 * say", full stop — it doesn't second-guess whether `personId` currently
 * looks like a legitimate holder. `assignSeat` already refuses to CREATE a
 * placeholder assignment, so in steady state this never diverges from the
 * real gates in practice; if a person is DEMOTED to a placeholder after being
 * seated (leaving a stale assignment), that's exactly the kind of drift
 * `capabilityAudit`'s today-vs-post-flip comparison exists to surface — using
 * the real gates' placeholder-aware logic on the "today" side as the
 * baseline, not by filtering it out here too.
 */
export async function getSeatDerivedCapabilities(
  ctx: QueryCtx,
  personId: Id<"people">,
): Promise<SeatDerivedCapabilities> {
  const assignments = await ctx.db
    .query("seatAssignments")
    .withIndex("by_person", (q) => q.eq("personId", personId))
    .take(PERSON_SEAT_ASSIGNMENT_LIMIT);

  const result: SeatDerivedCapabilities = {};
  for (const assignment of assignments) {
    const def = await ctx.db.get(assignment.seatDefId);
    if (!def) continue; // stale assignment on a deleted def — nothing to derive

    const scopeKey = String(assignment.scope);
    const entry =
      result[scopeKey] ??
      (result[scopeKey] = {
        financeRole: null,
        centralReach: false,
        accountsAccess: false,
      });

    if (def.capabilities.includes("finance.manager")) entry.financeRole = "manager";
    if (def.capabilities.includes("finance.central")) entry.centralReach = true;
    if (def.capabilities.includes("finance.accounts")) entry.accountsAccess = true;
  }
  return result;
}
