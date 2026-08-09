/**
 * One-time: put back the three markings the Stripe FC sweep silently un-did.
 *
 * ── WHAT WENT WRONG ─────────────────────────────────────────────────────────
 * `applyFcTransactions` re-derived `flow` from the sign of the feed's amount and
 * patched it onto the existing row on every sweep — and `flow` is exactly the
 * field `finances.markAsTransfer` writes. The sweep keeps no cursor (it re-reads
 * the newest 50x100 rows on the 07:00 cron and on every refresh webhook), so a
 * transfer marking on a `stripe_fc` row survived at most until the next morning.
 * Three of three marked `stripe_fc` legs had reverted; three of three
 * `increase_ach` legs had not. `financeAuditLog` holds no un-mark for any of
 * them, because nothing human un-marked them. The cause is fixed in the same PR
 * as this module; this clears what already landed.
 *
 * ── THE SIGNATURE IS THE SEARCH ─────────────────────────────────────────────
 * `preMarkFlow != null && flow !== "transfer"` is unreachable by any legitimate
 * path: `markAsTransfer` writes the two together and `unmarkTransfer` clears
 * them together. So the residue finds itself, and this module does not have to
 * trust a hand-copied list of ids. It still asserts the ids, amounts and current
 * flows it expects — a row carrying the signature that ISN'T one of the three
 * known ones means the sweep damaged something this module was never told
 * about, and that is reported as a problem rather than guessed at.
 *
 * ── THE $1,000 PAIR: RESTORE THE MARKING ────────────────────────────────────
 * `w179bmq4…` ("PUBLIC WORSHIP | Transfer", `stripe_fc`) reverted to `outflow`
 * while its counterpart `w17443p52…` (`increase_ach`) stayed `transfer`. Only
 * `flow` was clobbered — the sweep never touched `preMarkFlow` or
 * `transferGroupId` — so the marking is one field away from whole, and the pair
 * is genuinely what the bookkeeper said it was: money moving between the org's
 * own accounts. Restoring `flow: "transfer"` also takes $1,000 back out of org
 * spend and out of the unbudgeted-spend tile, which is the number the owner is
 * actually looking at.
 *
 * ── THE AMAZON PAIR: A REFUND, NOT A TRANSFER ───────────────────────────────
 * `w17d2tw6…` ("Purchase from AMAZON", $26.12 out) and `w1796k11…` ("Return from
 * AMAZON", $26.12 in) were marked as an internal TRANSFER, and both legs
 * reverted. Rather than restore that marking, this re-pairs them with
 * `markAsRefund`'s linkage, because a transfer is money moving between the org's
 * OWN accounts and AMAZON is a third party. The marking was the closest tool to
 * hand, not the right one.
 *
 * This is not a guess about intent. Both `transfer_mark` entries in
 * `financeAuditLog` carry the note the bookkeeper typed at the time, and the
 * note is the single word "Refund". He was already saying what these rows were;
 * the transfer marking was just the only pairing control on the screen.
 *
 * The refund linkage is also what actually fixes the number. `isSpend` is
 * outflow-only, so no amount of coding the credit could ever reduce a category —
 * a refunded charge went on consuming its budget forever. `refundedByTransactionId`
 * is what makes the charge stop counting, and it leaves both rows reading as the
 * real bank directions they are. Which means the flows the sweep left behind are
 * already CORRECT here: this clears the stale `preMarkFlow`/`transferGroupId`
 * and adds the refund link, and rewrites no `flow` at all.
 *
 * ── WHY NOT CALL markAsTransfer / markAsRefund ──────────────────────────────
 * Neither can be made to apply.
 *  - `markAsTransfer` throws ALREADY_TRANSFER on the $1,000 pair (the surviving
 *    leg is `flow: "transfer"`), and it would mint a NEW `transferGroupId`,
 *    splitting a pair that is still correctly linked.
 *  - `markAsRefund` throws IS_TRANSFER on the Amazon pair while
 *    `transferGroupId` is set, so it could only run after the clearing this
 *    module does anyway.
 *  - Both are public `mutation`s that resolve their actor through
 *    `requireReconcileTxn`, and a CLI-invoked internal mutation has no session.
 * So the writes are made directly, in the same shape those mutations would have
 * written them, and the audit entries are inserted directly too (same reason
 * `genesisApproveExceptions` does: `logFinanceAudit` derives its actor from
 * `requireUserId`). The caller passes the person/user acting, so the trail names
 * a human rather than a script. Dropping the trail was not an option — a
 * reclassification with no record of who did it is what this table exists to
 * prevent.
 *
 * ── SAFE BECAUSE NOTHING MOVES ──────────────────────────────────────────────
 * Every write here is a reclassification of rows that already exist. No cash
 * moves, no row is inserted or deleted, and book value is unchanged in both
 * cases: `signedBookCents` reads `preMarkFlow` on a marked transfer, and a
 * refund's charge and credit already netted to zero. What changes is only which
 * rows demand a budget and which ones count as spend.
 *
 * Idempotent: a leg already in its target state is counted as `alreadyFixed` and
 * not rewritten. Dry run by default — pass `execute: true` to write.
 *
 * Delete this module once run.
 */
