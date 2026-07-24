/**
 * Guest → Person linkage (person-centric audiences, specs/person-centric-
 * audiences.md Phase 1 item 2) — mirrors `lib/givingDonors.ts#linkDonorToPerson`'s
 * match-or-create shape for the OTHER automated `people` creation source: a
 * public RSVP/ticket/donation guest. All six rsvp insert sites (`submitRsvp`,
 * `prepareOrder` in ticketing.ts, `givebutterSync.ts` ×2, `prepareDonation` in
 * giving.ts, and `eventAttendanceImport.ts`) call this right after their own
 * insert so a guest who's also on the roster (or a previously-seen contact)
 * gets `rsvps.personId` stamped instead of staying an orphan row; a guest
 * nobody's seen before becomes a fresh CONTACT-ONLY `people` row (never a
 * roster teammate) so they're identity-matchable on their NEXT event without
 * cluttering roster-facing surfaces (`people.isContactOnly` — see
 * `schema/people.ts`).
 *
 * Match order (against `lib/org.ts#chapterRoster`, which already excludes
 * `isPlaceholder`/`isSamplePerson` — a bounded read, one chapter's roster —
 * and DELIBERATELY still includes contact rows, since a repeat guest's own
 * prior-event contact row must be matchable):
 *  1. normalized-lowercase email (both sides case-insensitive),
 *  2. exact phone (both sides trimmed),
 *  3. exact trimmed name.
 * No match → insert a minimal contact row (mirrors `linkDonorToPerson`'s
 * insert shape) IFF `hasPersonIdentifier` (email or phone) — a name-only
 * guest never spawns a roster row (see that function's OWNER RULE doc).
 *
 * BEST-EFFORT BY DESIGN: linking is a nice-to-have, the RSVP write is not —
 * every call site awaits this AFTER its own insert has already committed the
 * write it actually needs. Every failure here is caught and logged, never
 * rethrown, so a matching hiccup can never break a guest's RSVP/ticket/
 * donation. This is why the try/catch lives INSIDE the helper (once) instead
 * of being repeated at all six call sites.
 *
 * DIVERGENT NAMES ON A SHARED EMAIL (spec risk #4 — a family/household inbox
 * used by more than one attendee): this helper does NOT guard against it —
 * like `linkDonorToPerson`, an email match wins regardless of name, because a
 * single insert site has no visibility into any OTHER rsvp row that might
 * share the email. That cross-row visibility only exists at backfill time,
 * which is where the guard actually lives: `migrations/0037_link_rsvp_people`
 * groups rows by (chapter, email) BEFORE calling this helper and calls it only
 * for the winning name in a divergent group, leaving the rest unlinked. A live
 * single-row divergent case (rare — two family members RSVPing under a shared
 * inbox for the FIRST time within the SAME event's lifetime) can still merge;
 * a human un-links it from the People tab like any other bad match.
 *
 * ============================================================================
 * PRELOADED-ROSTER VARIANT — hotfix 0037-roster-reads (prod incident,
 * 2026-07-24): `linkRsvpToPerson` self-loads the chapter roster
 * (`chapterRoster` — an unbounded `.collect()`) on EVERY call, which is fine
 * for a live insert site (one call, one roster load) but not for a batch
 * caller processing many rows in one execution — `migrations/0037_link_rsvp_
 * people.ts` was already loading + caching its own roster per chapter for
 * anchor lookups, then calling THIS function, which reloaded the SAME
 * roster from scratch on every single row anyway. At 1000 rows/page that
 * doubled/tripled the cumulative documents read within one execution past
 * Convex's 32,000-per-execution cap, and — because `linkRsvpToPerson` catches
 * every error internally (see BEST-EFFORT BY DESIGN above) — the failures
 * were silently swallowed and miscounted as "no identifier" skips instead of
 * surfacing as failures.
 *
 * `linkRsvpToPersonWithRoster` (below) takes an ALREADY-LOADED, MUTABLE
 * roster array and matches against it directly — no per-call reload. It also
 * APPENDS a freshly created contact onto that SAME array, so a caller
 * processing many rows for one chapter in one execution (like 0037) sees
 * each new contact immediately, without a fresh DB read — the in-memory
 * equivalent of `linkRsvpToPerson`'s natural reads-your-writes behavior. It
 * returns a discriminated result instead of swallowing exceptions, so a
 * batch caller can count a genuine failure as a FAILURE, never as a
 * false-negative "skipped, no identifier".
 *
 * `linkRsvpToPerson` itself is UNCHANGED for every live insert site (still
 * self-loads, still catches-and-logs) — it's now a thin wrapper over the same
 * core logic (`linkRsvpToPersonCore`), so both variants stay in lockstep.
 * ============================================================================
 */
