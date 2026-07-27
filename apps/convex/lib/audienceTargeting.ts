/**
 * Targeting v2 evaluation (specs/audience-targeting-v2.md) — the group/
 * condition model behind `audiences.targeting`: a person is a member if they
 * match ANY include group (conditions inside a group AND-combine), then
 * `excludeGroups` removes anyone matching ANY of those, then hand-picks and
 * the consent gates apply EXACTLY as the legacy path does (this module never
 * touches suppression/opt-out ordering — `resolveAudienceRecipients` owns
 * that, shared with every legacy source).
 *
 * ── Condition semantics (the contract the UI and tests pin) ────────────────
 *
 * DONOR-DERIVED conditions (`donor_status`/`giving_lifetime`/`gift_count`/
 * `last_gift`/`backer`) evaluate against the person's linked donor ROWS
 * (per-scope books, from ONE bounded scan per resolution — see
 * `buildDonorIndex`):
 *  - a POSITIVE op (`is`/`gte`/`lte`/`within_days`) holds iff SOME single
 *    donor row satisfies it;
 *  - a NEGATED op (`is_not`/`not_within_days`) holds iff NO donor row
 *    satisfies its positive counterpart — so a person with no donor rows at
 *    all satisfies every negated donor condition ("is not a donor", "hasn't
 *    given in 90 days") and fails every positive one ("gave at most $50"
 *    still requires BEING a donor — pair with `donor_status is_not any` to
 *    say "not a donor").
 *  Each condition evaluates INDEPENDENTLY (per-condition ∃, not the legacy
 *  resolver's all-criteria-on-one-row rule): "active donor AND gave ≥ $100"
 *  can be satisfied by two different books of a multi-chapter giver. This is
 *  deliberate — per-condition verdicts are what the explainability surface
 *  shows, so the evaluation unit must BE the condition (and for the
 *  overwhelmingly common single-book giver the two rules are identical;
 *  migration 0042's wrap notes the delta).
 *
 * ATTENDANCE conditions (`attended_event`/`attended_any`) evaluate against
 * the person's non-archived `rsvps` rows (`by_person`, bounded, fetched once
 * per candidate and shared across every group — include and exclude alike).
 * A single row must satisfy every qualifier on the condition together
 * (`eventId`/`chapterId`/`rsvpStatus`/`withinDays` — the legacy
 * `personAttendsMatch` joint-row rule, kept losslessly). `has` = some row;
 * `has_not` = no row.
 *
 * `chapter`/`kind` compare fields already on the person row (zero reads);
 * `seat` reads the person's `seatAssignments` (bounded, cached);
 * `email_verified` checks that the address `resolveSendAddress` would
 * ACTUALLY pick has a verified `personEmails` row (the
 * `resolvedAddressIsVerified` rule — include-side only, see
 * `validateTargeting`).
 *
 * `has_service`/`has_not` compares `people.serviceIds` (Service Catalog ids,
 * `schema/services.ts`) against the condition's `serviceId`: a person matches
 * if `serviceIds` contains that id OR ANY CHILD of it — so targeting the
 * parent `Vocals` also matches everyone tagged the child `Vocals:Tenor`. The
 * child set is resolved ONCE per resolution (`buildServiceIndex`, a
 * prebuilt in-memory index exactly like `DonorIndex` below — a single bounded
 * `by_parent` read per DISTINCT `serviceId` referenced anywhere in the
 * targeting, never per candidate), so evaluating the condition itself is a
 * zero-read Set lookup. A person with no `serviceIds` array: `has` → false,
 * `has_not` → true — same "missing data reads as false"/negation-inverts
 * rule `attended_event` uses for a person with no rsvp rows.
 *
 * ── Central-donor fallback (spec §3.4, #424 finding A from day one) ────────
 * For a `scope: "central"` audience, unlinked `scope: "central"` donor rows
 * are candidates too — but ONLY via an include group carrying at least one
 * donor-derived condition (the legacy `hasDonorCriteria` gate: an
 * "everyone"/negation-only group must never silently sweep the whole central
 * donor file into a people-shaped audience). Against a donor row:
 *  - donor-derived conditions evaluate on THAT row (row set = itself);
 *  - person-linked conditions (`attended_*`/`seat`/`chapter`/`kind`/
 *    `email_verified`/`has_service`) evaluate as their linked-person
 *    semantics would with no rows: positive ops false, negated ops true
 *    ("never attended" is TRUE of a row with no person and no rsvps; a donor
 *    row has no `serviceIds` either, so `has_service` reads the same way —
 *    `has` false, `has_not` true). This applies to EXCLUDE groups
 *    identically — "remove anyone who never attended" really does remove
 *    fallback donors; uniform rule, no conservative-stay special case.
 *
 * ── Read budget ────────────────────────────────────────────────────────────
 * One bounded people scan per chapter in scope (`PEOPLE_PER_CHAPTER_LIMIT`),
 * one bounded donors scan per donor scope IF any donor-derived condition
 * exists anywhere (`DONORS_PER_SCOPE_LIMIT`), pledges only if a `backer`
 * condition exists (4 × `PLEDGES_PER_SCOPE_LIMIT` per scope), and per-person
 * bounded rsvp/seat/email lookups paid AT MOST ONCE per candidate per
 * resolution (lazy caches shared across all groups, both sides). Cheap-first
 * inside every group: zero-read conditions run before per-person lookups, so
 * a candidate failing on `chapter`/`kind`/donor conditions never costs a
 * read. NEVER `.paginate()` in this file — same single-paginate rule as
 * `audienceResolve.ts` (see that module's doc).
 *
 * The per-person/per-scope caps here deliberately MIRROR
 * `lib/audienceResolve.ts`'s (same tables, same scale reasoning — see each
 * constant's doc there); they're re-declared locally so this module never
 * imports from `audienceResolve.ts` (which imports THIS module for the
 * `targeting` branch — a one-direction dependency, no cycle).
 */
