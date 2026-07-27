/**
 * Guest Identity review — the human half of Partiful name-only RSVP
 * resolution. `migrations/0049_link_rsvp_identifiers.ts` auto-links the small
 * slice of rsvps that already carry an email/phone; everything else (a bare
 * first name, appearing at N events, that could be one of several existing
 * people or nobody the app has ever seen) needs a human. See
 * `schema/identity.ts`'s module doc for the `identityDecisions` ledger this
 * file reads/writes, and `lib/identityAccess.ts` for the access gate every
 * mutation here uses (today: anyone on the chapter's team — the founder's
 * explicit call for this queue, see that file's doc).
 *
 * THREE QUEUE BUCKETS (a 4th, auto-link, is 0049 — never surfaced here):
 *  - `listNameMatchCandidates` (bucket 2) — a name-only guest whose trimmed
 *    name exactly matches an EXISTING roster person's name. Small (~59 prod)
 *    — one bounded `.take()` per chapter, no cursor pagination, mirroring
 *    `dataHygiene.ts#listPeopleDuplicates`'s bounded-read precedent.
 *  - `listDuplicatePersonCandidates` (bucket 3) — suspected-duplicate PEOPLE
 *    rows (shared email/phone/name), reusing `dataHygiene.ts#groupDuplicates`
 *    (the exact clustering `listPeopleDuplicates` uses) rather than
 *    reimplementing it. Small (~3 prod) — same bounded-read shape.
 *  - `listUnidentifiedGuests` (bucket 4) — every OTHER name-only guest, with
 *    no roster match at all. Large (~1,179 distinct names prod) — needs real
 *    pagination; see that query's own doc for the SCAN_CAP/hand-rolled-cursor
 *    tradeoff.
 *
 * SUPPRESSION / RESURFACING (the mechanism buckets 2 & 3 share):
 * `shouldIncludeIdentityPair` looks up the most recent `identityDecisions` row
 * for the exact `(chapterId, kind, subjectKey, candidatePersonId)` tuple. No
 * row → include. A `"different"` row whose stored `evidenceHash` still
 * matches the CURRENT evidence → suppress (still settled). A `"different"`
 * row whose hash no longer matches (the candidate gained an email/phone since
 * the human said "different") → include again — new information arrived. A
 * `"same"` row is never looked up this way: by the time one exists, the
 * underlying link/merge already happened and the pair no longer appears in
 * the bucket's own source data. Bucket 4 (`listUnidentifiedGuests`) has NO
 * natural `candidatePersonId` to check against for a bare unidentified name
 * (that's exactly what makes it bucket 4, not bucket 2) — see that query's
 * own doc for how it stays consistent with this mechanism anyway.
 */
import { ConvexError, v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { query, mutation } from "./_generated/server";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireReviewGuestIdentity, canReviewGuestIdentity } from "./lib/identityAccess";
import { computeIdentityEvidenceHash } from "./lib/identityEvidence";
import { requireUserId } from "./lib/context";
import { chapterRoster } from "./lib/org";
import { normName, groupDuplicates, mergePeopleCore } from "./dataHygiene";
import { normalizeEmail } from "./lib/access";
import { isAutoLinkEligible } from "./migrations/0049_link_rsvp_identifiers";

// ── Bounds ───────────────────────────────────────────────────────────────────
/** Bounded scan of a chapter's rsvps for the name-based buckets (2 & 4) and
 *  the name-repoint mutations below. Matches this codebase's existing
 *  "bounded read, not a fully general scan" precedent
 *  (`lib/people.ts#PERSONA_RSVPS_SCAN_LIMIT`) — NOT a native `.paginate()`,
 *  so a chapter with more than `SCAN_CAP` rsvps would silently miss rows past
 *  the cap. Acceptable at this app's guest volume today (prod chapters sit
 *  far below this); a future chapter that outgrows it needs a real indexed
 *  scan, not a bigger constant. */
const SCAN_CAP = 5000;
/** Bounded roster read for duplicate-person clustering — mirrors
 *  `dataHygiene.ts#DEDUP_READ_CAP`. */
