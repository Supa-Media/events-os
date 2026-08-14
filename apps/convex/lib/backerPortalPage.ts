/**
 * The backer portal, server-rendered.
 *
 * Same shape as every other public page this backend serves (`givePage.ts`,
 * `publicLedgerPage.ts`, `contractPage.ts`): one HTML string, `BASE_CSS` from
 * `landingPageStyles.ts`, a small inline script talking to same-origin
 * `/api/backer/*`. No framework, no bundle, no Expo — a backer is not a staff
 * user and must not have to load the OS to read their own giving.
 *
 * ── EVERY RESPONSE IS PRIVATE AND UNCACHEABLE ──────────────────────────────
 * Set by the route in `http.ts`, not here, but stated here because it is a
 * property of what this file renders: these pages carry one person's giving
 * history and are reached with a session cookie. `no-store, private` is the
 * same discipline the `/finances` preview-token branch documents.
 *
 * ── THE COPY STATES, IT DOESN'T DEFEND ─────────────────────────────────────
 * Owner's note, 2026-08-14: a product surface says what it is. The reasoning
 * for what we do and don't show lives in `docs/plans/backer-portal.md`; none of
 * it appears on the page. "Who runs Brooklyn" is a heading, not an argument.
 */
import { formatCents } from "@events-os/shared";
import { BASE_CSS, FAVICON, FONTS } from "./landingPageStyles";
import { escapeHtml } from "./html";
import { BACKER_UNIT_CENTS } from "@events-os/shared";

const esc = escapeHtml;

/** Money, dates and counts a backer reads about themselves. */
export type PortalPledgeView = {
  pledgeId: string;
  amountCents: number;
  status: string;
  scopeLabel: string;
  startedAt?: number;
  currentPeriodEnd?: number;
  canceledAt?: number;
  isBacker: boolean;
  manageable: boolean;
  givePath: string | null;
};

export type PortalGiftView = {
  giftId: string;
  amountCents: number;
  receivedAt: number;
  methodLabel: string;
  scopeLabel: string;
  isRecurring: boolean;
  coveredFees: boolean;
  reversed: boolean;
};

export type PortalView = {
  email: string;
  name: string;
  isBacker: boolean;
  inGrace: boolean;
  pledges: PortalPledgeView[];
  lifetimeCents: number;
  giftCount: number;
  firstGiftAt?: number;
  history: PortalGiftView[];
  ladder: {
    scopeLabel: string;
    backerCount: number;
    nextAt: number | null;
    nextLabel: string | null;
    nextCommitment: string | null;
    rungs: {
      minBackers: number;
      label: string;
      commitment: string;
      reached: boolean;
    }[];
  } | null;
  upcoming: { name: string; startsAt: number; venue: string | null }[];
  /** Absolute base for share links — `siteUrl()`, resolved by the caller. */
  siteBase: string;
};

const DATE_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  month: "short",
  day: "numeric",
  year: "numeric",
});

const MONTH_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  month: "short",
  year: "numeric",
});

function day(ts: number): string {
  return DATE_FMT.format(new Date(ts));
}

/** The portal's own CSS, appended after `BASE_CSS` so it inherits the palette,
 *  the fonts and the warm background wash every public page shares. */
