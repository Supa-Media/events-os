/**
 * Person Emails write-through + send-address resolution (person-centric
 * audiences Phase 2 — specs/person-centric-audiences.md Phase 2 items 1/2).
 * See `schema/people.ts#personEmails`'s module doc for the table shape and
 * the four write-through call sites.
 *
 * `recordPersonEmail` is the ONE choke point every write-through call site
 * uses (mirrors `lib/givingDonors.ts`'s "one primitive, several callers"
 * shape) — additive/upgrade-only, so re-observing a lower-trust source or an
 * unverified flag never regresses an existing row.
 */
import { Doc, Id } from "../_generated/dataModel";
import { MutationCtx } from "../_generated/server";
import { normalizeEmail } from "./access";
import { PERSON_EMAIL_SOURCES } from "../schema/people";

export type PersonEmailSource = (typeof PERSON_EMAIL_SOURCES)[number];

/** Provenance trust order (highest first) — mirrors `schema/people.ts`'s
 *  `PERSON_EMAIL_SOURCES` doc. `"manual"` outranks everything: a human
 *  explicitly attaching an address is more trustworthy than any automated
 *  match, even though nothing writes that source yet. Exported so
 *  `migrations/0039_backfill_person_emails.ts` picks a winner across MULTIPLE
 *  candidate sources with the exact same order this file's upgrade-only
 *  `recordPersonEmail` uses — one trust order, not two. */
export const SOURCE_RANK: Record<PersonEmailSource, number> = {
  manual: 5,
  pw: 4,
  roster: 3,
  donor: 2,
  rsvp: 1,
};

/**
 * Write-through upsert: record that `email` (normalized) belongs to
 * `personId`, learned from `source`. A no-op when `email` is blank/absent —
 * every call site passes an optional field straight through rather than
 * pre-checking it.
 *
 * UPGRADE-ONLY: if a `personEmails` row for this exact (person, email) pair
 * already exists, it's patched ONLY when the new observation is strictly more
 * trustworthy — `verified` flips false → true (never true → false) and
 * `source` moves to a HIGHER-ranked source (never lower). A later, weaker
 * observation of an address this table already trusts more is silently
 * accepted as a confirmation, not a downgrade. Never touches `isPrimary` —
 * that's exclusively `setPrimaryEmail`'s call.
 */
export async function recordPersonEmail(
  ctx: MutationCtx,
  args: {
    personId: Id<"people">;
    email?: string | null;
    source: PersonEmailSource;
    verified: boolean;
  },
): Promise<void> {
  const email = normalizeEmail(args.email);
  if (!email) return;

  const existing = await ctx.db
    .query("personEmails")
    .withIndex("by_person", (q) => q.eq("personId", args.personId))
    .collect();
  const match = existing.find((e) => e.email === email);

  if (match) {
    const patch: Partial<Doc<"personEmails">> = {};
    if (args.verified && !match.verified) patch.verified = true;
    if (SOURCE_RANK[args.source] > SOURCE_RANK[match.source]) {
      patch.source = args.source;
    }
    if (Object.keys(patch).length > 0) await ctx.db.patch(match._id, patch);
    return;
  }

  await ctx.db.insert("personEmails", {
    personId: args.personId,
    email,
    source: args.source,
    verified: args.verified,
    addedAt: Date.now(),
  });
}

/**
 * Send-address precedence (Phase 2 item 2): explicit `isPrimary` row >
 * `person.pwEmail` > `person.email` > the most-recently-added VERIFIED
 * `personEmails` row > `null` (nothing usable). Pure — no I/O — so preview
 * and send resolution (`lib/audienceResolve.ts`) and the unit tests below
 * share the exact same decision.
 *
 * The first two tiers read `person`'s own fields directly rather than the
 * `personEmails` rows sourced FROM them, so a person with no `personEmails`
 * rows yet (pre-backfill, or a row inserted outside every write-through path)
 * still resolves correctly off `pwEmail ?? email` — the pre-Phase-2 fallback
 * `lib/audienceResolve.ts#resolvePeople` used to hardcode.
 */
export function resolveSendAddress(
  person: Pick<Doc<"people">, "email" | "pwEmail">,
  emails: Doc<"personEmails">[],
): string | null {
  const primary = emails.find((e) => e.isPrimary === true);
  if (primary) return primary.email;

  const pw = normalizeEmail(person.pwEmail);
  if (pw) return pw;

  const roster = normalizeEmail(person.email);
  if (roster) return roster;

  const verified = emails.filter((e) => e.verified === true);
  if (verified.length > 0) {
    const latest = verified.reduce((a, b) => (b.addedAt > a.addedAt ? b : a));
    return latest.email;
  }

  return null;
}
