/**
 * DAILY PAY-BACK REMINDERS FOR PERSONAL CHARGES.
 *
 * Founder, 2026-11-06: "when someone's charge is marked as personal, could you
 * also send daily reminders until they pay the money back".
 *
 * Once a day (`sendDaily`, crons.ts) everyone who still owes a personal charge
 * gets ONE email (and a text, when there's a phone and Twilio) listing every
 * charge they owe and the total, with a button to pay it back. It stops the
 * day nothing billable is left: a repayment that is `paid` (or has its credit
 * posted) is done, and one that is `processing` (a bank debit clearing) is
 * money already on its way, so it never earns another reminder. Un-flagging a
 * charge deletes its repayment row, which ends its reminders too.
 *
 * NOT DOUBLE-MESSAGING. The flag itself already sent an email
 * (`cards.notifyPersonalChargeFlagged`), and a manager may have pressed "Send
 * reminders" (`cards.nudgeOutstandingRepayments`). Either inside
 * `RECENT_MESSAGE_MS` stands in for today's reminder, so the first daily one
 * lands the day after the flag. Each reminder stamps `lastNudgedAt`, so the
 * desk's "reminded <date>" stays true.
 *
 * WHERE THE BUTTON GOES. The person's pay-back link (`/pay/<token>`) when a
 * manager has minted one: it works without signing in, which matters for
 * someone who has left the team. Otherwise the in-app repayments page. Never
 * "reply to this email": nobody reads replies to these.
 */
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { formatCents } from "@events-os/shared";
import { sendEmail, emailShell } from "./ticketingEmails";
import {
  emailButtonRow,
  emailHeading,
  emailPanel,
  emailParagraph,
} from "./lib/emailShell";
import { escapeHtml } from "./lib/html";
import { appUrl } from "./lib/siteUrl";
import { normalizePhone, resolveTwilioCredentials, sendSms } from "./lib/twilio";
import { repaymentLinkPath } from "./repaymentLinks";

/** A flag email or manual reminder this recent was today's message. */
export const RECENT_MESSAGE_MS = 20 * 60 * 60 * 1000;
/** Rows read per status per run — far above any real backlog. */
const SCAN_LIMIT = 2000;

/** Still owed AND payable now. Mirrors `cards.ts#isBillableRepayment`: a
 *  clearing bank debit is outstanding but must never be asked for again. */
function owesNow(r: Doc<"personalRepayments">): boolean {
  return (r.status === "pending" || r.status === "failed") && !r.creditTransactionId;
}

const reminderChargeValidator = v.object({
  merchantName: v.union(v.string(), v.null()),
  amountCents: v.number(),
  postedAt: v.union(v.number(), v.null()),
});

const targetValidator = v.object({
  payerPersonId: v.id("people"),
  name: v.string(),
  email: v.union(v.string(), v.null()),
  phone: v.union(v.string(), v.null()),
  totalCents: v.number(),
  repaymentIds: v.array(v.id("personalRepayments")),
  charges: v.array(reminderChargeValidator),
  /** The person's live `/pay/<token>` link, if a manager minted one. */
  payToken: v.union(v.string(), v.null()),
});
type Target = typeof targetValidator.type;

/** Everyone who owes something today and hasn't heard from us in the last
 *  `RECENT_MESSAGE_MS`. Biggest debt first. */
export const gather = internalQuery({
  args: {},
  returns: v.array(targetValidator),
  handler: async (ctx) => {
    const now = Date.now();
    const byPerson = new Map<Id<"people">, Doc<"personalRepayments">[]>();
    for (const status of ["pending", "failed"] as const) {
      const rows = await ctx.db
        .query("personalRepayments")
        .withIndex("by_status", (q) => q.eq("status", status))
        .take(SCAN_LIMIT);
      for (const row of rows) {
        if (!owesNow(row)) continue;
        const list = byPerson.get(row.payerPersonId) ?? [];
        list.push(row);
        byPerson.set(row.payerPersonId, list);
      }
    }

    const targets: Target[] = [];
    for (const [personId, list] of byPerson) {
      // One recent message about ANY of their charges covers today: the flag
      // email for a charge flagged this morning, or a manager's reminder.
      const lastMessage = Math.max(
        ...list.map((r) => Math.max(r.createdAt, r.lastNudgedAt ?? 0)),
      );
      if (now - lastMessage < RECENT_MESSAGE_MS) continue;

      const person = await ctx.db.get(personId);
      if (!person) continue;
      const charges: Target["charges"] = [];
      for (const r of list) {
        const txn = await ctx.db.get(r.transactionId);
        charges.push({
          merchantName: txn?.merchantName ?? null,
          amountCents: r.amountCents,
          postedAt: txn?.postedAt ?? null,
        });
      }
      charges.sort((a, b) => (b.postedAt ?? 0) - (a.postedAt ?? 0));
      const links = await ctx.db
        .query("repaymentLinks")
        .withIndex("by_person", (q) => q.eq("payerPersonId", personId))
        .collect();
      const live = links.find((l) => l.revokedAt == null);
      targets.push({
        payerPersonId: personId,
        name: person.name,
        email: person.pwEmail ?? person.email ?? null,
        phone: person.phone ?? null,
        totalCents: list.reduce((sum, r) => sum + r.amountCents, 0),
        repaymentIds: list.map((r) => r._id),
        charges,
        payToken: live?.token ?? null,
      });
    }
    targets.sort((a, b) => b.totalCents - a.totalCents);
    return targets;
  },
});

