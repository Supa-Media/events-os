import { VERIFY_JS } from "./landingPageVerifyClient";

/**
 * Browser script for the public landing page. Vanilla JS (no build step),
 * talks to the same-origin /api/tickets/* httpActions. Deliberately avoids
 * template literals so it can be embedded inside one. The email-verification
 * step lives in landingPageVerifyClient.ts and is spliced in below.
 */
export const LANDING_SCRIPT = `
(function(){
"use strict";
var SLUG=window.__CFG__.slug;
var D=window.__INIT__;
var KEY='pwguest:'+SLUG;
var TOKEN=null;
try{TOKEN=localStorage.getItem(KEY);}catch(e){}
var cart={};
var giveAmount=0; // selected suggested donation amount (cents), standalone "Give" card
var pending=null; // action waiting on the identity sheet
var openPicker=null,openReply=null;
var donateActive=false,donateContinue=null; // checkout donation-upsell step state
var phoneReq=false; // identity sheet is collecting a (required) phone number
var upsellAmount=0; // selected donation-upsell amount (cents)
var UPSELL_AMOUNTS=[0,2000,2500,5000,10000]; // $0(skip)/$20/$25/$50/$100
var EMOJIS=['🔥','❤️','🙌','😂','👀','🎉'];
var PASTELS=['#F5E5C7','#A8D9C4','#C9A8E0','#D6E5F2','#F5D3D0'];
var STATUS_META={going:{e:'👍',w:'Going'},maybe:{e:'🤔',w:'Maybe'},not_going:{e:'😢',w:"Can't go"}};

function $(id){return document.getElementById(id);}
function el(tag,cls,text){var n=document.createElement(tag);if(cls)n.className=cls;if(text!=null)n.textContent=text;return n;}
function toast(msg){var t=$('toast');t.textContent=msg;t.classList.add('show');clearTimeout(t._h);t._h=setTimeout(function(){t.classList.remove('show');},3200);}
function money(c){return c===0?'Free':'$'+(c/100).toFixed(c%100===0?0:2);}
function dollars(c){return '$'+(c/100).toFixed(c%100===0?0:2);} // money(), but 0 reads as "$0" not "Free" (goal/raised, not ticket price)
function initialsOf(name){var parts=name.trim().split(/\\s+/);var s=(parts[0]?parts[0][0]:'')+(parts[1]?parts[1][0]:'');return s.toUpperCase()||'?';}
function pastel(name){var h=0;for(var i=0;i<name.length;i++)h=(h*31+name.charCodeAt(i))>>>0;return PASTELS[h%PASTELS.length];}
function ago(ts){var s=Math.max(1,Math.round((Date.now()-ts)/1000));
  if(s<60)return 'just now';var m=Math.round(s/60);if(m<60)return m+'m';
  var h=Math.round(m/60);if(h<24)return h+'h';return Math.round(h/24)+'d';}

function api(path,body){
  return fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
    .then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||'Something went wrong');return j;});});
}
function refresh(){
  var q='/api/tickets/page?slug='+encodeURIComponent(SLUG)+(TOKEN?'&token='+encodeURIComponent(TOKEN):'');
  return fetch(q).then(function(r){return r.json();}).then(function(j){if(j&&j.slug){D=j;renderAll();}});
}
function saveToken(t){if(!t)return;TOKEN=t;try{localStorage.setItem(KEY,t);}catch(e){}}

/* ── sheet ── */
function scrollToCard(id){
  var node=$(id);
  if(node&&node.scrollIntoView)node.scrollIntoView({behavior:'smooth',block:'center'});
}
function validPhone(s){return (''+s).replace(/\\D/g,'').length>=10;}
function openSheet(title,sub,cta,action,opts){
  pending=action;
  phoneReq=!!(opts&&opts.phone);
  donateActive=false;donateContinue=null;
  var df=$('donatefields');if(df)df.style.display='none';
  setSheetMode('id');
  $('sheettitle').textContent=title;
  $('sheetsub').textContent=sub;
  $('sheetgo').textContent=cta;
  $('sheeterr').textContent='';
  if(D.viewer){$('f_name').value=D.viewer.name;$('f_email').value=D.viewer.email||'';}
  var pf=$('phonefld');if(pf)pf.style.display=phoneReq?'block':'none';
  if(phoneReq&&D.viewer&&D.viewer.phone)$('f_phone').value=D.viewer.phone;
  $('overlay').classList.add('open');
  setTimeout(function(){$('f_name').focus();},100);
}
function closeSheet(){$('overlay').classList.remove('open');pending=null;donateActive=false;donateContinue=null;}
$('sheetclose').onclick=closeSheet;
$('overlay').addEventListener('click',function(e){if(e.target===$('overlay'))closeSheet();});
$('sheetgo').onclick=function(){
  if(donateActive){
    var amt=currentUpsellCents();
    var cont=donateContinue;
    donateActive=false;donateContinue=null;
    if(cont)cont(amt);
    return;
  }
  if(sheetMode==='code'){submitVerify();return;}
  var name=$('f_name').value.trim(),email=$('f_email').value.trim();
  if(!name||email.indexOf('@')<0){$('sheeterr').textContent='Add your name and a real email ✨';return;}
  var phone='';
  if(phoneReq){
    phone=$('f_phone').value.trim();
    if(!validPhone(phone)){$('sheeterr').textContent='Add a valid phone number 📱';return;}
  }
  if(!pending)return closeSheet();
  var act=pending;
  $('sheetgo').disabled=true;
  act(name,email,phone).then(function(r){
      $('sheetgo').disabled=false;
      if(r&&r.needsVerify)openVerifySheet(r.email);else closeSheet();
    })
    .catch(function(err){$('sheetgo').disabled=false;$('sheeterr').textContent=err.message;});
};
var doncustomInit=$('doncustom');
if(doncustomInit){
  doncustomInit.oninput=function(){
    upsellAmount=0;
    var sibs=document.querySelectorAll('#donateamts .amtbtn');
    for(var i=0;i<sibs.length;i++)sibs[i].classList.remove('sel');
  };
}
${VERIFY_JS}

/* ── rsvp ── */
function doRsvp(status,name,email){
  return api('/api/tickets/rsvp',{slug:SLUG,token:TOKEN||undefined,name:name,email:email,status:status})
    .then(function(res){
      saveToken(res.token);
      toast(status==='going'?'You are on the list! 🎉':(status==='maybe'?'Marked as maybe 🤔':'Sorry you will miss it 💔'));
      return refresh().then(function(){
        if(res.needsEmailVerification)return{needsVerify:true,email:email||(D.viewer?D.viewer.email:'your email')};
        return null;
      });
    });
}
function pickStatus(status){
  var m=STATUS_META[status];
  if(TOKEN&&D.viewer){doRsvp(status).catch(function(e){toast(e.message);});return;}
  openSheet(
    status==='going'?'You’re going! '+m.e:(status==='maybe'?'Maybe? '+m.e:'Can’t make it '+m.e),
    'Leave your details so the host can keep you posted.',
    status==='going'?'Count me in':'Save my RSVP',
    function(name,email){return doRsvp(status,name,email);}
  );
}
function requireIdentity(then,title){
  if(TOKEN&&D.viewer)return then();
  if(!D.rsvpEnabled){
    toast(D.ticketsEnabled?'Get a ticket first to join in 🎟️':'Grab your spot first to join in ✨');
    scrollToCard(D.ticketsEnabled?'ticketscard':(D.givingEnabled?'givingcard':'ticketscard'));
    return;
  }
  openSheet(title||'Join the party first ✨','RSVP so everyone knows who’s talking.','RSVP & continue',
    function(name,email){return doRsvp('going',name,email).then(then);});
}

/* ── tickets ── */
function cartCount(){var n=0;for(var k in cart)n+=cart[k];return n;}
function cartTotal(){var t=0;D.ticketTypes.forEach(function(tt){t+=(cart[tt.id]||0)*tt.priceCents;});return t;}
function renderTickets(){
  var card=$('ticketscard');
  card.innerHTML='';
  if(!D.ticketsEnabled||D.ticketTypes.length===0){card.style.display='none';return;}
  card.style.display='block';
  card.appendChild(el('div','cardtitle serif','Tickets'));
  D.ticketTypes.forEach(function(tt){
    var row=el('div','tier');
    var inf=el('div','inf');
    inf.appendChild(el('div','nm',tt.name));
    if(tt.description)inf.appendChild(el('div','ds',tt.description));
    if(tt.lowRemaining!=null&&tt.onSale)inf.appendChild(el('div','low','Only '+tt.lowRemaining+' left'));
    row.appendChild(inf);
    var pr=el('div','pr');
    if(tt.priceCents===0){pr.appendChild(el('span','free','Free'));}else{pr.textContent=money(tt.priceCents);}
    row.appendChild(pr);
    if(!tt.onSale){row.appendChild(el('div','soldout','SOLD OUT'));}
    else{
      var st=el('div','stepper');
      var minus=el('button','stepbtn','−'),plus=el('button','stepbtn','+');
      var q=el('div','qty',String(cart[tt.id]||0));
      minus.disabled=!(cart[tt.id]>0);
      var max=tt.maxPerOrder||10;
      plus.disabled=(cart[tt.id]||0)>=max||(tt.lowRemaining!=null&&(cart[tt.id]||0)>=tt.lowRemaining);
      minus.onclick=function(){cart[tt.id]=Math.max(0,(cart[tt.id]||0)-1);if(!cart[tt.id])delete cart[tt.id];renderTickets();};
      plus.onclick=function(){cart[tt.id]=(cart[tt.id]||0)+1;renderTickets();};
      st.appendChild(minus);st.appendChild(q);st.appendChild(plus);
      row.appendChild(st);
    }
    card.appendChild(row);
  });
  var n=cartCount();
  var buy=el('button','buybtn');
  buy.textContent=n>0?('Get '+n+' ticket'+(n>1?'s':'')+' · '+money(cartTotal())):'Get tickets';
  buy.disabled=n===0;
  buy.onclick=startCheckout;
  card.appendChild(buy);
}
function startCheckout(){
  var items=[];for(var k in cart)items.push({ticketTypeId:k,quantity:cart[k]});
  if(items.length===0)return;
  var ticketTotal=cartTotal();
  var finish=function(donationCents){
    closeSheet();
    var run=function(name,email,phone){
      return api('/api/tickets/checkout',{slug:SLUG,token:TOKEN||undefined,name:name,email:email,phone:phone||undefined,items:items,donationCents:donationCents||0})
        .then(function(res){
          saveToken(res.token);
          if(res.kind==='stripe'){window.location.href=res.url;return;}
          cart={};
          toast('🎟️ Tickets sent — check your email!');
          return refresh().then(function(){
            if(res.needsEmailVerification)return{needsVerify:true,email:email};
            return null;
          });
        });
    };
    // A phone is required to buy — skip the sheet only for a returning guest who
    // already has one on file; otherwise collect name/email/phone.
    if(TOKEN&&D.viewer&&D.viewer.phone){run(D.viewer.name,D.viewer.email,D.viewer.phone).catch(function(e){toast(e.message);});}
    else openSheet('Almost there 🎟️','Your tickets and receipt land in your inbox.','Continue',run,{phone:true});
  };
  if(D.givingEnabled)openDonateUpsell(ticketTotal,finish);else finish(0);
}
/* "Would you also like to add a donation?" step, shown before checkout when
   giving is enabled — one combined Stripe charge, split server-side. */
function currentUpsellCents(){
  var inp=$('doncustom');
  if(inp&&inp.value.trim())return parseGiveInput(inp.value);
  return upsellAmount;
}
function renderDonateAmts(){
  var grid=$('donateamts');
  if(!grid)return;
  grid.innerHTML='';
  UPSELL_AMOUNTS.forEach(function(c){
    var label=c===0?'No thanks':money(c);
    var b=el('button','amtbtn'+(upsellAmount===c?' sel':''),label);
    b.onclick=function(){upsellAmount=c;var ci=$('doncustom');if(ci)ci.value='';renderDonateAmts();};
    grid.appendChild(b);
  });
}
function openDonateUpsell(ticketTotal,onDone){
  upsellAmount=0;
  var custom=$('doncustom');if(custom)custom.value='';
  $('idfields').style.display='none';
  $('codefields').style.display='none';
  var df=$('donatefields');df.style.display='block';
  $('sheettitle').textContent='Add a donation? 🎁';
  $('sheetsub').textContent='Tickets: '+money(ticketTotal)+'. Want to chip in extra for the fundraiser? One simple checkout.';
  $('sheeterr').textContent='';
  renderDonateAmts();
  $('sheetgo').textContent='Continue';
  $('sheetgo').disabled=false;
  donateActive=true;
  donateContinue=function(amt){df.style.display='none';onDone(amt);};
  $('overlay').classList.add('open');
}

/* ── giving ── */
function parseGiveInput(s){var t=(''+s).trim().replace(/^\\$/,'');if(!t)return 0;var n=Number(t);if(!isFinite(n)||n<=0)return 0;return Math.round(n*100);}
function currentGiveCents(){var inp=$('gcustom');if(inp&&inp.value.trim())return parseGiveInput(inp.value);return giveAmount;}
function updateGiveBtn(){var b=$('givebtn');if(!b)return;var c=currentGiveCents();b.textContent=c>0?('Give '+money(c)):'Give';b.disabled=c<=0;}
function renderGiving(){
  var card=$('givingcard');
  card.innerHTML='';
  if(!D.givingEnabled){card.style.display='none';return;}
  card.style.display='block';
  card.appendChild(el('div','cardtitle serif','Support this event'));
  if(D.givingPrompt)card.appendChild(el('div','giveprompt',D.givingPrompt));
  if(D.donationsCents>0){
    var raised=el('div','raised');
    raised.appendChild(el('b',null,money(D.donationsCents)));
    var suffix=' raised'+(D.donationsCount?(' · '+D.donationsCount+' gift'+(D.donationsCount===1?'':'s')):'');
    raised.appendChild(document.createTextNode(suffix));
    card.appendChild(raised);
  }
  var amts=D.suggestedAmountsCents||[];
  if(amts.length){
    var grid=el('div','amtgrid');
    amts.forEach(function(c){
      var b=el('button','amtbtn'+(giveAmount===c?' sel':''),money(c));
      b.onclick=function(){giveAmount=c;renderGiving();};
      grid.appendChild(b);
    });
    card.appendChild(grid);
  }
  var fld=el('div','amtcustom');
  fld.appendChild(el('span','cur','$'));
  var inp=el('input');inp.id='gcustom';inp.type='text';inp.inputMode='decimal';inp.placeholder='Other amount';
  inp.oninput=function(){
    giveAmount=0;
    var sibs=card.querySelectorAll('.amtbtn');
    for(var i=0;i<sibs.length;i++)sibs[i].classList.remove('sel');
    updateGiveBtn();
  };
  fld.appendChild(inp);
  card.appendChild(fld);
  var give=el('button','buybtn');give.id='givebtn';
  give.onclick=function(){startDonation(currentGiveCents());};
  card.appendChild(give);
  updateGiveBtn();
}
function startDonation(amountCents){
  if(!amountCents||amountCents<=0)return;
  var run=function(name,email){
    return api('/api/tickets/donate',{slug:SLUG,token:TOKEN||undefined,name:name,email:email,amountCents:amountCents})
      .then(function(res){
        saveToken(res.token);
        if(res.kind==='stripe'){window.location.href=res.url;return;}
        return null;
      });
  };
  if(TOKEN&&D.viewer){run(D.viewer.name,D.viewer.email).catch(function(e){toast(e.message);});}
  else openSheet('Make it count 🙏','Your receipt lands in your inbox.','Continue to payment',run);
}

/* ── rsvp card ── */
function renderRsvp(){
  var card=$('rsvpcard');
  card.innerHTML='';
  if(!D.rsvpEnabled){card.style.display='none';return;}
  card.style.display='block';
  card.appendChild(el('div','cardtitle serif',D.viewer?'Your RSVP':'Are you coming?'));
  var orbs=el('div','orbs');
  ['going','maybe','not_going'].forEach(function(s){
    var m=STATUS_META[s];
    var o=el('button','orb'+(D.viewer&&D.viewer.status===s?' sel':''));
    var f=el('div','face',m.e);
    o.appendChild(f);o.appendChild(el('div','lbl',m.w));
    o.onclick=function(){pickStatus(s);};
    orbs.appendChild(o);
  });
  card.appendChild(orbs);
  if(D.viewer){
    var ya=el('div','youare');
    var t=el('div');t.innerHTML='';
    var m=STATUS_META[D.viewer.status];
    var b=el('b',null,D.viewer.name.split(' ')[0]);
    t.appendChild(b);t.appendChild(document.createTextNode(' — '+m.w+' '+m.e));
    ya.appendChild(t);
    var edit=el('button',null,'Edit');
    edit.onclick=function(){openSheet('Update your details','Change your name or email.','Save',
      function(name,email){return doRsvp(D.viewer.status,name,email);});};
    ya.appendChild(edit);
    card.appendChild(ya);
    verifyPill(card);
  }
}

/* ── social proof / goal / hero cta ── */
function renderSocialProof(){
  var box=$('socialproof');
  if(!box)return;
  box.innerHTML='';
  var chips=[];
  if(D.ticketsEnabled&&D.counts.ticketsSold>0)chips.push('🎟️ '+D.counts.ticketsSold+' ticket'+(D.counts.ticketsSold===1?'':'s')+' sold');
  if(D.rsvpEnabled&&D.counts.going>0)chips.push('👍 '+D.counts.going+' going');
  if(D.rsvpEnabled&&D.counts.maybe>0)chips.push(D.counts.maybe+' maybe');
  if(chips.length===0){box.style.display='none';return;}
  box.style.display='flex';
  chips.forEach(function(t){box.appendChild(el('span','proofchip',t));});
}
function renderGoal(){
  var box=$('goalbar');
  if(!box)return;
  box.innerHTML='';
  if(D.goalCents==null||D.goalCents<=0){box.style.display='none';return;}
  box.style.display='block';
  var pct=Math.max(0,Math.min(100,Math.round((D.raisedCents/D.goalCents)*100)));
  var row=el('div','goalrow');
  row.appendChild(el('span','goalraised',dollars(D.raisedCents)+' raised'));
  row.appendChild(el('span','goaltarget','of '+dollars(D.goalCents)+' goal'));
  box.appendChild(row);
  var track=el('div','goaltrack');
  var fill=el('div','goalfill');fill.style.width=pct+'%';
  track.appendChild(fill);
  box.appendChild(track);
}
function renderHeroCta(){
  var box=$('herocta');
  if(!box)return;
  box.innerHTML='';
  var primary=null;
  if(D.ticketsEnabled)primary={label:'Get tickets',target:'ticketscard'};
  else if(D.rsvpEnabled)primary={label:'RSVP now',target:'rsvpcard'};
  else if(D.givingEnabled)primary={label:'Give now',target:'givingcard'};
  if(primary){
    var pb=el('button','ctabtn primary',primary.label+' →');
    pb.onclick=function(){scrollToCard(primary.target);};
    box.appendChild(pb);
  }
  if(D.givingEnabled&&(!primary||primary.target!=='givingcard')){
    var sb=el('button','ctabtn secondary','Donate');
    sb.onclick=function(){scrollToCard('givingcard');};
    box.appendChild(sb);
  }
  box.style.display=box.children.length?'flex':'none';
}

/* ── guests ── */
function renderGuests(){
  var box=$('guests');
  box.innerHTML='';
  var total=D.counts.going+D.counts.maybe;
  if(D.guests.length===0&&total===0){
    var empty=el('div','gcount');
    empty.textContent=D.rsvpEnabled?'No one has RSVP’d yet — be the first ✨':'No tickets sold yet — be the first 🎟️';
    box.appendChild(empty);return;
  }
  var row=el('div','avatars');
  var shown=D.guests.slice(0,10);
  shown.forEach(function(g){
    var a=el('div','av',initialsOf(g.name));
    a.style.background=pastel(g.name);
    a.title=g.name+' · '+(STATUS_META[g.status]||{}).w;
    row.appendChild(a);
  });
  if(total>shown.length){row.appendChild(el('div','av more','+'+(total-shown.length)));}
  box.appendChild(row);
  var c=el('div','gcount');
  var bits=[];
  if(D.counts.going)bits.push('<b>'+D.counts.going+' going</b>');
  if(D.counts.maybe)bits.push(D.counts.maybe+' maybe');
  if(D.capacity){var left=Math.max(0,D.capacity-D.counts.going);bits.push(left+' spot'+(left===1?'':'s')+' left');}
  c.innerHTML=bits.join(' · ');
  box.appendChild(c);
}

/* ── activity ── */
function reactRow(item,type){
  var row=el('div','reacts');
  (item.reactions||[]).forEach(function(r){
    var chip=el('button','rchip'+(r.mine?' mine':''));
    chip.appendChild(document.createTextNode(r.emoji));
    chip.appendChild(el('span','n',String(r.count)));
    chip.onclick=function(){toggleReact(type,item.id,r.emoji);};
    row.appendChild(chip);
  });
  var add=el('button','raddb','＋ 😊');
  add.onclick=function(ev){
    ev.stopPropagation();
    if(openPicker){openPicker.remove();openPicker=null;return;}
    var pick=el('span','picker');
    EMOJIS.forEach(function(e){
      var b=el('button',null,e);
      b.onclick=function(){pick.remove();openPicker=null;toggleReact(type,item.id,e);};
      pick.appendChild(b);
    });
    openPicker=pick;
    add.after(pick);
  };
  row.appendChild(add);
  return row;
}
function toggleReact(targetType,targetId,emoji){
  requireIdentity(function(){
    return api('/api/tickets/react',{slug:SLUG,token:TOKEN,targetType:targetType,targetId:targetId,emoji:emoji})
      .then(refresh).catch(function(e){toast(e.message);});
  },'RSVP to react ✨');
}
function feedItem(item,isReply){
  var it=el('div','feeditem');
  var a=el('div','av',initialsOf(item.authorName));
  a.style.background=pastel(item.authorName);
  a.style.width=isReply?'30px':'38px';a.style.height=isReply?'30px':'38px';
  a.style.fontSize=isReply?'11px':'13px';a.style.border='none';a.style.marginLeft='0';
  it.appendChild(a);
  var body=el('div','body');
  var line=el('div','feedline');
  var nm=el('b',null,item.authorName+(item.isViewer?' (you)':''));
  line.appendChild(nm);
  if(item.type==='rsvp'){
    var m=STATUS_META[item.status]||{e:'',w:item.status};
    var st=el('span','st',' rsvped '+m.w+' '+m.e);
    line.appendChild(st);
  }
  line.appendChild(el('span','ago',ago(item.createdAt)));
  body.appendChild(line);
  if(item.type==='comment')body.appendChild(el('div','cbody',item.body));
  body.appendChild(reactRow(item,item.type==='rsvp'?'rsvp':'comment'));
  if(!isReply){
    var rb=el('button','replybtn','Reply');
    rb.style.marginTop='6px';
    rb.onclick=function(){
      if(openReply){openReply.remove();openReply=null;return;}
      var box=el('div','replybox');
      var inp=el('input');inp.placeholder='Reply to '+item.authorName.split(' ')[0]+'…';
      var send=el('button','replybtn','Send');
      var submit=function(){
        var val=inp.value.trim();if(!val)return;
        requireIdentity(function(){
          var payload={slug:SLUG,token:TOKEN,body:val};
          if(item.type==='rsvp')payload.replyToRsvpId=item.id;else payload.parentId=item.id;
          return api('/api/tickets/comment',payload).then(refresh).catch(function(e){toast(e.message);});
        },'RSVP to reply ✨');
      };
      send.onclick=submit;
      inp.addEventListener('keydown',function(e){if(e.key==='Enter')submit();});
      box.appendChild(inp);box.appendChild(send);
      openReply=box;
      body.appendChild(box);
      inp.focus();
    };
    body.appendChild(rb);
    if(item.replies&&item.replies.length){
      var reps=el('div','replies');
      item.replies.forEach(function(r){reps.appendChild(feedItem(r,true));});
      body.appendChild(reps);
    }
  }
  it.appendChild(body);
  return it;
}
function renderActivity(){
  var box=$('activity');
  box.innerHTML='';
  if(D.activityLocked){
    var lock=el('div','locked');
    var rows=el('div','rows');
    for(var i=0;i<3;i++){
      var fr=el('div','fakerow');
      var av=el('div','av','');av.style.background=PASTELS[i];av.style.border='none';av.style.marginLeft='0';
      var bars=el('div');bars.style.flex='1';
      bars.appendChild(el('div','b1'));bars.appendChild(el('div','b2'));
      fr.appendChild(av);fr.appendChild(bars);
      rows.appendChild(fr);
    }
    lock.appendChild(rows);
    var veil=el('div','veil');
    veil.appendChild(el('div','lk','🔒'));
    veil.appendChild(el('p',null,D.rsvpEnabled
      ? 'Only guests can see the conversation. RSVP to peek inside.'
      : 'Only ticket holders can see the conversation. Get your ticket to peek inside.'));
    var btn=el('button','buybtn',D.rsvpEnabled?'RSVP to unlock':(D.ticketsEnabled?'Get tickets to unlock':'Unlock'));
    btn.style.width='auto';btn.style.padding='11px 26px';btn.style.marginTop='2px';
    btn.onclick=function(){
      if(D.rsvpEnabled)pickStatus('going');
      else scrollToCard(D.ticketsEnabled?'ticketscard':'givingcard');
    };
    veil.appendChild(btn);
    lock.appendChild(veil);
    box.appendChild(lock);
    return;
  }
  var comp=el('div','composer');
  var inp=el('input');inp.placeholder=D.viewer?'Say something to the group…':(D.rsvpEnabled?'RSVP to join the conversation…':'Get a ticket to join the conversation…');
  var post=el('button','buybtn','Post');
  post.style.width='auto';post.style.padding='11px 22px';post.style.marginTop='0';
  var submit=function(){
    var val=inp.value.trim();if(!val)return;
    requireIdentity(function(){
      return api('/api/tickets/comment',{slug:SLUG,token:TOKEN,body:val})
        .then(function(){inp.value='';return refresh();}).catch(function(e){toast(e.message);});
    },'RSVP to comment ✨');
  };
  post.onclick=submit;
  inp.addEventListener('keydown',function(e){if(e.key==='Enter')submit();});
  comp.appendChild(inp);comp.appendChild(post);
  box.appendChild(comp);
  var items=D.activity||[];
  if(items.length===0){box.appendChild(el('div','gcount','Quiet in here so far — say hi 👋'));return;}
  items.forEach(function(item){box.appendChild(feedItem(item,false));});
}

function renderAll(){
  renderTickets();
  renderGiving();
  renderRsvp();
  renderSocialProof();
  renderGoal();
  renderHeroCta();
  renderGuests();
  renderActivity();
}

document.addEventListener('click',function(){
  if(openPicker){openPicker.remove();openPicker=null;}
});

/* checkout return params */
(function(){
  var q=new URLSearchParams(window.location.search);
  var c=q.get('checkout');
  if(c==='success')toast('🎟️ Payment received — your tickets are in your inbox!');
  if(c==='canceled')toast('Checkout canceled — your spot is still open.');
  if(q.get('donated')==='1')toast('🙏 Thank you for your gift — a receipt is on its way!');
  if(c||q.get('donated'))history.replaceState(null,'',window.location.pathname);
})();

renderAll();
if(TOKEN)refresh();
setInterval(function(){if(document.visibilityState==='visible')refresh();},30000);
})();
`;
