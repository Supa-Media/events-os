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
 */
import { Doc, Id } from "../_generated/dataModel";
import { MutationCtx } from "../_generated/server";
import { normalizeEmail } from "./access";
import { chapterRoster } from "./org";
import { hasPersonIdentifier } from "./givingDonors";

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

export async function linkRsvpToPerson(
  ctx: MutationCtx,
  args: {
    rsvpId: Id<"rsvps">;
    chapterId: Id<"chapters">;
    name: string;
    email?: string | null;
    phone?: string | null;
  },
): Promise<Id<"people"> | null> {
  try {
    const roster = await chapterRoster(ctx, args.chapterId);
    const match = findPersonMatch(roster, {
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
      personId = await ctx.db.insert("people", {
        chapterId: args.chapterId,
        name: args.name,
        ...(args.email ? { email: args.email } : {}),
        ...(args.phone ? { phone: args.phone } : {}),
        isTeamMember: false,
        isContactOnly: true,
        notes: "Added from RSVP",
        createdAt: Date.now(),
      });
    }

    await ctx.db.patch(args.rsvpId, { personId });
    return personId;
  } catch (err) {
    // Best-effort (see module doc): never let a linking failure surface to a
    // guest mid-RSVP/checkout — the caller's own insert already committed.
    console.error("linkRsvpToPerson failed", err);
    return null;
  }
}
