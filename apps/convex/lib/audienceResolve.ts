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
  /** `person_filters` only (Phase 2's person-level preference, specs/
   *  person-centric-audiences.md Phase 3 invariant): how many matched
   *  people — via FILTER match, hand-pick, or both — were dropped for
   *  `marketingOptOut === true`. Always 0 for guests/donors (address-shaped
   *  legacy sources that never consult a person row) and for `people` (which
   *  already folds this into `excludedSuppressed`-adjacent silent exclusion
   *  rather than a counted one — kept as-is for back-compat). */
  excludedOptOut: number;
  /** `person_filters` at `scope === "central"` only: how many of the final
   *  `recipients` came from an UNLINKED central `donors` row matched by a
   *  donor-derived filter (spec §3.4's fallback) rather than a real `people`
   *  row — central donors have no chapter roster to link into by design, so
   *  this is the honest "N central donors (unlinked)" count, not a silent
   *  fold-in. Always 0 for every other source/scope. */
  unlinkedCentralDonors: number;
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
): Promise<ResolvedRecipient[]> {
  const chapterIds = await targetChapterIds(ctx, filters);
  const byEmail = new Map<string, ResolvedRecipient>();
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
      if (p.marketingOptOut === true) continue;
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
  return [...byEmail.values()];
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

/** True iff `personId` has at least one `personEmails` row with
 *  `verified: true` — a property of the PERSON (see the schema doc on
 *  `verifiedEmailOnly`), computed once per person and reused for both the
 *  filter check and (via the caller's cache) the final address resolution. */
function hasAnyVerifiedEmail(emails: Doc<"personEmails">[]): boolean {
  return emails.some((e) => e.verified === true);
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
async function matchDonorFilters(
  ctx: QueryCtx,
  audience: { scope: AudienceScope; filters: AudienceFilters },
): Promise<{ matchedPersonIds: Set<Id<"people">>; centralFallbackDonors: Doc<"donors">[] }> {
  const { filters } = audience;
  const scopes = await targetDonorScopes(ctx, audience);

  // `backerStatus` needs a donorId → "has an active pledge" / "has ANY pledge
  // on file" lookup, built once across the same scopes (bounded per scope,
  // mirrors `resolveDonors`'s per-scope fan-out shape).
  let activePledgeDonorIds: Set<Id<"donors">> | null = null;
  let anyPledgeDonorIds: Set<Id<"donors">> | null = null;
  if (filters.backerStatus != null) {
    activePledgeDonorIds = new Set();
    anyPledgeDonorIds = new Set();
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
  }

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
      if (filters.givingLifetimeMinCents != null && d.lifetimeCents < filters.givingLifetimeMinCents) continue;
      if (filters.givingLifetimeMaxCents != null && d.lifetimeCents > filters.givingLifetimeMaxCents) continue;
      if (filters.giftCountMin != null && d.giftCount < filters.giftCountMin) continue;
      if (gaveCutoff !== null && (d.lastGiftAt == null || d.lastGiftAt < gaveCutoff)) continue;
      if (filters.backerStatus === "active" && !activePledgeDonorIds!.has(d._id)) continue;
      if (
        filters.backerStatus === "lapsed" &&
        !(anyPledgeDonorIds!.has(d._id) && !activePledgeDonorIds!.has(d._id))
      ) {
        continue;
      }

      if (d.personId) {
        matchedPersonIds.add(d.personId);
      } else if (d.scope === "central" && audience.scope === "central" && d.email) {
        centralFallbackDonors.push(d);
      }
    }
  }

  return { matchedPersonIds, centralFallbackDonors };
}

/**
 * Resolve a `person_filters` audience — the Phase 3 "robust filters + hand-
 * picked" model (specs/person-centric-audiences.md "Phase 3"). Filters
 * AND-combine; `includePersonIds` UNIONS in regardless of filter match;
 * `excludePersonIds` always wins over both. `marketingOptOut` (Phase 2) is
 * checked for EVERY final candidate REGARDLESS of how they entered the set —
 * a hand-pick is not consent (spec §3.3's non-negotiable invariant) — and is
 * counted via `excludedOptOut` rather than folded silently into
 * `excludedSuppressed`. `verifiedEmailOnly`, by contrast, is a FILTER
 * criterion: it's only enforced against people who matched via FILTERS —
 * a person who is ALSO (or ONLY) hand-picked is never excluded by it, mirroring
 * the general "hand-pick bypasses filter criteria, never bypasses consent
 * gates" split this function documents throughout.
 */
