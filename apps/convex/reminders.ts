/**
 * Due-date reminders — the weekly digest and daily nudges (see crons.ts).
 *
 * One collection pass gathers every OPEN piece of dated work per person —
 * projects with deadlines (by effective owner) and event items with due dates
 * (by item owner) — then two windows cut it:
 *   weekly digest  — Sunday afternoon: everything due in the coming week,
 *                    plus anything already overdue, plus (for managers) a
 *                    rollup of their direct reports' overdue work
 *   daily reminder — each morning: items due today or tomorrow (the "24 hours
 *                    before" nudge)
 * Recipients are roster people with an email; someone with nothing in the
 * window simply gets no email. Delivery is best-effort Resend, same pattern
 * as the ticketing emails. Also home to the project-comment notification
 * that `projects.addComment` schedules.
 *
 * Project entries render as full management cards — status, purpose, blocker,
 * latest thread update — and carry `/p/<token>` action links (30-day expiring
 * capabilities, see projectActions.ts) so the owner can mark the project in
 * progress / blocked / done, or jump into the app, straight from the email.
 *
 * Day boundaries use America/New_York — "due Tuesday" means Tuesday for the
 * team, not Tuesday UTC.
 */
import {
  internalQuery,
  internalAction,
  ActionCtx,
  QueryCtx,
} from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import {
  isCompleteStatus,
  PROJECT_STATUS_LABELS,
  type ProjectStatus,
  type SelectOption,
} from "@events-os/shared";
import { sendEmail, emailShell } from "./ticketingEmails";
import { statusColumnFor } from "./lib/readiness";
import { siteUrl } from "./lib/siteUrl";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Don't resurface work overdue longer than this — it's stale, not urgent. */
const OVERDUE_LOOKBACK_MS = 60 * DAY_MS;
/** The digest looks this many days ahead (Sunday → the coming week). */
const DIGEST_HORIZON_DAYS = 7;

const OPEN_PROJECT_STATUSES = new Set(["not_started", "in_progress", "blocked"]);

export type WorkEntry = {
  kind: "project" | "task";
  name: string;
  /** Where it lives: the event name for tasks, the parent project for subs. */
  context: string | null;
  dueDate: number;
  /** Projects only — the management detail the email card renders, and the
   * id the action-token is minted against. */
  projectId?: Id<"projects">;
  status?: ProjectStatus;
  purpose?: string | null;
  blocker?: string | null;
  lastComment?: { body: string; authorName: string | null } | null;
};

export type RecipientWork = {
  personId: Id<"people">;
  name: string;
  email: string;
  entries: WorkEntry[];
  /** Direct reports' dated work — the digest surfaces what's overdue. */
  directs: Array<{ name: string; entries: WorkEntry[] }>;
};

/** Calendar day in the team's timezone, as sortable "YYYY-MM-DD". */
export function dayKey(ts: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
  }).format(new Date(ts));
}

function formatDue(ts: number): string {
  return new Date(ts).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "America/New_York",
  });
}

/** The digest's cut: already overdue vs due in the coming week. */
export function partitionForDigest(
  entries: WorkEntry[],
  now: number,
): { overdue: WorkEntry[]; dueThisWeek: WorkEntry[] } {
  const today = dayKey(now);
  const horizon = dayKey(now + DIGEST_HORIZON_DAYS * DAY_MS);
  const sorted = [...entries].sort((a, b) => a.dueDate - b.dueDate);
  return {
    overdue: sorted.filter((e) => dayKey(e.dueDate) < today),
    dueThisWeek: sorted.filter((e) => {
      const key = dayKey(e.dueDate);
      return key >= today && key <= horizon;
    }),
  };
}

/** The daily nudge's cut: due today vs due tomorrow. */
export function partitionForDueSoon(
  entries: WorkEntry[],
  now: number,
): { dueToday: WorkEntry[]; dueTomorrow: WorkEntry[] } {
  const today = dayKey(now);
  const tomorrow = dayKey(now + DAY_MS);
  const sorted = [...entries].sort((a, b) => a.dueDate - b.dueDate);
  return {
    dueToday: sorted.filter((e) => dayKey(e.dueDate) === today),
    dueTomorrow: sorted.filter((e) => dayKey(e.dueDate) === tomorrow),
  };
}

