/**
 * THE PARTNER PORTAL, server-rendered — one sponsorship agreement on a page a
 * church's executive pastor can open from a text message, read, sign, and pay.
 *
 * Served by http.ts at `/partner/<token>`. Self-contained (inline CSS + vanilla
 * JS), same cream/dark-red palette as `contractPage.ts` and `reimbursePage.ts`
 * so the org's three public money surfaces are visibly one product, talking to
 * same-origin `/api/partner/*` httpActions (see `sponsorPortalApiRoutes.ts`).
 * No login: the token in the URL is the whole of the authority.
 *
 * ── THE ARGUMENT FOR THIS DESIGN ────────────────────────────────────────────
 * A partnership proposal is normally a PDF and an invoice: two documents, two
 * moments, and a gap between them where deals die. The founder asked for one
 * place with "the details in, like, a summarize form" plus "a partnership
 * agreement that they can sign digitally", and the honest reading of that is:
 * the document and the payment are the same page.
 *
 * So this page is ONE COLUMN, read top to bottom, and it is deliberately not a
 * dashboard:
 *
 *   1. WHO AND WHAT — the partner's own name, the deal's name, and the money in
 *      one line. Somebody forwarded this link; they need to know in two seconds
 *      whether it is theirs.
 *   2. WHERE IT STANDS — a single progress bar covering in-kind credit and cash
 *      together, because a partner who donated $2,500 of production has covered
 *      most of a $3,500 spot and a page that showed "$0 paid" would be lying to
 *      them about their own generosity.
 *   3. THE PROPOSAL — free-form prose, then what they receive, then what we
 *      deliver. Their side first: this is a page asking somebody for money, and
 *      leading with our obligations is what makes that bearable.
 *   4. THE TERMS — verbatim, read-only, in a bordered card that looks like a
 *      document rather than like copy.
 *   5. THE SIGNATURE — one panel, typed name, and an explicit sentence about
 *      what signing means.
 *   6. THE PAYMENT — which only appears AFTER the signature, because the terms
 *      are what the money is for.
 *
 * ── FOUR THINGS THIS PAGE IS CAREFUL ABOUT ──────────────────────────────────
 *
 * 1. IT SHOWS THE FEE, ALWAYS. Bank transfer is presented as the recommended
 *    rail with its real number ("$5.00 processing fee, capped") rather than as
 *    the only option with no explanation. A partner who understands why we ask
 *    for ACH will use ACH; one who meets an unexplained restriction will email
 *    and ask, which costs the desk more than the fee did.
 *
 * 2. IT NEVER SHOWS OUR NOTES ABOUT THEM. `dueDiligenceNotes`, the pipeline
 *    stage, the internal owner, and every other agreement are unrepresentable
 *    here — `publicByToken`'s projection does not carry them. That is enforced
 *    in the query, not by this file remembering.
 *
 * 3. EVERY INTERPOLATED VALUE IS ESCAPED. The proposal body is parsed by the
 *    shared `parseSponsorProse` into plain strings and each is run through
 *    `esc`. There is no inline markup grammar and no raw-HTML path, so a pasted
 *    `<script>` renders as the characters somebody typed.
 *
 * 4. MOBILE IS THE PRIMARY CASE. Nothing is fixed-width, the money grid
 *    collapses at 640px, and the sign/pay buttons are full-width thumb targets.
 *
 * The client scripts deliberately avoid template literals so they can be
 * assembled inside one.
 */
import {
  SPONSOR_RAIL_BLURBS,
  SPONSOR_RAIL_LABELS,
  type SponsorInKindCredit,
  type SponsorPaymentRail,
  type SponsorPortalState,
  parseSponsorProse,
  sponsorDocKind,
} from "@events-os/shared";
import { escapeHtml as esc } from "./html";
import { FONTS, FAVICON } from "./landingPageStyles";

// ── The view this page renders ───────────────────────────────────────────────
// Structural on purpose: http.ts passes `sponsorPortal.publicByToken`'s result
// straight through, so this describes the SHAPE rather than re-declaring the
// branded id types the query returns. Same posture as `ContractPublicView`.

export type SponsorPortalView = {
  orgName: string;
  title: string;
  summary: string | null;
  benefits: string[];
  commitments: string[];
  terms: string | null;
  termsVersion: number;
  events: { name: string; eventDate: number }[];
  contactName: string | null;
  documents: {
    label: string;
    fileName: string | null;
    contentType: string | null;
    sizeBytes: number | null;
    href: string;
  }[];
  amountCents: number;
  inKindCredits: SponsorInKindCredit[];
  balance: {
    committedCents: number;
    inKindCents: number;
    paidCents: number;
    coveredCents: number;
    balanceCents: number;
    percentCovered: number;
    settled: boolean;
  };
  pendingCents: number;
  payableCents: number;
  state: SponsorPortalState;
  rails: { rail: SponsorPaymentRail; feeCents: number; chargeCents: number }[];
  signed: { name: string; title: string | null; at: number } | null;
  payments: { amountCents: number; receivedAt: number; method: string }[];
};

// ── Formatting ───────────────────────────────────────────────────────────────

