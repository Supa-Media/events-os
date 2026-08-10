import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";

/**
 * Stamp `watermarkFromRun: true` on every notification rule that already has a
 * `lastSentAt`.
 *
 * ── WHY A ROW WITHOUT IT IS WRONG, NOT JUST UNLABELLED ─────────────────────
 * `watermarkFromRun` says which of two things `lastSentAt` is: a REPORT set by
 * a digest run (resume from it exactly — those gifts have been mailed) or a
 * synthetic BOUNDARY stamped by `setRuleActive`/`saveRule` (a window may reach
 * a full period back past it). Absent reads as the second, which is the safe
 * default for a field that has to mean something on day one — but every row
 * that exists when this ships got its watermark from a RUN, so every one of
 * them is mislabelled until its next claim re-stamps it.
 *
 * Self-healing, and one window of overlap was the estimate. The estimate was
 * wrong for one shape: a rule caught MID-DRAIN. A cut window parks the
 * watermark part-way through a period and clears `lastRunDayKey` so the drain
 * continues on the next hourly tick; read as a boundary, that mark gets the
 * trailing-period floor, so the next run re-reads from a period back, matches
 * the same first 750 gifts, and mails a BYTE-IDENTICAL duplicate digest before
 * the flag it just stamped takes effect. It recovers on the run after, and no
 * gift is ever skipped — but a duplicate digest to a fundraising team is
 * exactly the kind of thing that costs a new feature its credibility, and it
 * costs one `patch` per rule to not happen at all.
 *
 * ── WHY `lastSentAt !== undefined` IS THE WHOLE TEST ───────────────────────
 * A rule with no watermark needs nothing: `digestWindowStart`'s never-reported
 * case gives it exactly one trailing period regardless. And at the instant this
 * runs, a watermark can only have come from `claimDigest` — the two synthetic
 * writers ship in the same commit as the flag and clear it, so a boundary stamp
 * that predates the field cannot exist. (After this runs, an unflagged
 * watermark means a genuine synthetic boundary again, which is the steady
 * state.)
 *
 * Idempotent, and safe on a re-run for a reason worth stating: it only ever
 * SETS the flag on a row that has a watermark and lacks it. It never clears
 * one, so a rule legitimately paused-and-resumed after this migration is
 * ledgered and untouched anyway — and would be unharmed even if it weren't.
 */
export async function runStampDigestWatermarkProvenance(ctx: MutationCtx) {
  let patched = 0;
  let skipped = 0;

  // Rules are hand-authored config and bounded at MAX_RULES (200), so the whole
  // table is one small read — no pagination, no scheduler continuation.
  const rules = await ctx.db.query("givingNotificationRules").collect();
  for (const rule of rules) {
    if (rule.lastSentAt === undefined || rule.watermarkFromRun) {
      skipped++;
      continue;
    }
    await ctx.db.patch(rule._id, { watermarkFromRun: true });
    patched++;
  }

  return { patched, skipped };
}

export const stampDigestWatermarkProvenance: Migration = {
  name: "0061_stamp_digest_watermark_provenance",
  run: runStampDigestWatermarkProvenance,
};
