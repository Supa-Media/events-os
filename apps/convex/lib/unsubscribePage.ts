/**
 * The `/unsubscribe/<token>` page — where a campaign email's unsubscribe link
 * lands (served by `http.ts`, data + writes in `campaigns.ts`). Same GET-is-
 * read-only / POST-is-the-real-change shape as `lib/projectActionPage.ts`
 * (mail scanners prefetch GET links, so the actual suppression write only
 * ever happens on an explicit POST — either the page's own confirm button, or
 * a mail client's automatic RFC 8058 one-click `List-Unsubscribe-Post`).
 *
 * ── Why this page is themed, not landing-page-styled ───────────────────────
 * This is the ONLY public page a recipient reaches from inside an email, so it
 * belongs to the email's brand, not the marketing site's. It used to pull
 * `BASE_CSS`/`FAVICON`/`FONTS` from `landingPageStyles.ts`, which meant it
 * carried that surface's invented palette (`--accent:#D23B3A`,
 * `--cream:#FDF6F6`) — a visible colour jump between the email you tapped and
 * the page you landed on. It now paints itself from the SAME
 * `DEFAULT_EMAIL_THEME` the email did (via `lib/emailShell.ts`), including the
 * dark-mode tokens, so tapping the footer link is visually continuous in
 * either scheme.
 *
 * `lib/landingPage.ts` and `lib/landingPageStyles.ts` are deliberately left
 * alone — that's the public marketing/event surface, a different design system
 * with its own fonts and gradients, and out of scope here.
 */
import { EMAIL_DARK, EMAIL_THEME } from "./emailShell";
import { escapeHtml } from "./html";

const esc = escapeHtml;
const t = EMAIL_THEME;
const d = EMAIL_DARK;

/** A wordmark favicon painted in the theme's own accent/canvas — no shared
 *  asset, so it can't drift back to a palette this page doesn't use. */
const FAVICON = `<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='16' fill='${t.accent}'/><text x='32' y='43' font-weight='bold' font-size='30' fill='${t.accentInk}' text-anchor='middle'>pw</text></svg>`,
)}">`;

/** Every colour here is a theme token. `prefers-color-scheme: dark` swaps the
 *  variables rather than re-declaring rules — one override block, and any
 *  future rule inherits dark mode for free. */
const PAGE_CSS = `
:root{
  color-scheme:light dark;
  --canvas:${t.canvas};--surface:${t.surface};--ink:${t.ink};--muted:${t.muted};
  --border:${t.border};--accent:${t.accent};--accent-ink:${t.accentInk};
  --radius:${t.radius}px;
}
@media (prefers-color-scheme: dark){
  :root{
    --canvas:${d.canvas};--surface:${d.surface};--ink:${d.ink};--muted:${d.muted};
    --border:${d.border};--accent:${d.accent};--accent-ink:${d.accentInk};
  }
}
*{box-sizing:border-box;margin:0;padding:0}
html{-webkit-text-size-adjust:100%}
body{background:var(--canvas);color:var(--ink);font-family:${t.bodyFont};font-size:16px;line-height:1.5;min-height:100vh}
main{max-width:480px;margin:0 auto;padding:28px 20px 80px}
.topbar{display:flex;justify-content:center;padding:6px 0 22px}
.wordmark{font-weight:700;font-size:12px;letter-spacing:.22em;color:var(--accent)}
.card{background:var(--surface);border:1px solid var(--border);border-radius:calc(var(--radius) + 4px);padding:26px 24px;text-align:center}
h1{font-family:${t.headingFont};font-size:24px;line-height:1.25;margin-bottom:10px;color:var(--ink)}
p{color:var(--muted);font-size:14px;line-height:1.6}
.btn{width:100%;border:1.5px solid var(--accent);background:var(--accent);color:var(--accent-ink);border-radius:999px;padding:12px 18px;font-family:inherit;font-size:14px;font-weight:700;cursor:pointer;margin-top:18px}
.btn:hover{opacity:0.92}
.emoji{font-size:44px;margin-bottom:6px}
`;

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="${t.canvas}" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="${d.canvas}" media="(prefers-color-scheme: dark)">
<title>${esc(title)} · Public Worship</title>${FAVICON}
<style>${PAGE_CSS}</style></head><body>
<main>
  <div class="topbar"><span class="wordmark">${esc(t.wordmark || "PUBLIC WORSHIP")}</span></div>
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
      <p>You'll stop receiving all Public Worship newsletters and announcements at this address. This won't affect event RSVP confirmations or ticket receipts.</p>
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