/**
 * Everyone's open dated work, chapter by chapter. Bounded to due dates inside
 * [now - lookback, now + digest horizon + 1d] so ancient stragglers and
 * far-future plans never enter either email.
 */
async function collectOpenWork(
  ctx: QueryCtx,
  now: number,
): Promise<RecipientWork[]> {
  const chapters = await ctx.db.query("chapters").collect();
  const recipients: RecipientWork[] = [];

  for (const chapter of chapters) {
    const people = await ctx.db
      .query("people")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapter._id))
      .collect();
    const byOwner = new Map<Id<"people">, WorkEntry[]>();
    const add = (owner: Id<"people">, entry: WorkEntry) => {
      if (entry.dueDate < now - OVERDUE_LOOKBACK_MS) return;
      if (entry.dueDate > now + (DIGEST_HORIZON_DAYS + 1) * DAY_MS) return;
      const list = byOwner.get(owner) ?? [];
      list.push(entry);
      byOwner.set(owner, list);
    };

    // Projects — deadline'd open work, charged to the effective owner (an
    // unowned sub-project inherits its nearest owned ancestor, same rule as
    // the Team views).
    const projects = await ctx.db
      .query("projects")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapter._id))
      .collect();
    const projectById = new Map(projects.map((p) => [p._id, p]));
    const effectiveOwner = (p: Doc<"projects">): Id<"people"> | undefined => {
      let cur: Doc<"projects"> | undefined = p;
      for (let hops = 0; cur && hops < 100; hops++) {
        if (cur.ownerPersonId) return cur.ownerPersonId;
        cur = cur.parentProjectId
          ? projectById.get(cur.parentProjectId)
          : undefined;
      }
      return undefined;
    };
    for (const p of projects) {
      if (!p.deadline || !OPEN_PROJECT_STATUSES.has(p.status)) continue;
      const owner = effectiveOwner(p);
      if (!owner) continue;
      const parent = p.parentProjectId
        ? projectById.get(p.parentProjectId)
        : undefined;
      // Full management detail: the email card should tell the owner (and
      // their manager) everything without opening the app. The thread's
      // latest entry only for projects inside the window (the add() bounds
      // reject the rest before this read matters — check first).
      const dueDate = p.deadline;
      if (dueDate < now - OVERDUE_LOOKBACK_MS) continue;
      if (dueDate > now + (DIGEST_HORIZON_DAYS + 1) * DAY_MS) continue;
      const last = await ctx.db
        .query("projectComments")
        .withIndex("by_project", (q) => q.eq("projectId", p._id))
        .order("desc")
        .first();
      const lastAuthor = last ? await ctx.db.get(last.authorPersonId) : null;
      add(owner, {
        kind: "project",
        name: p.name,
        context: parent?.name ?? null,
        dueDate,
        projectId: p._id,
        status: p.status,
        purpose: p.purpose ?? null,
        blocker: p.blocker ?? null,
        lastComment: last
          ? { body: last.body, authorName: lastAuthor?.name ?? null }
          : null,
      });
    }

    // Event items — due-dated grid rows with a person on them, from events
    // still in flight. "Open" defers to the module's own status vocabulary
    // (its status column's isComplete options); a module with no status
    // column can't be completed, so its dated items stay open until the date.
    const events = await ctx.db
      .query("events")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapter._id))
      .collect();
    const eventById = new Map(
      events
        .filter((e) => e.status !== "completed" && e.status !== "cancelled")
        .map((e) => [e._id, e]),
    );
    const items = await ctx.db
      .query("eventItems")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapter._id))
      .collect();
    const statusOptionsCache = new Map<string, SelectOption[] | undefined>();
    for (const item of items) {
      if (!item.dueDate || !item.ownerPersonId) continue;
      const event = eventById.get(item.eventId);
      if (!event) continue;
      const cacheKey = `${item.eventId}:${item.module}`;
      if (!statusOptionsCache.has(cacheKey)) {
        const col = await statusColumnFor(ctx, item.eventId, item.module);
        statusOptionsCache.set(
          cacheKey,
          col?.options as SelectOption[] | undefined,
        );
      }
      if (isCompleteStatus(statusOptionsCache.get(cacheKey), item.status)) {
        continue;
      }
      add(item.ownerPersonId, {
        kind: "task",
        name: item.title,
        context: event.name,
        dueDate: item.dueDate,
      });
    }

    for (const person of people) {
      if (person.isPlaceholder || person.status === "inactive") continue;
      const email = person.pwEmail ?? person.email;
      if (!email) continue;
      const entries = byOwner.get(person._id) ?? [];
      // Managers also carry their direct reports' dated work, so the digest
      // can flag what's slipping on their team (directs only — each layer of
      // the chain watches its own layer).
      const directs = people
        .filter(
          (d) =>
            d.managerId === person._id &&
            !d.isPlaceholder &&
            d.status !== "inactive" &&
            (byOwner.get(d._id)?.length ?? 0) > 0,
        )
        .map((d) => ({ name: d.name, entries: byOwner.get(d._id)! }));
      if (entries.length === 0 && directs.length === 0) continue;
      recipients.push({
        personId: person._id,
        name: person.name,
        email,
        entries,
        directs,
      });
    }
  }
  return recipients;
}