const PORTAL_CSS = `
main{max-width:640px;margin:0 auto;padding:22px 18px 80px;position:relative}
.topbar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 0 22px}
.wordmark{font-weight:700;font-size:12px;letter-spacing:.22em;color:var(--accent);text-transform:uppercase}
.topbar .who{font-size:13px;color:var(--muted)}
.topbar form{display:inline}
.linkbtn{font-size:13px;color:var(--muted);text-decoration:underline;text-underline-offset:3px;background:none;border:0;padding:0;cursor:pointer}
h1.big{font-family:'Corben',Georgia,serif;font-size:30px;line-height:1.15;margin:0 0 6px}
p.sub{color:var(--muted);font-size:14px;margin:0 0 22px}
.card{background:var(--raised);border:1px solid var(--border);border-radius:16px;padding:16px 18px;box-shadow:var(--shadow);margin:0 0 14px}
.card.sunken{background:var(--sunken);box-shadow:none}
.lbl{font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--faint);margin:0 0 8px}
.sect{font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin:26px 0 10px}
.amount{font-family:'Corben',Georgia,serif;font-size:38px;line-height:1;margin:0 0 4px}
.amount small{font-family:inherit;font-size:15px;font-weight:600;color:var(--muted)}
.city{font-size:17px;font-weight:700;margin:0 0 4px}
.meta{font-size:13px;color:var(--muted);margin:0 0 12px}
.pill{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:3px 11px;font-size:12px;font-weight:700}
.pill.ok{background:#EAF6F0;color:var(--success)}
.pill.bad{background:var(--accent-soft);color:var(--accent)}
.pill.neutral{background:var(--sunken);color:var(--muted)}
.btnrow{display:flex;gap:8px;flex-wrap:wrap}
.btn{display:inline-block;border-radius:999px;padding:11px 18px;font-size:14px;font-weight:700;text-decoration:none;border:1px solid transparent;cursor:pointer;font-family:inherit}
.btn.primary{background:var(--accent);color:#fff}
.btn.ghost{background:var(--raised);color:var(--ink);border-color:var(--border-strong);font-weight:600}
.btn[disabled]{opacity:.55;cursor:default}
.alert{background:var(--accent);color:#fff;border-radius:16px;padding:16px 18px;margin:0 0 16px;box-shadow:var(--shadow-pop)}
.alert h2{font-family:'Corben',Georgia,serif;font-size:20px;margin:0 0 8px}
.alert p{font-size:14px;line-height:1.55;color:rgba(255,255,255,.92);margin:0 0 12px}
.alert .btn{background:#fff;color:var(--accent-hover)}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:0 0 14px}
.stat{background:var(--raised);border:1px solid var(--border);border-radius:13px;padding:11px 12px}
.stat b{display:block;font-size:19px}
.stat span{font-size:11px;color:var(--muted)}
.bar{height:9px;border-radius:999px;background:var(--sunken);overflow:hidden;border:1px solid var(--border);margin:0 0 8px}
.bar i{display:block;height:100%;background:var(--accent);border-radius:999px}
.rung{display:flex;align-items:center;gap:9px;font-size:14px;padding:5px 0}
.rung .tick{flex:none;width:18px;height:18px;border-radius:50%;display:grid;place-items:center;font-size:10px;font-weight:800;border:1.5px solid var(--border-strong);color:var(--faint)}
.rung.done .tick{background:var(--success);border-color:var(--success);color:#fff}
.rung.next .tick{border-color:var(--accent);color:var(--accent)}
.rung.next b{color:var(--accent)}
.rung span{color:var(--muted);font-size:13px}
.row{display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border)}
.row:last-child{border-bottom:0}
.row .when{flex:none;width:64px;font-size:12px;color:var(--faint)}
.row .what{flex:1;min-width:0}
.row .what b{display:block;font-weight:600;font-size:14px}
.row .what span{font-size:12px;color:var(--muted)}
.row .val{font-weight:700;white-space:nowrap}
.row.reversed .val,.row.reversed .what b{text-decoration:line-through;color:var(--faint)}
.row.reversed .what span{color:var(--accent)}
.field{width:100%;background:var(--raised);border:1px solid var(--border-strong);border-radius:12px;padding:12px 14px;font-size:15px;margin:0 0 10px}
.share{display:flex;gap:8px;align-items:center}
.share input{flex:1;min-width:0;background:var(--sunken);border:1px solid var(--border);border-radius:10px;padding:9px 11px;font-size:13px;color:var(--muted)}
.fine{font-size:12px;color:var(--faint);line-height:1.55;margin:10px 0 0}
.fine a{color:var(--accent)}
.msg{font-size:13px;border-radius:12px;padding:10px 12px;margin:0 0 12px;display:none}
.msg.show{display:block}
.msg.err{background:var(--accent-soft);color:var(--accent-hover)}
.msg.ok{background:#EAF6F0;color:var(--success)}
footer{margin-top:34px;padding-top:16px;border-top:1px solid var(--border);font-size:12px;color:var(--faint);line-height:1.6}
footer a{color:var(--accent)}
@media(max-width:520px){.stats{grid-template-columns:1fr 1fr}}
`;