import type { Infer } from "convex/values";
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { DAY_MS } from "@events-os/shared";
import { normalizeEmail } from "./access";
import { listActiveChapters } from "./chapters";
import { resolveSendAddress } from "./personEmails";
import {
  audienceConditionValidator,
  audienceGroupValidator,
  audienceTargetingValidator,
} from "../schema/campaigns";
import { PLEDGE_STATUSES } from "../schema/givingPlatform";

export type AudienceCondition = Infer<typeof audienceConditionValidator>;
export type AudienceGroup = Infer<typeof audienceGroupValidator>;
export type AudienceTargeting = Infer<typeof audienceTargetingValidator>;

type AudienceScope = Id<"chapters"> | "central";

// Mirrors of `audienceResolve.ts`'s caps — see the module doc above.
const PEOPLE_PER_CHAPTER_LIMIT = 2000;
const DONORS_PER_SCOPE_LIMIT = 2000;
const PLEDGES_PER_SCOPE_LIMIT = 2000;
const RSVPS_PER_PERSON_LIMIT = 500;
const SEAT_ASSIGNMENTS_PER_PERSON_LIMIT = 200;
const RSVPS_PER_EVENT_LIMIT = 2000;
const UNLINKED_GUESTS_SCAN_CAP = 500;

/** Structural caps enforced by `validateTargeting` — far above anything a
 *  human builds by hand, low enough that the per-candidate evaluation loop
 *  stays trivially bounded (every condition is O(cached rows) once its
 *  lookup is paid). */
export const TARGETING_MAX_GROUPS = 10;
export const TARGETING_MAX_CONDITIONS_PER_GROUP = 10;

const DONOR_FIELDS = new Set(["donor_status", "giving_lifetime", "gift_count", "last_gift", "backer"]);

function isDonorCondition(c: AudienceCondition): boolean {
  return DONOR_FIELDS.has(c.field);
}

/**
 * Write-time structural validation, shared by `audiences.ts`'s create/update/
 * preview and (defensively) migration 0042. Throws `ConvexError` on:
 *  - zero include groups (an audience that matches nobody is a UI bug, not a
 *    definition — "everyone" is ONE group with ZERO conditions, which IS
 *    allowed on the include side);
 *  - an EMPTY group inside `excludeGroups` (vacuous AND = "exclude everyone"
 *    — never what a human meant; the group-shaped `hasEffectiveExcludeCriteria`
 *    rule);
 *  - `email_verified` inside `excludeGroups` (#424 finding C: reads backwards
 *    there);
 *  - group/condition counts over the structural caps.
 */
export function validateTargeting(targeting: AudienceTargeting): void {
  if (targeting.groups.length === 0) {
    throw new ConvexError({
      code: "EMPTY_TARGETING",
      message: "Add at least one group (a group with no conditions means everyone).",
    });
  }
  if (targeting.groups.length > TARGETING_MAX_GROUPS) {
    throw new ConvexError({
      code: "TOO_MANY_GROUPS",
      message: `Use at most ${TARGETING_MAX_GROUPS} groups.`,
    });
  }
  const excludeGroups = targeting.excludeGroups ?? [];
  if (excludeGroups.length > TARGETING_MAX_GROUPS) {
    throw new ConvexError({
      code: "TOO_MANY_GROUPS",
      message: `Use at most ${TARGETING_MAX_GROUPS} skip lists.`,
    });
  }
  for (const g of [...targeting.groups, ...excludeGroups]) {
    if (g.conditions.length > TARGETING_MAX_CONDITIONS_PER_GROUP) {
      throw new ConvexError({
        code: "TOO_MANY_CONDITIONS",
        message: `Use at most ${TARGETING_MAX_CONDITIONS_PER_GROUP} conditions per group.`,
      });
    }
  }
  for (const g of excludeGroups) {
    if (g.conditions.length === 0) {
      throw new ConvexError({
        code: "EMPTY_EXCLUDE_GROUP",
        message: "A skip list needs at least one condition — an empty one would skip everyone.",
      });
    }
    if (g.conditions.some((c) => c.field === "email_verified")) {
      throw new ConvexError({
        code: "INVALID_EXCLUDE_CONDITION",
        message: "Verified-email can't be used in a skip list — it would remove exactly the people you can safely reach.",
      });
    }
  }
}

/** Write-time normalization, mirroring `audiences.ts#normalizeExcludeFilters`'s
 *  philosophy: an `excludeGroups: []` is stored as `undefined` so a stored row
 *  can never be present-but-inert and the snapshot hash's key-presence rule
 *  stays trivial. */