const DUPLICATE_READ_CAP = 1000;

const personCandidateValidator = v.object({
  _id: v.id("people"),
  name: v.string(),
  email: v.union(v.string(), v.null()),
  phone: v.union(v.string(), v.null()),
  userId: v.union(v.id("users"), v.null()),
  isTeamMember: v.boolean(),
  notes: v.union(v.string(), v.null()),
  status: v.union(v.string(), v.null()),
  role: v.union(v.string(), v.null()),
  company: v.union(v.string(), v.null()),
  createdAt: v.number(),
});

function personCandidateOut(p: Doc<"people">) {
  return {
    _id: p._id,
    name: p.name,
    email: p.email ?? null,
    phone: p.phone ?? null,
    userId: p.userId ?? null,
    isTeamMember: p.isTeamMember === true,
    notes: p.notes ?? null,
    status: p.status ?? null,
    role: p.role ?? null,
    company: p.company ?? null,
    createdAt: p.createdAt,
  };
}

/**
 * The suppression/resurfacing check every bucket-2/3 candidate pair runs
 * through before being included in a queue result — see the module doc.
 */
async function shouldIncludeIdentityPair(
  ctx: QueryCtx,
  args: {
    chapterId: Id<"chapters">;
    kind: "guest_link" | "person_merge";
    subjectKey: string;
    candidatePersonId: Id<"people">;
    candidateName: string;
    candidateEmail?: string | null;
    candidatePhone?: string | null;
    subjectName?: string;
    subjectEmail?: string | null;
    subjectPhone?: string | null;
  },
): Promise<boolean> {
  const decision = await ctx.db
    .query("identityDecisions")
    .withIndex("by_chapter_kind_subject_candidate", (q) =>
      q
        .eq("chapterId", args.chapterId)
        .eq("kind", args.kind)
        .eq("subjectKey", args.subjectKey)
        .eq("candidatePersonId", args.candidatePersonId),
    )
    .order("desc")
    .first();
  if (!decision || decision.verdict !== "different") return true;
  const currentHash = computeIdentityEvidenceHash({
    candidateName: args.candidateName,
    candidateEmail: args.candidateEmail,
    candidatePhone: args.candidatePhone,
    subjectName: args.subjectName,
    subjectEmail: args.subjectEmail,
    subjectPhone: args.subjectPhone,
  });
  return currentHash !== decision.evidenceHash;
}

/** A name-only, not-yet-linked rsvp — the shared source population for
 *  buckets 2 and 4 (never bucket 1's auto-link scope — see
 *  `migrations/0049_link_rsvp_identifiers.ts#isAutoLinkEligible`, whose
 *  complement this is, by construction, so the automated and human scopes
 *  never silently overlap or drift apart). */
async function nameOnlyRsvps(ctx: QueryCtx, chapterId: Id<"chapters">): Promise<Doc<"rsvps">[]> {
  return (
    await ctx.db
      .query("rsvps")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .take(SCAN_CAP)
  ).filter((r) => !isAutoLinkEligible(r) && r.personId === undefined);
}

// ═══════════════════════════════════════════════════════════════════════════
// BUCKET 2 — name matches an existing roster person
// ═══════════════════════════════════════════════════════════════════════════