import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { CENTRAL } from "@events-os/shared";
import type { Doc, Id } from "./_generated/dataModel";

const SCAN_LIMIT = 20000;

/**
 * The four production rows, by document id — read back out of the
 * `transfer_mark` entries the original markings left in `financeAuditLog`, so
 * they are the ids of the rows a human actually marked and not a transcription.
 * Matched with `startsWith`, which on a whole id is exact; every one is
 * additionally asserted against amount, flow and `preMarkFlow` before anything
 * is written.
 *
 * Overridable ONLY so the pairing and refusal logic can be exercised against a
 * seeded database at all — a test cannot choose the ids Convex assigns it.
 * Nothing in the app passes this.
 */
const PROD_ID_PREFIXES = {
  /** The reverted leg of the $1,000 internal movement. */
  transferLeg: "w179bmq4nv8bk5vdhrdckjb9vh8b4dcv",
  /** Its partner, which never came through this feed and stayed marked. */
  transferPartner: "w17443p52kk7gv7h7ythfzmqex8bec6e",
  /** "Purchase from AMAZON", $26.12 out. */
  charge: "w17d2tw6f72ntbwxyjj16jx4fh8btynr",
  /** "Return from AMAZON", $26.12 in. */
  credit: "w1796k11dn0v4ed7217ch122g98bvtc5",
};

const idPrefixValidator = v.object({
  transferLeg: v.string(),
  transferPartner: v.string(),
  charge: v.string(),
  credit: v.string(),
});

const TRANSFER_LEG = {
  amountCents: 100_000,
  /** What the sweep left it as — i.e. what we expect to be repairing FROM. */
  currentFlow: "outflow" as const,
  preMarkFlow: "outflow" as const,
  partnerPreMarkFlow: "inflow" as const,
};

/** Both legs of the AMAZON purchase + return, which reverted together. */
const REFUND_PAIR = {
  amountCents: 2_612,
  chargeFlow: "outflow" as const,
  creditFlow: "inflow" as const,
};

const TRANSFER_REASON =
  "Restored 2026-08-09. Marked as an internal transfer on 2026-08-08 and silently reverted to " +
  "outflow by the Stripe FC sweep, which re-derived flow from the amount sign on every run. No " +
  "human un-marked it — financeAuditLog holds no such entry. Cause fixed in the same PR.";

const REFUND_REASON =
  "Re-paired as a refund 2026-08-09. Marked as an internal transfer on 2026-08-07 and silently " +
  "reverted by the Stripe FC sweep. A purchase and its return from AMAZON is a refund, not a " +
  "movement between our own accounts — refundedByTransactionId is what stops the charge " +
  "counting as spend. Cause fixed in the same PR.";

