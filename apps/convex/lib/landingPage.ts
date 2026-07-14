import {
  BASE_CSS,
  FAVICON,
  FONTS,
  LANDING_CSS,
} from "./landingPageStyles";
import { LANDING_SCRIPT } from "./landingPageClient";

/**
 * Public event landing page — server-rendered HTML (Posh/Partiful-style),
 * served by http.ts at /e/<slug>. Self-contained: inline CSS + vanilla JS
 * that talks to same-origin /api/tickets/* httpActions, so link previews
 * (og:*) work for iMessage/WhatsApp and the page needs no separate hosting.
 *
 * Brand: Public Worship — cream paper, dark-red ink, Corben display type.
 * The client script deliberately avoids template literals so this file can
 * assemble it inside one.
 */

type PublicPage = {
  slug: string;
  eventName: string;
  startDate: number;
  endDate: number | null;
  tagline: string | null;
  description: string | null;
  hostName: string;
  venueName: string | null;
  address: string | null;
  addressLocked: boolean;
  hasCover: boolean;
  rsvpEnabled: boolean;
  ticketsEnabled: boolean;
  givingEnabled: boolean;
  givingPrompt: string | null;
  suggestedAmountsCents: number[];
  donationsCents: number;
  donationsCount: number;
  capacity: number | null;
  counts: { going: number; maybe: number; ticketsSold: number };
  guests: Array<{ name: string; status: string }>;
  ticketTypes: Array<{
    id: string;
    name: string;
    description: string | null;
    priceCents: number;
    currency: string;
    maxPerOrder: number | null;
    onSale: boolean;
    lowRemaining: number | null;
  }>;
  viewer: {
    name: string;
    email: string;
    status: string;
    emailVerified: boolean;
  } | null;
  activityLocked: boolean;
  activity: unknown[] | null;
};

/** HTML-escape untrusted strings for element content / attributes. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const TZ = "America/New_York";

function fmtDateLine(ts: number): string {
  return new Date(ts).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: TZ,
  });
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: TZ,
  });
}

function fmtShort(ts: number): string {
  return new Date(ts).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: TZ,
  });
}


/**
 * Render the full landing page. `initial` is the anonymous query result —
 * crawlers see real content; the client re-fetches with its guest token.
 */
export function renderLandingPage(
  initial: PublicPage,
  siteUrl: string,
): string {
  const p = initial;
  const coverUrl = p.hasCover ? `${siteUrl}/e/${p.slug}/cover` : null;
  const pageUrl = `${siteUrl}/e/${p.slug}`;
  const dateLine = `${fmtDateLine(p.startDate)} · ${fmtTime(p.startDate)}${
    p.endDate ? ` – ${fmtTime(p.endDate)}` : ""
  }`;
  const ogDescription =
    p.tagline ??
    `${fmtShort(p.startDate)} · ${fmtTime(p.startDate)}${
      p.venueName ? ` · ${p.venueName}` : ""
    } — RSVP${p.ticketsEnabled ? " & get tickets" : ""}`;

  // Initial data for the client script; <-escape to survive </script>.
  const initialJson = JSON.stringify(p).replace(/</g, "\\u003c");

  const initials = p.eventName
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(p.eventName)} · ${esc(p.hostName)}</title>
<meta name="description" content="${esc(ogDescription)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${esc(p.hostName)}">
<meta property="og:title" content="${esc(p.eventName)}">
<meta property="og:description" content="${esc(ogDescription)}">
<meta property="og:url" content="${pageUrl}">
${coverUrl ? `<meta property="og:image" content="${coverUrl}">\n<meta name="twitter:card" content="summary_large_image">\n<meta name="twitter:image" content="${coverUrl}">` : `<meta name="twitter:card" content="summary">`}
<meta name="twitter:title" content="${esc(p.eventName)}">
<meta name="twitter:description" content="${esc(ogDescription)}">
<meta name="theme-color" content="#FDF6F6">
${FAVICON}
${FONTS}
<style>
${BASE_CSS}${LANDING_CSS}
</style>
</head>
<body>
${coverUrl ? `<div class="backdrop" style="background-image:url('${coverUrl}')"></div>` : ""}
<main>
  <div class="topbar"><div class="wordmark">✦ ${esc(p.hostName.toUpperCase())} ✦</div></div>
  <div class="grid">
    <div class="left">
      <span class="hostchip"><span class="dot">${esc(p.hostName[0] ?? "P")}</span> Hosted by ${esc(p.hostName)}</span>
      <h1 class="title serif">${esc(p.eventName)}</h1>
      ${p.tagline ? `<p class="tagline">${esc(p.tagline)}</p>` : ""}

      <div class="metacard">
        <div class="ic">🗓️</div>
        <div>
          <div class="t">${esc(fmtDateLine(p.startDate))}</div>
          <div class="s">${esc(fmtTime(p.startDate))}${p.endDate ? ` – ${esc(fmtTime(p.endDate))}` : ""} · <a href="${pageUrl}/calendar.ics">Add to calendar</a></div>
        </div>
      </div>
      <div class="metacard" id="wherecard">
        <div class="ic">📍</div>
        <div>
          <div class="t">${esc(p.venueName ?? "Location")}</div>
          <div class="s" id="whereline">${
            p.address
              ? `<a href="https://maps.apple.com/?q=${encodeURIComponent(p.address)}" target="_blank" rel="noopener">${esc(p.address)}</a>`
              : p.addressLocked
                ? `<span class="lockpill">🔒 RSVP to see the full address</span>`
                : `<span>Details coming soon</span>`
          }</div>
        </div>
      </div>

      ${p.description ? `<section><div class="sectitle serif">About</div><div class="about">${esc(p.description)}</div></section>` : ""}

      <section id="guestsec">
        <div class="sectitle serif">Guest list</div>
        <div id="guests"></div>
      </section>

      <section id="activitysec">
        <div class="sectitle serif">Activity</div>
        <div id="activity"></div>
      </section>
    </div>

    <aside class="flyer">
      <div class="coverwrap">
        ${
          coverUrl
            ? `<img class="cover" src="${coverUrl}" alt="${esc(p.eventName)} cover">`
            : `<div class="coverph"><div class="st">${esc(fmtShort(p.startDate).toUpperCase())}</div><div class="init">${esc(initials)}</div><div class="st">${esc(p.hostName.toUpperCase())}</div></div>`
        }
      </div>
      <div class="card" id="ticketscard" style="display:none"></div>
      <div class="card" id="givingcard" style="display:none"></div>
      <div class="card" id="rsvpcard" style="display:none"></div>
    </aside>
  </div>
  <footer>Made with <span class="hearts">♥</span> by ${esc(p.hostName)} · RSVP &amp; tickets by Chapter OS</footer>
