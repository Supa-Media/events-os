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
 * (`chaseOutstandingFor`, the same predicate the chase itself used): its row
 * is stamped `settledAt` and kept `DONE_KEEP_MS` so the Book can say
 * "Done, reminders stopped" (founder, 2026-11-14: "how do I know that you've
 * stopped chasing someone"), then deleted.
 *
 * TELLING THE CHASER. Founder, 2026-11-05: "notify me of anyone who hasn't
 * coded their charges with five days of daily reminders and I'll send them a
 * message personally". After a charge's `ESCALATE_AFTER_REMINDERS`th
 * follow-up, whoever chased it gets one email naming the person and the
 * charges. A new chase resets the count.
 *
 * NOT DOUBLE-MESSAGING. Someone a manager chased by hand earlier the same
 * Eastern calendar day is skipped that day: the chase was today's message.
 * It used to be "the last 20 hours", which skipped a person chased the
 * previous AFTERNOON too, so an afternoon chase meant a whole day with no
 * message (founder, 2026-11-08: "how do I know that you chased them
 * yesterday" — Friday 4:30pm chases got nothing Saturday). The
 * automated day-1/day-3 digest (`cards.sendReceiptReminders`) is about NEW
 * charges crossing a checkpoint; a charge someone was chased about is
 * normally past both, so the two rarely meet.
 */
import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  CHASE_REASONS,
  FINANCE_TIMEZONE,
  dayKeyInTz,
  type ChaseReason,
} from "@events-os/shared";
import { chaseOutstandingFor } from "./finances";
import { codingPolicy } from "./lib/transactionCoding";
import {
  isDocumented,
  isUncodedCharge,
  reminderChargeValidator,
  type ReminderCharge,
} from "./lib/codingReminders";
import { notifyCodingChase, sendCodingChaseSms } from "./cards";
import { requireChapterId, requireUserId } from "./lib/context";
import { requireCodingRequest } from "./lib/chaseAccess";
import type { FinanceScope } from "./lib/finance";
import { sendEmail, emailShell } from "./ticketingEmails";
import {
  emailButtonRow,
  emailHeading,
  emailList,
  emailParagraph,
} from "./lib/emailShell";
import { escapeHtml } from "./lib/html";
import { appUrl } from "./lib/siteUrl";

/** A hand chase on the same Eastern calendar day as the run stands in for
 *  that day's follow-up. */
export function chasedSameDay(chasedAt: number, now: number): boolean {
  return dayKeyInTz(chasedAt, FINANCE_TIMEZONE) === dayKeyInTz(now, FINANCE_TIMEZONE);
}
/** Rows read per daily run — far above any real chase backlog. */
const FOLLOW_UP_SCAN_LIMIT = 2000;
/** How long a finished chase stays visible as "Done" in the Book. */
export const DONE_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
/** Follow-ups after which the chaser is told the person still hasn't coded. */
export const ESCALATE_AFTER_REMINDERS = 5;

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
    const chasedByUserId = (await requireUserId(ctx)) as Id<"users">;
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
        chasedByUserId,
        // A new chase starts the count again (replace drops the old one).
        reminderCount: 0,
      };
      if (existing) await ctx.db.replace(existing._id, fields);
      else await ctx.db.insert("codingChaseFollowUps", fields);
    }
    return null;
  },
});

/**
 * STOP A PERSON'S DAILY REMINDERS by hand (founder, 2026-11-19: "I need a
 * button to stop chase", e.g. after filling someone's coding in for them).
 * Marks every open follow-up row for the person settled now, with who
 * stopped it, so the Book shows "Reminders stopped" and the sweep never
 * sends again. Chasing the person again starts fresh rows (`record` replaces).
 *
 * Gate: the chase's own power on each charge's book (`requireCodingRequest`):
 * whoever may start the reminders may stop them.
 */
