/**
 * The `/poll/<campaignId>/<token>/<blockId>/<optionId>` page — where a poll
 * option tapped inside a campaign email lands (served by `http.ts`, data +
 * writes in `campaignPolls.ts`).
 *
 * Same GET-is-read-only / POST-is-the-real-change shape as
 * `lib/unsubscribePage.ts` and `lib/projectActionPage.ts`: mail scanners
 * prefetch every href in a message, so the vote is only ever recorded by the
 * POST this page's confirm button issues. GET renders the button; that is all
 * it does. See `campaignPolls.ts`'s module doc for the full reasoning.
 *
 * ── Why this page is themed, unlike its siblings ───────────────────────────
 * The other public pages wear the fixed Public Worship shell (cream paper, red
 * ink, Corben). This one wears the CAMPAIGN'S OWN theme, read off the
 * document's inline `theme` snapshot through `normalizeEmailTheme` — the same
 * permissive read edge `emailRender.ts` paints the email with, so the landing
 * page is the same colours, the same fonts, and the same corner radius as the
 * email the reader just tapped. A seasonal newsletter that hands off to a
 * stock-branded page reads as a phishing link; matching the email is what makes
 * the tap feel like it stayed inside the same message.
 *
 * `normalizeEmailTheme` is total — a campaign with no theme (every document
 * written before themes existed) falls back to `DEFAULT_EMAIL_THEME`, so this
 * module never has to special-case a missing or malformed theme.
 */
import {
  DEFAULT_EMAIL_THEME,
  normalizeEmailTheme,
  resolveDarkTheme,
  type EmailTheme,
} from "@events-os/shared";
import { FAVICON } from "./landingPageStyles";
import { escapeHtml } from "./html";

const esc = escapeHtml;

/** One option's standing on the "thanks" page. */
export type PollTallyOption = { optionId: string; label: string; count: number };
export type PollTally = {
  question: string;
  totalVotes: number;
  options: PollTallyOption[];
};

/**
 * Theme → CSS. Every colour reaching here is a `#rgb`/`#rrggbb` string and
 * every font stack has already had `;{}<>()\` stripped, both guaranteed by
 * `normalizeEmailTheme` — which is why these can be interpolated into a
 * `<style>` block directly (HTML entities are NOT decoded inside `<style>`, so
 * escaping would corrupt the CSS rather than protect it; sanitizing at the
 * edge is the only correct defense, and the shared module does it).
 */
function themeCss(theme: EmailTheme): string {
  const dark = resolveDarkTheme(theme);
  return `
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;background:${theme.canvas};color:${theme.ink};font-family:${theme.bodyFont};-webkit-font-smoothing:antialiased}
main{max-width:480px;margin:0 auto;padding:28px 20px 80px}
.topbar{display:flex;justify-content:center;padding:6px 0 22px}
.wordmark{font-weight:700;font-size:12px;letter-spacing:.22em;color:${theme.accent}}
.card{background:${theme.surface};border:1px solid ${theme.border};border-radius:${theme.radius}px;padding:26px 24px;text-align:center}
h1{margin:0 0 10px;font-family:${theme.headingFont};font-size:22px;line-height:1.3;color:${theme.ink}}
p{margin:0;color:${theme.muted};font-size:14px;line-height:1.6}
.answer{display:inline-block;margin:14px 0 0;padding:10px 18px;border:1px solid ${theme.border};border-radius:999px;font-weight:700;font-size:15px;color:${theme.ink}}
.btn{display:block;width:100%;margin-top:18px;border:0;border-radius:999px;padding:13px 18px;font-family:${theme.bodyFont};font-size:15px;font-weight:700;background:${theme.accent};color:${theme.accentInk};cursor:pointer}
.btn:hover{opacity:.92}
.results{margin-top:20px;text-align:left}
.row{margin:0 0 12px}
.rowtop{display:flex;justify-content:space-between;font-size:13px;font-weight:600;color:${theme.ink};margin-bottom:5px}
.bar{height:8px;border-radius:999px;background:${theme.border};overflow:hidden}
.fill{height:8px;border-radius:999px;background:${theme.accent}}
.total{margin-top:16px;font-size:12px;color:${theme.muted};text-align:center}
@media (prefers-color-scheme:dark){
body{background:${dark.canvas};color:${dark.ink}}
.wordmark{color:${dark.accent}}
.card{background:${dark.surface};border-color:${dark.border}}
h1{color:${dark.ink}}
p,.total{color:${dark.muted}}
.answer{border-color:${dark.border};color:${dark.ink}}
.btn{background:${dark.accent};color:${dark.accentInk}}
.bar{background:${dark.border}}
.fill{background:${dark.accent}}
}
`;
}

