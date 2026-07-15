/**
 * Public, accountless reimbursement page — server-rendered HTML served by
 * http.ts at /reimburse/<chapterSlug>[?token=]. Mirrors the ticketing landing
 * page: self-contained (inline CSS + vanilla JS), talks to the same-origin
 * /api/reimburse/* httpActions (see reimburseApiRoutes.ts). No login — the
 * chapter slug scopes the form; a request's secret token scopes its status.
 *
 * Visual spec: public-worship reimburse.html — cream paper, dark-red ink,
 * Corben display type. Two states:
 *   - FORM   (no token): renderReimburseForm — payee, purpose, a line-items
 *            grid with per-line category + per-line receipt, pay-to bank last4,
 *            notes, live total, submit / ask-for-pre-approval.
 *   - STATUS (token):    renderReimburseStatus — the "after submitting" timeline
 *            (Submitted → Under review → Approved → Paid by ACH) + summary.
 *
 * The client script deliberately avoids template literals so it can be
 * assembled inside one. Every interpolated value is HTML-escaped.
 */
import { escapeHtml as esc } from "./html";
import { FONTS, FAVICON } from "./landingPageStyles";

// ── Types the render fns accept (structural — the orchestrator passes query
//    results straight through) ────────────────────────────────────────────────

/** Chapter display data for the form (from api.lib.reimburseApiRoutes.chapterForReimburse). */
export type ReimburseChapterView = {
  slug: string;
  name: string;
  categories: Array<{
    id: string;
    name: string;
    fundId: string;
    fundName: string | null;
  }>;
};

/** Claimant status view (from api.reimbursements.getPublicReimbursement). */
export type ReimburseStatusView = {
  reference: string;
  status: string;
  statusLabel: string;
  payeeName: string;
  totalCents: number;
  approvedCents?: number | null;
  lines: Array<{
    description: string;
    amountCents: number;
    category: string | null;
    hasReceipt: boolean;
  }>;
  submittedAt: number;
  timeline: Array<{
    step: string;
    label: string;
    state: "done" | "now" | "todo";
  }>;
};

// ── Formatting ────────────────────────────────────────────────────────────────

function money(cents: number): string {
  const v = (cents || 0) / 100;
  return `$${v.toFixed(v % 1 === 0 ? 2 : 2)}`;
}

function fmtWhen(ts: number): string {
  return new Date(ts).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  });
}

// ── Static presentation ───────────────────────────────────────────────────────

/** Inline SVG symbol library (the subset the page references via <use>). */
const SYMBOLS = `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
<symbol id="i-receipt" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></symbol>
<symbol id="i-upload" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></symbol>
<symbol id="i-plus" viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></symbol>
<symbol id="i-x" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></symbol>
<symbol id="i-check" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></symbol>
<symbol id="i-clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></symbol>
<symbol id="i-send" viewBox="0 0 24 24"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></symbol>
<symbol id="i-shield" viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></symbol>
<symbol id="i-link" viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></symbol>
<symbol id="i-bank" viewBox="0 0 24 24"><line x1="3" y1="22" x2="21" y2="22"/><line x1="6" y1="18" x2="6" y2="11"/><line x1="10" y1="18" x2="10" y2="11"/><line x1="14" y1="18" x2="14" y2="11"/><line x1="18" y1="18" x2="18" y2="11"/><polygon points="12 2 20 7 4 7"/></symbol>
<symbol id="i-check-circle" viewBox="0 0 24 24"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></symbol>
<symbol id="i-calendar" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></symbol>
</defs></svg>`;

