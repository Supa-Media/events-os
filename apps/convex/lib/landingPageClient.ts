/**
 * Browser script for the public landing page. Vanilla JS (no build step),
 * talks to the same-origin /api/tickets/* httpActions. Deliberately avoids
 * template literals so it can be embedded inside one.
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
var pending=null; // action waiting on the identity sheet
var openPicker=null,openReply=null;
var EMOJIS=['🔥','❤️','🙌','😂','👀','🎉'];
var PASTELS=['#F5E5C7','#A8D9C4','#C9A8E0','#D6E5F2','#F5D3D0'];
var STATUS_META={going:{e:'👍',w:'Going'},maybe:{e:'🤔',w:'Maybe'},not_going:{e:'😢',w:"Can't go"}};

function $(id){return document.getElementById(id);}
function el(tag,cls,text){var n=document.createElement(tag);if(cls)n.className=cls;if(text!=null)n.textContent=text;return n;}
function toast(msg){var t=$('toast');t.textContent=msg;t.classList.add('show');clearTimeout(t._h);t._h=setTimeout(function(){t.classList.remove('show');},3200);}
function money(c){return c===0?'Free':'$'+(c/100).toFixed(c%100===0?0:2);}
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
function openSheet(title,sub,cta,action){
  pending=action;
  $('sheettitle').textContent=title;
  $('sheetsub').textContent=sub;
  $('sheetgo').textContent=cta;
  $('sheeterr').textContent='';
  if(D.viewer){$('f_name').value=D.viewer.name;$('f_email').value=D.viewer.email;}
  $('overlay').classList.add('open');
  setTimeout(function(){$('f_name').focus();},100);
}
function closeSheet(){$('overlay').classList.remove('open');pending=null;}
$('sheetclose').onclick=closeSheet;
$('overlay').addEventListener('click',function(e){if(e.target===$('overlay'))closeSheet();});
$('sheetgo').onclick=function(){
  var name=$('f_name').value.trim(),email=$('f_email').value.trim();
  if(!name||email.indexOf('@')<0){$('sheeterr').textContent='Add your name and a real email ✨';return;}
  if(!pending)return closeSheet();
  var act=pending;
  $('sheetgo').disabled=true;
  act(name,email).then(function(){$('sheetgo').disabled=false;closeSheet();})
    .catch(function(err){$('sheetgo').disabled=false;$('sheeterr').textContent=err.message;});
};

/* ── rsvp ── */
function doRsvp(status,name,email){
  return api('/api/tickets/rsvp',{slug:SLUG,token:TOKEN||undefined,name:name,email:email,status:status})
    .then(function(res){
      saveToken(res.token);
      var m=STATUS_META[status];
      toast(status==='going'?'You are on the list! 🎉':(status==='maybe'?'Marked as maybe 🤔':'Sorry you will miss it 💔'));
      return refresh();
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
  var run=function(name,email){
    return api('/api/tickets/checkout',{slug:SLUG,token:TOKEN||undefined,name:name,email:email,items:items})
      .then(function(res){
        saveToken(res.token);
        if(res.kind==='stripe'){window.location.href=res.url;return;}
        cart={};
        toast('🎟️ Tickets sent — check your email!');
        return refresh();
      });
  };
  if(TOKEN&&D.viewer){run(D.viewer.name,D.viewer.email).catch(function(e){toast(e.message);});}
  else openSheet('Almost there 🎟️','Your tickets and receipt land in your inbox.','Continue',run);
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
  }
}

/* ── guests ── */
function renderGuests(){
  var box=$('guests');
  box.innerHTML='';
  var total=D.counts.going+D.counts.maybe;
  if(D.guests.length===0&&total===0){
    var empty=el('div','gcount');
    empty.textContent='No one has RSVP’d yet — be the first ✨';
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
    veil.appendChild(el('p',null,'Only guests can see the conversation. RSVP to peek inside.'));
    var btn=el('button','buybtn','RSVP to unlock');
    btn.style.width='auto';btn.style.padding='11px 26px';btn.style.marginTop='2px';
    btn.onclick=function(){pickStatus('going');};
    veil.appendChild(btn);
    lock.appendChild(veil);
    box.appendChild(lock);
    return;
  }
  var comp=el('div','composer');
  var inp=el('input');inp.placeholder=D.viewer?'Say something to the group…':'RSVP to join the conversation…';
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
  renderRsvp();
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
  if(c)history.replaceState(null,'',window.location.pathname);
})();

renderAll();
if(TOKEN)refresh();
setInterval(function(){if(document.visibilityState==='visible')refresh();},30000);
})();
`;
