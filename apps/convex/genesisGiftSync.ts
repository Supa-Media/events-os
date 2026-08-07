/**
 * One-time gift/expense realignment (2026-08-07) — a ONE-TIME ops module.
 *
 * Every owner-paid genesis expense mirrors an in-kind gift: `genesis-inkind-exp:<slug>`
 * against `genesis:<slug>`, same amount. Nothing enforces that pairing — the app has no
 * concept of a transaction mirroring a gift — so corrections made to one side over the
 * past two days drifted the two apart. This puts them back in step. It is DATA ONLY:
 * there is no sync mechanism, deliberately, because the org is not recording in-kind
 * gifts this way going forward (owner decision, 2026-08-07).
 *
 * SEVEN ROWS DRIFTED, in three ways:
 *
 *   1. FOUR ARE THIS SESSION'S OWN FAULT. `genesisCleanup` corrected transaction
 *      amounts against receipts (buy25:2, :3, :22, :25) but its patch path never moved
 *      the mirrored gift — unlike `genesisDedupe`, written later, which does. So the
 *      expense says what the receipt says and the gift still says what the estimate
 *      said.
 *   2. TWO WERE A HUMAN CORRECTION IN THE APP. buy25:4 and buy25:5 had $106.78 moved
 *      between them (the SM58 line became "2 x", the drum-set line dropped by the same
 *      amount). `correctTransaction` moves the transaction alone, so the gifts kept the
 *      original split. Net zero across the pair, wrong on each row.
 *   3. ONE IS AN OLD ROUNDING SLIP. buy25:29 (Eden, Lagos Restaurant) is 11 cents apart.
 *
 * PLUS TWO ORPHANED GIFTS. `genesisCleanup` merged the Zoom order's three per-item rows
 * into one ($486.46, the charge that actually cleared) and deleted two of them — but
 * left their gifts standing. `genesis:buy25:26` ($11.96) and `genesis:buy25:27`
 * ($119.74) now mirror transactions that no longer exist. They are removed here, and
 * the surviving `genesis:buy25:25` takes the whole order. Net +$28.19, which is the AA
 * battery pack the original per-item rows dropped.
 *
 * NOT TOUCHED, and each for a reason:
 *   - The 18 `gear2024:*` rows have no individual gift by design; they collectively
 *     mirror the single `genesis:gear2024`. They balance: $4,446.91 of expense =
 *     $3,746.91 owner + $700 Layomi.
 *   - Cash/wire gifts (`don24:*`, `truist:*`, `wire:*`, `ltn:*`) have no expense leg
 *     because money came IN. Correct as they are.
 *   - The 16 `genesis-cleanup:*` rows ($843.03 of newly-found owner-paid purchases)
 *     have no gift at all. Whether they should is a real decision about the owner's
 *     recognised giving, not a drift to repair — it goes to him separately.
 *
 * Every gift edit goes through `editGiftRow` / `removeGiftRow`, never a raw patch, so
 * donor lifetime and the scope rollups follow. Dry-run by default; idempotent.
 */
import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { editGiftRow, removeGiftRow } from "./lib/givingDonors";

const PREFIX = "genesis-inkind-exp:";

/**
 * Gifts realigned to their transaction's amount. `expected` is asserted against the
 * LIVE transaction before anything moves — if a row has changed again since this was
 * written, it is reported rather than written from stale facts.
 */
const REALIGN: { slug: string; expectedTxnCents: number; why: string }[] = [
  { slug: "buy25:3",  expectedTxnCents: 5440,   why: "SanDisk ×2 + card reader order — cleanup corrected the expense, not the gift" },
  { slug: "buy25:22", expectedTxnCents: 6465,   why: "Red chairs actual order total — cleanup corrected the expense, not the gift" },
  { slug: "buy25:25", expectedTxnCents: 48646,  why: "Zoom order collapsed to the charge that cleared; gift still held one line item" },
  { slug: "buy25:2",  expectedTxnCents: 5878,   why: "Lexar SD + stools order — cleanup corrected the expense, not the gift" },
  { slug: "buy25:4",  expectedTxnCents: 21557,  why: "SM58 line corrected in-app to 2 units; gift kept the single-unit figure" },
  { slug: "buy25:5",  expectedTxnCents: 105930, why: "Drum-set line corrected in-app; gift kept the pre-correction figure" },
  { slug: "buy25:29", expectedTxnCents: 40511,  why: "Eden, Lagos Restaurant — 11-cent rounding slip from the original import" },
];