/** Reimburse-page stylesheet — the palette/tokens from reimburse.html. */
const REIMBURSE_CSS = `
:root{
  --surface:#FDF6F6;--raised:#FFFFFF;--sunken:#FAEEE9;--ink:#210909;--muted:#7A5A5A;--faint:#A98C8C;
  --border:#EFE0DC;--border-strong:#E4CFCB;--accent:#D23B3A;--accent-hover:#922424;--accent-soft:#FBE8E8;
  --success:#2F7D5B;--success-bg:#EAF6F0;--warn:#B4761A;--warn-bg:#FBF1DE;--info:#4A6BC0;--info-bg:#D6E5F2;
  --lavender:#C9A8E0;--shadow-card:0 1px 2px rgba(33,9,9,.04),0 1px 3px rgba(33,9,9,.03);
  --shadow-raised:0 4px 16px rgba(33,9,9,.07);--r-sm:6px;--r-md:10px;--r-lg:14px;
}
*{box-sizing:border-box;}html,body{margin:0;padding:0;}
body{background:var(--surface);color:var(--ink);font-family:"DM Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:15px;line-height:22px;-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums;min-height:100vh;}
h1,h2,h3{margin:0;}p{margin:0;}button{font-family:inherit;cursor:pointer;}
.serif{font-family:"Corben",Georgia,serif;font-weight:700;letter-spacing:-.01em;}
.money{font-variant-numeric:tabular-nums;font-weight:600;}
.muted{color:var(--muted);}.faint{color:var(--faint);}.ink{color:var(--ink);}.small{font-size:13px;}.xs{font-size:12px;}.semi{font-weight:600;}.bold{font-weight:700;}
.row{display:flex;align-items:center;gap:10px;}.between{justify-content:space-between;}.wrap{flex-wrap:wrap;}.col{display:flex;flex-direction:column;}
.gap6{gap:6px;}.gap8{gap:8px;}.gap12{gap:12px;}.gap16{gap:16px;}.mt4{margin-top:4px;}.mt8{margin-top:8px;}.mt12{margin-top:12px;}.mt16{margin-top:16px;}.mt24{margin-top:24px;}
.pubbar{background:var(--raised);border-bottom:1px solid var(--border);}
.pubbar-in{max-width:900px;margin:0 auto;padding:14px 24px;display:flex;align-items:center;gap:12px;}
.mark{height:30px;width:30px;border-radius:var(--r-md);background:var(--accent);display:flex;align-items:center;justify-content:center;flex:0 0 30px;}
.mark svg{width:16px;height:16px;stroke:#fff;}
.brand-t{font-family:"Corben",serif;font-weight:700;font-size:16px;}
.brand-t .os{color:var(--accent);}
.wrap-main{max-width:900px;margin:0 auto;padding:22px 24px 64px;}
.card{background:var(--raised);border:1px solid var(--border);border-radius:var(--r-lg);box-shadow:var(--shadow-card);padding:22px;}
.hero{text-align:center;padding:8px 0 20px;}
.hero .ic{height:46px;width:46px;border-radius:999px;background:var(--accent-soft);display:inline-flex;align-items:center;justify-content:center;margin-bottom:10px;}
.hero .ic svg{width:22px;height:22px;stroke:var(--accent);}
.hero h1{font-family:"Corben",serif;font-weight:700;font-size:27px;line-height:32px;}
.hero p{color:var(--muted);margin-top:8px;font-size:14px;}
.field{display:flex;flex-direction:column;gap:6px;}
.fl{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);}
.forminput{border:1px solid var(--border-strong);background:var(--raised);border-radius:var(--r-md);padding:10px 12px;font-size:14px;color:var(--ink);width:100%;font-family:inherit;}
.forminput::placeholder{color:var(--faint);}
select.forminput{appearance:none;-webkit-appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%23A98C8C' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 8px center;padding-right:30px;}
.two{display:grid;grid-template-columns:1fr 1fr;gap:14px;}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;border-radius:var(--r-md);font-weight:600;font-size:15px;padding:11px 18px;border:1px solid transparent;line-height:1;}
.btn svg{width:16px;height:16px;stroke:currentColor;}
.btn.sm{padding:7px 12px;font-size:13px;}.btn.sm svg{width:14px;height:14px;}
.btn:disabled{opacity:.55;cursor:default;}
.btn-primary{background:var(--accent);color:#fff;}.btn-primary:hover{background:var(--accent-hover);}
.btn-secondary{background:var(--raised);color:var(--ink);border-color:var(--border-strong);}.btn-secondary:hover{background:var(--sunken);}
.btn-ghost{background:transparent;color:var(--accent);}.btn-ghost:hover{background:var(--sunken);}
.badge{display:inline-flex;align-items:center;gap:4px;border-radius:var(--r-sm);padding:2px 8px;font-size:12px;line-height:16px;font-weight:600;}
.badge svg{width:11px;height:11px;stroke:currentColor;}
.badge.success{background:var(--success-bg);color:var(--success);}.badge.warn{background:var(--warn-bg);color:var(--warn);}
.badge.info{background:var(--info-bg);color:var(--info);}.badge.neutral{background:var(--sunken);color:var(--muted);}.badge.accent{background:var(--accent-soft);color:var(--accent);}
.li-head{display:grid;grid-template-columns:1fr 150px 96px 34px;gap:8px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);padding:0 2px;}
.li-row{display:grid;grid-template-columns:1fr 150px 96px 34px;gap:8px;align-items:center;}
.li-receipt{grid-column:1 / -1;}
.dropzone{border:1px dashed var(--border-strong);border-radius:var(--r-md);background:var(--sunken);padding:10px 12px;display:flex;align-items:center;gap:10px;color:var(--muted);font-size:13px;cursor:pointer;width:100%;text-align:left;}
.dropzone svg{width:17px;height:17px;stroke:var(--muted);flex:0 0 17px;}
.receipt-chip{display:inline-flex;align-items:center;gap:6px;background:var(--success-bg);color:var(--success);border-radius:var(--r-sm);padding:3px 8px;font-size:12px;font-weight:600;}
.receipt-chip svg{width:12px;height:12px;stroke:currentColor;}
.receipt-chip button{background:none;border:none;color:var(--success);display:inline-flex;padding:0;margin-left:2px;}
.divider{height:1px;background:var(--border);margin:18px 0;}
.callout{border-left:3px solid var(--warn);background:var(--warn-bg);border-radius:0 var(--r-md) var(--r-md) 0;padding:12px 14px;font-size:13px;color:#6b4a12;}
.callout.info{border-color:var(--info);background:var(--info-bg);color:#2e447e;}
.callout.ok{border-color:var(--success);background:var(--success-bg);color:#1e5a41;}
.callout.err{border-color:var(--accent);background:var(--accent-soft);color:var(--accent-hover);}
.timeline{display:flex;flex-direction:column;}
.tl{display:flex;gap:14px;}
.tl .tll{display:flex;flex-direction:column;align-items:center;flex:0 0 26px;}
.tl .tld{width:26px;height:26px;border-radius:999px;border:2px solid var(--border-strong);background:var(--raised);display:flex;align-items:center;justify-content:center;color:var(--faint);}
.tl .tld svg{width:13px;height:13px;stroke:currentColor;}
.tl.done .tld{background:var(--success-bg);border-color:var(--success);color:var(--success);}
.tl.now .tld{background:var(--accent-soft);border-color:var(--accent);color:var(--accent);}
.tl .tlbar{width:2px;flex:1;background:var(--border);margin:2px 0;min-height:22px;}
.tl.done .tlbar{background:var(--success);}
.tl:last-child .tlbar{display:none;}
.tl .tlc{padding-bottom:18px;}
.tl .tlt{font-weight:600;font-size:14px;}
.tl .tls{font-size:13px;color:var(--muted);}
.summ{border:1px solid var(--border);border-radius:var(--r-md);overflow:hidden;}
.summ .sr{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 14px;border-bottom:1px solid var(--border);}
.summ .sr:last-child{border-bottom:none;background:var(--sunken);}
.hide{display:none;}
.footnote{text-align:center;color:var(--faint);font-size:12px;margin-top:24px;}
@media (max-width:640px){.two{grid-template-columns:1fr;}.li-head,.li-row{grid-template-columns:1fr 96px 34px;}.li-head span:nth-child(2),.li-row .catcell{display:none;}}
`;

