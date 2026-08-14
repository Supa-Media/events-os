/**
 * Public, accountless CONTRACTOR PAYMENT page — server-rendered HTML served by
 * http.ts at /contract/<chapterSlug>[?token=]. The sibling of
 * `reimbursePage.ts` and deliberately built from the same parts: self-contained
 * (inline CSS + vanilla JS), same cream/dark-red palette, same
 * upload-then-submit rhythm, talking to same-origin /api/contract/* httpActions
 * (see contractApiRoutes.ts). No login — the chapter slug scopes the blank
 * form, a payment's secret token scopes everything else.
 *
 * FOUR STATES, matching `contractorPayments.ts`'s two entry points:
 *   - FORM      (no token):            renderContractForm — the BLANK
 *               self-serve request. The person writes their own terms; the row
 *               lands `submitted` and UNCODED and a treasurer decides.
 *   - AGREEMENT (token, canEdit):      renderContractAgreement — a PRE-FILLED
 *               agreement. The terms are the org's testimony and render
 *               READ-ONLY; the contractor supplies identity, tax form, bank,
 *               and a signature. (`changes_requested` lands here too — same
 *               surface, with the reviewer's note on top.)
 *   - STATUS    (token, !canEdit):     renderContractStatus — the timeline
 *               (Submitted → Under review → Approved → Paid), plus the
 *               terminal cases (rejected / canceled / failed).
 *   - NOT FOUND:                       renderContractNotFound.
 *
 * ── THE THING THIS PAGE EXISTS TO GET RIGHT ────────────────────────────────
 * A contractor payment PUBLISHES. `serviceDescription`, the amount, the date
 * and the budget category go onto the chapter's public ledger verbatim and
 * permanently; the person's name does NOT (the ledger row's counterparty is
 * the constant `CONTRACTOR_LEDGER_COUNTERPARTY`). Somebody filling this in on
 * their phone has no way to know any of that unless we tell them, so the
 * disclosure is not a footnote — it is the panel the description field lives
 * INSIDE (`disclosureSection`), and it renders a LIVE PREVIEW of the exact
 * ledger row as they type. Seeing the row beats being told about it, and it is
 * the difference between "we warned them" and "they understood".
 *
 * The same panel says what will NEVER publish (name, email, phone, tax form,
 * bank details) — because the fear that makes people write vague, useless
 * descriptions is the fear that their name is going on a website.
 *
 * The inline `publicTextProblems` check is a courtesy, never a gate: the
 * server runs the identical shared function on every write path
 * (`assertPublicDescription`), so a description this page warned about cannot
 * be forced through by posting directly.
 *
 * The client scripts deliberately avoid template literals so they can be
 * assembled inside one. Every interpolated value is HTML-escaped.
 */
import { escapeHtml as esc } from "./html";
import { FONTS, FAVICON } from "./landingPageStyles";
import {
  CONTRACTOR_LEDGER_COUNTERPARTY,
  CONTRACTOR_PAYMENT_MAX_CENTS,
  CONTRACTOR_SERVICE_DESCRIPTION_MAX,
  publicTextProblems,
} from "@events-os/shared";

// ── Types the render fns accept ──────────────────────────────────────────────
// Structural on purpose: http.ts passes the Convex query results straight
// through, so these describe the SHAPE rather than re-declaring the branded
// id/union types the queries actually return (every one of those is assignable
// to `string`). Same posture as `ReimburseChapterView`.

/** Chapter display data for the blank form (api.contractorPayments.chapterForContract
 *  plus the slug from the URL — the chapter row's own `slug` is optional in the
 *  schema, and the form needs a definite one to POST with). */
export type ContractChapterView = {
  chapterId: string;
  name: string;
  slug?: string | null;
};

/** The contractor's own view of their payment (api.contractorPayments.publicByToken).
 *  Note what ISN'T here and can't be: no token echo, no tax-document storage id,
 *  no reviewer identity. The query's projection is allow-list shaped; this type
 *  is the page's half of that promise. */
export type ContractPublicView = {
  reference: string;
  chapterName: string;
  status: string;
  statusLabel: string;
  canEdit: boolean;
  origin: string;
  payeeName: string;
  payeeEmail?: string | null;
  payeeBusinessName?: string | null;
  serviceDescription: string;
  serviceDate?: number | null;
  agreedAmountCents: number;
  agreementNotes?: string | null;
  agreementTermsVersion: number;
  acceptedAt?: number | null;
  acceptedCurrentTerms: boolean;
  reviewNote?: string | null;
  rejectedReason?: string | null;
  hasBankDestination: boolean;
  bankAccountLast4?: string | null;
  hasTaxDocument: boolean;
  taxDocumentKind?: string | null;
  paidAt?: number | null;
};

// ── Formatting ───────────────────────────────────────────────────────────────