/** Gifts whose transaction was merged away by the Zoom collapse. */
const ORPHANS: { ref: string; cents: number; why: string }[] = [
  { ref: "genesis:buy25:26", cents: 1196,  why: "128GB micro SDXC — merged into the buy25:25 order row" },
  { ref: "genesis:buy25:27", cents: 11974, why: "Zoom EXH-6e capsule — merged into the buy25:25 order row" },
];

export const runGenesisGiftSync = internalMutation({
  args: { editedBy: v.id("users"), execute: v.optional(v.boolean()) },
  returns: v.object({
    dryRun: v.boolean(),
    realigned: v.number(),
    orphansRemoved: v.number(),
    alreadyAligned: v.number(),
    givingDeltaCents: v.number(),
    skipped: v.array(v.string()),
  }),
  handler: async (ctx, { editedBy, execute }) => {
    const write = execute ?? false;
    const skipped: string[] = [];
    let realigned = 0, orphansRemoved = 0, alreadyAligned = 0, givingDeltaCents = 0;

    // Transactions are scanned once across both books; a genesis row could in
    // principle sit on either.
    const chapters = await ctx.db.query("chapters").collect();
    const txns = [];
    for (const c of chapters) {
      txns.push(
        ...(await ctx.db
          .query("transactions")
          .withIndex("by_chapter_and_postedAt", (q) => q.eq("chapterId", c._id))
          .take(6000)),
      );
    }
    const byExternalId = new Map(txns.filter((t) => t.externalId).map((t) => [t.externalId!, t]));

    for (const row of REALIGN) {
      const txn = byExternalId.get(PREFIX + row.slug);
      const gift = await ctx.db
        .query("gifts")
        .withIndex("by_externalRef", (q) => q.eq("externalRef", "genesis:" + row.slug))
        .first();
      if (!txn) { skipped.push(`${row.slug}: transaction not found`); continue; }
      if (!gift) { skipped.push(`${row.slug}: gift not found`); continue; }
      // The dataset is a plan; the ledger is the authority.
      if (txn.amountCents !== row.expectedTxnCents) {
        skipped.push(
          `${row.slug}: transaction is ${txn.amountCents}, expected ${row.expectedTxnCents} — moved since this was written`,
        );
        continue;
      }
      if (gift.amountCents === txn.amountCents) { alreadyAligned++; continue; }
      givingDeltaCents += txn.amountCents - gift.amountCents;
      if (write) {
        await editGiftRow(ctx, {
          giftId: gift._id,
          amountCents: txn.amountCents,
          note:
            `${gift.note ?? ""} Realigned 2026-08-07 to the expense it mirrors: ${row.why}.`.trim(),
          editedBy,
        });
      }
      realigned++;
    }

    for (const o of ORPHANS) {
      const gift = await ctx.db
        .query("gifts")
        .withIndex("by_externalRef", (q) => q.eq("externalRef", o.ref))
        .first();
      if (!gift) { alreadyAligned++; continue; }
      if (gift.amountCents !== o.cents) {
        skipped.push(`${o.ref}: gift is ${gift.amountCents}, expected ${o.cents}`);
        continue;
      }
      // Refuse to delete a gift whose transaction is somehow still there.
      const slug = o.ref.slice("genesis:".length);
      if (byExternalId.has(PREFIX + slug)) {
        skipped.push(`${o.ref}: its transaction still exists — not an orphan`);
        continue;
      }
      givingDeltaCents -= gift.amountCents;
      if (write) await removeGiftRow(ctx, gift._id);
      orphansRemoved++;
    }

    return { dryRun: !write, realigned, orphansRemoved, alreadyAligned, givingDeltaCents, skipped };
  },
});