const ICON_ATTRS = `fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`;

/** Common <head> so both states share fonts, favicon, and styles. */
function head(title: string): string {
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#FDF6F6">
<title>${esc(title)}</title>
${FAVICON}${FONTS}
<style>${REIMBURSE_CSS}</style>`;
}

/** The shared brand bar. */
function pubbar(chapterName: string): string {
  return `<div class="pubbar"><div class="pubbar-in">
  <span class="mark"><svg ${ICON_ATTRS}><use href="#i-calendar"/></svg></span>
  <span class="brand-t">${esc(chapterName)} <span class="os">reimbursements</span></span>
</div></div>`;
}

// ── FORM state ────────────────────────────────────────────────────────────────

/**
 * The blank submission form for a chapter. The client script populates the
 * line-items grid (starting with one row), tracks receipt files in memory,
 * computes the live total, and on submit calls /api/reimburse/submit, uploads
 * each line's receipt, then redirects to ?token=<token> (the status state).
 */
export function renderReimburseForm(chapter: ReimburseChapterView): string {
  const init = JSON.stringify({
    slug: chapter.slug,
    name: chapter.name,
    categories: chapter.categories,
  }).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="en"><head>${head(`Get reimbursed — ${chapter.name}`)}</head>
<body>
${SYMBOLS}
${pubbar(chapter.name)}
<div class="wrap-main">
  <div class="hero">
    <span class="ic"><svg ${ICON_ATTRS}><use href="#i-receipt"/></svg></span>
    <h1>Get reimbursed</h1>
    <p>${esc(chapter.name)} — tell us what you spent and we'll pay you back by direct deposit once a finance manager approves.</p>
  </div>

  <div class="card">
    <div class="col gap16">
      <div class="two">
        <div class="field"><span class="fl">Your name</span><input id="f_name" class="forminput" autocomplete="name" placeholder="First and last name"></div>
        <div class="field"><span class="fl">Email</span><input id="f_email" class="forminput" type="email" autocomplete="email" placeholder="you@example.com"></div>
      </div>

      <div class="field">
        <span class="fl">What's this for?</span>
        <input id="f_purpose" class="forminput" placeholder="Event or project (e.g. Worship with Strangers · July)">
        <span class="xs faint">Tell finance where it goes. Pick a category per line below and the fund fills in automatically.</span>
      </div>

      <div class="field">
        <span class="fl">Line items</span>
        <div class="li-head"><span>Description</span><span class="catcell">Category</span><span style="text-align:right">Amount</span><span></span></div>
        <div class="col gap12" id="lines"></div>
        <button id="addline" class="btn btn-ghost sm mt4" style="align-self:flex-start"><svg ${ICON_ATTRS}><use href="#i-plus"/></svg>Add line item</button>
      </div>

      <div class="field">
        <span class="fl">Pay to — your bank</span>
        <input id="f_bank" class="forminput" inputmode="numeric" maxlength="4" placeholder="Last 4 digits (e.g. 3391)">
        <span class="xs faint">We only store the last four digits.</span>
      </div>

      <div class="field"><span class="fl">Notes (optional)</span><textarea id="f_notes" class="forminput" rows="2" placeholder="Anything the finance team should know…"></textarea></div>

      <div class="callout"><b>Was this pre-approved?</b> If it wasn't already in the budget, tap "Ask for pre-approval" instead — surprises can be sent back.</div>

      <div class="callout err hide" id="formerr"></div>

      <div class="divider" style="margin:4px 0"></div>
      <div class="row between wrap gap12">
        <div><span class="xs faint">Total to be reimbursed</span><div class="serif" id="total" style="font-size:24px">$0.00</div></div>
        <div class="row gap8 wrap">
          <button id="preapprove" class="btn btn-secondary"><svg ${ICON_ATTRS}><use href="#i-clock"/></svg>Ask for pre-approval</button>
          <button id="submit" class="btn btn-primary"><svg ${ICON_ATTRS}><use href="#i-send"/></svg>Submit request</button>
        </div>
      </div>
    </div>
  </div>
  <div class="footnote">Your info is used only to process this reimbursement. Powered by Chapter&nbsp;OS.</div>
</div>
<script>window.__REIMB__=${init};</script>
<script>${REIMBURSE_FORM_SCRIPT}</script>
</body></html>`;
}