export const stop = mutation({
  args: { personId: v.id("people") },
  returns: v.object({ stopped: v.number() }),
  handler: async (ctx, { personId }) => {
    const homeChapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    const userId = (await requireUserId(ctx)) as Id<"users">;
    const rows = await ctx.db
      .query("codingChaseFollowUps")
      .withIndex("by_person", (q) => q.eq("personId", personId))
      .take(FOLLOW_UP_SCAN_LIMIT);
    const now = Date.now();
    let stopped = 0;
    for (const row of rows) {
      if (row.settledAt != null) continue;
      const tr = await ctx.db.get(row.transactionId);
      if (tr) await requireCodingRequest(ctx, homeChapterId, tr.chapterId as FinanceScope);
      await ctx.db.patch(row._id, { settledAt: now, stoppedByUserId: userId });
      stopped++;
    }
    return { stopped };
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
  /** Per row: follow-ups so far, whether the chaser was already told, and the
   *  chaser's email, for the five-reminder escalation. */
  rows: v.array(
    v.object({
      id: v.id("codingChaseFollowUps"),
      reminderCount: v.number(),
      escalated: v.boolean(),
      chaserEmail: v.union(v.string(), v.null()),
      charge: reminderChargeValidator,
    }),
  ),
});

type FollowUpTarget = typeof followUpTargetValidator.type;

/** Who gets a follow-up today, and which rows are settled and can go. */
export const gather = internalQuery({
  args: {},
  returns: v.object({
    targets: v.array(followUpTargetValidator),
    settledIds: v.array(v.id("codingChaseFollowUps")),
    purgeIds: v.array(v.id("codingChaseFollowUps")),
  }),
  handler: async (ctx) => {
    const now = Date.now();
    const { sinceMs } = await codingPolicy(ctx);
    const rows = await ctx.db
      .query("codingChaseFollowUps")
      .withIndex("by_chasedAt")
      .take(FOLLOW_UP_SCAN_LIMIT);

    const settledIds: Id<"codingChaseFollowUps">[] = [];
    const purgeIds: Id<"codingChaseFollowUps">[] = [];
    type Target = typeof followUpTargetValidator.type & { latestChase: number };
    const byPerson = new Map<string, Target>();

    for (const row of rows) {
      // Already done: kept only so the Book can say so, then purged.
      if (row.settledAt != null) {
        if (now - row.settledAt >= DONE_KEEP_MS) purgeIds.push(row._id);
        continue;
      }
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
          rows: [],
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
      const chaser = row.chasedByUserId ? await ctx.db.get(row.chasedByUserId) : null;
      target.rows.push({
        id: row._id,
        reminderCount: row.reminderCount ?? 0,
        escalated: row.escalatedAt != null,
        chaserEmail: chaser?.email ?? null,
        charge,
      });
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
      // Chased by hand today: that chase was today's message.
      .filter((t) => !chasedSameDay(t.latestChase, now))
      .map(({ latestChase: _latest, ...t }) => ({
        ...t,
        charges: [...t.charges].sort((a, b) => b.amountCents - a.amountCents),
      }));
    return { targets, settledIds, purgeIds };
  },
});

/** Mark newly settled rows, purge old ones, stamp the ones just reminded. */
export const finish = internalMutation({
  args: {
    settledIds: v.array(v.id("codingChaseFollowUps")),
    purgeIds: v.optional(v.array(v.id("codingChaseFollowUps"))),
    remindedIds: v.array(v.id("codingChaseFollowUps")),
    escalatedIds: v.array(v.id("codingChaseFollowUps")),
  },
  returns: v.null(),
  handler: async (ctx, { settledIds, purgeIds, remindedIds, escalatedIds }) => {
    const now = Date.now();
    for (const id of settledIds) {
      if (await ctx.db.get(id)) await ctx.db.patch(id, { settledAt: now });
    }
    for (const id of purgeIds ?? []) {
      if (await ctx.db.get(id)) await ctx.db.delete(id);
    }
    for (const id of remindedIds) {
      const row = await ctx.db.get(id);
      if (row) {
        await ctx.db.patch(id, {
          lastRemindedAt: now,
          reminderCount: (row.reminderCount ?? 0) + 1,
        });
      }
    }
    for (const id of escalatedIds) {
      if (await ctx.db.get(id)) await ctx.db.patch(id, { escalatedAt: now });
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
      purgeIds: Id<"codingChaseFollowUps">[];
    } = await ctx.runQuery(internal.chaseFollowUps.gather, {});
    const { targets, settledIds, purgeIds } = gathered;
    const remindedIds: Id<"codingChaseFollowUps">[] = [];
    const escalatedIds: Id<"codingChaseFollowUps">[] = [];
    // chaser email -> person -> what they still owe
    const dueByChaser = new Map<
      string,
      Map<string, { name: string; charges: ReminderCharge[] }>
    >();
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

      // FIVE REMINDERS AND STILL OPEN: tell whoever chased, once per chase.
      for (const r of t.rows) {
        if (r.escalated || r.reminderCount + 1 < ESCALATE_AFTER_REMINDERS) continue;
        if (!r.chaserEmail) continue;
        const people = dueByChaser.get(r.chaserEmail) ?? new Map();
        const entry = people.get(t.personId) ?? { name: t.cardholderName, charges: [] };
        entry.charges.push(r.charge);
        people.set(t.personId, entry);
        dueByChaser.set(r.chaserEmail, people);
        escalatedIds.push(r.id);
      }
    }

    for (const [chaserEmail, people] of dueByChaser) {
      try {
        await notifyChaser(ctx, chaserEmail, [...people.values()]);
      } catch (err) {
        console.error("[chaseFollowUps] chaser email failed", chaserEmail, err);
      }
    }

    await ctx.runMutation(internal.chaseFollowUps.finish, {
      settledIds,
      purgeIds,
      remindedIds,
      escalatedIds,
    });
    return { reminded, settled: settledIds.length };
  },
});

/** The email to the person who chased: who still hasn't coded after
 *  `ESCALATE_AFTER_REMINDERS` daily reminders, so they can reach out. */
async function notifyChaser(
  ctx: Parameters<typeof notifyCodingChase>[0],
  to: string,
  people: { name: string; charges: ReminderCharge[] }[],
): Promise<void> {
  const fmt = (c: ReminderCharge) =>
    `$${(c.amountCents / 100).toFixed(2)}${c.merchantName ? ` at ${c.merchantName}` : ""}`;
  const one = people.length === 1;
  const subject = one
    ? `${people[0].name} still hasn't coded after ${ESCALATE_AFTER_REMINDERS} reminders`
    : `${people.length} people still haven't coded after ${ESCALATE_AFTER_REMINDERS} reminders`;
  const items = people.map(
    (p) =>
      `<strong>${escapeHtml(p.name)}</strong>: ${p.charges
        .map((c) => `${escapeHtml(fmt(c))} (${escapeHtml(c.outstanding)})`)
        .join(", ")}`,
  );
  const link = appUrl("/finances/reconcile?filters=needs_chasing&group=person");
  await sendEmail(ctx, {
    to,
    subject,
    html: emailShell(`
      ${emailHeading("Time for a personal message")}
      ${emailParagraph(
        `You chased ${one ? "this person" : "these people"}, and after ${ESCALATE_AFTER_REMINDERS} daily reminders these charges are still open:`,
        { margin: "0 0 8px" },
      )}
      ${emailList(items)}
      ${emailParagraph("The daily reminders keep going until each charge is coded. You won't hear about this chase again.")}
      ${link ? emailButtonRow(link, "Open the Book →") : ""}`),
  });
}