export function normalizeTargeting(targeting: AudienceTargeting): AudienceTargeting {
  if (targeting.excludeGroups && targeting.excludeGroups.length === 0) {
    const { excludeGroups: _drop, ...rest } = targeting;
    return rest;
  }
  return targeting;
}

// ── Resolution-level indexes (built at most once per resolution) ────────────

interface DonorIndex {
  /** Every scanned donor row with a `personId`, grouped by person. */
  rowsByPersonId: Map<Id<"people">, Doc<"donors">[]>;
  /** Unlinked `scope: "central"` rows (the §3.4 fallback pool) — only
   *  populated for a central-scoped audience. */
  centralFallbackDonors: Doc<"donors">[];
  activePledgeDonorIds: Set<Id<"donors">> | null;
  anyPledgeDonorIds: Set<Id<"donors">> | null;
}

function targetingHasDonorConditions(targeting: AudienceTargeting): boolean {
  return [...targeting.groups, ...(targeting.excludeGroups ?? [])].some((g) =>
    g.conditions.some(isDonorCondition),
  );
}

function targetingHasBackerConditions(targeting: AudienceTargeting): boolean {
  return [...targeting.groups, ...(targeting.excludeGroups ?? [])].some((g) =>
    g.conditions.some((c) => c.field === "backer"),
  );
}

/** The donor scopes a targeting resolution fans across — every active chapter
 *  plus the `"central"` sentinel for a central-scoped audience, else just the
 *  audience's own chapter. (No `filters.chapterId` narrowing exists in v2:
 *  `chapter` is a CONDITION evaluated per person, so the
 *  central-donors-silently-unscanned class `audienceResolve.ts`'s
 *  `centralDonorsExcludedByChapterFilter` counter exists to expose is
 *  structurally gone here.) */
async function targetingDonorScopes(ctx: QueryCtx, scope: AudienceScope): Promise<AudienceScope[]> {
  if (scope !== "central") return [scope];
  const chapters = await listActiveChapters(ctx);
  return [...chapters.map((c) => c._id), "central"];
}

/** ONE bounded donors scan (+ pledges, only when a `backer` condition exists)
 *  for the whole resolution — every donor-derived condition in every group
 *  evaluates against this in-memory index; no per-person donor reads ever. */
async function buildDonorIndex(
  ctx: QueryCtx,
  scope: AudienceScope,
  targeting: AudienceTargeting,
): Promise<DonorIndex> {
  const idx: DonorIndex = {
    rowsByPersonId: new Map(),
    centralFallbackDonors: [],
    activePledgeDonorIds: null,
    anyPledgeDonorIds: null,
  };
  if (!targetingHasDonorConditions(targeting)) return idx;

  const scopes = await targetingDonorScopes(ctx, scope);
  for (const s of scopes) {
    const donors = await ctx.db
      .query("donors")
      .withIndex("by_scope", (q) => q.eq("scope", s))
      .take(DONORS_PER_SCOPE_LIMIT);
    for (const d of donors) {
      if (d.personId) {
        const rows = idx.rowsByPersonId.get(d.personId);
        if (rows) rows.push(d);
        else idx.rowsByPersonId.set(d.personId, [d]);
      } else if (d.scope === "central" && scope === "central" && d.email) {
        idx.centralFallbackDonors.push(d);
      }
    }
  }

  if (targetingHasBackerConditions(targeting)) {
    idx.activePledgeDonorIds = new Set();
    idx.anyPledgeDonorIds = new Set();
    for (const s of scopes) {
      for (const status of PLEDGE_STATUSES) {
        const pledges = await ctx.db
          .query("pledges")
          .withIndex("by_scope_and_status", (q) => q.eq("scope", s).eq("status", status))
          .take(PLEDGES_PER_SCOPE_LIMIT);
        for (const p of pledges) {
          idx.anyPledgeDonorIds.add(p.donorId);
          if (status === "active") idx.activePledgeDonorIds.add(p.donorId);
        }
      }
    }
  }
  return idx;
}

/** Bound on the `by_parent` scan `buildServiceIndex` runs per distinct
 *  `serviceId` — far above the Service Catalog's own per-option child count
 *  (a handful, e.g. `Vocals`'s 4 parts). */
const SERVICE_CHILDREN_LIMIT = 500;

interface ServiceIndex {
  /** Target `serviceId` → the full match set (itself + every child,
   *  regardless of the child's own `isActive` — deactivating an option never
   *  retroactively untags anyone; see `schema/services.ts`'s doc). */
  matchSetById: Map<Id<"serviceOptions">, Set<Id<"serviceOptions">>>;
}

function targetingServiceIds(targeting: AudienceTargeting): Set<Id<"serviceOptions">> {
  const ids = new Set<Id<"serviceOptions">>();
  for (const g of [...targeting.groups, ...(targeting.excludeGroups ?? [])]) {
    for (const c of g.conditions) {
      if (c.field === "has_service") ids.add(c.serviceId);
    }
  }
  return ids;
}

/** ONE bounded `by_parent` scan per DISTINCT `serviceId` referenced anywhere
 *  in `targeting` (include or exclude side) — built once per resolution,
 *  exactly like `buildDonorIndex`, so evaluating `has_service` for each
 *  candidate is a zero-read Set lookup regardless of how many people are
 *  scanned. */
