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

export type AudienceFilters = Infer<typeof audienceFiltersValidator>;
export type AudienceScope = Id<"chapters"> | "central";
export type AudienceSource = "guests" | "donors" | "people";

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
   *  `emailVerified === false`. Always 0 for donors/people. */
  excludedUnverified: number;
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

// ── entry point ───────────────────────────────────────────────────────────

/**
 * Resolve an audience (or a not-yet-saved draft with the same shape, for a
 * live composer preview) to its deduped, suppression-filtered recipient list,
 * bounded at `limit` (default `AUDIENCE_RESOLVE_LIMIT`).
 */
export async function resolveAudienceRecipients(
  ctx: QueryCtx,
  audience: { scope: AudienceScope; source: AudienceSource; filters: AudienceFilters },
  limit: number = AUDIENCE_RESOLVE_LIMIT,
): Promise<AudienceResolution> {
  let raw: ResolvedRecipient[];
  let excludedUnverified = 0;

  if (audience.source === "guests") {
    const result = await resolveGuests(ctx, audience.filters);
    raw = result.raw;
    excludedUnverified = result.excludedUnverified;
  } else if (audience.source === "donors") {
    raw = await resolveDonors(ctx, audience);
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

  return { recipients, excludedSuppressed, excludedUnverified, truncated, truncatedCount };
}