import { Doc, Id } from "../_generated/dataModel";
import { MutationCtx } from "../_generated/server";
import { normalizeEmail } from "./access";
import { chapterRoster } from "./org";
import { hasPersonIdentifier } from "./givingDonors";
import { recordPersonEmail } from "./personEmails";

/**
 * Pure match step, shared by the live linker (below) and the backfill's
 * dry-run preview (which must not write) — the SAME email → phone → name
 * order `linkDonorToPerson` uses, just against an already-loaded roster.
 */
export function findPersonMatch(
  roster: Doc<"people">[],
  opts: { email?: string | null; phone?: string | null; name?: string },
): Doc<"people"> | null {
  const email = normalizeEmail(opts.email) ?? undefined;
  const phone = opts.phone?.trim() || undefined;
  const name = opts.name?.trim();
  return (
    (email && roster.find((p) => normalizeEmail(p.email) === email)) ||
    (phone && roster.find((p) => p.phone?.trim() === phone)) ||
    (name && roster.find((p) => p.name.trim() === name)) ||
    null
  );
}

type LinkArgs = {
  rsvpId: Id<"rsvps">;
  chapterId: Id<"chapters">;
  name: string;
  email?: string | null;
  phone?: string | null;
};

/**
 * Core match-or-create + write-through, no try/catch — throws on any
 * read/write failure. Shared by `linkRsvpToPerson` (self-loads the roster,
 * catches for live insert sites) and `linkRsvpToPersonWithRoster` (takes an
 * already-loaded roster, lets the caller decide how to handle a failure) —
 * see the module doc's "PRELOADED-ROSTER VARIANT" banner for why both exist.
 *
 * `roster`, when passed, is READ from for matching and, on a fresh insert,
 * MUTATED (pushed onto) so the caller's own cached array reflects the new
 * contact immediately — the in-memory equivalent of reads-your-writes for a
 * caller processing many rows against the same cached roster in one
 * execution. Omit it to self-load (unchanged single-call behavior).
 */
