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
  viewer: { name: string; email: string; status: string } | null;
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

/** Shared <head> boilerplate: fonts + favicon + palette. */
const FONTS = `
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Corben:wght@400;700&family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700&display=swap" rel="stylesheet">`;

const FAVICON = `<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='16' fill='#D23B3A'/><text x='32' y='43' font-family='Georgia,serif' font-weight='bold' font-size='30' fill='#FDF6F6' text-anchor='middle'>pw</text></svg>`,
)}">`;

const BASE_CSS = `
:root{
  --cream:#FDF6F6;--raised:#FFFFFF;--sunken:#FAEEE9;--ink:#210909;--muted:#7A5A5A;
  --faint:#A98C8C;--border:#EFE0DC;--border-strong:#E4CFCB;--accent:#D23B3A;
  --accent-hover:#922424;--accent-soft:#FBE8E8;--peach:#F5E5C7;--mint:#A8D9C4;
  --lavender:#C9A8E0;--sky:#D6E5F2;--success:#2F7D5B;--warn:#B4761A;
  --shadow:0 2px 8px rgba(33,9,9,.06),0 12px 32px rgba(33,9,9,.08);
  --shadow-pop:0 4px 12px rgba(33,9,9,.10),0 24px 60px rgba(33,9,9,.16);
}
*{box-sizing:border-box;margin:0;padding:0}
html{-webkit-text-size-adjust:100%}
body{
  background:var(--cream);color:var(--ink);
  font-family:'DM Sans',-apple-system,'Segoe UI',sans-serif;
  font-size:16px;line-height:1.5;min-height:100vh;overflow-x:hidden;
}
body::before{
  content:"";position:fixed;inset:0;z-index:-2;pointer-events:none;
  background:
    radial-gradient(600px 400px at 8% -5%, rgba(210,59,58,.07), transparent 70%),
    radial-gradient(700px 500px at 105% 15%, rgba(201,168,224,.12), transparent 70%),
    radial-gradient(600px 500px at 50% 110%, rgba(245,229,199,.35), transparent 70%);
}
.serif{font-family:'Corben',Georgia,serif}
a{color:var(--accent)}
button{font-family:inherit;cursor:pointer;border:0;background:none;color:inherit}
input,textarea{font-family:inherit;font-size:15px;color:var(--ink)}
::placeholder{color:var(--faint)}
`;

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
${BASE_CSS}
.backdrop{
  position:fixed;inset:-10% -10% auto -10%;height:85vh;z-index:-1;pointer-events:none;
  background-size:cover;background-position:center;
  filter:blur(90px) saturate(1.2);opacity:.28;transform:scale(1.15);
  -webkit-mask-image:linear-gradient(#000 40%,transparent);
  mask-image:linear-gradient(#000 40%,transparent);
}
main{max-width:1080px;margin:0 auto;padding:20px 20px 96px;position:relative}
.topbar{display:flex;justify-content:center;padding:10px 0 26px}
.wordmark{font-weight:700;font-size:12px;letter-spacing:.22em;color:var(--accent)}
.grid{display:grid;grid-template-columns:minmax(0,1fr) 400px;gap:52px;align-items:start}
@media(max-width:880px){
  .grid{grid-template-columns:1fr;gap:28px}
  .flyer{order:-1;max-width:420px;margin:0 auto;width:100%}
}
/* ── left column ── */
.hostchip{display:inline-flex;align-items:center;gap:8px;background:var(--raised);
  border:1px solid var(--border);border-radius:999px;padding:6px 14px 6px 6px;
  font-size:13px;font-weight:500;color:var(--muted);box-shadow:var(--shadow)}
.hostchip .dot{width:24px;height:24px;border-radius:50%;
  background:radial-gradient(circle at 30% 30%,#F5D3D0,var(--accent));
  display:flex;align-items:center;justify-content:center;color:#fff;font-size:11px;font-weight:700}
h1.title{font-size:clamp(38px,6.5vw,60px);line-height:1.08;font-weight:700;margin:18px 0 8px;letter-spacing:-.01em}
.tagline{font-size:18px;color:var(--muted);margin-bottom:26px}
.metacard{display:flex;gap:14px;align-items:flex-start;background:var(--raised);
  border:1px solid var(--border);border-radius:16px;padding:14px 16px;margin-bottom:12px;box-shadow:var(--shadow)}
.metacard .ic{width:44px;height:44px;border-radius:12px;background:var(--accent-soft);
  display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0}
.metacard .t{font-weight:600;font-size:15px}
.metacard .s{font-size:13.5px;color:var(--muted);margin-top:1px}
.metacard .s a{font-weight:500}
.lockpill{display:inline-flex;align-items:center;gap:6px;background:var(--sunken);
  border:1px dashed var(--border-strong);border-radius:999px;padding:3px 12px;
  font-size:12.5px;color:var(--muted);margin-top:4px}
section{margin-top:36px}
.sectitle{font-family:'Corben',Georgia,serif;font-size:21px;font-weight:400;
  display:flex;align-items:center;gap:10px;margin-bottom:14px}
.sectitle::after{content:"";height:1px;flex:1;background:var(--border)}
.about{white-space:pre-wrap;color:#4A2E2E;font-size:15.5px;line-height:1.65}
/* guests */
.avatars{display:flex;align-items:center}
.av{width:42px;height:42px;border-radius:50%;border:2.5px solid var(--cream);
  display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;
  color:#5A3A3A;margin-left:-10px;flex-shrink:0}
.av:first-child{margin-left:0}
.av.more{background:var(--sunken);color:var(--muted);font-size:12px}
.gcount{font-size:14px;color:var(--muted);margin-top:10px}
.gcount b{color:var(--ink)}
/* activity */
.locked{position:relative;border-radius:20px;overflow:hidden;border:1px solid var(--border);background:var(--raised)}
.locked .rows{filter:blur(7px);opacity:.55;padding:18px;pointer-events:none}
.fakerow{display:flex;gap:12px;align-items:center;margin-bottom:16px}
.fakerow .b1{height:12px;border-radius:6px;background:var(--sunken);width:46%}
.fakerow .b2{height:9px;border-radius:6px;background:var(--sunken);width:28%;margin-top:6px}
.locked .veil{position:absolute;inset:0;display:flex;flex-direction:column;gap:10px;
  align-items:center;justify-content:center;text-align:center;padding:20px}
.locked .veil .lk{font-size:26px}
.locked .veil p{font-size:14.5px;color:var(--muted);max-width:260px}
.composer{display:flex;gap:10px;margin-bottom:18px}
.composer input{flex:1;background:var(--raised);border:1.5px solid var(--border);
  border-radius:999px;padding:11px 18px;outline:none;transition:border .15s}
.composer input:focus{border-color:var(--accent)}
.feeditem{display:flex;gap:12px;margin-bottom:20px}
.feeditem .body{flex:1;min-width:0}
.feedline{font-size:14.5px}
.feedline b{font-weight:600}
.feedline .st{white-space:nowrap}
.ago{color:var(--faint);font-size:12.5px;margin-left:6px}
.cbody{font-size:14.5px;color:#3D2424;margin-top:2px;overflow-wrap:break-word}
.reacts{display:flex;gap:6px;flex-wrap:wrap;margin-top:7px;align-items:center}
.rchip{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--border);
  background:var(--raised);border-radius:999px;padding:2.5px 10px;font-size:13px;transition:transform .1s}
.rchip:active{transform:scale(1.15)}
.rchip.mine{background:var(--accent-soft);border-color:var(--accent);color:var(--accent-hover)}
.rchip .n{font-size:12px;color:var(--muted);font-weight:600}
.raddb{border:1px dashed var(--border-strong);border-radius:999px;padding:2.5px 9px;
  font-size:12.5px;color:var(--faint)}
.replybtn{font-size:12.5px;color:var(--muted);font-weight:600}
.replies{margin-top:12px;padding-left:14px;border-left:2px solid var(--border)}
.replies .feeditem{margin-bottom:12px}
.replybox{display:flex;gap:8px;margin-top:8px}
.replybox input{flex:1;background:var(--raised);border:1.5px solid var(--border);
  border-radius:999px;padding:7px 14px;font-size:13.5px;outline:none}
.replybox input:focus{border-color:var(--accent)}
.picker{display:inline-flex;gap:2px;background:var(--raised);border:1px solid var(--border);
  border-radius:999px;padding:3px 6px;box-shadow:var(--shadow-pop)}
.picker button{font-size:17px;padding:2px 4px;border-radius:8px;transition:transform .1s}
.picker button:hover{transform:scale(1.25)}
/* ── right column ── */
.flyer{position:sticky;top:24px}
.coverwrap{background:#fff;padding:10px;border-radius:24px;box-shadow:var(--shadow-pop);
  transform:rotate(-1.2deg);transition:transform .25s}
.coverwrap:hover{transform:rotate(0deg) scale(1.005)}
.cover{width:100%;aspect-ratio:4/5;object-fit:cover;border-radius:16px;display:block}
.coverph{width:100%;aspect-ratio:4/5;border-radius:16px;display:flex;flex-direction:column;
  align-items:center;justify-content:center;gap:6px;color:#fff;text-align:center;
  background:
    radial-gradient(circle at 20% 15%, rgba(245,229,199,.9), transparent 55%),
    radial-gradient(circle at 85% 80%, rgba(201,168,224,.75), transparent 55%),
    linear-gradient(160deg,#D23B3A,#922424)}
.coverph .init{font-family:'Corben',Georgia,serif;font-size:72px;font-weight:700;line-height:1;text-shadow:0 3px 14px rgba(33,9,9,.3)}
.coverph .st{font-size:12px;letter-spacing:.24em;font-weight:600;opacity:.9}
.card{background:var(--raised);border:1px solid var(--border);border-radius:20px;
  padding:20px;margin-top:18px;box-shadow:var(--shadow)}
.cardtitle{font-family:'Corben',Georgia,serif;font-size:19px;margin-bottom:14px}
/* rsvp orbs */
.orbs{display:flex;justify-content:space-between;gap:8px}
.orb{flex:1;display:flex;flex-direction:column;align-items:center;gap:8px;padding:6px 2px;border-radius:16px;transition:background .15s}
.orb .face{width:62px;height:62px;border-radius:50%;background:var(--sunken);
  border:2px solid transparent;display:flex;align-items:center;justify-content:center;
  font-size:27px;box-shadow:inset 0 -3px 6px rgba(33,9,9,.05);transition:all .15s}
.orb:hover .face{transform:translateY(-2px) scale(1.05)}
.orb .lbl{font-size:13px;font-weight:600;color:var(--muted)}
.orb.sel .face{background:var(--accent-soft);border-color:var(--accent);
  box-shadow:0 0 0 4px rgba(210,59,58,.14)}
.orb.sel .lbl{color:var(--accent)}
.youare{display:flex;align-items:center;justify-content:space-between;margin-top:14px;
  background:var(--sunken);border-radius:999px;padding:8px 8px 8px 16px;font-size:14px}
.youare b{font-weight:700}
.youare button{background:var(--raised);border:1px solid var(--border);border-radius:999px;
  padding:5px 14px;font-size:12.5px;font-weight:600;color:var(--muted)}
/* tickets */
.tier{display:flex;align-items:center;gap:12px;padding:13px 0;border-bottom:1px solid var(--border)}
.tier:last-of-type{border-bottom:0}
.tier .inf{flex:1;min-width:0}
.tier .nm{font-weight:600;font-size:15px}
.tier .ds{font-size:12.5px;color:var(--muted);margin-top:1px}
.tier .low{font-size:12px;color:var(--warn);font-weight:600;margin-top:2px}
.tier .pr{font-weight:700;font-size:15px;white-space:nowrap}
.tier .pr .free{color:var(--success)}
.stepper{display:flex;align-items:center;gap:10px}
.stepbtn{width:30px;height:30px;border-radius:50%;border:1.5px solid var(--border-strong);
  font-size:16px;font-weight:600;color:var(--muted);display:flex;align-items:center;justify-content:center;transition:all .12s}
.stepbtn:hover{border-color:var(--accent);color:var(--accent)}
.stepbtn:disabled{opacity:.3;pointer-events:none}
.qty{min-width:16px;text-align:center;font-weight:700;font-size:15px}
.soldout{font-size:12.5px;font-weight:700;color:var(--faint);letter-spacing:.06em}
.buybtn{width:100%;margin-top:16px;background:var(--accent);color:#fff;font-weight:700;
  font-size:15.5px;border-radius:999px;padding:14px;transition:background .15s;box-shadow:0 6px 18px rgba(210,59,58,.35)}
.buybtn:hover{background:var(--accent-hover)}
.buybtn:disabled{background:var(--border-strong);box-shadow:none;pointer-events:none}
/* sheet */
.overlay{position:fixed;inset:0;background:rgba(33,9,9,.42);backdrop-filter:blur(5px);
  z-index:50;display:none;align-items:flex-end;justify-content:center}
@media(min-width:640px){.overlay{align-items:center}}
.overlay.open{display:flex}
.sheet{background:var(--cream);border-radius:26px 26px 0 0;width:100%;max-width:440px;
  padding:28px 24px 34px;position:relative;animation:up .25s ease}
@media(min-width:640px){.sheet{border-radius:26px;padding-bottom:28px}}
@keyframes up{from{transform:translateY(40px);opacity:0}to{transform:none;opacity:1}}
.sheet h3{font-family:'Corben',Georgia,serif;font-size:22px;margin-bottom:4px;padding-right:34px}
.sheet .sub{font-size:13.5px;color:var(--muted);margin-bottom:18px}
.sheet .x{position:absolute;top:18px;right:18px;width:32px;height:32px;border-radius:50%;
  background:var(--sunken);color:var(--muted);font-size:15px;display:flex;align-items:center;justify-content:center}
.fld{margin-bottom:12px}
.fld label{display:block;font-size:12.5px;font-weight:600;color:var(--muted);margin-bottom:5px}
.fld input{width:100%;background:var(--raised);border:1.5px solid var(--border);
  border-radius:14px;padding:12px 16px;outline:none;transition:border .15s}
.fld input:focus{border-color:var(--accent)}
.sheetbtn{width:100%;margin-top:8px;background:var(--accent);color:#fff;font-weight:700;
  font-size:15.5px;border-radius:999px;padding:14px}
.sheetbtn:hover{background:var(--accent-hover)}
.sheetbtn:disabled{opacity:.6;pointer-events:none}
.sheeterr{color:var(--accent);font-size:13px;margin-top:10px;text-align:center;min-height:16px}
/* toast */
#toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%) translateY(20px);
  background:var(--ink);color:var(--cream);border-radius:999px;padding:11px 22px;
  font-size:14px;font-weight:500;opacity:0;pointer-events:none;transition:all .3s;z-index:60;
  box-shadow:var(--shadow-pop);max-width:90vw;text-align:center}
#toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
footer{margin-top:70px;text-align:center;font-size:12.5px;color:var(--faint)}
footer .hearts{color:var(--accent)}
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
      <div class="card" id="rsvpcard" style="display:none"></div>
    </aside>
  </div>
  <footer>Made with <span class="hearts">♥</span> by ${esc(p.hostName)} · RSVP &amp; tickets by Events OS</footer>
</main>

<div class="overlay" id="overlay">
  <div class="sheet">
    <button class="x" id="sheetclose">✕</button>
    <h3 id="sheettitle" class="serif">You’re going!</h3>
    <div class="sub" id="sheetsub">Leave your details so the host can keep you posted.</div>
    <div class="fld"><label for="f_name">Your name</label><input id="f_name" autocomplete="name" placeholder="First and last name"></div>
    <div class="fld"><label for="f_email">Email</label><input id="f_email" type="email" autocomplete="email" placeholder="you@example.com"></div>
    <button class="sheetbtn" id="sheetgo">Count me in</button>
    <div class="sheeterr" id="sheeterr"></div>
  </div>
</div>
<div id="toast"></div>

<script>window.__INIT__=${initialJson};window.__CFG__={slug:${JSON.stringify(p.slug)}};</script>
<script>
(function(){
"use strict";
var SLUG=window.__CFG__.slug;
var D=window.__INIT__;
var KEY='pwguest:'+SLUG;
var TOKEN=null;
try{TOKEN=localStorage.getItem(KEY);}catch(e){}
var cart={};
var pending=null; // action waiting on the identity sheet
var openPicker=null,openReply=null;
var EMOJIS=['🔥','❤️','🙌','😂','👀','🎉'];
var PASTELS=['#F5E5C7','#A8D9C4','#C9A8E0','#D6E5F2','#F5D3D0'];
var STATUS_META={going:{e:'👍',w:'Going'},maybe:{e:'🤔',w:'Maybe'},not_going:{e:'😢',w:"Can't go"}};

function $(id){return document.getElementById(id);}
function el(tag,cls,text){var n=document.createElement(tag);if(cls)n.className=cls;if(text!=null)n.textContent=text;return n;}
function toast(msg){var t=$('toast');t.textContent=msg;t.classList.add('show');clearTimeout(t._h);t._h=setTimeout(function(){t.classList.remove('show');},3200);}
function money(c){return c===0?'Free':'$'+(c/100).toFixed(c%100===0?0:2);}
function initialsOf(name){var parts=name.trim().split(/\\s+/);var s=(parts[0]?parts[0][0]:'')+(parts[1]?parts[1][0]:'');return s.toUpperCase()||'?';}
function pastel(name){var h=0;for(var i=0;i<name.length;i++)h=(h*31+name.charCodeAt(i))>>>0;return PASTELS[h%PASTELS.length];}
function ago(ts){var s=Math.max(1,Math.round((Date.now()-ts)/1000));
  if(s<60)return 'just now';var m=Math.round(s/60);if(m<60)return m+'m';
  var h=Math.round(m/60);if(h<24)return h+'h';return Math.round(h/24)+'d';}

function api(path,body){
  return fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
    .then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||'Something went wrong');return j;});});
}
function refresh(){
  var q='/api/tickets/page?slug='+encodeURIComponent(SLUG)+(TOKEN?'&token='+encodeURIComponent(TOKEN):'');
  return fetch(q).then(function(r){return r.json();}).then(function(j){if(j&&j.slug){D=j;renderAll();}});
}
function saveToken(t){if(!t)return;TOKEN=t;try{localStorage.setItem(KEY,t);}catch(e){}}

/* ── sheet ── */
function openSheet(title,sub,cta,action){
  pending=action;
  $('sheettitle').textContent=title;
  $('sheetsub').textContent=sub;
  $('sheetgo').textContent=cta;
  $('sheeterr').textContent='';
  if(D.viewer){$('f_name').value=D.viewer.name;$('f_email').value=D.viewer.email;}
  $('overlay').classList.add('open');
  setTimeout(function(){$('f_name').focus();},100);
}
function closeSheet(){$('overlay').classList.remove('open');pending=null;}
$('sheetclose').onclick=closeSheet;
$('overlay').addEventListener('click',function(e){if(e.target===$('overlay'))closeSheet();});
$('sheetgo').onclick=function(){
  var name=$('f_name').value.trim(),email=$('f_email').value.trim();
  if(!name||email.indexOf('@')<0){$('sheeterr').textContent='Add your name and a real email ✨';return;}
  if(!pending)return closeSheet();
  var act=pending;
  $('sheetgo').disabled=true;
  act(name,email).then(function(){$('sheetgo').disabled=false;closeSheet();})
    .catch(function(err){$('sheetgo').disabled=false;$('sheeterr').textContent=err.message;});
};

/* ── rsvp ── */
function doRsvp(status,name,email){
  return api('/api/tickets/rsvp',{slug:SLUG,token:TOKEN||undefined,name:name,email:email,status:status})
    .then(function(res){
      saveToken(res.token);
      var m=STATUS_META[status];
      toast(status==='going'?'You are on the list! 🎉':(status==='maybe'?'Marked as maybe 🤔':'Sorry you will miss it 💔'));
      return refresh();
    });
}
function pickStatus(status){
  var m=STATUS_META[status];
  if(TOKEN&&D.viewer){doRsvp(status).catch(function(e){toast(e.message);});return;}
  openSheet(
    status==='going'?'You’re going! '+m.e:(status==='maybe'?'Maybe? '+m.e:'Can’t make it '+m.e),
    'Leave your details so the host can keep you posted.',
    status==='going'?'Count me in':'Save my RSVP',
    function(name,email){return doRsvp(status,name,email);}
  );
}
function requireIdentity(then,title){
  if(TOKEN&&D.viewer)return then();
  openSheet(title||'Join the party first ✨','RSVP so everyone knows who’s talking.','RSVP & continue',
    function(name,email){return doRsvp('going',name,email).then(then);});
}

/* ── tickets ── */
function cartCount(){var n=0;for(var k in cart)n+=cart[k];return n;}
function cartTotal(){var t=0;D.ticketTypes.forEach(function(tt){t+=(cart[tt.id]||0)*tt.priceCents;});return t;}
function renderTickets(){
  var card=$('ticketscard');
  card.innerHTML='';
  if(!D.ticketsEnabled||D.ticketTypes.length===0){card.style.display='none';return;}
  card.style.display='block';
  card.appendChild(el('div','cardtitle serif','Tickets'));
  D.ticketTypes.forEach(function(tt){
    var row=el('div','tier');
    var inf=el('div','inf');
    inf.appendChild(el('div','nm',tt.name));
    if(tt.description)inf.appendChild(el('div','ds',tt.description));
    if(tt.lowRemaining!=null&&tt.onSale)inf.appendChild(el('div','low','Only '+tt.lowRemaining+' left'));
    row.appendChild(inf);
    var pr=el('div','pr');
    if(tt.priceCents===0){pr.appendChild(el('span','free','Free'));}else{pr.textContent=money(tt.priceCents);}
    row.appendChild(pr);
    if(!tt.onSale){row.appendChild(el('div','soldout','SOLD OUT'));}
    else{
      var st=el('div','stepper');
      var minus=el('button','stepbtn','−'),plus=el('button','stepbtn','+');
      var q=el('div','qty',String(cart[tt.id]||0));
      minus.disabled=!(cart[tt.id]>0);
      var max=tt.maxPerOrder||10;
      plus.disabled=(cart[tt.id]||0)>=max||(tt.lowRemaining!=null&&(cart[tt.id]||0)>=tt.lowRemaining);
      minus.onclick=function(){cart[tt.id]=Math.max(0,(cart[tt.id]||0)-1);if(!cart[tt.id])delete cart[tt.id];renderTickets();};
      plus.onclick=function(){cart[tt.id]=(cart[tt.id]||0)+1;renderTickets();};
      st.appendChild(minus);st.appendChild(q);st.appendChild(plus);
      row.appendChild(st);
    }
    card.appendChild(row);
  });
  var n=cartCount();
  var buy=el('button','buybtn');
  buy.textContent=n>0?('Get '+n+' ticket'+(n>1?'s':'')+' · '+money(cartTotal())):'Get tickets';
  buy.disabled=n===0;
  buy.onclick=startCheckout;
  card.appendChild(buy);
}
function startCheckout(){
  var items=[];for(var k in cart)items.push({ticketTypeId:k,quantity:cart[k]});
  if(items.length===0)return;
  var run=function(name,email){
    return api('/api/tickets/checkout',{slug:SLUG,token:TOKEN||undefined,name:name,email:email,items:items})
      .then(function(res){
        saveToken(res.token);
        if(res.kind==='stripe'){window.location.href=res.url;return;}
        cart={};
        toast('🎟️ Tickets sent — check your email!');
        return refresh();
      });
  };
  if(TOKEN&&D.viewer){run(D.viewer.name,D.viewer.email).catch(function(e){toast(e.message);});}
  else openSheet('Almost there 🎟️','Your tickets and receipt land in your inbox.','Continue',run);
}

/* ── rsvp card ── */
function renderRsvp(){
  var card=$('rsvpcard');
  card.innerHTML='';
  if(!D.rsvpEnabled){card.style.display='none';return;}
  card.style.display='block';
  card.appendChild(el('div','cardtitle serif',D.viewer?'Your RSVP':'Are you coming?'));
  var orbs=el('div','orbs');
  ['going','maybe','not_going'].forEach(function(s){
    var m=STATUS_META[s];
    var o=el('button','orb'+(D.viewer&&D.viewer.status===s?' sel':''));
    var f=el('div','face',m.e);
    o.appendChild(f);o.appendChild(el('div','lbl',m.w));
    o.onclick=function(){pickStatus(s);};
    orbs.appendChild(o);
  });
  card.appendChild(orbs);
  if(D.viewer){
    var ya=el('div','youare');
    var t=el('div');t.innerHTML='';
    var m=STATUS_META[D.viewer.status];
    var b=el('b',null,D.viewer.name.split(' ')[0]);
    t.appendChild(b);t.appendChild(document.createTextNode(' — '+m.w+' '+m.e));
    ya.appendChild(t);
    var edit=el('button',null,'Edit');
    edit.onclick=function(){openSheet('Update your details','Change your name or email.','Save',
      function(name,email){return doRsvp(D.viewer.status,name,email);});};
    ya.appendChild(edit);
    card.appendChild(ya);
  }
}

/* ── guests ── */
function renderGuests(){
  var box=$('guests');
  box.innerHTML='';
  var total=D.counts.going+D.counts.maybe;
  if(D.guests.length===0&&total===0){
    var empty=el('div','gcount');
    empty.textContent='No one has RSVP’d yet — be the first ✨';
    box.appendChild(empty);return;
  }
  var row=el('div','avatars');
  var shown=D.guests.slice(0,10);
  shown.forEach(function(g){
    var a=el('div','av',initialsOf(g.name));
    a.style.background=pastel(g.name);
    a.title=g.name+' · '+(STATUS_META[g.status]||{}).w;
    row.appendChild(a);
  });
  if(total>shown.length){row.appendChild(el('div','av more','+'+(total-shown.length)));}
  box.appendChild(row);
  var c=el('div','gcount');
  var bits=[];
  if(D.counts.going)bits.push('<b>'+D.counts.going+' going</b>');
  if(D.counts.maybe)bits.push(D.counts.maybe+' maybe');
  if(D.capacity){var left=Math.max(0,D.capacity-D.counts.going);bits.push(left+' spot'+(left===1?'':'s')+' left');}
  c.innerHTML=bits.join(' · ');
  box.appendChild(c);
}

/* ── activity ── */
function reactRow(item,type){
  var row=el('div','reacts');
  (item.reactions||[]).forEach(function(r){
    var chip=el('button','rchip'+(r.mine?' mine':''));
    chip.appendChild(document.createTextNode(r.emoji));
    chip.appendChild(el('span','n',String(r.count)));
    chip.onclick=function(){toggleReact(type,item.id,r.emoji);};
    row.appendChild(chip);
  });
  var add=el('button','raddb','＋ 😊');
  add.onclick=function(ev){
    ev.stopPropagation();
    if(openPicker){openPicker.remove();openPicker=null;return;}
    var pick=el('span','picker');
    EMOJIS.forEach(function(e){
      var b=el('button',null,e);
      b.onclick=function(){pick.remove();openPicker=null;toggleReact(type,item.id,e);};
      pick.appendChild(b);
    });
    openPicker=pick;
    add.after(pick);
  };
  row.appendChild(add);
  return row;
}
function toggleReact(targetType,targetId,emoji){
  requireIdentity(function(){
    return api('/api/tickets/react',{slug:SLUG,token:TOKEN,targetType:targetType,targetId:targetId,emoji:emoji})
      .then(refresh).catch(function(e){toast(e.message);});
  },'RSVP to react ✨');
}
function feedItem(item,isReply){
  var it=el('div','feeditem');
  var a=el('div','av',initialsOf(item.authorName));
  a.style.background=pastel(item.authorName);
  a.style.width=isReply?'30px':'38px';a.style.height=isReply?'30px':'38px';
  a.style.fontSize=isReply?'11px':'13px';a.style.border='none';a.style.marginLeft='0';
  it.appendChild(a);
  var body=el('div','body');
  var line=el('div','feedline');
  var nm=el('b',null,item.authorName+(item.isViewer?' (you)':''));
  line.appendChild(nm);
  if(item.type==='rsvp'){
    var m=STATUS_META[item.status]||{e:'',w:item.status};
    var st=el('span','st',' rsvped '+m.w+' '+m.e);
    line.appendChild(st);
  }
  line.appendChild(el('span','ago',ago(item.createdAt)));
  body.appendChild(line);
  if(item.type==='comment')body.appendChild(el('div','cbody',item.body));
  body.appendChild(reactRow(item,item.type==='rsvp'?'rsvp':'comment'));
  if(!isReply){
    var rb=el('button','replybtn','Reply');
    rb.style.marginTop='6px';
    rb.onclick=function(){
      if(openReply){openReply.remove();openReply=null;return;}
      var box=el('div','replybox');
      var inp=el('input');inp.placeholder='Reply to '+item.authorName.split(' ')[0]+'…';
      var send=el('button','replybtn','Send');
      var submit=function(){
        var val=inp.value.trim();if(!val)return;
        requireIdentity(function(){
          var payload={slug:SLUG,token:TOKEN,body:val};
          if(item.type==='rsvp')payload.replyToRsvpId=item.id;else payload.parentId=item.id;
          return api('/api/tickets/comment',payload).then(refresh).catch(function(e){toast(e.message);});
        },'RSVP to reply ✨');
      };
      send.onclick=submit;
      inp.addEventListener('keydown',function(e){if(e.key==='Enter')submit();});
      box.appendChild(inp);box.appendChild(send);
      openReply=box;
      body.appendChild(box);
      inp.focus();
    };
    body.appendChild(rb);
    if(item.replies&&item.replies.length){
      var reps=el('div','replies');
      item.replies.forEach(function(r){reps.appendChild(feedItem(r,true));});
      body.appendChild(reps);
    }
  }
  it.appendChild(body);
  return it;
}
function renderActivity(){
  var box=$('activity');
  box.innerHTML='';
  if(D.activityLocked){
    var lock=el('div','locked');
    var rows=el('div','rows');
    for(var i=0;i<3;i++){
      var fr=el('div','fakerow');
      var av=el('div','av','');av.style.background=PASTELS[i];av.style.border='none';av.style.marginLeft='0';
      var bars=el('div');bars.style.flex='1';
      bars.appendChild(el('div','b1'));bars.appendChild(el('div','b2'));
      fr.appendChild(av);fr.appendChild(bars);
      rows.appendChild(fr);
    }
    lock.appendChild(rows);
    var veil=el('div','veil');
    veil.appendChild(el('div','lk','🔒'));
    veil.appendChild(el('p',null,'Only guests can see the conversation. RSVP to peek inside.'));
    var btn=el('button','buybtn','RSVP to unlock');
    btn.style.width='auto';btn.style.padding='11px 26px';btn.style.marginTop='2px';
    btn.onclick=function(){pickStatus('going');};
    veil.appendChild(btn);
    lock.appendChild(veil);
    box.appendChild(lock);
    return;
  }
  var comp=el('div','composer');
  var inp=el('input');inp.placeholder=D.viewer?'Say something to the group…':'RSVP to join the conversation…';
  var post=el('button','buybtn','Post');
  post.style.width='auto';post.style.padding='11px 22px';post.style.marginTop='0';
  var submit=function(){
    var val=inp.value.trim();if(!val)return;
    requireIdentity(function(){
      return api('/api/tickets/comment',{slug:SLUG,token:TOKEN,body:val})
        .then(function(){inp.value='';return refresh();}).catch(function(e){toast(e.message);});
    },'RSVP to comment ✨');
  };
  post.onclick=submit;
  inp.addEventListener('keydown',function(e){if(e.key==='Enter')submit();});
  comp.appendChild(inp);comp.appendChild(post);
  box.appendChild(comp);
  var items=D.activity||[];
  if(items.length===0){box.appendChild(el('div','gcount','Quiet in here so far — say hi 👋'));return;}
  items.forEach(function(item){box.appendChild(feedItem(item,false));});
}

function renderAll(){
  renderTickets();
  renderRsvp();
  renderGuests();
  renderActivity();
}

document.addEventListener('click',function(){
  if(openPicker){openPicker.remove();openPicker=null;}
});

/* checkout return params */
(function(){
  var q=new URLSearchParams(window.location.search);
  var c=q.get('checkout');
  if(c==='success')toast('🎟️ Payment received — your tickets are in your inbox!');
  if(c==='canceled')toast('Checkout canceled — your spot is still open.');
  if(c)history.replaceState(null,'',window.location.pathname);
})();

renderAll();
if(TOKEN)refresh();
setInterval(function(){if(document.visibilityState==='visible')refresh();},30000);
})();
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
    "PRODID:-//Public Worship//Events OS//EN",
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
