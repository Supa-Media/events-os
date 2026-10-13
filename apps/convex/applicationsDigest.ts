/**
 * DAILY APPLICATIONS DIGEST — one morning email to everyone who can see the
 * hiring pipeline: how many people applied in the last day, for which roles,
 * who they are, and where the open files stand.
 *
 * Recipients come from the seat chart (`hiringDigestRecipients`, the
 * `hiring.view` power), so granting the power subscribes and removing it
 * unsubscribes. The per-application notice (`hiring.sendNewApplicationNotice`)
 * and the leads inbox's weekly count (`recruitingDigest`) are unchanged.
 *
 * Sent every day there is something to say: new applications, or open files
 * still waiting on someone. A day with neither sends nothing.
 */
import { v } from "convex/values";
import { internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { HIRING_STAGE_DEFS, OPEN_HIRING_STAGES } from "@events-os/shared";
import { hiringDigestRecipients } from "./lib/hiringAccess";
import { escapeHtml } from "./lib/html";
import { appUrl } from "./lib/siteUrl";
import {
  emailButtonRow,
  emailHeading,
  emailParagraph,
} from "./lib/emailShell";
import { emailShell, sendEmail } from "./ticketingEmails";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Bound on one day's new rows and on each open stage's rows. Far past
 *  launch-phase volume; past it the email says "at least". */
const SCAN_LIMIT = 500;
/** How many of the day's applicants are named in the email; the rest are
 *  counted, and the pipeline link has them all. */
const LISTED_LIMIT = 25;

const countValidator = v.object({ label: v.string(), count: v.number() });

export const dailySummary = internalQuery({
  args: { since: v.number() },
  returns: v.object({
    recipients: v.array(v.string()),
    newCount: v.number(),
    capped: v.boolean(),
    byRole: v.array(countValidator),
    applicants: v.array(
      v.object({
        name: v.string(),
        roleTitle: v.string(),
        location: v.union(v.string(), v.null()),
      }),
    ),
    openTotal: v.number(),
    openByStage: v.array(countValidator),
  }),
  handler: async (ctx, { since }) => {
    const fresh = await ctx.db
      .query("jobApplications")
      .withIndex("by_createdAt", (q) => q.gte("createdAt", since))
      .take(SCAN_LIMIT);

    const roles = new Map<string, number>();
    for (const a of fresh) {
      roles.set(a.roleTitle, (roles.get(a.roleTitle) ?? 0) + 1);
    }
    const byRole = [...roles.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

    let capped = fresh.length === SCAN_LIMIT;
    const openByStage: { label: string; count: number }[] = [];
    for (const stage of OPEN_HIRING_STAGES) {
      const rows = await ctx.db
        .query("jobApplications")
        .withIndex("by_stage", (q) => q.eq("stage", stage))
        .take(SCAN_LIMIT);
      if (rows.length === SCAN_LIMIT) capped = true;
      if (rows.length > 0) {
        openByStage.push({
          label: HIRING_STAGE_DEFS[stage].label,
          count: rows.length,
        });
      }
    }

    return {
      recipients: await hiringDigestRecipients(ctx),
      newCount: fresh.length,
      capped,
      byRole,
      applicants: [...fresh]
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(0, LISTED_LIMIT)
        .map((a) => ({
          name: a.name,
          roleTitle: a.roleTitle,
          location: a.location ?? null,
        })),
      openTotal: openByStage.reduce((n, s) => n + s.count, 0),
      openByStage,
    };
  },
});

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Cron target (daily). Best-effort per recipient. */
export const sendDailyApplicationsDigest = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const s = await ctx.runQuery(internal.applicationsDigest.dailySummary, {
      since: Date.now() - DAY_MS,
    });
    if (s.recipients.length === 0) return null;
    if (s.newCount === 0 && s.openTotal === 0) return null;

    const atLeast = s.capped ? "at least " : "";
    const headline =
      s.newCount === 0
        ? "No new applications in the last day."
        : `<b>${atLeast}${plural(s.newCount, "new application", "new applications")}</b> in the last day.`;
    const roles = s.byRole.length
      ? emailParagraph(
          `<b>By role:</b> ${s.byRole
            .map((r) => `${escapeHtml(r.label)} (${r.count})`)
            .join(" · ")}`,
        )
      : "";
    const unlisted = s.newCount - s.applicants.length;
    const people = s.applicants.length
      ? emailParagraph(
          s.applicants
            .map(
              (a) =>
                `${escapeHtml(a.name)} — ${escapeHtml(a.roleTitle)}${a.location ? `, ${escapeHtml(a.location)}` : ""}`,
            )
            .join("<br>") + (unlisted > 0 ? `<br>…and ${unlisted} more.` : ""),
        )
      : "";
    const pipeline =
      s.openTotal > 0
        ? emailParagraph(
            `<b>Open in the pipeline:</b> ${atLeast}${s.openTotal} — ${s.openByStage
              .map((st) => `${escapeHtml(st.label)} (${st.count})`)
              .join(" · ")}`,
          )
        : "";
    const link = appUrl("/people/pipeline");

    const html = emailShell(`
      ${emailHeading("Today's applications")}
      ${emailParagraph(headline)}
      ${roles}
      ${people}
      ${pipeline}
      ${link ? emailButtonRow(link, "View the applications →") : ""}
    `);
    const subject =
      s.newCount === 0
        ? `Applications: none new · ${s.openTotal} open`
        : `Applications: ${s.newCount} new · ${s.openTotal} open`;

    for (const to of s.recipients) {
      try {
        await sendEmail(ctx, { to, subject, html });
      } catch (err) {
        console.error("sendDailyApplicationsDigest: recipient failed", to, err);
      }
    }
    return null;
  },
});
