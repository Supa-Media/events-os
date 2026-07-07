/**
 * The /p/<token> project action page — where a reminder email's "mark done /
 * blocked / in progress" links land (served by http.ts, data + writes in
 * projectActions.ts).
 *
 * Why a page instead of status-changing links directly in the email: mail
 * scanners and preview proxies prefetch GET links, which would flip project
 * statuses on their own. The email links GET here (safe, read-only); the
 * actual change is a same-page form POST — one extra tap, zero accidents.
 * `?intent=<status>` (set by the email's per-status buttons) highlights the
 * chosen action so that tap is obvious.
 *
 * Same brand shell as the public event pages: cream paper, red ink, Corben.
 */
import { BASE_CSS, FAVICON, FONTS } from "./landingPageStyles";
import { escapeHtml } from "./html";
import {
  PROJECT_STATUS_LABELS,
  type ProjectStatus,
} from "@events-os/shared";
import {
  EMAIL_ACTION_STATUSES,
  type EmailActionStatus,
} from "../projectActions";

const esc = escapeHtml;

export type ProjectActionPageData = {
  personName: string | null;
  project: {
    name: string;
    purpose: string | null;
    status: ProjectStatus;
    deadline: number | null;
    startDate: number | null;
    budgetUsd: number | null;
    blocker: string | null;
    ownerName: string | null;
    parentName: string | null;
    eventName: string | null;
  };
  comments: Array<{
    body: string;
    authorName: string | null;
    createdAt: number;
  }>;
};

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleDateString("en-US", {
    weekday: "short",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "America/New_York",
  });
}

const PAGE_CSS = `
main{max-width:560px;margin:0 auto;padding:28px 20px 80px}
.topbar{display:flex;justify-content:center;padding:6px 0 22px}
.wordmark{font-weight:700;font-size:12px;letter-spacing:.22em;color:var(--accent)}
.card{background:var(--raised);border:1px solid var(--border);border-radius:20px;padding:26px 24px;box-shadow:var(--shadow)}
h1{font-family:'Corben',Georgia,serif;font-size:26px;line-height:1.25;margin-bottom:4px}
.meta{color:var(--muted);font-size:13px;margin-bottom:14px}
.pill{display:inline-block;border-radius:999px;padding:3px 12px;font-size:12px;font-weight:700}
.pill.now{background:var(--accent-soft);color:var(--accent)}
.pill.done{background:#E6F3EC;color:var(--success)}
.pill.blocked{background:#FBE8E8;color:var(--accent)}
.pill.neutral{background:var(--sunken);color:var(--muted)}
.section{margin-top:18px}
.section h2{font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin-bottom:6px}
.blocker{background:var(--accent-soft);border-left:3px solid var(--accent);border-radius:0 10px 10px 0;padding:10px 14px;font-size:14px}
.comment{background:var(--cream);border:1px solid var(--border);border-radius:12px;padding:10px 14px;margin-bottom:8px;font-size:14px}
.comment .who{color:var(--faint);font-size:12px;margin-top:3px}
.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:20px}
.actions form{flex:1;min-width:130px}
.btn{width:100%;border-radius:999px;padding:12px 18px;font-size:14px;font-weight:700;border:1.5px solid var(--border-strong);background:var(--raised);color:var(--ink)}
.btn:hover{background:var(--sunken)}
.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.btn.primary:hover{background:var(--accent-hover)}
.hint{color:var(--faint);font-size:12px;text-align:center;margin-top:14px}
.applink{display:block;text-align:center;margin-top:16px;font-weight:600;font-size:14px}
.center{min-height:70vh;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:10px;padding:24px}
`;

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)} · Public Worship</title>${FAVICON}${FONTS}
<style>${BASE_CSS}${PAGE_CSS}</style></head><body>
<main>
  <div class="topbar"><span class="wordmark">PUBLIC WORSHIP · EVENTS OS</span></div>
  ${body}