function money(cents: number): string {
  return `$${((cents || 0) / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Whole dollars — for the headline figure, where cents are noise. */
function moneyShort(cents: number): string {
  return (cents || 0) % 100 === 0
    ? `$${((cents || 0) / 100).toLocaleString("en-US")}`
    : money(cents);
}

function fmtDay(ts: number): string {
  return new Date(ts).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "America/New_York",
  });
}

// ── Static presentation ──────────────────────────────────────────────────────

const SYMBOLS = `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
<symbol id="i-hand" viewBox="0 0 24 24"><path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2"/><path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2"/><path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/></symbol>
<symbol id="i-check" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></symbol>
<symbol id="i-check-circle" viewBox="0 0 24 24"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></symbol>
<symbol id="i-pen" viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></symbol>
<symbol id="i-bank" viewBox="0 0 24 24"><line x1="3" y1="22" x2="21" y2="22"/><line x1="6" y1="18" x2="6" y2="11"/><line x1="10" y1="18" x2="10" y2="11"/><line x1="14" y1="18" x2="14" y2="11"/><line x1="18" y1="18" x2="18" y2="11"/><polygon points="12 2 20 7 4 7"/></symbol>
<symbol id="i-card" viewBox="0 0 24 24"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></symbol>
<symbol id="i-gift" viewBox="0 0 24 24"><polyline points="20 12 20 22 4 22 4 12"/><rect x="2" y="7" width="20" height="5"/><line x1="12" y1="22" x2="12" y2="7"/><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"/><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/></symbol>
<symbol id="i-calendar" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></symbol>
<symbol id="i-clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></symbol>
<symbol id="i-lock" viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></symbol>
<symbol id="i-alert" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></symbol>
<symbol id="i-file" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></symbol>
<symbol id="i-image" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></symbol>
<symbol id="i-download" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></symbol>
</defs></svg>`;

const ICON = `fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`;

/**
 * Portal stylesheet. The palette and primitives are lifted from
 * `CONTRACT_CSS` verbatim so the org's public money surfaces are visibly the
 * same product; everything below the `── portal-only ──` marker exists for this
 * page's own problems (the coverage bar, the rail cards, the document card).
 */
const PORTAL_CSS = `
:root{
  --surface:#FDF6F6;--raised:#FFFFFF;--sunken:#FAEEE9;--ink:#210909;--muted:#7A5A5A;--faint:#A98C8C;
  --border:#EFE0DC;--border-strong:#E4CFCB;--accent:#D23B3A;--accent-hover:#922424;--accent-soft:#FBE8E8;
  --success:#2F7D5B;--success-bg:#EAF6F0;--warn:#B4761A;--warn-bg:#FBF1DE;--info:#4A6BC0;--info-bg:#D6E5F2;
  --shadow-card:0 1px 2px rgba(33,9,9,.04),0 1px 3px rgba(33,9,9,.03);
  --r-sm:6px;--r-md:10px;--r-lg:14px;
}
*{box-sizing:border-box;}html,body{margin:0;padding:0;}
body{background:var(--surface);color:var(--ink);font-family:"DM Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:15px;line-height:22px;-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums;min-height:100vh;}
h1,h2,h3{margin:0;}p{margin:0;}button{font-family:inherit;cursor:pointer;}
ul{margin:0;padding:0;list-style:none;}
.serif{font-family:"Corben",Georgia,serif;font-weight:700;letter-spacing:-.01em;}
.muted{color:var(--muted);}.faint{color:var(--faint);}
.small{font-size:13px;line-height:19px;}.xs{font-size:12px;line-height:17px;}
.semi{font-weight:600;}.bold{font-weight:700;}
.row{display:flex;align-items:center;gap:10px;}.between{justify-content:space-between;}.wrap{flex-wrap:wrap;}
.col{display:flex;flex-direction:column;}
.gap4{gap:4px;}.gap6{gap:6px;}.gap8{gap:8px;}.gap12{gap:12px;}
.mt4{margin-top:4px;}.mt8{margin-top:8px;}.mt12{margin-top:12px;}.mt16{margin-top:16px;}.mt24{margin-top:24px;}
.pubbar{background:var(--raised);border-bottom:1px solid var(--border);}
.pubbar-in{max-width:720px;margin:0 auto;padding:14px 20px;display:flex;align-items:center;gap:12px;}
.mark{height:30px;width:30px;border-radius:var(--r-md);background:var(--accent);display:flex;align-items:center;justify-content:center;flex:0 0 30px;}
.mark svg{width:16px;height:16px;stroke:#fff;}
.brand-t{font-family:"Corben",serif;font-weight:700;font-size:16px;}
.brand-t .os{color:var(--accent);}
.wrap-main{max-width:720px;margin:0 auto;padding:26px 20px 72px;}
.card{background:var(--raised);border:1px solid var(--border);border-radius:var(--r-lg);box-shadow:var(--shadow-card);padding:20px;}
.sec{margin-top:26px;}
.sec-h{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:10px;}
.badge{display:inline-flex;align-items:center;gap:4px;border-radius:var(--r-sm);padding:2px 8px;font-size:12px;line-height:16px;font-weight:600;}
.badge svg{width:11px;height:11px;stroke:currentColor;}
.badge.success{background:var(--success-bg);color:var(--success);}.badge.warn{background:var(--warn-bg);color:var(--warn);}
.badge.info{background:var(--info-bg);color:var(--info);}.badge.neutral{background:var(--sunken);color:var(--muted);}
.badge.accent{background:var(--accent-soft);color:var(--accent);}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;border-radius:var(--r-md);font-weight:600;font-size:15px;padding:13px 18px;border:1px solid transparent;line-height:1;width:100%;}
.btn svg{width:16px;height:16px;stroke:currentColor;}
.btn:disabled{opacity:.55;cursor:default;}
.btn-primary{background:var(--accent);color:#fff;}.btn-primary:hover:not(:disabled){background:var(--accent-hover);}
.field{display:flex;flex-direction:column;gap:6px;margin-bottom:14px;}
.fl{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);}
.forminput{border:1px solid var(--border-strong);background:var(--raised);border-radius:var(--r-md);padding:11px 12px;font-size:16px;line-height:22px;color:var(--ink);width:100%;font-family:inherit;}
.forminput::placeholder{color:var(--faint);}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;}
.forminput:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft);}
.two{display:grid;grid-template-columns:1fr 1fr;gap:12px;}
.callout{border-left:3px solid var(--warn);background:var(--warn-bg);border-radius:0 var(--r-md) var(--r-md) 0;padding:12px 14px;font-size:13px;line-height:19px;color:#6b4a12;}
.callout.info{border-color:var(--info);background:var(--info-bg);color:#2e447e;}
.callout.ok{border-color:var(--success);background:var(--success-bg);color:#1e5a41;}
.callout.err{border-color:var(--accent);background:var(--accent-soft);color:var(--accent-hover);}
.divider{height:1px;background:var(--border);margin:18px 0;}

/* ── portal-only ─────────────────────────────────────────────────────────── */
.hero{padding:6px 0 4px;}
.hero .eyebrow{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--accent);}
.hero h1{font-family:"Corben",serif;font-weight:700;font-size:30px;line-height:36px;margin-top:8px;}
.hero .who{color:var(--muted);margin-top:8px;font-size:14px;}
/* The money headline. Big, because it is the number the reader came for and
   burying it under prose is how a proposal gets skimmed and then forgotten. */
.figure{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;}
.figure .big{font-family:"Corben",serif;font-size:34px;line-height:38px;font-weight:700;}
.figure .cap{font-size:13px;color:var(--muted);}
.bar{height:10px;border-radius:999px;background:var(--sunken);overflow:hidden;margin-top:14px;display:flex;}
.bar .seg-kind{background:var(--info);}
.bar .seg-cash{background:var(--success);}
.legend{display:flex;flex-wrap:wrap;gap:14px;margin-top:10px;font-size:12px;color:var(--muted);}
.legend .dot{height:8px;width:8px;border-radius:999px;display:inline-block;margin-right:6px;}
.moneygrid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:18px;}
.moneygrid .cell{border:1px solid var(--border);border-radius:var(--r-md);padding:11px 12px;}
.moneygrid .k{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);}
.moneygrid .v{font-size:17px;font-weight:700;margin-top:3px;}
/* The proposal body. Reads like a document, not like app copy. */
.prose h2{font-family:"Corben",serif;font-size:18px;line-height:24px;margin:20px 0 8px;}
.prose h2:first-child{margin-top:0;}
.prose p{margin:0 0 12px;color:var(--ink);overflow-wrap:anywhere;}
.prose ul{margin:0 0 14px;padding:0;}
.prose li{position:relative;padding-left:20px;margin-bottom:7px;color:var(--ink);overflow-wrap:anywhere;}
.prose li:before{content:"";position:absolute;left:4px;top:9px;height:5px;width:5px;border-radius:999px;background:var(--accent);}
.ticks li{position:relative;padding-left:26px;margin-bottom:9px;overflow-wrap:anywhere;}
.ticks li svg{position:absolute;left:0;top:3px;width:15px;height:15px;stroke:var(--success);}
.ticks.ours li svg{stroke:var(--accent);}
/* Terms: a bordered, slightly sunken block so it reads as a document rather
   than as more page copy. Scrolls inside itself when long. */
