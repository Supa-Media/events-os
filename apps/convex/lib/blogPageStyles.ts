/**
 * Presentation for the Convex-rendered blog (`blogPage.ts`).
 *
 * Appended after `BASE_CSS` (`landingPageStyles.ts`) exactly like
 * `publicLedgerPageStyles.ts` is, so this file only carries what the blog
 * adds — it inherits the cream/ink/accent palette, the DM Sans + Corben
 * pairing, and the ambient gradient wash the rest of the public site uses.
 *
 * ── THIS IS A PORT, NOT A REDESIGN ──────────────────────────────────────────
 * A live, well-designed post moved from Astro to here, and a reader must not
 * be able to tell. The prose block below is `.pw-post` from
 * `apps/landing/src/styles/global.css` transcribed value for value: every
 * Tailwind utility in that file resolved by hand against
 * `apps/landing/tailwind.config.js` (text-lg → 1.125rem, mt-12 → 3rem,
 * red-200 → #EFA0A0, and so on). The class names are kept — `.pw-post`,
 * `.pw-scroll`, `.pw-note`, `.pw-reaction` — because the POST BODIES
 * THEMSELVES reference two of them: the existing doxology post wraps its
 * wide tables in `<div class="pw-scroll">` and its callouts in
 * `<div class="pw-note">` as raw HTML inside the markdown. Renaming them here
 * would silently unstyle content already written, and content already
 * written is now a database row nobody would think to grep.
 *
 * The named colour tokens are declared here rather than reused from
 * `BASE_CSS` where the two disagree: `BASE_CSS`'s `--accent-soft` is red-50
 * (#FBE8E8) while the prose block wants red-100/red-200/pink-softer, which
 * that palette never named. Declaring them makes each rule readable against
 * the Tailwind original instead of leaving a reviewer to guess whether a
 * near-miss hex was intentional.
 */