/** All open dated work per emailable person — the input to both crons. */
export const openWorkByRecipient = internalQuery({
  args: { now: v.number() },
  handler: async (ctx, { now }) => {
    return await collectOpenWork(ctx, now);
  },
});

// ── Email rendering ──────────────────────────────────────────────────────────

const MUTED = "#7A5A5A";
const ACCENT = "#D23B3A";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const SANS = "-apple-system,'Segoe UI',Roboto,sans-serif";

/**
 * One work entry as an email card. Tasks stay compact; projects get the full
 * management picture — status, purpose, blocker, latest thread update — plus
 * the tokenized action row (mark in progress / blocked / done, open in the
 * browser) when a token was minted for them.
 */
function entryCard(
  e: WorkEntry,
  showDue: boolean,
  tokenByProject: Record<string, string>,
  base: string,
): string {
  const metaLine = `
    <div style="font-family:${SANS};font-size:12px;color:${MUTED};padding-top:2px">
      ${e.kind === "task" ? "Event task" : "Project"}${e.status ? ` · ${esc(PROJECT_STATUS_LABELS[e.status])}` : ""}${e.context ? ` · ${esc(e.context)}` : ""}${showDue ? ` · due ${formatDue(e.dueDate)}` : ""}
    </div>`;
  const token = e.projectId ? tokenByProject[e.projectId] : undefined;
  const link = token ? `${base}/p/${token}` : null;
  const detail =
    e.kind === "project"
      ? `
      ${e.purpose ? `<div style="font-family:${SANS};font-size:13px;color:${MUTED};padding-top:6px">${esc(e.purpose)}</div>` : ""}
      ${e.blocker ? `<div style="font-family:${SANS};font-size:13px;color:${ACCENT};padding-top:6px"><strong>Blocked:</strong> ${esc(e.blocker)}</div>` : ""}
      ${e.lastComment ? `<div style="font-family:${SANS};font-size:13px;color:${MUTED};border-left:3px solid #EFE0DC;padding:2px 0 2px 10px;margin-top:8px">"${esc(e.lastComment.body)}"${e.lastComment.authorName ? ` — ${esc(e.lastComment.authorName)}` : ""}</div>` : ""}
      ${
        link
          ? `<div style="font-family:${SANS};font-size:12px;font-weight:600;padding-top:10px">
        <a href="${link}?intent=in_progress" style="color:${MUTED};text-decoration:none;border:1px solid #E4CFCB;border-radius:999px;padding:5px 10px;display:inline-block;margin:0 4px 4px 0">Mark in progress</a>
        <a href="${link}?intent=blocked" style="color:${MUTED};text-decoration:none;border:1px solid #E4CFCB;border-radius:999px;padding:5px 10px;display:inline-block;margin:0 4px 4px 0">Mark blocked</a>
        <a href="${link}?intent=done" style="color:#fff;background:${ACCENT};text-decoration:none;border:1px solid ${ACCENT};border-radius:999px;padding:5px 10px;display:inline-block;margin:0 4px 4px 0">Mark done</a>
        <a href="${link}" style="color:${ACCENT};text-decoration:none;padding:5px 2px;display:inline-block">Open →</a>
      </div>`
          : ""
      }`
      : "";
  return `
      <div style="background:#fff;border:1px solid #EFE0DC;border-radius:12px;padding:12px 16px;margin:0 0 8px">
        <div style="font-family:${SANS};font-size:14px;font-weight:600">${esc(e.name)}</div>
        ${metaLine}
        ${detail}
      </div>`;
}