function shell(title: string, body: string, script = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)}</title>
${FONTS}${FAVICON}
<style>${BASE_CSS}${PORTAL_CSS}</style>
</head><body><main>${body}</main>${script ? `<script>${script}</script>` : ""}</body></html>`;
}

// ── Sign in ──────────────────────────────────────────────────────────────────

/**
 * The sign-in screen. Two states in one page — ask for an email, then ask for
 * the code — swapped by the inline script so a wrong code doesn't lose the
 * address the person just typed.
 */
export function renderBackerSignIn(): string {
  const body = `
<div class="topbar"><span class="wordmark">Public Worship</span></div>
<h1 class="big">See your giving.</h1>
<p class="sub">Enter the email you give with and we'll send you a six-digit code.</p>
<div id="msg" class="msg"></div>
<form id="emailForm">
  <input class="field" id="email" type="email" name="email" placeholder="you@example.com" autocomplete="email" required>
  <button class="btn primary" type="submit" id="emailBtn">Send me a code</button>
</form>
<form id="codeForm" style="display:none">
  <p class="sub" id="sentTo"></p>
  <input class="field" id="code" inputmode="numeric" pattern="[0-9]*" maxlength="6" placeholder="123456" autocomplete="one-time-code" required>
  <div class="btnrow">
    <button class="btn primary" type="submit" id="codeBtn">Verify</button>
    <button class="btn ghost" type="button" id="backBtn">Use a different email</button>
  </div>
</form>
<footer>
  Not giving yet? <a href="/give">See the cities</a> · Our books are public, every month → <a href="/finances">read them</a>
</footer>`;

  const script = `