async function buildServiceIndex(
  ctx: QueryCtx,
  targeting: AudienceTargeting,
): Promise<ServiceIndex> {
  const idx: ServiceIndex = { matchSetById: new Map() };
  for (const serviceId of targetingServiceIds(targeting)) {
    const children = await ctx.db
      .query("serviceOptions")
      .withIndex("by_parent", (q) => q.eq("parentId", serviceId))
      .take(SERVICE_CHILDREN_LIMIT);
    idx.matchSetById.set(serviceId, new Set([serviceId, ...children.map((c) => c._id)]));
  }
  return idx;
}

// ── Per-candidate lazy lookups (each paid at most once per candidate) ───────

interface PersonCaches {
  rsvpsById: Map<Id<"people">, Doc<"rsvps">[]>;
  seatsById: Map<Id<"people">, Doc<"seatAssignments">[]>;
  emailsById: Map<Id<"people">, Doc<"personEmails">[]>;
}

async function getRsvpsCached(
  ctx: QueryCtx,
  caches: PersonCaches,
  personId: Id<"people">,
): Promise<Doc<"rsvps">[]> {
  const cached = caches.rsvpsById.get(personId);
  if (cached) return cached;
  const rows = await ctx.db
    .query("rsvps")
    .withIndex("by_person", (q) => q.eq("personId", personId))
    .take(RSVPS_PER_PERSON_LIMIT);
  caches.rsvpsById.set(personId, rows);
  return rows;
}

async function getSeatsCached(
  ctx: QueryCtx,
  caches: PersonCaches,
  personId: Id<"people">,
): Promise<Doc<"seatAssignments">[]> {
  const cached = caches.seatsById.get(personId);
  if (cached) return cached;
  const rows = await ctx.db
    .query("seatAssignments")
    .withIndex("by_person", (q) => q.eq("personId", personId))
    .take(SEAT_ASSIGNMENTS_PER_PERSON_LIMIT);
  caches.seatsById.set(personId, rows);
  return rows;
}

async function getEmailsCached(
  ctx: QueryCtx,
  caches: PersonCaches,
  personId: Id<"people">,
): Promise<Doc<"personEmails">[]> {
  const cached = caches.emailsById.get(personId);
  if (cached) return cached;
  const rows = await ctx.db
    .query("personEmails")
    .withIndex("by_person", (q) => q.eq("personId", personId))
    .collect();
  caches.emailsById.set(personId, rows);
  return rows;
}

/** Same rule as `audienceResolve.ts#resolvedAddressIsVerified` (the #418
 *  data-trust fix): the address that would ACTUALLY be sent to must itself be
 *  a verified `personEmails` row. */
function resolvedAddressIsVerified(
  person: Pick<Doc<"people">, "email" | "pwEmail">,
  emails: Doc<"personEmails">[],
): boolean {
  const raw = resolveSendAddress(person, emails);
  const email = raw ? normalizeEmail(raw) : null;
  if (!email) return false;
  return emails.some((e) => e.email === email && e.verified === true);
}

// ── Per-condition evaluation ────────────────────────────────────────────────

/** True iff one donor row satisfies the POSITIVE reading of `c`. */
function donorRowSatisfies(
  d: Doc<"donors">,
  c: AudienceCondition,
  idx: DonorIndex,
  now: number,
): boolean {
  switch (c.field) {
    case "donor_status":
      return c.status === "any" ? true : d.status === c.status;
    case "giving_lifetime":
      return c.op === "gte" ? d.lifetimeCents >= c.cents : d.lifetimeCents <= c.cents;
    case "gift_count":
      return c.op === "gte" ? d.giftCount >= c.count : d.giftCount <= c.count;
    case "last_gift":
      return d.lastGiftAt != null && d.lastGiftAt >= now - c.days * DAY_MS;
    case "backer": {
      const active = idx.activePledgeDonorIds!.has(d._id);
      const any = idx.anyPledgeDonorIds!.has(d._id);
      return c.status === "active" ? active : any && !active;
    }
    default:
      return false;
  }
}

/** Is `c`'s op the negated member of its field's pair? (`is_not`/`has_not`/
 *  `not_holds`/`not_within_days` — `gte`/`lte` are both positive.) */
function isNegatedOp(c: AudienceCondition): boolean {
  return c.op === "is_not" || c.op === "has_not" || c.op === "not_holds" || c.op === "not_within_days";
}

/** Evaluate one donor-derived condition against a set of donor rows:
 *  positive = SOME row satisfies; negated = NO row satisfies the positive
 *  counterpart (so an empty row set fails positives and passes negations —
 *  see the module doc). */
function evalDonorCondition(
  rows: Doc<"donors">[],
  c: AudienceCondition,
  idx: DonorIndex,
  now: number,
): boolean {
  const some = rows.some((d) => donorRowSatisfies(d, c, idx, now));
  return isNegatedOp(c) ? !some : some;
}

/** True iff rsvp row `r` satisfies every qualifier on attendance condition
 *  `c` together (the joint-row rule — see the module doc). */
function rsvpRowSatisfies(r: Doc<"rsvps">, c: AudienceCondition, now: number): boolean {
  if (r.archivedAt !== undefined) return false;
  if (c.field === "attended_event") {
    if (r.eventId !== c.eventId) return false;
  } else if (c.field === "attended_any") {
    if (c.chapterId && r.chapterId !== c.chapterId) return false;
  } else {
    return false;
  }
  if (c.rsvpStatus && r.status !== c.rsvpStatus) return false;
  if (c.withinDays != null && r.createdAt < now - c.withinDays * DAY_MS) return false;
  return true;
}