// ── STATUS state ──────────────────────────────────────────────────────────────

/** The "after submitting" status timeline + summary, keyed by the secret token. */
export function renderReimburseStatus(
  view: ReimburseStatusView,
  chapterName: string,
  token: string,
  slug: string,
): string {
  const firstName = view.payeeName.trim().split(/\s+/)[0] || view.payeeName;
  const receiptsMissing = view.lines.filter((l) => !l.hasReceipt).length;

  const timeline = view.timeline
    .map((t) => {
      const cls = t.state === "done" ? " done" : t.state === "now" ? " now" : "";
      const icon =
        t.step === "paid"
          ? "i-bank"
          : t.step === "under_review"
            ? "i-clock"
            : "i-check";
      const nowBadge =
        t.state === "now"
          ? ` <span class="badge accent" style="margin-left:4px">now</span>`
          : "";
      return `<div class="tl${cls}"><div class="tll"><span class="tld"><svg ${ICON_ATTRS}><use href="#${icon}"/></svg></span><span class="tlbar"></span></div><div class="tlc"><div class="tlt">${esc(t.label)}${nowBadge}</div><div class="tls">${esc(stepSub(t.step, view))}</div></div></div>`;
    })
    .join("");

  const rows = view.lines
    .map((l, i) => {
      const meta = [l.category, l.hasReceipt ? "receipt attached" : "receipt needed"]
        .filter(Boolean)
        .join(" · ");
      const addBtn = l.hasReceipt
        ? ""
        : `<button class="btn btn-ghost sm addreceipt" data-line="${i}" style="padding:4px 8px"><svg ${ICON_ATTRS}><use href="#i-upload"/></svg>Add</button>`;
      return `<div class="sr"><div><div class="semi small">${esc(l.description)}</div><div class="xs faint">${esc(meta)}</div></div><div class="row gap8">${addBtn}<span class="money small">${money(l.amountCents)}</span></div></div>`;
    })
    .join("");

  const receiptCallout =
    receiptsMissing === 0
      ? `<div class="callout ok mt8"><svg width="13" height="13" fill="none" stroke="var(--success)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px"><use href="#i-check"/></svg> A receipt is attached to every line, so nothing's blocking review.</div>`
      : `<div class="callout mt8">${receiptsMissing} line${receiptsMissing === 1 ? "" : "s"} still need${receiptsMissing === 1 ? "s" : ""} a receipt — add ${receiptsMissing === 1 ? "it" : "them"} below to keep review moving.</div>`;

  const cfg = JSON.stringify({ token, slug }).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="en"><head>${head(`Reimbursement ${view.reference} — ${chapterName}`)}</head>
<body>
${SYMBOLS}
${pubbar(chapterName)}
<div class="wrap-main">
  <div class="hero">
    <span class="ic" style="background:var(--success-bg)"><svg fill="none" stroke="var(--success)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="#i-check-circle"/></svg></span>
    <h1>Request submitted</h1>
    <p>Thanks, ${esc(firstName)}. Reference <b class="ink">#${esc(view.reference)}</b>. We'll email you at each step — reopen this link anytime to check status.</p>
  </div>

  <div class="two" style="align-items:start;gap:16px">
    <div class="card">
      <span class="fl">Status</span>
      <div class="timeline mt12">${timeline}</div>
      ${receiptCallout}
    </div>

    <div class="col gap16">
      <div class="card">
        <span class="fl">What you submitted</span>
        <div class="summ mt12">
          ${rows}
          <div class="sr"><span class="semi small">Total</span><span class="money">${money(view.totalCents)}</span></div>
        </div>
        ${
          view.approvedCents != null && view.approvedCents !== view.totalCents
            ? `<div class="xs faint mt8">Approved so far: <b class="ink">${money(view.approvedCents)}</b></div>`
            : ""
        }
      </div>
      <div class="card">
        <div class="row between"><span class="semi small">Need to change something?</span></div>
        <p class="xs muted mt8">You can add a receipt to any line above, or start a new request until this one is approved.</p>
        <div class="row gap8 mt12"><a class="btn btn-ghost sm" href="/reimburse/${encodeURIComponent(slug)}">New request</a></div>
      </div>
    </div>
  </div>
  <div class="footnote">Questions? Reply to any of our emails. Powered by Chapter&nbsp;OS.</div>
</div>
<script>window.__RCFG__=${cfg};</script>
<script>${REIMBURSE_STATUS_SCRIPT}</script>
</body></html>`;
}

/** Per-step subtitle for the status timeline. */
function stepSub(step: string, view: ReimburseStatusView): string {
  const receipts = view.lines.filter((l) => l.hasReceipt).length;
  switch (step) {
    case "submitted":
      return `${fmtWhen(view.submittedAt)} · ${view.lines.length} line item${view.lines.length === 1 ? "" : "s"} · ${receipts} receipt${receipts === 1 ? "" : "s"} attached`;
    case "under_review":
      return "With the finance manager — checking it lands in the right budget";
    case "approved":
      return view.approvedCents != null
        ? `Approved for ${money(view.approvedCents)}`
        : "You'll get an email the moment it's approved";
    case "paid":
      return "Direct deposit — usually 1–2 business days after approval";
    default:
      return "";
  }
}

/** Friendly 404 for an unknown chapter slug or unknown token. */
export function renderReimburseNotFound(): string {
  return `<!doctype html>
<html lang="en"><head>${head("Reimbursement not found")}</head>
<body>
${SYMBOLS}
<div class="wrap-main" style="min-height:70vh;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:10px">
  <span class="ic" style="height:56px;width:56px;border-radius:999px;background:var(--accent-soft);display:inline-flex;align-items:center;justify-content:center"><svg width="26" height="26" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="#i-receipt"/></svg></span>
  <h1 class="serif" style="font-size:28px">Nothing here</h1>
  <p class="muted" style="max-width:340px">This reimbursement link isn't valid. Check the address, or ask whoever sent it for a fresh one.</p>
</div>
</body></html>`;
}

// ── Client scripts (vanilla JS, no template literals) ─────────────────────────

/** Form-state browser script: line-item grid, receipts, total, submit. */
const REIMBURSE_FORM_SCRIPT = `
(function(){
"use strict";
var R=window.__REIMB__;
var CATS=R.categories||[];

function $(id){return document.getElementById(id);}
function el(tag,cls){var n=document.createElement(tag);if(cls)n.className=cls;return n;}
function svg(id,attrs){return '<svg '+(attrs||'fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"')+'><use href="#'+id+'"/></svg>';}
function centsOf(s){var t=(''+s).replace(/[^0-9.]/g,'');var n=parseFloat(t);if(!isFinite(n)||n<0)return 0;return Math.round(n*100);}
function money(c){return '$'+((c||0)/100).toFixed(2);}
function showErr(msg){var e=$('formerr');e.textContent=msg;e.classList.remove('hide');window.scrollTo({top:document.body.scrollHeight,behavior:'smooth'});}
function clearErr(){$('formerr').classList.add('hide');}

/* ── line rows ── */
function addLine(){
  var box=$('lines');
  var line=el('div','line');
  var row=el('div','li-row');
  var desc=el('input','forminput desc');desc.placeholder='What did you buy?';
  var cat=el('select','forminput catcell cat');
  var opt0=el('option');opt0.value='';opt0.textContent='Category…';cat.appendChild(opt0);
  CATS.forEach(function(c){var o=el('option');o.value=c.id;o.setAttribute('data-fund',c.fundId);o.textContent=c.name;cat.appendChild(o);});
  var amt=el('input','forminput amt');amt.style.textAlign='right';amt.inputMode='decimal';amt.placeholder='$0.00';
  amt.addEventListener('input',recalc);
  var rm=el('button','btn btn-ghost sm rm');rm.style.padding='6px';rm.innerHTML=svg('i-x');
  rm.addEventListener('click',function(){line.remove();recalc();});
  row.appendChild(desc);row.appendChild(cat);row.appendChild(amt);row.appendChild(rm);
  var rc=el('div','li-receipt mt8');
  var file=el('input');file.type='file';file.accept='image/*,application/pdf';file.className='rfile';file.style.display='none';
  var drop=el('button','dropzone');drop.type='button';drop.innerHTML=svg('i-upload')+'Add a receipt for this line — photo or PDF';
  drop.addEventListener('click',function(){file.click();});
  file.addEventListener('change',function(){renderReceipt(rc,file,drop);});
  rc.appendChild(file);rc.appendChild(drop);
  line.appendChild(row);line.appendChild(rc);
  box.appendChild(line);
  recalc();
}
function renderReceipt(rc,file,drop){
  var old=rc.querySelector('.receipt-chip');if(old)old.remove();
  if(file.files&&file.files[0]){
    drop.style.display='none';
    var chip=el('span','receipt-chip');
    chip.innerHTML=svg('i-check')+'<span></span>';
    chip.querySelector('span').textContent=file.files[0].name;
    var x=el('button');x.type='button';x.innerHTML=svg('i-x');
    x.addEventListener('click',function(){file.value='';chip.remove();drop.style.display='';});
    chip.appendChild(x);
    rc.appendChild(chip);
  }else{drop.style.display='';}
}
function eachLine(fn){var ls=document.querySelectorAll('#lines .line');for(var i=0;i<ls.length;i++)fn(ls[i],i);}
function recalc(){
  var total=0;
  eachLine(function(l){total+=centsOf(l.querySelector('.amt').value);});
  $('total').textContent=money(total);
}

/* ── api ── */
function api(path,body){
  return fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
    .then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||'Something went wrong');return j;});});
}
function uploadFile(token,file){
  return api('/api/reimburse/upload-url',{token:token}).then(function(r){
    return fetch(r.uploadUrl,{method:'POST',headers:{'Content-Type':file.type||'application/octet-stream'},body:file})
      .then(function(res){if(!res.ok)throw new Error('Upload failed');return res.json();})
      .then(function(j){return j.storageId;});
  });
}

