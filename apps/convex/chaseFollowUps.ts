/**
 * DAILY FOLLOW-UPS AFTER A CHASE.
 *
 * Founder, 2026-11-05: "when a person still doesn't code a charge after we
 * chase them, can we automatically remind them everyday until they code the
 * charge".
 *
 * `cards.sendCodingChase` records every charge it mailed someone about
 * (`record`). Once a day (`sendDaily`, crons.ts) each cardholder with chased
 * charges that still owe something gets ONE follow-up: the same chase email
 * and text, marked as a daily reminder, repeating the manager's reasons and
 * note. A charge drops out the moment it stops owing anything
 * (`chaseOutstandingFor`, the same predicate the chase itself used), and its
 * row is deleted.
 *
 * NOT DOUBLE-MESSAGING. Someone a manager chased by hand in the last
 * `RECENT_CHASE_MS` is skipped that day: the chase was today's message. The
 * automated day-1/day-3 digest (`cards.sendReceiptReminders`) is about NEW
 * charges crossing a checkpoint; a charge someone was chased about is
 * normally past both, so the two rarely meet.
 */
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { CHASE_REASONS, type ChaseReason } from "@events-os/shared";
import { chaseOutstandingFor } from "./finances";
import { codingPolicy } from "./lib/transactionCoding";
import {
  isDocumented,
  isUncodedCharge,
  reminderChargeValidator,
  type ReminderCharge,
} from "./lib/codingReminders";
import { notifyCodingChase, sendCodingChaseSms } from "./cards";

/** A hand chase this recent stands in for today's follow-up. */
const RECENT_CHASE_MS = 20 * 60 * 60 * 1000;
/** Rows read per daily run — far above any real chase backlog. */
const FOLLOW_UP_SCAN_LIMIT = 2000;

const isChaseReason = (r: string): r is ChaseReason =>
  (CHASE_REASONS as readonly string[]).includes(r);

/** Upsert one follow-up row per chased transaction. Called by
 *  `cards.sendCodingChase` after it chases a person. */
export const record = internalMutation({
  args: {
    personId: v.id("people"),
    transactionIds: v.array(v.id("transactions")),
    reasons: v.array(v.string()),
    note: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    for (const transactionId of args.transactionIds) {
      const existing = await ctx.db
        .query("codingChaseFollowUps")
        .withIndex("by_transaction", (q) => q.eq("transactionId", transactionId))
        .first();
      const fields = {
        transactionId,
        personId: args.personId,
        chasedAt: now,
        reasons: args.reasons,
        note: args.note,
      };
      if (existing) await ctx.db.replace(existing._id, fields);
      else await ctx.db.insert("codingChaseFollowUps", fields);
    }
    return null;
  },
});

const followUpTargetValidator = v.object({
  personId: v.id("people"),
  email: v.union(v.string(), v.null()),
  phone: v.union(v.string(), v.null()),
  cardholderName: v.string(),
  charges: v.array(reminderChargeValidator),
  reasons: v.array(v.string()),
  note: v.union(v.string(), v.null()),
  rowIds: v.array(v.id("codingChaseFollowUps")),
});

type FollowUpTarget = typeof followUpTargetValidator.type;