async function resolvePersonFilters(
  ctx: QueryCtx,
  audience: {
    scope: AudienceScope;
    filters: AudienceFilters;
    includePersonIds?: Id<"people">[];
    excludePersonIds?: Id<"people">[];
  },
): Promise<{ raw: ResolvedRecipient[]; excludedOptOut: number; centralFallbackEmails: Set<string> }> {
  const { filters } = audience;
  const includeIds = audience.includePersonIds ?? [];
  const excludeSet = new Set(audience.excludePersonIds ?? []);

  const donorMatch = hasDonorCriteria(filters)
    ? await matchDonorFilters(ctx, audience)
    : { matchedPersonIds: new Set<Id<"people">>(), centralFallbackDonors: [] };
  const hasAttendanceCriteria =
    filters.attendedEventId != null || filters.attendedWithinDays != null || filters.rsvpStatus != null;

  // ── Phase 1: scan the target chapters' roster+contacts, evaluating every
  // SET filter criterion per candidate into `filterMatchedIds`.
  // `personEmailsById` is populated as we go (only when `verifiedEmailOnly`
  // needs it) so phase 2's final address resolution never re-fetches a row
  // it already has. `verifiedEmailOnly` is deliberately checked HERE, not in
  // phase 2 — a candidate that fails it simply never joins `filterMatchedIds`,
  // so a hand-picked person (added to the final set independently, in phase
  // 2, via `includeIds`) is never excluded by a filter criterion they didn't
  // go through — see the function doc's "hand-pick bypasses filter criteria"
  // split. ──
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
      if (filters.teamOnly === true && p.isContactOnly === true) continue;
      if (filters.contactsOnly === true && p.isContactOnly !== true) continue;
      personById.set(p._id, p);

      if (hasDonorCriteria(filters) && !donorMatch.matchedPersonIds.has(p._id)) continue;
      if (hasAttendanceCriteria && !(await personAttendsMatch(ctx, p._id, filters))) continue;
      if (filters.seatId && !(await personHoldsSeat(ctx, p._id, filters.seatId))) continue;
      if (filters.verifiedEmailOnly) {
        const emails = await ctx.db
          .query("personEmails")
          .withIndex("by_person", (q) => q.eq("personId", p._id))
          .collect();
        personEmailsById.set(p._id, emails);
        if (!hasAnyVerifiedEmail(emails)) continue;
      }
      filterMatchedIds.add(p._id);
    }
  }

  // ── Phase 2: union filter matches + hand-picks, subtract excludes, then
  // resolve each survivor to a send address (consent gates apply here,
  // uniformly, regardless of provenance). ──
  const finalIds = new Set<Id<"people">>([...filterMatchedIds, ...includeIds]);
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
  for (const id of finalIds) {
    const person = personById.get(id) ?? (await ctx.db.get(id));
    if (!person || person.isPlaceholder === true) continue;
    if (person.marketingOptOut === true) {
      excludedOptOut++;
      continue;
    }
    const emails =
      personEmailsById.get(id) ??
      (await ctx.db
        .query("personEmails")
        .withIndex("by_person", (q) => q.eq("personId", id))
        .collect());
    const raw = resolveSendAddress(person, emails);
    const email = raw ? normalizeEmail(raw) : null;
    if (!email || byEmail.has(email)) continue;
    byEmail.set(email, { email, name: person.name });
  }

  // ── Central-donor fallback (spec §3.4): unlinked central donor rows that
  // matched the donor filters become their own recipients — never gated by
  // marketingOptOut/verifiedEmailOnly (no person row exists to check).
  // `centralFallbackEmails` is handed back (not a bare count) so the caller
  // can report `unlinkedCentralDonors` AFTER the shared suppression pass —
  // a suppressed central-donor address must not inflate the "N central
  // donors (unlinked)" count for recipients that won't actually be reached. ──
  const centralFallbackEmails = new Set<string>();
  for (const d of donorMatch.centralFallbackDonors) {
    const email = normalizeEmail(d.email);
    if (!email || byEmail.has(email)) continue;
    byEmail.set(email, { email, name: d.name });
    centralFallbackEmails.add(email);
  }

  return { raw: [...byEmail.values()], excludedOptOut, centralFallbackEmails };
}

// ── entry point ───────────────────────────────────────────────────────────

/**
 * Resolve an audience (or a not-yet-saved draft with the same shape, for a
 * live composer preview) to its deduped, suppression-filtered recipient list,
 * bounded at `limit` (default `AUDIENCE_RESOLVE_LIMIT`).
 */
export async function resolveAudienceRecipients(
  ctx: QueryCtx,
  audience: {
    scope: AudienceScope;
    source: AudienceSource;
    filters: AudienceFilters;
    includePersonIds?: Id<"people">[];
    excludePersonIds?: Id<"people">[];
  },
  limit: number = AUDIENCE_RESOLVE_LIMIT,
): Promise<AudienceResolution> {
  let raw: ResolvedRecipient[];
  let excludedUnverified = 0;
  let excludedOptOut = 0;
  let centralFallbackEmails: Set<string> = new Set();

  if (audience.source === "guests") {
    const result = await resolveGuests(ctx, audience.filters);
    raw = result.raw;
    excludedUnverified = result.excludedUnverified;
  } else if (audience.source === "donors") {
    raw = await resolveDonors(ctx, audience);
  } else if (audience.source === "person_filters") {
    const result = await resolvePersonFilters(ctx, audience);
    raw = result.raw;
    excludedOptOut = result.excludedOptOut;
    centralFallbackEmails = result.centralFallbackEmails;
  } else {
    raw = await resolvePeople(ctx, audience.filters);
  }

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
    truncated,
    truncatedCount,
  };
}