/**
 * Evaluate one condition for a PERSON candidate. `excludeSide` only changes
 * `email_verified` (never evaluated there — belt to `validateTargeting`'s
 * suspenders; returns `false` so the group can't match through it).
 */
async function evalConditionForPerson(
  ctx: QueryCtx,
  person: Doc<"people">,
  c: AudienceCondition,
  donorIdx: DonorIndex,
  serviceIdx: ServiceIndex,
  caches: PersonCaches,
  now: number,
  excludeSide: boolean,
): Promise<boolean> {
  switch (c.field) {
    case "chapter": {
      const is = person.chapterId === c.chapterId;
      return c.op === "is" ? is : !is;
    }
    case "kind":
      return c.kind === "contact" ? person.isContactOnly === true : person.isContactOnly !== true;
    case "has_service": {
      const matchSet = serviceIdx.matchSetById.get(c.serviceId) ?? new Set([c.serviceId]);
      const some = (person.serviceIds ?? []).some((id) => matchSet.has(id));
      return c.op === "has" ? some : !some;
    }
    case "donor_status":
    case "giving_lifetime":
    case "gift_count":
    case "last_gift":
    case "backer":
      return evalDonorCondition(donorIdx.rowsByPersonId.get(person._id) ?? [], c, donorIdx, now);
    case "attended_event":
    case "attended_any": {
      const rows = await getRsvpsCached(ctx, caches, person._id);
      const some = rows.some((r) => rsvpRowSatisfies(r, c, now));
      return c.op === "has" ? some : !some;
    }
    case "seat": {
      const rows = await getSeatsCached(ctx, caches, person._id);
      const some = rows.some((a) => a.seatDefId === c.seatId);
      return c.op === "holds" ? some : !some;
    }
    case "email_verified": {
      if (excludeSide) return false;
      const emails = await getEmailsCached(ctx, caches, person._id);
      return resolvedAddressIsVerified(person, emails);
    }
  }
}

/** Cost class for cheap-first ordering inside a group: 0 = field compare,
 *  1 = prebuilt in-memory index, 2 = per-person indexed read. */
function conditionCost(c: AudienceCondition): number {
  switch (c.field) {
    case "chapter":
    case "kind":
      return 0;
    case "donor_status":
    case "giving_lifetime":
    case "gift_count":
    case "last_gift":
    case "backer":
    case "has_service":
      return 1;
    default:
      return 2;
  }
}

/** True iff `person` satisfies EVERY condition in `group` (vacuously true for
 *  an empty include group — "everyone"; `validateTargeting` bans empty
 *  exclude groups). Conditions are evaluated cheapest-first with
 *  short-circuit, so a failing candidate rarely pays a read. */
async function personMatchesGroup(
  ctx: QueryCtx,
  person: Doc<"people">,
  group: AudienceGroup,
  donorIdx: DonorIndex,
  serviceIdx: ServiceIndex,
  caches: PersonCaches,
  now: number,
  excludeSide: boolean,
): Promise<boolean> {
  const ordered = [...group.conditions].sort((a, b) => conditionCost(a) - conditionCost(b));
  for (const c of ordered) {
    if (!(await evalConditionForPerson(ctx, person, c, donorIdx, serviceIdx, caches, now, excludeSide))) {
      return false;
    }
  }
  return true;
}

/** Evaluate one condition for an UNLINKED CENTRAL DONOR row (spec §3.4 /
 *  finding A): donor-derived conditions run against the row itself; every
 *  person-linked condition evaluates as a person with NO rows would —
 *  positive false, negated true (see the module doc). */
function evalConditionForFallbackDonor(
  d: Doc<"donors">,
  c: AudienceCondition,
  donorIdx: DonorIndex,
  now: number,
  excludeSide: boolean,
): boolean {
  if (isDonorCondition(c)) return evalDonorCondition([d], c, donorIdx, now);
  if (c.field === "email_verified") {
    // A donor row's address has no `personEmails` verification to check —
    // never provable, include-side only, so the group can't admit the row
    // through it. (`excludeSide` is identical: false.)
    void excludeSide;
    return false;
  }
  return isNegatedOp(c);
}

function fallbackDonorMatchesGroup(
  d: Doc<"donors">,
  group: AudienceGroup,
  donorIdx: DonorIndex,
  now: number,
  excludeSide: boolean,
): boolean {
  return group.conditions.every((c) => evalConditionForFallbackDonor(d, c, donorIdx, now, excludeSide));
}

// ── Diagnostics ─────────────────────────────────────────────────────────────

/**
 * The v2 generalization of `audienceResolve.ts#countUnlinkedGuests` (same
 * data-trust rationale, same bounds — see that function's doc): count
 * non-archived `rsvps` rows with NO `personId` that would satisfy at least
 * one POSITIVE attendance condition in the include groups — guests who can
 * never match via `rsvps.by_person` and so silently never appear. One
 * bounded `by_event` scan per distinct positive `attended_event` eventId
 * (capped at 5 distinct events — beyond that the counter reports a lower
 * bound rather than paying more scans), plus ONE capped most-recent-first
 * scan when any positive `attended_any` exists. Deduped by row id across
 * scans. DIAGNOSTIC-ONLY: caller gates on `includeDiagnostics`.
 */