/** Stamp `lastNudgedAt` on what one reminder covered, only after it sent, so a
 *  failed send leaves the person due again tomorrow. */
export const markReminded = internalMutation({
  args: { repaymentIds: v.array(v.id("personalRepayments")) },
  returns: v.null(),
  handler: async (ctx, { repaymentIds }) => {
    const now = Date.now();
    for (const id of repaymentIds) {
      if (await ctx.db.get(id)) {
        await ctx.db.patch(id, { lastNudgedAt: now, updatedAt: now });
      }
    }
    return null;
  },
});

/** The daily cron: one pay-back reminder per person who still owes. */
export const sendDaily = internalAction({
  args: {},
  returns: v.object({ reminded: v.number(), failed: v.number() }),
  // Explicit types: this action reads `internal.repaymentReminders`, whose type
  // includes this action, so inference would be circular.
  handler: async (ctx): Promise<{ reminded: number; failed: number }> => {
    const targets: Target[] = await ctx.runQuery(internal.repaymentReminders.gather, {});
    let reminded = 0;
    let failed = 0;
    for (const t of targets) {
      const link = appUrl(t.payToken ? repaymentLinkPath(t.payToken) : "/finances/repayments");
      if (!link) {
        // Same rule as `nudgeOutstandingRepayments`: never send "you owe $X"
        // with nowhere to pay it.
        console.error("[repaymentReminders] APP_URL is unset — not sending");
        return { reminded, failed };
      }
      let sent = false;
      if (t.email) {
        try {
          await sendReminderEmail(ctx, t, link);
          sent = true;
        } catch (err) {
          console.error("[repaymentReminders] email failed", t.payerPersonId, err);
        }
      }
      if (t.phone && (await sendReminderSms(ctx, t, link))) sent = true;
      if (sent) {
        await ctx.runMutation(internal.repaymentReminders.markReminded, {
          repaymentIds: t.repaymentIds,
        });
        reminded++;
      } else if (t.email || t.phone) {
        failed++;
      }
    }
    return { reminded, failed };
  },
});

function chargeLine(c: Target["charges"][number]): string {
  const when = c.postedAt
    ? new Date(c.postedAt).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        timeZone: "America/New_York",
      })
    : null;
  return `<div>${escapeHtml(c.merchantName ?? "Card charge")}${
    when ? ` · ${escapeHtml(when)}` : ""
  } — <strong>${escapeHtml(formatCents(c.amountCents))}</strong></div>`;
}

async function sendReminderEmail(ctx: ActionCtx, t: Target, link: string): Promise<void> {
  const dollars = formatCents(t.totalCents);
  const one = t.charges.length === 1;
  await sendEmail(ctx, {
    to: t.email!,
    subject: `Daily reminder: you owe Public Worship ${dollars}`,
    html: emailShell(`
      ${emailHeading(`You still owe Public Worship ${escapeHtml(dollars)}`)}
      ${emailParagraph(
        `Hi ${escapeHtml(t.name)}, ${
          one ? "a charge on your card was" : `${t.charges.length} charges on your card were`
        } marked personal, so ${one ? "it's" : "they're"} yours to pay back. Pay by card or bank transfer; it takes a minute.`,
      )}
      ${emailPanel(t.charges.map(chargeLine).join(""))}
      ${emailButtonRow(link, "Pay it back →")}
      ${emailParagraph(
        "You'll get this reminder once a day until it's paid. Already paid by bank transfer? It stops on its own once the payment starts clearing. If a charge isn't actually personal, ask your Treasurer to un-flag it.",
        { size: 12, margin: "16px 0 0" },
      )}`),
  });
}

/** True when a text actually went. */
async function sendReminderSms(ctx: ActionCtx, t: Target, link: string): Promise<boolean> {
  const creds = await resolveTwilioCredentials(ctx);
  if (!creds) return false;
  const to = normalizePhone(t.phone!);
  if (!to) return false;
  const body = `Daily reminder from Public Worship: you still owe ${formatCents(
    t.totalCents,
  )} for ${t.charges.length === 1 ? "a personal charge" : `${t.charges.length} personal charges`} on your card. Pay it back here: ${link}`;
  try {
    await sendSms(creds, { to, body });
    return true;
  } catch (err) {
    console.log(`[repaymentReminders] SMS failed: ${String(err)}`);
    return false;
  }
}
