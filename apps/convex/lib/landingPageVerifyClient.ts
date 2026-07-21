/**
 * Email-verification chunk of the landing page script. Interpolated into
 * LANDING_SCRIPT's IIFE (landingPageClient.ts), so it shares its helpers
 * ($, el, api, toast, refresh, closeSheet, SLUG, TOKEN, D, pending) and
 * inherits the same rule: no backtick template literals.
 *
 * Flow: when an RSVP/checkout response says needsEmailVerification, the
 * identity sheet swaps to a code-entry step (#codefields). Verifying is
 * encouraged, never blocking — the sheet can be dismissed and reopened later
 * via the "Verify your email" pill in the RSVP card.
 */
export const VERIFY_JS = `
/* ── email verification ── */
var sheetMode='id';
function setSheetMode(m){
  sheetMode=m;
  $('idfields').style.display=m==='code'?'none':'block';
  $('codefields').style.display=m==='code'?'block':'none';
  // The per-ticket recipient step belongs only to the id step of checkout.
  var rf=$('recipientfields');if(rf&&m==='code')rf.style.display='none';
}
function openVerifySheet(email){
  pending=null;
  $('sheettitle').textContent='Check your email 📬';
  $('sheetsub').textContent='We sent a 6-digit code to '+email;
  $('sheetgo').textContent='Verify';
  $('sheetgo').disabled=false;
  $('sheeterr').textContent='';
  $('f_code').value='';
  setSheetMode('code');
  $('overlay').classList.add('open');
  setTimeout(function(){$('f_code').focus();},100);
}
function submitVerify(){
  var code=$('f_code').value.trim();
  if(!/^[0-9]{6}$/.test(code)){$('sheeterr').textContent='Enter the 6-digit code from your email';return;}
  $('sheetgo').disabled=true;
  api('/api/tickets/verify-email',{slug:SLUG,token:TOKEN,code:code})
    .then(function(){$('sheetgo').disabled=false;closeSheet();toast('Email verified ✓');return refresh();})
    .catch(function(e){$('sheetgo').disabled=false;$('sheeterr').textContent=e.message;});
}
$('resendcode').onclick=function(){
  $('sheeterr').textContent='';
  api('/api/tickets/resend-code',{slug:SLUG,token:TOKEN})
    .then(function(){toast('New code sent 📬');})
    .catch(function(e){$('sheeterr').textContent=e.message;});
};
/* Small "Verify your email" nudge inside the RSVP card. */
function verifyPill(card){
  if(!D.viewer||D.viewer.emailVerified!==false)return;
  var p=el('button','lockpill','✉️ Verify your email');
  p.style.cursor='pointer';p.style.marginTop='10px';p.style.border='none';p.style.font='inherit';p.style.fontSize='12.5px';
  p.onclick=function(){openVerifySheet(D.viewer.email);};
  card.appendChild(p);
}
`;
