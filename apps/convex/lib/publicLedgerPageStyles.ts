/**
 * Presentation for the public finances page (`publicLedgerPage.ts`).
 *
 * Appended after `BASE_CSS` (`landingPageStyles.ts`), so this file only
 * carries what the ledger page adds — it inherits the same cream/ink/accent
 * palette, the DM Sans + Corben pairing, and the ambient gradient wash every
 * other public page already uses. A transparency page that looked like a
 * spreadsheet bolted onto the side of the site would read as an afterthought;
 * looking like the rest of the site is part of the claim.
 *
 * Two deliberate constraints, both inherited from the house pattern:
 *  - No external assets beyond the shared font link. The page has to render
 *    identically to somebody auditing it from a locked-down network.
 *  - The ledger table must survive a phone. It scrolls horizontally inside
 *    its own container (`.ledgerwrap`) rather than letting the body scroll,
 *    and the leading Date/Amount columns stay pinned so a row stays
 *    identifiable while a reader scans right.
 */
export const LEDGER_CSS = `
main{max-width:1120px;margin:0 auto;padding:20px 20px 120px;position:relative}
.topbar{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:14px 0 8px;flex-wrap:wrap}
.wordmark{font-weight:700;font-size:12px;letter-spacing:.22em;color:var(--accent);text-decoration:none}
.topnav{display:flex;gap:8px;flex-wrap:wrap}
.topnav a{display:inline-flex;align-items:center;background:var(--raised);border:1px solid var(--border);
  border-radius:999px;padding:6px 14px;font-size:12.5px;font-weight:600;color:var(--accent);
  text-decoration:none;box-shadow:var(--shadow)}
.topnav a:hover{background:var(--accent-soft)}

/* ── Hero ── */
.hero{padding:26px 0 8px}
h1.title{font-size:clamp(34px,5.6vw,54px);line-height:1.06;font-weight:700;letter-spacing:-.015em;margin-bottom:12px}
.lede{font-size:17.5px;color:var(--muted);max-width:62ch}
.lede strong{color:var(--ink);font-weight:600}

/* ── Month picker ── */
.months{display:flex;gap:8px;overflow-x:auto;padding:18px 0 6px;scrollbar-width:thin}
.monthchip{flex:0 0 auto;background:var(--raised);border:1px solid var(--border);border-radius:999px;
  padding:8px 16px;font-size:13.5px;font-weight:600;color:var(--muted);text-decoration:none;white-space:nowrap;
  box-shadow:var(--shadow)}
.monthchip:hover{background:var(--accent-soft);color:var(--accent)}
.monthchip.on{background:var(--accent);border-color:var(--accent);color:#fff}

/* ── Period picker (year + month dropdowns) ── */
.picker{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:20px}
.pickerlabel{font-size:11.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--faint)}
.picker select{background:var(--raised);border:1px solid var(--border);border-radius:999px;
  padding:9px 16px;font-family:inherit;font-size:14.5px;font-weight:600;color:var(--ink);box-shadow:var(--shadow)}
.picker select:hover{border-color:var(--border-strong)}
.picker select option:disabled{color:var(--faint)}
.pickerbtn{background:var(--accent);border-radius:999px;padding:9px 20px;
  font-size:14px;font-weight:700;color:#fff;box-shadow:var(--shadow)}
.pickerbtn:hover{background:var(--accent-hover)}

/* ── Stat row ── */
.stats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin-top:22px}
.stats.four{grid-template-columns:repeat(4,minmax(0,1fr))}
@media(max-width:900px){.stats.four{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:560px){.stats,.stats.four{grid-template-columns:1fr}}
.stat{background:var(--raised);border:1px solid var(--border);border-radius:16px;padding:18px 20px;box-shadow:var(--shadow)}
.stat .k{font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--faint)}
.stat .v{font-size:clamp(26px,3.4vw,34px);font-weight:700;letter-spacing:-.02em;margin-top:6px;font-variant-numeric:tabular-nums}
.stat .sub{font-size:13px;color:var(--muted);margin-top:4px}
.stat.in .v{color:var(--success)}
.stat.out .v{color:var(--accent)}
.stat.net .v{color:var(--ink)}
.stat.people .v{color:var(--ink)}

/* ── Sections ── */
section{margin-top:44px}
h2.sectionhead{font-size:clamp(22px,3vw,28px);font-weight:700;letter-spacing:-.01em;margin-bottom:6px}
.sectionsub{font-size:15px;color:var(--muted);max-width:66ch;margin-bottom:18px}

/* ── Breakdown bars ── */
.bars{background:var(--raised);border:1px solid var(--border);border-radius:16px;padding:8px 18px 14px;box-shadow:var(--shadow)}
.barrow{padding:12px 0;border-bottom:1px solid var(--border)}
.barrow:last-child{border-bottom:0}
.barhead{display:flex;justify-content:space-between;align-items:baseline;gap:12px;font-size:14.5px}
.barlabel{font-weight:600}
.barnote{font-size:12.5px;color:var(--faint);font-weight:500}
.baramt{font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap}
.bartrack{height:7px;border-radius:999px;background:var(--sunken);overflow:hidden;margin-top:8px}
.barfill{height:100%;border-radius:999px;background:linear-gradient(90deg,var(--accent),var(--accent-hover))}
.barfill.inflow{background:linear-gradient(90deg,var(--success),#1F5C41)}
/* An over-budget line is the most interesting row in the table; it gets its
   own treatment rather than a bar that silently pins at 100%. */
.barfill.over{background:repeating-linear-gradient(45deg,var(--accent),var(--accent) 6px,var(--accent-hover) 6px,var(--accent-hover) 12px)}
.budgetrow{padding:12px 0;border-bottom:1px solid var(--border)}
.budgetrow:last-child{border-bottom:0}
.ofplan{font-weight:500;color:var(--faint)}
.barpct{font-size:12.5px;color:var(--muted);margin-top:5px;font-weight:600}
.barpct.over{color:var(--accent)}
.barblurb{font-size:13px;color:var(--muted);margin-top:6px;max-width:70ch}
.tabs{display:flex;gap:8px;margin-bottom:12px}
.tabs button{background:var(--raised);border:1px solid var(--border);border-radius:999px;padding:6px 14px;
  font-size:13px;font-weight:600;color:var(--muted);box-shadow:var(--shadow)}
.tabs button[aria-pressed="true"]{background:var(--accent);border-color:var(--accent);color:#fff}

/* ── Ledger table ── */
.toolbar{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:12px}
.toolbar input[type=search]{flex:1 1 260px;min-width:0;background:var(--raised);border:1px solid var(--border);
  border-radius:999px;padding:10px 16px;box-shadow:var(--shadow)}
.toolbar select{background:var(--raised);border:1px solid var(--border);border-radius:999px;padding:9px 14px;
  font-size:14px;font-weight:600;color:var(--muted);box-shadow:var(--shadow)}
.count{font-size:13px;color:var(--muted);font-weight:600}
.ledgerwrap{background:var(--raised);border:1px solid var(--border);border-radius:16px;box-shadow:var(--shadow);
  overflow-x:auto;-webkit-overflow-scrolling:touch}
table.ledger{border-collapse:separate;border-spacing:0;width:100%;min-width:900px;font-size:13.5px}
table.ledger th{position:sticky;top:0;background:var(--sunken);text-align:left;font-size:11.5px;font-weight:700;
  letter-spacing:.06em;text-transform:uppercase;color:var(--muted);padding:11px 12px;white-space:nowrap;z-index:2}
table.ledger td{padding:11px 12px;border-top:1px solid var(--border);vertical-align:top}
table.ledger tbody tr:hover td{background:var(--accent-soft)}
td.date,th.date{white-space:nowrap;font-variant-numeric:tabular-nums;color:var(--muted)}
td.amt,th.amt{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums;font-weight:700}
td.amt.out{color:var(--accent)}
td.amt.in{color:var(--success)}
td.amt.internal{color:var(--faint)}
td.who{font-weight:600;min-width:150px}
td.purpose{color:var(--muted);min-width:260px}
.detail{display:block;font-size:12.5px;color:var(--faint);margin-top:3px}
.nopurpose{font-style:italic;color:var(--faint)}
.chip{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.03em;border-radius:999px;
  padding:2px 8px;white-space:nowrap;margin:1px 3px 1px 0}
.chip.receipt{background:#EAF6F0;color:var(--success)}
.chip.exception{background:#FBF1DE;color:var(--warn)}
.chip.undocumented{background:var(--accent-soft);color:var(--accent)}
.chip.rebuilt{background:var(--sky);color:#2C4680}
.chip.fee{background:var(--sunken);color:var(--muted)}
.chip.internal{background:var(--sunken);color:var(--muted)}
/* Applies to the filtered-out rows AND to the no-results message, which is a
   div, not a row — scoping this to \`tr\` left "Nothing matches that search"
   permanently on screen underneath a full table. */
.hidden{display:none}
.emptyrow{padding:26px 14px;text-align:center;color:var(--muted);font-size:14px}

/* ── Callouts / disclosure ── */
.note{background:var(--raised);border:1px solid var(--border);border-left:3px solid var(--accent);
  border-radius:12px;padding:14px 18px;margin-top:16px;font-size:14.5px;color:var(--muted);box-shadow:var(--shadow)}
.note strong{color:var(--ink)}
.note.pay{border-left-color:var(--lavender);margin-top:18px;font-size:15.5px}
.note.pay strong{font-size:16.5px}
.paypolicy{margin-top:10px;max-width:74ch}
.note.missing{border-left-color:var(--success);margin-top:14px}
.misslist{margin:10px 0 0;padding-left:20px}
.misslist li{margin-bottom:6px;max-width:72ch}
.misslist strong{color:var(--ink)}
.missfoot{margin-top:12px;max-width:72ch}
.notegrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px;margin-top:16px}
details.faq{background:var(--raised);border:1px solid var(--border);border-radius:12px;padding:14px 18px;
  margin-top:10px;box-shadow:var(--shadow)}
details.faq summary{font-weight:700;font-size:15px;cursor:pointer;list-style:none}
details.faq summary::-webkit-details-marker{display:none}
details.faq summary::before{content:"+ ";color:var(--accent);font-weight:700}
details.faq[open] summary::before{content:"− "}
details.faq p{font-size:14.5px;color:var(--muted);margin-top:10px;max-width:72ch}
details.faq p + p{margin-top:8px}

/* ── Amendments ── */
.amendbanner{background:var(--warn);color:#fff;border-radius:12px;padding:12px 18px;font-size:14.5px;
  font-weight:600;margin-top:18px;box-shadow:var(--shadow)}
.amendlist{background:var(--raised);border:1px solid var(--border);border-radius:16px;box-shadow:var(--shadow);
  padding:6px 18px}
.amendrow{padding:14px 0;border-bottom:1px solid var(--border)}
.amendrow:last-child{border-bottom:0}
.amendtop{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;font-size:13px;color:var(--faint);font-weight:600}
.amendreason{background:var(--sunken);border-radius:999px;padding:2px 10px;color:var(--muted)}
.amendnote{font-size:14.5px;color:var(--ink);margin-top:6px;max-width:72ch}

/* ── Giving roll ── */
.roll{background:var(--raised);border:1px solid var(--border);border-radius:16px;box-shadow:var(--shadow);
  max-height:520px;overflow-y:auto}
.rollrow{display:flex;justify-content:space-between;align-items:baseline;gap:12px;padding:11px 18px;
  border-top:1px solid var(--border);font-size:14px}
.rollrow:first-child{border-top:0}
.rollwhen{color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap}
.rollamt{font-weight:700;color:var(--success);font-variant-numeric:tabular-nums;white-space:nowrap}
.rollmeta{color:var(--faint);font-size:12.5px}

/* ── Footer ── */
footer{margin-top:64px;padding-top:24px;border-top:1px solid var(--border);font-size:13.5px;color:var(--faint)}
footer a{font-weight:600}
.dl{display:inline-flex;align-items:center;gap:6px;background:var(--raised);border:1px solid var(--border);
  border-radius:999px;padding:8px 16px;font-size:13.5px;font-weight:600;color:var(--accent);
  text-decoration:none;box-shadow:var(--shadow);margin:4px 8px 4px 0}
.dl:hover{background:var(--accent-soft)}
.empty{background:var(--raised);border:1px solid var(--border);border-radius:16px;padding:40px 28px;
  text-align:center;box-shadow:var(--shadow);margin-top:26px}
.empty h2{font-size:22px;font-weight:700;margin-bottom:8px}
.empty p{color:var(--muted);max-width:56ch;margin:0 auto}
`;