</main>

<div class="overlay" id="overlay">
  <div class="sheet">
    <button class="x" id="sheetclose">✕</button>
    <h3 id="sheettitle" class="serif">You’re going!</h3>
    <div class="sub" id="sheetsub">Leave your details so the host can keep you posted.</div>
    <div id="idfields">
      <div class="fld"><label for="f_name">Your name</label><input id="f_name" autocomplete="name" placeholder="First and last name"></div>
      <div class="fld"><label for="f_email">Email</label><input id="f_email" type="email" autocomplete="email" placeholder="you@example.com"></div>
    </div>
    <div id="codefields" style="display:none">
      <div class="fld"><label for="f_code">6-digit code</label><input id="f_code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="123456"></div>
      <button id="resendcode" type="button" style="background:none;border:none;padding:4px 0;color:var(--accent);font-size:13px;font-weight:600;cursor:pointer;text-decoration:underline">Resend code</button>
    </div>
    <button class="sheetbtn" id="sheetgo">Count me in</button>
    <div class="sheeterr" id="sheeterr"></div>
  </div>
</div>
<div id="toast"></div>

<script>window.__INIT__=${initialJson};window.__CFG__={slug:${JSON.stringify(p.slug)}};</script>
<script>
${LANDING_SCRIPT}
</script>
</body>
</html>`;
}

/** Friendly 404 for unpublished/unknown slugs. */
export function renderNotFound(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Event not found · Public Worship</title>${FAVICON}${FONTS}
<style>${BASE_CSS}
.wrap{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:24px;gap:10px}
h1{font-family:'Corben',Georgia,serif;font-size:34px}
p{color:var(--muted);max-width:320px}
</style></head><body><div class="wrap">
<div style="font-size:44px">🕊️</div>
<h1>Nothing here yet</h1>
<p>This event page isn’t live. Check the link, or ask the host for a fresh one.</p>
</div></body></html>`;
}