/* ── submit ── */
function collect(){
  var lines=[];var files=[];
  eachLine(function(l){
    var desc=l.querySelector('.desc').value.trim();
    var amt=centsOf(l.querySelector('.amt').value);
    if(!desc&&amt===0)return; /* skip blank rows */
    var sel=l.querySelector('.cat');
    var opt=sel.options[sel.selectedIndex];
    var line={description:desc,amountCents:amt};
    if(sel.value){line.categoryId=sel.value;var f=opt&&opt.getAttribute('data-fund');if(f)line.fundId=f;}
    lines.push(line);
    var fi=l.querySelector('.rfile');
    files.push(fi&&fi.files&&fi.files[0]?fi.files[0]:null);
  });
  return {lines:lines,files:files};
}
function submit(preApproval){
  clearErr();
  var name=$('f_name').value.trim();
  if(!name)return showErr('Please add your name.');
  var email=$('f_email').value.trim();
  var c=collect();
  if(c.lines.length===0)return showErr('Add at least one line item with an amount.');
  for(var i=0;i<c.lines.length;i++){if(c.lines[i].amountCents<=0)return showErr('Every line needs an amount greater than $0.');if(!c.lines[i].description)return showErr('Every line needs a description.');}
  var bank=$('f_bank').value.replace(/[^0-9]/g,'').slice(-4);
  var payload={
    chapterSlug:R.slug,
    payeeName:name,
    payeeEmail:email||undefined,
    purpose:$('f_purpose').value.trim()||undefined,
    bankAccountLast4:bank||undefined,
    requestPreApproval:!!preApproval,
    lines:c.lines
  };
  var notes=$('f_notes').value.trim();
  if(notes)payload.purpose=(payload.purpose?payload.purpose+' — ':'')+notes;
  var btnP=$('submit'),btnA=$('preapprove');
  btnP.disabled=true;btnA.disabled=true;
  api('/api/reimburse/submit',payload).then(function(res){
    var token=res.token;
    /* upload each line's receipt (best-effort), matched to lines by order */
    return getLineIds(token).then(function(ids){
      var chain=Promise.resolve();
      c.files.forEach(function(file,i){
        if(!file||!ids||!ids[i])return;
        var lineId=ids[i].lineId;
        chain=chain.then(function(){
          return uploadFile(token,file).then(function(storageId){
            return api('/api/reimburse/attach-receipt',{token:token,lineId:lineId,receiptStorageId:storageId});
          }).catch(function(){/* a failed receipt shouldn't block the request */});
        });
      });
      return chain.then(function(){return token;});
    });
  }).then(function(token){
    window.location.href=window.location.pathname+'?token='+encodeURIComponent(token);
  }).catch(function(err){
    btnP.disabled=false;btnA.disabled=false;
    showErr(err.message||'Something went wrong. Please try again.');
  });
}
function getLineIds(token){
  return fetch('/api/reimburse/lines?token='+encodeURIComponent(token))
    .then(function(r){return r.ok?r.json():null;}).catch(function(){return null;});
}