async function countUnlinkedGuestsForTargeting(
  ctx: QueryCtx,
  targeting: AudienceTargeting,
  chapterIds: Set<Id<"chapters">>,
  now: number,
): Promise<{ count: number; isLowerBound: boolean }> {
  const positives = targeting.groups
    .flatMap((g) => g.conditions)
    .filter((c) => (c.field === "attended_event" || c.field === "attended_any") && c.op === "has");
  if (positives.length === 0) return { count: 0, isLowerBound: false };

  const seen = new Set<Id<"rsvps">>();
  let isLowerBound = false;

  const matchesAnyPositive = (r: Doc<"rsvps">): boolean =>
    positives.some((c) => rsvpRowSatisfies(r, c, now));

  const consider = (rows: Doc<"rsvps">[]) => {
    for (const r of rows) {
      if (r.personId !== undefined) continue;
      if (!chapterIds.has(r.chapterId)) continue;
      if (!matchesAnyPositive(r)) continue;
      seen.add(r._id);
    }
  };

  const eventIds = [
    ...new Set(
      positives.flatMap((c) => (c.field === "attended_event" ? [c.eventId] : [])),
    ),
  ];
  const EVENT_SCAN_CAP = 5;
  if (eventIds.length > EVENT_SCAN_CAP) isLowerBound = true;
  for (const eventId of eventIds.slice(0, EVENT_SCAN_CAP)) {
    const rows = await ctx.db
      .query("rsvps")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .take(RSVPS_PER_EVENT_LIMIT);
    if (rows.length >= RSVPS_PER_EVENT_LIMIT) isLowerBound = true;
    consider(rows);
  }

  if (positives.some((c) => c.field === "attended_any")) {
    const rows = await ctx.db.query("rsvps").order("desc").take(UNLINKED_GUESTS_SCAN_CAP);
    if (rows.length >= UNLINKED_GUESTS_SCAN_CAP) isLowerBound = true;
    consider(rows);
  }

  return { count: seen.size, isLowerBound };
}

// ── Explainability ("check a person" — the trust feature) ──────────────────

export interface ConditionVerdict {
  condition: AudienceCondition;
  pass: boolean;
}

export interface GroupVerdict {
  matched: boolean;
  conditions: ConditionVerdict[];
}

export interface PersonExplanation {
  /** The one-word outcome, in decision order: no_match → excluded (by a
   *  group) → hand_pick_excluded → opted_out → suppressed → no_address →
   *  recipient. */
  verdict:
    | "recipient"
    | "no_match"
    | "excluded"
    | "hand_pick_excluded"
    | "opted_out"
    | "suppressed"
    | "no_address";
  groups: GroupVerdict[];
  excludeGroups: GroupVerdict[];
  /** True when the person is on `includePersonIds` — i.e. they'd be in the
   *  union even matching no group (and the UI should say so). */
  handPicked: boolean;
}

/**
 * Per-condition explanation of one PERSON's membership — the backend of the
 * preview card's "check a person" box (spec §"Explainability"): every
 * condition in every group gets its own pass/fail against the same evaluator
 * the real resolution uses (never a parallel reimplementation, so the
 * explanation can't drift from the truth), then the final verdict walks the
 * same decision order `resolveTargetingAudience` applies. Read cost: one
 * donor-index build (bounded, only if donor conditions exist) plus this ONE
 * person's cached rsvp/seat/email lookups — a single-person slice of a
 * resolution, cheap enough for a live search box.
 */
export async function explainTargetingForPerson(
  ctx: QueryCtx,
  audience: {
    scope: AudienceScope;
    targeting: AudienceTargeting;
    includePersonIds?: Id<"people">[];
    excludePersonIds?: Id<"people">[];
  },
  person: Doc<"people">,
  suppressedEmails: Set<string>,
): Promise<PersonExplanation> {
  const { targeting } = audience;
  const now = Date.now();
  const donorIdx = await buildDonorIndex(ctx, audience.scope, targeting);
  const serviceIdx = await buildServiceIndex(ctx, targeting);
  const caches: PersonCaches = {
    rsvpsById: new Map(),
    seatsById: new Map(),
    emailsById: new Map(),
  };

  const evalGroups = async (groups: AudienceGroup[], excludeSide: boolean) => {
    const out: GroupVerdict[] = [];
    for (const g of groups) {
      const conditions: ConditionVerdict[] = [];
      for (const c of g.conditions) {
        conditions.push({
          condition: c,
          pass: await evalConditionForPerson(ctx, person, c, donorIdx, serviceIdx, caches, now, excludeSide),
        });
      }
      out.push({ matched: conditions.every((v) => v.pass), conditions });
    }
    return out;
  };

  const groups = await evalGroups(targeting.groups, false);
  const excludeGroups = await evalGroups(targeting.excludeGroups ?? [], true);
  const handPicked = (audience.includePersonIds ?? []).includes(person._id);

  const matchedAny = groups.some((g) => g.matched) || handPicked;
  const excluded = excludeGroups.some((g) => g.matched);
  const handPickExcluded = (audience.excludePersonIds ?? []).includes(person._id);

  const emails = await getEmailsCached(ctx, caches, person._id);
  const raw = resolveSendAddress(person, emails);
  const email = raw ? normalizeEmail(raw) : null;

  let verdict: PersonExplanation["verdict"];
  if (!matchedAny) verdict = "no_match";
  else if (excluded) verdict = "excluded";
  else if (handPickExcluded) verdict = "hand_pick_excluded";
  else if (person.marketingOptOut === true) verdict = "opted_out";
  else if (!email) verdict = "no_address";
  else if (suppressedEmails.has(email)) verdict = "suppressed";
  else verdict = "recipient";

  return { verdict, groups, excludeGroups, handPicked };
}