.doc{background:var(--sunken);border:1px solid var(--border-strong);border-radius:var(--r-md);padding:16px 18px;max-height:420px;overflow-y:auto;}
.doc p,.doc li{font-size:14px;line-height:21px;}
.rails{display:flex;flex-direction:column;gap:10px;}
.rail{display:flex;gap:12px;align-items:flex-start;border:1px solid var(--border-strong);border-radius:var(--r-md);padding:13px 14px;cursor:pointer;}
.rail:has(input:checked){border-color:var(--accent);background:var(--accent-soft);}
.rail input{margin-top:3px;accent-color:var(--accent);height:17px;width:17px;flex:0 0 17px;}
.rail .rt{display:flex;align-items:center;gap:7px;font-weight:600;}
.rail .rt svg{width:15px;height:15px;stroke:var(--muted);}
.rail .rb{font-size:12.5px;line-height:18px;color:var(--muted);margin-top:3px;}
.rail .fee{font-size:12.5px;font-weight:600;color:var(--success);margin-top:5px;}
.agree{display:flex;gap:11px;align-items:flex-start;font-size:13.5px;line-height:20px;color:var(--muted);}
.agree input{margin-top:2px;accent-color:var(--accent);height:17px;width:17px;flex:0 0 17px;}
/* Coverage rows — a date the partner is standing behind, not a table row. */
.covers{display:flex;flex-direction:column;gap:12px;}
.cover{display:flex;gap:12px;align-items:flex-start;}
.cover .ic{height:34px;width:34px;border-radius:var(--r-md);background:var(--accent-soft);display:flex;align-items:center;justify-content:center;flex:0 0 34px;}
.cover .ic svg{width:16px;height:16px;stroke:var(--accent);}
.cover .cn{display:block;font-weight:600;font-size:15px;line-height:21px;overflow-wrap:anywhere;}
.cover .cd{display:block;font-size:13px;line-height:19px;color:var(--muted);margin-top:1px;}
/* Document rows — a real download link, styled as a tappable card. */
.docs{display:flex;flex-direction:column;gap:10px;}
.doc-row{display:flex;gap:12px;align-items:center;text-decoration:none;color:var(--ink);border:1px solid var(--border-strong);border-radius:var(--r-md);padding:12px 14px;background:var(--raised);}
.doc-row:hover{border-color:var(--accent);background:var(--sunken);}
.doc-row .ic{height:34px;width:34px;border-radius:var(--r-sm);background:var(--accent-soft);display:flex;align-items:center;justify-content:center;flex:0 0 34px;}
.doc-row .ic svg{width:16px;height:16px;stroke:var(--accent);}
.doc-row .dt{flex:1;min-width:0;}
.doc-row .dn{display:block;font-weight:600;font-size:14px;line-height:20px;overflow-wrap:anywhere;}
.doc-row .df{display:block;font-size:12px;line-height:17px;color:var(--muted);overflow-wrap:anywhere;}
.doc-row .dl{flex:0 0 auto;}
.doc-row .dl svg{width:17px;height:17px;stroke:var(--muted);}
.paylist{border:1px solid var(--border);border-radius:var(--r-md);overflow:hidden;}
.paylist .pr{display:flex;justify-content:space-between;gap:12px;padding:11px 14px;border-bottom:1px solid var(--border);}
.paylist .pr:last-child{border-bottom:none;}
.stamp{display:flex;gap:12px;align-items:flex-start;}
.stamp .ic{height:38px;width:38px;border-radius:999px;background:var(--success-bg);display:flex;align-items:center;justify-content:center;flex:0 0 38px;}
.stamp .ic svg{height:19px;width:19px;stroke:var(--success);}
.sig{font-family:"Corben",Georgia,serif;font-size:22px;line-height:28px;}
.foot{margin-top:34px;text-align:center;font-size:12px;color:var(--faint);}
@media (max-width:640px){
  .moneygrid{grid-template-columns:1fr;}
  .two{grid-template-columns:1fr;}
  .hero h1{font-size:25px;line-height:31px;}
  .figure .big{font-size:29px;line-height:33px;}
  .card{padding:16px 14px;}
  .wrap-main{padding:20px 14px 64px;}
}
`;

/** Common <head> so every state shares fonts, favicon, and styles. */
function head(title: string): string {
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#FDF6F6">
<title>${esc(title)}</title>
${FAVICON}${FONTS}
<style>${PORTAL_CSS}</style>`;
}

