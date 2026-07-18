/**
 * Browser script for the `/give/<slug>` territory page's become-a-backer form
 * (docs/plans/giving-territories.md). Vanilla JS (no build step), posts to the
 * same-origin `/api/give/pledge` httpAction (mirrors `/api/tickets/donate`'s
 * shape — `landingPageClient.ts#startDonation`) and redirects to the returned
 * Stripe Checkout URL. The map page (`/give`) needs no script — every dot is a
 * plain server-rendered `<a>`.
 */
export const GIVE_CAMPAIGN_SCRIPT = `
(function(){
"use strict";
var SLUG=window.__GIVE__.slug;
var PRESETS=window.__GIVE__.presetsCents||[2000,5000,10000];
var selected=PRESETS[1]||PRESETS[0]||0;

function $(id){return document.getElementById(id);}
function money(c){return '$'+(c/100).toFixed(c%100===0?0:2);}

function currentCents(){
  var custom=$('gc_custom');
  if(custom&&custom.value.trim()){
    var n=Number(custom.value.trim().replace(/^\\$/,''));
    if(isFinite(n)&&n>0)return Math.round(n*100);
    return 0;
  }
  return selected;
}
function refreshButton(){
  var btn=$('gc_submit');
  if(!btn)return;
  var c=currentCents();
  btn.textContent=c>0?('Back this territory — '+money(c)+'/mo'):'Choose an amount';
  btn.disabled=c<=0;
}
function selectPreset(cents){
  selected=cents;
  var custom=$('gc_custom');
  if(custom)custom.value='';
  var btns=document.querySelectorAll('.amtbtn');
  for(var i=0;i<btns.length;i++){
    btns[i].classList.toggle('sel',Number(btns[i].getAttribute('data-cents'))===cents);
  }
  refreshButton();
}

document.addEventListener('DOMContentLoaded',function(){
  var btns=document.querySelectorAll('.amtbtn');
  for(var i=0;i<btns.length;i++){
    (function(b){
      b.addEventListener('click',function(){selectPreset(Number(b.getAttribute('data-cents')));});
    })(btns[i]);
  }
  var custom=$('gc_custom');
  if(custom){
    custom.addEventListener('input',function(){
      selected=0;
      var all=document.querySelectorAll('.amtbtn');
      for(var i=0;i<all.length;i++)all[i].classList.remove('sel');
      refreshButton();
    });
  }
  refreshButton();

  var form=$('gc_form');
  if(form){
    form.addEventListener('submit',function(e){
      e.preventDefault();
      var err=$('gc_err');
      var ok=$('gc_ok');
      if(err)err.textContent='';
      if(ok)ok.textContent='';
      var amountCents=currentCents();
      var name=($('gc_name')||{}).value||'';
      var email=($('gc_email')||{}).value||'';
      name=name.trim();email=email.trim();
      if(amountCents<=0){if(err)err.textContent='Choose or enter an amount.';return;}
      if(!name||email.indexOf('@')<0){if(err)err.textContent='Add your name and a real email.';return;}
      var btn=$('gc_submit');
      if(btn)btn.disabled=true;
      fetch('/api/give/pledge',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({slug:SLUG,amountCents:amountCents,name:name,email:email})
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
        refreshButton();
      });
    });
  }
});
})();
`;