async function linkRsvpToPersonCore(
  ctx: MutationCtx,
  args: LinkArgs,
  roster?: Doc<"people">[],
): Promise<Id<"people"> | null> {
  const activeRoster = roster ?? (await chapterRoster(ctx, args.chapterId));
  const match = findPersonMatch(activeRoster, {
    email: args.email,
    phone: args.phone,
    name: args.name,
  });

  let personId: Id<"people">;
  if (match) {
    personId = match._id;
  } else {
    // OWNER RULE mirror (see `givingDonors.ts#hasPersonIdentifier`): never
    // insert a name-only roster row from an automated path. Matching above
    // is still allowed on name alone; only the insert is gated.
    if (!hasPersonIdentifier({ email: args.email, phone: args.phone })) {
      return null;
    }
    const insertedId = await ctx.db.insert("people", {
      chapterId: args.chapterId,
      name: args.name,
      ...(args.email ? { email: args.email } : {}),
      ...(args.phone ? { phone: args.phone } : {}),
      isTeamMember: false,
      isContactOnly: true,
      notes: "Added from RSVP",
      createdAt: Date.now(),
    });
    personId = insertedId;
    if (roster) {
      // Append to the CALLER's cached array so a later row in the same
      // execution (e.g. a sibling in the same 0037 page) matches this
      // contact instead of racing to create a second one — see the module
      // doc banner.
      const created = await ctx.db.get(insertedId);
      if (created) roster.push(created);
    }
  }

  // Person-centric audiences Phase 2 (specs/person-centric-audiences.md
  // item 1) — write-through: this rsvp's own email joins the linked
  // person's `personEmails` ledger on EVERY link (matched OR freshly
  // created), so a repeat guest's several rsvp rows converge on the SAME
  // known address instead of only living on `people.email`. `verified`
  // reads the JUST-INSERTED/patched rsvp row's OWN persisted
  // `emailVerified` flag (a fresh `ctx.db.get`, not `args` — the caller may
  // have constructed `args.email` before the verification flag settled):
  // `false` = a pending unconfirmed code, `true`/`undefined` (legacy or
  // imported rows) = verified — the same `!== false` gate
  // `resolveGuests` uses elsewhere.
  if (args.email) {
    const rsvpDoc = await ctx.db.get(args.rsvpId);
    await recordPersonEmail(ctx, {
      personId,
      email: args.email,
      source: "rsvp",
      verified: rsvpDoc?.emailVerified !== false,
    });
  }

  await ctx.db.patch(args.rsvpId, { personId });
  return personId;
}

export async function linkRsvpToPerson(
  ctx: MutationCtx,
  args: LinkArgs,
): Promise<Id<"people"> | null> {
  try {
    return await linkRsvpToPersonCore(ctx, args);
  } catch (err) {
    // Best-effort (see module doc): never let a linking failure surface to a
    // guest mid-RSVP/checkout — the caller's own insert already committed.
    console.error("linkRsvpToPerson failed", err);
    return null;
  }
}

/** Discriminated outcome for `linkRsvpToPersonWithRoster` — unlike
 *  `linkRsvpToPerson`'s bare `Id | null`, this lets a batch caller tell a
 *  genuine "no identifier to link/create from" apart from an infrastructure
 *  FAILURE (a thrown error) instead of miscounting the latter as the former
 *  (see the module doc's "PRELOADED-ROSTER VARIANT" banner — this is the
 *  exact miscount that hid the 0037 prod incident's real failure count).
 *  `error` is stringified (never the raw thrown value) — the full error is
 *  already `console.error`-logged below; a plain string keeps this result a
 *  normal, freely-passable value (e.g. through `ctx.db`/scheduler args or a
 *  test's `t.run`, both of which reject non-Convex-serializable values like a
 *  raw `Error`). */
export type LinkWithRosterResult =
  | { status: "linked"; personId: Id<"people"> }
  | { status: "skipped" }
  | { status: "failed"; error: string };

/**
 * Preloaded-roster variant for a batch caller processing many rows against
 * the SAME cached roster in one execution (`migrations/0037_link_rsvp_
 * people.ts`) — see the module doc's banner. Matches against `roster`
 * directly (no per-call reload) and appends a freshly created contact onto
 * it in place. Still catches every error (same best-effort spirit as
 * `linkRsvpToPerson` — one bad row must not abort an entire page's worth of
 * otherwise-good links), but reports the outcome truthfully instead of
 * collapsing every non-link into the same bucket.
 */
export async function linkRsvpToPersonWithRoster(
  ctx: MutationCtx,
  args: LinkArgs,
  roster: Doc<"people">[],
): Promise<LinkWithRosterResult> {
  try {
    const personId = await linkRsvpToPersonCore(ctx, args, roster);
    return personId ? { status: "linked", personId } : { status: "skipped" };
  } catch (err) {
    console.error("linkRsvpToPersonWithRoster failed", err);
    return { status: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}