function pubbar(): string {
  return `<div class="pubbar"><div class="pubbar-in">
  <span class="mark"><svg ${ICON}><use href="#i-hand"/></svg></span>
  <span class="brand-t">Public Worship <span class="os">partnership</span></span>
</div></div>`;
}

// ── Pieces ───────────────────────────────────────────────────────────────────

const STATE_BADGE: Record<SponsorPortalState, { tone: string; label: string; icon: string }> = {
  unissued: { tone: "neutral", label: "Draft", icon: "i-lock" },
  awaiting_signature: { tone: "warn", label: "Awaiting your signature", icon: "i-pen" },
  awaiting_payment: { tone: "info", label: "Signed", icon: "i-check" },
  payment_clearing: { tone: "info", label: "Transfer clearing", icon: "i-clock" },
  settled: { tone: "success", label: "Complete", icon: "i-check-circle" },
};

/**
 * The coverage bar — in-kind and cash as two segments of one line.
 *
 * TWO SEGMENTS, NOT TWO BARS. A partner whose production proposal was valued at
 * $2,500 against a $3,500 spot has covered 71% of it, and the single most
 * demoralising thing this page could do is show them a "paid: $0" bar. One bar,
 * two colours, one legend that names both.
 */
function coverageBar(v: SponsorPortalView): string {
  const total = Math.max(1, v.balance.committedCents);
  const kindPct = Math.min(100, (v.balance.inKindCents / total) * 100);
  const cashPct = Math.min(100 - kindPct, (v.balance.paidCents / total) * 100);
  const legend: string[] = [];
  if (v.balance.inKindCents > 0) {
    legend.push(
      `<span><span class="dot" style="background:var(--info)"></span>In-kind ${money(v.balance.inKindCents)}</span>`,
    );
  }
  if (v.balance.paidCents > 0) {
    legend.push(
      `<span><span class="dot" style="background:var(--success)"></span>Paid ${money(v.balance.paidCents)}</span>`,
    );
  }
  if (v.balance.balanceCents > 0) {
    legend.push(
      `<span><span class="dot" style="background:var(--sunken);border:1px solid var(--border-strong)"></span>Remaining ${money(v.balance.balanceCents)}</span>`,
    );
  }
  return `<div class="bar" role="img" aria-label="${v.balance.percentCovered}% covered">
  <div class="seg-kind" style="width:${kindPct.toFixed(2)}%"></div>
  <div class="seg-cash" style="width:${cashPct.toFixed(2)}%"></div>
</div>
${legend.length ? `<div class="legend">${legend.join("")}</div>` : ""}`;
}

