/**
 * The `/unsubscribe/<token>` page — where a campaign email's unsubscribe link
 * lands (served by `http.ts`, data + writes in `campaigns.ts`). Same GET-is-
 * read-only / POST-is-the-real-change shape as `lib/projectActionPage.ts`
 * (mail scanners prefetch GET links, so the actual suppression write only
 * ever happens on an explicit POST — either the page's own confirm button, or
 * a mail client's automatic RFC 8058 one-click `List-Unsubscribe-Post`).
 *
 * Same brand shell as the other public pages: cream paper, red ink, Corben.
 */
import { BASE_CSS, FAVICON, FONTS } from "./landingPageStyles";
import { escapeHtml } from "./html";

const esc = escapeHtml;

const PAGE_CSS = `
main{max-width:480px;margin:0 auto;padding:28px 20px 80px}
.topbar{display:flex;justify-content:center;padding:6px 0 22px}
.wordmark{font-weight:700;font-size:12px;letter-spacing:.22em;color:var(--accent)}
.card{background:var(--raised);border:1px solid var(--border);border-radius:20px;padding:26px 24px;box-shadow:var(--shadow);text-align:center}
h1{font-family:'Corben',Georgia,serif;font-size:24px;line-height:1.25;margin-bottom:10px}
p{color:var(--muted);font-size:14px;line-height:1.6}
.btn{width:100%;border-radius:999px;padding:12px 18px;font-size:14px;font-weight:700;border:1.5px solid var(--accent);background:var(--accent);color:#fff;margin-top:18px}
.btn:hover{opacity:0.92}
.emoji{font-size:44px;margin-bottom:6px}
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

/** The confirm page (GET). `email` is shown so the recipient can confirm it's
 *  the right address before tapping the button. */
export function renderUnsubscribeConfirm(email: string, token: string): string {
  return shell(
    "Unsubscribe",
    `<div class="card">
      <div class="emoji">✉️</div>
      <h1>Unsubscribe ${esc(email)}?</h1>
      <p>You'll stop receiving email campaigns at this address. This won't affect event RSVP confirmations or ticket receipts.</p>
      <form method="post" action="/unsubscribe/${esc(token)}">
        <button class="btn" type="submit">Unsubscribe me</button>
      </form>
    </div>`,
  );
}

/** Post-unsubscribe confirmation (POST result). */
export function renderUnsubscribeDone(email: string): string {
  return shell(
    "Unsubscribed",
    `<div class="card">
      <div class="emoji">✅</div>
      <h1>You're unsubscribed</h1>
      <p>${esc(email)} won't receive any more email campaigns from us.</p>
    </div>`,
  );
}

/** Unknown/expired token. */
export function renderUnsubscribeNotFound(): string {
  return shell(
    "Link expired",
    `<div class="card">
      <div class="emoji">⏳</div>
      <h1>This link isn't valid</h1>
      <p>It may be from an old campaign. Contact us directly if you'd still like to stop receiving email.</p>
    </div>`,
  );
}