(function(){
  var msg=document.getElementById('msg');
  function say(text,kind){msg.textContent=text;msg.className='msg show '+(kind||'err');}
  function clear(){msg.className='msg';}
  var emailForm=document.getElementById('emailForm');
  var codeForm=document.getElementById('codeForm');
  var emailInput=document.getElementById('email');
  var current='';
  emailForm.addEventListener('submit',function(e){
    e.preventDefault();clear();
    var btn=document.getElementById('emailBtn');btn.disabled=true;
    current=emailInput.value.trim();
    fetch('/api/backer/code',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:current})})
      .then(function(r){return r.json();})
      .then(function(d){
        btn.disabled=false;
        if(d.error){say(d.error);return;}
        emailForm.style.display='none';codeForm.style.display='block';
        document.getElementById('sentTo').textContent='If that email is on file, a code is on its way to '+current+'. It expires in 15 minutes.';
        document.getElementById('code').focus();
      })
      .catch(function(){btn.disabled=false;say('Something went wrong. Please try again.');});
  });
  codeForm.addEventListener('submit',function(e){
    e.preventDefault();clear();
    var btn=document.getElementById('codeBtn');btn.disabled=true;
    fetch('/api/backer/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:current,code:document.getElementById('code').value.trim()})})
      .then(function(r){return r.json();})
      .then(function(d){
        btn.disabled=false;
        if(d.error){say(d.error);return;}
        window.location.href='/backer';
      })
      .catch(function(){btn.disabled=false;say('Something went wrong. Please try again.');});
  });
  document.getElementById('backBtn').addEventListener('click',function(){
    clear();codeForm.style.display='none';emailForm.style.display='block';emailInput.focus();
  });
})();`;

  return shell("Backer portal — Public Worship", body, script);
}

// ── The portal ───────────────────────────────────────────────────────────────

const STATUS_PILL: Record<string, { text: string; cls: string }> = {
  active: { text: "Active", cls: "ok" },
  past_due: { text: "Past due", cls: "bad" },
  paused: { text: "On hold", cls: "neutral" },
  canceled: { text: "Ended", cls: "neutral" },
  incomplete: { text: "Not finished", cls: "neutral" },
};

/** One pledge card, in all five of its states. Each says what is true and what
 *  the reader can do about it; none of them is an error page. */
function pledgeCard(p: PortalPledgeView): string {
  const pill = STATUS_PILL[p.status] ?? { text: p.status, cls: "neutral" };
  const bits: string[] = [];
  if (p.startedAt) bits.push(`Since ${day(p.startedAt)}`);
  if (p.status === "active" && p.currentPeriodEnd) {
    bits.push(`Next charge ${day(p.currentPeriodEnd)}`);
  }
  if (p.status === "canceled" && p.canceledAt) {
    bits.push(`Ended ${day(p.canceledAt)}`);
  }

  let actions = "";
  if (p.status === "canceled") {
    actions = p.givePath
      ? `<div class="btnrow"><a class="btn primary" href="${esc(p.givePath)}">Start again</a></div>`
      : "";
  } else if (p.status === "incomplete") {
    actions = p.givePath
      ? `<div class="btnrow"><a class="btn primary" href="${esc(p.givePath)}">Finish signing up</a></div>`
      : "";
  } else if (!p.manageable) {
    actions = `<p class="fine">This monthly gift is billed on our old platform, so it can't be changed here. Reply to any email from us and we'll move it over.</p>`;
  } else {
    actions = `<div class="btnrow">
      <button class="btn primary" data-amount="${esc(p.pledgeId)}" data-current="${p.amountCents}">Change amount</button>
      <button class="btn ghost" data-portal="${esc(p.pledgeId)}" data-flow="card">Update card</button>
      <button class="btn ghost" data-portal="${esc(p.pledgeId)}" data-flow="cancel">Stop my monthly gift</button>
    </div>
    <form class="amountForm" id="amt-${esc(p.pledgeId)}" style="display:none;margin-top:12px">
      <input class="field" type="text" inputmode="decimal" name="amount" placeholder="${(p.amountCents / 100).toFixed(0)}" aria-label="New monthly amount in dollars">
      <div class="btnrow">
        <button class="btn primary" type="submit">Save new amount</button>
        <button class="btn ghost" type="button" data-cancel="${esc(p.pledgeId)}">Never mind</button>
      </div>
      ${
        p.amountCents >= BACKER_UNIT_CENTS
          ? `<p class="fine">Backers give ${formatCents(BACKER_UNIT_CENTS)} a month or more. To go below that, or to stop altogether, reply to any email from us.</p>`
          : `<p class="fine">Giving ${formatCents(BACKER_UNIT_CENTS)} a month or more makes you a backer of ${esc(p.scopeLabel)} and counts toward what it can commit to.</p>`
      }
    </form>`;
  }

  return `<div class="card">
  <div class="lbl">Your giving to ${esc(p.scopeLabel)}</div>
  <div class="amount">${esc(formatCents(p.amountCents))}<small>/month</small></div>
  <div class="city">${esc(p.scopeLabel)}</div>
  <div class="meta">${esc(bits.join(" · "))}</div>
  <span class="pill ${pill.cls}">${esc(pill.text)}</span>
  <div style="margin-top:14px">${actions}</div>
</div>`;
}

function pastDueBanner(p: PortalPledgeView): string {
  return `<div class="alert">
  <h2>Your last payment didn't go through.</h2>
  <p>Your giving to ${esc(p.scopeLabel)} is still on — the bank turned down the charge and it'll be tried again over the next few days. Updating your card fixes it straight away.</p>
  <button class="btn" data-portal="${esc(p.pledgeId)}" data-flow="card">Update your card</button>