/** The money card: headline figure, the bar, and the three sub-totals. */
function moneyCard(v: SponsorPortalView): string {
  const badge = STATE_BADGE[v.state];
  const clearing =
    v.pendingCents > 0
      ? `<div class="callout info mt16"><strong>${money(v.pendingCents)} is on its way.</strong> Bank transfers take about four business days to clear. We'll email you the moment it lands — there's no need to send it again.</div>`
      : "";
  return `<div class="card">
  <div class="row between wrap gap8">
    <div class="figure">
      <span class="big">${moneyShort(v.balance.committedCents)}</span>
      <span class="cap">total partnership</span>
    </div>
    <span class="badge ${badge.tone}"><svg ${ICON}><use href="#${badge.icon}"/></svg>${esc(badge.label)}</span>
  </div>
  ${coverageBar(v)}
  <div class="moneygrid">
    <div class="cell"><div class="k">In-kind credit</div><div class="v">${money(v.balance.inKindCents)}</div></div>
    <div class="cell"><div class="k">Received</div><div class="v">${money(v.balance.paidCents)}</div></div>
    <div class="cell"><div class="k">Remaining</div><div class="v" style="color:${v.balance.balanceCents > 0 ? "var(--accent)" : "var(--success)"}">${money(v.balance.balanceCents)}</div></div>
  </div>
  ${clearing}
</div>`;
}

/** The in-kind lines, listed rather than lumped — the proposal promises the
 *  partner that "every line of the review is shown to you". */
function inKindSection(v: SponsorPortalView): string {
  if (!v.inKindCredits.length) return "";
  const rows = v.inKindCredits
    .map(
      (c) => `<div class="pr">
      <div><div class="semi">${esc(c.label)}</div>${c.note ? `<div class="xs muted mt4">${esc(c.note)}</div>` : ""}</div>
      <div class="semi">${money(c.amountCents)}</div>
    </div>`,
    )
    .join("");
  return `<section class="sec">
  <div class="sec-h">What you're carrying in kind</div>
  <div class="paylist">${rows}</div>
  <p class="xs muted mt8">Valued against our own itemized budget lines — what we would otherwise have paid a vendor for the same work. It counts toward the partnership exactly like cash.</p>
</section>`;
}

/** The free-form body, parsed by the SHARED grammar and escaped block by
 *  block. There is no path here that emits caller HTML. */
function proseHtml(source: string | null): string {
  if (!source) return "";
  return parseSponsorProse(source)
    .map((block) => {
      if (block.kind === "heading") return `<h2>${esc(block.text)}</h2>`;
      if (block.kind === "paragraph") return `<p>${esc(block.text)}</p>`;
      return `<ul>${block.items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`;
    })
    .join("");
}

function listSection(title: string, items: string[], ours: boolean): string {
  if (!items.length) return "";
  return `<section class="sec">
  <div class="sec-h">${esc(title)}</div>
  <div class="card"><ul class="ticks${ours ? " ours" : ""}">${items
    .map((i) => `<li><svg ${ICON}><use href="#i-check"/></svg>${esc(i)}</li>`)
    .join("")}</ul></div>
</section>`;
}

/**
 * WHAT THIS PARTNERSHIP COVERS — the events, by name and date.
 *
 * ── WHY THIS SITS DIRECTLY UNDER THE MONEY ──────────────────────────────────
 * A partnership is routinely more than one date. The Ignite agreement stands
 * behind Love Thy Neighbor on Sept 26 AND the hosted Worship with Strangers on
 * Sept 18, and "which days am I actually standing behind?" is the second
 * question a partner asks after "how much?" — not a footnote after the terms.
 * So it renders as a titled card immediately below the figure, with each date
 * spelled out, rather than as a thin "attached to" list near the bottom.
 *
 * Renders nothing when no event is attached, which is correct rather than a
 * gap: a season or annual agreement genuinely covers no single date, and an
 * empty "covers:" heading would read as something missing.
 */
function eventsSection(v: SponsorPortalView): string {
  if (!v.events.length) return "";
  const plural = v.events.length === 1 ? "gathering" : "gatherings";
  return `<section class="sec">
  <div class="sec-h">What this partnership covers</div>
  <div class="card">
    <p class="small muted" style="margin-bottom:14px">${v.events.length} ${plural}, carried by this one agreement.</p>
    <div class="covers">${v.events
      .map(
        (e) => `<div class="cover">
        <span class="ic"><svg ${ICON}><use href="#i-calendar"/></svg></span>
        <span>
          <span class="cn">${esc(e.name)}</span>
          <span class="cd">${fmtDay(e.eventDate)}</span>
        </span>
      </div>`,
      )
      .join("")}</div>
  </div>
</section>`;
}

