/**
 * CSS for the public `/give` map + `/give/<slug>` territory pages
 * (docs/plans/giving-territories.md). Appended after `BASE_CSS`
 * (`landingPageStyles.ts`), same house pattern as `LANDING_CSS` — one brand
 * palette, no external stylesheet. (The internal `.city-dot`/`.citylist` class
 * names are kept as-is — they're not user-visible copy.)
 *
 * `.givecard` is the one generic "form in a card" look shared by the one-time
 * gift form, the monthly/backer form, and the interest form — each just
 * supplies its own fields inside (see `givePageSections.ts`).
 */
export const GIVE_CSS = `
main.give{max-width:1080px;margin:0 auto;padding:20px 20px 96px}
.give-topbar{display:flex;justify-content:center;align-items:center;position:relative;padding:10px 0 26px}

/* ── BUG FIX: .wordmark and .hearts live in LANDING_CSS, which the give pages
   never load (they load BASE_CSS + GIVE_CSS only — see givePage.ts's <style>).
   The result was the logotype at the top of the donation page rendering as
   plain 16px black body text, and the footer heart in ink rather than accent.
   Duplicated here rather than pulling in the whole landing stylesheet. ── */
.wordmark{font-weight:700;font-size:12px;letter-spacing:.22em;color:var(--accent)}
.hearts{color:var(--accent)}

/* ── topbar nav: the books link, on every give page ──
   /finances has existed and been unlinked from /give since it shipped. The
   single most persuasive asset the org has was reachable only by typing the
   URL. */
.give-topnav{position:absolute;right:0;top:50%;transform:translateY(-50%);display:flex;gap:8px}
.give-navlink{display:inline-flex;align-items:center;gap:6px;background:var(--raised);
  border:1px solid var(--border);border-radius:999px;padding:7px 14px;text-decoration:none;
  font-size:12.5px;font-weight:600;color:var(--accent);box-shadow:var(--shadow);white-space:nowrap}
.give-navlink:hover{background:var(--accent-soft)}
@media(max-width:620px){.give-topnav{display:none}}
.give-hero{text-align:center;max-width:640px;margin:0 auto 28px}
.give-hero h1{font-size:clamp(30px,5vw,44px);line-height:1.12;font-weight:700;margin-bottom:10px;letter-spacing:-.01em}
.give-hero p{font-size:16px;color:var(--muted);line-height:1.55}

/* ── generic section header (Corben + a trailing rule) ── */
.sectionhead{font-family:'Corben',Georgia,serif;font-size:21px;font-weight:400;
  display:flex;align-items:center;gap:10px;margin:8px 0 14px}
.sectionhead::after{content:"";height:1px;flex:1;background:var(--border)}
section{margin-bottom:32px}

/* ── map ── */
.mapwrap{background:var(--raised);border:1px solid var(--border);border-radius:24px;
  padding:14px;box-shadow:var(--shadow);margin-bottom:22px}
.mapwrap svg{width:100%;height:auto;display:block;border-radius:16px;background:var(--sunken)}
.us-outline{fill:var(--peach);fill-opacity:.55;stroke:var(--border-strong);stroke-width:1.5}
.city-dot{cursor:pointer}
.city-dot circle.ring{fill:none;stroke-width:2;opacity:.35}
.city-dot circle.core{stroke:#fff;stroke-width:1.5}
.city-dot:hover circle.core{r:9}
.city-dot.launched circle.core{fill:var(--success)}
.city-dot.launched circle.ring{stroke:var(--success)}
.city-dot.raising circle.core{fill:var(--accent)}
.city-dot.raising circle.ring{stroke:var(--accent)}
.city-dot.prospect circle.core{fill:var(--muted)}
.city-dot.prospect circle.ring{stroke:var(--muted)}
.city-dot text{font-family:'DM Sans',sans-serif;font-size:11px;font-weight:600;fill:var(--ink);pointer-events:none}
.map-empty{padding:60px 20px;text-align:center;color:var(--muted)}

.legend{display:flex;flex-wrap:wrap;gap:16px;justify-content:center;padding:12px 4px 0;font-size:13px;color:var(--muted)}
.legend .item{display:flex;align-items:center;gap:6px}
.legend .swatch{width:11px;height:11px;border-radius:50%;display:inline-block}
.legend .swatch.launched{background:var(--success)}
.legend .swatch.raising{background:var(--accent)}
.legend .swatch.prospect{background:var(--muted)}

/* ── active-raise goal cards (map page) ── */
.raisecards{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;margin-bottom:22px}
.raisecard{display:block;border:1px solid var(--border);border-radius:16px;background:var(--raised);
  padding:16px;box-shadow:var(--shadow);text-decoration:none;color:inherit;transition:border-color .15s}
.raisecard:hover{border-color:var(--accent)}
.raisecard .rc-name{font-weight:700;font-size:15px;color:var(--ink)}
.raisecard .rc-stat{font-size:13px;color:var(--muted);margin:3px 0 8px}
.raisetrack{height:8px;border-radius:999px;background:var(--sunken);overflow:hidden}
.raisefill{height:100%;border-radius:999px;background:linear-gradient(90deg,var(--accent),var(--accent-hover))}
.raise-empty{text-align:center;color:var(--muted);font-size:14px;padding:8px 0 22px}

/* ── city list fallback (mobile + accessibility) ── */
.citylist{margin-top:0}
.citylist .row{display:flex;align-items:center;justify-content:space-between;gap:12px;
  padding:13px 16px;border:1px solid var(--border);border-radius:14px;background:var(--raised);
  margin-bottom:8px;text-decoration:none;color:inherit;transition:border-color .15s}
.citylist .row:hover{border-color:var(--accent)}
.citylist .row .info .nm{font-weight:600;font-size:15px;color:var(--ink)}
.citylist .row .info .rg{font-size:12.5px;color:var(--muted);margin-top:1px}
.citylist .row .stat{display:flex;align-items:center;gap:8px}
.citylist .row .count{font-size:13.5px;color:var(--muted);white-space:nowrap}

/* ── status chip ── */
.chip{display:inline-flex;align-items:center;gap:5px;border-radius:999px;padding:3px 11px;
  font-size:11.5px;font-weight:700;letter-spacing:.02em;text-transform:uppercase}
.chip.launched{background:#EAF6F0;color:var(--success)}
.chip.raising{background:var(--accent-soft);color:var(--accent)}
.chip.prospect{background:var(--sunken);color:var(--muted)}

/* ── campaign page ── */
.give-back{display:inline-flex;align-items:center;gap:6px;font-size:13.5px;font-weight:600;
  color:var(--muted);margin-bottom:18px}
.campaign-head{margin-bottom:22px}
.campaign-head h1{font-size:clamp(30px,5vw,44px);line-height:1.1;font-weight:700;margin:8px 0 4px;letter-spacing:-.01em}
.campaign-head .region{color:var(--muted);font-size:15px}

.thankyou{border-radius:16px;padding:14px 18px;margin-bottom:20px;font-size:14.5px;font-weight:600;
  display:flex;align-items:center;gap:10px}
.thankyou.success{background:#EAF6F0;color:var(--success);border:1px solid #BFE3D0}
.thankyou.canceled{background:var(--sunken);color:var(--muted);border:1px solid var(--border)}

.progress-card{background:var(--raised);border:1px solid var(--border);border-radius:20px;
  padding:22px 24px;margin-bottom:24px;box-shadow:var(--shadow)}
.progress-count{font-family:'Corben',Georgia,serif;font-size:26px;margin-bottom:2px}
.progress-count b{color:var(--accent)}
.progress-sub{font-size:13.5px;color:var(--muted);margin-bottom:14px}
.progress-track{height:12px;border-radius:999px;background:var(--sunken);overflow:hidden}
.progress-fill{height:100%;background:linear-gradient(90deg,var(--accent),var(--accent-hover));
  border-radius:999px;transition:width .3s}

.launch-fund{margin-bottom:28px;border:1px solid var(--border);border-radius:16px;
  padding:18px 18px 16px;background:var(--raised)}
.launch-fund h2{font-family:'Corben',Georgia,serif;font-size:19px;font-weight:400;margin-bottom:6px}
.lf-amount{font-size:15px;color:var(--muted);margin-bottom:12px}
.lf-amount b{color:var(--accent);font-size:22px}
.lf-bars{display:flex;align-items:flex-end;gap:6px;height:96px;margin:16px 0 10px}
.lf-bar{flex:1;display:flex;flex-direction:column;align-items:center;gap:6px;min-width:0}
.lf-bar-track{width:100%;height:72px;display:flex;align-items:flex-end;
  background:var(--sunken);border-radius:6px;overflow:hidden}
.lf-bar-fill{width:100%;background:linear-gradient(180deg,var(--accent-hover),var(--accent));
  border-radius:6px 6px 0 0;min-height:2px;transition:height .3s}
.lf-bar-lbl{font-size:10px;color:var(--faint);white-space:nowrap}
.lf-note{font-size:13px;color:var(--muted);line-height:1.5;margin-top:4px}

.ladder{margin-bottom:28px}
.rung{display:flex;gap:14px;align-items:flex-start;border:1px solid var(--border);border-radius:16px;
  padding:14px 16px;margin-bottom:10px;background:var(--raised)}
.rung.unlocked{border-color:#BFE3D0;background:#F5FBF8}
.rung.next{border-color:var(--accent);box-shadow:0 0 0 3px rgba(210,59,58,.10)}
.rung .badge{width:38px;height:38px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;
  justify-content:center;font-weight:700;font-size:13px;background:var(--sunken);color:var(--muted)}
.rung.unlocked .badge{background:var(--success);color:#fff}
.rung.next .badge{background:var(--accent);color:#fff}
.rung .rt{flex:1;min-width:0}
.rung .rt .lb{font-weight:700;font-size:15px;color:var(--ink)}
.rung .rt .cm{font-size:13.5px;color:var(--muted);margin-top:1px}
.rung .rt .ds{font-size:13px;color:var(--muted);margin-top:4px;line-height:1.45}
.next-callout{background:var(--accent-soft);border:1px dashed var(--accent);border-radius:14px;
  padding:12px 16px;font-size:14px;color:var(--accent-hover);font-weight:600;margin-bottom:20px}

/* ── BUG FIX: these were scoped \`.explainer .fact\`, but no element with
   class="explainer" exists anywhere in givePage.ts or givePageSections.ts —
   the descendant selector never matched, so the 85/15 split figures (the two
   most quotable numbers on the page) rendered as plain body text. The
   \`.explainer\` wrapper was removed with an earlier section and the rules were
   left behind. Unprefixed here so \`.fact\` styles wherever it is used. ── */
.fact{border:1px solid var(--border);border-radius:16px;padding:16px;background:var(--raised)}
.fact .k{font-family:'Corben',Georgia,serif;font-size:22px;color:var(--accent)}
.fact .v{font-size:13px;color:var(--muted);margin-top:4px;line-height:1.4}
.story{white-space:pre-wrap;color:#4A2E2E;font-size:15.5px;line-height:1.65;margin-bottom:28px}

/* ── founding / New York callout ── */
.founding-callout{border:1px solid var(--border-strong);border-radius:16px;
  padding:18px 20px;background:var(--sunken)}
.founding-callout p{color:#4A2E2E;font-size:14.5px;line-height:1.6}

/* ── program cards ("what your backing makes happen") ── */
.programgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px}
.programcard{border:1px solid var(--border);border-radius:18px;padding:18px;background:var(--raised);box-shadow:var(--shadow)}
.programcard .picon{font-size:26px;margin-bottom:6px}
.programcard .ptitle{font-family:'Corben',Georgia,serif;font-size:17px;margin-bottom:6px}
.programcard .pbody{font-size:13.5px;color:var(--muted);line-height:1.55}
.programcard .plink{display:inline-block;margin-top:10px;font-size:13px;font-weight:700;color:var(--accent);text-decoration:none}
.programcard .plink:hover{text-decoration:underline}

/* ── give forms (generic card, shared by one-time / monthly / interest) ── */
.givecard{background:var(--raised);border:1px solid var(--border);border-radius:20px;
  padding:22px 24px;box-shadow:var(--shadow);margin-bottom:22px}
.givecard .givecard-head{margin-bottom:14px}
.givecard .givecard-head h2{font-family:'Corben',Georgia,serif;font-size:21px;font-weight:400}
.givecard .givecard-head p{font-size:13.5px;color:var(--muted);margin-top:4px;line-height:1.5}
/* auto-fit, not repeat(4,1fr): a pre-launch territory's one-time ladder tops
   out at $1,000 (LAUNCH_FUND_ONE_TIME_PRESETS_CENTS), and a fixed quarter of a
   360px viewport leaves ~54px of content box — not enough for "$1,000" at
   15px/700, so the label wrapped or overflowed its button. */
.amtgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(72px,1fr));gap:8px;margin-bottom:10px}
.amtbtn{border:1.5px solid var(--border-strong);border-radius:14px;padding:11px 4px;
  font-weight:700;font-size:15px;color:var(--ink);transition:all .12s;background:none;text-align:center}
.amtbtn:hover{border-color:var(--accent);color:var(--accent)}
.amtbtn.sel{background:var(--accent-soft);border-color:var(--accent);color:var(--accent);
  box-shadow:0 0 0 3px rgba(210,59,58,.14)}
.amtcustom{display:flex;align-items:center;gap:8px;background:var(--raised);
  border:1.5px solid var(--border);border-radius:14px;padding:0 14px;margin-bottom:14px}
.amtcustom .cur{color:var(--muted);font-weight:700;font-size:15px}
.amtcustom input{flex:1;background:none;border:0;outline:none;padding:12px 0;font-size:15px;color:var(--ink)}
.recurring-note{background:var(--accent-soft);border:1px dashed var(--accent);border-radius:12px;
  padding:9px 12px;font-size:12.5px;color:var(--accent-hover);line-height:1.4;margin:-2px 0 14px}
.fld{margin-bottom:12px}
.fld label{display:block;font-size:12.5px;font-weight:600;color:var(--muted);margin-bottom:5px}
.fld input,.fld textarea{width:100%;background:var(--raised);border:1.5px solid var(--border);
  border-radius:14px;padding:12px 16px;outline:none;transition:border .15s;font-size:15px;color:var(--ink);resize:vertical}
.fld input:focus,.fld textarea:focus{border-color:var(--accent)}
.submitbtn{width:100%;margin-top:8px;background:var(--accent);color:#fff;font-weight:700;
  font-size:15.5px;border-radius:999px;padding:14px;transition:background .15s;box-shadow:0 6px 18px rgba(210,59,58,.35)}
.submitbtn:hover{background:var(--accent-hover)}
.submitbtn:disabled{opacity:.6;pointer-events:none}
.formerr{color:var(--accent);font-size:13px;margin-top:10px;text-align:center;min-height:16px}
.formok{color:var(--success);font-size:13px;margin-top:10px;text-align:center}
.transparency-note{font-size:12px;color:var(--faint);text-align:center;line-height:1.5;margin-top:6px}
.giveprompt{font-size:13.5px;color:var(--muted);line-height:1.55;margin-bottom:16px}

/* ── give-box tabs (territory page: monthly vs one-time) ── */
.give-tabs{display:flex;gap:8px;margin-bottom:16px}
.tab-btn{flex:1;border:1.5px solid var(--border-strong);border-radius:999px;padding:10px 4px;
  font-weight:700;font-size:14px;color:var(--muted);transition:all .12s;text-align:center}
.tab-btn:hover{border-color:var(--accent);color:var(--accent)}
.tab-btn.active{background:var(--accent-soft);border-color:var(--accent);color:var(--accent);
  box-shadow:0 0 0 3px rgba(210,59,58,.14)}
.tab-panel{display:none}
.tab-panel.active{display:block}

/* ── interest / suggest-a-space (F4: multi-select checkboxes) ── */
.interest-count{font-size:14px;color:var(--muted);margin-bottom:14px}
.interest-opts{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:8px;margin-bottom:16px}
.interest-opt{display:flex;align-items:flex-start;gap:10px;text-align:left;cursor:pointer;
  border:1.5px solid var(--border-strong);border-radius:14px;padding:11px 14px;transition:all .12s;background:none}
.interest-opt:hover{border-color:var(--accent)}
.interest-opt:has(input:checked){background:var(--accent-soft);border-color:var(--accent);
  box-shadow:0 0 0 3px rgba(210,59,58,.14)}
.interest-opt input[type="checkbox"]{width:16px;height:16px;margin-top:2px;accent-color:var(--accent);flex-shrink:0}
.interest-opt .io-text{display:flex;flex-direction:column;gap:3px}
.interest-opt .io-label{font-weight:700;font-size:13.5px;color:var(--ink)}
.interest-opt .io-hint{font-size:12px;color:var(--muted)}
.interest-hint{font-size:12.5px;color:var(--faint);margin:-6px 0 10px}

/* ── founding-team progressive reveal (F4: roles, skills, church, phone, social) ── */
.jointeam-fld{border:1px dashed var(--border-strong);border-radius:14px;padding:14px;margin-bottom:14px;background:var(--sunken)}
.jointeam-fld > .fld:last-child{margin-bottom:0}
.jointeam-note{font-size:12.5px;color:var(--muted);line-height:1.5;margin-bottom:10px}
.role-opts{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:6px;margin-bottom:4px}
.role-opt{display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--ink);border:1px solid var(--border);
  border-radius:10px;padding:6px 10px;cursor:pointer;background:var(--raised)}
.role-opt:has(input:checked){background:var(--accent-soft);border-color:var(--accent)}
.role-opt input{width:14px;height:14px;accent-color:var(--accent)}

/* ── share-on-wall extras (F6, shared by the monthly + one-time forms) ── */
/* flex-start (not center): the consent label now names both things that go
   public, so it wraps to two lines on a phone and a centred box would float
   away from the first line. */
.sharewall{display:flex;align-items:flex-start;gap:8px;font-size:13px;color:var(--ink);margin:-2px 0 6px;cursor:pointer;line-height:1.4}
.sharewall input{width:16px;height:16px;accent-color:var(--accent);flex:0 0 auto;margin-top:1px}
/* The plain-language expansion under the consent box: what is public, what
   never is. Muted and small — it explains the checkbox, it isn't a second ask. */
.sharewall-hint{font-size:12px;line-height:1.45;color:var(--muted);margin:0 0 14px 24px}
/* The card-or-bank-transfer footnote under the submit button. Centred and
   quiet — it sets an expectation on the way to Stripe, it isn't a warning. */
.paynote{font-size:12px;line-height:1.45;color:var(--muted);margin:10px 0 0;text-align:center}
/* "How are you paying?" — the rail picker (.paypick), asked before we quote a
   fee so the quote can be the rail's real rate. Two stacked rows rather than
   side-by-side buttons: each carries a rate underneath it, and two columns of
   small print on a phone is where a donor stops reading. The whole row is the
   label so the tap target is the row, not the 16px radio. */
.paypick{border:0;padding:0;margin:0 0 14px}
.paypick legend{font-size:13px;color:var(--ink);font-weight:600;padding:0;margin:0 0 8px}
.payopt{display:flex;align-items:center;gap:8px;cursor:pointer;
  border:1.5px solid var(--border-strong);border-radius:12px;padding:10px 12px;
  font-size:13.5px;color:var(--ink);line-height:1.35;margin-bottom:8px}
.payopt:last-child{margin-bottom:0}
.payopt:hover{border-color:var(--accent)}
.payopt.sel{background:var(--accent-soft);border-color:var(--accent)}
.payopt input{width:16px;height:16px;accent-color:var(--accent);flex:0 0 auto}
.payopt-name{font-weight:600;flex:0 0 auto}
/* The live rate off the real schedule. Muted and pushed right — it is evidence
   for the choice, not the choice itself. */
.payopt-rate{color:var(--muted);font-size:12px;margin-left:auto;text-align:right}
/* The live "you'll be charged X, and Y reaches us" line under the cover-fees
   box. Indented to sit under the hint it follows, and in the ink colour rather
   than muted: it is a number the donor is agreeing to, not small print. */
.covline{font-size:12.5px;line-height:1.45;color:var(--ink);margin:-8px 0 14px 24px;font-weight:600}
/* The bank-transfer suggestion above a large gift. Same treatment as
   .recurring-note — an inline, conditional, JS-toggled aside rather than
   anything that looks like a warning or an interruption. */
.achnote{background:var(--accent-soft);border:1px dashed var(--accent);border-radius:12px;
  padding:9px 12px;font-size:12.5px;color:var(--accent-hover);line-height:1.4;margin:-2px 0 14px}

/* ── one-time → City Launch Fund framing (F5, territory pre-launch) ── */
.onetime-launch-intro{margin-bottom:14px}
.onetime-launch-intro h3{font-family:'Corben',Georgia,serif;font-size:16px;font-weight:400;margin-bottom:4px}
.onetime-launch-intro p{font-size:13px;color:var(--muted);line-height:1.5}

/* ── money transparency (F2, both pages) ── */
.moneybox .lead{color:var(--muted);font-size:15px;line-height:1.6;margin-bottom:16px}
.mt-h3{font-family:'Corben',Georgia,serif;font-size:16px;font-weight:400;margin:18px 0 8px}
.mt-table-wrap{overflow-x:auto;margin-bottom:16px}
.mt-table{width:100%;border-collapse:collapse;font-size:13.5px}
.mt-table th,.mt-table td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--border)}
.mt-table th{color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.02em}
.mt-detail{border:1px solid var(--border);border-radius:14px;padding:14px 16px;margin-bottom:14px;background:var(--raised)}
.mt-detail summary{cursor:pointer;font-weight:700;font-size:14.5px;color:var(--ink)}
.mt-detail .mt-sub{font-size:12.5px;font-weight:700;color:var(--muted);margin:12px 0 4px;text-transform:uppercase;letter-spacing:.02em}
.mt-lines{margin-top:8px}
.mt-line{display:flex;justify-content:space-between;gap:12px;font-size:13.5px;color:var(--muted);padding:4px 0}
.mt-line-note{color:var(--faint);font-size:12px}
.mt-total{display:flex;justify-content:space-between;font-weight:700;font-size:14px;color:var(--ink);
  border-top:1px solid var(--border);margin-top:8px;padding-top:8px}
.mt-total-grand{color:var(--accent)}
.mt-split{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:16px}
.mt-backer-def{font-size:13px;color:var(--muted);line-height:1.5}

/* ── sustain section (F3, territory, launched-but-under-backed) ── */
.sustainbox{border:1px solid var(--border);border-radius:20px;padding:20px 22px;background:var(--sunken)}
.sustainbox > p{color:#4A2E2E;font-size:14.5px;line-height:1.6;margin-bottom:16px}
.sustain-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-bottom:16px}
.sustain-item{background:var(--raised);border:1px solid var(--border);border-radius:14px;padding:14px}
.sustain-item h3{font-size:14px;margin-bottom:4px}
.sustain-item p{font-size:13px;color:var(--muted);line-height:1.5}
.fundraiser-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
.fundraiser-card{display:block;border:1px solid var(--border);border-radius:14px;background:var(--raised);
  padding:14px;text-decoration:none;color:inherit;transition:border-color .15s}
.fundraiser-card:hover{border-color:var(--accent)}
.fundraiser-card .fc-name{font-weight:700;font-size:14px;color:var(--ink)}
.fundraiser-card .fc-stat{font-size:12.5px;color:var(--muted);margin:3px 0 8px}
.fundraiser-empty{font-size:13.5px;color:var(--muted)}

/* ── activity wall (F6, territory) ── */
.activitywall{border:1px solid var(--border);border-radius:20px;padding:18px 20px;background:var(--raised)}
.activity-list{display:flex;flex-direction:column;gap:12px}
.activity-item{border-bottom:1px solid var(--border);padding-bottom:12px}
.activity-item:last-child{border-bottom:0;padding-bottom:0}
.ai-line{font-size:14px;color:var(--ink)}
.ai-msg{font-size:13.5px;color:var(--muted);font-style:italic;margin-top:3px}
.ai-time{font-size:11.5px;color:var(--faint);margin-top:3px}
.activity-empty{color:var(--muted);font-size:14px}

/* ── team philosophy (F7, both pages) ── */
.teamphilo p{color:var(--muted);font-size:14.5px;line-height:1.65;margin-bottom:12px}
.teamphilo-quote{font-family:'Corben',Georgia,serif;font-size:16px;color:var(--accent);font-style:italic}

/* ══ v3 redesign (docs/plans/give-redesign-v3.md) ══════════════════════════ */

/* ── hero: two CTAs, the backer ask primary and "give once" a peer link ──
   Not a tab pair. Tabs make the two asks look equal-weight while hiding one
   of them; here the hierarchy is the point (D1) and both stay visible. */
.hero-cta{display:flex;gap:10px;margin-top:22px;justify-content:center;flex-wrap:wrap}
.ctabtn{border-radius:999px;padding:15px 28px;font-weight:700;font-size:15.5px;
  text-align:center;transition:all .15s;display:inline-block;text-decoration:none}
.ctabtn.primary{background:var(--accent);color:#fff;box-shadow:0 6px 18px rgba(210,59,58,.35)}
.ctabtn.primary:hover{background:var(--accent-hover)}
.ctabtn.secondary{background:var(--raised);color:var(--accent);border:1.5px solid var(--accent)}
.ctabtn.secondary:hover{background:var(--accent-soft)}

/* ── proof strip: four auditable numbers, above the fold ── */
.proofstrip{display:grid;grid-template-columns:repeat(auto-fit,minmax(158px,1fr));
  gap:1px;background:var(--border);border:1px solid var(--border);border-radius:20px;
  overflow:hidden;box-shadow:var(--shadow);margin-bottom:34px}
.proofcell{background:var(--raised);padding:18px;text-align:center}
.proofcell .pk{font-family:'Corben',Georgia,serif;font-size:27px;line-height:1.1;
  color:var(--accent);font-variant-numeric:tabular-nums}
.proofcell .pv{font-size:12.5px;color:var(--muted);margin-top:5px;line-height:1.42}

/* ── back a city: the page's centre of gravity ── */
.citygrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(232px,1fr));gap:14px}
.citycard{display:flex;flex-direction:column;border:1px solid var(--border);border-radius:20px;
  background:var(--raised);padding:20px;box-shadow:var(--shadow);
  text-decoration:none;color:inherit;transition:border-color .15s,transform .15s}
.citycard:hover{border-color:var(--accent);transform:translateY(-2px)}
.citycard.flagship{border-color:var(--accent);box-shadow:0 0 0 3px rgba(210,59,58,.10),var(--shadow)}
.cc-top{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:12px}
.cc-name{font-family:'Corben',Georgia,serif;font-size:22px;color:var(--ink);line-height:1.15}
.cc-region{font-size:12.5px;color:var(--muted);margin-top:3px}
.cc-count{font-size:14.5px;color:var(--muted);margin-bottom:9px}
.cc-count b{color:var(--ink);font-weight:700;font-variant-numeric:tabular-nums}
.cc-next{font-size:12.5px;color:var(--muted);margin-top:10px;line-height:1.45;flex:1}
.cc-next b{color:var(--accent)}
.cc-body{font-size:13.5px;color:var(--muted);line-height:1.5;flex:1}
.cc-cta{display:block;margin-top:15px;text-align:center;background:var(--accent);color:#fff;
  font-weight:700;font-size:13.5px;border-radius:999px;padding:11px 8px;
  box-shadow:0 4px 14px rgba(210,59,58,.28);text-wrap:balance}
.citycard.prospectcard{background:var(--sunken);box-shadow:none;border-style:dashed;border-color:var(--border-strong)}
.citycard.prospectcard .cc-cta{background:var(--raised);color:var(--accent);
  border:1.5px solid var(--accent);box-shadow:none}

/* ── the wall: the give pages' own giving, anonymous by default (spec D6) ── */
.wallbox{border:1px solid var(--border);border-radius:22px;background:var(--raised);
  box-shadow:var(--shadow);overflow:hidden}
.wallhead{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;
  padding:20px 22px 16px;border-bottom:1px solid var(--border);background:var(--sunken)}
.wallhead .wh-k{font-family:'Corben',Georgia,serif;font-size:30px;color:var(--accent);
  line-height:1.05;font-variant-numeric:tabular-nums}
.wallhead .wh-v{font-size:13px;color:var(--muted);margin-top:4px;line-height:1.45}
.livepill{display:inline-flex;align-items:center;gap:7px;background:var(--raised);
  border:1px solid var(--border);border-radius:999px;padding:6px 13px;
  font-size:12px;font-weight:700;color:var(--success)}
.livepill .blip{width:7px;height:7px;border-radius:50%;background:var(--success);
  animation:blip 2.4s ease-in-out infinite}
@keyframes blip{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.8)}}
@media (prefers-reduced-motion:reduce){.livepill .blip{animation:none}}
.wallrow{display:flex;align-items:flex-start;gap:13px;padding:14px 22px;border-bottom:1px solid var(--border)}
.wallrow:last-child{border-bottom:0}
.wr-av{width:36px;height:36px;border-radius:50%;flex:0 0 auto;display:flex;
  align-items:center;justify-content:center;font-size:15px;background:var(--accent-soft)}
.wallrow.backer .wr-av{background:#EAF6F0}
.wr-body{flex:1;min-width:0}
.wr-line{font-size:14.5px;color:var(--ink);line-height:1.4}
.wr-amt{font-weight:700;color:var(--accent);font-variant-numeric:tabular-nums}
.wr-city{color:var(--muted)}
.wr-msg{font-size:13.5px;color:var(--muted);font-style:italic;margin-top:4px;line-height:1.45}
.wr-time{font-size:11.5px;color:var(--faint);margin-top:4px}
.wr-tag{font-size:10.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;
  border-radius:5px;padding:2px 7px;margin-left:7px;vertical-align:1px;white-space:nowrap}
.wr-tag.mo{background:#EAF6F0;color:var(--success)}
.wr-tag.once{background:var(--accent-soft);color:var(--accent)}
.wr-tag.central{background:var(--sunken);color:var(--muted)}
.wr-goal{margin-top:8px;max-width:280px}
.wg-track{height:6px;border-radius:999px;background:var(--sunken);overflow:hidden}
.wg-fill{height:100%;border-radius:999px;background:linear-gradient(90deg,var(--accent),var(--accent-hover))}
.wg-lbl{font-size:12px;color:var(--muted);margin-top:5px;font-variant-numeric:tabular-nums}
.wg-lbl b{color:var(--accent)}
.wallfoot{padding:14px 22px;background:var(--sunken);font-size:12.5px;
  color:var(--muted);text-align:center;line-height:1.5}

/* ── give once: destination first, amount second ── */
.oncebox{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.05fr);
  border:1px solid var(--border);border-radius:22px;overflow:hidden;
  background:var(--raised);box-shadow:var(--shadow)}
@media(max-width:760px){.oncebox{grid-template-columns:1fr}}
.once-l{padding:24px;background:var(--sunken);border-right:1px solid var(--border)}
@media(max-width:760px){.once-l{border-right:0;border-bottom:1px solid var(--border)}}
.once-l h2{font-family:'Corben',Georgia,serif;font-size:21px;font-weight:400;margin-bottom:8px}
.once-l p{font-size:14px;color:var(--muted);line-height:1.58;margin-bottom:14px}
.once-r{padding:24px}
.destpick{display:flex;flex-direction:column;gap:8px;border:0;padding:0;margin:0}
.destopt{display:flex;align-items:flex-start;gap:10px;cursor:pointer;
  border:1.5px solid var(--border-strong);border-radius:14px;padding:12px 14px;
  background:var(--raised);transition:all .12s}
.destopt:hover{border-color:var(--accent)}
.destopt.sel{background:var(--accent-soft);border-color:var(--accent);box-shadow:0 0 0 3px rgba(210,59,58,.14)}
.destopt input{width:16px;height:16px;margin-top:2px;accent-color:var(--accent);flex:0 0 auto}
.destopt .dt{font-weight:700;font-size:13.5px;color:var(--ink);display:block}
.destopt .dh{font-size:12px;color:var(--muted);margin-top:2px;display:block;line-height:1.4}
.destcity{margin-top:10px}
.destcity select{width:100%;background:var(--raised);border:1.5px solid var(--border);
  border-radius:14px;padding:12px 16px;font-size:15px;color:var(--ink);outline:none}
.destcity[hidden]{display:none}
/* The city <select> is introduced by the radio it belongs to, so a visible
   label would be redundant — but a bare select is unlabelled to a screen
   reader, which is not. */
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;
  clip:rect(0,0,0,0);white-space:nowrap;border:0}

/* ── money teaser: three facts and two links, replacing ~450 words ── */
.moneyteaser{border:1px solid var(--border-strong);border-radius:22px;
  background:var(--sunken);padding:26px 26px 24px}
.moneyteaser h2{font-family:'Corben',Georgia,serif;font-size:23px;font-weight:400;margin-bottom:10px}
.moneyteaser .mt-lead{font-size:14.5px;color:#4A2E2E;line-height:1.62;max-width:62ch}
.moneyteaser .mt-lead + .mt-lead{margin-top:10px}
.moneyteaser .sharp{color:var(--ink);font-weight:600}
.mt-facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));
  gap:12px;margin:20px 0}
.mt-links{display:flex;gap:10px;flex-wrap:wrap}
.mt-links .ctabtn{padding:12px 22px;font-size:14.5px}

/* ── this book is public: the /finances doorway ── */
.booklink{display:flex;align-items:center;gap:14px;border:1px solid var(--border-strong);
  border-radius:18px;background:var(--sunken);padding:18px 20px;margin-bottom:28px}
.booklink .bl-ic{width:44px;height:44px;border-radius:12px;background:var(--raised);
  border:1px solid var(--border);display:flex;align-items:center;justify-content:center;
  font-size:20px;flex:0 0 auto}
.booklink .bl-t{font-weight:700;font-size:14.5px;color:var(--ink)}
.booklink .bl-s{font-size:13px;color:var(--muted);margin-top:2px;line-height:1.45}

/* ── fundraisers: open AND finished, all giveable (spec D9) ── */
.fundgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:14px}
.fundcard{display:flex;flex-direction:column;border:1px solid var(--border);border-radius:18px;
  background:var(--raised);padding:18px;box-shadow:var(--shadow)}
.fundcard.past{background:var(--sunken);box-shadow:none;border-color:var(--border-strong)}
.fc-top{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:4px}
.fc-name{font-family:'Corben',Georgia,serif;font-size:17px;color:var(--ink);line-height:1.25}
.fc-when{font-size:12.5px;color:var(--muted);margin-bottom:12px}
.fc-track{height:8px;border-radius:999px;background:var(--sunken);overflow:hidden}
.fundcard.past .fc-track{background:var(--raised)}
.fc-fill{height:100%;border-radius:999px;background:linear-gradient(90deg,var(--accent),var(--accent-hover))}
.fc-fill.met{background:linear-gradient(90deg,var(--success),#1F5C41)}
.fc-lbl{font-size:13px;color:var(--muted);margin:7px 0 12px;font-variant-numeric:tabular-nums}
.fc-lbl b{color:var(--accent)}
.fc-lbl b.met{color:var(--success)}
.fc-body{font-size:13px;color:var(--muted);line-height:1.5;margin-bottom:14px;flex:1}
.fc-cta{display:block;text-align:center;border-radius:999px;padding:10px;font-weight:700;
  font-size:13.5px;background:var(--accent);color:#fff;text-decoration:none;
  box-shadow:0 4px 14px rgba(210,59,58,.28)}
.fundcard.past .fc-cta{background:var(--raised);color:var(--accent);
  border:1.5px solid var(--accent);box-shadow:none}
.fc-chip{font-size:10.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;
  border-radius:5px;padding:3px 8px;flex:0 0 auto}
.fc-chip.live{background:var(--accent-soft);color:var(--accent)}
.fc-chip.done{background:#EAF6F0;color:var(--success)}

/* ── thank-you upgrade: the warmest moment on the site (one-time → backer) ── */
.ty-upgrade{margin-top:12px}
.ty-upgrade .ty-b{font-size:14px;color:#2C4A3C;line-height:1.6;margin-bottom:12px}
.ty-upgrade .ty-b b{color:var(--ink)}
.ty-cta{display:inline-block;background:var(--accent);color:#fff;font-weight:700;
  font-size:14.5px;border-radius:999px;padding:11px 22px;text-decoration:none;
  box-shadow:0 4px 14px rgba(210,59,58,.28)}
.thankyou.stacked{display:block}

/* ── focus: GIVE_CSS defined no :focus-visible at all, so keyboard users got
   the UA default ring on a cream ground. ── */
.give a:focus-visible,.give button:focus-visible,.give input:focus-visible,
.give select:focus-visible,.give textarea:focus-visible{
  outline:2px solid var(--accent);outline-offset:2px}

.give-404{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;
  text-align:center;padding:24px;gap:10px}
.give-404 h1{font-family:'Corben',Georgia,serif;font-size:34px}
.give-404 p{color:var(--muted);max-width:320px}
`;
