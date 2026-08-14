/**
 * "THE PUBLIC PAGE IS BEHIND" — marking an already-published month as having
 * drifted from the live books, so the publish console can ASK for a
 * republication rather than waiting for someone to notice.
 *
 * Founder, 2026-08-14, describing what should happen when a personal charge is
 * finally paid back: "it should probably trigger — or it should ask to
 * republish, you know, the public ledgers and statements and stuff like that
 * if they're already published."
 *
 * ── WHY A MARK AND NOT A COMPARISON ─────────────────────────────────────────
 * The alternative is to detect staleness by rebuilding each month's snapshot
 * and diffing it against the published revision. That is a full snapshot build
 * per month per console load, and it makes "stale" mean whatever the snapshot
 * builder happens to mean this week — a refactor of the builder would light up
 * every month in the org as needing republication. A positive mark, stamped by
 * the write that actually caused the drift, says only what somebody did. Same
 * doctrine as `transactions.sourceCategory` / `feeOrigin` elsewhere in this
 * codebase: record the fact, don't re-infer it.
 *
 * ── WHAT IT IS NOT ──────────────────────────────────────────────────────────
 * It is not an auto-republish. Publishing a correction puts a new statement in
 * front of the world with a human's sentence explaining it (`republish`'s
 * `note`, minimum length enforced), and an amendment nobody chose to make is
 * an amendment nobody can explain. It is also not a lock: a stale month stays
 * live and readable the whole time, because the last approved numbers are
 * still the org's last approved numbers.
 *
 * ── UNPUBLISHED MONTHS ARE NOT STALE ────────────────────────────────────────
 * Every marker here no-ops unless the month is actually LIVE. A draft month
 * rebuilds from the books on every preview, so "drift" is not a thing that can
 * happen to it, and marking it would put a scary badge on a month whose whole
 * job is to change.
 */
import { easternParts } from "@events-os/shared";
import { MutationCtx } from "../_generated/server";
import { type FinanceScope } from "./finance";

/** `YYYY-MM` in America/New_York — the `periodKey` every publication is
 *  keyed by (`schema/publicLedger.ts`). */
export function periodKeyOf(ts: number): string {
  const { year, month } = easternParts(ts);
  return `${year}-${String(month).padStart(2, "0")}`;
}

/**
 * Mark the book/month that covers `ts` as drifted, if it is published.
 *
 * `reason` is one short sentence a publisher will recognize on the console
 * ("A personal charge was paid back") — it is shown verbatim, so write it for
 * a human, not for a log. The FIRST drift's timestamp is kept (how long the
 * public page has been behind); the reason is overwritten by the most recent
 * cause, which is the one most likely to still be in mind.
 *
 * Silent no-op when the month was never published, when there is no
 * publication row at all, or when the month is mid-amendment — an amendment in
 * flight is already on its way to republishing, and stamping it would put a
 * "needs republishing" badge on the very screen where it is being republished.
 */
export async function markPublicationStale(
  ctx: MutationCtx,
  scope: FinanceScope,
  ts: number,
  reason: string,
): Promise<void> {
  const periodKey = periodKeyOf(ts);
  const pub = await ctx.db
    .query("financePublications")
    .withIndex("by_scope_and_period", (q) =>
      q.eq("scope", scope).eq("periodKey", periodKey),
    )
    .unique();
  if (!pub) return;
  if (!pub.isLive) return;
  if (pub.status !== "published") return; // mid-amendment — already in hand
  const now = Date.now();
  await ctx.db.patch(pub._id, {
    staleSince: pub.staleSince ?? now,
    staleReason: reason,
    updatedAt: now,
  });
}

/**
 * Mark every month a single correction touches, deduped.
 *
 * One settlement moves two months in the general case: the month the original
 * charge posted in (whose published statement described it as still owed) and
 * the month the offsetting credit posts in (which now has a line it didn't
 * have). Those are usually different, occasionally the same, and both can be
 * published — hence a set rather than two calls at each site.
 *
 * Only the book that OWNS the row is marked. A chapter's charge is on the
 * chapter's book; Central publishes its own. Marking Central for every chapter
 * correction would put a permanent "needs republishing" badge on the one
 * console that couldn't act on it.
 */
export async function markPublicationsStale(
  ctx: MutationCtx,
  scope: FinanceScope,
  timestamps: readonly number[],
  reason: string,
): Promise<void> {
  const seen = new Set<string>();
  for (const ts of timestamps) {
    const key = periodKeyOf(ts);
    if (seen.has(key)) continue;
    seen.add(key);
    await markPublicationStale(ctx, scope, ts, reason);
  }
}