/* ── wire up ── */
$('addline').addEventListener('click',function(){addLine();});
$('submit').addEventListener('click',function(){submit(false);});
$('preapprove').addEventListener('click',function(){submit(true);});
addLine();
})();
`;

/** Status-state browser script: attach a receipt to a line missing one. */
const REIMBURSE_STATUS_SCRIPT = `
(function(){
"use strict";
var CFG=window.__RCFG__;
var TOKEN=CFG.token;
function api(path,body){
  return fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
    .then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||'Something went wrong');return j;});});
}
function getLineIds(){
  return fetch('/api/reimburse/lines?token='+encodeURIComponent(TOKEN))
    .then(function(r){return r.ok?r.json():null;}).catch(function(){return null;});
}
function uploadFile(file){
  return api('/api/reimburse/upload-url',{token:TOKEN}).then(function(r){
    return fetch(r.uploadUrl,{method:'POST',headers:{'Content-Type':file.type||'application/octet-stream'},body:file})
      .then(function(res){if(!res.ok)throw new Error('Upload failed');return res.json();})
      .then(function(j){return j.storageId;});
  });
}
var picker=document.createElement('input');
picker.type='file';picker.accept='image/*,application/pdf';picker.style.display='none';
document.body.appendChild(picker);
var pendingIndex=null;
picker.addEventListener('change',function(){
  if(pendingIndex==null||!picker.files||!picker.files[0])return;
  var idx=pendingIndex;var file=picker.files[0];
  getLineIds().then(function(ids){
    if(!ids||!ids[idx])throw new Error('Could not find that line.');
    return uploadFile(file).then(function(storageId){
      return api('/api/reimburse/attach-receipt',{token:TOKEN,lineId:ids[idx].lineId,receiptStorageId:storageId});
    });
  }).then(function(){window.location.reload();})
    .catch(function(e){alert(e.message||'Could not add the receipt.');});
  picker.value='';
});
document.querySelectorAll('.addreceipt').forEach(function(b){
  b.addEventListener('click',function(){pendingIndex=parseInt(b.getAttribute('data-line'),10);picker.click();});
});
})();
`;