// ── Resolution ──────────────────────────────────────────────────────────────

export interface TargetingResolution {
  raw: { email: string; name?: string }[];
  excludedOptOut: number;
  centralFallbackEmails: Set<string>;
  unlinkedGuests: number;
  unlinkedGuestsIsLowerBound: boolean;
  handPickedUnverified: number;
  /** Members removed by `excludeGroups` — surfaced through the SAME
   *  `excludedByFilters` preview/resolution field the legacy `excludeFilters`
   *  uses (one number, one UI slot, whichever model the row is on). */
  excludedByGroups: number;
  handPickedExcludedByGroups: number;
  /** Per-include-group match counts over the candidate pool (people +
   *  fallback donors) — DIAGNOSTIC-ONLY (empty unless `includeDiagnostics`):
   *  groups overlap, so the sum can exceed the deduped total; the UI labels
   *  that. */
  perGroupCounts: number[];
  /** Per-exclude-group counts of union members each one removed —
   *  DIAGNOSTIC-ONLY, same gating. */
  perExcludeGroupCounts: number[];
  /** email → include-group indexes that matched (sample tagging) —
   *  DIAGNOSTIC-ONLY, same gating. A plain Record (not a Map) so the whole
   *  resolution stays a valid Convex value end to end. */
  matchedGroupsByEmail: Record<string, number[]>;
}

/**
 * Resolve a `targeting` audience to its raw (pre-suppression) recipient set —
 * the v2 counterpart of `audienceResolve.ts#resolvePersonFilters`, called
 * ONLY from `resolveAudienceRecipients` (which owns dedupe-by-email ordering,
 * the suppression pass, the overall cap, and the shared result shape).
 *
 * Order of operations (spec §"Audience"): (∪ include groups over the scanned
 * people pool, + the gated central-donor fallback) ∪ `includePersonIds` →
 * minus anyone matching ANY exclude group (beats hand-pick include — counted)
 * → minus `excludePersonIds` → minus `marketingOptOut` (counted; a hand-pick
 * is never consent) → caller applies suppression + cap. When
 * `includeDiagnostics` is false, group evaluation short-circuits at the first
 * matching include group; when true, every include group is evaluated per
 * candidate so `perGroupCounts`/`matchedGroupsByEmail` are exact (the extra
 * cost is bounded by the per-person caches — no lookup is ever paid twice).
 */