function entryRows(
  entries: WorkEntry[],
  showDue: boolean,
  tokenByProject: Record<string, string>,
  base: string,
): string {
  return entries
    .map((e) => entryCard(e, showDue, tokenByProject, base))
    .join("");
}

/** The manager rollup: each direct's overdue work, compact and read-only. */
function directsOverdueRows(
  directs: Array<{ name: string; overdue: WorkEntry[] }>,
): string {
  return directs
    .map(
      (d) => `
      <div style="background:#fff;border:1px solid #EFE0DC;border-radius:12px;padding:12px 16px;margin:0 0 8px">
        <div style="font-family:${SANS};font-size:13px;font-weight:700">${esc(d.name)}</div>
        ${d.overdue
          .map(
            (e) => `<div style="font-family:${SANS};font-size:13px;color:${MUTED};padding-top:4px">${esc(e.name)}${e.context ? ` <span style="color:#A98C8C">· ${esc(e.context)}</span>` : ""} · was due ${formatDue(e.dueDate)}</div>`,
          )
          .join("")}
      </div>`,
    )
    .join("");
}

/** Mint `/p/` action tokens for the project entries an email will show. */
async function tokensFor(
  ctx: ActionCtx,
  personId: Id<"people">,
  entryLists: WorkEntry[][],
): Promise<Record<string, string>> {
  const projectIds = [
    ...new Set(
      entryLists.flat().flatMap((e) => (e.projectId ? [e.projectId] : [])),
    ),
  ];
  if (projectIds.length === 0) return {};
  return await ctx.runMutation(internal.projectActions.mintProjectTokens, {
    personId,
    projectIds,
  });
}

function sectionHeading(text: string, color = MUTED): string {
  return `<div style="font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:${color};padding:14px 0 8px">${text}</div>`;
}

/** Sunday-afternoon digest: the coming week's work, one email per person. */
export const sendWeeklyDigests = internalAction({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const base = siteUrl();
    const recipients: RecipientWork[] = await ctx.runQuery(
      internal.reminders.openWorkByRecipient,
      { now },
    );
    for (const r of recipients) {
      const { overdue, dueThisWeek } = partitionForDigest(r.entries, now);
      const directsOverdue = r.directs
        .map((d) => ({
          name: d.name,
          overdue: partitionForDigest(d.entries, now).overdue,
        }))
        .filter((d) => d.overdue.length > 0);
      if (
        overdue.length === 0 &&
        dueThisWeek.length === 0 &&
        directsOverdue.length === 0
      ) {
        continue;
      }
      const tokens = await tokensFor(ctx, r.personId, [overdue, dueThisWeek]);
      const firstName = r.name.split(/\s+/)[0];
      const teamCount = directsOverdue.reduce(
        (n, d) => n + d.overdue.length,
        0,
      );
      const subject =
        dueThisWeek.length > 0
          ? `Your week ahead — ${dueThisWeek.length} due${overdue.length ? `, ${overdue.length} overdue` : ""}`
          : overdue.length > 0
            ? `${overdue.length} overdue item${overdue.length === 1 ? "" : "s"} need${overdue.length === 1 ? "s" : ""} a look`
            : `Your team has ${teamCount} overdue item${teamCount === 1 ? "" : "s"}`;
      await sendEmail(
        r.email,
        subject,
        emailShell(`
        <h1 style="margin:0 0 8px;font-size:24px;line-height:1.2">Your week ahead, ${esc(firstName)}</h1>
        <p style="margin:0;font-family:${SANS};font-size:14px;line-height:1.6;color:${MUTED}">Everything with your name on it that's due this week — so Sunday-you can set up Monday-you. Project buttons below update status right from this email.</p>
        ${overdue.length ? sectionHeading("Overdue", ACCENT) + entryRows(overdue, true, tokens, base) : ""}
        ${dueThisWeek.length ? sectionHeading("Due this week") + entryRows(dueThisWeek, true, tokens, base) : ""}
        ${directsOverdue.length ? sectionHeading("Your team — overdue", ACCENT) + directsOverdueRows(directsOverdue) + `<p style="margin:4px 0 0;font-family:${SANS};font-size:12px;line-height:1.5;color:${MUTED}">Worth a nudge in your next 1:1 — or a comment on the project.</p>` : ""}`),
      );
    }
    return null;
  },
});