/**
 * The page's only client-side behaviour: filtering the ledger table.
 *
 * Written as plain inline JS with no framework and no build step, matching
 * `givePageClient.ts`. The filtering is purely additive — the full table is
 * already in the HTML, so a reader with JS disabled (or an archiver, or a
 * screen-reader user tabbing through) still gets every row. Nothing here can
 * hide a transaction from someone who didn't ask to hide it.
 */
export const LEDGER_SCRIPT = `
(function(){
  var q=document.getElementById('q');
  var dir=document.getElementById('dir');
  var doc=document.getElementById('doc');
  var count=document.getElementById('rowcount');
  var body=document.getElementById('ledgerbody');
  var empty=document.getElementById('noresults');
  if(!body)return;
  var rows=[].slice.call(body.querySelectorAll('tr[data-row]'));
  function apply(){
    var term=(q&&q.value||'').trim().toLowerCase();
    var d=dir&&dir.value||'';
    var dc=doc&&doc.value||'';
    var shown=0;
    rows.forEach(function(tr){
      var ok=true;
      if(term&&tr.getAttribute('data-search').indexOf(term)===-1)ok=false;
      if(ok&&d&&tr.getAttribute('data-dir')!==d)ok=false;
      if(ok&&dc&&tr.getAttribute('data-doc')!==dc)ok=false;
      tr.classList.toggle('hidden',!ok);
      if(ok)shown++;
    });
    if(count)count.textContent=shown+(shown===1?' line':' lines');
    if(empty)empty.classList.toggle('hidden',shown>0);
  }
  [q,dir,doc].forEach(function(el){if(el)el.addEventListener('input',apply)});
  apply();
  // The period picker auto-submits on change so it feels immediate. The form
  // still works — and the View button still shows — without any of this, which
  // is the whole reason it is a real GET form and not a JS navigation.
  var picker=document.querySelector('form.picker');
  if(picker){
    [].slice.call(picker.querySelectorAll('select')).forEach(function(sel){
      sel.addEventListener('change',function(){
        // Changing the YEAR invalidates the chosen month (it may not be
        // published in the new year), so fall back to the year rollup rather
        // than submitting a month that 404s.
        if(sel.name==='year'){
          var m=picker.querySelector('select[name=month]');
          if(m)m.value='';
        }
        picker.submit();
      });
    });
  }
  // The breakdown toggle: by category vs by what it was for.
  var tabs=[].slice.call(document.querySelectorAll('[data-tab]'));
  tabs.forEach(function(btn){
    btn.addEventListener('click',function(){
      var target=btn.getAttribute('data-tab');
      tabs.forEach(function(b){b.setAttribute('aria-pressed',String(b===btn))});
      [].slice.call(document.querySelectorAll('[data-panel]')).forEach(function(p){
        p.style.display=p.getAttribute('data-panel')===target?'':'none';
      });
    });
  });
})();
`;
