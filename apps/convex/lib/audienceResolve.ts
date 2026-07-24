/**
 * Audience resolution — the pure(ish) `QueryCtx` logic behind `audiences.ts`'s
 * `previewAudience` and `campaigns.ts`'s send-time materialization (via
 * `audiences.ts#resolveAudienceForSend`, the internalQuery wrapper actions
 * call through `ctx.runQuery`). One function per `source`
 * (`schema/campaigns.ts#AUDIENCE_SOURCES`), fanned out to a shared shape.
 *
 * Every scan here is BOUNDED (`.take()`, never `.collect()`) and capped —
 * these can be large tables. `AUDIENCE_RESOLVE_LIMIT` is the overall
 * recipient cap for both preview and send: a preview's `count` and a real
 * send's recipient list are both capped at this number, documented rather
 * than silently truncated (`AudienceResolution.truncated`/`truncatedCount`).
 * Suppressed addresses (`emailSuppressions`) are ALWAYS dropped, and the raw
 * source rows are ALWAYS deduped by normalized email before that cap is
 * applied — the per-source resolvers (`resolveGuests`/`resolveDonors`/
 * `resolvePeople`) themselves are NOT limit-aware; they run to completion
 * against their own already-bounded per-chapter/per-scope sub-limits
 * (`EVENTS_PER_CHAPTER_LIMIT` etc. below), and `resolveAudienceRecipients`
 * applies `AUDIENCE_RESOLVE_LIMIT` once, at the very end, against the full
 * deduped+suppression-filtered set — the only way to report an honest
 * `truncatedCount` instead of an early-exit guess.
 *
 * Every read in this file uses `.take()`/`.collect()` on an indexed query,
 * NEVER `.paginate()` — deliberately: Convex's runtime allows at most ONE
 * `.paginate()` call per query/mutation execution (learned the hard way from
 * migration 0039's production-only failure — `convex-test` doesn't enforce
 * this, so it's invisible to the local/CI suite), and `previewAudience` /
 * `resolveAudienceForSend` are both plain queries that need to run to
 * completion in ONE call. `.take()` against a bounded per-scope/per-chapter/
 * per-person cap is exempt from that constraint and is the house pattern
 * here for exactly that reason — keep it that way; do not introduce
 * `.paginate()` into this file.
 *
 * Data-trust TRANSPARENCY counters (`unlinkedGuests`,
 * `centralDonorsExcludedByChapterFilter`) are each an EXTRA bounded scan on
 * top of the above — real, but only worth paying for in a live composer
 * preview. `resolveAudienceRecipients`'s `includeDiagnostics` flag (default
 * `false`) gates both: `previewAudience` passes `true`;
 * `resolveAudienceForSend` and `campaigns.ts#liveAudienceCount` do not, so a
 * real send or a polled live count never carries the extra read cost (see
 * `resolveAudienceRecipients`'s doc — the read-budget incident class hotfix
 * #414 addressed).
 */