</div>`;
}

function ladderCard(view: PortalView): string {
  const l = view.ladder;
  if (!l) return "";
  const top = l.rungs[l.rungs.length - 1]?.minBackers ?? l.backerCount;
  const pct = Math.max(0, Math.min(100, Math.round((l.backerCount / ((l.nextAt ?? top) || 1)) * 100)));
  const headline =
    l.nextAt === null
      ? `${esc(l.scopeLabel)} has cleared every milestone.`
      : `<b>${l.backerCount} of ${l.nextAt} backers</b> — ${l.nextAt - l.backerCount} more and ${esc(l.scopeLabel)} commits to ${esc(l.nextCommitment || l.nextLabel || "the next rung")}.`;
  const rungs = l.rungs
    .map((r) => {
      const cls = r.reached ? "done" : r.minBackers === l.nextAt ? "next" : "";
      const tick = r.reached ? "✓" : "";
      return `<div class="rung ${cls}"><span class="tick">${tick}</span><b>${r.minBackers} backers</b>${
        r.commitment ? `<span>· ${esc(r.commitment)}</span>` : ""
      }</div>`;
    })
    .join("");
  return `<div class="sect">What your backing unlocks</div>
<div class="card">
  <div class="bar"><i style="width:${pct}%"></i></div>
  <p style="font-size:14px;margin:0 0 8px">${headline}</p>
  ${rungs}
</div>`;
}

function upcomingCard(view: PortalView): string {
  if (view.upcoming.length === 0) return "";
  const rows = view.upcoming
    .map(
      (e) => `<div class="row">
    <div class="when">${esc(day(e.startsAt))}</div>
    <div class="what"><b>${esc(e.name)}</b>${e.venue ? `<span>${esc(e.venue)}</span>` : ""}</div>
  </div>`,
    )
    .join("");
  return `<div class="sect">Coming up</div><div class="card">${rows}</div>`;
}

function shareCard(view: PortalView): string {
  const city = view.pledges.find((p) => p.givePath);
  if (!city?.givePath) return "";
  const url = `${view.siteBase}${city.givePath}`;
  return `<div class="sect">Bring someone with you</div>
<div class="card sunken">
  <p style="font-size:14px;margin:0 0 10px">Share ${esc(city.scopeLabel)}'s page. Every backer moves the number.</p>
  <div class="share">
    <input id="shareUrl" value="${esc(url)}" readonly>
    <button class="btn ghost" id="copyBtn" type="button">Copy</button>
  </div>
</div>`;
}

function historyCard(view: PortalView): string {
  if (view.history.length === 0) {
    return `<div class="sect">Your giving</div>
<div class="card"><p style="font-size:14px;color:var(--muted);margin:0">Your first gift will show up here.</p></div>`;
  }
  const rows = view.history
    .map((g) => {
      const bits = [g.scopeLabel, g.isRecurring ? "Monthly gift" : g.methodLabel];
      if (g.coveredFees) bits.push("you covered the fee");
      const meta = g.reversed
        ? `Returned by your bank`
        : bits.filter(Boolean).join(" · ");
      return `<div class="row${g.reversed ? " reversed" : ""}">
    <div class="when">${esc(day(g.receivedAt))}</div>
    <div class="what"><b>${esc(g.isRecurring ? "Monthly gift" : "Gift")}</b><span>${esc(meta)}</span></div>
    <div class="val">${esc(formatCents(g.amountCents))}</div>
  </div>`;
    })
    .join("");
  return `<div class="sect">Your giving</div><div class="card">${rows}</div>`;
}

/** The signed-in portal. */
export function renderBackerPortal(view: PortalView): string {
  const first = view.name.trim().split(/\s+/)[0] || "there";
  const pastDue = view.pledges.find((p) => p.status === "past_due");
  const live = view.pledges.filter(
    (p) => p.status !== "canceled" && p.status !== "incomplete",
  );
  const shown = live.length > 0 ? live : view.pledges;

  const noPledge =
    view.pledges.length === 0
      ? `<div class="card">
    <div class="lbl">Your backing</div>
    <p style="font-size:15px;margin:0 0 12px">You've given to Public Worship, but you're not giving monthly yet.</p>
    <a class="btn primary" href="/give">Back a city</a>
  </div>`
      : "";

  const body = `
