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
  DAY_MS,
  isCompleteStatus,
  isOperationalEvent,
  MODULE_LABELS,
  PROJECT_STATUS_LABELS,
  type ModuleKey,
  type ProjectStatus,
  type SelectOption,
} from "@events-os/shared";
import { sendEmail, emailShell } from "./ticketingEmails";
import { escapeHtml } from "./lib/html";
import { statusColumnFor } from "./lib/readiness";
import { appUrl, siteUrl } from "./lib/siteUrl";

/** Don't resurface work overdue longer than this — it's stale, not urgent. */
const OVERDUE_LOOKBACK_MS = 60 * DAY_MS;
/** The digest looks this many days ahead (Sunday → the coming week). */
const DIGEST_HORIZON_DAYS = 7;
/** One extra day past the horizon so a "due tomorrow" nudge on the horizon's
 * edge still has its item collected. */
const WINDOW_AHEAD_MS = (DIGEST_HORIZON_DAYS + 1) * DAY_MS;

const OPEN_PROJECT_STATUSES = new Set([
  "not_started",
  "in_progress",
  "blocked",
]);

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

// One formatter, reused — Intl.DateTimeFormat construction dwarfs .format(),
// and dayKey runs several times per entry per recipient.
const DAY_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
});

/** Calendar day in the team's timezone, as sortable "YYYY-MM-DD". */
export function dayKey(ts: number): string {
  return DAY_FMT.format(new Date(ts));
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
 * One chapter's open dated work per emailable person. Every table read is
 * scoped to the chapter (so a single query transaction never spans the whole
 * deployment) and bounded to due dates inside [now - lookback, now + horizon
 * + 1d], so ancient stragglers, far-future plans, and undated rows never
 * enter either email.
 */
export async function collectOpenWorkForChapter(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
  now: number,
  onlyPersonId?: Id<"people">,
): Promise<RecipientWork[]> {
  const windowStart = now - OVERDUE_LOOKBACK_MS;
  const windowEnd = now + WINDOW_AHEAD_MS;
  const recipients: RecipientWork[] = [];

  const people = await ctx.db
    .query("people")
    .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
    .collect();
  const personById = new Map(people.map((p) => [p._id, p]));
  // A person can actually receive an email: on the roster, active, addressable.
  const reachable = (id: Id<"people">): boolean => {
    const p = personById.get(id);
    return (
      !!p &&
      !p.isPlaceholder &&
      p.status !== "inactive" &&
      !!(p.pwEmail ?? p.email)
    );
  };
  const byOwner = new Map<Id<"people">, WorkEntry[]>();
  const add = (owner: Id<"people">, entry: WorkEntry) => {
    if (entry.dueDate < windowStart || entry.dueDate > windowEnd) return;
    // "Mine" scoping: when collecting one person's own open work, drop
    // everything charged to anyone else before it's ever grouped.
    if (onlyPersonId && owner !== onlyPersonId) return;
    const list = byOwner.get(owner) ?? [];
    list.push(entry);
    byOwner.set(owner, list);
  };

  // Events, read once for both branches below: the item branch needs the
  // in-flight operational events; the project branch needs to know which
  // events are Academy training sandboxes so projects wrapping one never
  // email anyone either.
  const events = await ctx.db
    .query("events")
    .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
    .collect();
  const trainingEventIds = new Set(
    events.filter((e) => !isOperationalEvent(e)).map((e) => e._id),
  );

  // Projects — deadline'd open work, charged to the effective owner (an
  // unowned sub-project inherits its nearest owned ancestor, same rule as
  // the Team views).
  const projects = await ctx.db
    .query("projects")
    .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
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
  const inWindowProjects = projects.filter(
    (p) =>
      p.deadline != null &&
      p.deadline >= windowStart &&
      p.deadline <= windowEnd &&
      OPEN_PROJECT_STATUSES.has(p.status) &&
      // A project wrapping an Academy training sandbox is training too.
      !(p.eventId && trainingEventIds.has(p.eventId)) &&
      effectiveOwner(p) !== undefined,
  );
  // Independent per-project thread reads, run together rather than serially.
  const lastComments = await Promise.all(
    inWindowProjects.map((p) =>
      ctx.db
        .query("projectComments")
        .withIndex("by_project", (q) => q.eq("projectId", p._id))
        .order("desc")
        .first(),
    ),
  );
  const lastAuthors = await Promise.all(
    lastComments.map((c) => (c ? ctx.db.get(c.authorPersonId) : null)),
  );
  inWindowProjects.forEach((p, i) => {
    const parent = p.parentProjectId
      ? projectById.get(p.parentProjectId)
      : undefined;
    const last = lastComments[i];
    add(effectiveOwner(p)!, {
      kind: "project",
      name: p.name,
      context: parent?.name ?? null,
      dueDate: p.deadline!,
      projectId: p._id,
      status: p.status,
      purpose: p.purpose ?? null,
      blocker: p.blocker ?? null,
      lastComment: last
        ? { body: last.body, authorName: lastAuthors[i]?.name ?? null }
        : null,
    });
  });

  // Event items — every due-dated grid row (planning doc, comms, permits,
  // supplies, custom modules — the same rows the readiness bars count),
  // from events still in flight. Read via the [chapterId, dueDate] index
  // range-scanned to the window, so undated and out-of-window rows are never
  // loaded. "Open" defers to the module's own status vocabulary (its status
  // column's isComplete options); a module with no status column can't be
  // completed, so its dated items stay open until the date. Accountability
  // resolves like the app does: the item's owner cell first, else everyone
  // assigned to the item's ROLE on this event, else the event's owner (whose
  // job is filling exactly these gaps) — but an owner/role holder who can't
  // receive email falls through to the event owner rather than silently
  // dropping the task.
  const eventById = new Map(
    events
      .filter(
        (e) =>
          e.status !== "completed" &&
          e.status !== "cancelled" &&
          // Academy training sandboxes never email anyone about quest rows.
          isOperationalEvent(e),
      )
      .map((e) => [e._id, e]),
  );
  const items = await ctx.db
    .query("eventItems")
    .withIndex("by_chapter_and_dueDate", (q) =>
      q
        .eq("chapterId", chapterId)
        .gte("dueDate", windowStart)
        .lte("dueDate", windowEnd),
    )
    .collect();
  const statusOptionsCache = new Map<string, SelectOption[] | undefined>();
  // Per-event lookups, loaded once on first use: role → assigned people,
  // and custom-module key → label (for the "Eden · Comms" context line).
  const roleHoldersByEvent = new Map<
    Id<"events">,
    Map<Id<"eventRoles">, Id<"people">[]>
  >();
  const customLabelsByEvent = new Map<Id<"events">, Map<string, string>>();
  const eventLookups = async (eventId: Id<"events">) => {
    let roleHolders = roleHoldersByEvent.get(eventId);
    if (!roleHolders) {
      roleHolders = new Map();
      const assignments = await ctx.db
        .query("roleAssignments")
        .withIndex("by_event", (q) => q.eq("eventId", eventId))
        .collect();
      for (const a of assignments) {
        const list = roleHolders.get(a.roleId) ?? [];
        list.push(a.personId);
        roleHolders.set(a.roleId, list);
      }
      roleHoldersByEvent.set(eventId, roleHolders);
    }
    let customLabels = customLabelsByEvent.get(eventId);
    if (!customLabels) {
      customLabels = new Map(
        (
          await ctx.db
            .query("eventModules")
            .withIndex("by_event", (q) => q.eq("eventId", eventId))
            .collect()
        ).map((m) => [m.key, m.label]),
      );
      customLabelsByEvent.set(eventId, customLabels);
    }
    return { roleHolders, customLabels };
  };
  for (const item of items) {
    if (item.dueDate == null) continue; // guaranteed by the range, narrows type
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
    const { roleHolders, customLabels } = await eventLookups(item.eventId);
    const candidates: Id<"people">[] = item.ownerPersonId
      ? [item.ownerPersonId]
      : item.roleId
        ? (roleHolders.get(item.roleId) ?? [])
        : [];
    // Skip an owner/role holder who can't receive email so the task falls
    // through to the event owner instead of vanishing from every inbox.
    // Keep the "Mine" viewer even when they can't receive email — their own
    // items must surface in-app regardless of an address. For the digest
    // (no onlyPersonId) this is exactly the old reachable-only filter.
    let owners = candidates.filter(
      (id) => reachable(id) || id === onlyPersonId,
    );
    if (owners.length === 0 && event.ownerPersonId) {
      owners = [event.ownerPersonId];
    }
    const moduleLabel =
      MODULE_LABELS[item.module as ModuleKey] ??
      customLabels.get(item.module) ??
      item.module;
    for (const owner of owners) {
      add(owner, {
        kind: "task",
        name: item.title,
        context: `${event.name} · ${moduleLabel}`,
        dueDate: item.dueDate,
      });
    }
  }

  // "Mine" path: return just this person's own entries, skipping the
  // emailability fan-out and the manager directs rollup entirely.
  if (onlyPersonId) {
    const person = personById.get(onlyPersonId);
    const entries = byOwner.get(onlyPersonId) ?? [];
    if (!person || entries.length === 0) return [];
    return [
      {
        personId: onlyPersonId,
        name: person.name,
        email: person.pwEmail ?? person.email ?? "",
        entries,
        directs: [],
      },
    ];
  }

  for (const person of people) {
    if (!reachable(person._id)) continue;
    const email = (person.pwEmail ?? person.email)!;
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
  return recipients;
}

/** Chapter ids to fan the collection over — one bounded transaction each. */
export const listChapterIds = internalQuery({
  args: {},
  handler: async (ctx) => {
    const chapters = await ctx.db.query("chapters").collect();
    return chapters.map((c) => c._id);
  },
});

/** One chapter's open dated work per emailable person — the crons fan this
 * out per chapter so no single query transaction spans the deployment. */
export const openWorkForChapter = internalQuery({
  args: { chapterId: v.id("chapters"), now: v.number() },
  handler: async (ctx, { chapterId, now }) => {
    return await collectOpenWorkForChapter(ctx, chapterId, now);
  },
});

// ── Email rendering ──────────────────────────────────────────────────────────

const MUTED = "#7A5A5A";
const ACCENT = "#D23B3A";

const esc = escapeHtml;

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
            (e) =>
              `<div style="font-family:${SANS};font-size:13px;color:${MUTED};padding-top:4px">${esc(e.name)}${e.context ? ` <span style="color:#A98C8C">· ${esc(e.context)}</span>` : ""} · was due ${formatDue(e.dueDate)}</div>`,
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

/** Fan the collection over chapters — one bounded query transaction each —
 * and flatten into every emailable recipient across the deployment. */
async function allRecipients(
  ctx: ActionCtx,
  now: number,
): Promise<RecipientWork[]> {
  const chapterIds: Id<"chapters">[] = await ctx.runQuery(
    internal.reminders.listChapterIds,
    {},
  );
  const perChapter = await Promise.all(
    chapterIds.map((chapterId) =>
      ctx.runQuery(internal.reminders.openWorkForChapter, { chapterId, now }),
    ),
  );
  return perChapter.flat();
}

/** Sunday-afternoon digest: the coming week's work, one email per person. */
export const sendWeeklyDigests = internalAction({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const base = siteUrl();
    const recipients = await allRecipients(ctx, now);
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
    const recipients = await allRecipients(ctx, now);
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
    projectId: v.optional(v.id("projects")),
    projectName: v.string(),
    authorName: v.string(),
    body: v.string(),
  },
  handler: async (
    _ctx,
    { to, recipientName, projectId, projectName, authorName, body },
  ) => {
    const firstName = recipientName.split(/\s+/)[0];
    const link = projectId ? appUrl(`/project/${projectId}`) : null;
    await sendEmail(
      to,
      `${authorName} commented on ${projectName}`,
      emailShell(`
      <h1 style="margin:0 0 8px;font-size:22px;line-height:1.3">New comment on ${esc(projectName)}</h1>
      <p style="margin:0 0 16px;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-size:14px;line-height:1.6;color:${MUTED}">Hey ${esc(firstName)} — ${esc(authorName)} left an update on your project:</p>
      <div style="background:#fff;border-left:3px solid ${ACCENT};border-radius:0 12px 12px 0;padding:12px 16px;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-size:14px;line-height:1.6">${esc(body)}</div>
      ${
        link
          ? `<div style="font-family:${SANS};font-size:12px;font-weight:600;padding-top:14px"><a href="${link}" style="color:#fff;background:${ACCENT};text-decoration:none;border:1px solid ${ACCENT};border-radius:999px;padding:6px 12px;display:inline-block">Open the project →</a></div>`
          : ""
      }
      <p style="margin:16px 0 0;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-size:12px;line-height:1.6;color:${MUTED}">Reply on the project's thread so the progression stays in one place.</p>`),
    );
    return null;
  },
});
