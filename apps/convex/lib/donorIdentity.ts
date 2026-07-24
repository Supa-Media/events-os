/**
 * Cross-chapter donor IDENTITY layer (donor-identity, 2026-07) — the write-side
 * primitives that keep the `donorIdentities` table (schema/givingPlatform.ts) in
 * sync with the scope-partitioned `donors` rows underneath it.
 *
 * The problem this solves: the giving book is per-`(scope, person)` on purpose,
 * so someone who gives to BOTH central and a chapter is two `donors` rows (each
 * chapter keeps its donors separate). This layer sits OVER those rows — a donor
 * who gives to everyone shows up as ONE identity carrying the `scopes` they're
 * part of.
 *
 * INVARIANTS (money-adjacent — see the schema doc):
 *  - ADDITIVE. A `donors` row's own per-scope rollups (`lifetimeCents`,
 *    `giftCount`, …) are NEVER touched here. The identity keeps its OWN
 *    aggregate, RECOMPUTED from its rows (never a blind bump, so it can't
 *    drift — there is at most one donor per scope, so the recompute is a small
 *    bounded read).
 *  - The grouping KEY is normalized email (primary), else exact phone, else
 *    exact normalized name — the same person-across-books rule
 *    `listOrgDonorsByIdentity` reads at query time, now persisted. `personId`
 *    is a per-chapter roster row that can never be shared across two
 *    scope-partitioned donors, so it never groups cross-book; email is the
 *    stored key (the donors table's own documented "primary key").
 *
 * Every helper is a plain async function on `MutationCtx` (not a registered
 * function), mirroring `lib/givingDonors.ts`, so callers invoke them directly.
 */
import { Doc, Id } from "../_generated/dataModel";
import { MutationCtx } from "../_generated/server";
import { normalizeEmail } from "./access";
import type { GivingScope } from "./givingAccess";

/**
 * Bounded read of an identity's `donors` rows for the aggregate recompute. One
 * donor per scope (scope-partitioned), so the realistic ceiling is central +
 * every chapter — this generous cap keeps the recompute a bounded, indexed read
 * (`donors.by_identity`), never an unbounded scan.
 */
const IDENTITY_DONOR_CAP = 500;

/**
 * Normalized-lowercase name key — the weakest identity-grouping fallback, kept
 * byte-identical to `givingPlatform.ts#normNameKey` (which
 * `listOrgDonorsByIdentity` reads with) so the persisted key matches the
 * read-time grouping exactly.
 */
export function normNameKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The stored grouping key for a donor: normalized email (primary) → exact
 * trimmed phone → exact normalized name. A stable string that two
 * scope-partitioned rows for the same underlying person resolve to identically.
 */
export function donorIdentityKey(donor: {
  email?: string;
  phone?: string;
  name: string;
}): string {
  const email = normalizeEmail(donor.email) ?? undefined;
  if (email) return `e:${email}`;
  const phone = donor.phone?.trim() || undefined;
  if (phone) return `p:${phone}`;
  return `n:${normNameKey(donor.name)}`;
}

/**
 * Recompute + persist an identity's aggregate from its CURRENT `donors` rows:
 * lifetime = Σ per-scope lifetime, giftCount = Σ per-scope giftCount, lastGiftAt
 * = max, `scopes` = the distinct set of the rows' scopes, `name` = the
 * strongest-lifetime row's name. If the identity has NO rows left (its last
 * donor re-keyed away), the husk is deleted — this layer is additive
 * scaffolding, never money data, so a stray empty identity is safe to remove.
 */
async function recomputeIdentityAggregates(
  ctx: MutationCtx,
  identityId: Id<"donorIdentities">,
): Promise<void> {
  const rows = await ctx.db
    .query("donors")
    .withIndex("by_identity", (q) => q.eq("identityId", identityId))
    .take(IDENTITY_DONOR_CAP);

  if (rows.length === 0) {
    await ctx.db.delete(identityId);
    return;
  }

  let lifetimeCents = 0;
  let giftCount = 0;
  let lastGiftAt: number | undefined;
  const scopeSet = new Set<GivingScope>();
  // Display name: prefer the strongest-lifetime row with a non-blank name.
  let name = rows[0].name;
  let bestLifetime = -1;
  for (const d of rows) {
    lifetimeCents += d.lifetimeCents;
    giftCount += d.giftCount;
    if (d.lastGiftAt !== undefined) {
      lastGiftAt =
        lastGiftAt === undefined ? d.lastGiftAt : Math.max(lastGiftAt, d.lastGiftAt);
    }
    scopeSet.add(d.scope);
    if (d.lifetimeCents > bestLifetime && d.name.trim().length > 0) {
      bestLifetime = d.lifetimeCents;
      name = d.name;
    }
  }

  await ctx.db.patch(identityId, {
    name,
    lifetimeCents,
    giftCount,
    ...(lastGiftAt !== undefined ? { lastGiftAt } : { lastGiftAt: undefined }),
    scopes: [...scopeSet],
  });
}

/**
 * Attach a donor to its identity — the single choke point every write path
 * calls after touching a donor. Idempotent:
 *  1. compute the donor's current grouping key;
 *  2. find (or create) the `donorIdentities` row for that key;
 *  3. point `donor.identityId` at it if not already;
 *  4. recompute that identity's aggregate (and, if the donor moved off a PRIOR
 *     identity because its email/phone/name changed, recompute the prior one
 *     too — which garbage-collects it if now empty).
 *
 * Reads the donor FRESH by id so callers can invoke it right after a patch
 * without threading the updated doc. A no-op-safe: called repeatedly it settles
 * to the same state and writes nothing new once consistent.
 */
export async function syncDonorIdentity(
  ctx: MutationCtx,
  donorId: Id<"donors">,
): Promise<Id<"donorIdentities"> | null> {
  const donor = await ctx.db.get(donorId);
  if (!donor) return null;

  const key = donorIdentityKey(donor);
  const prior = donor.identityId;

  // The identity might already be the right one (same key) — then only its
  // aggregate needs a refresh (a gift landed/left).
  const existing = await ctx.db
    .query("donorIdentities")
    .withIndex("by_key", (q) => q.eq("key", key))
    .first();

  let identityId: Id<"donorIdentities">;
  if (existing) {
    identityId = existing._id;
  } else {
    const email = normalizeEmail(donor.email) ?? undefined;
    const phone = donor.phone?.trim() || undefined;
    identityId = await ctx.db.insert("donorIdentities", {
      key,
      ...(email ? { email } : {}),
      name: donor.name,
      ...(phone ? { phone } : {}),
      lifetimeCents: 0,
      giftCount: 0,
      scopes: [],
      createdAt: Date.now(),
    });
  }

  if (prior !== identityId) {
    await ctx.db.patch(donorId, { identityId });
  }

  // If the donor re-keyed off a different identity, refresh the one it left
  // (recompute deletes it when it becomes empty).
  if (prior && prior !== identityId) {
    await recomputeIdentityAggregates(ctx, prior);
  }
  await recomputeIdentityAggregates(ctx, identityId);
  return identityId;
}