/** The /t/<code> ticket page: branded stub with a QR for the door. */
export function renderTicketPage(ticket: {
  code: string;
  status: string;
  attendeeName: string;
  ticketTypeName: string;
  eventName: string;
  startDate: number | null;
  venueName: string | null;
  slug: string | null;
  hasCover: boolean;
}, siteUrl: string): string {
  const t = ticket;
  const when = t.startDate
    ? `${fmtShort(t.startDate)} · ${fmtTime(t.startDate)}`
    : "";
  const statusBadge =
    t.status === "checked_in"
      ? `<div class="badge in">✓ Checked in</div>`
      : t.status === "void"
        ? `<div class="badge void">Void</div>`
        : `<div class="badge ok">Valid</div>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(t.eventName)} — ticket · Public Worship</title>
<meta name="robots" content="noindex">
${FAVICON}${FONTS}
<style>${BASE_CSS}
.wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:22px}
.tix{width:100%;max-width:380px;background:var(--raised);border-radius:26px;box-shadow:var(--shadow-pop);overflow:hidden}
.hd{background:linear-gradient(150deg,var(--accent),var(--accent-hover));color:#fff;padding:26px 26px 22px;text-align:center}
.hd .wm{font-size:11px;letter-spacing:.22em;font-weight:700;opacity:.85}
.hd h1{font-family:'Corben',Georgia,serif;font-size:26px;line-height:1.2;margin-top:8px}
.hd .wh{font-size:13.5px;opacity:.9;margin-top:6px}
.perf{height:0;border-top:2px dashed var(--border-strong);position:relative;margin:0 14px}
.perf::before,.perf::after{content:"";position:absolute;top:-11px;width:22px;height:22px;border-radius:50%;background:var(--cream)}
.perf::before{left:-25px}.perf::after{right:-25px}
.bd{padding:24px 26px 28px;text-align:center}
.qr{display:flex;justify-content:center;margin-bottom:14px}
.qr canvas,.qr img{border-radius:10px}
.code{font-family:'SF Mono',Menlo,Consolas,monospace;font-size:22px;font-weight:700;letter-spacing:.08em;color:var(--accent)}
.who{margin-top:12px;font-weight:600}
.type{color:var(--muted);font-size:13.5px;margin-top:2px}
.badge{display:inline-block;margin-top:14px;border-radius:999px;padding:5px 16px;font-size:12.5px;font-weight:700}
.badge.ok{background:#EAF6F0;color:var(--success)}
.badge.in{background:var(--sky);color:#2C4A86}
.badge.void{background:var(--accent-soft);color:var(--accent)}
.foot{padding:0 26px 24px;text-align:center;font-size:12px;color:var(--faint)}
.foot a{color:var(--accent)}
</style></head><body>
<div class="wrap"><div class="tix">
  <div class="hd">
    <div class="wm">✦ PUBLIC WORSHIP ✦</div>
    <h1>${esc(t.eventName)}</h1>
    <div class="wh">${esc(when)}${t.venueName ? ` · ${esc(t.venueName)}` : ""}</div>
  </div>
  <div style="height:14px"></div>
  <div class="perf"></div>
  <div class="bd">
    <div class="qr" id="qr"></div>
    <div class="code">${esc(t.code)}</div>
    <div class="who">${esc(t.attendeeName)}</div>
    <div class="type">${esc(t.ticketTypeName)}</div>
    ${statusBadge}
  </div>
  <div class="foot">Show this at the door.${t.slug ? ` <a href="${siteUrl}/e/${esc(t.slug)}">Event details</a>` : ""}</div>
</div></div>
<script src="https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js"></script>
<script>
(function(){
  try{
    var qr=qrcode(0,'M');
    qr.addData(${JSON.stringify(t.code)});
    qr.make();
    document.getElementById('qr').innerHTML=qr.createImgTag(5,8);
  }catch(e){}
})();
</script>
</body></html>`;
}

/** iCalendar file so "Add to calendar" works everywhere. */
export function renderIcs(args: {
  slug: string;
  eventName: string;
  startDate: number;
  endDate: number | null;
  venueName: string | null;
  address: string | null;
  description: string | null;
  siteUrl: string;
}): string {
  const dt = (ts: number) =>
    new Date(ts)
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}/, "");
  const escapeIcs = (s: string) =>
    s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
  const location = [args.venueName, args.address].filter(Boolean).join(", ");
  const url = `${args.siteUrl}/e/${args.slug}`;
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Public Worship//Chapter OS//EN",
    "BEGIN:VEVENT",
    `UID:${args.slug}@events-os`,
    `DTSTAMP:${dt(Date.now())}`,
    `DTSTART:${dt(args.startDate)}`,
    `DTEND:${dt(args.endDate ?? args.startDate + 2 * 60 * 60 * 1000)}`,
    `SUMMARY:${escapeIcs(args.eventName)}`,
    ...(location ? [`LOCATION:${escapeIcs(location)}`] : []),
    `DESCRIPTION:${escapeIcs((args.description ? args.description + "\n\n" : "") + url)}`,
    `URL:${url}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}