/** The page shell — `noindex` (a tokenized, single-recipient URL must never
 *  reach a search index), the campaign's own wordmark strip, and nothing that
 *  fetches from another origin. */
function shell(theme: EmailTheme, title: string, body: string): string {
  const wordmark = theme.wordmark.trim() || DEFAULT_EMAIL_THEME.wordmark;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)} · Public Worship</title>${FAVICON}
<style>${themeCss(theme)}</style></head><body>
<main>
  <div class="topbar"><span class="wordmark">${esc(wordmark)}</span></div>
  ${body}
</main>
</body></html>`;
}

/**
 * The confirm page (GET). Shows the question and the answer that was tapped,
 * and a single button that POSTs to the SAME path — no vote has been recorded
 * at the moment this renders, and the copy says so, because a reader whose
 * mail client already prefetched the link must not believe they've voted when
 * they haven't.
 */
export function renderPollConfirm(opts: {
  theme: unknown;
  question: string;
  optionLabel: string;
  /** The same `/poll/...` path this page was fetched at — already URL-encoded
   *  by the caller (`http.ts`), which is what built the segments. */
  actionPath: string;
}): string {
  const theme = normalizeEmailTheme(opts.theme);
  return shell(
    theme,
    "Your answer",
    `<div class="card">
      <h1>${esc(opts.question)}</h1>
      <p>Confirm your answer:</p>
      <div class="answer">${esc(opts.optionLabel)}</div>
      <form method="post" action="${esc(opts.actionPath)}">
        <button class="btn" type="submit">Send my answer</button>
      </form>
    </div>`,
  );
}

/** Post-vote confirmation (POST result) — the recorded answer plus where the
 *  poll currently stands. */
export function renderPollThanks(opts: {
  theme: unknown;
  optionLabel: string;
  tally: PollTally;
}): string {
  const theme = normalizeEmailTheme(opts.theme);
  const total = opts.tally.totalVotes;
  const rows = opts.tally.options
    .map((option) => {
      const pct = total > 0 ? Math.round((option.count / total) * 100) : 0;
      return `<div class="row">
        <div class="rowtop"><span>${esc(option.label)}</span><span>${pct}%</span></div>
        <div class="bar"><div class="fill" style="width:${pct}%"></div></div>
      </div>`;
    })
    .join("");
  return shell(
    theme,
    "Answer recorded",
    `<div class="card">
      <h1>Your answer is in</h1>
      <p>${esc(opts.tally.question)}</p>
      <div class="answer">${esc(opts.optionLabel)}</div>
      <div class="results">${rows}</div>
      <div class="total">${total} ${total === 1 ? "answer" : "answers"} so far · you can change yours any time by tapping another option in the email.</div>
    </div>`,
  );
}

/** Unknown campaign / expired token / a hand-edited block or option id. One
 *  page for all four so a probe can't tell which segment it got wrong. Wears
 *  the default theme — there's no campaign to read one off. */
export function renderPollNotFound(): string {
  return shell(
    DEFAULT_EMAIL_THEME,
    "Link expired",
    `<div class="card">
      <h1>This link isn't valid</h1>
      <p>It may be from an old campaign, or the poll may have changed. Reply to the email if you'd still like to share your answer.</p>
    </div>`,
  );
}
