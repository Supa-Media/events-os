/**
 * One-time: remove the 88 Givebutter gifts a cross-scope re-sync duplicated on
 * 2026-08-14, and the donor rows it minted to hold them.
 *
 * ── WHAT HAPPENED ───────────────────────────────────────────────────────────
 * The same 88 donations are in the books twice:
 *
 *   2026-07-19  CSV backfill, scope NEW YORK,  externalRef `gb:txn:<CSV ref>`
 *   2026-08-14  API sync,     scope CENTRAL,   externalRef `<16-char txn id>`
 *
 * Three separate defenses should each have caught it, and one changed variable
 * — the SCOPE — took out all three:
 *
 *  1. `externalRef` dedup: the CSV's "Reference Number" and the API's
 *     transaction id are different id spaces, so the keys never collide. This
 *     was known, and is why defense 2 exists.
 *  2. The legacy-backfill guard (`givebutterSync.ts`) looks for a `gb:txn:`
 *     twin at the same amount on the same day — but read only the ONE donor
 *     row it had just resolved.
 *  3. Donor matching (`findDonorInScope`) queries `by_scope_and_email`. The
 *     central sync could not see the New York donor, so it created a second
 *     row for the same person — same name, same email — and defense 2 then
 *     read that fresh row's empty history and found nothing.
 *
 * Result: 88 duplicate gifts ($7,324.75) and 71 duplicate donor rows. Because
 * `earned` is computed from gifts (not transactions), book value rose by the
 * full amount while the cash side did not move, and the reconciliation page
 * reported $7,228.25 "unaccounted for" — the duplicates less $96.50 of ACH
 * already netted out as in-flight.
 *
 * The cause is fixed in the same change (the guard now spans every donor row
 * belonging to one person, via the `donorIdentities` layer). This removes the
 * damage that fix cannot reach.
 *
 * ── HOW IT DECIDES WHAT TO DELETE, AND WHY THAT MATTERS ─────────────────────
 * `genesisDedupe2026` deleted six rows on "has a same-amount twin within two
 * days" and was WRONG about every one of them, because a twin can only be
 * spoken for ONCE and that pass never checked. Its own header is the standing
 * warning. So this runner does what that one didn't:
 *
 *  - It pairs ONE-TO-ONE. Each surviving `gb:txn:` original is consumed by at
 *    most one duplicate, so two genuine same-amount same-day gifts can never
 *    collapse onto one row.
 *  - It requires corroboration beyond amount + date: the two rows must belong
 *    to donors that are THE SAME PERSON — same identity, or the same
 *    normalized email. Amount and date alone are what made the genesis pass
 *    wrong.
 *  - It only ever deletes a BARE-id row (the API sync's key shape), and only
 *    against a `gb:txn:` partner (the CSV backfill's). The keeper is always
 *    the chapter-scoped original, and a candidate can never be suppressed
 *    against another candidate.
 *  - It refuses outright unless the totals match what was measured against
 *    production: 88 gifts, $7,324.75. A partial match means the ledger has
 *    moved since this was written and a human should look, so it reports and
 *    writes NOTHING rather than half-applying.
 *
 * ── WHAT IT DOES NOT TOUCH ──────────────────────────────────────────────────
 * The 2 genuinely new gifts from that same sync stay: Austin Erickson's $50.00
 * of 2026-08-13 (the one donation that really was missing) and Charisma
 * Stevens' $309.27 Stripe gift of 2026-08-14 (not a Givebutter row at all).
 * Neither pairs with anything, so neither is eligible.
 *
 * A duplicate DONOR row is deleted only when it ends up holding no gifts at
 * all — never one that has any history of its own. Its rollups are removed
 * through the same scope aggregates that created them.
 *
 * Delete this module once run.
 */
import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { ROLLUP_SCAN_LIMIT } from "./finances";
import { formatCents } from "@events-os/shared";
import { applyScopeDelta, removeGiftRow } from "./lib/givingDonors";
import { syncDonorIdentity } from "./lib/donorIdentity";

/** What was measured in production on 2026-08-14. The runner refuses unless it
 *  re-derives exactly this. */
const EXPECTED_GIFTS = 88;
const EXPECTED_CENTS = 732_475;

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const norm = (s: string | undefined) => (s ?? "").trim().toLowerCase();

/** The two rows describe the same human — the corroboration that amount+date
 *  alone cannot give. Identity first (the layer built for exactly this), email
 *  second for rows that predate it. A name match is deliberately NOT accepted:
 *  the duplicates include "Jude Omodon" vs "Chukwuka Jude Omodon", so names
 *  are known to disagree on the very rows this is about, and accepting them
 *  would also let two different people with one common name collapse. */
