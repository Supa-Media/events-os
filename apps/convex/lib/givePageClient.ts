/**
 * Browser script for the public `/give` map + `/give/<slug>` territory pages
 * (docs/plans/giving-territories.md). Vanilla JS (no build step), dependency-
 * free, and defensive — every `getElementById` is guarded so the SAME script
 * runs on both pages and simply no-ops for whichever forms aren't present
 * (the map page has no monthly form or tabs; the 404 page loads no script at
 * all).
 *
 * Reads `window.__GIVE__` (stamped by `givePage.ts`):
 *   map:       { mode:"map", slug:null, oneTimePresetsCents, oneTimeDefaultIndex }
 *   territory: { mode:"territory", slug, backerPresetsCents,
 *                oneTimePresetsCents, oneTimeDefaultIndex, backerUnitCents }
 *
 * Drives three same-origin JSON POSTs (all mirror `landingPageClient.ts`'s
 * `startDonation` shape — resolve → redirect to the returned Stripe URL):
 *   - `/api/give/donate`   — the one-time form (`#gc_onetime_form`).
 *   - `/api/give/pledge`   — the monthly/backer form (`#gc_monthly_form`,
 *                            territory only) — UNCHANGED core payload shape,
 *                            PLUS (F6, wave 2) the optional `shareOnWall`/
 *                            `publicName`/`message` trio, sent only when the
 *                            form's "share this on the wall" box is checked.
 *   - `/api/give/interest` — the interest + suggest-a-space form (`#gi_form`,
 *                            map + territory) — MULTI-SELECT (F4, wave 2):
 *                            sends `kinds: string[]` from however many
 *                            checkboxes are checked. Checking "I want to be
 *                            on the founding team" (`join_team`) reveals a
 *                            role picker + skills/church/phone/social fields
 *                            and REQUIRES name, phone, email, and at least
 *                            one role before submit; every other selection
 *                            stays fully optional. No redirect — shows an
 *                            inline thank-you on success.
 */