export const repairSyncClearedTransferMarks = internalMutation({
  args: {
    /** Who is making the correction — named in `financeAuditLog`. */
    actorPersonId: v.id("people"),
    actorUserId: v.id("users"),
    execute: v.optional(v.boolean()),
    /** Test seam — see `PROD_ID_PREFIXES`. Leave unset in production. */
    idPrefixes: v.optional(idPrefixValidator),
  },
  returns: v.object({
    dryRun: v.boolean(),
    transferRestored: v.number(),
    refundPaired: v.number(),
    alreadyFixed: v.number(),
    problems: v.array(v.string()),
  }),
  handler: async (ctx, { actorPersonId, actorUserId, execute, idPrefixes }) => {
    const write = execute ?? false;
    const ids = idPrefixes ?? PROD_ID_PREFIXES;
    const problems: string[] = [];

    // Every finance scope: each chapter, plus the "central" sentinel that is a
    // scope but not a `chapters` row.
    const scopes: (Id<"chapters"> | typeof CENTRAL)[] = [
      ...(await ctx.db.query("chapters").collect()).map((c) => c._id),
      CENTRAL,
    ];
    const stranded: Doc<"transactions">[] = [];
    for (const scope of scopes) {
      const rows = await ctx.db
        .query("transactions")
        .withIndex("by_chapter", (q) => q.eq("chapterId", scope))
        .take(SCAN_LIMIT);
      // The signature: marked by a human, no longer reading as a transfer.
      stranded.push(...rows.filter((r) => r.preMarkFlow != null && r.flow !== "transfer"));
    }

    const find = (prefix: string): Doc<"transactions"> | null =>
      stranded.find((r) => r._id.startsWith(prefix)) ?? null;

    // Anything carrying the signature that we weren't told about is damage this
    // module has no instructions for. Report it; never guess.
    const known = [
      ids.transferLeg,
      ids.charge,
      ids.credit,
    ];
    for (const row of stranded) {
      if (!known.some((p) => row._id.startsWith(p))) {
        problems.push(
          `unexpected stranded leg ${row._id} (${row.merchantName ?? "?"}, ${row.amountCents}¢, ` +
            `flow ${row.flow}, preMarkFlow ${row.preMarkFlow}) — not one of the three known rows, LEFT ALONE`,
        );
      }
    }

    let transferRestored = 0;
    let refundPaired = 0;
    let alreadyFixed = 0;

    // ── The $1,000 pair ──────────────────────────────────────────────────────
    const leg = find(ids.transferLeg);
    if (!leg) {
      // Not stranded — already restored (or not in this deployment). Either way
      // there is nothing to do, and re-running must stay a no-op.
      alreadyFixed++;
    } else if (
      leg.amountCents !== TRANSFER_LEG.amountCents ||
      leg.flow !== TRANSFER_LEG.currentFlow ||
      leg.preMarkFlow !== TRANSFER_LEG.preMarkFlow
    ) {
      problems.push(
        `${leg._id}: expected ${TRANSFER_LEG.amountCents}¢ flow ${TRANSFER_LEG.currentFlow} ` +
          `preMarkFlow ${TRANSFER_LEG.preMarkFlow}, found ${leg.amountCents}¢ flow ${leg.flow} ` +
          `preMarkFlow ${leg.preMarkFlow} — SKIPPED`,
      );
    } else if (leg.transferGroupId == null) {
      problems.push(`${leg._id}: no transferGroupId — the pair linkage is gone, SKIPPED`);
    } else {
      const groupId = leg.transferGroupId;
      // The partner has to still be there, still marked, still the other
      // direction and the same money. Restoring a leg into a group that no
      // longer matches would recreate a lone `flow:"transfer"` row, which is the
      // exact unexplained-money state the pairing requirement exists to stop.
      const group = await ctx.db
        .query("transactions")
        .withIndex("by_transfer_group", (q) => q.eq("transferGroupId", groupId))
        .collect();
      const partner = group.find((g) => g._id !== leg._id) ?? null;
      if (group.length !== 2 || !partner) {
        problems.push(
          `${leg._id}: group ${groupId} has ${group.length} legs, expected 2 — SKIPPED`,
        );
      } else if (!partner._id.startsWith(ids.transferPartner)) {
        problems.push(
          `${leg._id}: partner is ${partner._id}, expected ${ids.transferPartner}… — SKIPPED`,
        );
      } else if (partner.flow !== "transfer") {
        problems.push(
          `${leg._id}: partner ${partner._id} reads ${partner.flow}, not transfer — both legs ` +
            `reverted, so this is not the pair described, SKIPPED`,
        );
      } else if (
        partner.amountCents !== TRANSFER_LEG.amountCents ||
        partner.preMarkFlow !== TRANSFER_LEG.partnerPreMarkFlow
      ) {
        problems.push(
          `${leg._id}: partner ${partner._id} is ${partner.amountCents}¢ preMarkFlow ` +
            `${partner.preMarkFlow}, expected ${TRANSFER_LEG.amountCents}¢ ${TRANSFER_LEG.partnerPreMarkFlow} — SKIPPED`,
        );
      } else if (write) {
        // `flow` is the only field the sweep clobbered; `preMarkFlow`,
        // `transferGroupId` and `transferDirection` all survived, so this is the
        // whole repair.
        await ctx.db.patch(leg._id, { flow: "transfer" });
        await ctx.db.insert("financeAuditLog", {
          chapterId: leg.chapterId,
          actorUserId,
          actorPersonId,
          subjectType: "transaction",
          subjectId: leg._id,
          action: "transfer_mark",
          field: "flow",
          before: leg.flow,
          after: "transfer",
          reason: TRANSFER_REASON,
          amountCents: leg.amountCents,
          createdAt: Date.now(),
        });
        transferRestored++;
      } else {
        transferRestored++;
      }
    }

    // ── The AMAZON pair ──────────────────────────────────────────────────────
    const charge = find(ids.charge);
    const credit = find(ids.credit);
    if (!charge && !credit) {
      alreadyFixed += 2;
    } else if (!charge || !credit) {
      problems.push(
        `AMAZON pair: found only ${charge ? charge._id : credit!._id} stranded — the two legs are ` +
          `in different states, SKIPPED`,
      );
    } else {
      // Everything `markAsRefund` would have refused on, checked by hand
      // because the mutation itself can't be reached from here.
      const bad: string[] = [];
      if (charge.chapterId !== credit.chapterId) bad.push("different books");
      if (charge.amountCents !== REFUND_PAIR.amountCents)
        bad.push(`charge is ${charge.amountCents}¢, expected ${REFUND_PAIR.amountCents}¢`);
      if (credit.amountCents !== REFUND_PAIR.amountCents)
        bad.push(`credit is ${credit.amountCents}¢, expected ${REFUND_PAIR.amountCents}¢`);
      if (charge.flow !== REFUND_PAIR.chargeFlow)
        bad.push(`charge reads ${charge.flow}, expected ${REFUND_PAIR.chargeFlow}`);
      if (credit.flow !== REFUND_PAIR.creditFlow)
        bad.push(`credit reads ${credit.flow}, expected ${REFUND_PAIR.creditFlow}`);
      if ((charge.currency ?? "usd") !== (credit.currency ?? "usd"))
        bad.push("different currencies");
      if (charge.transferGroupId == null || charge.transferGroupId !== credit.transferGroupId)
        bad.push("the two legs are not in one transfer group");
      for (const [name, row] of [
        ["charge", charge],
        ["credit", credit],
      ] as const) {
        if (row.refundsTransactionId != null || row.refundedByTransactionId != null)
          bad.push(`${name} is already part of a refund`);
        if (row.payoutProcessor != null) bad.push(`${name} is marked as a processor payout`);
      }
      if (bad.length > 0) {
        problems.push(`AMAZON pair (${charge._id} / ${credit._id}): ${bad.join("; ")} — SKIPPED`);
      } else if (write) {
        // Clear the transfer marking. No `flow` rewrite: the sweep already left
        // both legs at the directions a refund needs, and `preMarkFlow` says
        // those are the directions they were ingested with.
        await ctx.db.patch(charge._id, {
          preMarkFlow: undefined,
          transferGroupId: undefined,
          transferDirection: undefined,
          refundedByTransactionId: credit._id,
        });
        await ctx.db.patch(credit._id, {
          preMarkFlow: undefined,
          transferGroupId: undefined,
          transferDirection: undefined,
          refundsTransactionId: charge._id,
          // Legibility only, exactly as `markAsRefund` does it — an inflow is
          // never spend, so this moves no total.
          ...(charge.categoryId ? { categoryId: charge.categoryId } : {}),
          ...(charge.budgetId ? { budgetId: charge.budgetId } : {}),
        });
        for (const row of [charge, credit]) {
          // Two entries per leg, because two things happened to it: the transfer
          // marking came off, and a refund marking went on.
          await ctx.db.insert("financeAuditLog", {
            chapterId: row.chapterId,
            actorUserId,
            actorPersonId,
            subjectType: "transaction",
            subjectId: row._id,
            action: "transfer_mark",
            field: "flow",
            before: "transfer",
            after: row.flow,
            reason: REFUND_REASON,
            amountCents: row.amountCents,
            createdAt: Date.now(),
          });
          await ctx.db.insert("financeAuditLog", {
            chapterId: row.chapterId,
            actorUserId,
            actorPersonId,
            subjectType: "transaction",
            subjectId: row._id,
            action: "refund_mark",
            field: "refund",
            before: "none",
            after: "refunded",
            reason: REFUND_REASON,
            amountCents: row.amountCents,
            createdAt: Date.now(),
          });
        }
        refundPaired += 2;
      } else {
        refundPaired += 2;
      }
    }

    return { dryRun: !write, transferRestored, refundPaired, alreadyFixed, problems };
  },
});