/** Who gets a follow-up today, and which rows are settled and can go. */
export const gather = internalQuery({
  args: {},
  returns: v.object({
    targets: v.array(followUpTargetValidator),
    settledIds: v.array(v.id("codingChaseFollowUps")),
  }),
  handler: async (ctx) => {
    const now = Date.now();
    const { sinceMs } = await codingPolicy(ctx);
    const rows = await ctx.db
      .query("codingChaseFollowUps")
      .withIndex("by_chasedAt")
      .take(FOLLOW_UP_SCAN_LIMIT);

    const settledIds: Id<"codingChaseFollowUps">[] = [];
    type Target = typeof followUpTargetValidator.type & { latestChase: number };
    const byPerson = new Map<string, Target>();

    for (const row of rows) {
      const tr = await ctx.db.get(row.transactionId);
      const outstanding = tr ? chaseOutstandingFor(tr, sinceMs) : null;
      if (!tr || !outstanding) {
        settledIds.push(row._id);
        continue;
      }
      let target = byPerson.get(row.personId);
      if (!target) {
        const person = await ctx.db.get(row.personId);
        if (!person) {
          settledIds.push(row._id);
          continue;
        }
        target = {
          personId: row.personId,
          email: person.pwEmail ?? person.email ?? null,
          phone: person.phone ?? null,
          cardholderName: person.name,
          charges: [],
          reasons: [],
          note: null,
          rowIds: [],
          latestChase: 0,
        };
        byPerson.set(row.personId, target);
      }
      target.rowIds.push(row._id);
      const charge: ReminderCharge = {
        amountCents: tr.amountCents,
        merchantName: tr.merchantName ?? null,
        escalated: tr.receiptReminderStage === "escalated",
        outstanding,
        missingReceipt: !isDocumented(tr),
        needsCoding: isUncodedCharge(tr, sinceMs),
      };
      target.charges.push(charge);
      for (const r of row.reasons ?? []) {
        if (!target.reasons.includes(r)) target.reasons.push(r);
      }
      // The newest chase's note wins: it's the latest thing the manager said.
      if (row.chasedAt >= target.latestChase) {
        target.latestChase = row.chasedAt;
        if (row.note) target.note = row.note;
      }
    }

    const targets = [...byPerson.values()]
      // Chased by hand recently: that chase was today's message.
      .filter((t) => now - t.latestChase >= RECENT_CHASE_MS)
      .map(({ latestChase: _latest, ...t }) => ({
        ...t,
        charges: [...t.charges].sort((a, b) => b.amountCents - a.amountCents),
      }));
    return { targets, settledIds };
  },
});

/** Delete settled rows and stamp the ones just reminded. */
export const finish = internalMutation({
  args: {
    settledIds: v.array(v.id("codingChaseFollowUps")),
    remindedIds: v.array(v.id("codingChaseFollowUps")),
  },
  returns: v.null(),
  handler: async (ctx, { settledIds, remindedIds }) => {
    for (const id of settledIds) {
      if (await ctx.db.get(id)) await ctx.db.delete(id);
    }
    const now = Date.now();
    for (const id of remindedIds) {
      if (await ctx.db.get(id)) await ctx.db.patch(id, { lastRemindedAt: now });
    }
    return null;
  },
});

/** The daily cron: one follow-up per cardholder still owing a chased charge. */
export const sendDaily = internalAction({
  args: {},
  returns: v.object({ reminded: v.number(), settled: v.number() }),
  // Explicit types: this action reads `internal.chaseFollowUps`, whose type
  // includes this action, so inference would be circular.
  handler: async (ctx): Promise<{ reminded: number; settled: number }> => {
    const gathered: {
      targets: FollowUpTarget[];
      settledIds: Id<"codingChaseFollowUps">[];
    } = await ctx.runQuery(internal.chaseFollowUps.gather, {});
    const { targets, settledIds } = gathered;
    const remindedIds: Id<"codingChaseFollowUps">[] = [];
    let reminded = 0;
    for (const t of targets) {
      if (!t.email) continue;
      const why = {
        reasons: t.reasons.filter(isChaseReason),
        note: t.note,
        followUp: true,
      };
      try {
        await notifyCodingChase(ctx, {
          email: t.email,
          cardholderName: t.cardholderName,
          charges: t.charges,
          why,
        });
      } catch (err) {
        console.error("[chaseFollowUps] email failed", t.email, err);
        continue;
      }
      if (t.phone) await sendCodingChaseSms(ctx, t.phone, t.charges, why);
      remindedIds.push(...t.rowIds);
      reminded++;
    }
    await ctx.runMutation(internal.chaseFollowUps.finish, {
      settledIds,
      remindedIds,
    });
    return { reminded, settled: settledIds.length };
  },
});
