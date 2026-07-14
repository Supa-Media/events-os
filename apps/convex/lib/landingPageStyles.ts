/**
 * Static presentation for the public event pages: fonts, favicon, base
 * palette, and the landing-page stylesheet. Split out of landingPage.ts so
 * markup, styles, and behaviour each live in their own file.
 */
export const FONTS = `
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Corben:wght@400;700&family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700&display=swap" rel="stylesheet">`;

export const FAVICON = `<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='16' fill='#D23B3A'/><text x='32' y='43' font-family='Georgia,serif' font-weight='bold' font-size='30' fill='#FDF6F6' text-anchor='middle'>pw</text></svg>`,
)}">`;

export const BASE_CSS = `
:root{
  --cream:#FDF6F6;--raised:#FFFFFF;--sunken:#FAEEE9;--ink:#210909;--muted:#7A5A5A;
  --faint:#A98C8C;--border:#EFE0DC;--border-strong:#E4CFCB;--accent:#D23B3A;
  --accent-hover:#922424;--accent-soft:#FBE8E8;--peach:#F5E5C7;--mint:#A8D9C4;
  --lavender:#C9A8E0;--sky:#D6E5F2;--success:#2F7D5B;--warn:#B4761A;
  --shadow:0 2px 8px rgba(33,9,9,.06),0 12px 32px rgba(33,9,9,.08);
  --shadow-pop:0 4px 12px rgba(33,9,9,.10),0 24px 60px rgba(33,9,9,.16);
}
*{box-sizing:border-box;margin:0;padding:0}
html{-webkit-text-size-adjust:100%}
body{
  background:var(--cream);color:var(--ink);
  font-family:'DM Sans',-apple-system,'Segoe UI',sans-serif;
  font-size:16px;line-height:1.5;min-height:100vh;overflow-x:hidden;
}
body::before{
  content:"";position:fixed;inset:0;z-index:-2;pointer-events:none;
  background:
    radial-gradient(600px 400px at 8% -5%, rgba(210,59,58,.07), transparent 70%),
    radial-gradient(700px 500px at 105% 15%, rgba(201,168,224,.12), transparent 70%),
    radial-gradient(600px 500px at 50% 110%, rgba(245,229,199,.35), transparent 70%);
}
.serif{font-family:'Corben',Georgia,serif}
a{color:var(--accent)}
button{font-family:inherit;cursor:pointer;border:0;background:none;color:inherit}
input,textarea{font-family:inherit;font-size:15px;color:var(--ink)}
::placeholder{color:var(--faint)}
`;

