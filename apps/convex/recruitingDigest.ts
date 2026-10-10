/**
 * RECRUITING DIGEST — the leads inbox's weekly count of who raised a hand.
 *
 * Every application already emails the leads inbox the moment it lands
 * (`hiring.sendNewApplicationNotice`); volunteer signups don't, because a
 * hand-raise to carry speakers is not a same-day decision. This is the
 * rhythm both get on top of that: once a week, how many people signed up to
 * volunteer at `/serve` and how many applied to join the team at `/team`.
 *
 * Silent weeks stay silent. A digest that arrives with two zeroes trains the
 * inbox to skip it, and then the week it says something nobody reads it.
 */
import { v } from "convex/values";
import { internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { LEADS_INBOX, VOLUNTEER_AREAS } from "@events-os/shared";
import { escapeHtml } from "./lib/html";
import { appUrl } from "./lib/siteUrl";
import {
  emailButtonRow,
  emailHeading,
  emailParagraph,
} from "./lib/emailShell";
import { emailShell, sendEmail } from "./ticketingEmails";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** Bound on one week's rows per table. Launch-phase volume is tens a season;
 *  hitting this would mean a week far past anything the desk has seen, and the
 *  digest says "at least" rather than pretending to an exact count. */
const WEEK_SCAN_LIMIT = 500;

const countValidator = v.object({ label: v.string(), count: v.number() });

/** The past week's new signups and applications, grouped for the email. A
 *  re-submission updates its row in place, so each row is one person. */
export const weekSummary = internalQuery({
  args: { since: v.number() },
  returns: v.object({
    volunteers: v.number(),
    applications: v.number(),
    capped: v.boolean(),
    byRole: v.array(countValidator),
    byArea: v.array(countValidator),
  }),
  handler: async (ctx, { since }) => {
    const signups = await ctx.db
      .query("volunteerSignups")
      .withIndex("by_createdAt", (q) => q.gte("createdAt", since))
      .take(WEEK_SCAN_LIMIT);
    const applications = await ctx.db
      .query("jobApplications")
      .withIndex("by_createdAt", (q) => q.gte("createdAt", since))
      .take(WEEK_SCAN_LIMIT);

    const roles = new Map<string, number>();
    for (const a of applications) {
      roles.set(a.roleTitle, (roles.get(a.roleTitle) ?? 0) + 1);
    }
    const areaLabel = new Map<string, string>(
      VOLUNTEER_AREAS.map((a) => [a.id, a.label]),
    );
    const areas = new Map<string, number>();
    for (const s of signups) {
      for (const id of s.areas) {
        const label = areaLabel.get(id) ?? id;
        areas.set(label, (areas.get(label) ?? 0) + 1);
      }
    }
    const sorted = (m: Map<string, number>) =>
      [...m.entries()]
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

    return {
      volunteers: signups.length,
      applications: applications.length,
      capped:
        signups.length === WEEK_SCAN_LIMIT ||
        applications.length === WEEK_SCAN_LIMIT,
      byRole: sorted(roles),
      byArea: sorted(areas),
    };
  },
});

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function breakdown(rows: { label: string; count: number }[]): string {
  return rows
    .map((r) => `${escapeHtml(r.label)} (${r.count})`)
    .join(" · ");
}

/** Cron target (Mondays). Sends nothing when the week had nothing in it. */
export const sendWeeklyRecruitingDigest = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const summary = await ctx.runQuery(internal.recruitingDigest.weekSummary, {
      since: Date.now() - WEEK_MS,
    });
    if (summary.volunteers === 0 && summary.applications === 0) return null;

    const atLeast = summary.capped ? "at least " : "";
    const volunteerLine = `<b>${atLeast}${plural(summary.volunteers, "person", "people")}</b> signed up to volunteer${
      summary.byArea.length ? ` — ${breakdown(summary.byArea)}` : ""
    }.`;
    const applicationLine = `<b>${atLeast}${plural(summary.applications, "person", "people")}</b> applied to join the team${
      summary.byRole.length ? ` — ${breakdown(summary.byRole)}` : ""
    }.`;
    const volunteersLink = appUrl("/people/volunteers");
    const pipelineLink = appUrl("/people/pipeline");

    const html = emailShell(`
      ${emailHeading("This week's recruiting")}
      ${emailParagraph("In the last seven days:")}
      ${emailParagraph(volunteerLine)}
      ${emailParagraph(applicationLine)}
      ${volunteersLink && summary.volunteers > 0 ? emailButtonRow(volunteersLink, "Open volunteer signups →") : ""}
      ${pipelineLink && summary.applications > 0 ? emailButtonRow(pipelineLink, "Open applications →") : ""}
    `);

    await sendEmail(ctx, {
      to: LEADS_INBOX,
      subject: `This week: ${plural(summary.volunteers, "volunteer signup", "volunteer signups")}, ${plural(summary.applications, "team application", "team applications")}`,
      html,
    });
    return null;
  },
});