/** Morning nudge: anything due today or tomorrow, one email per person. */
export const sendDueReminders = internalAction({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const base = siteUrl();
    const recipients: RecipientWork[] = await ctx.runQuery(
      internal.reminders.openWorkByRecipient,
      { now },
    );
    for (const r of recipients) {
      const { dueToday, dueTomorrow } = partitionForDueSoon(r.entries, now);
      if (dueToday.length === 0 && dueTomorrow.length === 0) continue;
      const tokens = await tokensFor(ctx, r.personId, [dueToday, dueTomorrow]);
      const count = dueToday.length + dueTomorrow.length;
      const subject = dueToday.length
        ? `Due today: ${dueToday[0].name}${count > 1 ? ` (+${count - 1} more)` : ""}`
        : `Due tomorrow: ${dueTomorrow[0].name}${count > 1 ? ` (+${count - 1} more)` : ""}`;
      await sendEmail(
        r.email,
        subject,
        emailShell(`
        <h1 style="margin:0 0 8px;font-size:24px;line-height:1.2">Coming up ${dueToday.length ? "today" : "tomorrow"}</h1>
        ${dueToday.length ? sectionHeading("Due today", ACCENT) + entryRows(dueToday, false, tokens, base) : ""}
        ${dueTomorrow.length ? sectionHeading("Due tomorrow") + entryRows(dueTomorrow, false, tokens, base) : ""}`),
      );
    }
    return null;
  },
});

// ── Project comment notifications ────────────────────────────────────────────

/**
 * "Someone commented on your project" — scheduled by `projects.addComment`
 * for the project's effective owner (never for one's own comment). Keeps the
 * update-culture loop alive: a nudge posted in the thread actually reaches
 * the person it's for.
 */
export const sendProjectCommentEmail = internalAction({
  args: {
    to: v.string(),
    recipientName: v.string(),
    projectName: v.string(),
    authorName: v.string(),
    body: v.string(),
  },
  handler: async (_ctx, { to, recipientName, projectName, authorName, body }) => {
    const firstName = recipientName.split(/\s+/)[0];
    await sendEmail(
      to,
      `${authorName} commented on ${projectName}`,
      emailShell(`
      <h1 style="margin:0 0 8px;font-size:22px;line-height:1.3">New comment on ${esc(projectName)}</h1>
      <p style="margin:0 0 16px;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-size:14px;line-height:1.6;color:${MUTED}">Hey ${esc(firstName)} — ${esc(authorName)} left an update on your project:</p>
      <div style="background:#fff;border-left:3px solid ${ACCENT};border-radius:0 12px 12px 0;padding:12px 16px;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-size:14px;line-height:1.6">${esc(body)}</div>
      <p style="margin:16px 0 0;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-size:12px;line-height:1.6;color:${MUTED}">Reply on the project's thread in Events OS so the progression stays in one place.</p>`),
    );
    return null;
  },
});