import type { Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { DAY_MS } from "@events-os/shared";
import { normalizeEmail } from "./access";
import { listActiveChapters } from "./chapters";
import { suppressedEmailSet } from "../emailSuppressions";
import { resolveSendAddress } from "./personEmails";
import type { audienceFiltersValidator } from "../schema/campaigns";
import { PLEDGE_STATUSES } from "../schema/givingPlatform";

export type AudienceFilters = Infer<typeof audienceFiltersValidator>;
export type AudienceScope = Id<"chapters"> | "central";
export type AudienceSource = "guests" | "donors" | "people" | "person_filters";

export interface ResolvedRecipient {
  email: string;
  name?: string;
}

export interface AudienceResolution {
  recipients: ResolvedRecipient[];
  /** How many otherwise-matching rows were dropped for being on the
   *  deployment-wide suppression list (`emailSuppressions`). */
  excludedSuppressed: number;
  /** Guests only: how many matching RSVPs were dropped for
   *  `emailVerified === false`. Always 0 for donors/people/person_filters. */
  excludedUnverified: number;
  /** `person_filters` AND `people`: how many matched people — via FILTER
   *  match, hand-pick, or both (`person_filters`), or the legacy roster scan
   *  (`people`) — were dropped for `marketingOptOut === true`. Both sources
   *  now count this explicitly (previously `people` dropped these rows with
   *  no preview signal at all — a silent-shrink bug, not a design choice; see
   *  `resolvePeople`'s doc). Always 0 for guests/donors (address-shaped
   *  legacy sources that never consult a person row). */
  excludedOptOut: number;
  /** `person_filters` at `scope === "central"` only: how many of the final
   *  `recipients` came from an UNLINKED central `donors` row matched by a
   *  donor-derived filter (spec §3.4's fallback) rather than a real `people`
   *  row — central donors have no chapter roster to link into by design, so
   *  this is the honest "N central donors (unlinked)" count, not a silent
   *  fold-in. Always 0 for every other source/scope. */
  unlinkedCentralDonors: number;
  /** `donors`/`person_filters` only, when `scope === "central"` AND
   *  `filters.chapterId` is set AND a donor criterion is active
   *  (`hasDonorCriteria`): `targetDonorScopes` narrows to JUST that chapter
   *  the moment `chapterId` is set — even for a central-scoped audience —
   *  which means the org-wide `"central"` donor pool is never scanned at all
   *  for that resolution (product ruling: correct, a chapter filter means
   *  that chapter). This is how many `"central"`-scope donors WOULD have
   *  matched — using whichever criteria THAT source actually honors (the
   *  legacy `donors` resolver only ever applies `donorStatus`/
   *  `gaveWithinDays`; `person_filters` applies the full Phase-3 set — see
   *  `countCentralDonorsExcludedByChapterFilter`'s doc) — had the pool been
   *  scanned. DIAGNOSTIC-ONLY (see `resolveAudienceRecipients`'s
   *  `includeDiagnostics` doc): always 0 unless the caller opted in. Always 0
   *  otherwise. */
  centralDonorsExcludedByChapterFilter: number;
  /** `person_filters` only, when an attendance criterion
   *  (`attendedEventId`/`attendedWithinDays`/`rsvpStatus`) is set: how many
   *  non-archived `rsvps` rows matching those criteria have NO `personId`
   *  (pre-Phase-1 rows, or a chapter whose migration 0037 backfill hasn't run
   *  yet) — these guests can never match via `rsvps.by_person`
   *  (`personAttendsMatch`), so they silently never appear in an
   *  attendance-filtered audience with no signal today. See
   *  `countUnlinkedGuests`'s doc for the bounded-read shape.
   *  DIAGNOSTIC-ONLY (see `resolveAudienceRecipients`'s `includeDiagnostics`
   *  doc): always 0 unless the caller opted in. Always 0 when no attendance
   *  criterion is set, and always 0 for every other source. */
  unlinkedGuests: number;
  /** True when `unlinkedGuests` hit its scan cap without exhausting every
   *  matching unlinked row — i.e. `unlinkedGuests` is a LOWER bound, not an
   *  exact count. Always false when `unlinkedGuests` is 0. */
  unlinkedGuestsIsLowerBound: boolean;
  /** `person_filters` only, when `filters.verifiedEmailOnly` is set: how many
   *  people reached the final recipient set ONLY via `includePersonIds` (a
   *  hand-pick, which deliberately bypasses `verifiedEmailOnly` as a FILTER
   *  criterion — see `resolvePersonFilters`'s doc) whose resolved send
   *  address (`resolveSendAddress`) is itself NOT a verified `personEmails`
   *  row — i.e. they'd have failed `verifiedEmailOnly` had they not been
   *  hand-picked. Surfaced so an author sees exactly who's bypassing the
   *  consent-adjacent signal, without actually excluding them (hand-picks are
   *  intentional curation). Always 0 for every other source or when
   *  `verifiedEmailOnly` is unset. */
  handPickedUnverified: number;
  /** `person_filters` only: how many people who would otherwise be members
   *  (matched `filters`, were hand-picked via `includePersonIds`, or both)
   *  were removed because they satisfy every SET `excludeFilters` criterion
   *  — the property-level counterpart of `excludePersonIds`. A PRIMARY
   *  number, like `excludedOptOut`, NOT gated behind `includeDiagnostics`:
   *  it costs nothing extra (evaluated only against candidates the
   *  resolution already loaded — see `resolvePersonFilters`'s doc), so a
   *  real send materializes the exact same exclusion a preview showed.
   *  Always 0 when `excludeFilters` is unset or has no criteria set (a
   *  no-op, not "exclude everyone" — an empty `filters` object means "match
   *  everyone," but an empty `excludeFilters` must never mean "exclude
   *  everyone"). */
  excludedByFilters: number;
  /** `person_filters` only: of `excludedByFilters`, how many were ALSO a
   *  hand-picked `includePersonIds` member — i.e. cases where an explicit
   *  property exclusion beat a manual include (curation is not exemption
   *  from an exclusion; see `resolvePersonFilters`'s doc). DIAGNOSTIC-ONLY
   *  (see `resolveAudienceRecipients`'s `includeDiagnostics` doc): always 0
   *  unless the caller opted in, mirroring `unlinkedGuests`/
   *  `centralDonorsExcludedByChapterFilter`. */
  handPickedExcludedByFilters: number;
  /** True when the deduped, suppression-filtered match count exceeded
   *  `limit` and `recipients` was truncated to it — surfaced (not silent) so
   *  a send/preview against an audience bigger than the cap says so. */
  truncated: boolean;
  /** How many otherwise-matching recipients were left out solely because of
   *  the cap (0 when `truncated` is false). */
  truncatedCount: number;
}

/** The overall recipient cap applied to both preview and send resolution —
 *  generously above any realistic single-audience size for this org, and
 *  documented (not silent) when it binds. */
export const AUDIENCE_RESOLVE_LIMIT = 5000;

const EVENTS_PER_CHAPTER_LIMIT = 300;
const RSVPS_PER_EVENT_LIMIT = 2000;
const DONORS_PER_SCOPE_LIMIT = 2000;
const GIFTS_PER_SCOPE_LIMIT = 5000;
const PEOPLE_PER_CHAPTER_LIMIT = 2000;
const PLEDGES_PER_SCOPE_LIMIT = 2000;
// A single person's own rsvp/seat history — small by construction (nobody
// RSVPs to, or holds a seat in, thousands of things), so a generous bound
// that's still a REAL cap (never `.collect()`) per the house query rules.
const RSVPS_PER_PERSON_LIMIT = 500;
const SEAT_ASSIGNMENTS_PER_PERSON_LIMIT = 200;
/** Cap for `countUnlinkedGuests`'s unscoped fallback scan (no `eventId` set —
 *  `rsvps` has no chapter or date index to bound by otherwise, see that
 *  function's doc). Deliberately small: this path only runs to produce a
 *  transparency counter, not the recipient list itself, so a lower-bound
 *  estimate capped here (flagged via `unlinkedGuestsIsLowerBound`) is an
 *  acceptable tradeoff against an unaffordable full scan. */
const UNLINKED_GUESTS_SCAN_CAP = 500;
/** Bound on `includePersonIds`/`excludePersonIds` — generous for a
 *  human-curated hand-pick list, enforced by `audiences.ts`'s create/update
 *  mutations (which reject an oversized list outright, rather than this
 *  resolver silently truncating someone's picks). Exported so both sides
 *  share one number. */
export const HAND_PICK_LOOKUP_LIMIT = 2000;

/** The chapters a `guests`/`people` resolution fans out across: just
 *  `filters.chapterId` when set, else every active chapter. */
async function targetChapterIds(
  ctx: QueryCtx,
  filters: AudienceFilters,
): Promise<Id<"chapters">[]> {
  if (filters.chapterId) return [filters.chapterId];
  const chapters = await listActiveChapters(ctx);
  return chapters.map((c) => c._id);
}

// ── guests ────────────────────────────────────────────────────────────────
//
// `resolveGuests`/`resolveDonors`/`resolvePeople` (this section through
// "people" below) are NOT dead code: `migrations/0040_migrate_legacy_
// audiences.ts` and `migrations/0041_migrate_guest_audiences.ts` between them
// move every pre-existing "people"/"donors" row, and every "guests" row that
// carries a specific `filters.eventId`, onto `person_filters` — but a
// "guests" row with no `eventId` ("attended anything, ever," across every
// event in scope) has no faithful `person_filters` equivalent today (see
// 0041's own doc) and keeps resolving through `resolveGuests` indefinitely.
// Do NOT delete these three resolvers (or their `AUDIENCE_SOURCES` literals)
// until zero legacy-sourced rows remain across every deployment — a
// follow-up PR, verified in prod, not this one.

async function resolveGuestEventIds(
  ctx: QueryCtx,
  filters: AudienceFilters,
): Promise<Id<"events">[]> {
  if (filters.eventId) return [filters.eventId];
  const chapterIds = await targetChapterIds(ctx, filters);
  const eventIds: Id<"events">[] = [];
  for (const chapterId of chapterIds) {
    const events = await ctx.db
      .query("events")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .take(EVENTS_PER_CHAPTER_LIMIT);
    for (const e of events) eventIds.push(e._id);
  }
  return eventIds;
}

/** All RSVPs across the target event(s): email present, `emailVerified !==
 *  false`, deduped by normalized email keeping the MOST-RECENTLY-UPDATED
 *  row's name (a guest who RSVP'd again with a corrected name wins). */
async function resolveGuests(
  ctx: QueryCtx,
  filters: AudienceFilters,
): Promise<{ raw: ResolvedRecipient[]; excludedUnverified: number }> {
  const eventIds = await resolveGuestEventIds(ctx, filters);
  const byEmail = new Map<string, { name?: string; updatedAt: number }>();
  let excludedUnverified = 0;
  for (const eventId of eventIds) {
    const rows: Doc<"rsvps">[] = await ctx.db
      .query("rsvps")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .take(RSVPS_PER_EVENT_LIMIT);
    for (const r of rows) {
      if (!r.email) continue;
      if (r.emailVerified === false) {
        excludedUnverified++;
        continue;
      }
      const email = normalizeEmail(r.email);
      if (!email) continue;
      const existing = byEmail.get(email);
      if (!existing || r.updatedAt > existing.updatedAt) {
        byEmail.set(email, { name: r.name, updatedAt: r.updatedAt });
      }
    }
  }
  return {
    raw: [...byEmail.entries()].map(([email, v]) => ({ email, name: v.name })),
    excludedUnverified,
  };
}

// ── donors ────────────────────────────────────────────────────────────────

/** The scopes a `donors` resolution fans out across: `filters.chapterId` when
 *  set; else, for a central-scoped audience, every active chapter PLUS the
 *  `"central"` sentinel (org-wide); else just the audience's own chapter. */
async function targetDonorScopes(
  ctx: QueryCtx,
  audience: { scope: AudienceScope; filters: AudienceFilters },
): Promise<AudienceScope[]> {
  if (audience.filters.chapterId) return [audience.filters.chapterId];
  if (audience.scope === "central") {
    const chapters = await listActiveChapters(ctx);
    return [...chapters.map((c) => c._id), "central"];
  }
  return [audience.scope];
}

async function resolveDonors(
  ctx: QueryCtx,
  audience: { scope: AudienceScope; filters: AudienceFilters },
): Promise<ResolvedRecipient[]> {
  const scopes = await targetDonorScopes(ctx, audience);
  const { donorStatus, gaveWithinDays } = audience.filters;

  // "Has given in the last N days" is a rolling window computed at resolution
  // time (not a frozen timestamp on the audience) — pre-filter to a donorId
  // set via a bounded `by_scope_and_received` range scan per scope.
  let recentGiftDonorIds: Set<Id<"donors">> | null = null;
  if (gaveWithinDays != null) {
    const sinceTs = Date.now() - gaveWithinDays * DAY_MS;
    recentGiftDonorIds = new Set();
    for (const scope of scopes) {
      const gifts = await ctx.db
        .query("gifts")
        .withIndex("by_scope_and_received", (q) =>
          q.eq("scope", scope).gte("receivedAt", sinceTs),
        )
        .take(GIFTS_PER_SCOPE_LIMIT);
      for (const g of gifts) recentGiftDonorIds.add(g.donorId);
    }
  }

  const byEmail = new Map<string, ResolvedRecipient>();
  for (const scope of scopes) {
    const donors: Doc<"donors">[] = donorStatus
      ? await ctx.db
          .query("donors")
          .withIndex("by_scope_and_status", (q) =>
            q.eq("scope", scope).eq("status", donorStatus),
          )
          .take(DONORS_PER_SCOPE_LIMIT)
      : await ctx.db
          .query("donors")
          .withIndex("by_scope", (q) => q.eq("scope", scope))
          .take(DONORS_PER_SCOPE_LIMIT);
    for (const d of donors) {
      if (!d.email) continue;
      if (recentGiftDonorIds && !recentGiftDonorIds.has(d._id)) continue;
      const email = normalizeEmail(d.email);
      if (!email || byEmail.has(email)) continue;
      byEmail.set(email, { email, name: d.name });
    }
  }
  return [...byEmail.values()];
}

// ── people ────────────────────────────────────────────────────────────────

async function resolvePeople(
  ctx: QueryCtx,
  filters: AudienceFilters,
): Promise<{ raw: ResolvedRecipient[]; excludedOptOut: number }> {
  const chapterIds = await targetChapterIds(ctx, filters);
  const byEmail = new Map<string, ResolvedRecipient>();
  let excludedOptOut = 0;
  for (const chapterId of chapterIds) {
    const rows: Doc<"people">[] = await ctx.db
      .query("people")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .take(PEOPLE_PER_CHAPTER_LIMIT);
    for (const p of rows) {
      if (p.isPlaceholder === true) continue;
      // Person-centric audiences Phase 1 — a contact-only row (auto-created
      // from a donor gift, an import, or a public RSVP; see
      // `lib/org.ts#excludeContacts`'s doc) is NOT what an admin means by the
      // "People" audience source: it preserves the pre-Phase-1 behavior where
      // this source was implicitly roster-only. Contacts become reachable
      // deliberately once Phase 3's filter model (specs/person-centric-
      // audiences.md) lands, via an explicit criterion — never silently
      // folded into the legacy roster-shaped source.
      if (p.isContactOnly === true) continue;
      if (p.status === "inactive") continue;
      // Person-centric audiences Phase 2 (specs/person-centric-audiences.md
      // Phase 2 item 3) — a person-level marketing opt-out excludes them from
      // this source ENTIRELY, layered OVER the address-level
      // `emailSuppressions` ledger below (which stays authoritative and
      // untouched — this is an ADDITIONAL exclusion, never a replacement).
      // Counted via `excludedOptOut` — same signal `resolvePersonFilters`
      // already surfaces, previously a silent drop on this legacy path (data-
      // trust fix: the two sources must explain their counts consistently).
      if (p.marketingOptOut === true) {
        excludedOptOut++;
        continue;
      }
      // Phase 2 item 2 — the chosen send address now comes from
      // `resolveSendAddress` (explicit primary > pwEmail > email > most-
      // recently-added verified `personEmails` row), falling back to the
      // pre-Phase-2 `pwEmail ?? email` behavior automatically when this
      // person has no `personEmails` rows yet (pre-backfill or a row created
      // outside every write-through path).
      const personEmails = await ctx.db
        .query("personEmails")
        .withIndex("by_person", (q) => q.eq("personId", p._id))
        .collect();
      const raw = resolveSendAddress(p, personEmails);
      const email = raw ? normalizeEmail(raw) : null;
      if (!email || byEmail.has(email)) continue;
      byEmail.set(email, { email, name: p.name });
    }
  }
  return { raw: [...byEmail.values()], excludedOptOut };
}

// ── person_filters (Phase 3 — specs/person-centric-audiences.md) ───────────

/** Same shape `targetChapterIds` produces, but SCOPE-AWARE (unlike that
 *  legacy helper, which every pre-Phase-3 source deliberately ignores scope
 *  for): a chapter-scoped `person_filters` audience targets THAT chapter's
 *  roster/contacts, not the whole fleet — mirroring `targetDonorScopes`'s
 *  scope-respecting fan-out instead. `filters.chapterId` still wins outright
 *  when set (narrows even a central-scoped audience to one chapter, the same
 *  override every source already honors). */
async function targetPersonFilterChapters(
  ctx: QueryCtx,
  audience: { scope: AudienceScope; filters: AudienceFilters },
): Promise<Id<"chapters">[]> {
  if (audience.filters.chapterId) return [audience.filters.chapterId];
  if (audience.scope !== "central") return [audience.scope];
  const chapters = await listActiveChapters(ctx);
  return chapters.map((c) => c._id);
}

/** True iff `personId` has at least one non-archived `rsvps` row satisfying
 *  every ATTENDANCE criterion that's actually SET on `filters`
 *  (`attendedEventId`/`attendedWithinDays`/`rsvpStatus` — a single row must
 *  satisfy all of them together, not one criterion per row). Reads via the
 *  Phase 3 `rsvps.by_person` index (schema/ticketing.ts), bounded. */
async function personAttendsMatch(
  ctx: QueryCtx,
  personId: Id<"people">,
  filters: AudienceFilters,
): Promise<boolean> {
  const rows = await ctx.db
    .query("rsvps")
    .withIndex("by_person", (q) => q.eq("personId", personId))
    .take(RSVPS_PER_PERSON_LIMIT);
  const cutoff =
    filters.attendedWithinDays != null ? Date.now() - filters.attendedWithinDays * DAY_MS : null;
  for (const r of rows) {
    if (r.archivedAt !== undefined) continue; // archived rows never count as attendance
    if (filters.attendedEventId && r.eventId !== filters.attendedEventId) continue;
    if (cutoff !== null && r.createdAt < cutoff) continue;
    if (filters.rsvpStatus && r.status !== filters.rsvpStatus) continue;
    return true;
  }
  return false;
}

/**
 * Data-trust counter (top-priority fix): how many `rsvps` rows match every
 * SET attendance criterion (`attendedEventId`/`attendedWithinDays`/
 * `rsvpStatus` — same predicate `personAttendsMatch` applies, just against
 * the raw row instead of a specific person) but have NO `personId` — i.e.
 * historical/unlinked guests (migration 0037 not yet run, or a guest who
 * never matched into a `people` row) that `personAttendsMatch`'s
 * `rsvps.by_person` lookup can never see, so they silently never match an
 * attendance-filtered `person_filters` audience today. Archived rows are
 * excluded, mirroring `personAttendsMatch`.
 *
 * DIAGNOSTIC-ONLY, caller-gated: `resolvePersonFilters` only calls this when
 * `includeDiagnostics` is true (preview only — see
 * `resolveAudienceRecipients`'s doc). A real send or `liveAudienceCount`
 * must never pay for this extra bounded scan on top of everything else it
 * already reads.
 *
 * Bounded reads, ONE scan for the whole call:
 *  - `attendedEventId` set: the SAME `rsvps.by_event` index/cap
 *    (`RSVPS_PER_EVENT_LIMIT`) `resolveGuests` (the legacy source) already
 *    uses for that event — exhaustive for that event unless the cap itself
 *    binds (flagged via the cap-hit check below, same shape as everywhere
 *    else in this file).
 *  - `attendedEventId` unset (only `attendedWithinDays`/`rsvpStatus`): `rsvps`
 *    has no chapter or date index (`schema/ticketing.ts`), so a full scan is
 *    unaffordable for what's only a transparency counter. Take a capped,
 *    most-recent-first slice (`UNLINKED_GUESTS_SCAN_CAP`) instead and report
 *    the result as a LOWER bound when the cap binds — an honest
 *    underestimate beats no signal at all.
 *
 * `chapterIds` scopes the count to the same chapters the caller's own
 * resolution fans across (`targetPersonFilterChapters`) — an org-wide central
 * audience still sees every chapter's unlinked guests; a chapter-scoped one
 * doesn't get inflated by other chapters' rows.
 */
async function countUnlinkedGuests(
  ctx: QueryCtx,
  filters: AudienceFilters,
  chapterIds: Set<Id<"chapters">>,
): Promise<{ count: number; isLowerBound: boolean }> {
  const hasAttendanceCriteria =
    filters.attendedEventId != null || filters.attendedWithinDays != null || filters.rsvpStatus != null;
  if (!hasAttendanceCriteria) return { count: 0, isLowerBound: false };

  const cutoff =
    filters.attendedWithinDays != null ? Date.now() - filters.attendedWithinDays * DAY_MS : null;

  const matches = (r: Doc<"rsvps">): boolean => {
    if (r.personId !== undefined) return false; // linked — not the unlinked-guest gap
    if (r.archivedAt !== undefined) return false;
    if (!chapterIds.has(r.chapterId)) return false;
    if (filters.attendedEventId && r.eventId !== filters.attendedEventId) return false;
    if (cutoff !== null && r.createdAt < cutoff) return false;
    if (filters.rsvpStatus && r.status !== filters.rsvpStatus) return false;
    return true;
  };

  if (filters.attendedEventId) {
    const rows = await ctx.db
      .query("rsvps")
      .withIndex("by_event", (q) => q.eq("eventId", filters.attendedEventId!))
      .take(RSVPS_PER_EVENT_LIMIT);
    let count = 0;
    for (const r of rows) if (matches(r)) count++;
    return { count, isLowerBound: rows.length >= RSVPS_PER_EVENT_LIMIT };
  }

  const rows = await ctx.db.query("rsvps").order("desc").take(UNLINKED_GUESTS_SCAN_CAP);
  let count = 0;
  for (const r of rows) if (matches(r)) count++;
  return { count, isLowerBound: rows.length >= UNLINKED_GUESTS_SCAN_CAP };
}

/** True iff `personId` holds ANY `seatAssignments` row for `seatId` — see the
 *  schema doc on `audienceFiltersValidator.seatId` for why scope is
 *  deliberately ignored here. */
async function personHoldsSeat(
  ctx: QueryCtx,
  personId: Id<"people">,
  seatId: Id<"seatDefs">,
): Promise<boolean> {
  const assignments = await ctx.db
    .query("seatAssignments")
    .withIndex("by_person", (q) => q.eq("personId", personId))
    .take(SEAT_ASSIGNMENTS_PER_PERSON_LIMIT);
  return assignments.some((a) => a.seatDefId === seatId);
}

/** True iff the address `resolveSendAddress` would ACTUALLY pick for `person`
 *  has its own verified `personEmails` row — the fix for a data-trust bug:
 *  the filter used to pass anyone with ANY verified `personEmails` row
 *  (`hasAnyVerifiedEmail`, since removed), even when `resolveSendAddress`
 *  picks a DIFFERENT, unverified address (`pwEmail`/`person.email` outrank a
 *  verified `personEmails` row in the precedence — see `personEmails.ts`'s
 *  doc). `verifiedEmailOnly` is meant to gate what's actually SENT TO, so it
 *  must check the resolved address itself, not merely "this person has some
 *  verified address on file somewhere." */
function resolvedAddressIsVerified(
  person: Pick<Doc<"people">, "email" | "pwEmail">,
  emails: Doc<"personEmails">[],
): boolean {
  const raw = resolveSendAddress(person, emails);
  const email = raw ? normalizeEmail(raw) : null;
  if (!email) return false;
  return emails.some((e) => e.email === email && e.verified === true);
}

/** Cache-through `personEmails` lookup shared by `resolvePersonFilters`'s two
 *  passes (the filter check and the final address resolution) — avoids
 *  re-fetching the same person's rows twice. */
async function getEmailsCached(
  ctx: QueryCtx,
  cache: Map<Id<"people">, Doc<"personEmails">[]>,
  personId: Id<"people">,
): Promise<Doc<"personEmails">[]> {
  const cached = cache.get(personId);
  if (cached) return cached;
  const emails = await ctx.db
    .query("personEmails")
    .withIndex("by_person", (q) => q.eq("personId", personId))
    .collect();
  cache.set(personId, emails);
  return emails;
}

/** True iff any donor-derived criterion is present on `filters` — gates
 *  whether `resolvePersonFilters` scans `donors`/`pledges` at all (an empty
 *  person_filters audience, or one with only attendance/role/type criteria,
 *  never touches the giving tables). */
function hasDonorCriteria(filters: AudienceFilters): boolean {
  return (
    filters.givingLifetimeMinCents != null ||
    filters.givingLifetimeMaxCents != null ||
    filters.giftCountMin != null ||
    filters.gaveWithinDays != null ||
    filters.donorStatus != null ||
    filters.backerStatus != null
  );
}

/**
 * Donor-derived matching for `person_filters`: scans `donors` (+ `pledges`
 * for `backerStatus`) across the SAME scopes `resolveDonors`'s legacy path
 * fans across (`targetDonorScopes` — chapter fan-out, plus the `"central"`
 * sentinel when `audience.scope === "central"`), and buckets every donor row
 * that matches every SET criterion into either:
 *  - `matchedPersonIds` — the row has a linked `people` row (the normal,
 *    Phase-1-backfilled case for every chapter donor); or
 *  - `centralFallbackDonors` — the row has NO linked person AND is itself
 *    `scope: "central"` (permanently unlinked by design, spec §3.4) — these
 *    become their OWN recipients (email/name straight off the donor row,
 *    the `resolveDonors` legacy shape) rather than being silently dropped.
 * A chapter donor with no `personId` (a rare gap: `linkDonorToPerson` never
 * inserts without an email/phone to match on — see `hasPersonIdentifier`) is
 * intentionally NOT a fallback case — that's a data-hygiene gap for a human
 * to link from the People tab, not a scope-shaped fallback this resolver
 * should paper over.
 *
 * `lifetimeCents`/`giftCount` are read straight off the donor row — the
 * denormalized, bumped-on-every-gift-write rollup (`schema/givingPlatform.ts`
 * doc) — rather than re-summed from `gifts` or pulled from the CROSS-CHAPTER
 * `donorIdentities` aggregate (which would double-count across the fan-out
 * for a giver active in more than one book). `gaveWithinDays` reads the same
 * donor row's `lastGiftAt` for the same reason: it's the authoritative max of
 * every gift's `receivedAt` for that scope, so `lastGiftAt >= cutoff` is
 * exactly "has given in the last N days" without a second `gifts` scan.
 */
/** `backerStatus`'s donorId → "has an active pledge" / "has ANY pledge on
 *  file" lookup, built once across `scopes` (bounded per scope, mirrors
 *  `resolveDonors`'s per-scope fan-out shape). Shared by `matchDonorFilters`
 *  and `countCentralDonorsExcludedByChapterFilter` so both apply the EXACT
 *  same `backerStatus` semantics — one rule, not two. Returns `null`/`null`
 *  when `backerStatus` isn't set (the pledges table is never scanned for a
 *  filter set that doesn't need it). */
async function buildPledgeIndexes(
  ctx: QueryCtx,
  scopes: AudienceScope[],
  filters: Pick<AudienceFilters, "backerStatus">,
): Promise<{
  activePledgeDonorIds: Set<Id<"donors">> | null;
  anyPledgeDonorIds: Set<Id<"donors">> | null;
}> {
  if (filters.backerStatus == null) return { activePledgeDonorIds: null, anyPledgeDonorIds: null };
  const activePledgeDonorIds = new Set<Id<"donors">>();
  const anyPledgeDonorIds = new Set<Id<"donors">>();
  for (const scope of scopes) {
    for (const status of PLEDGE_STATUSES) {
      const pledges = await ctx.db
        .query("pledges")
        .withIndex("by_scope_and_status", (q) => q.eq("scope", scope).eq("status", status))
        .take(PLEDGES_PER_SCOPE_LIMIT);
      for (const p of pledges) {
        anyPledgeDonorIds.add(p.donorId);
        if (status === "active") activePledgeDonorIds.add(p.donorId);
      }
    }
  }
  return { activePledgeDonorIds, anyPledgeDonorIds };
}

/** True iff donor row `d` satisfies every SET donor-derived criterion on
 *  `filters` — the per-donor predicate shared by `matchDonorFilters` (the
 *  real resolution) and `countCentralDonorsExcludedByChapterFilter` (the
 *  transparency counter for the pool `matchDonorFilters` never scans) so both
 *  apply the exact same rule. */
function donorMatchesFilters(
  d: Doc<"donors">,
  filters: AudienceFilters,
  pledgeIdx: {
    activePledgeDonorIds: Set<Id<"donors">> | null;
    anyPledgeDonorIds: Set<Id<"donors">> | null;
  },
  gaveCutoff: number | null,
): boolean {
  if (filters.givingLifetimeMinCents != null && d.lifetimeCents < filters.givingLifetimeMinCents) return false;
  if (filters.givingLifetimeMaxCents != null && d.lifetimeCents > filters.givingLifetimeMaxCents) return false;
  if (filters.giftCountMin != null && d.giftCount < filters.giftCountMin) return false;
  if (gaveCutoff !== null && (d.lastGiftAt == null || d.lastGiftAt < gaveCutoff)) return false;
  if (filters.backerStatus === "active" && !pledgeIdx.activePledgeDonorIds!.has(d._id)) return false;
  if (
    filters.backerStatus === "lapsed" &&
    !(pledgeIdx.anyPledgeDonorIds!.has(d._id) && !pledgeIdx.activePledgeDonorIds!.has(d._id))
  ) {
    return false;
  }
  return true;
}

async function matchDonorFilters(
  ctx: QueryCtx,
  audience: { scope: AudienceScope; filters: AudienceFilters },
): Promise<{ matchedPersonIds: Set<Id<"people">>; centralFallbackDonors: Doc<"donors">[] }> {
  const { filters } = audience;
  const scopes = await targetDonorScopes(ctx, audience);
  const pledgeIdx = await buildPledgeIndexes(ctx, scopes, filters);
  const gaveCutoff = filters.gaveWithinDays != null ? Date.now() - filters.gaveWithinDays * DAY_MS : null;

  const matchedPersonIds = new Set<Id<"people">>();
  const centralFallbackDonors: Doc<"donors">[] = [];
  for (const scope of scopes) {
    const donors: Doc<"donors">[] = filters.donorStatus
      ? await ctx.db
          .query("donors")
          .withIndex("by_scope_and_status", (q) => q.eq("scope", scope).eq("status", filters.donorStatus!))
          .take(DONORS_PER_SCOPE_LIMIT)
      : await ctx.db
          .query("donors")
          .withIndex("by_scope", (q) => q.eq("scope", scope))
          .take(DONORS_PER_SCOPE_LIMIT);

    for (const d of donors) {
      if (!donorMatchesFilters(d, filters, pledgeIdx, gaveCutoff)) continue;

      if (d.personId) {
        matchedPersonIds.add(d.personId);
      } else if (d.scope === "central" && audience.scope === "central" && d.email) {
        centralFallbackDonors.push(d);
      }
    }
  }

  return { matchedPersonIds, centralFallbackDonors };
}

/** True iff donor row `d` satisfies every criterion the LEGACY `donors`
 *  source resolver (`resolveDonors`) actually honors: `donorStatus` (already
 *  applied by the caller's index-query choice — never re-checked here) and
 *  `gaveWithinDays` (via `recentGiftDonorIds`, mirroring `resolveDonors`'s
 *  own `gifts` lookup), plus the same `!d.email` skip `resolveDonors` applies
 *  before a row can become a recipient at all. `resolveDonors` silently
 *  ignores every Phase-3-only criterion (`givingLifetimeMinCents`/`Max`,
 *  `giftCountMin`, `backerStatus`) — so
 *  `countCentralDonorsExcludedByChapterFilter`'s `"donors"`-source branch
 *  must ignore them too, or it reports a drop using criteria that were never
 *  actually applied (the exact mismatch a verifier caught: a `giftCountMin`
 *  filter that `resolveDonors` never enforces made the counter claim a
 *  0-gift donor was "excluded by the chapter filter" when in truth
 *  `giftCountMin` never touches this source at all). */
function donorMatchesLegacyCriteria(
  d: Doc<"donors">,
  recentGiftDonorIds: Set<Id<"donors">> | null,
): boolean {
  if (!d.email) return false;
  if (recentGiftDonorIds && !recentGiftDonorIds.has(d._id)) return false;
  return true;
}

/**
 * Data-trust counter (fix #3): `targetDonorScopes` narrows to JUST
 * `filters.chapterId` the instant it's set — even for a `scope: "central"`
 * audience — so the org-wide `"central"` donor pool is never scanned at all
 * once a chapter filter is added, and any central donor who'd have matched
 * the SAME donor criteria silently vanishes with no signal. Product ruling
 * (2026-07-24): don't include them (a chapter filter means that chapter) —
 * but DO count them, via one extra bounded `by_scope`/`by_scope_and_status`
 * scan of JUST the `"central"` pool.
 *
 * SOURCE-AWARE matching (fix for a verifier-caught bug): the two sources
 * that reach this function honor DIFFERENT criteria sets, so the count must
 * mirror whichever one is actually resolving —
 *  - `"person_filters"` — the full Phase-3 criteria, via `donorMatchesFilters`
 *    (the EXACT predicate `matchDonorFilters` applies for this source).
 *  - `"donors"` — ONLY what the legacy `resolveDonors` resolver honors
 *    (`donorStatus`/`gaveWithinDays`), via `donorMatchesLegacyCriteria`.
 *    Using the full Phase-3 predicate here would report a chapter-filter
 *    "exclusion" driven by criteria (`givingLifetimeMinCents`/`giftCountMin`/
 *    `backerStatus`) that `resolveDonors` never applies to ANY donor, chapter
 *    or central — actively misleading, not merely imprecise.
 *
 * DIAGNOSTIC-ONLY: only ever called when `includeDiagnostics` is true (see
 * `resolveAudienceRecipients`'s doc) — the send path and
 * `campaigns.ts#liveAudienceCount` never pay for this. Zero-cost even then
 * (no query at all) unless every one of the three gating conditions holds.
 */
async function countCentralDonorsExcludedByChapterFilter(
  ctx: QueryCtx,
  audience: { scope: AudienceScope; source: AudienceSource; filters: AudienceFilters },
): Promise<number> {
  const { scope, source, filters } = audience;
  if (scope !== "central" || !filters.chapterId || !hasDonorCriteria(filters)) return 0;

  const donors: Doc<"donors">[] = filters.donorStatus
    ? await ctx.db
        .query("donors")
        .withIndex("by_scope_and_status", (q) => q.eq("scope", "central").eq("status", filters.donorStatus!))
        .take(DONORS_PER_SCOPE_LIMIT)
    : await ctx.db
        .query("donors")
        .withIndex("by_scope", (q) => q.eq("scope", "central"))
        .take(DONORS_PER_SCOPE_LIMIT);

  if (source === "donors") {
    let recentGiftDonorIds: Set<Id<"donors">> | null = null;
    if (filters.gaveWithinDays != null) {
      const sinceTs = Date.now() - filters.gaveWithinDays * DAY_MS;
      recentGiftDonorIds = new Set();
      const gifts = await ctx.db
        .query("gifts")
        .withIndex("by_scope_and_received", (q) => q.eq("scope", "central").gte("receivedAt", sinceTs))
        .take(GIFTS_PER_SCOPE_LIMIT);
      for (const g of gifts) recentGiftDonorIds.add(g.donorId);
    }
    let count = 0;
    for (const d of donors) {
      if (donorMatchesLegacyCriteria(d, recentGiftDonorIds)) count++;
    }
    return count;
  }

  const pledgeIdx = await buildPledgeIndexes(ctx, ["central"], filters);
  const gaveCutoff = filters.gaveWithinDays != null ? Date.now() - filters.gaveWithinDays * DAY_MS : null;
  let count = 0;
  for (const d of donors) {
    if (donorMatchesFilters(d, filters, pledgeIdx, gaveCutoff)) count++;
  }
  return count;
}

/**
 * True iff `filters` has at least one criterion actually SET that is
 * EFFECTIVE for `excludeFilters` purposes — i.e. ignoring `verifiedEmailOnly`
 * entirely, since it's never evaluated when a filters object is used as an
 * `excludeFilters` block (see `personMatchesCriteria`'s doc: inside
 * `excludeFilters` it reads backwards — "exclude anyone whose address IS
 * verified" — a UX footgun the picker UI also removes from the exclude
 * section's chip groups; this function is the resolver-side belt to that
 * UI's suspenders). An `excludeFilters` object whose ONLY set field is
 * `verifiedEmailOnly` must therefore be treated exactly like an EMPTY one —
 * inert, never "matches everyone" (which is what a truly empty AND-block
 * would vacuously do — see the second half of this doc).
 *
 * Separately: an empty `filters` object is deliberately "match everyone"
 * (see `FilterChipsBuilder`'s "leave all off to target everyone" copy) —
 * but that same emptiness must mean the OPPOSITE thing for `excludeFilters`
 * ("exclude nobody," a no-op), never "exclude everyone." Every exclude-side
 * caller — this resolver, `audiences.ts`'s write-time normalizer (an
 * ineffective `excludeFilters` is stored as `undefined`, never `{}`), and
 * `campaigns.ts#computeCampaignSnapshotHash`'s key-omission — MUST use this
 * ONE function to decide "is excludeFilters actually doing something,"
 * rather than three different ad hoc checks that could drift apart.
 */
export function hasEffectiveExcludeCriteria(filters: AudienceFilters | undefined): boolean {
  if (!filters) return false;
  return Object.entries(filters).some(([key, value]) => key !== "verifiedEmailOnly" && value !== undefined);
}

/**
 * True iff `person` satisfies every criterion actually SET on `filters` —
 * the ONE per-criterion matcher `resolvePersonFilters` calls for BOTH the
 * include-side `filters` block and the exclude-side `excludeFilters` block,
 * so the two can never drift apart (property exclusions must mirror
 * inclusion's AND semantics exactly). `donorMatchedPersonIds` is the
 * donor/pledge match set for THIS SPECIFIC `filters` object (computed once
 * by the caller via `matchDonorFilters` — a fresh set per filters object,
 * since `filters` and `excludeFilters` can name entirely different donor
 * criteria). `personEmailsById` is the shared cache-through map so neither
 * block re-fetches a person's `personEmails` rows the other already loaded.
 *
 * `chapterId`/`teamOnly`/`contactsOnly` are checked directly against the
 * person row here (rather than relying on the caller's scan already being
 * pre-scoped to one chapter, the include side's historical shortcut) so this
 * matcher is correct standalone against ANY candidate, including one the
 * exclude side is re-checking outside its own chapter fan-out. For the
 * include side, where the scan IS already pre-scoped, this is a no-op
 * re-check (every scanned row already satisfies it) — see
 * `targetPersonFilterChapters`'s doc.
 *
 * `opts.evaluateVerifiedEmailOnly` (default `true`) — pass `false` when
 * calling this for the EXCLUDE block: `verifiedEmailOnly` reads backwards
 * there (see `hasEffectiveExcludeCriteria`'s doc), so it's skipped entirely
 * rather than contributing to the AND — never a reason a candidate is
 * excluded, never a reason a fallback donor stays. The include side keeps
 * the default (`true`), unchanged.
 */
async function personMatchesCriteria(
  ctx: QueryCtx,
  person: Doc<"people">,
  filters: AudienceFilters,
  ctxHelpers: {
    donorMatchedPersonIds: Set<Id<"people">>;
    personEmailsById: Map<Id<"people">, Doc<"personEmails">[]>;
  },
  opts: { evaluateVerifiedEmailOnly?: boolean } = {},
): Promise<boolean> {
  // ── Cheap-first: everything in this block is ZERO extra reads — a field
  // compare on `person` already in hand, or a `Set.has()` against a
  // donor/pledge match set the caller computed ONCE for the whole
  // resolution (see `resolvePersonFilters`) — checked before any per-person
  // indexed lookup so a candidate failing here short-circuits for free.
  // AND semantics: one cheap criterion failing already disqualifies the
  // match, so nothing below this block runs for it. ──
  if (filters.chapterId && person.chapterId !== filters.chapterId) return false;
  if (filters.teamOnly === true && person.isContactOnly === true) return false;
  if (filters.contactsOnly === true && person.isContactOnly !== true) return false;
  if (hasDonorCriteria(filters) && !ctxHelpers.donorMatchedPersonIds.has(person._id)) return false;

  // ── Per-person indexed lookups from here — each is a bounded, capped read
  // (`personAttendsMatch`: up to `RSVPS_PER_PERSON_LIMIT`; `personHoldsSeat`:
  // up to `SEAT_ASSIGNMENTS_PER_PERSON_LIMIT`), paid ONLY by a candidate that
  // survived every cheap check above. Worst case for a WHOLE exclude pass
  // (`resolvePersonFilters` phase 2a, one call per union member): (union
  // size) × (whichever per-person cap applies) reads — the exact same cost
  // SHAPE phase 1's include-side scan already pays per candidate; this
  // matcher is the ONE place both sides incur it, so there's nothing extra
  // to budget for beyond what the include side already accounts for. ──
  const hasAttendanceCriteria =
    filters.attendedEventId != null || filters.attendedWithinDays != null || filters.rsvpStatus != null;
  if (hasAttendanceCriteria && !(await personAttendsMatch(ctx, person._id, filters))) return false;
  if (filters.seatId && !(await personHoldsSeat(ctx, person._id, filters.seatId))) return false;

  if (opts.evaluateVerifiedEmailOnly !== false && filters.verifiedEmailOnly) {
    const emails = await getEmailsCached(ctx, ctxHelpers.personEmailsById, person._id);
    if (!resolvedAddressIsVerified(person, emails)) return false;
  }
  return true;
}

/**
 * Resolve a `person_filters` audience — the Phase 3 "robust filters + hand-
 * picked" model (specs/person-centric-audiences.md "Phase 3"), extended
 * with `excludeFilters` (property-level exclusions, "everyone matching X,
 * EXCEPT anyone matching Y" — `schema/campaigns.ts#audiences`'s doc). Order
 * of operations: `filters` AND-combine into a match set; `includePersonIds`
 * UNIONS in regardless of filter match; `excludeFilters` then removes anyone
 * (from that union) satisfying every SET exclude criterion — via
 * `personMatchesCriteria`, the SAME matcher `filters` itself uses, so
 * inclusion and exclusion can never apply different rules for the "same"
 * criterion; a hand-pick is not exemption from an explicit exclusion, so
 * this beats `includePersonIds` too; `excludePersonIds` always wins over
 * everything that's left. `marketingOptOut` (Phase 2) is checked for EVERY
 * final candidate REGARDLESS of how they entered the set — a hand-pick is
 * not consent (spec §3.3's non-negotiable invariant) — and is counted via
 * `excludedOptOut` rather than folded silently into `excludedSuppressed`.
 * `verifiedEmailOnly`, by contrast, is a FILTER criterion: on the INCLUDE
 * side it's only enforced against people who matched via FILTERS (a person
 * who is ALSO/ONLY hand-picked is never excluded by it); this function
 * documents that "hand-pick bypasses filter criteria, never bypasses
 * consent gates" split throughout — `excludeFilters` does NOT get this same
 * hand-pick exemption, by design (see the exclusion-beats-hand-pick rule
 * above).
 *
 * Read budget: `excludeFilters` is evaluated ONLY against the
 * `filterMatchedIds ∪ includeIds` union this function already built for the
 * include side — never a fresh scan of the people table. Its own
 * donor/pledge match set (when it has donor criteria) is a SECOND bounded
 * `matchDonorFilters` scan of the SAME already-bounded scopes the include
 * side scans (no new unbounded reads, no second `.paginate()` — this file
 * never uses `.paginate()` at all, see the module doc); attendance/seat/
 * verified-email criteria reuse the exact same per-person bounded helpers
 * (`personAttendsMatch`/`personHoldsSeat`/`resolvedAddressIsVerified`) the
 * include side already pays for.
 *
 * `includeDiagnostics` gates the DIAGNOSTIC-ONLY `unlinkedGuests` and
 * `handPickedExcludedByFilters` counters (an extra bounded scan for the
 * former; free but preview-only signal for the latter): true only from
 * `previewAudience`, false from the send path and `liveAudienceCount` — see
 * `resolveAudienceRecipients`'s doc. `excludedByFilters` itself is NOT
 * gated — like `excludedOptOut`, it's a primary count computed unconditionally
 * (candidates are already loaded, so it costs nothing extra) so a real send
 * and a preview always agree on how many were dropped.
 */
async function resolvePersonFilters(
  ctx: QueryCtx,
  audience: {
    scope: AudienceScope;
    filters: AudienceFilters;
    excludeFilters?: AudienceFilters;
    includePersonIds?: Id<"people">[];
    excludePersonIds?: Id<"people">[];
  },
  includeDiagnostics: boolean,
): Promise<{
  raw: ResolvedRecipient[];
  excludedOptOut: number;
  centralFallbackEmails: Set<string>;
  unlinkedGuests: number;
  unlinkedGuestsIsLowerBound: boolean;
  handPickedUnverified: number;
  excludedByFilters: number;
  handPickedExcludedByFilters: number;
}> {
  const { filters, excludeFilters } = audience;
  const includeIds = audience.includePersonIds ?? [];
  const includeIdSet = new Set(includeIds);
  const excludeSet = new Set(audience.excludePersonIds ?? []);
  const excludeFiltersActive = hasEffectiveExcludeCriteria(excludeFilters);

  const donorMatch = hasDonorCriteria(filters)
    ? await matchDonorFilters(ctx, audience)
    : { matchedPersonIds: new Set<Id<"people">>(), centralFallbackDonors: [] };

  // ── Phase 1: scan the target chapters' roster+contacts, evaluating every
  // SET filter criterion per candidate into `filterMatchedIds` via the
  // shared `personMatchesCriteria` matcher. `personEmailsById` is populated
  // as we go (only when `verifiedEmailOnly` needs it) so later phases never
  // re-fetch a row they already have. Filter criteria are deliberately
  // checked HERE, not in phase 2 — a candidate that fails them simply never
  // joins `filterMatchedIds`, so a hand-picked person (added to the final
  // set independently, in phase 2, via `includeIds`) is never excluded by a
  // FILTER criterion they didn't go through — see the function doc's
  // "hand-pick bypasses filter criteria" split (which does NOT apply to
  // `excludeFilters` — see phase 2a). ──
  const personEmailsById = new Map<Id<"people">, Doc<"personEmails">[]>();
  const personById = new Map<Id<"people">, Doc<"people">>();
  const filterMatchedIds = new Set<Id<"people">>();

  const chapterIds = await targetPersonFilterChapters(ctx, audience);
  for (const chapterId of chapterIds) {
    const rows: Doc<"people">[] = await ctx.db
      .query("people")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .take(PEOPLE_PER_CHAPTER_LIMIT);
    for (const p of rows) {
      if (p.isPlaceholder === true) continue;
      if (p.status === "inactive") continue;
      personById.set(p._id, p);
      if (
        await personMatchesCriteria(ctx, p, filters, {
          donorMatchedPersonIds: donorMatch.matchedPersonIds,
          personEmailsById,
        })
      ) {
        filterMatchedIds.add(p._id);
      }
    }
  }

  // Data-trust counter (top priority): unlinked historical RSVPs that an
  // attendance criterion would have matched, had they been linked to a
  // person — see `countUnlinkedGuests`'s doc. Scoped to the same chapters
  // this resolution just fanned across. DIAGNOSTIC-ONLY: skipped entirely
  // (no extra reads at all) unless `includeDiagnostics` — the send path and
  // `campaigns.ts#liveAudienceCount` must never pay for a preview-only
  // signal (see `resolveAudienceRecipients`'s doc — the incident class
  // hotfix #414 addressed).
  const { count: unlinkedGuests, isLowerBound: unlinkedGuestsIsLowerBound } = includeDiagnostics
    ? await countUnlinkedGuests(ctx, filters, new Set(chapterIds))
    : { count: 0, isLowerBound: false };

  // ── Phase 2a: property-level exclusions (`excludeFilters`) — evaluated
  // ONLY against the `filterMatchedIds ∪ includeIds` union (never a fresh
  // table scan), via the SAME `personMatchesCriteria` matcher phase 1 used,
  // so the two blocks can never apply different rules for the "same"
  // criterion. Beats a hand-pick include on purpose (curation is not
  // exemption from an explicit property exclusion) — counted via
  // `handPickedExcludedByFilters` when it does. `evaluateVerifiedEmailOnly:
  // false` — see `personMatchesCriteria`'s doc on why that criterion is
  // never evaluated for the exclude block. `excludeDonorMatch` is captured
  // in full (not just `.matchedPersonIds`) because its `.centralFallbackDonors`
  // is reused below by the central-donor-fallback exclude check (spec §3.4 —
  // see that section's doc for why an unlinked donor needs its own,
  // donor-row-only exclude evaluation). ──
  const excludeDonorMatch =
    excludeFiltersActive && excludeFilters && hasDonorCriteria(excludeFilters)
      ? await matchDonorFilters(ctx, { scope: audience.scope, filters: excludeFilters })
      : { matchedPersonIds: new Set<Id<"people">>(), centralFallbackDonors: [] as Doc<"donors">[] };

  const unionIds = new Set<Id<"people">>([...filterMatchedIds, ...includeIds]);
  let excludedByFilters = 0;
  let handPickedExcludedByFilters = 0;
  const survivingIds = new Set<Id<"people">>();
  for (const id of unionIds) {
    if (excludeFiltersActive && excludeFilters) {
      let person = personById.get(id);
      if (!person) {
        const fetched = await ctx.db.get(id);
        if (fetched) {
          personById.set(id, fetched);
          person = fetched;
        }
      }
      if (
        person &&
        (await personMatchesCriteria(
          ctx,
          person,
          excludeFilters,
          { donorMatchedPersonIds: excludeDonorMatch.matchedPersonIds, personEmailsById },
          { evaluateVerifiedEmailOnly: false },
        ))
      ) {
        excludedByFilters++;
        if (includeDiagnostics && includeIdSet.has(id)) handPickedExcludedByFilters++;
        continue;
      }
    }
    survivingIds.add(id);
  }

  // ── Phase 2b: hand-picked `excludePersonIds` — the last word, subtracted
  // from whatever `excludeFilters` left standing — then resolve each
  // survivor to a send address (consent gates apply here, uniformly,
  // regardless of provenance). ──
  const finalIds = survivingIds;
  for (const id of excludeSet) finalIds.delete(id);

  // `finalIds` is already bounded: `filterMatchedIds` by the chapter fan-out's
  // own per-chapter cap (`PEOPLE_PER_CHAPTER_LIMIT`), `includeIds` by
  // `HAND_PICK_LOOKUP_LIMIT` (enforced by the caller/mutation layer, which
  // rejects an oversized include/exclude list outright rather than silently
  // truncating a human's hand-picked list — see `audiences.ts`). This
  // resolver stays "run to completion, not limit-aware" like its siblings —
  // `resolveAudienceRecipients` applies `AUDIENCE_RESOLVE_LIMIT` once, at the
  // very end, against the full deduped set (see the module doc).
  const byEmail = new Map<string, ResolvedRecipient>();
  let excludedOptOut = 0;
  let handPickedUnverified = 0;
  for (const id of finalIds) {
    const person = personById.get(id) ?? (await ctx.db.get(id));
    if (!person || person.isPlaceholder === true) continue;

    // Data-trust counter (fix #2): a person who reached `finalIds` ONLY via
    // a hand-pick (never matched `filterMatchedIds`) bypasses
    // `verifiedEmailOnly` as a filter criterion by design — but if their
    // resolved send address isn't itself verified, that's worth surfacing so
    // an author sees exactly who they're bypassing consent-adjacent signal
    // for, without actually excluding them.
    if (filters.verifiedEmailOnly && !filterMatchedIds.has(id)) {
      const emails = await getEmailsCached(ctx, personEmailsById, id);
      if (!resolvedAddressIsVerified(person, emails)) handPickedUnverified++;
    }

    if (person.marketingOptOut === true) {
      excludedOptOut++;
      continue;
    }
    const emails = await getEmailsCached(ctx, personEmailsById, id);
    const raw = resolveSendAddress(person, emails);
    const email = raw ? normalizeEmail(raw) : null;
    if (!email || byEmail.has(email)) continue;
    byEmail.set(email, { email, name: person.name });
  }

  // ── Central-donor fallback (spec §3.4): unlinked central donor rows that
  // matched the donor filters become their own recipients — never gated by
  // marketingOptOut (no person row exists to check), and never evaluated
  // against `verifiedEmailOnly` in EITHER block (ignored on the exclude side
  // per `hasEffectiveExcludeCriteria`'s doc; never was a filter criterion
  // for this fallback path on the include side either — a donor row has no
  // `personEmails`). `centralFallbackEmails` is handed back (not a bare
  // count) so the caller can report `unlinkedCentralDonors` AFTER the shared
  // suppression pass — a suppressed central-donor address must not inflate
  // the "N central donors (unlinked)" count for recipients that won't
  // actually be reached.
  //
  // `excludeFilters` MUST also apply here — a fallback donor is still a
  // member of the audience, so an explicit property exclusion must reach it
  // exactly like it reaches a linked person (this was the exact gap a
  // verifier caught: a $5k donor is excluded via `givingLifetimeMinCents`,
  // but an otherwise-identical UNLINKED central donor sailed past because it
  // never entered `unionIds` — there's no `people` row for it to be a
  // candidate there). Donor-derived criteria (`donorStatus`/
  // `givingLifetimeMin/MaxCents`/`giftCountMin`/`backerStatus`/
  // `gaveWithinDays`) evaluate against the donor row/aggregates directly —
  // `excludeDonorMatch.centralFallbackDonors` is EXACTLY that evaluation,
  // reused for free (it's the SAME `matchDonorFilters(excludeFilters)` call
  // phase 2a already made, no extra read). Any PERSON-SCOPED criterion
  // (`chapterId`/`attendedEventId`/`attendedWithinDays`/`rsvpStatus`/
  // `seatId`/`teamOnly`/`contactsOnly`) being SET makes the WHOLE exclude
  // block fail to match instead — there's no `people` row to check it
  // against, and under AND semantics an unprovable criterion means the
  // block doesn't match, so the donor conservatively STAYS (this never
  // silently drops a fallback donor on a criterion nobody could verify). ──
  const excludeHasPersonScopedCriteria =
    excludeFiltersActive &&
    excludeFilters != null &&
    (excludeFilters.chapterId != null ||
      excludeFilters.attendedEventId != null ||
      excludeFilters.attendedWithinDays != null ||
      excludeFilters.rsvpStatus != null ||
      excludeFilters.seatId != null ||
      excludeFilters.teamOnly === true ||
      excludeFilters.contactsOnly === true);
  const excludeCentralFallbackIds = new Set(excludeDonorMatch.centralFallbackDonors.map((d) => d._id));

  const centralFallbackEmails = new Set<string>();
  for (const d of donorMatch.centralFallbackDonors) {
    if (excludeFiltersActive && !excludeHasPersonScopedCriteria && excludeCentralFallbackIds.has(d._id)) {
      excludedByFilters++;
      continue;
    }
    const email = normalizeEmail(d.email);
    if (!email || byEmail.has(email)) continue;
    byEmail.set(email, { email, name: d.name });
    centralFallbackEmails.add(email);
  }

  return {
    raw: [...byEmail.values()],
    excludedOptOut,
    centralFallbackEmails,
    unlinkedGuests,
    unlinkedGuestsIsLowerBound,
    handPickedUnverified,
    excludedByFilters,
    handPickedExcludedByFilters,
  };
}

// ── entry point ───────────────────────────────────────────────────────────

/**
 * Resolve an audience (or a not-yet-saved draft with the same shape, for a
 * live composer preview) to its deduped, suppression-filtered recipient list,
 * bounded at `limit` (default `AUDIENCE_RESOLVE_LIMIT`).
 *
 * `includeDiagnostics` (default `false`) gates the data-trust TRANSPARENCY
 * counters (`unlinkedGuests`/`unlinkedGuestsIsLowerBound`/
 * `centralDonorsExcludedByChapterFilter`) — each is an EXTRA bounded scan on
 * top of everything this function already reads (`countUnlinkedGuests`: up
 * to `RSVPS_PER_EVENT_LIMIT`/`UNLINKED_GUESTS_SCAN_CAP` rows;
 * `countCentralDonorsExcludedByChapterFilter`: up to `DONORS_PER_SCOPE_LIMIT`
 * donors plus, when `backerStatus` is set, up to 4 ×
 * `PLEDGES_PER_SCOPE_LIMIT` pledge reads — several thousand reads worst
 * case). This function is shared by THREE callers with very different cost
 * budgets: `previewAudience` (a live composer query, where the extra reads
 * are the entire point), `resolveAudienceForSend` (a real send's
 * materialization), and `campaigns.ts#liveAudienceCount` (polled
 * repeatedly). Only `previewAudience` passes `includeDiagnostics: true` — a
 * send or a live count must never pay for a preview-only signal on top of
 * its own bounded reads (the exact read-budget incident class hotfix #414
 * addressed). When `false`, every diagnostic field on the returned
 * `AudienceResolution` is its zero/false default — the recipient list and
 * every non-diagnostic count are unaffected either way.
 */
export async function resolveAudienceRecipients(
  ctx: QueryCtx,
  audience: {
    scope: AudienceScope;
    source: AudienceSource;
    filters: AudienceFilters;
    // `person_filters` only — see `schema/campaigns.ts#audiences`'s doc.
    // Ignored (harmlessly) for every legacy source, mirroring `filters`'
    // own "fields the source ignores sit unused" shape.
    excludeFilters?: AudienceFilters;
    includePersonIds?: Id<"people">[];
    excludePersonIds?: Id<"people">[];
  },
  limit: number = AUDIENCE_RESOLVE_LIMIT,
  includeDiagnostics: boolean = false,
): Promise<AudienceResolution> {
  let raw: ResolvedRecipient[];
  let excludedUnverified = 0;
  let excludedOptOut = 0;
  let centralFallbackEmails: Set<string> = new Set();
  let unlinkedGuests = 0;
  let unlinkedGuestsIsLowerBound = false;
  let handPickedUnverified = 0;
  let excludedByFilters = 0;
  let handPickedExcludedByFilters = 0;

  if (audience.source === "guests") {
    const result = await resolveGuests(ctx, audience.filters);
    raw = result.raw;
    excludedUnverified = result.excludedUnverified;
  } else if (audience.source === "donors") {
    raw = await resolveDonors(ctx, audience);
  } else if (audience.source === "person_filters") {
    const result = await resolvePersonFilters(ctx, audience, includeDiagnostics);
    raw = result.raw;
    excludedOptOut = result.excludedOptOut;
    centralFallbackEmails = result.centralFallbackEmails;
    unlinkedGuests = result.unlinkedGuests;
    unlinkedGuestsIsLowerBound = result.unlinkedGuestsIsLowerBound;
    handPickedUnverified = result.handPickedUnverified;
    excludedByFilters = result.excludedByFilters;
    handPickedExcludedByFilters = result.handPickedExcludedByFilters;
  } else {
    const result = await resolvePeople(ctx, audience.filters);
    raw = result.raw;
    excludedOptOut = result.excludedOptOut;
  }

  // Data-trust counter (fix #3): only `donors`/`person_filters` ever consult
  // the `donors` table, and the count is zero-cost (no query) unless scope,
  // chapterId, and an active donor criterion all line up — see the
  // function's doc. DIAGNOSTIC-ONLY: gated by `includeDiagnostics` first —
  // never runs on the send path or `liveAudienceCount`.
  const centralDonorsExcludedByChapterFilter =
    includeDiagnostics && (audience.source === "donors" || audience.source === "person_filters")
      ? await countCentralDonorsExcludedByChapterFilter(ctx, audience)
      : 0;

  const suppressed = await suppressedEmailSet(ctx);
  const filtered: ResolvedRecipient[] = [];
  let excludedSuppressed = 0;
  for (const r of raw) {
    if (suppressed.has(r.email)) {
      excludedSuppressed++;
      continue;
    }
    filtered.push(r);
  }

  const truncated = filtered.length > limit;
  const truncatedCount = truncated ? filtered.length - limit : 0;
  const recipients = truncated ? filtered.slice(0, limit) : filtered;

  // Counted AFTER suppression + the cap, against the actual final recipient
  // list — a suppressed or truncated-away central-donor row must not inflate
  // the "N central donors (unlinked)" figure (see `resolvePersonFilters`'s doc).
  const unlinkedCentralDonors = recipients.reduce(
    (n, r) => (centralFallbackEmails.has(r.email) ? n + 1 : n),
    0,
  );

  return {
    recipients,
    excludedSuppressed,
    excludedUnverified,
    excludedOptOut,
    unlinkedCentralDonors,
    centralDonorsExcludedByChapterFilter,
    unlinkedGuests,
    unlinkedGuestsIsLowerBound,
    handPickedUnverified,
    excludedByFilters,
    handPickedExcludedByFilters,
    truncated,
    truncatedCount,
  };
}