function termsSection(v: SponsorPortalView): string {
  if (!v.terms) return "";
  return `<section class="sec">
  <div class="sec-h">Terms</div>
  <div class="doc prose">${proseHtml(v.terms)}</div>
</section>`;
}

/**
 * SHARED DOCUMENTS — the paperwork behind the agreement, downloadable.
 *
 * The founder's case: a partner covering production themselves has an agreed
 * proposal, and that PDF is the evidence behind the in-kind credit on this
 * page. It renders after the terms — supporting material for what was agreed,
 * not a headline — and only the documents the desk marked shared reach here at
 * all (the query filters; this renderer never sees an internal one).
 *
 * Each row is a real download link to the token-scoped route, which re-checks
 * "shared" on every request. `rel="noopener"` on the new tab, and the label is
 * the desk's words with the filename beneath it.
 */
function documentsSection(v: SponsorPortalView): string {
  if (!v.documents.length) return "";
  const rows = v.documents
    .map((d) => {
      const kind = sponsorDocKind(d.contentType ?? undefined);
      const icon = kind === "pdf" ? "i-file" : kind === "image" ? "i-image" : "i-file";
      const size = d.sizeBytes != null ? ` · ${fmtSize(d.sizeBytes)}` : "";
      return `<a class="doc-row" href="${esc(d.href)}" target="_blank" rel="noopener">
      <span class="ic"><svg ${ICON}><use href="#${icon}"/></svg></span>
      <span class="dt">
        <span class="dn">${esc(d.label)}</span>
        <span class="df">${esc(d.fileName ?? "Open")}${size}</span>
      </span>
      <span class="dl"><svg ${ICON}><use href="#i-download"/></svg></span>
    </a>`;
    })
    .join("");
  return `<section class="sec">
  <div class="sec-h">Documents</div>
  <div class="docs">${rows}</div>
</section>`;
}

/** A human file size, coarse on purpose — nobody reads a byte count. */
function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The signature panel.
 *
 * SAYS WHAT SIGNING MEANS, in a sentence, above the button rather than in fine
 * print below it. This is the moment the page asks somebody to commit an
 * organisation's money; burying that in a checkbox label would be the cheap
 * version of consent.
 */
function signSection(v: SponsorPortalView): string {
  if (v.signed) {
    return `<section class="sec">
  <div class="sec-h">Signed</div>
  <div class="card"><div class="stamp">
    <span class="ic"><svg ${ICON}><use href="#i-check-circle"/></svg></span>
    <div>
      <div class="sig">${esc(v.signed.name)}</div>
      <div class="small muted mt4">${v.signed.title ? `${esc(v.signed.title)} · ` : ""}${fmtDay(v.signed.at)}</div>
    </div>
  </div></div>
</section>`;
  }
  return `<section class="sec" id="sign">
  <div class="sec-h">Sign the agreement</div>
  <div class="card">
    <p class="small muted" style="margin-bottom:16px">Typing your name below is your signature. It records that ${esc(
      v.orgName,
    )} agrees to the terms on this page as they read today, for ${money(v.balance.committedCents)}.</p>
    <div class="two">
      <div class="field"><label class="fl" for="sg-name">Your full name</label><input class="forminput" id="sg-name" autocomplete="name" placeholder="Jane Adeyemi"></div>
      <div class="field"><label class="fl" for="sg-title">Your role</label><input class="forminput" id="sg-title" autocomplete="organization-title" placeholder="Executive Pastor"></div>
    </div>
    <div class="field"><label class="fl" for="sg-email">Email for your copy</label><input class="forminput" id="sg-email" type="email" autocomplete="email" placeholder="you@church.org"></div>
    <label class="agree" style="margin-bottom:16px"><input type="checkbox" id="sg-agree"><span>I'm authorised to sign for ${esc(
      v.orgName,
    )}, and we agree to the terms above.</span></label>
    <div id="sg-err" class="callout err" style="display:none;margin-bottom:14px"></div>
    <button class="btn btn-primary" id="sg-btn"><svg ${ICON}><use href="#i-pen"/></svg>Sign the agreement</button>
  </div>
</section>`;
}

/**
 * The payment panel — only rendered once the current terms are signed.
 *
 * ── WHY THE FEE IS ON THE PAGE ──────────────────────────────────────────────
 * Each rail shows what it actually costs. Bank transfer's line reads "$5.00
 * processing fee (capped)" against a card's ~$101 on a $3,500 spot, and that
 * number is what makes ACH feel like the partner's own choice rather than our
 * restriction. Most agreements only ever offer the one rail (see
 * `DEFAULT_SPONSOR_RAILS`), in which case this renders as a single card that
 * explains itself instead of a radio group of one.
 */