<div class="topbar">
  <span class="wordmark">Public Worship</span>
  <span class="who">${esc(view.email)} · <button class="linkbtn" id="signOut" type="button">Sign out</button></span>
</div>
<h1 class="big">Hi, ${esc(first)}.</h1>
<p class="sub">${
    view.isBacker
      ? "Thank you for backing this work every month."
      : "Thank you for giving to this work."
  }</p>
<div id="msg" class="msg"></div>
${pastDue ? pastDueBanner(pastDue) : ""}
${noPledge}
${shown.map(pledgeCard).join("")}
<div class="stats">
  <div class="stat"><b>${esc(formatCents(view.lifetimeCents))}</b><span>Given</span></div>
  <div class="stat"><b>${view.giftCount}</b><span>${view.giftCount === 1 ? "Gift" : "Gifts"}</span></div>
  <div class="stat"><b>${view.firstGiftAt ? esc(MONTH_FMT.format(new Date(view.firstGiftAt))) : "—"}</b><span>First gift</span></div>
</div>
${ladderCard(view)}
${upcomingCard(view)}
${shareCard(view)}
${historyCard(view)}
<footer>
  Our books are public, every month → <a href="/finances">read them</a><br>
  Questions? Reply to any email from us — a person reads it.
</footer>`;

  const script = `
(function(){
  var msg=document.getElementById('msg');
  function say(text,kind){msg.textContent=text;msg.className='msg show '+(kind||'err');window.scrollTo({top:0,behavior:'smooth'});}
  function post(path,body){
    return fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})}).then(function(r){return r.json();});
  }
  document.querySelectorAll('[data-portal]').forEach(function(btn){
    btn.addEventListener('click',function(){
      btn.disabled=true;
      post('/api/backer/billing-portal',{pledgeId:btn.getAttribute('data-portal'),flow:btn.getAttribute('data-flow')||'card'}).then(function(d){
        btn.disabled=false;
        if(d.error){say(d.error);return;}
        window.location.href=d.url;
      }).catch(function(){btn.disabled=false;say('Something went wrong. Please try again.');});
    });
  });
  document.querySelectorAll('[data-amount]').forEach(function(btn){
    btn.addEventListener('click',function(){
      var form=document.getElementById('amt-'+btn.getAttribute('data-amount'));
      if(form)form.style.display=form.style.display==='none'?'block':'none';
    });
  });
  document.querySelectorAll('[data-cancel]').forEach(function(btn){
    btn.addEventListener('click',function(){
      var form=document.getElementById('amt-'+btn.getAttribute('data-cancel'));
      if(form)form.style.display='none';
    });
  });
  document.querySelectorAll('.amountForm').forEach(function(form){
    form.addEventListener('submit',function(e){
      e.preventDefault();
      var pledgeId=form.id.replace('amt-','');
      var raw=form.querySelector('input[name=amount]').value;
      post('/api/backer/amount',{pledgeId:pledgeId,amount:raw}).then(function(d){
        if(d.error){say(d.error);return;}
        window.location.reload();
      }).catch(function(){say('Something went wrong. Please try again.');});
    });
  });
  var copyBtn=document.getElementById('copyBtn');
  if(copyBtn){
    copyBtn.addEventListener('click',function(){
      var input=document.getElementById('shareUrl');
      input.select();
      try{document.execCommand('copy');copyBtn.textContent='Copied';}catch(err){}
      if(navigator.clipboard){navigator.clipboard.writeText(input.value).then(function(){copyBtn.textContent='Copied';},function(){});}
    });
  }
  document.getElementById('signOut').addEventListener('click',function(){
    post('/api/backer/signout').then(function(){window.location.href='/backer';});
  });
})();`;

  return shell("Your giving — Public Worship", body, script);
}
