/**
 * CSS for the public `/give` map + `/give/<slug>` campaign pages (F-6 P3).
 * Appended after `BASE_CSS` (`landingPageStyles.ts`), same house pattern as
 * `LANDING_CSS` — one brand palette, no external stylesheet.
 */
export const GIVE_CSS = `
main.give{max-width:1080px;margin:0 auto;padding:20px 20px 96px}
.give-topbar{display:flex;justify-content:center;padding:10px 0 26px}
.give-hero{text-align:center;max-width:640px;margin:0 auto 28px}
.give-hero h1{font-size:clamp(30px,5vw,44px);line-height:1.12;font-weight:700;margin-bottom:10px;letter-spacing:-.01em}
.give-hero p{font-size:16px;color:var(--muted);line-height:1.55}

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

/* ── city list fallback (mobile + accessibility) ── */
.citylist{margin-top:28px}
.citylist h2{font-family:'Corben',Georgia,serif;font-size:21px;font-weight:400;margin-bottom:14px}
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

.ladder{margin-bottom:28px}
.ladder h2,.explainer h2,.backer-form h2{font-family:'Corben',Georgia,serif;font-size:21px;
  font-weight:400;display:flex;align-items:center;gap:10px;margin-bottom:14px}
.ladder h2::after,.explainer h2::after{content:"";height:1px;flex:1;background:var(--border)}
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

.explainer{margin-bottom:28px}
.explainer .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
.explainer .fact{border:1px solid var(--border);border-radius:16px;padding:16px;background:var(--raised)}
.explainer .fact .k{font-family:'Corben',Georgia,serif;font-size:22px;color:var(--accent)}
.explainer .fact .v{font-size:13px;color:var(--muted);margin-top:4px;line-height:1.4}
.story{white-space:pre-wrap;color:#4A2E2E;font-size:15.5px;line-height:1.65;margin-bottom:28px}

.backer-form{background:var(--raised);border:1px solid var(--border);border-radius:20px;
  padding:22px 24px;box-shadow:var(--shadow);margin-bottom:40px}
.backer-form .amtgrid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:10px}
.backer-form .amtbtn{border:1.5px solid var(--border-strong);border-radius:14px;padding:11px 4px;
  font-weight:700;font-size:15px;color:var(--ink);transition:all .12s;background:none;text-align:center}
.backer-form .amtbtn:hover{border-color:var(--accent);color:var(--accent)}
.backer-form .amtbtn.sel{background:var(--accent-soft);border-color:var(--accent);color:var(--accent);
  box-shadow:0 0 0 3px rgba(210,59,58,.14)}
.backer-form .amtcustom{display:flex;align-items:center;gap:8px;background:var(--raised);
  border:1.5px solid var(--border);border-radius:14px;padding:0 14px;margin-bottom:14px}
.backer-form .amtcustom .cur{color:var(--muted);font-weight:700;font-size:15px}
.backer-form .amtcustom input{flex:1;background:none;border:0;outline:none;padding:12px 0;font-size:15px;color:var(--ink)}
.backer-form .fld{margin-bottom:12px}
.backer-form .fld label{display:block;font-size:12.5px;font-weight:600;color:var(--muted);margin-bottom:5px}
.backer-form .fld input{width:100%;background:var(--raised);border:1.5px solid var(--border);
  border-radius:14px;padding:12px 16px;outline:none;transition:border .15s;font-size:15px;color:var(--ink)}
.backer-form .fld input:focus{border-color:var(--accent)}
.backer-form .submitbtn{width:100%;margin-top:8px;background:var(--accent);color:#fff;font-weight:700;
  font-size:15.5px;border-radius:999px;padding:14px;transition:background .15s;box-shadow:0 6px 18px rgba(210,59,58,.35)}
.backer-form .submitbtn:hover{background:var(--accent-hover)}
.backer-form .submitbtn:disabled{opacity:.6;pointer-events:none}
.backer-form .formerr{color:var(--accent);font-size:13px;margin-top:10px;text-align:center;min-height:16px}
.backer-form .formok{color:var(--success);font-size:13px;margin-top:10px;text-align:center}

.give-404{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;
  text-align:center;padding:24px;gap:10px}
.give-404 h1{font-family:'Corben',Georgia,serif;font-size:34px}
.give-404 p{color:var(--muted);max-width:320px}
`;