function money(cents: number): string {
  return `$${((cents || 0) / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Date only — what a ledger row shows. */
function fmtDay(ts: number): string {
  return new Date(ts).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "America/New_York",
  });
}

/** Date + time — what a timeline step shows. */
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

// ── Static presentation ──────────────────────────────────────────────────────

/** Inline SVG symbol library (the subset the page references via <use>). */
const SYMBOLS = `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
<symbol id="i-file" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></symbol>
<symbol id="i-upload" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></symbol>
<symbol id="i-check" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></symbol>
<symbol id="i-x" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></symbol>
<symbol id="i-clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></symbol>
<symbol id="i-send" viewBox="0 0 24 24"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></symbol>
<symbol id="i-eye" viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></symbol>
<symbol id="i-lock" viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></symbol>
<symbol id="i-bank" viewBox="0 0 24 24"><line x1="3" y1="22" x2="21" y2="22"/><line x1="6" y1="18" x2="6" y2="11"/><line x1="10" y1="18" x2="10" y2="11"/><line x1="14" y1="18" x2="14" y2="11"/><line x1="18" y1="18" x2="18" y2="11"/><polygon points="12 2 20 7 4 7"/></symbol>
<symbol id="i-check-circle" viewBox="0 0 24 24"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></symbol>
<symbol id="i-alert" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></symbol>
<symbol id="i-calendar" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></symbol>
<symbol id="i-pen" viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></symbol>
</defs></svg>`;

/**
 * Contract-page stylesheet. The palette and the shared primitives are lifted
 * from `REIMBURSE_CSS` verbatim so the two public money surfaces are visibly
 * the same product; everything below the `── contract-only ──` marker is new
 * and exists for this page's own problems (the disclosure panel, the ledger
 * preview, the tax-form picker).
 *
 * MOBILE IS THE PRIMARY CASE — a stranger opens this on a phone from a text
 * message. Nothing is fixed-width, the two-up grids collapse at 640px, the
 * page padding tightens at 400px, and the preview row wraps rather than
 * pushing the body sideways (`overflow-wrap:anywhere`). Focus is visible
 * everywhere: `:focus-visible` gets a real outline and inputs get a ring, so
 * the form is usable by keyboard and by anyone who cannot see a caret.
 */
const CONTRACT_CSS = `
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
.serif{font-family:"Corben",Georgia,serif;font-weight:700;letter-spacing:-.01em;}
.money{font-variant-numeric:tabular-nums;font-weight:600;}
.muted{color:var(--muted);}.faint{color:var(--faint);}.ink{color:var(--ink);}
.small{font-size:13px;line-height:19px;}.xs{font-size:12px;line-height:17px;}.semi{font-weight:600;}.bold{font-weight:700;}
.row{display:flex;align-items:center;gap:10px;}.between{justify-content:space-between;}.wrap{flex-wrap:wrap;}
.col{display:flex;flex-direction:column;}
.gap4{gap:4px;}.gap6{gap:6px;}.gap8{gap:8px;}.gap12{gap:12px;}.gap16{gap:16px;}
.mt4{margin-top:4px;}.mt8{margin-top:8px;}.mt12{margin-top:12px;}.mt16{margin-top:16px;}.mt24{margin-top:24px;}
.pubbar{background:var(--raised);border-bottom:1px solid var(--border);}
.pubbar-in{max-width:760px;margin:0 auto;padding:14px 20px;display:flex;align-items:center;gap:12px;}
.mark{height:30px;width:30px;border-radius:var(--r-md);background:var(--accent);display:flex;align-items:center;justify-content:center;flex:0 0 30px;}
.mark svg{width:16px;height:16px;stroke:#fff;}
.brand-t{font-family:"Corben",serif;font-weight:700;font-size:16px;}
.brand-t .os{color:var(--accent);}
.wrap-main{max-width:760px;margin:0 auto;padding:22px 20px 64px;}
.card{background:var(--raised);border:1px solid var(--border);border-radius:var(--r-lg);box-shadow:var(--shadow-card);padding:20px;}
.hero{text-align:center;padding:8px 0 20px;}
.hero .ic{height:46px;width:46px;border-radius:999px;background:var(--accent-soft);display:inline-flex;align-items:center;justify-content:center;margin-bottom:10px;}
.hero .ic svg{width:22px;height:22px;stroke:var(--accent);}
.hero h1{font-family:"Corben",serif;font-weight:700;font-size:26px;line-height:31px;}
.hero p{color:var(--muted);margin-top:8px;font-size:14px;}
.field{display:flex;flex-direction:column;gap:6px;}
.fl{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);}
.forminput{border:1px solid var(--border-strong);background:var(--raised);border-radius:var(--r-md);padding:11px 12px;font-size:16px;line-height:22px;color:var(--ink);width:100%;font-family:inherit;}
.forminput::placeholder{color:var(--faint);}
textarea.forminput{resize:vertical;}
select.forminput{appearance:none;-webkit-appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%23A98C8C' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 10px center;padding-right:32px;}
input[type=file].forminput{padding:9px 10px;font-size:13px;}
/* Focus is never invisible — keyboard users and low-vision users both depend
   on it, and this form is long enough to get lost in. */
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;}
.forminput:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft);}
.two{display:grid;grid-template-columns:1fr 1fr;gap:14px;}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;border-radius:var(--r-md);font-weight:600;font-size:15px;padding:12px 18px;border:1px solid transparent;line-height:1;}
.btn svg{width:16px;height:16px;stroke:currentColor;}
.btn.sm{padding:7px 12px;font-size:13px;}.btn.sm svg{width:14px;height:14px;}
.btn:disabled{opacity:.55;cursor:default;}
.btn-primary{background:var(--accent);color:#fff;}.btn-primary:hover:not(:disabled){background:var(--accent-hover);}
.btn-secondary{background:var(--raised);color:var(--ink);border-color:var(--border-strong);}.btn-secondary:hover{background:var(--sunken);}
.btn-ghost{background:transparent;color:var(--accent);text-decoration:none;}.btn-ghost:hover{background:var(--sunken);}
.badge{display:inline-flex;align-items:center;gap:4px;border-radius:var(--r-sm);padding:2px 8px;font-size:12px;line-height:16px;font-weight:600;}
.badge svg{width:11px;height:11px;stroke:currentColor;}
.badge.success{background:var(--success-bg);color:var(--success);}.badge.warn{background:var(--warn-bg);color:var(--warn);}
.badge.info{background:var(--info-bg);color:var(--info);}.badge.neutral{background:var(--sunken);color:var(--muted);}.badge.accent{background:var(--accent-soft);color:var(--accent);}
.divider{height:1px;background:var(--border);margin:18px 0;}
.callout{border-left:3px solid var(--warn);background:var(--warn-bg);border-radius:0 var(--r-md) var(--r-md) 0;padding:12px 14px;font-size:13px;line-height:19px;color:#6b4a12;}
.callout.info{border-color:var(--info);background:var(--info-bg);color:#2e447e;}
.callout.ok{border-color:var(--success);background:var(--success-bg);color:#1e5a41;}
.callout.err{border-color:var(--accent);background:var(--accent-soft);color:var(--accent-hover);}
.summ{border:1px solid var(--border);border-radius:var(--r-md);overflow:hidden;}
.summ .sr{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding:11px 14px;border-bottom:1px solid var(--border);}
.summ .sr:last-child{border-bottom:none;}
.summ .sr .k{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);flex:0 0 auto;padding-top:2px;}
.summ .sr .v{text-align:right;font-size:14px;overflow-wrap:anywhere;}
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
.tl .tls{font-size:13px;line-height:19px;color:var(--muted);}
.hide{display:none;}
.footnote{text-align:center;color:var(--faint);font-size:12px;line-height:18px;margin-top:24px;}

/* ── contract-only ────────────────────────────────────────────────────────── */
/* THE DISCLOSURE. Deliberately the loudest thing on the page that isn't a
   button: a full-weight border, its own ground, and the description field
   living inside it so the rule and the box it governs cannot be read apart. */
.disclose{border:2px solid var(--info);background:var(--info-bg);border-radius:var(--r-lg);padding:16px;color:#22365f;}
.disclose h2{font-family:"Corben",serif;font-weight:700;font-size:16px;line-height:21px;display:flex;align-items:center;gap:8px;}
.disclose h2 svg{width:17px;height:17px;stroke:currentColor;flex:0 0 17px;}
.disclose p{font-size:13px;line-height:19px;margin-top:8px;}
.disclose .fl{color:#3b5390;}
.pubgrid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:12px;}
.pubcol{background:rgba(255,255,255,.72);border-radius:var(--r-md);padding:10px 12px;}
.pubcol .h{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;display:flex;align-items:center;gap:5px;}
.pubcol .h svg{width:12px;height:12px;stroke:currentColor;flex:0 0 12px;}
.pubcol.yes .h{color:var(--warn);}
.pubcol.no .h{color:var(--success);}
.pubcol ul{margin:6px 0 0;padding-left:16px;font-size:12px;line-height:18px;color:#33456e;}
.pubcol li{margin-top:2px;}
/* The live ledger row. Monospaced digits, wraps instead of scrolling the page,
   and reads as a printed line rather than as another form control. */
.ledgerbox{background:var(--raised);border:1px solid var(--border-strong);border-radius:var(--r-md);padding:11px 12px;margin-top:8px;}
.ledgerrow{font-size:13px;line-height:19px;color:var(--ink);overflow-wrap:anywhere;font-variant-numeric:tabular-nums;}
.ledgerrow .cp{font-weight:700;}
.ledgerrow .ph{color:var(--faint);font-style:italic;}
/* Tax-form picker: big tap targets, the explanation on the card rather than in
   a tooltip, because "which form am I?" is the actual question. */
.pick{display:flex;gap:10px;align-items:flex-start;border:1px solid var(--border-strong);border-radius:var(--r-md);padding:11px 12px;background:var(--raised);cursor:pointer;}
.pick input{margin:2px 0 0;flex:0 0 auto;width:18px;height:18px;accent-color:var(--accent);}
.pick b{display:block;font-size:14px;line-height:20px;}
.pick em{display:block;font-style:normal;font-size:12px;line-height:17px;color:var(--muted);margin-top:1px;}
.pick.on{border-color:var(--accent);background:var(--accent-soft);}
.pick:has(input:checked){border-color:var(--accent);background:var(--accent-soft);}
.chip{display:inline-flex;align-items:center;gap:6px;background:var(--success-bg);color:var(--success);border-radius:var(--r-sm);padding:4px 9px;font-size:12px;font-weight:600;overflow-wrap:anywhere;}
.chip svg{width:12px;height:12px;stroke:currentColor;flex:0 0 12px;}
.terms-note{white-space:pre-wrap;overflow-wrap:anywhere;}
.agree{display:flex;gap:10px;align-items:flex-start;font-size:13px;line-height:19px;}
.agree input{margin:2px 0 0;flex:0 0 auto;width:18px;height:18px;accent-color:var(--accent);}

@media (max-width:640px){
  .two{grid-template-columns:1fr;}
  .pubgrid{grid-template-columns:1fr;}
}
@media (max-width:400px){
  .wrap-main{padding:16px 12px 56px;}
  .pubbar-in{padding:12px 12px;}
  .card{padding:16px 14px;}
  .disclose{padding:13px 12px;}
  .hero h1{font-size:23px;line-height:28px;}
}
`;

const ICON_ATTRS = `fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`;

/** Common <head> so every state shares fonts, favicon, and styles. */
function head(title: string): string {
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#FDF6F6">
<title>${esc(title)}</title>
${FAVICON}${FONTS}
<style>${CONTRACT_CSS}</style>`;
}

/** The shared brand bar. */
function pubbar(chapterName: string): string {
  return `<div class="pubbar"><div class="pubbar-in">
  <span class="mark"><svg ${ICON_ATTRS}><use href="#i-file"/></svg></span>
  <span class="brand-t">${esc(chapterName)} <span class="os">contractor payments</span></span>
</div></div>`;
}

// ── The disclosure ───────────────────────────────────────────────────────────

/**
 * THE PUBLIC-LEDGER DISCLOSURE — the requirement this whole file is organised
 * around (founder, explicitly). Everything the contractor needs in order to
 * write a description they will not regret, in the place they write it.
 *
 * Four things, in this order, because that is the order the questions arrive:
 *   1. There IS a public ledger, and this payment goes on it.
 *   2. What lands on it: the description, the amount, the date, the category.
 *   3. What never does: their name, email, phone, tax form, bank details —
 *      the ledger's counterparty is `CONTRACTOR_LEDGER_COUNTERPARTY`, which
 *      is printed here literally rather than described, so the promise is
 *      checkable against the published ledger.
 *   4. A direct instruction: no address, no phone, no SSN in the description.
 *
 * Then the field itself, then the LIVE PREVIEW of the exact row. The preview
 * is the part that actually works: a person who is told "this is public"
 * writes the same sentence anyway, and a person who watches their sentence
 * appear inside a ledger row rewrites it.
 *
 * `fieldHtml` is the caller's description control — an editable textarea on the
 * blank form, a read-only rendering of the org's terms on the pre-filled one.
 * The panel is IDENTICAL either way: someone accepting a description a staffer
 * wrote is still agreeing to publish it, and deserves to see where it lands.
 */
function disclosureSection(chapterName: string, fieldHtml: string): string {
  return `<section class="disclose" aria-labelledby="disclose-h">
  <h2 id="disclose-h"><svg ${ICON_ATTRS}><use href="#i-eye"/></svg>What becomes public</h2>
  <p>${esc(chapterName)} publishes a <b>public ledger</b> of what it spends, and this payment will appear on it. Here is exactly what does and doesn't go on that page.</p>
  <div class="pubgrid">
    <div class="pubcol yes">
      <div class="h"><svg ${ICON_ATTRS}><use href="#i-eye"/></svg>Published</div>
      <ul>
        <li>The description of the work — word for word</li>
        <li>The amount</li>
        <li>The date</li>
        <li>The budget category it's filed under</li>
      </ul>
    </div>
    <div class="pubcol no">
      <div class="h"><svg ${ICON_ATTRS}><use href="#i-lock"/></svg>Never published</div>
      <ul>
        <li>Your name</li>
        <li>Your email and phone number</li>
        <li>Your tax form</li>
        <li>Your bank details</li>
      </ul>
    </div>
  </div>
  <p>The ledger names the payee as <b>&ldquo;${esc(CONTRACTOR_LEDGER_COUNTERPARTY)}&rdquo;</b> — never you. So <b>please don't put personal details in the description</b>: no home address, no phone number, no Social Security or tax number. Describe the work, not yourself.</p>
  <div class="mt12">${fieldHtml}</div>
  <div class="ledgerbox">
    <span class="fl">The ledger row that will publish</span>
    <div class="ledgerrow mt4" id="ledgerrow" aria-live="polite"></div>
  </div>
</section>`;
}

// ── Reusable field groups (identical on both submitting surfaces) ────────────

/** Who you are. `view` pre-fills whatever the org already knew — a pre-filled
 *  agreement usually arrives with a name and often an email. */
function identityFields(view?: ContractPublicView): string {
  const name = view?.payeeName ?? "";
  const email = view?.payeeEmail ?? "";
  const business = view?.payeeBusinessName ?? "";
  return `<div class="col gap12">
  <div class="two">
    <div class="field"><label class="fl" for="f_name">Your full name</label><input id="f_name" class="forminput" autocomplete="name" autocapitalize="words" placeholder="First and last name" value="${esc(name)}"></div>
    <div class="field"><label class="fl" for="f_email">Email</label><input id="f_email" class="forminput" type="email" inputmode="email" autocomplete="email" autocapitalize="off" spellcheck="false" placeholder="you@example.com" value="${esc(email)}"></div>
  </div>
  <div class="two">
    <div class="field"><label class="fl" for="f_business">Business name (optional)</label><input id="f_business" class="forminput" autocomplete="organization" placeholder="If you're paid as a business" value="${esc(business)}"></div>
    <div class="field"><label class="fl" for="f_phone">Phone (optional)</label><input id="f_phone" class="forminput" type="tel" inputmode="tel" autocomplete="tel" placeholder="For questions about this payment"></div>
  </div>
  <span class="xs faint">None of this is published — it's how the finance team reaches you and how the payment is reported at year end.</span>
</div>`;
}

/**
 * The tax form. Two decisions live here and both are the contractor's:
 *
 *  - WHICH FORM. A US person or US business files a W-9; anyone who is not a
 *    US person files a W-8BEN (individual) or W-8BEN-E (entity). The
 *    one-liners are on the cards, because "which one am I?" is the question
 *    and a link to irs.gov is not an answer.
 *  - THE W-8 CONSEQUENCE, stated up front rather than discovered at review:
 *    `approve` hard-blocks a foreign payee with `FOREIGN_PAYEE_REVIEW`
 *    (withholding is not something this system computes), so a W-8 request is
 *    accepted but will not be paid automatically. Someone who learns that
 *    AFTER submitting feels lied to; someone who learns it here can plan.
 *
 * The retention sentence is a promise the code actually keeps — see
 * `taxDocPurgeAfter` and the purge sweep in `contractorPayments.ts`.
 */
function taxDocFields(): string {
  return `<div class="col gap12">
  <div class="field">
    <span class="fl" id="taxkind-l">Which tax form are you filing?</span>
    <div class="col gap8" role="radiogroup" aria-labelledby="taxkind-l">
      <label class="pick on"><input type="radio" name="taxkind" value="w9" checked><span><b>W-9</b><em>You're a US person, or a US business. This is the usual one.</em></span></label>
      <label class="pick"><input type="radio" name="taxkind" value="w8ben"><span><b>W-8BEN</b><em>You're an individual who is not a US person.</em></span></label>
      <label class="pick"><input type="radio" name="taxkind" value="w8bene"><span><b>W-8BEN-E</b><em>You're a business that is not a US entity.</em></span></label>
    </div>
    <div class="callout hide mt4" id="w8warn"><b>Heads up.</b> Paying someone outside the US can carry tax withholding that this system doesn't calculate, so a W-8 request <b>won't be paid automatically</b> — we'll take it, and someone from the finance team will get in touch to sort out how it's paid.</div>
  </div>
  <div class="field">
    <label class="fl" for="f_taxfile">Upload your completed, signed form</label>
    <input id="f_taxfile" class="forminput" type="file" accept="application/pdf,image/*" aria-describedby="taxfile-h">
    <div class="chip hide" id="f_taxchip"><svg ${ICON_ATTRS}><use href="#i-check"/></svg><span></span></div>
    <span class="xs faint" id="taxfile-h">A PDF or a clear photo, under 20MB. <b class="ink">Your W-9 is stored securely, is visible only to the finance team, and is destroyed four years after the tax year it covers.</b> Nothing on it is ever published.</span>
  </div>
</div>`;
}

/** Where the money goes. The account-number sentence is the whole point of the
 *  block: `linkPublicBankAccount` hands the digits to Increase once and Convex
 *  only ever stores the reference id + the last four, so we can say so plainly.
 *  `inputmode="numeric"` on both digit fields — a phone keypad instead of a
 *  full keyboard is the difference between a 30-second step and a 3-minute one. */
function bankFields(): string {
  return `<div class="col gap12">
  <div class="two">
    <div class="field"><label class="fl" for="f_routing">Routing number</label><input id="f_routing" class="forminput" inputmode="numeric" pattern="[0-9]*" autocomplete="off" maxlength="9" placeholder="9 digits"></div>
    <div class="field"><label class="fl" for="f_account">Account number</label><input id="f_account" class="forminput" inputmode="numeric" pattern="[0-9]*" autocomplete="off" placeholder="Your account number"></div>
  </div>
  <div class="two">
    <div class="field"><label class="fl" for="f_holder">Name on the account</label><input id="f_holder" class="forminput" autocapitalize="words" placeholder="Defaults to your name above"></div>
    <div class="field"><label class="fl" for="f_funding">Account type</label>
      <select id="f_funding" class="forminput">
        <option value="checking">Checking</option>
        <option value="savings">Savings</option>
      </select>
    </div>
  </div>
  <span class="xs faint"><b class="ink">Your account number is sent straight to our bank and is never stored here — we keep only the last four digits.</b> It is never published.</span>
</div>`;
}

/** The signature. A typed name, recorded against the terms version that was on
 *  screen — see `completeAgreement`'s `acceptedTermsVersion`. */
function signatureFields(agreeLabel: string): string {
  return `<div class="col gap12">
  <label class="agree"><input type="checkbox" id="f_agree"><span>${agreeLabel}</span></label>
  <div class="field" style="max-width:340px"><label class="fl" for="f_sign">Type your full name to sign</label><input id="f_sign" class="forminput" autocapitalize="words" placeholder="Your full name"></div>
</div>`;
}

/** The shared page footer. */
function footnote(): string {
  return `<div class="footnote">Your name, contact details, tax form, and bank details are used only to pay you — they are never published. Powered by Chapter&nbsp;OS.</div>`;
}

// ── FORM state: the blank self-serve request ─────────────────────────────────

/**
 * The BLANK request form — somebody asking to be paid, with nothing
 * pre-approved (`submitPublicRequest`, `origin: "self_serve"`).
 *
 * They write their own terms, so the description here is a real, editable
 * field and it lives inside the disclosure panel. Everything else is the same
 * shape the pre-filled path uses: identity → tax form → bank → signature.
 *
 * The submit path is upload-then-post, copied from `reimbursePage.ts`: the tax
 * document PUTs straight to Convex storage first and the resulting `storageId`
 * rides along in the JSON body. The bank digits go to
 * `/api/contract/request`, which links them with Increase BEFORE the mutation
 * runs — the page never sees an `externalAccountId`.
 */
export function renderContractForm(chapter: ContractChapterView): string {
  const slug = chapter.slug ?? "";
  const init = JSON.stringify({
    mode: "request",
    slug,
    name: chapter.name,
    counterparty: CONTRACTOR_LEDGER_COUNTERPARTY,
    descMax: CONTRACTOR_SERVICE_DESCRIPTION_MAX,
    maxCents: CONTRACTOR_PAYMENT_MAX_CENTS,
  }).replace(/</g, "\\u003c");

  const descField = `<div class="field">
  <label class="fl" for="f_desc">What was the work?</label>
  <textarea id="f_desc" class="forminput" rows="3" maxlength="${CONTRACTOR_SERVICE_DESCRIPTION_MAX}" placeholder="e.g. Sound engineering for the June Worship with Strangers night" aria-describedby="desc-h"></textarea>
  <div class="row between wrap gap8">
    <span class="xs" id="desc-h" style="color:#3b5390">Say what you did, for which event or project.</span>
    <span class="xs faint" id="desccount" aria-live="polite"></span>
  </div>
  <div class="callout err hide" id="descproblems" role="status"></div>
</div>`;

  return `<!doctype html>
<html lang="en"><head>${head(`Request a payment — ${chapter.name}`)}</head>
<body>
${SYMBOLS}
${pubbar(chapter.name)}
<main class="wrap-main">
  <div class="hero">
    <span class="ic"><svg ${ICON_ATTRS}><use href="#i-file"/></svg></span>
    <h1>Request a payment</h1>
    <p>${esc(chapter.name)} — tell us what you did and what you're owed. A treasurer reviews every request, and once it's approved you're paid by direct deposit.</p>
  </div>

  <div class="col gap16">
    ${disclosureSection(chapter.name, descField)}

    <section class="card">
      <span class="fl">The work</span>
      <div class="two mt12">
        <div class="field"><label class="fl" for="f_amount">Amount you're owed</label><input id="f_amount" class="forminput" inputmode="decimal" placeholder="$0.00" aria-describedby="amount-h"></div>
        <div class="field"><label class="fl" for="f_date">Date of the work (optional)</label><input id="f_date" class="forminput" type="date"></div>
      </div>
      <span class="xs faint mt8" id="amount-h" style="display:block">In dollars. Both of these publish on the ledger.</span>
      <div class="field mt12">
        <label class="fl" for="f_notes">Anything the treasurer should know? (optional)</label>
        <textarea id="f_notes" class="forminput" rows="2" placeholder="Who asked you to do this, which budget you think it belongs to, an invoice number…"></textarea>
        <span class="xs faint">This one is <b class="ink">internal</b> — it goes to the treasurer, not to the ledger.</span>
      </div>
    </section>

    <section class="card">
      <span class="fl">Who you are</span>
      <div class="mt12">${identityFields()}</div>
    </section>

    <section class="card">
      <span class="fl">Your tax form</span>
      <p class="xs muted mt4">We're required to collect one before paying you.</p>
      <div class="mt12">${taxDocFields()}</div>
    </section>

    <section class="card">
      <span class="fl">Where the money goes</span>
      <div class="mt12">${bankFields()}</div>
    </section>

    <section class="card">
      <span class="fl">Sign and send</span>
      <div class="mt12">${signatureFields("Everything above is true, the work described is work I did, and I understand the description, amount, and date will be published on the public ledger.")}</div>
      <div class="callout err hide mt12" id="formerr" role="alert"></div>
      <div class="row between wrap gap12 mt16">
        <span class="xs faint">Nothing is paid until a treasurer approves it.</span>
        <button id="submit" class="btn btn-primary"><svg ${ICON_ATTRS}><use href="#i-send"/></svg><span id="submitlabel">Send request</span></button>
      </div>
    </section>
  </div>
  ${footnote()}
</main>
<script>window.__CCFG__=${init};</script>
<script>${CONTRACT_SCRIPT}</script>
</body></html>`;
}

// ── AGREEMENT state: the pre-filled terms ────────────────────────────────────

/**
 * The PRE-FILLED agreement (`completeAgreement`, `origin: "staff_prefilled"`).
 *
 * THE TERMS ARE READ-ONLY AND THAT IS STRUCTURAL, not styling: the mutation
 * behind this page has no `agreedAmountCents`, `serviceDescription` or
 * `serviceDate` parameter at all, so there is nothing an edited input could
 * post to. Rendering them as text rather than as disabled inputs says the same
 * thing honestly — this is the org's testimony, and the contractor's job is to
 * agree to it or not.
 *
 * The disclosure panel renders IDENTICALLY here, with the org's description
 * inside it and the live ledger preview underneath. Somebody agreeing to a
 * sentence a staffer wrote is still the person whose payment publishes; if the
 * description names their street, this is the last moment anyone can catch it.
 *
 * `changes_requested` lands here too (`contractorCanEdit` covers both `sent`
 * and `changes_requested`), with the reviewer's note at the top — that state is
 * a conversation, not a verdict, and the page says so.
 */
export function renderContractAgreement(
  view: ContractPublicView,
  chapterSlug: string,
  token: string,
): string {
  const init = JSON.stringify({
    mode: "agreement",
    slug: chapterSlug,
    token,
    name: view.chapterName,
    counterparty: CONTRACTOR_LEDGER_COUNTERPARTY,
    descMax: CONTRACTOR_SERVICE_DESCRIPTION_MAX,
    maxCents: CONTRACTOR_PAYMENT_MAX_CENTS,
    // The frozen terms, for the ledger preview only — nothing here is ever
    // posted back (the mutation cannot accept them).
    terms: {
      description: view.serviceDescription,
      amountCents: view.agreedAmountCents,
      serviceDate: view.serviceDate ?? null,
    },
  }).replace(/</g, "\\u003c");

  const sentBack = view.status === "changes_requested";
  const firstName =
    view.payeeName.trim().split(/\s+/)[0] || view.payeeName || "there";

  const reviewCallout = sentBack
    ? `<div class="callout mt16"><b>A reviewer sent this back.</b> ${esc(
        view.reviewNote ??
          "Please check the details below and send it again.",
      )}<div class="xs mt8">This isn't a rejection — nothing is lost. Fix what's noted and re-sign below.</div></div>`
    : "";

  const staleAcceptance =
    view.acceptedAt != null && !view.acceptedCurrentTerms
      ? `<div class="callout mt16"><b>These terms changed since you signed.</b> ${esc(
          view.chapterName,
        )} updated the work, the amount, or the date, so your earlier signature no longer applies. Please read the terms below and sign again.</div>`
      : "";

  const descBlock = `<div class="field">
  <span class="fl">The work, as ${esc(view.chapterName)} wrote it</span>
  <div class="ledgerbox" style="background:var(--sunken)"><div class="small terms-note">${esc(view.serviceDescription)}</div></div>
  <span class="xs" style="color:#3b5390">You can't edit this — it's the description ${esc(view.chapterName)} agreed to pay for. If it's wrong, don't sign: reply to whoever sent you this link and ask them to change it.</span>
</div>`;

  return `<!doctype html>
<html lang="en"><head>${head(`Your agreement ${view.reference} — ${view.chapterName}`)}</head>
<body>
${SYMBOLS}
${pubbar(view.chapterName)}
<main class="wrap-main">
  <div class="hero">
    <span class="ic"><svg ${ICON_ATTRS}><use href="#i-pen"/></svg></span>
    <h1>${sentBack ? "One more thing" : "Your agreement"}</h1>
    <p>Hi ${esc(firstName)} — ${esc(view.chapterName)} would like to pay you ${esc(
      money(view.agreedAmountCents),
    )}. Read the terms, add your details, and sign. Reference <b class="ink">#${esc(
      view.reference,
    )}</b>.</p>
  </div>
  ${reviewCallout}${staleAcceptance}

  <div class="col gap16 mt16">
    <section class="card">
      <span class="fl">The terms</span>
      <div class="summ mt12">
        <div class="sr"><span class="k">Amount</span><span class="v money">${esc(money(view.agreedAmountCents))}</span></div>
        <div class="sr"><span class="k">Date of work</span><span class="v">${
          view.serviceDate != null ? esc(fmtDay(view.serviceDate)) : "Not specified"
        }</span></div>
        <div class="sr"><span class="k">Paid by</span><span class="v">Direct deposit, after a treasurer approves</span></div>
        ${
          view.agreementNotes
            ? `<div class="sr"><span class="k">Notes</span><span class="v terms-note">${esc(view.agreementNotes)}</span></div>`
            : ""
        }
      </div>
      <p class="xs muted mt8">These terms are set by ${esc(view.chapterName)} and can't be changed here. If any of them change later, your signature is voided and we'll ask you to read and sign again.</p>
    </section>

    ${disclosureSection(view.chapterName, descBlock)}

    <section class="card">
      <span class="fl">Who you are</span>
      <div class="mt12">${identityFields(view)}</div>
    </section>

    <section class="card">
      <span class="fl">Your tax form</span>
      <p class="xs muted mt4">${
        view.hasTaxDocument
          ? "We already have a form on file for you. Uploading another replaces it."
          : "We're required to collect one before paying you."
      }</p>
      <div class="mt12">${taxDocFields()}</div>
    </section>

    <section class="card">
      <span class="fl">Where the money goes</span>
      <div class="mt12">${bankFields()}</div>
      ${
        view.bankAccountLast4
          ? `<p class="xs muted mt8">We currently have an account ending <b class="ink">${esc(view.bankAccountLast4)}</b> on file. Entering details here replaces it.</p>`
          : ""
      }
    </section>

    <section class="card">
      <span class="fl">Accept and sign</span>
      <div class="mt12">${signatureFields(
        `I accept these terms, and I understand the description, amount, and date above will be published on ${esc(
          view.chapterName,
        )}'s public ledger — without my name.`,
      )}</div>
      <div class="callout err hide mt12" id="formerr" role="alert"></div>
      <div class="row between wrap gap12 mt16">
        <span class="xs faint">Signing sends this to a treasurer for approval.</span>
        <button id="submit" class="btn btn-primary"><svg ${ICON_ATTRS}><use href="#i-pen"/></svg><span id="submitlabel">Accept and sign</span></button>
      </div>
    </section>
  </div>
  ${footnote()}
</main>
<script>window.__CCFG__=${init};</script>
<script>${CONTRACT_SCRIPT}</script>
</body></html>`;
}

// ── STATUS state ─────────────────────────────────────────────────────────────

type TimelineStep = {
  step: string;
  label: string;
  sub: string;
  state: "done" | "now" | "todo";
  icon: string;
};

/**
 * The timeline, derived from the status rather than stored. Four steps on the
 * happy path; the terminal refusals (`rejected`, `canceled`) get their own
 * panel above instead of a fake fifth step, because "your payment was refused"
 * is not a stage of being paid.
 */
function timelineFor(view: ContractPublicView): TimelineStep[] {
  const s = view.status;
  const rank: Record<string, number> = {
    draft: 0,
    sent: 0,
    submitted: 1,
    changes_requested: 1,
    approved: 2,
    paying: 3,
    failed: 3,
    paid: 4,
    rejected: 1,
    canceled: 1,
  };
  const at = rank[s] ?? 1;
  const state = (n: number): "done" | "now" | "todo" =>
    at > n ? "done" : at === n ? "now" : "todo";

  return [
    {
      step: "submitted",
      label: "Sent in",
      sub:
        view.acceptedAt != null
          ? `${fmtWhen(view.acceptedAt)} · signed as ${view.payeeName}`
          : "We have your details",
      state: at >= 1 ? "done" : "now",
      icon: "i-check",
    },
    {
      step: "review",
      label: "With a treasurer",
      sub:
        s === "rejected"
          ? "Reviewed — see above"
          : s === "canceled"
            ? "Withdrawn before a decision"
            : at > 1
              ? "Reviewed and approved"
              : "Someone is checking it lands in the right budget. We'll email you either way.",
      state: state(1),
      icon: "i-clock",
    },
    {
      step: "approved",
      label: "Approved",
      sub:
        at > 2
          ? "Approved — the transfer is on its way"
          : "You'll get an email the moment it's approved",
      state: state(2),
      icon: "i-check-circle",
    },
    {
      step: "paid",
      label: "Paid by direct deposit",
      sub:
        view.paidAt != null
          ? `${fmtWhen(view.paidAt)}${view.bankAccountLast4 ? ` · account ending ${view.bankAccountLast4}` : ""}`
          : s === "failed"
            ? "The transfer bounced. A manager is retrying it — you don't need to do anything."
            : "Usually 1–2 business days after approval",
      state: s === "paid" ? "done" : state(3),
      icon: "i-bank",
    },
  ];
}

/**
 * The read-only status page: what happens after the contractor's half is done
 * (`submitted` and everything past it), plus the terminal cases.
 *
 * NO CLIENT SCRIPT AT ALL — there is nothing to submit from here, and a page
 * with no form has no reason to ship JavaScript. Reopening the same link is
 * how someone checks on it, which is what the copy tells them to do.
 */
export function renderContractStatus(
  view: ContractPublicView,
  chapterSlug: string,
): string {
  const firstName =
    view.payeeName.trim().split(/\s+/)[0] || view.payeeName || "there";
  const rejected = view.status === "rejected";
  const canceled = view.status === "canceled";
  const paid = view.status === "paid";
  const stopped = rejected || canceled;

  const steps = timelineFor(view)
    .map((t) => {
      const cls =
        t.state === "done" ? " done" : t.state === "now" && !stopped ? " now" : "";
      const nowBadge =
        t.state === "now" && !stopped
          ? ` <span class="badge accent" style="margin-left:4px">now</span>`
          : "";
      return `<div class="tl${cls}"><div class="tll"><span class="tld"><svg ${ICON_ATTRS}><use href="#${t.icon}"/></svg></span><span class="tlbar"></span></div><div class="tlc"><div class="tlt">${esc(
        t.label,
      )}${nowBadge}</div><div class="tls">${esc(t.sub)}</div></div></div>`;
    })
    .join("");

  const verdict = rejected
    ? `<div class="callout err mt16"><b>This request was declined.</b> ${esc(
        view.rejectedReason ?? "No reason was recorded.",
      )}<div class="xs mt8">If you think that's a mistake, reply to whoever sent you this link — this page can't be reopened.</div></div>`
    : canceled
      ? `<div class="callout mt16"><b>This request was withdrawn</b> before a decision was made. Nothing was paid and nothing is owed.</div>`
      : view.status === "failed"
        ? `<div class="callout mt16"><b>The transfer bounced.</b> That usually means a digit in the account details is off. Someone from the finance team will be in touch — you don't need to do anything yet.</div>`
        : "";

  const heroTitle = paid
    ? "You've been paid"
    : rejected
      ? "Not approved"
      : canceled
        ? "Withdrawn"
        : "We've got it";
  const heroIcon = paid ? "i-bank" : stopped ? "i-alert" : "i-check-circle";
  const heroTint = paid || !stopped ? "var(--success)" : "var(--accent)";

  const heroSub = paid
    ? `Thanks, ${esc(firstName)}. ${esc(money(view.agreedAmountCents))} was sent to your bank${
        view.bankAccountLast4 ? ` (account ending ${esc(view.bankAccountLast4)})` : ""
      }. Reference <b class="ink">#${esc(view.reference)}</b>.`
    : stopped
      ? `Reference <b class="ink">#${esc(view.reference)}</b> is closed. See the note below.`
      : `Thanks, ${esc(firstName)}. Reference <b class="ink">#${esc(
          view.reference,
        )}</b>. We'll email you at each step — reopen this link any time to check where it is.`;

  return `<!doctype html>
<html lang="en"><head>${head(`Payment ${view.reference} — ${view.chapterName}`)}</head>
<body>
${SYMBOLS}
${pubbar(view.chapterName)}
<main class="wrap-main">
  <div class="hero">
    <span class="ic"${
      paid || !stopped ? ` style="background:var(--success-bg)"` : ""
    }><svg fill="none" stroke="${heroTint}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="#${heroIcon}"/></svg></span>
    <h1>${heroTitle}</h1>
    <p>${heroSub}</p>
  </div>
  ${verdict}

  <div class="col gap16 mt16">
    <section class="card">
      <div class="row between wrap gap8"><span class="fl">Status</span><span class="badge ${
        paid ? "success" : stopped ? "neutral" : "info"
      }">${esc(view.statusLabel)}</span></div>
      <div class="timeline mt16">${steps}</div>
    </section>

    <section class="card">
      <span class="fl">What we have</span>
      <div class="summ mt12">
        <div class="sr"><span class="k">The work</span><span class="v terms-note">${esc(view.serviceDescription)}</span></div>
        <div class="sr"><span class="k">Amount</span><span class="v money">${esc(money(view.agreedAmountCents))}</span></div>
        <div class="sr"><span class="k">Date of work</span><span class="v">${
          view.serviceDate != null ? esc(fmtDay(view.serviceDate)) : "Not specified"
        }</span></div>
        <div class="sr"><span class="k">Tax form</span><span class="v">${
          view.hasTaxDocument ? "On file" : "Not on file"
        }</span></div>
        <div class="sr"><span class="k">Paying to</span><span class="v">${
          view.hasBankDestination
            ? view.bankAccountLast4
              ? `Account ending ${esc(view.bankAccountLast4)}`
              : "Bank account on file"
            : "No account on file"
        }</span></div>
      </div>
    </section>

    <section class="card">
      <span class="fl">What's public</span>
      <p class="small mt8">${esc(view.chapterName)}'s public ledger will show this payment as <b class="ink">&ldquo;${esc(
        CONTRACTOR_LEDGER_COUNTERPARTY,
      )}&rdquo;</b> with the description, amount, date, and budget category above. <b class="ink">Your name, email, phone, tax form, and bank details are not published.</b></p>
      <p class="xs muted mt8">Your tax form is visible only to the finance team and is destroyed four years after the tax year it covers.</p>
    </section>

    <section class="card">
      <div class="row between wrap gap8"><span class="semi small">Something else to bill for?</span>
        <a class="btn btn-secondary sm" href="/contract/${encodeURIComponent(chapterSlug)}">Start a new request</a>
      </div>
      <p class="xs muted mt8">This link is private to you — anyone with it can see this page, so don't forward it.</p>
    </section>
  </div>
  ${footnote()}
</main>
</body></html>`;
}

/** Friendly 404 for an unknown chapter slug or an unknown/expired token. */
export function renderContractNotFound(): string {
  return `<!doctype html>
<html lang="en"><head>${head("Payment link not found")}</head>
<body>
${SYMBOLS}
<main class="wrap-main" style="min-height:70vh;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:10px">
  <span style="height:56px;width:56px;border-radius:999px;background:var(--accent-soft);display:inline-flex;align-items:center;justify-content:center"><svg width="26" height="26" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="#i-file"/></svg></span>
  <h1 class="serif" style="font-size:28px">Nothing here</h1>
  <p class="muted" style="max-width:340px">This payment link isn't valid. Check the address, or ask whoever sent it for a fresh one.</p>
</main>
</body></html>`;
}

// ── Client script (vanilla JS, no template literals) ─────────────────────────

/**
 * The SHARED public-text check, shipped to the browser as the SAME FUNCTION the
 * server runs.
 *
 * `publicTextProblems` is imported from `@events-os/shared` and serialised with
 * `Function.prototype.toString()` rather than re-implemented in the script
 * string. A hand-written copy is a copy that drifts, and the drift is silent:
 * the page would stop warning about a shape the server still refuses, and the
 * contractor would meet the rule as a 400 after they'd already uploaded a W-9.
 *
 * This is only safe because that function is entirely self-contained — it
 * closes over nothing, references no imported constant, and calls nothing but
 * regex/array built-ins (go and read it; that property is load-bearing here).
 * A function with a free identifier would break under bundler renaming, which
 * is why `contractorAmountProblems` (it reads
 * `CONTRACTOR_PAYMENT_MAX_CENTS`) is NOT shipped this way — its limit is
 * injected as a number in `__CCFG__.maxCents` and checked inline instead.
 *
 * Belt and braces regardless: every call site wraps this in a try/catch, so the
 * worst a bundler surprise can do is remove an inline warning. The server's
 * `assertPublicDescription` is the actual gate and always was.
 */
const PUBLIC_TEXT_PROBLEMS_SRC = `var publicTextProblems=${publicTextProblems.toString()};`;

/**
 * One script for both submitting surfaces, branching on `__CCFG__.mode`.
 *
 * They differ in exactly two places — whether the description is an input or a
 * constant, and which endpoint the payload goes to — and are identical in the
 * five that matter (the ledger preview, the tax-form picker, the upload, the
 * bank fields, the signature). Two scripts would mean two chances for the
 * disclosure preview to be wrong on one of them.
 *
 * THE SUBMIT ORDER is upload-then-post, the same as the reimburse page: get an
 * upload URL, PUT the file, then post the JSON with the `storageId` in it. The
 * routing/account digits go in that same body and no further — the httpAction
 * hands them to Increase and drops them (see contractApiRoutes.ts).
 */
const CONTRACT_SCRIPT = `
(function(){
"use strict";
var C=window.__CCFG__;
${PUBLIC_TEXT_PROBLEMS_SRC}

function $(id){return document.getElementById(id);}
function money(c){return '$'+((c||0)/100).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});}
/* Dollars in the box, integer cents on the wire. The strip runs first so
   "$1,200.50" and "1200.50" mean the same thing, and Math.round is what keeps
   0.1+0.2 arithmetic out of somebody's paycheck. */
function centsOf(s){
  var t=(''+(s||'')).replace(/[^0-9.]/g,'');
  if(!t)return 0;
  var n=parseFloat(t);
  if(!isFinite(n)||n<0)return 0;
  return Math.round(n*100);
}
/* "YYYY-MM-DD" (an <input type=date> value, local) -> ms at noon local, so a
   UTC-midnight rollover never reads as "yesterday" on the ledger. */
function dateToMs(s){
  if(!s)return null;
  var p=(''+s).split('-');
  if(p.length!==3)return null;
  var d=new Date(Number(p[0]),Number(p[1])-1,Number(p[2]),12,0,0,0);
  var t=d.getTime();
  return isFinite(t)?t:null;
}
function fmtDay(ms){
  if(ms==null)return '';
  try{return new Date(ms).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});}catch(e){return '';}
}
function showErr(msg){
  var e=$('formerr');
  e.textContent=msg;
  e.classList.remove('hide');
  e.scrollIntoView({behavior:'smooth',block:'center'});
}
function clearErr(){$('formerr').classList.add('hide');}

/* ── THE LEDGER PREVIEW ──────────────────────────────────────────────────
   The exact row that publishes: counterparty — description · amount · date.
   Rebuilt on every keystroke because the point is watching your own sentence
   land in a public record, not reading a description of one. Built with
   textContent (never innerHTML) — this renders what a stranger typed. */
var row=$('ledgerrow');
function readDesc(){
  return C.mode==='agreement'?(C.terms.description||''):($('f_desc').value||'').trim();
}
function readCents(){
  return C.mode==='agreement'?(C.terms.amountCents||0):centsOf($('f_amount').value);
}
function readServiceMs(){
  return C.mode==='agreement'?C.terms.serviceDate:dateToMs($('f_date').value);
}
function renderRow(){
  row.textContent='';
  var cp=document.createElement('span');
  cp.className='cp';
  cp.textContent=C.counterparty;
  row.appendChild(cp);
  var desc=readDesc();
  if(desc){
    row.appendChild(document.createTextNode(' — '+desc));
  }else{
    var ph=document.createElement('span');
    ph.className='ph';
    ph.textContent=' — what the work was';
    row.appendChild(ph);
  }
  var parts=[];
  var cents=readCents();
  if(cents>0)parts.push(money(cents));
  var when=fmtDay(readServiceMs());
  if(when)parts.push(when);
  if(parts.length)row.appendChild(document.createTextNode(' · '+parts.join(' · ')));
}

/* The inline PII warning. Advisory only — assertPublicDescription runs the
   identical function server-side on every write path, so this can fail open
   without opening a hole. */
function checkDesc(){
  var box=$('descproblems');
  if(!box)return;
  var problems=[];
  try{problems=publicTextProblems(readDesc())||[];}catch(e){problems=[];}
  if(problems.length===0){box.classList.add('hide');box.textContent='';return;}
  box.textContent=problems.join(' ')+' The description is published publicly — please reword it without personal details.';
  box.classList.remove('hide');
}

if(C.mode==='request'){
  var desc=$('f_desc');
  var count=$('desccount');
  function onDesc(){
    renderRow();
    checkDesc();
    count.textContent=desc.value.length+'/'+C.descMax;
  }
  desc.addEventListener('input',onDesc);
  $('f_amount').addEventListener('input',renderRow);
  $('f_date').addEventListener('change',renderRow);
  onDesc();
}else{
  renderRow();
  checkDesc();
}

/* ── tax form picker ── */
var kinds=document.querySelectorAll('input[name=taxkind]');
function syncKind(){
  var value='w9';
  for(var i=0;i<kinds.length;i++){
    var card=kinds[i].closest('.pick');
    if(card)card.classList.toggle('on',kinds[i].checked);
    if(kinds[i].checked)value=kinds[i].value;
  }
  /* The W-8 branch means "not a US person", which approve() hard-blocks for
     withholding reasons. Say so here rather than at review. */
  $('w8warn').classList.toggle('hide',value==='w9');
  return value;
}
for(var ki=0;ki<kinds.length;ki++)kinds[ki].addEventListener('change',syncKind);
syncKind();
function taxKind(){return syncKind();}

var taxFile=$('f_taxfile');
var taxChip=$('f_taxchip');
taxFile.addEventListener('change',function(){
  var f=taxFile.files&&taxFile.files[0];
  if(!f){taxChip.classList.add('hide');return;}
  taxChip.querySelector('span').textContent=f.name;
  taxChip.classList.remove('hide');
});

/* ── api ── */
function api(path,body){
  return fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
    .then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||'Something went wrong');return j;});});
}
/* Upload URL -> browser PUTs the file straight to Convex storage -> storageId
   rides along in the submit body. Copied from reimbursePage.ts's uploadFile.
   The upload-url route takes either a token (agreement) or a chapter slug
   (blank request); both are rate-limited per IP server-side. */
function uploadFile(file){
  var scope=C.mode==='agreement'?{token:C.token}:{chapterSlug:C.slug};
  return api('/api/contract/upload-url',scope).then(function(r){
    return fetch(r.uploadUrl,{method:'POST',headers:{'Content-Type':file.type||'application/octet-stream'},body:file})
      .then(function(res){if(!res.ok)throw new Error('That upload didn\\'t finish. Please try again.');return res.json();})
      .then(function(j){return j.storageId;});
  });
}

/* ── submit ── */
function submit(){
  clearErr();
  var name=($('f_name').value||'').trim();
  if(name.length<2)return showErr('Please add your full name.');
  var email=($('f_email').value||'').trim();
  if(!email||email.indexOf('@')<1)return showErr('Please add an email address we can send your confirmation to.');

  var descText='',cents=0,serviceMs=null;
  if(C.mode==='request'){
    descText=readDesc();
    if(descText.length<3)return showErr('Say what the work was — this is what appears on the public ledger.');
    var problems=[];
    try{problems=publicTextProblems(descText)||[];}catch(e){problems=[];}
    if(problems.length>0)return showErr(problems[0]+' The description is published publicly, so please reword it without personal details.');
    cents=readCents();
    /* Mirrors contractorAmountProblems. Written out rather than shipped
       because that function reads a module constant; the limit itself comes
       from the server via __CCFG__.maxCents so only one number exists. */
    if(cents<=0)return showErr('Enter the amount you\\'re owed.');
    if(cents>C.maxCents)return showErr('The amount can\\'t be more than $'+(C.maxCents/100).toLocaleString('en-US')+'. Split a larger engagement into milestones.');
    serviceMs=readServiceMs();
  }

  var file=taxFile.files&&taxFile.files[0];
  if(!file)return showErr('Please attach your completed tax form — we can\\'t pay you without it.');

  var routing=($('f_routing').value||'').replace(/[^0-9]/g,'');
  var account=($('f_account').value||'').replace(/[^0-9]/g,'');
  if(routing.length!==9)return showErr('A routing number is exactly 9 digits.');
  if(account.length<4)return showErr('Please enter your full account number.');

  if(!$('f_agree').checked)return showErr('Please tick the box to confirm you agree.');
  var signature=($('f_sign').value||'').trim();
  if(signature.length<2)return showErr('Type your full name to sign.');

  var btn=$('submit');
  var label=$('submitlabel');
  btn.disabled=true;
  var was=label.textContent;
  label.textContent='Sending…';

  uploadFile(file).then(function(storageId){
    var common={
      payeeName:name,
      payeeEmail:email,
      payeePhone:($('f_phone').value||'').trim()||undefined,
      payeeBusinessName:($('f_business').value||'').trim()||undefined,
      taxDocStorageId:storageId,
      taxDocKind:taxKind(),
      taxDocFileName:file.name,
      /* Raw digits, once, to a route that links them with our bank and never
         writes them down. Nothing here ever comes back to the page. */
      routingNumber:routing,
      accountNumber:account,
      accountHolderName:($('f_holder').value||'').trim()||undefined,
      funding:$('f_funding').value||'checking',
      signature:signature
    };
    if(C.mode==='agreement'){
      common.token=C.token;
      return api('/api/contract/complete',common);
    }
    common.chapterSlug=C.slug;
    common.serviceDescription=descText;
    common.serviceDate=serviceMs==null?undefined:serviceMs;
    common.requestedAmountCents=cents;
    common.agreementNotes=($('f_notes').value||'').trim()||undefined;
    return api('/api/contract/request',common);
  }).then(function(res){
    /* Both paths land on the same status page, addressed by the token: the
       agreement already has one, a fresh request gets one back. */
    var token=C.mode==='agreement'?C.token:res.token;
    window.location.href='/contract/'+encodeURIComponent(C.slug)+'?token='+encodeURIComponent(token);
  }).catch(function(err){
    btn.disabled=false;
    label.textContent=was;
    showErr((err&&err.message)||'Something went wrong. Please try again.');
  });
}

$('submit').addEventListener('click',submit);
})();
`;