export const GIVE_CAMPAIGN_SCRIPT = `
(function(){
"use strict";
var G=window.__GIVE__||{mode:"map",slug:null,oneTimePresetsCents:[2500,5000,10000,25000]};

function $(id){return document.getElementById(id);}
function qsa(sel){return document.querySelectorAll(sel);}
function money(c){return '$'+(c/100).toFixed(c%100===0?0:2);}

/** Wire one amount-picker form (presets + custom + name/email + submit).
 *  No-ops if the form isn't on this page (its preset buttons won't exist). */
function wireAmountForm(opts){
  var prefix=opts.prefix;
  var presets=opts.presets||[];
  var btnSel='.amtbtn[data-group="'+prefix+'"]';
  var btns=qsa(btnSel);
  if(!btns.length)return;
  var selected=presets[opts.defaultIndex]||presets[0]||0;

  function currentCents(){
    var custom=$(prefix+'_custom');
    if(custom&&custom.value.trim()){
      var n=Number(custom.value.trim().replace(/^\\$/,''));
      if(isFinite(n)&&n>0)return Math.round(n*100);
      return 0;
    }
    return selected;
  }
  function refresh(){
    var c=currentCents();
    var btn=$(prefix+'_submit');
    if(btn){
      if(c<=0){
        btn.textContent='Choose an amount';
        btn.disabled=true;
      }else if(opts.isMonthly){
        btn.textContent=(c<opts.unitCents?'Give monthly — ':'Back this territory — ')+money(c)+'/mo';
        btn.disabled=false;
      }else{
        btn.textContent='Give '+money(c)+' now';
        btn.disabled=false;
      }
    }
    var note=$(prefix+'_note');
    if(note)note.style.display=(opts.isMonthly&&c>0&&c<opts.unitCents)?'block':'none';
  }
  function selectPreset(cents){
    selected=cents;
    var custom=$(prefix+'_custom');
    if(custom)custom.value='';
    var all=qsa(btnSel);
    for(var i=0;i<all.length;i++){
      all[i].classList.toggle('sel',Number(all[i].getAttribute('data-cents'))===cents);
    }
    refresh();
  }
  for(var i=0;i<btns.length;i++){
    (function(b){
      b.addEventListener('click',function(){selectPreset(Number(b.getAttribute('data-cents')));});
    })(btns[i]);
  }
  var custom=$(prefix+'_custom');
  if(custom){
    custom.addEventListener('input',function(){
      selected=0;
      var all=qsa(btnSel);
      for(var i=0;i<all.length;i++)all[i].classList.remove('sel');
      refresh();
    });
  }
  refresh();

  var form=$(prefix+'_form');
  if(!form)return;
  form.addEventListener('submit',function(e){
    e.preventDefault();
    var err=$(prefix+'_err');
    var ok=$(prefix+'_ok');
    if(err)err.textContent='';
    if(ok)ok.textContent='';
    var amountCents=currentCents();
    var name=(($(prefix+'_name')||{}).value||'').trim();
    var email=(($(prefix+'_email')||{}).value||'').trim();
    if(amountCents<=0){if(err)err.textContent='Choose or enter an amount.';return;}
    if(!name||email.indexOf('@')<0){if(err)err.textContent='Add your name and a real email.';return;}
    var btn=$(prefix+'_submit');
    if(btn)btn.disabled=true;
    var payload={amountCents:amountCents,name:name,email:email};
    if(G.slug)payload.slug=G.slug;
    // F6 (wave 2): "share this on the wall" — publicName/message only ever
    // travel alongside shareOnWall, so an unchecked box never leaks a typed
    // (but un-shared) message to the server.
    var share=!!(($(prefix+'_share')||{}).checked);
    if(share){
      var publicName=(($(prefix+'_public_name')||{}).value||'').trim();
      var wallMessage=(($(prefix+'_message')||{}).value||'').trim().slice(0,280);
      payload.shareOnWall=true;
      if(publicName)payload.publicName=publicName;
      if(wallMessage)payload.message=wallMessage;
    }
    fetch(opts.endpoint,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(payload)
    }).then(function(r){
      return r.json().then(function(j){
        if(!r.ok)throw new Error(j.error||'Something went wrong.');
        return j;
      });
    }).then(function(res){
      if(res&&res.url){window.location.href=res.url;}
      else if(ok){ok.textContent='Thanks — check your email!';}
    }).catch(function(e){
      if(btn)btn.disabled=false;
      if(err)err.textContent=e.message;
      refresh();
    });
  });
}

/* Wire the territory page's monthly/one-time tab toggle. No-ops on the map
   page (no .tab-btn elements there). */
function wireTabs(){
  var tabs=qsa('.tab-btn');
  if(!tabs.length)return;
  for(var i=0;i<tabs.length;i++){
    (function(t){
      t.addEventListener('click',function(){
        var name=t.getAttribute('data-tab');
        var allTabs=qsa('.tab-btn');
        for(var j=0;j<allTabs.length;j++)allTabs[j].classList.toggle('active',allTabs[j]===t);
        var panels=qsa('.tab-panel');
        for(var j=0;j<panels.length;j++){
          panels[j].classList.toggle('active',panels[j].getAttribute('data-tab-panel')===name);
        }
      });
    })(tabs[i]);
  }
}

/* Wire the interest + suggest-a-space form. Present (with the same ids) on
   both pages; no-ops if #gi_form isn't on the page. MULTI-SELECT (F4, wave
   2): several .interest-opt checkboxes may be checked at once, sent as
   kinds:string[]. Two fields progressively reveal off the checked set:
     - the location field, when want_in_city or suggest_space is checked.
     - the founding-team block (role picker + skills/church/phone/social),
       when join_team is checked -- which also makes name/phone/email/role
       REQUIRED (every other selection stays fully optional, matching wave
       1's "at least one of name/email/location/message" rule). */
function wireInterestForm(){
  var form=$('gi_form');
  if(!form)return;
  var locationFld=$('gi_location_fld');
  var jointeamFld=$('gi_jointeam_fld');

  function selectedKinds(){
    var out=[];
    var all=qsa('.interest-opt input[type="checkbox"]');
    for(var i=0;i<all.length;i++){if(all[i].checked)out.push(all[i].value);}
    return out;
  }
  function selectedRoles(){
    var out=[];
    var all=qsa('.role-opt input[type="checkbox"]');
    for(var i=0;i<all.length;i++){if(all[i].checked)out.push(all[i].value);}
    return out;
  }
  function refreshFields(){
    var kinds=selectedKinds();
    if(locationFld){
      var wantLocation=kinds.indexOf('want_in_city')>=0||kinds.indexOf('suggest_space')>=0;
      locationFld.style.display=wantLocation?'block':'none';
    }
    if(jointeamFld){
      jointeamFld.style.display=(kinds.indexOf('join_team')>=0)?'block':'none';
    }
  }
  var kindBoxes=qsa('.interest-opt input[type="checkbox"]');
  for(var i=0;i<kindBoxes.length;i++){kindBoxes[i].addEventListener('change',refreshFields);}
  refreshFields();

  form.addEventListener('submit',function(e){
    e.preventDefault();
    var err=$('gi_err');
    var ok=$('gi_ok');
    if(err)err.textContent='';
    if(ok)ok.textContent='';
    var kinds=selectedKinds();
    if(!kinds.length){if(err)err.textContent='Choose at least one so we know how to follow up.';return;}
    var name=(($('gi_name')||{}).value||'').trim();
    var email=(($('gi_email')||{}).value||'').trim();
    var location=(($('gi_location')||{}).value||'').trim();
    var message=(($('gi_message')||{}).value||'').trim();
    var joinTeam=kinds.indexOf('join_team')>=0;
    var roles=joinTeam?selectedRoles():[];
    var skills=(($('gi_skills')||{}).value||'').trim();
    var church=(($('gi_church')||{}).value||'').trim();
    var phone=(($('gi_phone')||{}).value||'').trim();
    var social=(($('gi_social')||{}).value||'').trim();
    if(joinTeam){
      if(!name||!phone||email.indexOf('@')<0||!roles.length){
        if(err)err.textContent='Joining the founding team needs your name, phone, email, and at least one role.';
        return;
      }
    }else if(!name&&!email&&!location&&!message){
      if(err)err.textContent='Add at least one way for us to follow up (name, email, location, or a message).';
      return;
    }
    var payload={kinds:kinds};
    if(name)payload.name=name;
    if(email)payload.email=email;
    if(location)payload.location=location;
    if(message)payload.message=message;
    if(G.mode==='territory'&&G.slug)payload.territorySlug=G.slug;
    if(joinTeam){
      if(roles.length)payload.roles=roles;
      if(skills)payload.skills=skills;
      if(church)payload.church=church;
      if(phone)payload.phone=phone;
      if(social)payload.socialHandle=social;
    }
    var btn=$('gi_submit');
    if(btn)btn.disabled=true;
    fetch('/api/give/interest',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(payload)
    }).then(function(r){
      return r.json().then(function(j){
        if(!r.ok)throw new Error(j.error||'Something went wrong.');
        return j;
      });
    }).then(function(){
      if(ok)ok.textContent='Thank you — we\\'ll be in touch.';
      form.style.display='none';
    }).catch(function(e){
      if(btn)btn.disabled=false;
      if(err)err.textContent=e.message;
    });
  });
}

document.addEventListener('DOMContentLoaded',function(){
  wireAmountForm({
    prefix:'gc_onetime',
    presets:G.oneTimePresetsCents||[2500,5000,10000,25000],
    defaultIndex:(typeof G.oneTimeDefaultIndex==='number')?G.oneTimeDefaultIndex:1,
    isMonthly:false,
    unitCents:0,
    endpoint:'/api/give/donate'
  });
  if(G.mode==='territory'){
    wireAmountForm({
      prefix:'gc_monthly',
      presets:G.backerPresetsCents||[5000,10000,20000],
      defaultIndex:0,
      isMonthly:true,
      unitCents:G.backerUnitCents||5000,
      endpoint:'/api/give/pledge'
    });
    wireTabs();
  }
  wireInterestForm();
});
})();
`;