function paySection(v: SponsorPortalView): string {
  if (!v.signed) return "";
  // Everything owed is already in flight — offer no second payment, just say
  // it's clearing. This is the page half of `preparePayment`'s guard: the
  // balance is still full during an ACH window, and a pay form here is how a
  // partner pays twice.
  if (!v.balance.settled && v.payableCents <= 0 && v.pendingCents > 0) {
    return `<section class="sec">
  <div class="sec-h">Payment</div>
  <div class="card"><div class="stamp">
    <span class="ic"><svg ${ICON}><use href="#i-clock"/></svg></span>
    <div>
      <div class="semi">${money(v.pendingCents)} is on its way.</div>
      <div class="small muted mt4">Your bank transfer is still clearing — about four business days. There's nothing to pay right now, and no need to send it again. We'll email you the moment it lands.</div>
    </div>
  </div></div>
</section>`;
  }
  if (v.balance.settled) {
    return `<section class="sec">
  <div class="card"><div class="stamp">
    <span class="ic"><svg ${ICON}><use href="#i-check-circle"/></svg></span>
    <div>
      <div class="semi">Fully covered — thank you.</div>
      <div class="small muted mt4">Nothing is outstanding on this partnership.</div>
    </div>
  </div></div>
</section>`;
  }
  if (!v.rails.length) {
    return `<section class="sec">
  <div class="sec-h">Paying</div>
  <div class="card"><p class="small muted">We'll invoice you directly for ${money(
    v.balance.balanceCents,
  )} — reply to your contact and we'll send it over.</p></div>
</section>`;
  }

  const rails = v.rails
    .map((r, i) => {
      const icon = r.rail === "ach" ? "i-bank" : "i-card";
      const fee =
        r.feeCents > 0
          ? `<div class="fee">+ ${money(r.feeCents)} processing fee if you cover it</div>`
          : "";
      return `<label class="rail">
      <input type="radio" name="rail" value="${r.rail}"${i === 0 ? " checked" : ""}>
      <span>
        <span class="rt"><svg ${ICON}><use href="#${icon}"/></svg>${esc(SPONSOR_RAIL_LABELS[r.rail])}</span>
        <span class="rb">${esc(SPONSOR_RAIL_BLURBS[r.rail])}</span>
        ${fee}
      </span>
    </label>`;
    })
    .join("");

  const onlyBank = v.rails.length === 1 && v.rails[0].rail === "ach";
  const note = onlyBank
    ? `<div class="callout info" style="margin-bottom:16px">This partnership settles by bank transfer. On an amount this size a card would hand about 3% of it to the processor; a bank transfer's fee is capped at $5.00, so every dollar we can keep goes to the event.</div>`
    : "";

  return `<section class="sec" id="pay">
  <div class="sec-h">Pay the balance</div>
  <div class="card">
    ${note}
    <div class="field">
      <label class="fl" for="py-amount">Amount</label>
      <input class="forminput" id="py-amount" inputmode="decimal" value="${(v.payableCents / 100).toFixed(2)}">
      <span class="xs muted">${money(v.payableCents)} to pay${v.pendingCents > 0 ? ` (a further ${money(v.pendingCents)} is already clearing)` : ""}. Pay it all, or send part of it now.</span>
    </div>
    <div class="rails" style="margin-bottom:14px">${rails}</div>
    <label class="agree" style="margin-bottom:16px"><input type="checkbox" id="py-fee" checked><span>Add the processing fee on top so the full amount reaches the mission.</span></label>
    <div id="py-err" class="callout err" style="display:none;margin-bottom:14px"></div>
    <button class="btn btn-primary" id="py-btn"><svg ${ICON}><use href="#i-bank"/></svg>Continue to payment</button>
    <p class="xs muted mt12" style="text-align:center">Payments are handled by Stripe. We never see your bank or card details.</p>
  </div>
</section>`;
}

function paymentsSection(v: SponsorPortalView): string {
  if (!v.payments.length) return "";
  return `<section class="sec">
  <div class="sec-h">Payments received</div>
  <div class="paylist">${v.payments
    .map(
      (p) =>
        `<div class="pr"><div class="semi">${money(p.amountCents)}</div><div class="small muted">${fmtDay(p.receivedAt)}</div></div>`,
    )
    .join("")}</div>
</section>`;
}

// ── The page ─────────────────────────────────────────────────────────────────

/** The whole portal, in one column. */
export function renderSponsorPortal(v: SponsorPortalView, token: string): string {
  const paidBanner = `<div id="paid-banner" class="callout ok" style="display:none;margin-bottom:18px"></div>`;
  return `<!doctype html>
<html lang="en"><head>${head(`${v.title} — ${v.orgName}`)}</head>
<body>
${SYMBOLS}
${pubbar()}
<main class="wrap-main">
  ${paidBanner}
  <div class="hero">
    <div class="eyebrow">Partnership agreement</div>
    <h1>${esc(v.title)}</h1>
    <p class="who">Prepared for ${esc(v.orgName)}${v.contactName ? ` · ${esc(v.contactName)}` : ""}</p>
  </div>
  <div class="mt16">${moneyCard(v)}</div>

  ${eventsSection(v)}
  ${v.summary ? `<section class="sec"><div class="card prose">${proseHtml(v.summary)}</div></section>` : ""}
  ${listSection("What you receive", v.benefits, false)}
  ${listSection("What we deliver", v.commitments, true)}
  ${inKindSection(v)}
  ${termsSection(v)}
  ${documentsSection(v)}
  ${signSection(v)}
  ${paySection(v)}
  ${paymentsSection(v)}

  <p class="foot">Public Worship · New York<br>Questions about anything on this page? Reply to the email this link came from.</p>
</main>
<script>${portalScript(token)}</script>
</body></html>`;
}

