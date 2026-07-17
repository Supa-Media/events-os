import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

/**
 * ONE-OFF cleanup (2026-07-17): remove 13 `relay_csv` transactions that each
 * duplicate a live `stripe_fc` twin.
 *
 * Root cause: the same underlying account (`fca_1TtY3M…RH8mJ`) was ingested
 * through BOTH the live Stripe Financial Connections sync (`stripe_fc`) and a
 * manual Relay CSV import (`relay_csv`). The two feeds carry different
 * `externalId` prefixes, so `transactions.by_external_id` dedup never collides
 * them. They also timestamp differently (stripe = real time; relay = normalized
 * to 16:00 UTC), so the pairs land on adjacent calendar days and evade a
 * same-day amount match. Within the 2.5-month window where both feeds overlap
 * (2026-04-17 → 2026-07-03) every relay row has a stripe twin — 13 pairs.
 *
 * We keep the live `stripe_fc` rows (ongoing, self-deduping, real
 * descriptions/timestamps) and delete the redundant `relay_csv` rows. A prior
 * coding comparison confirmed no relay row carries fund/category/budget/note/
 * receipt that its stripe twin lacks (the PRINT MOR pair is in fact BETTER coded
 * on the stripe side), so nothing is lost.
 *
 * The SQ Mexican relay row is referenced by a `reattributionAudit`
 * (project_transfer) row — that is safe: `restoreReattribution` skips a missing
 * transaction (`if (!txn) { skipped++; continue; }`), and `listReattributionAudit`
 * only over-counts that one historical row's txnCount by 1 (cosmetic).
 *
 * Guarded + idempotent: a row is deleted only if the id resolves, its
 * `source === "relay_csv"`, and its `amountCents` matches the expected value
 * captured below. Re-running after success is a no-op (rows report "already
 * gone"). Run `{ "dryRun": true }` first to preview.
 *
 * Invoke on production via the `run-convex-function.yml` workflow:
 *   gh workflow run run-convex-function.yml \
 *     -f function=oneoffDedupeRelay:runDeleteRelayCsvDuplicates -f args='{"dryRun":true}'
 * then again with -f args='{}' to execute.
 */

// [transactions._id, expected amountCents, human label] — the 13 relay_csv dupes.
const RELAY_DUPLICATES: ReadonlyArray<readonly [string, number, string]> = [
  ["w1758t5b77mezdzvczevyvgkb18ajb13", 62326, "Tapstitch (4/20)"],
  ["w17ahp90w127c6xqb0bq5xjw1h8ajwxw", 1908, "Webflow (4/27)"],
  ["w17e1009td8t07nm1z29xh7tp58aj1kf", 1250, "Blackmagic Cloud (4/29)"],
  ["w17bj70afee8m5901e9x4jjthx8ajzsp", 1424, "Google (5/2)"],
  ["w172rvq163kstmb38pc64a99s98ajsea", 1908, "Webflow (5/27)"],
  ["w17f9y6agpfr25g52yv9h8nt5n8ak2xf", 14698, "PRINT MOR (5/27)"],
  ["w177tfeftw9e83fwcphfjtqp4x8aj3d4", 1250, "Blackmagic Cloud (5/29)"],
  ["w17amw0bz4t826argemyhcm2hs8ajg86", 1418, "Google (6/2)"],
  ["w174wwvs0x2xmf7qct11t8b3p98akx91", 4746, "SQ Authentic Mexican (6/7)"],
  ["w17bf16a3fms5xbvy77yxyxfps8ajg3f", 5000, "Dispute 133922 — Reversal (6/16)"],
  ["w17f8890wmxe6m6rqd290xhmn98ajt98", 5000, "Dispute 133922 — Final Credit (6/16)"],
  ["w17cdhr6mmsvhjmb5j98s84tss8akwd0", 1908, "Webflow (6/27)"],
  ["w176h61gdfr0mgeyh1nct0h4m58ajr95", 1429, "Google (7/2)"],
];

export const runDeleteRelayCsvDuplicates = internalMutation({
  args: { dryRun: v.optional(v.boolean()) },
  returns: v.object({
    dryRun: v.boolean(),
    deleted: v.number(),
    alreadyGone: v.number(),
    skipped: v.number(),
    details: v.array(
      v.object({
        id: v.string(),
        label: v.string(),
        action: v.string(),
        source: v.union(v.string(), v.null()),
        amountCents: v.union(v.number(), v.null()),
      }),
    ),
  }),
  handler: async (ctx, { dryRun }) => {
    const isDry = dryRun ?? false;
    let deleted = 0;
    let alreadyGone = 0;
    let skipped = 0;
    const details: Array<{
      id: string;
      label: string;
      action: string;
      source: string | null;
      amountCents: number | null;
    }> = [];

    for (const [rawId, expectedCents, label] of RELAY_DUPLICATES) {
      const id = ctx.db.normalizeId("transactions", rawId);
      if (!id) {
        skipped++;
        details.push({ id: rawId, label, action: "SKIP: invalid id", source: null, amountCents: null });
        continue;
      }
      const txn = await ctx.db.get(id);
      if (!txn) {
        alreadyGone++;
        details.push({ id: rawId, label, action: "already gone", source: null, amountCents: null });
        continue;
      }
      if (txn.source !== "relay_csv") {
        skipped++;
        details.push({ id: rawId, label, action: `SKIP: source is ${txn.source}`, source: txn.source, amountCents: txn.amountCents });
        continue;
      }
      if (txn.amountCents !== expectedCents) {
        skipped++;
        details.push({ id: rawId, label, action: `SKIP: amount ${txn.amountCents} != expected ${expectedCents}`, source: txn.source, amountCents: txn.amountCents });
        continue;
      }
      if (!isDry) await ctx.db.delete(id);
      deleted++;
      details.push({ id: rawId, label, action: isDry ? "would delete" : "deleted", source: txn.source, amountCents: txn.amountCents });
    }

    return { dryRun: isDry, deleted, alreadyGone, skipped, details };
  },
});