async function samePerson(
  ctx: MutationCtx,
  a: Doc<"donors"> | null,
  b: Doc<"donors"> | null,
): Promise<boolean> {
  if (!a || !b) return false;
  if (a._id === b._id) return true;
  // Email equality is the strong evidence, and it is what 71 of these 74 pairs
  // actually share.
  if (norm(a.email) !== "" && norm(a.email) === norm(b.email)) return true;
  // A shared identity counts ONLY when the identity is email-derived.
  // `donorIdentityKey` falls back to `p:<phone>` and then `n:<name>`, so a
  // shared identity can mean nothing more than a shared NAME — and every
  // blank-named donor becomes "Anonymous", which would put strangers on one
  // identity. Accepting that would be the name-only evidence this module's
  // header rejects, smuggled in through a different field.
  if (a.identityId && b.identityId && a.identityId === b.identityId) {
    const identity = await ctx.db.get(a.identityId);
    return (identity?.key ?? "").startsWith("e:");
  }
  return false;
}

type Pair = { dupe: Doc<"gifts">; keep: Doc<"gifts"> };

/**
 * Re-derive the duplicate set from the live table. Exported for its test, which
 * is the only way to exercise the pairing rules — the runner itself is bound to
 * production totals.
 */
export async function findCrossScopeDupes(ctx: MutationCtx): Promise<{
  pairs: Pair[];
  problems: string[];
}> {
  const problems: string[] = [];
  const gifts = await ctx.db.query("gifts").take(ROLLUP_SCAN_LIMIT);
  if (gifts.length === ROLLUP_SCAN_LIMIT) {
    problems.push(
      `gift scan hit ROLLUP_SCAN_LIMIT (${ROLLUP_SCAN_LIMIT}) — this is not a complete view`,
    );
  }
  const donorCache = new Map<Id<"donors">, Doc<"donors"> | null>();
  const donorOf = async (g: Doc<"gifts">) => {
    if (!g.donorId) return null;
    if (!donorCache.has(g.donorId)) donorCache.set(g.donorId, await ctx.db.get(g.donorId));
    return donorCache.get(g.donorId) ?? null;
  };

  // THE DISCRIMINATOR IS THE REF SHAPE, not a timestamp. A row from the API
  // sync carries a BARE Givebutter id — the API's key has no `:`, while every
  // other writer in this codebase namespaces its refs (`gb:`, `give:`,
  // `sale:`, `cashapp:`, `genesis:`). A row from the July CSV backfill carries
  // `gb:txn:`. Those two shapes are what tell the copy from the original, and
  // they are properties of the rows themselves rather than of when a cleanup
  // happens to run.
  //
  // An earlier draft also gated on `_creationTime` being the import's UTC day.
  // Dropped: it added no safety the totals assertion doesn't already give
  // (this refuses unless it re-derives exactly 88 gifts / $7,324.75), and it
  // made the pairing rules untestable — convex-test stamps every fixture row
  // with the current time, so no fixture can put an "original" before an
  // "import".
  // `method === "givebutter"` as well as the ref shape: the totals assertion
  // checks the SUM, not the composition, so without this an unrelated gift that
  // happens to carry a colon-free ref could take a slot in the 88 and a real
  // duplicate could go unremoved with the arithmetic still adding up.
  const candidates = gifts.filter(
    (g) =>
      g.method === "givebutter" &&
      typeof g.externalRef === "string" &&
      g.externalRef.length > 0 &&
      !g.externalRef.includes(":"),
  );

  // The pool of legitimate originals, keyed amount + received-day. `gb:txn:`
  // only — the CSV backfill's prefix, which this sync never writes, so a
  // candidate can never be suppressed against another candidate.
  const pool = new Map<string, Doc<"gifts">[]>();
  for (const g of gifts) {
    if (!String(g.externalRef ?? "").startsWith("gb:txn:")) continue;
    const k = `${g.amountCents}|${utcDay(g.receivedAt)}`;
    (pool.get(k) ?? pool.set(k, []).get(k)!).push(g);
  }

  const pairs: Pair[] = [];
  for (const dupe of candidates) {
    const k = `${dupe.amountCents}|${utcDay(dupe.receivedAt)}`;
    const bucket = pool.get(k);
    if (!bucket || bucket.length === 0) continue; // genuinely new — left alone
    const dupeDonor = await donorOf(dupe);
    // ONE-TO-ONE: the first original in this bucket that is the same person is
    // consumed and cannot be claimed again.
    let idx = -1;
    for (let i = 0; i < bucket.length; i++) {
      if (await samePerson(ctx, dupeDonor, await donorOf(bucket[i]))) {
        idx = i;
        break;
      }
    }
    if (idx === -1) continue; // same money, different person — NOT a duplicate
    pairs.push({ dupe, keep: bucket.splice(idx, 1)[0] });
  }
  return { pairs, problems };
}