</main>
</body></html>`;
}

function statusPillClass(status: ProjectStatus): string {
  if (status === "done") return "done";
  if (status === "blocked") return "blocked";
  if (status === "in_progress") return "now";
  return "neutral";
}

const ACTION_LABELS: Record<EmailActionStatus, string> = {
  in_progress: "Mark in progress",
  blocked: "Mark blocked",
  done: "Mark done",
};

/** The main page: full project summary + the three status buttons. */
export function renderProjectActionPage(
  data: ProjectActionPageData,
  token: string,
  intent: string | null,
  appUrl: string | null,
): string {
  const p = data.project;
  const contextBits = [
    p.ownerName ? `Owned by ${esc(p.ownerName)}` : null,
    p.parentName ? `part of ${esc(p.parentName)}` : null,
    p.eventName ? `event: ${esc(p.eventName)}` : null,
    p.deadline ? `due ${fmtDate(p.deadline)}` : null,
    p.budgetUsd != null ? `$${p.budgetUsd.toLocaleString("en-US")} budget` : null,
  ].filter(Boolean);

  // Only a valid, own-property intent counts — `in` would treat inherited
  // Object members ("constructor", "toString") as intents and render their
  // source into the page.
  const validIntent: EmailActionStatus | null =
    intent && (EMAIL_ACTION_STATUSES as readonly string[]).includes(intent)
      ? (intent as EmailActionStatus)
      : null;

  const buttons = EMAIL_ACTION_STATUSES.map((status) => {
    const active = p.status !== status;
    // Never highlight a disabled button (the project's current status) — a
    // primary-styled dead button reads as a broken call-to-action.
    const highlight = validIntent === status && active;
    return `<form method="post" action="/p/${esc(token)}/status">
        <input type="hidden" name="status" value="${status}">
        <button class="btn${highlight ? " primary" : ""}" type="submit"${active ? "" : " disabled"}>${ACTION_LABELS[status]}</button>
      </form>`;
  }).join("");

  return shell(
    p.name,
    `<div class="card">
      <span class="pill ${statusPillClass(p.status)}">${PROJECT_STATUS_LABELS[p.status]}</span>
      <h1>${esc(p.name)}</h1>
      ${contextBits.length ? `<div class="meta">${contextBits.join(" · ")}</div>` : ""}
      ${p.purpose ? `<div class="section"><h2>Purpose</h2><div style="font-size:14px">${esc(p.purpose)}</div></div>` : ""}
      ${p.blocker ? `<div class="section"><h2>Blocker</h2><div class="blocker">${esc(p.blocker)}</div></div>` : ""}
      ${
        data.comments.length
          ? `<div class="section"><h2>Latest updates</h2>${data.comments
              .map(
                (c) =>
                  `<div class="comment">${esc(c.body)}<div class="who">${c.authorName ? esc(c.authorName) + " · " : ""}${fmtDate(c.createdAt)}</div></div>`,
              )
              .join("")}</div>`
          : ""
      }
      <div class="actions">${buttons}</div>
      ${validIntent ? `<div class="hint">Confirm "${ACTION_LABELS[validIntent]}" above — nothing changes until you tap it.</div>` : `<div class="hint">Signed in from your email as ${esc(data.personName ?? "a team member")} — this link works for 30 days.</div>`}
      ${appUrl ? `<a class="applink" href="${esc(appUrl)}">Open in Events OS →</a>` : ""}
    </div>`,
  );
}

/** Post-change confirmation. */
export function renderProjectActionResult(
  projectName: string,
  status: EmailActionStatus,
  token: string,
): string {
  return shell(
    projectName,
    `<div class="center">
      <div style="font-size:44px">${status === "done" ? "🎉" : status === "blocked" ? "🚧" : "🏃"}</div>
      <h1>${esc(projectName)}</h1>
      <p style="color:var(--muted)">is now marked <strong>${PROJECT_STATUS_LABELS[status]}</strong>. The update was logged on the project's thread.</p>
      <a href="/p/${esc(token)}">Back to the project</a>
    </div>`,
  );
}

/** Unknown or expired token. */
export function renderProjectActionGone(): string {
  return shell(
    "Link expired",
    `<div class="center">
      <div style="font-size:44px">⏳</div>
      <h1>This link has expired</h1>
      <p style="color:var(--muted);max-width:340px">Email action links work for 30 days. You'll get a fresh one in the next digest — or open the project in Events OS.</p>
    </div>`,
  );
}