export async function resolveTargetingAudience(
  ctx: QueryCtx,
  audience: {
    scope: AudienceScope;
    targeting: AudienceTargeting;
    includePersonIds?: Id<"people">[];
    excludePersonIds?: Id<"people">[];
  },
  includeDiagnostics: boolean,
): Promise<TargetingResolution> {
  const { targeting } = audience;
  const now = Date.now();
  const includeIds = audience.includePersonIds ?? [];
  const includeIdSet = new Set(includeIds);
  const excludeIdSet = new Set(audience.excludePersonIds ?? []);
  const excludeGroups = targeting.excludeGroups ?? [];

  const donorIdx = await buildDonorIndex(ctx, audience.scope, targeting);
  const serviceIdx = await buildServiceIndex(ctx, targeting);
  const caches: PersonCaches = {
    rsvpsById: new Map(),
    seatsById: new Map(),
    emailsById: new Map(),
  };

  // ── Candidate scan: the audience's chapters' roster+contacts (same pool
  // rules as the legacy path: placeholders and inactive rows never match). ──
  const chapterIds =
    audience.scope === "central"
      ? (await listActiveChapters(ctx)).map((c) => c._id)
      : [audience.scope];

  const personById = new Map<Id<"people">, Doc<"people">>();
  const matchedGroupsById = new Map<Id<"people">, number[]>();
  const perGroupCounts = new Array<number>(targeting.groups.length).fill(0);

  for (const chapterId of chapterIds) {
    const rows = await ctx.db
      .query("people")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .take(PEOPLE_PER_CHAPTER_LIMIT);
    for (const p of rows) {
      if (p.isPlaceholder === true) continue;
      if (p.status === "inactive") continue;
      personById.set(p._id, p);
      const matched: number[] = [];
      for (let gi = 0; gi < targeting.groups.length; gi++) {
        if (await personMatchesGroup(ctx, p, targeting.groups[gi], donorIdx, serviceIdx, caches, now, false)) {
          matched.push(gi);
          perGroupCounts[gi]++;
          if (!includeDiagnostics) break;
        }
      }
      if (matched.length > 0) matchedGroupsById.set(p._id, matched);
    }
  }

  // ── Central-donor fallback (gated — see the module doc): an unlinked
  // central donor row is admitted only by an include group that carries at
  // least one donor-derived condition. ──
  const admittedFallbackDonors: { d: Doc<"donors">; groups: number[] }[] = [];
  for (const d of donorIdx.centralFallbackDonors) {
    const matched: number[] = [];
    for (let gi = 0; gi < targeting.groups.length; gi++) {
      const g = targeting.groups[gi];
      if (!g.conditions.some(isDonorCondition)) continue;
      if (fallbackDonorMatchesGroup(d, g, donorIdx, now, false)) {
        matched.push(gi);
        perGroupCounts[gi]++;
        if (!includeDiagnostics) break;
      }
    }
    if (matched.length > 0) admittedFallbackDonors.push({ d, groups: matched });
  }

  // Diagnostic: unlinked historical rsvps a positive attendance condition
  // can never see (no `personId` → invisible to `by_person`).
  const { count: unlinkedGuests, isLowerBound: unlinkedGuestsIsLowerBound } = includeDiagnostics
    ? await countUnlinkedGuestsForTargeting(ctx, targeting, new Set(chapterIds), now)
    : { count: 0, isLowerBound: false };

  // ── Exclude groups over the union (matched people ∪ hand-picked includes),
  // then hand-picked excludes, then consent — same ordering as the legacy
  // path, group-shaped. ──
  const unionIds = new Set<Id<"people">>([...matchedGroupsById.keys(), ...includeIds]);
  const perExcludeGroupCounts = new Array<number>(excludeGroups.length).fill(0);
  let excludedByGroups = 0;
  let handPickedExcludedByGroups = 0;

  const survivingIds: Id<"people">[] = [];
  for (const id of unionIds) {
    let person = personById.get(id);
    if (!person) {
      const fetched = await ctx.db.get(id);
      if (!fetched || fetched.isPlaceholder === true) continue;
      personById.set(id, fetched);
      person = fetched;
    }
    let excluded = false;
    for (let gi = 0; gi < excludeGroups.length; gi++) {
      if (await personMatchesGroup(ctx, person, excludeGroups[gi], donorIdx, serviceIdx, caches, now, true)) {
        if (!excluded) {
          excluded = true;
          excludedByGroups++;
          if (includeDiagnostics && includeIdSet.has(id)) handPickedExcludedByGroups++;
        }
        perExcludeGroupCounts[gi]++;
        if (!includeDiagnostics) break;
      }
    }
    if (!excluded) survivingIds.push(id);
  }

  // ── Resolve survivors to send addresses (consent gates uniform regardless
  // of provenance — a hand-pick is never consent). ──
  const anyIncludeGroupChecksVerified = targeting.groups.some((g) =>
    g.conditions.some((c) => c.field === "email_verified"),
  );
  const byEmail = new Map<string, { email: string; name?: string }>();
  const matchedGroupsByEmail: Record<string, number[]> = {};
  let excludedOptOut = 0;
  let handPickedUnverified = 0;

  for (const id of survivingIds) {
    if (excludeIdSet.has(id)) continue;
    const person = personById.get(id)!;

    // Same data-trust signal as the legacy `handPickedUnverified`: a
    // hand-pick bypasses include-side conditions (including
    // `email_verified`), so when some include group checks it, surface every
    // hand-pick-only member whose resolved address isn't verified.
    if (anyIncludeGroupChecksVerified && !matchedGroupsById.has(id)) {
      const emails = await getEmailsCached(ctx, caches, id);
      if (!resolvedAddressIsVerified(person, emails)) handPickedUnverified++;
    }

    if (person.marketingOptOut === true) {
      excludedOptOut++;
      continue;
    }
    const emails = await getEmailsCached(ctx, caches, id);
    const raw = resolveSendAddress(person, emails);
    const email = raw ? normalizeEmail(raw) : null;
    if (!email || byEmail.has(email)) continue;
    byEmail.set(email, { email, name: person.name });
    if (includeDiagnostics) {
      matchedGroupsByEmail[email] = matchedGroupsById.get(id) ?? [];
    }
  }

  // ── Fallback donors: exclude groups reach them too (uniform rule — see the
  // module doc), then straight to recipients (no person row → no opt-out to
  // check; suppression still applies in the caller, as always). ──
  const centralFallbackEmails = new Set<string>();
  for (const { d, groups } of admittedFallbackDonors) {
    let excluded = false;
    for (let gi = 0; gi < excludeGroups.length; gi++) {
      if (fallbackDonorMatchesGroup(d, excludeGroups[gi], donorIdx, now, true)) {
        if (!excluded) {
          excluded = true;
          excludedByGroups++;
        }
        perExcludeGroupCounts[gi]++;
        if (!includeDiagnostics) break;
      }
    }
    if (excluded) continue;
    const email = normalizeEmail(d.email);
    if (!email || byEmail.has(email)) continue;
    byEmail.set(email, { email, name: d.name });
    centralFallbackEmails.add(email);
    if (includeDiagnostics) matchedGroupsByEmail[email] = groups;
  }

  return {
    raw: [...byEmail.values()],
    excludedOptOut,
    centralFallbackEmails,
    unlinkedGuests,
    unlinkedGuestsIsLowerBound,
    handPickedUnverified,
    excludedByGroups,
    handPickedExcludedByGroups,
    perGroupCounts: includeDiagnostics ? perGroupCounts : [],
    perExcludeGroupCounts: includeDiagnostics ? perExcludeGroupCounts : [],
    matchedGroupsByEmail,
  };
}