export const removeCrossScopeGivebutterDupes = internalMutation({
  args: { execute: v.optional(v.boolean()) },
  returns: v.object({
    dryRun: v.boolean(),
    giftsDeleted: v.number(),
    centsRemoved: v.number(),
    donorsDeleted: v.number(),
    problems: v.array(v.string()),
    sample: v.array(v.string()),
  }),
  handler: async (ctx, { execute }) => {
    const write = execute ?? false;
    const { pairs, problems } = await findCrossScopeDupes(ctx);
    const centsRemoved = pairs.reduce((s, p) => s + p.dupe.amountCents, 0);

    if (pairs.length !== EXPECTED_GIFTS || centsRemoved !== EXPECTED_CENTS) {
      problems.push(
        `re-derived ${pairs.length} duplicate gift(s) worth ${formatCents(centsRemoved)}, ` +
          `expected ${EXPECTED_GIFTS} worth ${formatCents(EXPECTED_CENTS)} — the ledger has ` +
          `moved since this was written; re-derive before doing anything — NOTHING WRITTEN`,
      );
    }
    const sample = pairs
      .slice(0, 5)
      .map(
        (p) =>
          `${formatCents(p.dupe.amountCents)} ${utcDay(p.dupe.receivedAt)} ` +
          `dupe=${p.dupe.externalRef} keep=${p.keep.externalRef}`,
      );
    if (problems.length > 0) {
      return {
        dryRun: !write,
        giftsDeleted: 0,
        centsRemoved: 0,
        donorsDeleted: 0,
        problems,
        sample,
      };
    }

    const touchedDonors = new Set<Id<"donors">>();
    for (const p of pairs) {
      if (p.dupe.donorId) touchedDonors.add(p.dupe.donorId);
      // `removeGiftRow`, NOT a raw delete. Every rollup `recordGiftForDonor`
      // bumped on the way in has to come back down: the donor's
      // lifetime/count/bookends and derived status, the scope's
      // `lifetimeCents`/`giftCount` (which drive the giving dashboard and the
      // public wall's `raisedCents`), the identity aggregate, the territory
      // launch pot, and the event's `externalGiftsCents`. Nothing recomputes
      // those on a schedule, so a raw delete would remove the gift rows — and
      // fix the reconciliation page, which reads `gifts` directly — while
      // leaving the duplicated $7,324.75 standing on every rollup-driven
      // surface.
      if (write) await removeGiftRow(ctx, p.dupe._id);
    }

    // A donor row goes only if it is left holding nothing. Checked AFTER the
    // gift deletions so the answer is about the post-cleanup world; on a dry
    // run the gifts are still there, so this counts what WOULD be emptied.
    let donorsDeleted = 0;
    const dupeIds = new Set(pairs.map((p) => p.dupe._id));
    for (const donorId of touchedDonors) {
      const donor = await ctx.db.get(donorId);
      if (!donor) continue;
      // Read the donor's whole gift history, not a page of it: on a dry run the
      // duplicates are still present, so a `take(5)` could return five
      // duplicates and hide a sixth REAL gift — making the dry run promise a
      // deletion the execute run then (correctly) refuses. The dry run is the
      // approval basis, so it has to agree with the real one.
      const remaining = await ctx.db
        .query("gifts")
        .withIndex("by_donor", (q) => q.eq("donorId", donorId))
        .take(ROLLUP_SCAN_LIMIT);
      const stillHeld = remaining.filter((g) => write || !dupeIds.has(g._id));
      if (stillHeld.length > 0) continue;
      // A donor is referenced by more than gifts. `pledges` and `sponsorships`
      // both hold a NON-optional `donorId`, so deleting a row either points at
      // would leave a dangling required reference — worse than an unused donor.
      const pledge = await ctx.db
        .query("pledges")
        .withIndex("by_donor", (q) => q.eq("donorId", donorId))
        .first();
      const sponsorship = await ctx.db
        .query("sponsorships")
        .withIndex("by_donor", (q) => q.eq("donorId", donorId))
        .first();
      if (pledge || sponsorship) continue;
      donorsDeleted += 1;
      if (write) {
        // The scope's donorCount and per-status buckets were bumped when this
        // row was created; both have to come back down, exactly as
        // `dataHygiene.mergeDonors` does when it retires a duplicate.
        await applyScopeDelta(ctx, donor.scope, {
          donorDelta: -1,
          statusFrom: donor.status,
        });
        const identityId = donor.identityId;
        await ctx.db.delete(donorId);
        // The identity outlives the row; refresh its aggregate and `scopes` so
        // it stops claiming the deleted donor's money and its book.
        if (identityId) {
          const sibling = await ctx.db
            .query("donors")
            .withIndex("by_identity", (q) => q.eq("identityId", identityId))
            .first();
          if (sibling) await syncDonorIdentity(ctx, sibling._id);
        }
      }
    }

    console.log(
      `[givebutter] removeCrossScopeGivebutterDupes (${write ? "execute" : "dry run"}): ` +
        `${pairs.length} gifts (${formatCents(centsRemoved)}), ${donorsDeleted} emptied donor rows.`,
    );
    return {
      dryRun: !write,
      giftsDeleted: pairs.length,
      centsRemoved,
      donorsDeleted,
      problems: [],
      sample,
    };
  },
});
