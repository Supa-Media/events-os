import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";
import type { Id } from "../_generated/dataModel";
import { normalizeEmail } from "../lib/access";
import { SOURCE_RANK, type PersonEmailSource } from "../lib/personEmails";

/**
 * Person Emails backfill (person-centric audiences Phase 2 item 1 —
 * specs/person-centric-audiences.md).
 *
 * `personEmails` shipped in the same deploy as this migration, so every
 * pre-existing email-bearing signal needs its ledger row stamped
 * retroactively — new signals get one for free at write time (`people.ts`'s
 * create/update, `lib/givingDonors.ts#linkDonorToPerson`,
 * `lib/rsvpPeople.ts#linkRsvpToPerson`, all via
 * `lib/personEmails.ts#recordPersonEmail`).
 *
 * FOUR SOURCES, ONE PASS EACH: this walks `people` (roster `email` +
 * `pwEmail`), `donors` (linked rows' `email`), and `rsvps` (linked rows'
 * `email`) — each its own full paginated scan, mirroring `0038`'s "the
 * dataset is small at this stage" assumption (same footing as `0032`/`0037`'s
 * own docs). `donors` has no `by_person` index (it's scoped by `by_scope*`
 * for its own CRM reads), so a full scan is the only way to find "every donor
 * linked to a person" — acceptable at this volume.
 *
 * DEDUPE BEFORE INSERT: candidates are grouped by (personId, normalized
 * email) BEFORE any write, keeping the single highest-trust candidate per
 * group — `verified: true` beats `false` first, then the SAME source rank
 * `lib/personEmails.ts#SOURCE_RANK` uses (pw > roster > donor > rsvp),
 * ties broken by earliest `addedAt` (deterministic, mirrors `0037`'s
 * "earliest" tie-break). This mirrors `recordPersonEmail`'s own upgrade-only
 * rule so a person who's simultaneously a roster member, a linked donor, AND
 * a repeat rsvp guest ends up with ONE row per distinct address, not one per
 * source.
 *
 * IDEMPOTENT: a (personId, email) pair that already has a `personEmails` row
 * — from a previous run of this migration OR a live write-through call that
 * happened to run first — is skipped outright, never duplicated, never
 * overwritten (this backfill never patches an existing row; only
 * `recordPersonEmail`'s live upgrade path does that).
 */

/** Rows per page during each table's scan. */
const PAGE_SIZE = 500;

type Candidate = {
  personId: Id<"people">;
  email: string; // normalized
  source: PersonEmailSource;
  verified: boolean;
  addedAt: number;
};

/** Pick the more-trustworthy candidate for a (personId, email) group: verified
 *  beats unverified, then higher source rank, then earliest `addedAt`. Pure —
 *  shared by every group resolution below. */
function preferCandidate(a: Candidate, b: Candidate): Candidate {
  if (a.verified !== b.verified) return a.verified ? a : b;
  if (SOURCE_RANK[a.source] !== SOURCE_RANK[b.source]) {
    return SOURCE_RANK[a.source] > SOURCE_RANK[b.source] ? a : b;
  }
  return a.addedAt <= b.addedAt ? a : b;
}

export async function runBackfillPersonEmails(ctx: MutationCtx) {
  const winners = new Map<string, Candidate>(); // key: `${personId}::${email}`
  const addCandidate = (c: Candidate) => {
    const key = `${c.personId}::${c.email}`;
    const existing = winners.get(key);
    winners.set(key, existing ? preferCandidate(existing, c) : c);
  };

  // ── people: roster `email` + `pwEmail` ──────────────────────────────────
  let peopleScanned = 0;
  {
    let cursor: string | null = null;
    for (;;) {
      const page = await ctx.db.query("people").paginate({ numItems: PAGE_SIZE, cursor });
      for (const p of page.page) {
        peopleScanned++;
        const roster = normalizeEmail(p.email);
        if (roster) {
          addCandidate({ personId: p._id, email: roster, source: "roster", verified: true, addedAt: p.createdAt });
        }
        const pw = normalizeEmail(p.pwEmail);
        if (pw) {
          addCandidate({ personId: p._id, email: pw, source: "pw", verified: true, addedAt: p.createdAt });
        }
      }
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
  }

  // ── donors: linked rows' email ──────────────────────────────────────────
  let donorsScanned = 0;
  {
    let cursor: string | null = null;
    for (;;) {
      const page = await ctx.db.query("donors").paginate({ numItems: PAGE_SIZE, cursor });
      for (const d of page.page) {
        donorsScanned++;
        if (!d.personId) continue;
        const email = normalizeEmail(d.email);
        if (!email) continue;
        // CRM data is staff-entered or import-matched, never an anonymous
        // public-form capture — trusted at write time, same as the live
        // `linkDonorToPerson` write-through.
        addCandidate({ personId: d.personId, email, source: "donor", verified: true, addedAt: d.createdAt });
      }
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
  }

  // ── rsvps: linked rows' email ────────────────────────────────────────────
  let rsvpsScanned = 0;
  {
    let cursor: string | null = null;
    for (;;) {
      const page = await ctx.db.query("rsvps").paginate({ numItems: PAGE_SIZE, cursor });
      for (const r of page.page) {
        rsvpsScanned++;
        if (!r.personId) continue;
        const email = normalizeEmail(r.email);
        if (!email) continue;
        // `false` = a pending unconfirmed code; `true`/`undefined` (legacy or
        // imported rows) reads as verified — the same `!== false` gate
        // `lib/audienceResolve.ts#resolveGuests` and the live rsvp write-through use.
        addCandidate({
          personId: r.personId,
          email,
          source: "rsvp",
          verified: r.emailVerified !== false,
          addedAt: r.createdAt,
        });
      }
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
  }

  // Idempotent insert, one bounded `personEmails` read per DISTINCT person
  // touched (cached across that person's multiple winning candidates).
  const existingByPerson = new Map<string, Set<string>>();
  const loadExisting = async (personId: Id<"people">): Promise<Set<string>> => {
    const key = String(personId);
    const cached = existingByPerson.get(key);
    if (cached) return cached;
    const rows = await ctx.db
      .query("personEmails")
      .withIndex("by_person", (q) => q.eq("personId", personId))
      .collect();
    const set = new Set(rows.map((r) => r.email));
    existingByPerson.set(key, set);
    return set;
  };

  let inserted = 0;
  let alreadyPresent = 0;
  for (const winner of winners.values()) {
    const present = await loadExisting(winner.personId);
    if (present.has(winner.email)) {
      alreadyPresent++;
      continue;
    }
    await ctx.db.insert("personEmails", {
      personId: winner.personId,
      email: winner.email,
      source: winner.source,
      verified: winner.verified,
      addedAt: winner.addedAt,
    });
    present.add(winner.email);
    inserted++;
  }

  return {
    peopleScanned,
    donorsScanned,
    rsvpsScanned,
    candidateGroups: winners.size,
    inserted,
    alreadyPresent,
  };
}

export const backfillPersonEmails: Migration = {
  name: "0039_backfill_person_emails",
  run: runBackfillPersonEmails,
};