export const listNameMatchCandidates = query({
  args: { chapterId: v.id("chapters") },
  returns: v.array(
    v.object({
      guestNameKey: v.string(),
      displayName: v.string(),
      eventCount: v.number(),
      candidate: personCandidateValidator,
    }),
  ),
  handler: async (ctx, { chapterId }) => {
    if (!(await canReviewGuestIdentity(ctx, chapterId))) return [];

    const rows = await nameOnlyRsvps(ctx, chapterId);
    const byName = new Map<string, { displayName: string; count: number }>();
    for (const r of rows) {
      const key = normName(r.name);
      if (!key) continue;
      const g = byName.get(key) ?? { displayName: r.name.trim(), count: 0 };
      g.count += 1;
      byName.set(key, g);
    }

    const roster = await chapterRoster(ctx, chapterId);
    const out: Array<{
      guestNameKey: string;
      displayName: string;
      eventCount: number;
      candidate: ReturnType<typeof personCandidateOut>;
    }> = [];
    for (const [key, g] of byName) {
      const candidate = roster.find((p) => normName(p.name) === key);
      if (!candidate) continue; // no exact roster match — belongs to bucket 4, not here
      const include = await shouldIncludeIdentityPair(ctx, {
        chapterId,
        kind: "guest_link",
        subjectKey: key,
        candidatePersonId: candidate._id,
        candidateName: candidate.name,
        candidateEmail: candidate.email,
        candidatePhone: candidate.phone,
      });
      if (!include) continue;
      out.push({
        guestNameKey: key,
        displayName: g.displayName,
        eventCount: g.count,
        candidate: personCandidateOut(candidate),
      });
    }
    return out;
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// BUCKET 3 — suspected-duplicate people
// ═══════════════════════════════════════════════════════════════════════════

export const listDuplicatePersonCandidates = query({
  args: { chapterId: v.id("chapters") },
  returns: v.array(
    v.object({
      matchKind: v.union(v.literal("email"), v.literal("phone"), v.literal("name"), v.literal("similar")),
      subject: personCandidateValidator,
      candidate: personCandidateValidator,
    }),
  ),
  handler: async (ctx, { chapterId }) => {
    if (!(await canReviewGuestIdentity(ctx, chapterId))) return [];

    const roster = (
      await ctx.db
        .query("people")
        .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
        .take(DUPLICATE_READ_CAP)
    ).filter((p) => p.isPlaceholder !== true && p.isSamplePerson !== true);

    // Reuses `dataHygiene.ts#groupDuplicates` verbatim (same email → phone →
    // name clustering `listPeopleDuplicates` uses) — this queue is gated by
    // `requireReviewGuestIdentity` (anyone on the team), not `isChapterAdmin`,
    // so it can't call that admin-gated query directly; it calls the same
    // underlying pure clustering function instead.
    const groups = groupDuplicates(roster, (p) => ({
      email: normalizeEmail(p.email) ?? "",
      phone: (p.phone ?? "").replace(/\D/g, ""),
      name: normName(p.name),
    }));

    const out: Array<{
      matchKind: "email" | "phone" | "name" | "similar";
      subject: ReturnType<typeof personCandidateOut>;
      candidate: ReturnType<typeof personCandidateOut>;
    }> = [];
    for (const g of groups) {
      // Pair the first member (the baseline "subject") against every OTHER
      // member of the cluster — for the common 2-member case this is exactly
      // one pair; a larger cluster (not expected at today's ~3-group prod
      // scale) still produces a well-defined pair per additional member
      // instead of an undefined N-way comparison.
      const [subject, ...rest] = g.members;
      for (const candidate of rest) {
        const include = await shouldIncludeIdentityPair(ctx, {
          chapterId,
          kind: "person_merge",
          subjectKey: String(subject._id),
          candidatePersonId: candidate._id,
          candidateName: candidate.name,
          candidateEmail: candidate.email,
          candidatePhone: candidate.phone,
          subjectName: subject.name,
          subjectEmail: subject.email,
          subjectPhone: subject.phone,
        });
        if (!include) continue;
        out.push({
          matchKind: g.matchKind,
          subject: personCandidateOut(subject),
          candidate: personCandidateOut(candidate),
        });
      }
    }
    return out;
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// BUCKET 4 — unidentified guests (no roster match at all)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Paginated, ordered by event count descending (tie-break: most-recently-seen
 * first — mirrors `territories.ts`'s `sort((a, b) => b.x - a.x || b.createdAt
 * - a.createdAt)` tie-break precedent).
 *
 * There is no indexed/denormalized-counter precedent in this codebase for
 * "distinct guest name → event count" (building one is out of scope for this
 * task), so this bounded-reads the chapter's name-only rsvps once
 * (`nameOnlyRsvps`, capped at `SCAN_CAP` — NOT a full-table `.paginate()`),
 * groups + sorts them ALL in memory, then hand-paginates that in-memory array
 * with a numeric-offset cursor (the cursor string is just `String(offset)`).
 * This is a real limitation, not a stylistic choice: a chapter with more than
 * `SCAN_CAP` name-only rsvps would silently lose visibility into names past
 * the cap, and every page re-does the full scan+sort (no cached ranking).
 * Acceptable at today's guest volume (SCAN_CAP comfortably covers a chapter's
 * full history); revisit with a real denormalized counter if either stops
 * holding.
 *
 * No suppression/resurfacing filter here (unlike buckets 2 & 3): a bare
 * unidentified name has no single natural `candidatePersonId` to check a
 * `"different"` decision against — that's the defining property that makes
 * it bucket 4 rather than bucket 2. `recordDecision`/`shouldIncludeIdentityPair`
 * still work generically for any `(subjectKey, candidatePersonId)` pair a
 * client wants to record against a specific searched-up person, but this
 * listing itself doesn't propose one to suppress against.
 */
export const listUnidentifiedGuests = query({
  args: { chapterId: v.id("chapters"), paginationOpts: paginationOptsValidator },
  returns: v.object({
    page: v.array(
      v.object({
        nameKey: v.string(),
        displayName: v.string(),
        eventCount: v.number(),
        eventNames: v.array(v.string()),
      }),
    ),
    isDone: v.boolean(),
    continueCursor: v.string(),
    // Total distinct-name-group count (after the SCAN_CAP-bounded read,
    // before pagination slicing) — a static "N unidentified" header total for
    // the client, since `page.length` alone can't convey that. Recomputed
    // (not cached) on every page call, so it always reflects the FULL
    // in-memory `groups` array this handler builds anyway — see the module
    // doc's SCAN_CAP tradeoff for why this isn't a truly global count past
    // the cap.
    totalCount: v.number(),
  }),
  handler: async (ctx, { chapterId, paginationOpts }) => {
    if (!(await canReviewGuestIdentity(ctx, chapterId))) {
      return { page: [], isDone: true, continueCursor: "", totalCount: 0 };
    }

    const rows = await nameOnlyRsvps(ctx, chapterId);
    const byName = new Map<string, { displayName: string; rows: Doc<"rsvps">[] }>();
    for (const r of rows) {
      const key = normName(r.name);
      if (!key) continue;
      const g = byName.get(key) ?? { displayName: r.name.trim(), rows: [] };
      g.rows.push(r);
      byName.set(key, g);
    }

    const groups = [...byName.entries()].map(([nameKey, g]) => ({
      nameKey,
      displayName: g.displayName,
      eventCount: g.rows.length,
      mostRecentCreatedAt: g.rows.reduce((m, r) => Math.max(m, r.createdAt), 0),
      rows: g.rows,
    }));
    groups.sort(
      (a, b) => b.eventCount - a.eventCount || b.mostRecentCreatedAt - a.mostRecentCreatedAt,
    );

    const offset = paginationOpts.cursor ? parseInt(paginationOpts.cursor, 10) || 0 : 0;
    const numItems = paginationOpts.numItems;
    const slice = groups.slice(offset, offset + numItems);
    const isDone = offset + numItems >= groups.length;

    // Resolve up to a few distinct event names per guest for display, cached
    // across the page so a busy event referenced by many guests is only read
    // from storage once.
    const eventNameCache = new Map<string, string>();
    const page = [];
    for (const g of slice) {
      const eventIds = [...new Set(g.rows.map((r) => String(r.eventId)))].slice(0, 3);
      const eventNames: string[] = [];
      for (const eid of eventIds) {
        let name = eventNameCache.get(eid);
        if (name === undefined) {
          const ev = await ctx.db.get(eid as Id<"events">);
          name = ev?.name ?? "Unknown event";
          eventNameCache.set(eid, name);
        }
        eventNames.push(name);
      }
      page.push({
        nameKey: g.nameKey,
        displayName: g.displayName,
        eventCount: g.eventCount,
        eventNames,
      });
    }

    return { page, isDone, continueCursor: String(offset + numItems), totalCount: groups.length };
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// MUTATIONS
// ═══════════════════════════════════════════════════════════════════════════

/** Repoint every unlinked rsvp in `chapterId` whose normalized name matches
 *  `guestNameKey` onto `personId` — shared by `linkGuestToPerson` and
 *  `createPersonFromGuest` so "matches the same name" is defined identically
 *  everywhere (the same `normName` used to GROUP bucket 2/4 candidates in the
 *  first place). Same `SCAN_CAP` bounded-read note as the queries above. */
async function repointRsvpsByNameKey(
  ctx: MutationCtx,
  chapterId: Id<"chapters">,
  guestNameKey: string,
  personId: Id<"people">,
): Promise<number> {
  const rows = await ctx.db
    .query("rsvps")
    .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
    .take(SCAN_CAP);
  let repointed = 0;
  for (const r of rows) {
    if (r.personId !== undefined) continue;
    if (normName(r.name) !== guestNameKey) continue;
    await ctx.db.patch(r._id, { personId });
    repointed += 1;
  }
  return repointed;
}

export const linkGuestToPerson = mutation({
  args: {
    chapterId: v.id("chapters"),
    guestNameKey: v.string(),
    personId: v.id("people"),
  },
  returns: v.object({ repointed: v.number() }),
  handler: async (ctx, { chapterId, guestNameKey, personId }) => {
    await requireReviewGuestIdentity(ctx, chapterId);
    const person = await ctx.db.get(personId);
    if (!person || person.chapterId !== chapterId) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Person not found in this chapter." });
    }

    const repointed = await repointRsvpsByNameKey(ctx, chapterId, guestNameKey, personId);

    const decidedBy = (await requireUserId(ctx)) as Id<"users">;
    await ctx.db.insert("identityDecisions", {
      chapterId,
      kind: "guest_link",
      subjectKey: guestNameKey,
      candidatePersonId: personId,
      verdict: "same",
      evidenceHash: computeIdentityEvidenceHash({
        candidateName: person.name,
        candidateEmail: person.email,
        candidatePhone: person.phone,
      }),
      decidedBy,
      decidedAt: Date.now(),
    });

    return { repointed };
  },
});

export const createPersonFromGuest = mutation({
  args: {
    chapterId: v.id("chapters"),
    guestNameKey: v.string(),
    name: v.string(),
    email: v.optional(v.string()),
    phone: v.optional(v.string()),
  },
  returns: v.object({ personId: v.id("people"), repointed: v.number() }),
  handler: async (ctx, { chapterId, guestNameKey, name, email, phone }) => {
    await requireReviewGuestIdentity(ctx, chapterId);

    // Reuses the standard roster-creation codepath (`people.ts#create`)
    // rather than hand-rolling the insert — see that mutation for the
    // defaults (status, vettingStatus, etc.) this deliberately doesn't
    // duplicate. NOTE: like every other `requireChapterId`-derived mutation,
    // this creates the person in the CALLER's own chapter membership, not a
    // `chapterId` passed as data — for the common case (a team member
    // reviewing their own chapter's queue) that's the same chapter this
    // mutation was gated against; a superuser reviewing a DIFFERENT chapter's
    // queue would create the person in their own home chapter instead (the
    // same latent multi-chapter limitation `lib/context.ts#requireChapterId`
    // already documents) — acceptable today since superusers reviewing a
    // foreign chapter's queue is not the common path this feature targets.
    const personId: Id<"people"> = await ctx.runMutation(api.people.create, {
      name,
      email,
      phone,
      isTeamMember: false,
    });

    const repointed = await repointRsvpsByNameKey(ctx, chapterId, guestNameKey, personId);

    const decidedBy = (await requireUserId(ctx)) as Id<"users">;
    await ctx.db.insert("identityDecisions", {
      chapterId,
      kind: "guest_link",
      subjectKey: guestNameKey,
      candidatePersonId: personId,
      verdict: "same",
      evidenceHash: computeIdentityEvidenceHash({
        candidateName: name,
        candidateEmail: email,
        candidatePhone: phone,
      }),
      decidedBy,
      decidedAt: Date.now(),
    });

    return { personId, repointed };
  },
});

export const recordDecision = mutation({
  args: {
    chapterId: v.id("chapters"),
    kind: v.union(v.literal("guest_link"), v.literal("person_merge")),
    subjectKey: v.string(),
    candidatePersonId: v.id("people"),
    // Only "different" is ever accepted here — see the module doc + schema
    // doc: a "same" verdict is written INLINE by the mutations above as a
    // side effect of actually performing the link/merge, and "not sure" is
    // purely client-side (no server call at all).
    verdict: v.literal("different"),
  },
  returns: v.id("identityDecisions"),
  handler: async (ctx, { chapterId, kind, subjectKey, candidatePersonId, verdict }) => {
    await requireReviewGuestIdentity(ctx, chapterId);

    const candidate = await ctx.db.get(candidatePersonId);
    if (!candidate || candidate.chapterId !== chapterId) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Candidate person not found in this chapter." });
    }
    // A `person_merge` decision's subject IS a person (its id, stringified);
    // a `guest_link` decision's subject is a normalized guest NAME, not an
    // id — there's no subject person to load, so the hash below omits every
    // subject field (see `computeIdentityEvidenceHash`'s key-omission rule).
    const subject = kind === "person_merge" ? await ctx.db.get(subjectKey as Id<"people">) : null;

    const decidedBy = (await requireUserId(ctx)) as Id<"users">;
    const evidenceHash = computeIdentityEvidenceHash({
      candidateName: candidate.name,
      candidateEmail: candidate.email,
      candidatePhone: candidate.phone,
      subjectName: subject?.name,
      subjectEmail: subject?.email,
      subjectPhone: subject?.phone,
    });

    return await ctx.db.insert("identityDecisions", {
      chapterId,
      kind,
      subjectKey,
      candidatePersonId,
      verdict,
      evidenceHash,
      decidedBy,
      decidedAt: Date.now(),
    });
  },
});

export const mergeDuplicatePeople = mutation({
  args: {
    chapterId: v.id("chapters"),
    fromId: v.id("people"),
    toId: v.id("people"),
  },
  returns: v.object({
    repointed: v.record(v.string(), v.number()),
    fieldsFilled: v.array(v.string()),
  }),
  handler: async (ctx, { chapterId, fromId, toId }) => {
    // "Anyone on the team" — deliberately NOT the public, admin-gated
    // `dataHygiene.mergePeople`'s `isChapterAdmin` check. See
    // `dataHygiene.ts#mergePeopleCore`'s doc for why the core logic is
    // shared instead of reimplemented.
    await requireReviewGuestIdentity(ctx, chapterId);

    const fromPerson = await ctx.db.get(fromId);
    const toPerson = await ctx.db.get(toId);
    if (!fromPerson || !toPerson) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Person not found." });
    }

    // Computed BEFORE the merge deletes `fromPerson` — `toId` is the
    // candidate (the survivor), `fromId` the subject (the duplicate).
    const evidenceHash = computeIdentityEvidenceHash({
      candidateName: toPerson.name,
      candidateEmail: toPerson.email,
      candidatePhone: toPerson.phone,
      subjectName: fromPerson.name,
      subjectEmail: fromPerson.email,
      subjectPhone: fromPerson.phone,
    });

    const result = await mergePeopleCore(ctx, {
      chapterId,
      survivorId: toId,
      duplicateId: fromId,
    });

    const decidedBy = (await requireUserId(ctx)) as Id<"users">;
    await ctx.db.insert("identityDecisions", {
      chapterId,
      kind: "person_merge",
      subjectKey: String(fromId),
      candidatePersonId: toId,
      verdict: "same",
      evidenceHash,
      decidedBy,
      decidedAt: Date.now(),
    });

    return result;
  },
});