/** Friendly 404 for an unknown, revoked, or mistyped token. Deliberately says
 *  the same thing for all three: a guessed token and a revoked one must be
 *  indistinguishable from outside. */
export function renderSponsorPortalNotFound(): string {
  return `<!doctype html>
<html lang="en"><head>${head("Partnership link not found")}</head>
<body>
${SYMBOLS}
<main class="wrap-main" style="min-height:70vh;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:10px">
  <span style="height:56px;width:56px;border-radius:999px;background:var(--accent-soft);display:inline-flex;align-items:center;justify-content:center"><svg width="26" height="26" ${ICON} stroke="var(--accent)"><use href="#i-hand"/></svg></span>
  <h1 class="serif" style="font-size:28px">Nothing here</h1>
  <p class="muted" style="max-width:360px">This partnership link isn't active. Check the address, or ask whoever sent it for a fresh one.</p>
</main>
</body></html>`;
}

// ── Client script (vanilla JS, no template literals) ─────────────────────────

/**
 * Sign and pay, and one read receipt on load.
 *
 * NO TEMPLATE LITERALS, so the whole thing can be assembled inside one. The
 * only interpolated value is the token, which came out of our own database as a
 * UUID — but it is JSON-encoded anyway rather than pasted, because "it can't
 * contain a quote" is exactly the assumption that stops being true one schema
 * change later.
 *
 * The page is never the guard: every check below is repeated server-side
 * (`signAgreement` re-validates the signature, `preparePayment` re-resolves the
 * balance, the rail, and whether the agreement is even signed). These exist so
 * a partner gets an answer in the field rather than as a 400 after a round
 * trip.
 */
function portalScript(token: string): string {
  const t = JSON.stringify(token);
  return `
(function(){
  var TOKEN=${t};
  function post(path,body){
    return fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
      .then(function(r){return r.json().then(function(j){return {ok:r.ok,body:j};});});
  }
  function show(el,msg){ if(!el) return; el.textContent=msg; el.style.display='block'; }
  function hide(el){ if(el) el.style.display='none'; }

  // Read receipt — best effort, never blocks the page or surfaces a failure.
  post('/api/partner/viewed',{token:TOKEN}).catch(function(){});

  // Stripe sends the partner back with ?paid=1. The gift may not be booked yet
  // (a bank debit takes days), so this says "we've got it" rather than
  // "received" — and then strips the query so a refresh doesn't re-announce it.
  try{
    var params=new URLSearchParams(window.location.search);
    if(params.get('paid')==='1'){
      var banner=document.getElementById('paid-banner');
      show(banner,"Thank you — we've got it. Bank transfers take about four business days to clear, and we'll email you the moment it lands.");
      history.replaceState(null,'',window.location.pathname);
    }
  }catch(e){}

  var sgBtn=document.getElementById('sg-btn');
  if(sgBtn){
    sgBtn.addEventListener('click',function(){
      var err=document.getElementById('sg-err');
      hide(err);
      var name=(document.getElementById('sg-name').value||'').trim();
      var title=(document.getElementById('sg-title').value||'').trim();
      var email=(document.getElementById('sg-email').value||'').trim();
      var agreed=document.getElementById('sg-agree').checked;
      if(name.length<2){ show(err,'Type your full name to sign.'); return; }
      if(!agreed){ show(err,'Tick the box to confirm you agree to the terms.'); return; }
      sgBtn.disabled=true; sgBtn.textContent='Signing…';
      post('/api/partner/sign',{token:TOKEN,name:name,title:title,email:email}).then(function(res){
        if(!res.ok){ show(err,res.body&&res.body.error?res.body.error:'Something went wrong. Please try again.'); sgBtn.disabled=false; sgBtn.textContent='Sign the agreement'; return; }
        window.location.reload();
      }).catch(function(){
        show(err,'Something went wrong. Please try again.');
        sgBtn.disabled=false; sgBtn.textContent='Sign the agreement';
      });
    });
  }

  var pyBtn=document.getElementById('py-btn');
  if(pyBtn){
    pyBtn.addEventListener('click',function(){
      var err=document.getElementById('py-err');
      hide(err);
      var raw=(document.getElementById('py-amount').value||'').replace(/[^0-9.]/g,'');
      var dollars=parseFloat(raw);
      if(!isFinite(dollars)||dollars<=0){ show(err,'Enter an amount greater than zero.'); return; }
      var cents=Math.round(dollars*100);
      var railEl=document.querySelector('input[name=rail]:checked');
      var rail=railEl?railEl.value:'ach';
      var coverFee=document.getElementById('py-fee').checked;
      pyBtn.disabled=true; pyBtn.textContent='Opening checkout…';
      post('/api/partner/pay',{token:TOKEN,method:rail,amountCents:cents,coverFee:coverFee}).then(function(res){
        if(!res.ok||!res.body||!res.body.url){
          show(err,res.body&&res.body.error?res.body.error:"Couldn't start checkout. Please try again.");
          pyBtn.disabled=false; pyBtn.textContent='Continue to payment'; return;
        }
        window.location.href=res.body.url;
      }).catch(function(){
        show(err,"Couldn't start checkout. Please try again.");
        pyBtn.disabled=false; pyBtn.textContent='Continue to payment';
      });
    });
  }
})();
`;
}