/** Landing-page-specific CSS (appended after BASE_CSS). */
export const LANDING_CSS = `
.backdrop{
  position:fixed;inset:-10% -10% auto -10%;height:85vh;z-index:-1;pointer-events:none;
  background-size:cover;background-position:center;
  filter:blur(90px) saturate(1.2);opacity:.28;transform:scale(1.15);
  -webkit-mask-image:linear-gradient(#000 40%,transparent);
  mask-image:linear-gradient(#000 40%,transparent);
}
main{max-width:1080px;margin:0 auto;padding:20px 20px 96px;position:relative}
.topbar{display:flex;justify-content:center;padding:10px 0 26px}
.wordmark{font-weight:700;font-size:12px;letter-spacing:.22em;color:var(--accent)}
.grid{display:grid;grid-template-columns:minmax(0,1fr) 400px;gap:52px;align-items:start}
@media(max-width:880px){
  .grid{grid-template-columns:1fr;gap:28px}
  .flyer{order:-1;max-width:420px;margin:0 auto;width:100%}
}
/* ── left column ── */
.hostchip{display:inline-flex;align-items:center;gap:8px;background:var(--raised);
  border:1px solid var(--border);border-radius:999px;padding:6px 14px 6px 6px;
  font-size:13px;font-weight:500;color:var(--muted);box-shadow:var(--shadow)}
.hostchip .dot{width:24px;height:24px;border-radius:50%;
  background:radial-gradient(circle at 30% 30%,#F5D3D0,var(--accent));
  display:flex;align-items:center;justify-content:center;color:#fff;font-size:11px;font-weight:700}
h1.title{font-size:clamp(38px,6.5vw,60px);line-height:1.08;font-weight:700;margin:18px 0 8px;letter-spacing:-.01em}
.tagline{font-size:18px;color:var(--muted);margin-bottom:26px}
.metacard{display:flex;gap:14px;align-items:flex-start;background:var(--raised);
  border:1px solid var(--border);border-radius:16px;padding:14px 16px;margin-bottom:12px;box-shadow:var(--shadow)}
.metacard .ic{width:44px;height:44px;border-radius:12px;background:var(--accent-soft);
  display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0}
.metacard .t{font-weight:600;font-size:15px}
.metacard .s{font-size:13.5px;color:var(--muted);margin-top:1px}
.metacard .s a{font-weight:500}
.lockpill{display:inline-flex;align-items:center;gap:6px;background:var(--sunken);
  border:1px dashed var(--border-strong);border-radius:999px;padding:3px 12px;
  font-size:12.5px;color:var(--muted);margin-top:4px}
section{margin-top:36px}
.sectitle{font-family:'Corben',Georgia,serif;font-size:21px;font-weight:400;
  display:flex;align-items:center;gap:10px;margin-bottom:14px}
.sectitle::after{content:"";height:1px;flex:1;background:var(--border)}
.about{white-space:pre-wrap;color:#4A2E2E;font-size:15.5px;line-height:1.65}
/* guests */
.avatars{display:flex;align-items:center}
.av{width:42px;height:42px;border-radius:50%;border:2.5px solid var(--cream);
  display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;
  color:#5A3A3A;margin-left:-10px;flex-shrink:0}
.av:first-child{margin-left:0}
.av.more{background:var(--sunken);color:var(--muted);font-size:12px}
.gcount{font-size:14px;color:var(--muted);margin-top:10px}
.gcount b{color:var(--ink)}
/* activity */
.locked{position:relative;border-radius:20px;overflow:hidden;border:1px solid var(--border);background:var(--raised)}
.locked .rows{filter:blur(7px);opacity:.55;padding:18px;pointer-events:none}
.fakerow{display:flex;gap:12px;align-items:center;margin-bottom:16px}
.fakerow .b1{height:12px;border-radius:6px;background:var(--sunken);width:46%}
.fakerow .b2{height:9px;border-radius:6px;background:var(--sunken);width:28%;margin-top:6px}
.locked .veil{position:absolute;inset:0;display:flex;flex-direction:column;gap:10px;
  align-items:center;justify-content:center;text-align:center;padding:20px}
.locked .veil .lk{font-size:26px}
.locked .veil p{font-size:14.5px;color:var(--muted);max-width:260px}
.composer{display:flex;gap:10px;margin-bottom:18px}
.composer input{flex:1;background:var(--raised);border:1.5px solid var(--border);
  border-radius:999px;padding:11px 18px;outline:none;transition:border .15s}
.composer input:focus{border-color:var(--accent)}
.feeditem{display:flex;gap:12px;margin-bottom:20px}
.feeditem .body{flex:1;min-width:0}
.feedline{font-size:14.5px}
.feedline b{font-weight:600}
.feedline .st{white-space:nowrap}
.ago{color:var(--faint);font-size:12.5px;margin-left:6px}
.cbody{font-size:14.5px;color:#3D2424;margin-top:2px;overflow-wrap:break-word}
.reacts{display:flex;gap:6px;flex-wrap:wrap;margin-top:7px;align-items:center}
.rchip{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--border);
  background:var(--raised);border-radius:999px;padding:2.5px 10px;font-size:13px;transition:transform .1s}
.rchip:active{transform:scale(1.15)}
.rchip.mine{background:var(--accent-soft);border-color:var(--accent);color:var(--accent-hover)}
.rchip .n{font-size:12px;color:var(--muted);font-weight:600}
.raddb{border:1px dashed var(--border-strong);border-radius:999px;padding:2.5px 9px;
  font-size:12.5px;color:var(--faint)}
.replybtn{font-size:12.5px;color:var(--muted);font-weight:600}
.replies{margin-top:12px;padding-left:14px;border-left:2px solid var(--border)}
.replies .feeditem{margin-bottom:12px}
.replybox{display:flex;gap:8px;margin-top:8px}
.replybox input{flex:1;background:var(--raised);border:1.5px solid var(--border);
  border-radius:999px;padding:7px 14px;font-size:13.5px;outline:none}
.replybox input:focus{border-color:var(--accent)}
.picker{display:inline-flex;gap:2px;background:var(--raised);border:1px solid var(--border);
  border-radius:999px;padding:3px 6px;box-shadow:var(--shadow-pop)}
.picker button{font-size:17px;padding:2px 4px;border-radius:8px;transition:transform .1s}
.picker button:hover{transform:scale(1.25)}
/* ── right column ── */
/* Sticky only on desktop: on mobile the flyer is reordered to the top and a
   sticky aside pins over the whole page, hiding the event details. */
@media(min-width:881px){.flyer{position:sticky;top:24px}}
.coverwrap{background:#fff;padding:10px;border-radius:24px;box-shadow:var(--shadow-pop);
  transform:rotate(-1.2deg);transition:transform .25s}
.coverwrap:hover{transform:rotate(0deg) scale(1.005)}
.cover{width:100%;aspect-ratio:4/5;object-fit:cover;border-radius:16px;display:block}
.coverph{width:100%;aspect-ratio:4/5;border-radius:16px;display:flex;flex-direction:column;
  align-items:center;justify-content:center;gap:6px;color:#fff;text-align:center;
  background:
    radial-gradient(circle at 20% 15%, rgba(245,229,199,.9), transparent 55%),
    radial-gradient(circle at 85% 80%, rgba(201,168,224,.75), transparent 55%),
    linear-gradient(160deg,#D23B3A,#922424)}
.coverph .init{font-family:'Corben',Georgia,serif;font-size:72px;font-weight:700;line-height:1;text-shadow:0 3px 14px rgba(33,9,9,.3)}
.coverph .st{font-size:12px;letter-spacing:.24em;font-weight:600;opacity:.9}
.card{background:var(--raised);border:1px solid var(--border);border-radius:20px;
  padding:20px;margin-top:18px;box-shadow:var(--shadow)}
.cardtitle{font-family:'Corben',Georgia,serif;font-size:19px;margin-bottom:14px}
/* rsvp orbs */
.orbs{display:flex;justify-content:space-between;gap:8px}
.orb{flex:1;display:flex;flex-direction:column;align-items:center;gap:8px;padding:6px 2px;border-radius:16px;transition:background .15s}
.orb .face{width:62px;height:62px;border-radius:50%;background:var(--sunken);
  border:2px solid transparent;display:flex;align-items:center;justify-content:center;
  font-size:27px;box-shadow:inset 0 -3px 6px rgba(33,9,9,.05);transition:all .15s}
.orb:hover .face{transform:translateY(-2px) scale(1.05)}
.orb .lbl{font-size:13px;font-weight:600;color:var(--muted)}
.orb.sel .face{background:var(--accent-soft);border-color:var(--accent);
  box-shadow:0 0 0 4px rgba(210,59,58,.14)}
.orb.sel .lbl{color:var(--accent)}
.youare{display:flex;align-items:center;justify-content:space-between;margin-top:14px;
  background:var(--sunken);border-radius:999px;padding:8px 8px 8px 16px;font-size:14px}
.youare b{font-weight:700}
.youare button{background:var(--raised);border:1px solid var(--border);border-radius:999px;
  padding:5px 14px;font-size:12.5px;font-weight:600;color:var(--muted)}
/* tickets */
.tier{display:flex;align-items:center;gap:12px;padding:13px 0;border-bottom:1px solid var(--border)}
.tier:last-of-type{border-bottom:0}
.tier .inf{flex:1;min-width:0}
.tier .nm{font-weight:600;font-size:15px}
.tier .ds{font-size:12.5px;color:var(--muted);margin-top:1px}
.tier .low{font-size:12px;color:var(--warn);font-weight:600;margin-top:2px}
.tier .pr{font-weight:700;font-size:15px;white-space:nowrap}
.tier .pr .free{color:var(--success)}
.stepper{display:flex;align-items:center;gap:10px}
.stepbtn{width:30px;height:30px;border-radius:50%;border:1.5px solid var(--border-strong);
  font-size:16px;font-weight:600;color:var(--muted);display:flex;align-items:center;justify-content:center;transition:all .12s}
.stepbtn:hover{border-color:var(--accent);color:var(--accent)}
.stepbtn:disabled{opacity:.3;pointer-events:none}
.qty{min-width:16px;text-align:center;font-weight:700;font-size:15px}
.soldout{font-size:12.5px;font-weight:700;color:var(--faint);letter-spacing:.06em}
.buybtn{width:100%;margin-top:16px;background:var(--accent);color:#fff;font-weight:700;
  font-size:15.5px;border-radius:999px;padding:14px;transition:background .15s;box-shadow:0 6px 18px rgba(210,59,58,.35)}
.buybtn:hover{background:var(--accent-hover)}
.buybtn:disabled{background:var(--border-strong);box-shadow:none;pointer-events:none}
/* giving */
.giveprompt{font-size:13.5px;color:var(--muted);line-height:1.5;margin-bottom:12px}
.raised{background:var(--sunken);border-radius:14px;padding:10px 14px;font-size:14px;
  color:var(--muted);margin-bottom:14px}
.raised b{color:var(--accent);font-weight:700;font-size:16px}
.amtgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:10px}
.amtbtn{border:1.5px solid var(--border-strong);border-radius:14px;padding:11px 4px;
  font-weight:700;font-size:15px;color:var(--ink);transition:all .12s}
.amtbtn:hover{border-color:var(--accent);color:var(--accent)}
.amtbtn.sel{background:var(--accent-soft);border-color:var(--accent);color:var(--accent);
  box-shadow:0 0 0 3px rgba(210,59,58,.14)}
.amtcustom{display:flex;align-items:center;gap:8px;background:var(--raised);
  border:1.5px solid var(--border);border-radius:14px;padding:0 14px}
.amtcustom .cur{color:var(--muted);font-weight:700;font-size:15px}
.amtcustom input{flex:1;background:none;border:0;outline:none;padding:12px 0;font-size:15px;color:var(--ink)}
/* sheet */
.overlay{position:fixed;inset:0;background:rgba(33,9,9,.42);backdrop-filter:blur(5px);
  z-index:50;display:none;align-items:flex-end;justify-content:center}
@media(min-width:640px){.overlay{align-items:center}}
.overlay.open{display:flex}
.sheet{background:var(--cream);border-radius:26px 26px 0 0;width:100%;max-width:440px;
  padding:28px 24px 34px;position:relative;animation:up .25s ease}
@media(min-width:640px){.sheet{border-radius:26px;padding-bottom:28px}}
@keyframes up{from{transform:translateY(40px);opacity:0}to{transform:none;opacity:1}}
.sheet h3{font-family:'Corben',Georgia,serif;font-size:22px;margin-bottom:4px;padding-right:34px}
.sheet .sub{font-size:13.5px;color:var(--muted);margin-bottom:18px}
.sheet .x{position:absolute;top:18px;right:18px;width:32px;height:32px;border-radius:50%;
  background:var(--sunken);color:var(--muted);font-size:15px;display:flex;align-items:center;justify-content:center}
.fld{margin-bottom:12px}
.fld label{display:block;font-size:12.5px;font-weight:600;color:var(--muted);margin-bottom:5px}
.fld input{width:100%;background:var(--raised);border:1.5px solid var(--border);
  border-radius:14px;padding:12px 16px;outline:none;transition:border .15s}
.fld input:focus{border-color:var(--accent)}
.sheetbtn{width:100%;margin-top:8px;background:var(--accent);color:#fff;font-weight:700;
  font-size:15.5px;border-radius:999px;padding:14px}
.sheetbtn:hover{background:var(--accent-hover)}
.sheetbtn:disabled{opacity:.6;pointer-events:none}
.sheeterr{color:var(--accent);font-size:13px;margin-top:10px;text-align:center;min-height:16px}
/* toast */
#toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%) translateY(20px);
  background:var(--ink);color:var(--cream);border-radius:999px;padding:11px 22px;
  font-size:14px;font-weight:500;opacity:0;pointer-events:none;transition:all .3s;z-index:60;
  box-shadow:var(--shadow-pop);max-width:90vw;text-align:center}
#toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
footer{margin-top:70px;text-align:center;font-size:12.5px;color:var(--faint)}
footer .hearts{color:var(--accent)}
`;
