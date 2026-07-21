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
.give-topbar{display:flex;justify-content:center;padding:10px 0 26px}
.give-hero{text-align:center;max-width:640px;margin:0 auto 28px}
.give-hero h1{font-size:clamp(30px,5vw,44px);line-height:1.12;font-weight:700;margin-bottom:10px;letter-spacing:-.01em}
.give-hero p{font-size:16px;color:var(--muted);line-height:1.55}

/* ── generic section header (Corben + a trailing rule) ── */
.sectionhead{font-family:'Corben',Georgia,serif;font-size:21px;font-weight:400;
  display:flex;align-items:center;gap:10px;margin:8px 0 14px}
.sectionhead::after{content:"";height:1px;flex:1;background:var(--border)}
section{margin-bottom:32px}

/* ── city launch plan (map page, block #2) ── */
.citylaunch{max-width:720px;margin:0 auto 26px;text-align:center}
.citylaunch .sectionhead{justify-content:center}
.citylaunch .sectionhead::after{display:none}
.citylaunch p{color:var(--muted);font-size:15px;line-height:1.6}

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

.explainer .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
.explainer .fact{border:1px solid var(--border);border-radius:16px;padding:16px;background:var(--raised)}
.explainer .fact .k{font-family:'Corben',Georgia,serif;font-size:22px;color:var(--accent)}
.explainer .fact .v{font-size:13px;color:var(--muted);margin-top:4px;line-height:1.4}
.explainer p.lead{color:var(--muted);font-size:15px;line-height:1.6;margin-bottom:14px}
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

/* ── give forms (generic card, shared by one-time / monthly / interest) ── */
.givecard{background:var(--raised);border:1px solid var(--border);border-radius:20px;
  padding:22px 24px;box-shadow:var(--shadow);margin-bottom:22px}
.givecard .givecard-head{margin-bottom:14px}
.givecard .givecard-head h2{font-family:'Corben',Georgia,serif;font-size:21px;font-weight:400}
.givecard .givecard-head p{font-size:13.5px;color:var(--muted);margin-top:4px;line-height:1.5}
.amtgrid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:10px}
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
.sharewall{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--muted);margin:-2px 0 14px;cursor:pointer}
.sharewall input{width:16px;height:16px;accent-color:var(--accent)}

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

.give-404{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;
  text-align:center;padding:24px;gap:10px}
.give-404 h1{font-family:'Corben',Georgia,serif;font-size:34px}
.give-404 p{color:var(--muted);max-width:320px}
`;