export const BLOG_CSS = `
:root{
  --red-50:#FBE8E8;--red-100:#F7CECE;--red-200:#EFA0A0;--red-300:#E47373;
  --red-500:#D23B3A;--red-600:#B62F2F;
  --pink-soft:#F2D2D2;--pink-softer:#F9DFDF;--cream-soft:#FAEEE9;
  /* The landing site writes body prose as ink at 85% and metadata at 60–75%.
     Spelled out here so the opacity ladder is visible in one place. */
  --ink-85:rgba(33,9,9,.85);--ink-80:rgba(33,9,9,.8);--ink-75:rgba(33,9,9,.75);
  --ink-70:rgba(33,9,9,.7);--ink-60:rgba(33,9,9,.6);--ink-50:rgba(33,9,9,.5);
}

/* ── Shell ── */
/* max-w-prose (42rem) + px-5 / sm:px-8 — Container size="narrow", which is
   what both blog pages used. */
main{max-width:42rem;margin:0 auto;padding:0 20px 80px;position:relative}
@media(min-width:640px){main{padding-left:32px;padding-right:32px}}
.topbar{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:14px 0 8px;flex-wrap:wrap}
.wordmark{font-weight:700;font-size:12px;letter-spacing:.22em;color:var(--accent);text-decoration:none}
.topnav{display:flex;gap:8px;flex-wrap:wrap}
.topnav a{display:inline-flex;align-items:center;background:var(--raised);border:1px solid var(--border);
  border-radius:999px;padding:6px 14px;font-size:12.5px;font-weight:600;color:var(--accent);
  text-decoration:none;box-shadow:var(--shadow)}
.topnav a:hover{background:var(--accent-soft)}

/* ── Index ── */
.indexhead{padding:40px 0 0;display:flex;flex-direction:column;align-items:flex-start;gap:12px}
@media(min-width:640px){.indexhead{padding-top:64px}}
/* .pw-eyebrow — the chip at the top of most sections of the landing site. */
.eyebrow{display:inline-flex;align-items:center;gap:8px;border-radius:10px;background:var(--pink-softer);
  padding:10px 16px;font-size:16px;font-weight:400;color:var(--ink)}
.eyebrow svg{width:16px;height:16px;flex:0 0 auto}
h1.indextitle{font-family:'Corben',Georgia,serif;font-weight:400;line-height:1.08;
  font-size:30px;letter-spacing:-.01em}
@media(min-width:640px){h1.indextitle{font-size:42px}}
@media(min-width:768px){h1.indextitle{font-size:52px}}
h1.indextitle .accent{color:var(--red-500)}
.indexlede{font-size:18px;line-height:1.625;color:var(--ink-75)}
.postlist{list-style:none;margin-top:48px;display:flex;flex-direction:column}
.postlist li{border-top:1px solid var(--red-100);padding-top:32px;margin-top:40px}
.postlist li:first-child{border-top:0;padding-top:0;margin-top:0}
.audience{font-family:'Corben',Georgia,serif;font-size:14px;color:var(--red-500)}
h2.postlink{margin-top:8px;font-family:'Corben',Georgia,serif;font-size:24px;font-weight:400;line-height:1.25}
h2.postlink a{color:var(--ink);text-decoration:none}
h2.postlink a:hover{color:var(--red-500)}
.postsummary{margin-top:12px;line-height:1.625;color:var(--ink-75)}
.postmeta{margin-top:12px;font-size:14px;color:var(--ink-60)}
.empty{margin-top:48px;font-size:18px;color:var(--ink-70)}
.feedline{margin-top:64px;font-size:14px;color:var(--ink-60)}
.feedline a,.backlink a{color:var(--red-500);text-decoration:underline;
  text-decoration-color:var(--red-200);text-underline-offset:2px}
.feedline a:hover,.backlink a:hover{text-decoration-color:var(--red-500)}

/* ── Post header ── */
article{padding-top:40px}
@media(min-width:640px){article{padding-top:64px}}
h1.posttitle{margin-top:12px;font-family:'Corben',Georgia,serif;font-weight:400;
  line-height:1.1;font-size:30px}
@media(min-width:640px){h1.posttitle{font-size:42px}}
.standfirst{margin-top:16px;font-size:18px;font-style:italic;line-height:1.625;color:var(--ink-75)}
.byline{margin-top:24px;display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;
  font-size:14px;color:var(--ink-60)}
.updated{margin-top:4px;font-size:14px;color:var(--ink-50)}
.hero{margin-top:32px;width:100%;border-radius:16px;object-fit:cover;display:block}

/* ── Table of contents ── */
.toc{margin-top:40px;border-radius:16px;background:var(--cream-soft);padding:16px 20px}
.toc h2{font-family:'Corben',Georgia,serif;font-size:14px;font-weight:400;color:var(--red-500)}
.toc ol{margin-top:8px;font-size:14px;padding-left:0;list-style:none}
.toc li + li{margin-top:6px}
.toc a{color:var(--ink-80);text-decoration:underline;text-decoration-color:var(--red-200);
  text-underline-offset:2px}
.toc a:hover{color:var(--red-500);text-decoration-color:var(--red-500)}

/* ── Tags, back link ── */
.tags{list-style:none;margin-top:48px;display:flex;flex-wrap:wrap;gap:8px}
.tags li{border-radius:999px;background:var(--pink-softer);padding:4px 12px;font-size:14px;color:var(--ink-70)}
.backlink{margin:48px 0 80px;border-top:1px solid var(--red-100);padding-top:32px;font-size:16px}

/* ── Banners ── */
/* The draft banner. In flow rather than fixed (the finances preview banner is
   fixed) because a draft here is READ, top to bottom, by an editor — a bar
   pinned over the first two lines of the piece they were asked to react to
   costs more than it warns. The noindex meta, the no-store header, and the
   URL's own token do the enforcing; this only has to be unmissable on
   arrival. */
.banner{margin-top:24px;border-radius:12px;border:1px solid var(--red-200);background:var(--pink-softer);
  padding:12px 16px;font-size:14px;color:var(--ink);line-height:1.5}
.banner strong{font-weight:600}
.takedown{margin-top:40px;border-radius:16px;background:var(--cream-soft);padding:24px 20px}
.takedown h1{font-family:'Corben',Georgia,serif;font-weight:400;font-size:26px;line-height:1.2}
.takedown p{margin-top:12px;line-height:1.625;color:var(--ink-75)}
.takedown p + p{margin-top:12px}

/* =================================================================
   Blog post body (.pw-post) — ported from
   apps/landing/src/styles/global.css. Hand-rolled there rather than
   @tailwindcss/typography, and hand-rolled here for the same reason: a
   dozen elements styled against tokens we would have had to override.
   ================================================================= */
.pw-post{font-size:18px;line-height:1.625;color:var(--ink-85)}
.pw-post > * + *{margin-top:20px}
/* scroll-margin clears the jump target from the top of the viewport when the
   table of contents links into the piece. */
.pw-post h2{margin-top:48px;font-family:'Corben',Georgia,serif;font-size:24px;font-weight:400;
  line-height:1.375;color:var(--ink);scroll-margin-top:2rem}
.pw-post h3{margin-top:36px;font-family:'Corben',Georgia,serif;font-size:20px;font-weight:400;
  color:var(--ink);scroll-margin-top:2rem}
.pw-post h4{margin-top:28px;font-size:18px;font-weight:600;color:var(--ink)}
.pw-post a{color:var(--red-500);text-decoration:underline;text-decoration-color:var(--red-200);
  text-underline-offset:2px}
.pw-post a:hover{text-decoration-color:var(--red-500)}
.pw-post strong{font-weight:600;color:var(--ink)}
.pw-post ul{list-style:disc;padding-left:24px}
.pw-post ol{list-style:decimal;padding-left:24px}
.pw-post li + li{margin-top:8px}
.pw-post li::marker{color:var(--red-300)}
/* Pull quote / scripture. */
.pw-post blockquote{border-left:4px solid var(--red-200);border-radius:0 12px 12px 0;
  background:var(--cream-soft);padding:12px 16px 12px 20px;font-style:italic;color:var(--ink-80)}
.pw-post blockquote p + p{margin-top:12px}
.pw-post hr{margin:40px 0;border:0;border-top:1px solid var(--red-100)}
.pw-post code{border-radius:4px;background:var(--cream-soft);padding:2px 6px;font-size:.9em}
/* Wraps a wide table in the markdown source. The page body must never scroll
   sideways, so the overflow is contained here. */
.pw-post .pw-scroll{margin-left:-20px;margin-right:-20px;padding-left:20px;padding-right:20px;overflow-x:auto}
@media(min-width:640px){.pw-post .pw-scroll{margin-left:0;margin-right:0;padding-left:0;padding-right:0}}
.pw-post table{width:100%;min-width:36rem;border-collapse:collapse;text-align:left;font-size:16px}
.pw-post th{border-bottom:1px solid var(--red-200);padding:0 16px 8px 0;vertical-align:bottom;
  font-size:14px;font-weight:600;text-transform:uppercase;letter-spacing:.025em;color:var(--ink-60)}
.pw-post td{border-bottom:1px solid var(--red-100);padding:12px 16px 12px 0;vertical-align:top;font-size:16px}
/* An aside — the callout boxes in a long post. */
.pw-post .pw-note{border-radius:16px;background:var(--pink-softer);padding:16px 20px;font-size:16px}
.pw-post .pw-note > * + *{margin-top:12px}
.pw-post img{max-width:100%;height:auto;border-radius:12px;display:block}

/* =================================================================
   Reaction bar (blogPageClient.ts drives it)
   ================================================================= */
.reactions{margin-top:56px;border-top:1px solid var(--red-100);padding-top:32px}
.reactions h2{font-family:'Corben',Georgia,serif;font-size:18px;font-weight:400;color:var(--ink-70)}
.reactions .blurb{margin-top:4px;font-size:14px;color:var(--ink-60)}
.reactionlist{margin-top:16px;display:flex;flex-wrap:wrap;gap:10px}
.pw-reaction{display:inline-flex;align-items:center;gap:8px;border-radius:999px;
  border:1px solid var(--red-100);background:#fff;padding:8px 14px;transition:border-color .15s,background .15s}
.pw-reaction:hover:not(:disabled){border-color:var(--red-300);background:var(--pink-softer)}
/* Pressed = this browser left this reaction. Not a colour-only signal: the
   button also carries aria-pressed for anyone not seeing the fill. */
.pw-reaction[aria-pressed="true"]{border-color:#DA5454;background:var(--pink-soft)}
.pw-reaction:disabled{cursor:default;opacity:.5}
.pw-reaction .emoji{font-size:18px;line-height:1}
.pw-reaction .count{font-size:14px;font-weight:500;font-variant-numeric:tabular-nums;color:var(--ink-70)}
/* Reserved line for "couldn't save that" — kept in the DOM (empty) so an
   error never shifts the layout. */
.reactionerror{margin-top:12px;min-height:1.25rem;font-size:14px;color:var(--red-600)}
`;
