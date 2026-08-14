/**
 * The Finances stream (WP-5.1) — where the money comes from, how it's
 * tracked, and who signs off on it. Also the Finances theme + its six
 * courses: five role courses (Finances for Everyone / Treasurer / Chapter
 * Director / Financial Manager / Executive Director) plus the shared
 * `chapter-money-model` core course (tiers + skim, the budget lifecycle,
 * one-home-per-dollar attribution) that Treasurer and Chapter Director both
 * build on — see `docs/plans/finance-v2-split-prd.md` §Phase 5.
 *
 * Owned exclusively by this file for content authoring — do not add Finances
 * sections or courses anywhere else. See `../index` for how this assembles
 * into the full curriculum/catalog.
 *
 * F-6 touch-up (giving-platform PRD §8): `finance-tiers-and-skim` no longer
 * lets "backer count" stand as an unexplained given — it now teaches WHERE
 * the number comes from (derived live from ACTIVE pledges on the Giving
 * page, with no hand-entry path at all: the manual setter was deleted after
 * a typed-in 2 outlived New York's real 0 on a public page), plus why a
 * `past_due` pledge does NOT count. The "what does the City Launch Fund pay
 * for?" question was retired from that quiz to make room — the same prompt is
 * asked in `finance-launch-grants-and-transfers` (with its own options and
 * explanation), which is where the fund is actually taught — so the quiz stays
 * at the 5-question cap
 * `apps/convex/tests/academy.test.ts` enforces. The
 * `finance-stewardship` quiz's "future Giving page" aside was also
 * corrected — the Giving page is shipped, not future. Every other Finances
 * teaching in this file is unchanged; see `streams/development.ts` for the
 * full backer-model lesson this touch-up points to.
 *
 * Auto-ACH + submission-email touch-up (reimbursement flow shipped three
 * changes at once): `finance-reimbursements-and-flags` now teaches that
 * approval itself fires the ACH payout automatically (no separate manual
 * send step), and that submitting a request already emails every finance
 * approver in the chapter — the old "there's no notification, call your
 * Treasurer" tip was rewritten so the direct nudge is framed as making an
 * already-notified approver move faster, not as the only signal that
 * exists. `finance-monthly-close`'s "queue triaged" bullet got one clause
 * noting the email is a nudge, not a substitute for clearing the queue.
 * No quiz answers changed truth value — none of the existing questions
 * asserted "no notification" or "manual payout" as fact. Titles, minutes,
 * and quiz lengths are unchanged, so the snapshot test needed no updates.
 *
 * Review fix: `finance-reimbursements-and-flags`'s auto-ACH line now notes
 * the manual-payout fallback for a chapter whose Increase account isn't set
 * up yet, so it no longer reads as an unconditional guarantee. No titles,
 * minutes, or quiz content changed.
 *
 * Budget-decision email touch-up (founder feedback review — the two-party
 * approval workflow now emails BOTH directions): `finance-approving-budgets`
 * and `finance-budget-lifecycle` each gained a clause on their "send" and
 * "approve/request changes" bullets — submitting already emailed the scope's
 * approvers before this touch-up (unchanged); approving or requesting
 * changes now ALSO emails the submitter back (new), note included on a
 * Changes requested decision. Mirrors the reimbursement touch-up above.
 * Neither section's title, minutes, or quiz length changed, so the snapshot
 * test needed no updates.
 *
 * Reimbursements-are-spend touch-up (founder report, 2026-07-26 — a paid
 * reimbursement used to post as a `transfer`, so it showed a budget and a
 * category in the UI while contributing $0 to both bars; it now posts as an
 * `outflow` like any other charge): `finance-reimbursements-and-flags` gained
 * one bullet saying a reimbursed purchase spends its budget the same way a
 * card swipe does, so the coding on the request is what decides the bucket.
 * No existing teaching changed truth value — nothing here ever claimed
 * reimbursements were budget-invisible. Title, minutes, and quiz length are
 * unchanged, so the snapshot test needed no updates.
 *
 * Skim-automation retirement (founder decision, 2026-07-26 — "we just have 1
 * chapter and not a lot of backers, it feels unnecessarily complex... it
 * could be just a manual transfer"; collapsed the skim/launch-grant/
 * settlement mutations into one generic `transfers.ts#recordTransfer`):
 * `finance-tiers-and-skim` gained a tip explaining the 15% is still real and
 * owed, just recorded as a deliberate manual transfer (not automated), and
 * swapped its "does a higher tier change the skim %" quiz question (already
 * redundant with an earlier question in the same quiz) for one testing that
 * same manual-transfer point — quiz length stays 5, minutes 4→5 (bumped in
 * the snapshot test). `finance-launch-grants-and-transfers` was rewritten end
 * to end: it used to frame automated Increase transfers as "coming with
 * Phase 4" — since that automation was built and then DELETED per this
 * decision, the lesson no longer promises a pipe that isn't coming; both
 * flows are now taught as deliberate, by-design manual transfers. Its quiz
 * answer about automation timing was corrected to match (still 3 questions —
 * no snapshot change there). Title and slug are unchanged for both sections.
 *
 * Transaction coding (docs/plans/transaction-coding.md, owner decisions
 * 2026-08-08). Phase 1 added the Treasurer's half as a rule on
 * `finance-reconcile-grid` ("Reconciled means coded, too"). Phase 2 makes it
 * every cardholder's job, so this file gained a NEW section —
 * `finance-coding-your-charges` (5 min, 5-quiz), inserted into
 * `finances-for-everyone` between `finance-receipt-exceptions` and
 * `finance-reimbursements-and-flags`. It teaches the spender's half: the
 * what/why/who record you author and someone else approves, the business
 * purpose written FOR THE PUBLIC ("travel to NY to film Eden event", never
 * "bus to NY"), routes on travel, the 15-HEAD meal threshold (names +
 * relationship at or below it, headcount + an identifiable group above it —
 * never a dollar trigger), that names never publish (the ledger prints the
 * affiliation breakdown instead), the lodging itemized-receipt exception to
 * the exception flow, why no AI ever drafts a coding (though your own words
 * from a reimbursement request follow you into the form, labeled),
 * and the clock — one digest, day-3 escalation, the existing day-7 lock, and
 * the 60-day auto-convert to a personal repayment, explained in plain words
 * (unsubstantiated spending is legally taxable income to the spender under
 * IRS accountable-plan rules). The policy applies to charges posted on/after
 * September 1, 2026; earlier history is a separate deliberate cleanup.
 * `finance-card-and-receipts` and `finance-receipt-exceptions` were left
 * alone — both quizzes sit at the 5-question cap, and this lesson leans on
 * the exception vocabulary rather than repeating it, which is why it sits
 * after that section rather than directly after the card lesson.
 *
 * Transaction coding phase 3 — reimbursement parity — then updated
 * `finance-reimbursements-and-flags` for two shipped behavior changes, adding
 * no sections and moving none. (1) A new rule, "Every line answers for
 * itself": substantiation is per LINE, not per request (one request mixes a
 * fare, a hotel night and a team dinner), validated by the same shared
 * checker in the in-app form, the accountless `/reimburse/<token>` page, and
 * the server, with submission blocked until every line is complete — it
 * deliberately CROSS-REFERENCES `finance-coding-your-charges` for the meal/
 * travel rules instead of restating them, and states the receipt asymmetry
 * plainly: no exception path here, because a reimbursement is a claim you
 * choose to make while a card charge already happened. (2) A new rule, "Sent
 * back is not rejected": the `changes_requested` loop with its required note,
 * the email, resubmission preserving the ORIGINAL submission date, and the
 * two deliberate limits (a revision may change substantiation only — a wrong
 * amount is a reject-and-refile, never a quiet edit under a reviewer who
 * already saw the number — and a sent-back request stays cancelable and
 * rejectable but is not payable). The first bullet and the `try_status`
 * caption were updated to match. Quiz length stays 5 (the cap): the "where do
 * you see both directions" navigation question was retired — still taught by
 * the bullet right above it — for one on the send-back loop, and the
 * out-of-pocket question's answer now names per-line coding. Minutes stay 5.
 *
 * Documentation fuses into coding (owner decision, 2026-08-08: "we don't even
 * need the receipt matching pipeline as much if people are going to code
 * things themselves, they should just upload the receipt when coding"). Two
 * shipped rules, six sections touched, none added or moved. (1) A coding no
 * longer submits unless the charge has a receipt attached or a receipt
 * exception FILED — a pending one counts, because the gate asks whether the
 * AUTHOR finished their half, and waiting on an approver would strand the
 * charge in a queue its owner can't clear; reconciling still needs the
 * exception APPROVED, so nothing publishes on an unweighed claim. (2) Emailed
 * and texted receipts are still captured — that half matters, since a charge
 * posts about a day after the swipe and the receipt is in your hand at the
 * counter — but they no longer auto-attach; they wait in the receipts library
 * and are OFFERED as a match when the cardholder opens that charge to code it,
 * confirmed in one tap by the one person looking at both.
 *
 * So `finance-card-and-receipts` gained a forward-pointer paragraph (a receipt
 * is half of what a charge owes) and the rule "Sending it in is not attaching
 * it", rewrote its email tip around capture-at-the-counter, and swapped its
 * weakest question — the "where do you see your own charges" navigation one,
 * whose answer now rides in the replacement's explanation — for one on an
 * emailed receipt nobody has confirmed yet, which is the misread that now
 * costs someone a card lock. `finance-receipt-exceptions` says the refusal
 * bites at SUBMISSION as well as at reconcile, files the exception from the
 * coding sheet, and marks the pending nuance in its try_status caption and one
 * explanation. `finance-coding-your-charges` retired "A receipt and a coding
 * are two separate obligations" for the rule that replaced it, "One act, not
 * two errands" — the deadlines that paragraph hung off the split are unchanged
 * and still taught (day-7 card lock on the receipt, day-60 conversion) — plus
 * a paragraph on the offered-receipt tap; its pizza-vs-dinner question, the
 * same numbers as the `scenario` block directly above it, gave way to one on
 * coding a cash charge that will never have a receipt. `finance-reconcile-grid`
 * tells the reviewer every coding now arrives documented (and that a pending
 * exception still needs their decision). `finance-chasing-receipts` and
 * `finance-receipt-escalation-queue` carry the same warning from the other
 * side — a full receipts library is not a documented month — the treasurer
 * lesson swapping its who-unlocks-the-card question (answered verbatim by the
 * `reveal` block above it) for the nine-receipts/nine-undocumented case, and
 * the FM lesson gaining a FOURTH question (3 → 4, bumped in the snapshot
 * test). Minutes are unchanged everywhere.
 *
 * Reconcile states + no default filter (2026-08-09, shipping with the filter
 * rework in `@events-os/shared`'s `reconcileFilters.ts` and
 * `finances.listReconcile`): a content-only edit to three Finances sections,
 * adding and moving none. Four product changes drove it. (1) "Undocumented"
 * is now **"Closed without documentation"** and means only the CLOSED tail —
 * reconciled, with neither a receipt nor an approved exception. It used to
 * ignore status, which made it a strict superset of "Needs documentation"
 * (in production: 42 in common, 3 only-undocumented, 0 only-missing-receipt),
 * so the menu offered two near-identical labels with two near-identical
 * numbers and picking the bigger one showed you the rows you'd just looked at.
 * The two are now DISJOINT and the publishing backlog is their OR, which —
 * same filter group — is what multi-select already gives you. (2) The header's
 * single "N to clear" became three tappable chips: Needs attention (open, with
 * something outstanding), Ready to close (open, with nothing outstanding — one
 * keystroke from done) and Reconciled. In production 76 of 127 open rows were
 * Ready to close, and no filter could find them. (3) The page no longer opens
 * on a default filter (it pre-selected Needs budget and showed 14 of 346
 * rows), and search now covers the whole book instead of whatever the State
 * filter left. (4) Needs budget counts open rows only; Needs coding / Coding
 * review are hidden until the coding policy starts (2026-09-01), since before
 * then they can only return zero.
 *
 * So `finance-reconcile-grid` lost the retired "All" row from its filter table
 * and gained the "Closed without documentation" one, a paragraph on the
 * unfiltered open + whole-book search, and the rule that carries the new daily
 * workflow ("The header's three numbers — and the pile that was never a
 * backlog"); its bulk-select question — the one whose real subject was now
 * Ready to close — was rewritten around the three chips, keeping the bulk-bar
 * teaching (including the two-legs-for-a-transfer detail) in its explanation.
 * `finance-chasing-receipts` rewrote its two-filters paragraph around the
 * disjoint pair and the union, and replaced the "Needs documentation: 0 but
 * Undocumented: 14" question — which tested the retired superset relationship —
 * with one that asks how big the publishing backlog is given both numbers, its
 * fourth option being the old shape. `finance-receipt-exceptions`'s treasurer
 * tip names both halves instead of the single old filter. Titles, minutes and
 * quiz lengths are unchanged everywhere (both rewritten quizzes are at the
 * 5-question cap, so the questions were swapped, not added).
 *
 * FOUNDER CALL, 2026-08-12 — three changes, one new section.
 *
 * `finance-three-tracks` ("Green, yellow, red") is NEW, inserted between
 * `finance-stewardship` and `finance-card-and-receipts`. It teaches the
 * spending policy in the founder's own frame: name the budget it comes out of,
 * check there's enough left in it, then decide the track — green (spend, and
 * tell the budget's owner it's landing there), yellow (get a yes BEFORE
 * spending, not after), red (don't; no budget or approval makes it green, and
 * it comes back as a personal charge). "What exactly is red" is spelled out
 * because the founder asked for precisely that — the honest test being whether
 * you'd want a backer to see the receipt.
 *
 * It sits BEFORE the card lesson because that is the real sequence: whose
 * money it is → the check you run before you spend → closing the loop
 * afterwards. Every other finance lesson in this course starts after the money
 * has already left, which is the point at which none of it is cheap to change.
 * It also carries the budget-owner rule from the same call: one person owns
 * each event/project budget, and spending WITHIN an approved budget is a
 * heads-up to them, not a fresh approval.
 *
 * Deliberately no product mechanism: there is no track field and no gate that
 * reads one. The founders were explicit that this is enforced by training and
 * meetings rather than software ("there's not really a way you can enforce
 * it… it'll just be training"). What the product does enforce — approved
 * budgets capping spend, coding review, an unaccounted charge becoming
 * personal — is taught in the lessons that own those mechanisms.
 *
 * `finance-tiers-and-skim` now DERIVES the operating formula instead of
 * asserting it. The founder asked "where does 570 come from?" and the honest
 * answer already existed in `finance.ts`'s constants but had never reached the
 * lesson: film $200 · event food $160 · equipment transport $100 · storage $60
 * · software $50 = the $570 fixed base, plus $20/teammate for the monthly team
 * meal. Added with it: an explicit rule that adding a teammate costs real
 * recurring money (her ask — "let chapter directors know that it's not free to
 * add people to the team") framed as a reason to grow deliberately rather than
 * a reason to stay small; and the conference sinking fund both EXPLAINED (so
 * teammates don't personally bear the cost of the network getting in one room,
 * and so central isn't asked to fund a 50-person team's seats) and flagged as
 * the model's one forward-looking line, since no conference is scheduled. Two
 * questions swapped in at the 5-cap — see the snapshot test's header for which
 * two came out and why.
 *
 * `finance-card-and-receipts` gained the one caveat that makes its day-7 table
 * true: the auto-lock works by Increase asking us to approve each
 * authorization in real time, which only happens for cards Increase issued. A
 * legacy Relay card linked by last-4 has no Increase object, so it cannot be
 * locked — and the sweep no longer pretends otherwise (see
 * `cards.ts#canEnforceCardLock` and migration 0064, which releases the rows it
 * had already falsely stamped). The lesson says so plainly and says what does
 * still apply, which is everything else. Its swapped-in question tests exactly
 * that distinction: the lock is one enforcement mechanism, not the rule.
 *
 * Reimbursement-prefill touch-up (owner directive, 2026-08-12 — "auto
 * populate with request purpose notes that we already have… remove a copy
 * and paste step"): a reimbursement payout's PRISTINE coding form now starts
 * from the claimant's own request words (`reimbursementPrefill.ts`), with a
 * provenance line and everything editable. `finance-coding-your-charges`'s
 * "never pre-filled" rule was retitled ("No AI ever writes your words — but
 * your own words follow you") and rewritten to teach the carve-out honestly:
 * machine-GENERATED text stays banned; a human's existing testimony carried
 * forward, labeled, is not that. The reconcile lesson's "nothing is
 * pre-filled" clause gained the same parenthetical. The Transportation quiz
 * question is scoped to a card charge — where nothing prefills — so it stays
 * true as written. Titles, minutes, and quiz lengths unchanged.
 *
 * Same day, the reconcile lesson's "Never your own, either way" gained the
 * solo-operator parenthetical: "Submit & approve" now exists in the product
 * (superuser-only single-party approval, recorded as such — shipped
 * 2026-08-11/12), and teaching the separation as absolute with no stated
 * exception would have the lesson contradict a button the founder can see.
 */

import type {
  AcademySection,
  Course,
  Theme,
} from "../types";

/** The Finances-stream sections, in curriculum order. */
export const FINANCES_SECTIONS: Omit<AcademySection, "order">[] = [
  // ══ Finances (WP-5.1) ════════════════════════════════════════════════════
  // Five role courses (Finances for Everyone / Treasurer / Chapter Director /
  // Financial Manager / Executive Director), authored from the shipped
  // finance surface (Reconcile, the 7-day receipt auto-lock, reimbursements,
  // seats, explicit-only budget attribution, central budgets, the budget
  // approval workflow — WP-3.2) — see `docs/plans/finance-v2-split-prd.md`
  // §Phase 5. Where a lesson teaches a workflow that isn't built yet
  // (automated skim/launch-grant transfers — Phase 4), a `tip` block says so
  // plainly; the doctrine is real even where the button isn't yet. Content
  // authoring depth here is WP-5.1's "concise starter content" — full depth
  // is WP-5.2.

  // ── 31 · Finances for everyone: stewardship ────────────────────────────────
  {
    slug: "finance-stewardship",
    title: "Where the money comes from",
    subtitle: "Backers, the card, and spending like it's not yours",
    minutes: 4,
    blocks: [
      {
        kind: "p",
        text: "Public Worship runs on backers — people who commit real dollars every month because they believe in the mission, not customers buying a product. Every dollar on your card started as someone's monthly gift. That's not guilt-tripping; it's the frame that should sit behind every purchase decision you make.",
      },
      {
        kind: "bullets",
        items: [
          "**A backer gives monthly, not once.** The floor is $50/month — a real, recurring commitment, not a one-time donation.",
          "**Backer count, not backer dollars, drives the model.** Headcount sets the tier a chapter operates at (see the Treasurer and Chapter Director courses) — a chapter grows by adding backers, not by asking existing ones for more.",
          "**The card exists so you don't front cash.** You spend on the mission's behalf; the app tracks it so nobody — including you — has to remember what you're owed.",
          "**Reach for the Public Worship card first.** For any Public Worship expense, always try the Public Worship card before reimbursing yourself or covering it another way — it's the cleanest record and the default path, not a last resort.",
        ],
      },
      {
        kind: "rule",
        title: "Spend like a steward, not an owner",
        text: "The money isn't the chapter's to spend however feels right in the moment — it's backers' trust, converted to dollars, for a specific mission. Before a purchase: would you be comfortable a backer saw the receipt?",
      },
      {
        kind: "reveal",
        prompt:
          "You're at the hardware store buying event supplies and spot a discounted item you personally want, same trip. Put it on the Public Worship card?",
        answer:
          "No — even a great deal. The card is for mission spending only; personal items go on your own card, full stop. If a personal charge lands on the Public Worship card by accident, flag it immediately (the next lesson) rather than hoping nobody notices.",
      },
      {
        kind: "rule",
        title: "Want to cover something personally? Donate it, don't spend it.",
        text: '"I\'ll just cover the meal myself" feels generous, but it quietly takes the expense off the books — Public Worship never sees it, your Treasurer can\'t track it, and a handful of these a year adds up to real spending nobody can account for. The steward\'s move is the SAME generosity, routed correctly: make a donation to Public Worship, then let Public Worship pay the expense on the Public Worship card. Same dollars out of your pocket, same mission funded — but now it\'s a clean, trackable record instead of an invisible one. And unlike a silent personal cover, your gift may be deductible depending on applicable tax rules and the nature of the contribution.',
      },
      {
        kind: "reveal",
        prompt:
          "Your team is $40 short for the after-event meal. You're tempted to just pay it yourself so nobody has to deal with reimbursement. What's the better move?",
        answer:
          "Donate the $40 to Public Worship, then let Public Worship pay for the meal on the Public Worship card. Same generosity, same $40 out of your pocket — but now it's a real, trackable gift instead of an invisible personal favor, and it may be deductible depending on applicable tax rules and the nature of the contribution.",
      },
    ],
    quiz: [
      {
        prompt: "What actually grows a chapter's operating budget, per the model?",
        options: [
          "Asking current backers to give more each month",
          "Adding more backers — headcount, not total dollars, is the unit the system tracks",
          "Running more events",
          "Cutting operating costs",
        ],
        answerIndex: 1,
        explanation:
          "Tiers and the operating formula key off backer COUNT. A chapter scales by growing its base of backers, not by squeezing more out of the ones it has.",
      },
      {
        prompt: "What is the $50/month backer floor?",
        options: [
          "A one-time donation minimum",
          "The recurring monthly commitment that makes someone a backer",
          "A price for merchandise",
          "A chapter's total monthly budget",
        ],
        answerIndex: 1,
        explanation:
          "A backer gives every month, not once — $50/month is the floor for that ongoing commitment (above-and-beyond giving, donor stewardship, and sponsorships live on the Giving page — see the Development stream).",
      },
      {
        prompt: "Why track backers by count instead of total dollars raised?",
        options: [
          "Dollars are hard to add up",
          "Headcount is the unit the tier table and operating formula are built on — a stable base of people, not a lump sum, sustains a chapter",
          "It's a legal requirement",
          "Donations aren't recorded individually",
        ],
        answerIndex: 1,
        explanation:
          "Every constant in the model — tiers, the operating formula — is keyed on backer headcount. That's deliberate: people who keep giving matter more than any single big gift.",
      },
      {
        prompt: "You see a discounted personal item while buying event supplies. What's the rule?",
        options: [
          "Buy it on the Public Worship card — it was a good deal",
          "Never put personal purchases on the card; flag it immediately if one lands there by accident",
          "Only buy it if it's under $20",
          "Ask your Treasurer first, then buy it either way",
        ],
        answerIndex: 1,
        explanation:
          "The card is mission-only, no exceptions for good deals. An accidental personal charge gets flagged right away, not left for someone else to find later.",
      },
      {
        prompt:
          "A teammate wants to personally cover a $40 team meal instead of dealing with reimbursement. What's the steward's move?",
        options: [
          "Let them quietly cover it — it saves everyone the reimbursement paperwork",
          "Tell them personal generosity toward the team isn't allowed at all",
          "Have them donate the $40 to Public Worship, then let Public Worship pay for the meal on the Public Worship card",
          "Have them put it on their own card and expense it later as a personal gift",
        ],
        answerIndex: 2,
        explanation:
          "Same generosity, routed correctly: a donation plus the Public Worship card keeps the expense on the books instead of turning into one more untrackable personal favor — and it may be deductible depending on applicable tax rules and the nature of the contribution.",
      },
    ],
  },

  // ── 31b · Finances for everyone: the three tracks ──────────────────────────
  // Founder policy, 2026-08-12 call: "when spending, it's green, yellow, red…
  // know what budget you're going to be spending out of, and know that there
  // is enough money in that budget for it… get approval if it's yellow track.
  // Never red. And just making sure that everybody knows what exactly is red."
  //
  // Placed BETWEEN stewardship and the card lesson because that's the real
  // sequence: whose money it is → the check you run BEFORE you spend → closing
  // the loop after. Every other finance lesson in this course is about what
  // happens once the money has already left; this is the only one that runs
  // beforehand, which is the only moment any of it is still cheap to change.
  //
  // The tracks are DELIBERATELY not a product feature. There is no track field
  // on a transaction and no gate that reads one — enforcement is a person
  // deciding before they tap, and the founders were explicit that this is
  // taught and reinforced in meetings rather than enforced by software ("there's
  // not really a way you can enforce it… it'll just be training"). What the
  // product does enforce lives elsewhere and is already taught elsewhere:
  // approved budgets cap spending, coding is reviewed, an unaccounted-for
  // charge becomes personal. This lesson is the judgment those mechanisms
  // assume.
  {
    slug: "finance-three-tracks",
    title: "Green, yellow, red",
    subtitle: "The thirty seconds before you tap the card",
    minutes: 4,
    blocks: [
      {
        kind: "p",
        text: "Almost every money problem a chapter has starts in the same place: someone spent first and worked out the details afterwards. Not dishonestly — they were at a store, the event was Saturday, it seemed obviously fine. The fix isn't more paperwork afterwards. It's about thirty seconds of thinking before.",
      },
      {
        kind: "heading",
        text: "Three questions, in order",
      },
      {
        kind: "bullets",
        items: [
          "**Which budget does this come out of?** Not \"the chapter's money\" — a specific, named, approved budget. If you can't name one, you've already found your answer: this isn't green.",
          "**Is there enough left in it?** Not what the budget started at — what's left after everything already charged to it. Open it and look; the app knows.",
          "**Which track is this on — green, yellow, or red?** The rest of this lesson.",
        ],
      },
      {
        kind: "table",
        headers: ["Track", "What it means", "What you do"],
        rows: [
          [
            "🟢 **Green**",
            "An approved budget covers it, there's room, and it's the ordinary kind of thing that budget is for",
            "Spend. Tell the budget's owner it's landing on their budget.",
          ],
          [
            "🟡 **Yellow**",
            "Real mission spending, but something is off-pattern — no budget quite covers it, the room is thin, it's unusually large, or it's a category that budget has never carried",
            "Get a yes BEFORE you spend. Not after.",
          ],
          [
            "🔴 **Red**",
            "Spending Public Worship should not be making at all",
            "Don't. No budget and no approval turns a red purchase green.",
          ],
        ],
      },
      {
        kind: "rule",
        title: "Yellow means ask first — that's the entire rule",
        text: "A yellow purchase made without asking doesn't become green because it turned out fine, and asking afterwards isn't asking. The whole value of the yellow track is that the conversation happens while the answer can still be no. Approval after the fact is just a report, and it puts the person you're telling in the position of either rubber-stamping something they'd have questioned or making you eat the cost — which is a bad position to put a teammate in, and the reason this rule exists at all.",
      },
      {
        kind: "heading",
        text: "What exactly is red",
      },
      {
        kind: "p",
        text: "Red isn't \"expensive\" and it isn't \"unbudgeted\" — a $4,000 sound system can be green and a $12 purchase can be red. Red is about the KIND of spending, which is why no approval fixes it. Concretely:",
      },
      {
        kind: "bullets",
        items: [
          "**Anything personal.** Groceries, your own clothes, a gift for your own family — even on a trip you're on for Public Worship, even when you intend to pay it back.",
          "**Anything you'd be uncomfortable a backer seeing the receipt for.** This is the honest test, and it catches things no list can enumerate. Somebody gave $50 a month for the mission; would you want to show them this line?",
          "**Anything that uses Public Worship's name or money for private benefit.** Booking through the org to get a discount for yourself, putting a friend's invoice through as a vendor, spending to do someone a favor.",
          "**Anything you'd rather nobody found out about.** If the plan involves the charge not being noticed, or a description that's technically true but designed not to raise questions, that IS the red flag. There is no version of this that's fine.",
        ],
      },
      {
        kind: "rule",
        title: "A red charge becomes yours",
        text: "This isn't a warning about a hypothetical process. A charge judged red in coding review gets sent back as a **personal charge** — money you owe Public Worship, repaid out of your own pocket, recorded under your name. It happens at the review step, not at some tribunal, and the person doing the review is a teammate who has to look at a line and decide whether the org is comfortable standing behind it. Nobody enjoys that conversation. Not having it is worth thirty seconds of thought at the counter.",
      },
      {
        kind: "heading",
        text: "Who you ask, and what you're actually asking",
      },
      {
        kind: "p",
        text: "Every event and project has **one person who owns its budget** — the person who planned it and got it approved. That's who a purchase against that budget goes through. But notice what green actually asks of you: not a formal approval, just a heads-up. \"I'm about to buy the speakers — can I put that on the Worship With Strangers budget?\" Most of the time the answer is yes and it takes ten seconds.",
      },
      {
        kind: "p",
        text: "That ten seconds is doing real work, though. The owner is the only person who knows what else is still coming out of that budget, and plenty of purchases could legitimately land in two places — general operating or this specific event. Which one it lands on changes whether either has room later. Guessing silently is how a budget that looked fine all month is suddenly over at close, with no single purchase to blame.",
      },
      {
        kind: "scenario",
        prompt:
          "You're running errands for Saturday's event. The approved event budget has $300 left. At the store you grab $80 of supplies that are clearly on the plan — and you notice the extension cords the chapter has needed for months, another $45. Same trip, same card. What do you do?",
        options: [
          {
            text: "Buy both — it's all chapter spending and the budget has room",
            feedback:
              "The $80 is green. The cords aren't — they're not what this event's budget was approved for, they're a chapter-wide purchase riding along because you happened to be standing there. That's textbook yellow: real, sensible, mission spending that belongs to a different pot. Buy the supplies, then text whoever owns general operating about the cords.",
          },
          {
            text: "Buy the $80 of supplies; ask about the cords before buying them",
            correct: true,
            feedback:
              "Right on both halves. The supplies are green — approved budget, room in it, exactly the kind of thing it's for. The cords are yellow, not because $45 is a lot but because they belong to a different budget than the one you're standing in. One message settles it, and it takes less time than the return trip would.",
          },
          {
            text: "Buy neither until someone approves the whole trip",
            feedback:
              "Too cautious, and it doesn't scale — if green spending needed approval, having budgets approved in advance would mean nothing. The supplies are exactly what that budget was approved for. Go ahead.",
          },
          {
            text: "Buy both, then split them correctly in coding afterwards",
            feedback:
              "Coding it correctly afterwards is necessary but it isn't the same thing. Whoever owns general operating still hasn't been told $45 left their budget, and they find out at close — which is exactly the surprise this rule exists to prevent. Coding records a decision; it doesn't make it.",
          },
        ],
      },
      {
        kind: "reveal",
        prompt:
          "You're travelling for Public Worship and buy a $9 airport sandwich on the card. Green, yellow, or red?",
        answer:
          "Green, in almost every chapter — eating on a trip you're on for the mission is ordinary travel spending, and travel budgets exist for exactly this. What would make it red isn't the amount: it's buying a second sandwich for tomorrow, or picking up something for home in the same transaction. The line isn't cost, it's whether the money was spent on the mission or on you.",
      },
      {
        kind: "tip",
        text: "**When you genuinely can't tell, it's yellow.** \"I couldn't decide, so I asked\" is a completely respectable outcome and costs one message. \"I couldn't decide, so I bought it\" is how a charge ends up in review with no good answer available. Uncertainty is itself the signal — a green purchase doesn't feel uncertain.",
      },
    ],
    quiz: [
      {
        prompt: "What are the three things to check before you spend?",
        options: [
          "The price, the vendor, and whether you have the receipt",
          "Which budget it comes out of, whether there's enough left in it, and which track it's on",
          "Whether it's under $100, whether it's urgent, and who else knows",
          "Your card balance, the month, and the chapter's tier",
        ],
        answerIndex: 1,
        explanation:
          "Budget, room, track — in that order. The first two are facts you can look up in the app; the third is the judgment those facts feed.",
      },
      {
        prompt: "A purchase is yellow. When do you get approval?",
        options: [
          "Before you spend",
          "Afterwards, when you code the charge",
          "At the monthly close",
          "Only if someone questions it",
        ],
        answerIndex: 0,
        explanation:
          "Before — that's the whole of the yellow track. Asking afterwards isn't asking; it hands someone a decision that's already been made and forces them to either rubber-stamp it or make you pay for it.",
      },
      {
        prompt: "Which of these makes a purchase RED?",
        options: [
          "It costs more than $500",
          "No budget has been approved for it yet",
          "It's personal, or it's something you'd be uncomfortable a backer seeing the receipt for",
          "It was bought on a weekend",
        ],
        answerIndex: 2,
        explanation:
          "Red is about the kind of spending, not the size or the paperwork. A large purchase with an approved budget is green; an unbudgeted one is yellow and needs a yes. Red is spending the org shouldn't be making at all — which is why no budget and no approval turns it green.",
      },
      {
        prompt: "What actually happens to a charge judged red?",
        options: [
          "It's absorbed into the chapter's general budget",
          "It becomes a personal charge — money you owe Public Worship and repay yourself",
          "Nothing, as long as you attached a receipt",
          "The budget owner is asked to approve it retroactively",
        ],
        answerIndex: 1,
        explanation:
          "It's sent back to you as a personal charge, recorded under your name and repaid out of your own pocket. A receipt doesn't help — proving you made the purchase was never the question.",
      },
      {
        prompt:
          "You're about to buy something clearly covered by an event's approved budget, with plenty of room. What do you owe the budget's owner?",
        options: [
          "A formal approval request before buying",
          "Nothing at all — it's green",
          "A quick heads-up that it's landing on their budget",
          "A written justification at the monthly close",
        ],
        answerIndex: 2,
        explanation:
          "Green doesn't need permission — that's what having an approved budget means. It does need a heads-up: the owner is the only person tracking everything else still to come out of that budget, and a purchase that arrives silently is one they can't plan around.",
      },
    ],
  },

  // ── 32 · Finances for everyone: card + 7-day rule ──────────────────────────
  {
    slug: "finance-card-and-receipts",
    title: "Your card and the 7-day rule",
    subtitle: "Spend, then close the loop before the grace window ends",
    minutes: 4,
    blocks: [
      {
        kind: "p",
        text: "Every charge on your Public Worship card needs a receipt attached in the app — not for bureaucracy, but so your Treasurer can close the books without chasing you down a month later. You have **7 days** from the charge to upload one.",
      },
      {
        kind: "rule",
        title: "No receipt, no coverage — every expense, any amount",
        text: "This is absolute: every Public Worship expense needs a receipt, or a clear photo of one — a $5 card swipe and a $1,000 reimbursement claim follow the exact same rule. There's no purchase too small to bother with and no method that's exempt. If you can't produce a receipt or a clear photo of one, you may be PERSONALLY RESPONSIBLE for the charge: a card purchase can end up flagged as a personal charge you owe back, and a reimbursement claim with no receipt can simply be denied. The receipt isn't paperwork for its own sake — it's what keeps an expense being Public Worship's instead of quietly becoming yours.",
      },
      {
        kind: "table",
        headers: ["Day", "What happens"],
        rows: [
          ["Day of charge", "Charge appears on your own page at /code, receipt missing"],
          ["Day 1–3", "A reminder nudges you if the receipt still isn't attached"],
          ["Day 3+", "The reminder escalates — now a flagged charge, visible to your Treasurer"],
          ["Day 7", "No receipt yet → your card **locks automatically**. Uploading the receipt unlocks it immediately."],
        ],
      },
      {
        kind: "rule",
        title: "The lock is a self-service problem",
        text: "Nobody has to ask permission to fix it: the moment you upload the missing receipt, the auto-lock lifts on its own. The rule exists so the Treasurer's monthly close is never blocked on a receipt nobody remembers.",
      },
      {
        kind: "tip",
        text: "**One exception, and it's about the card, not about you.** The lock works by Public Worship being asked to approve each purchase as you make it — which only happens on cards Public Worship issues. A few people still carry an OLDER card from our previous bank, linked here by its last four digits; nobody asks us before those authorize, so they can't be locked and the app won't pretend otherwise. If that's your card, the day-7 line in the table above simply doesn't fire. **Everything else on this page still does**: the reminders, the Treasurer seeing the flag, and — past 60 days with no account of the spending — the charge becoming money you owe back. The deadline is the same; only the enforcement is quieter. Ask your Treasurer which kind you're carrying if you don't know.",
      },
      {
        kind: "p",
        text: "Some spending genuinely never produces a receipt — a cash tip, a parking meter, a donation box. That has its own answer, and its own lesson: **you file a receipt exception**, and someone else approves it. The next lesson is all of it. What matters here is that it doesn't change the rule above — until an exception is approved, the charge is still missing its receipt and the 7-day clock keeps running.",
      },
      {
        kind: "p",
        text: "And a receipt is only half of what a charge owes. It proves you paid $312.40 to a bus company; it doesn't say why Public Worship should have. That half is a **coding**, and it has its own lesson shortly. What matters here is that the two aren't two errands: the app won't take a coding on a charge that has neither a receipt attached nor a filed reason there isn't one. Same sheet, same sitting.",
      },
      {
        kind: "try_status",
        title: "A charge waiting on a receipt",
        options: [
          { value: "none", label: "No receipt yet", color: "gray" },
          { value: "flagged", label: "Reminder sent", color: "amber" },
          { value: "uploaded", label: "Receipt uploaded", color: "green" },
        ],
        terminal: "uploaded",
        caption:
          "Getting the receipt ONTO THE CHARGE is the only move that matters — uploading it in the app, or confirming the one you emailed in. It clears the reminder and the lock, whichever stage you're at.",
      },
      {
        kind: "tip",
        text: "**Deal with it at the counter.** A card charge usually posts about a day after you swipe, so the moment to handle a paper receipt is while it's still in your hand — not tomorrow, when it's in a coat pocket. Photograph it and email it to **receipts@publicworship.life**, or text the photo back to a reminder; forward the Amazon or Uber confirmation the same way. Send it from the address (or number) the roster has for you so we can tell whose it is, send as many at once as you like — you'll get a single confirmation covering all of them, not one per receipt — and forwarding *as an attachment* works too: we open each attached message and read the receipt inside it. Everything that arrives lands in ONE shared library at Finances → Receipts that all bookkeepers can see, tagged with who sent it and which chapter they're in. It isn't walled off per chapter, because that address is shared and a receipt often turns up before anyone knows which budget it belongs to.",
      },
      {
        kind: "rule",
        title: "Sending it in is not attaching it",
        text: "What emailing or texting a receipt does is **capture** it. What it deliberately does NOT do is decide which charge it belongs to. Instead the app OFFERS it to you — *is this the one?* — when you open the matching charge to code it, and one tap attaches it. Until you take that tap, the charge is still missing its receipt, and the clock in the table above is still running.\n\nWe used to let the system guess the match and attach it unattended. It was usually right, and the times it was wrong were invisible: a receipt quietly stuck to the wrong charge looks finished, which is worse than one that isn't attached at all. Now the confirmation is made by the one person looking at the charge and the receipt at the same moment — you.",
      },
    ],
    quiz: [
      {
        prompt: "How long do you have to attach a receipt before your card locks?",
        options: ["24 hours", "7 days", "30 days", "There's no deadline"],
        answerIndex: 1,
        explanation:
          "A charge whose receipt is still missing after 7 days locks the card automatically — the grace window is a week, not a day and not a month.",
      },
      {
        prompt: "Your card auto-locked for a missing receipt from last week. How do you unlock it?",
        options: [
          "Call the Financial Manager",
          "Upload the receipt — the lock lifts automatically, no review needed",
          "Wait for the next reimbursement cycle",
          "You can't; a new card is issued",
        ],
        answerIndex: 1,
        explanation:
          "The unlock is self-service and instant: uploading the missing receipt clears the auto-lock the moment it lands, at any stage.",
      },
      {
        prompt:
          "You emailed a receipt in on Monday. On Friday the charge still reads as missing its receipt. What's happening?",
        options: [
          "A bug — an emailed receipt attaches itself to the matching charge",
          "It's in the receipts library waiting on you: the app offers it as a match when you open that charge at /code, and one tap attaches it",
          "Emailed receipts take about a week to process",
          "That address only works for reimbursements",
        ],
        answerIndex: 1,
        explanation:
          "Emailing CAPTURES the receipt — the half worth doing at the counter, often before the charge has even posted. It doesn't decide which charge the receipt belongs to; you do, in one tap, at /code (your own page: receipts, coding, and flagging your own charges — no finance seat needed, and the link works even if you have never opened the rest of the app). Until that tap, the receipt is still missing and the 7-day clock is still running.",
      },
      {
        prompt:
          "A $6 supply run and a $940 reimbursement claim both show up with no receipt. Which one actually needs a receipt to keep you from being personally on the hook?",
        options: [
          "Only the $940 one — small charges are exempt",
          "Neither — receipts are only for reimbursements, not card charges",
          "Both — the receipt rule doesn't scale with the dollar amount or the method",
          "Only the card charge — reimbursements are covered automatically once approved",
        ],
        answerIndex: 2,
        explanation:
          "The rule is absolute: a receipt (or a clear photo of one) is required no matter the amount or the method. Skip it on either one and you risk being personally responsible — a card charge can be flagged personal, a reimbursement claim can simply be denied.",
      },
      {
        prompt:
          "You carry one of the older cards from our previous bank, which can't be auto-locked. What does that change about the 7-day rule?",
        options: [
          "Nothing about what you owe — the reminders, the Treasurer's flag, and eventually being billed for unaccounted spending all still apply; only the lock itself can't fire",
          "The receipt deadline no longer applies to you",
          "You get 30 days instead of 7",
          "You have to hand the card back",
        ],
        answerIndex: 0,
        explanation:
          "The lock is one enforcement mechanism, not the rule. It works by Public Worship being asked to approve each purchase as it happens, which only cards Public Worship issues do — so on an older linked card it simply doesn't fire. Every other consequence is unchanged, including the charge becoming money you owe back once the spending has gone long enough without an account of it.",
      },
    ],
  },

  // ── 33 · Finances for everyone: when no receipt exists ─────────────────────
  // Its own lesson rather than a rule bolted onto the card lesson: the concept
  // carries new vocabulary a member has to actually hold (the reason axis,
  // attestation, evidence-vs-receipt, the second approver) and it changes a
  // money rule.
  //
  // Lives in `finances-for-everyone`, not `treasurer`, even though it teaches
  // both filing AND approving. A section may belong to exactly ONE course
  // (`assertCourseCatalogIntegrity`), and the Treasurer's own path already
  // runs through `finances-for-everyone` (see `academyPaths.ts`) — so putting
  // it in the member course reaches every cardholder AND every Treasurer,
  // while the reverse would hide it from the people who file most of them.
  // The approver's half is a tip block at the end for that reason.
  // See `docs/plans/receipt-exceptions.md`.
  {
    slug: "finance-receipt-exceptions",
    title: "When there's genuinely no receipt",
    subtitle: "Document it anyway — with your name on it",
    minutes: 4,
    blocks: [
      {
        kind: "p",
        text: "We publish every transaction we make. That's the point of the whole finance system: a backer can look at what their money did. Which creates a problem the last lesson didn't solve — some real, honest spending never produces a receipt. A cash tip to a sound engineer. A parking meter. A donation box at a venue. Flowers bought from a stall that doesn't print anything.",
      },
      {
        kind: "rule",
        title: "The answer is never a blank",
        text: "The wrong fix is to quietly mark the charge Reconciled and move on. A published ledger can't tell that row from a properly documented one — and neither can we, six months later. So the app refuses it: **you can't reconcile a charge that has neither a receipt nor an approved exception.** It refuses earlier than that, too — you can't even submit the charge's coding without one or the other. Why there's no receipt is part of the record, not a follow-up to it.\n\nThe right fix is to say, on the record, what the money was for and why no receipt exists. That's a **receipt exception**. It isn't an absence — it's a substitute document with a name attached to it.",
      },
      {
        kind: "bullets",
        items: [
          "**File it where you code the charge.** It isn't a separate screen or a separate errand: open the charge at /code, and the same sheet that asks what the money was for holds the no-receipt path. One sitting, one act.",
          "**Pick the reason, don't type one.** No receipt was issued · Receipt lost · Predates the receipt policy · Vendor can't reproduce it · Bank record only. \"Missing\" and \"unattainable\" aren't different states — they're different reasons, and the ledger should say which.",
          "**Write what it was for.** This is the part that actually gets published in place of the document, under your name. \"Cash tip for the sound engineer at the Aug 2 outdoor service — $40, agreed with Kansi beforehand\" is a real record. \"n/a\" is not, and the app won't take it.",
          "**Attach proof if it exists — up to 5 files.** You often can't get the receipt but you can absolutely get *something*: photos of the flowers at the event, a bank statement line, an order confirmation email, a picture of what you bought.",
          "**Someone else approves it.** A Finance manager decides. Above $75, that approver can't be you — that's not distrust, it's the same separation-of-duties rule that governs every approval in the app.",
        ],
      },
      {
        kind: "rule",
        title: "Evidence is not a receipt, and we don't pretend otherwise",
        text: "A photo of flowers at an event proves the flowers existed. It doesn't prove what was paid for them. So evidence attaches to the exception, never to the charge as a receipt — it shows up labelled as proof of purchase, not as the document.\n\nThat honesty is the whole reason anyone should believe our published ledger. A system that quietly upgraded photos into receipts would be easier to use and worth less.",
      },
      {
        kind: "try_status",
        title: "A charge with no receipt",
        options: [
          { value: "none", label: "No receipt, nothing filed", color: "gray" },
          { value: "pending", label: "Exception awaiting approval", color: "amber" },
          { value: "approved", label: "Approved — documented", color: "green" },
        ],
        terminal: "approved",
        caption:
          "Saying a receipt is LOST now costs something, on purpose: you'll be asked, one at a time, whether you checked the vendor's website or order history, whether you contacted the merchant to reproduce it, and whether you searched every inbox INCLUDING SPAM. A no to any of them stops you there \u2014 go do that thing first, because the receipt is usually still findable, and spam and order history are where it usually is. Nobody verifies your answers; they're recorded as YOUR attestation, and the approver reads them. Saying no receipt was ISSUED doesn't face that gauntlet \u2014 a subway turnstile issues nothing and chasing it is pointless \u2014 but it does ask two questions: does this merchant do receipts, and did you ask? If you simply forgot to ask, that's not none-was-issued, that's a lost one, and it'll move you there.\n\nOnly the last state counts as documentation. While it's pending you're still on the clock: the reminders keep coming and the 7-day card lock still applies — asking to be let off isn't being let off. Filing it does unblock one thing, though: you can submit the charge's coding on a pending exception, because filing is your half and deciding is somebody else's.",
      },
      {
        kind: "rule",
        title: "It is not a way out of losing your receipt",
        text: "\"Receipt lost\" is one of the reasons on the list, and filing it is the honest thing to do. But it's a reason someone else weighs, not a self-issued pass — a Finance manager can reject it, and \"lost it\" on a $600 charge reads very differently from a $6 one.\n\nIf a receipt exists, get the receipt. If one turns up after an exception was approved, attach it anyway — the receipt takes over automatically and the exception retires itself.",
      },
      {
        kind: "tip",
        text: "**Treasurers:** your side of this is the decision. Read the note before approving — an exception you wave through becomes the org's public answer for that money. Rejecting is fine and often right; say what would make it approvable, and the charge goes back to owing a receipt. In Reconcile, the honest backlog is two filters, not one: **Needs documentation** (still open, still owing a receipt or an approved exception — somebody to nudge) and **Closed without documentation** (marked Reconciled with neither one behind it — nobody to nudge, and the pile that gets forgotten because it already looks finished). They're disjoint, they're in the same filter group, so picking both shows you the union — and that union is what has to reach zero before a period can be published.",
      },
    ],
    quiz: [
      {
        prompt:
          "You tipped a sound engineer $40 in cash. No receipt exists and never will. What's the right move?",
        options: [
          "Mark the charge Reconciled and move on",
          "File a receipt exception — pick the reason, say what it was for, and let a manager approve it",
          "Nothing; small cash amounts are exempt",
          "Ask the venue to write you a receipt for it later",
        ],
        answerIndex: 1,
        explanation:
          "An exception is the documented substitute for a receipt, not a shrug. Marking it Reconciled with nothing attached is exactly what the app refuses — a published ledger can't tell that row from a documented one.",
      },
      {
        prompt:
          "You bought flowers for an event and never got a receipt, but you have photos of them at the service. What do the photos count as?",
        options: [
          "A receipt — attach them and the charge is documented",
          "Evidence on the exception — proof of the purchase, but not a receipt",
          "Nothing; only paper receipts count",
          "A reimbursement claim",
        ],
        answerIndex: 1,
        explanation:
          "Photos prove the flowers existed; they don't prove what was paid. They attach to the exception as proof of purchase and are labelled that way. Pretending evidence is a receipt would make the published ledger easier to produce and less worth believing.",
      },
      {
        prompt: "You filed an exception this morning. Is the charge documented?",
        options: [
          "Yes — filing is what counts",
          "Not until a Finance manager approves it; until then the reminders and the 7-day lock still apply",
          "Yes, if you attached a photo",
          "Only if it's under $75",
        ],
        answerIndex: 1,
        explanation:
          "Asking to be let off isn't being let off. A pending exception stops nothing — not the reminder timeline, not the card auto-lock. Only an approved one stands in for a receipt. It does let you submit the charge's coding, because filing the attestation is the part that's yours; the charge still isn't closed until someone approves it.",
      },
      {
        prompt:
          "You're a Finance manager and you filed a $200 exception on your own charge. Can you approve it?",
        options: [
          "Yes — you have the permission",
          "No — above $75 the approver has to be someone other than the person who filed it",
          "Yes, if you attach evidence",
          "Only after 7 days",
        ],
        answerIndex: 1,
        explanation:
          "Separation of duties, the same rule that governs reimbursements, budgets, and campaigns. Without it everyone would simply except their own charges and the receipt policy would mean nothing. Under $75 a manager can approve their own — a two-name ceremony on a parking meter buys nothing.",
      },
      {
        prompt: "A receipt turns up weeks after an exception was already approved. Now what?",
        options: [
          "Nothing — the exception already settled it",
          "Attach the receipt; it takes over and the exception retires itself",
          "Withdraw the exception first, then attach the receipt",
          "Ask a manager to reverse the approval",
        ],
        answerIndex: 1,
        explanation:
          "A receipt always outranks an attestation. Attaching it is enough — the app supersedes the exception on its own, so the row stops reading \"documented exception\" the moment it has the real document.",
      },
    ],
  },

  // ── 34 · Finances for everyone: coding your own charges ────────────────────
  // Sits AFTER `finance-receipt-exceptions` on purpose, even though it's the
  // cardholder's other half of `finance-card-and-receipts`: this lesson leans
  // on the exception flow it doesn't re-teach ("no receipt? you already know
  // the honest path") and on the lodging exception-to-the-exception, both of
  // which only make sense once the reader has the exception vocabulary. It
  // also hands off to `finance-reimbursements-and-flags` next, which is where
  // the same fields reappear on a request you submit.
  //
  // Its own lesson rather than more blocks on the card lesson: it introduces
  // a new required record with its own review loop, its own clock, and a
  // publication rule (names never publish) — and both neighbouring quizzes
  // are already at the 5-question cap `apps/convex/tests/academy.test.ts`
  // enforces. The Treasurer's half of this ships as a rule on
  // `finance-reconcile-grid` ("Reconciled means coded, too"); this is the
  // spender's half. See `docs/plans/transaction-coding.md`.
  {
    slug: "finance-coding-your-charges",
    title: "Coding your charges",
    subtitle: "What it was, why it served the work, and who was there",
    minutes: 5,
    blocks: [
      {
        kind: "p",
        text: "A receipt proves you paid $312.40 to a bus company. It doesn't say why Public Worship should have. That gap is fine while the books are ours alone — and useless the moment we publish them, which is exactly what we're about to do with every transaction we make. So from **September 1, 2026**, every card charge carries a second thing alongside its receipt: a **coding**.",
      },
      {
        kind: "rule",
        title: "You write it, someone else approves it",
        text: "A coding answers three questions about a charge: **what it was**, **why it served the org's work**, and **who was involved**. You write it — you're the only person who actually knows — and a different person approves it, the same separation of duties that governs exceptions, reimbursements, and budgets.\n\nIt's a first-class record with its own review, not a note field. If a reviewer sends it back, it comes with a note saying exactly what would make it approvable (\"receipt must show the exact amount\"), and you fix it and resubmit. Nobody guesses on your behalf, and nobody signs off on their own.\n\nOne thing a coding is NOT: a place to confess. If a charge wasn't Public Worship's — you grabbed the wrong card, it was a ride home — don't explain that in the business purpose. That sentence publishes, and the charge still counts as our spending. Use **It was personal — I'll pay it back**, offered right under the purpose field: the charge stops owing a coding, stops counting as ours, and moves to what you owe back.",
      },
      {
        kind: "rule",
        title: "Write the purpose for the public, not for the bookkeeper",
        text: "The business purpose is the sentence a stranger reads on Public Worship's public ledger, under our name, forever. So write it for them.\n\n**\"Bus to NY\"** is what the bank already told us. **\"Travel to NY to film the Eden event\"** is a reason. The test: could someone who wasn't there tell what happened and why it was worth backers' money?",
      },
      {
        kind: "rule",
        title: "Pick your category — the proof questions follow it",
        text: "You already pick a **category** on every charge (Food & Meals, Transportation, Travel & Lodging, and so on) — that's what the budget rollups read. The coding sheet now reads it too: your category quietly picks which of the four proof-question branches below applies, so a **Transportation** charge lands straight on the route questions without a second decision, and a **Food & Meals** charge lands on the headcount question.\n\nThat's a QUESTION SET, not an answer — it decides which fields the sheet shows you, never what goes in them. It's also correctable, always: the branch shows as a small, editable control right there on the sheet, and picking a different one yourself sticks — a later category change won't quietly swap it back. A category with no obvious branch (Supplies, Office & Admin, and most others) simply leaves it unpicked, exactly like coding a charge always has.",
      },
      {
        kind: "table",
        headers: ["If the branch is…", "What it asks for on top of the purpose"],
        rows: [
          [
            "**General**",
            "Nothing extra — the purpose carries the whole record. Most charges are this.",
          ],
          [
            "**Travel**",
            "A route: where from, where to. City level is enough (\"Kansas City → New York\"), plus who travelled. This is also where a **Transportation** category charge lands — fares, gas, parking, tolls are getting-somewhere spending, same branch, same questions. \"Travel\" and \"Transportation\" aren't two different things; they're the coding branch and the category that defaults to it.",
          ],
          [
            "**Overnight stay (lodging)**",
            "One place — **where you stayed** (city level is enough; nobody \"travelled from\" a hotel, so there's no second field to fill) — **plus an itemized receipt, at any amount**. This is the one place a bank-record-only exception is refused outright; the IRS wants the itemized folio for lodging, full stop. A Travel & Lodging charge defaults to the Travel branch, not this one — an overnight stay is one tap away on the sheet whenever the trip actually included a room.",
          ],
          [
            "**A meal**",
            "A headcount, always. 15 people or fewer: every attendee named, with how they relate to the org. More than 15: the headcount plus an identifiable group.",
          ],
        ],
      },
      {
        kind: "rule",
        title: "Meals count people, not dollars",
        text: "The threshold is **15 heads**, and it has nothing to do with the amount. A $40 pizza order for 16 volunteers gets a headcount and a group description. A $400 dinner for 4 gets four names.\n\nNames come with a relationship — **team · volunteer · community member · contractor · guest** — because \"who was there\" without \"who they are to us\" doesn't answer anything. Above 15, the group description has to be *identifiable*: \"volunteers writing and producing the album\" is a real answer. \"Some people\" is not, and it's the answer a reviewer will send straight back.",
      },
      {
        kind: "rule",
        title: "Names never publish",
        text: "We ask for names, and then we don't print them. Ever. The public ledger shows the shape of the room — **\"meal · 5 volunteers, 3 community members, 2 contractors\"** — and the names stay inside the app.\n\nThat isn't a hedge. Volunteers, community members and guests never agreed to appear in a public financial record, and some of them are minors. Publishing our own spending is a decision we made about ourselves; it isn't a decision we get to make about the people who showed up to help us.",
      },
      {
        kind: "rule",
        title: "One act, not two errands",
        text: "A charge's documentation and its coding are one record: **the app won't take a coding on a charge that has neither a receipt attached nor a filed reason there isn't one.** What the money was for and how it can be proved get answered in the same sheet, in the same sitting — no more finishing half of a charge and leaving the other half to a reminder.\n\nIf there genuinely is no receipt, you already know the honest path from the last lesson: pick a reason, explain it, attach up to five photos of proof. FILING it is enough to submit your coding — approving it is somebody else's work, and making you wait on them would strand the charge in your queue for something you can't do. Approval is still what the charge needs before it can be closed, so nothing gets published on the strength of a claim nobody weighed. (The only exception to the exception is lodging, above.)\n\nTwo deadlines still hang off that one act, and it's worth knowing which is which: a missing RECEIPT is what locks your card at day 7, and a charge nobody substantiated is what becomes money you owe back at day 60.",
      },
      {
        kind: "p",
        text: "Which is less work than it sounds, because the receipt is usually already here. A card charge posts about a day after you swipe, so the moment to deal with the paper slip is at the counter — photograph it and email or text it in right then, before a coding sheet for that charge even exists. It waits in your receipts library, and when you open the charge to code it the app offers it: *is this the one?* One tap attaches it. That tap is deliberately yours rather than the system's — you're the only one looking at the charge and the receipt at the same moment, which is exactly the moment to answer the question.",
      },
      {
        kind: "rule",
        title: "No AI ever writes your words — but your own words follow you",
        text: "Your category can pick which QUESTIONS the sheet asks (the rule above) — it never answers them. And no machine ever composes an answer: **an AI's plausible sentence about a charge it didn't witness is worth nothing to a backer, an auditor, or you.** What we publish has to be the testimony of a person who was actually there.\n\nThere is exactly one way a field starts filled in, and it isn't a machine writing: when a charge is a **reimbursement payout**, the coding form starts from what the claimant already wrote on their request — their purpose, and on a single-line request the route, headcount, or place too. That's a real person's real words about this exact expense, moved one screen over so nobody retypes them. The form says so (\"started from the claimant's own words on the request\"), everything stays editable, and nothing submits itself — you still read it, fix it, and own the submission.",
      },
      {
        kind: "table",
        headers: ["Day", "What happens"],
        rows: [
          [
            "Day of charge",
            "The charge lands on your own page at /code, uncoded. Code it here and none of the rest of this table ever happens.",
          ],
          [
            "Day 1–3",
            "**One digest email** — \"you have 3 charges to code\" — not one nag per charge.",
          ],
          [
            "Day 3+",
            "The reminder escalates, and your open charges become visible to your Treasurer.",
          ],
          [
            "Day 7",
            "A charge still missing its **receipt** locks your card automatically — the same 7-day rule you already know, unchanged. Coding doesn't lock the card; it has its own deadline below. In practice coding early clears this row too, since a submitted coding always carries its documentation.",
          ],
          [
            "Day 60",
            "A charge still unsubstantiated **auto-converts to a personal repayment**. You pay it back.",
          ],
        ],
      },
      {
        kind: "rule",
        title: "Why day 60 has teeth",
        text: "This isn't an escalating punishment someone invented to make a point. Public Worship pays expenses under what the IRS calls an **accountable plan**, and one of its conditions is that spending gets substantiated within a reasonable period — 60 days is the safe harbor.\n\nPast it, spending nobody substantiated doesn't stay a loose end: it legally becomes **taxable income to the person who spent it**. Converting it to a repayment you can settle is the kinder of the two endings. Coding it in week one avoids both.",
      },
      {
        kind: "try_status",
        title: "A charge waiting on its coding",
        options: [
          { value: "uncoded", label: "Uncoded", color: "gray" },
          { value: "submitted", label: "Submitted for review", color: "amber" },
          { value: "approved", label: "Approved", color: "green" },
        ],
        terminal: "approved",
        caption:
          "Changes requested is the real fourth state — a reviewer's note lands back in your court, and the charge is open until you fix it and resubmit. Submitted is your part done; the clock is measured against APPROVED.",
      },
      {
        kind: "scenario",
        prompt:
          "Two charges, same week: $38 of pizza for 16 volunteers at an album work session, and a $410 dinner with 4 people — you, a videographer you contract, and two community members considering joining. How do you code the attendees?",
        options: [
          {
            text: "Name everyone on both — you know who was in both rooms",
            feedback:
              "Overkill on the pizza, and not what the record wants: above 15 heads it asks for a headcount and an identifiable group instead.",
          },
          {
            text: "Headcount plus \"volunteers writing and producing the album\" for the pizza; four names with their relationships for the dinner",
            correct: true,
            feedback:
              "Right. The threshold is 15 HEADS, not dollars — the cheap charge gets the headcount, the expensive one gets names. And the dinner's names carry relationships: contractor, community member, community member, team.",
          },
          {
            text: "Headcount for the pizza; headcount for the dinner too, since it's the bigger amount",
            feedback:
              "Backwards — dollars never move this line. Four people is enumerable, so four names and their relationships is what the record asks for.",
          },
          {
            text: "Names for the pizza since it's a small charge; a group description for the $410 dinner",
            feedback:
              "That's the dollar instinct, inverted. It's a headcount rule: 16 people is over the line no matter how little it cost, and 4 people is under it no matter how much.",
          },
        ],
      },
      {
        kind: "tip",
        text: "**Reimbursements work the same way.** You code each LINE as you submit it — same purpose, same route on travel, same attendees on meals — and a reviewer can send it back with a note to fix and resubmit rather than rejecting it outright. One habit, both directions. And the policy starts at charges posted **on or after September 1, 2026**: you are not on the hook for reconstructing last spring from memory. That history is a separate, deliberate cleanup, and it will publish flagged for what it is.",
      },
    ],
    quiz: [
      {
        prompt:
          "You take a bus to New York to film the Eden event. What does the coding need beyond the amount and the receipt?",
        options: [
          "Nothing — the receipt is the record",
          "A purpose written for the public, plus where you travelled from and where to",
          "Just the word \"travel\" and the date",
          "Approval from your Treasurer before you go",
        ],
        answerIndex: 1,
        explanation:
          "\"Bus to NY\" is what the bank already told us. \"Travel to NY to film the Eden event\" is a reason — and travel adds a route (city level is enough), because where the money went is part of what the record has to say.",
      },
      {
        prompt:
          "You're coding a $12 parking charge — cash to an attendant, no receipt, and there never will be one. Can you submit the coding?",
        options: [
          "No — nothing submits without a receipt attached",
          "Yes — file the receipt exception in the same sheet; filing it is your half of the documentation and the coding goes through",
          "Yes — the receipt and the coding are separate obligations, so submit now and sort the receipt out later",
          "Only once a manager has approved the exception",
        ],
        answerIndex: 1,
        explanation:
          "What the money was for and how it can be proved are one record, so a coding won't submit on a charge with neither. The exception lives in the same sheet, and FILING it is enough to submit — approving it is somebody else's work, and waiting on them would strand the charge in your queue. It does still have to be approved before the charge can be closed.",
      },
      {
        prompt:
          "Your meal coding lists 10 people by name. What does the public ledger show?",
        options: [
          "The full list of names",
          "First names only",
          "The headcount and the affiliation breakdown — \"5 volunteers, 3 community members, 2 contractors\"",
          "Nothing about who was there",
        ],
        answerIndex: 2,
        explanation:
          "Names never publish. Volunteers, community members and guests didn't consent to a public financial record and some are minors — so the ledger prints the shape of the room and the names stay inside the app.",
      },
      {
        prompt:
          "A charge from September is still uncoded 60 days later. What happens, and why?",
        options: [
          "Nothing — the Treasurer codes it for you at year end",
          "It auto-converts to a personal repayment you owe back: under IRS accountable-plan rules, spending nobody substantiates becomes taxable income to the person who spent it",
          "The card is cancelled permanently",
          "It's written off and removed from the books",
        ],
        answerIndex: 1,
        explanation:
          "The 60-day safe harbor is the accountable plan's substantiation window. Past it, unsubstantiated spending is legally wages to the spender — converting it to a repayment you can settle is the kinder of the two endings, and coding it in week one avoids both.",
      },
      {
        prompt:
          "You code a Transportation charge and the sheet already shows the travel branch's route questions. You then leave the purpose blank instead of letting AI draft it. What's actually going on?",
        options: [
          "The feature just isn't built yet",
          "Your category picked which QUESTIONS to ask (a route, in this case) — it never answers them; the purpose, route and who-was-there stay blank until you type them",
          "AI drafted the route from the merchant name, but you still have to write the purpose yourself",
          "To keep the app cheap to run",
        ],
        answerIndex: 1,
        explanation:
          "A category can pick the QUESTION SET — it's why Transportation lands on travel's route questions without a second decision — but it never answers a question. The purpose, the route, who was there: all of it stays blank until you type it, and you can always correct the branch yourself if the category guessed wrong. A plausible sentence about a charge nobody witnessed is worth nothing to a backer or an auditor — the first-hand account is the whole reason the ledger is worth publishing.",
      },
    ],
  },

  // ── 35 · Finances for everyone: reimbursements + flags ─────────────────────
  {
    slug: "finance-reimbursements-and-flags",
    title: "Reimbursement, and flagging a charge",
    subtitle: "Two directions: what you're owed, what you owe",
    minutes: 5,
    blocks: [
      {
        kind: "p",
        text: "Two situations, two flows. You paid out of pocket for something mission-related? Submit a reimbursement request. A personal charge landed on your Public Worship card by mistake? Flag it — that starts you owing the money back, not the other way around.",
      },
      {
        kind: "bullets",
        items: [
          "**Reimbursement — Public Worship owes you:** submit the request in-app with a short note on WHY it was needed, plus a transaction date, a receipt, and a full coding on every line — none of that is optional, the app blocks submission until all of it is there. Your full bank details (routing + account, not just a last-4) are captured up front too, so the moment someone approves it, the ACH payout fires automatically from the chapter's Increase account — no one has to separately go send it (unless that account isn't set up yet for the chapter, in which case the Treasurer pays it manually instead). It then moves through submitted → approved → paying → paid, with a detour back to you if a reviewer sends it back for a fix. Someone else — never you — has to approve it.",
          "**A reimbursed purchase spends the budget, same as a card swipe:** once it's paid, it counts against whatever budget and category it's coded to — a $300 team meal you fronted eats $300 of Food & Meals either way. So code it as carefully as you'd code a card charge: the \"what's this for?\" and the per-line category are what decide which bucket it lands in, not paperwork.",
          "**Personal-charge flag — you owe Public Worship:** flag your own charge as personal at /code, or a manager flags it for you from the Book (its \"Personal (unpaid)\" filter is the Treasurer's worklist for exactly this). It opens an owed balance, tracked the same way, just pointed the other direction — and it's a FLAG, not a status: the same charge can be Reconciled AND an unpaid personal expense at the same time.",
          "**Pay it back by card or by bank:** once flagged, pay it back instantly by card (real-time, via Stripe Checkout) or by linking your bank account (ACH). Either way the flag only actually clears to \"repaid\" once the payment is CONFIRMED — closing the tab on a card payment without finishing it leaves the charge exactly as owed as before.",
          "**Flagged something by mistake?** Un-flag it — but only before it's been repaid. Once it's marked repaid, that's a settled transaction; fixing an error at that point is a manual correction, not a toggle.",
          "**Both directions live in one place:** the Reimbursements tab shows \"Public Worship owes you\" and \"you owe Public Worship\" side by side, so nothing nets out silently.",
          "**Don't recognize a charge at all?** That's different from a personal charge you remember making — flagging it \"personal\" says YOU made it. If a charge on the Public Worship card is a genuine mystery, freeze the card yourself right away (instant, self-serve, reversible), then tell your Treasurer or the Financial Manager immediately so they can look into it. Don't guess by flagging an unrecognized charge as personal.",
        ],
      },
      {
        kind: "rule",
        title: "Every line answers for itself",
        text: "One request routinely mixes a $38 fare, a hotel night and a team dinner — three kinds of spending that owe three different answers. So the substantiation is per LINE, not per request: a category, the expense type, a real business purpose, the route on travel, the people at a meal.\n\nSame questions, same rules as the coding you write on your own card charges — the 15-head names threshold, and the category-picks-the-branch rule too (see *Coding your charges*) — and now on BOTH surfaces: logged in or not, each line opens with a category picker, and it defaults the expense-type branch the same way, correctable with one more tap. What differs is what the pick MEANS: your card-charge coding's category is the real one — the app already knows which category the charge is under. A reimbursement line's category is a SUGGESTION — you're telling us where you think it belongs before anyone's reviewed it, and the finance manager who approves the request can recode it if you guessed wrong. Nothing about that is a privacy loophole: category names are already public on the ledger, so seeing the list before you submit doesn't tell you anything the ledger wouldn't already. Either way, you answer everything line by line, at submission, before anyone has seen the request, and the same checker runs in the in-app form, the accountless emailed link, and the server, so no door into this is easier than another.\n\nReceipts stay hard here too: one per line, and **no exception path**. A card charge already happened, and some real spending genuinely never produces a receipt. A reimbursement is a claim you're choosing to make — so \"no receipt\" is a reason not to claim it, not a form to file.",
      },
      {
        kind: "rule",
        title: "Sent back is not rejected",
        text: "A reviewer who spots a thin purpose, or a receipt that doesn't show the exact amount, used to have two moves: approve it anyway, or reject it. Rejected is terminal and reads as \"you lost your money\" — so questions quietly turned into approvals.\n\nNow there's a third: **send it back with a note**, and the note is required (\"receipt must show exact amount\"). You get an email, fix the substantiation, resubmit — and it returns to review carrying its ORIGINAL submission date, so being asked a question never costs you your place in the queue.\n\nTwo limits, both deliberate. A revision may change the **substantiation only** — never the amounts, never the lines; a wrong amount is a reject and a fresh request, because a resubmission must never quietly move a number a reviewer already looked at. And while it sits with you it isn't payable, though you can still cancel it and the reviewer can still reject it outright.",
      },
      {
        kind: "rule",
        title: "Approver ≠ you, always",
        text: "Separation of duties means the person who submits a reimbursement is never the person who approves it — even a Treasurer can't approve their own request. It's the same rule for everyone, including the Executive Director. In practice, your chapter's Treasurer approves most requests; if the Treasurer is the one requesting, it's the central Financial Manager who approves instead — their reach covers every chapter, which is exactly the failsafe for \"the approver and the requester would otherwise be the same person.\"",
      },
      {
        kind: "tip",
        text: "**Something time-sensitive?** There's no in-app \"urgent\" flag or fast lane — a request sits in the same queue whether it's due in an hour or next month. Submitting already emails every approver who could act on it (your chapter's Treasurer(s) and the central Financial Manager(s)), so nobody is checking the queue on faith. If it's genuinely urgent, treat that email as your baseline, not your whole plan: reach the person who'd actually approve it directly — a call or a text — and ask them to look now. That's what turns \"they'll see it eventually\" into \"they saw it today.\"",
      },
      {
        kind: "try_status",
        title: "A reimbursement request",
        options: [
          { value: "submitted", label: "Submitted", color: "gray" },
          { value: "approved", label: "Approved", color: "amber" },
          { value: "paid", label: "Paid", color: "green" },
        ],
        terminal: "paid",
        caption:
          "Changes requested is the state that isn't on this line: it hands the request back to YOU with a note, keeps its original submission date, and rejoins at Submitted the moment you resubmit. Rejected and canceled are endings — those land in your History, not stuck in the middle.",
      },
      {
        kind: "scenario",
        prompt:
          "You're at the store buying event supplies. The Public Worship card is declined — or you realize you left it at home. What's the move?",
        options: [
          {
            text: "Buy it on your own card and quietly let it go — it's not worth the paperwork",
            feedback:
              "That's the exact pattern this system exists to avoid: a small personal cover that never gets tracked. Submit a reimbursement request instead.",
          },
          {
            text: "Pay with your own card, then submit a reimbursement request for it",
            correct: true,
            feedback:
              "Right. Paying out of pocket happens — the fix is tracking it, not hiding it. Submit the reimbursement with your receipt, the transaction date, and why it was needed, and it moves through the normal approve → paid flow.",
          },
          {
            text: "Skip the purchase entirely and try again another day",
            feedback:
              "Sometimes that's fine, but if the team genuinely needs the supplies now, pay and request reimbursement — don't stall the event over a card hiccup.",
          },
          {
            text: "Ask a teammate to \"just cover it\" as a personal favor and move on",
            feedback:
              "Same problem, just handed to someone else — an untracked personal favor instead of a tracked reimbursement.",
          },
        ],
      },
      {
        kind: "scenario",
        prompt:
          "A teammate says, \"Don't worry about the reimbursement, I'll just cover the team dinner myself.\" What's actually the better move?",
        options: [
          {
            text: "Let them — it's generous, and it saves everyone the reimbursement paperwork",
            feedback:
              "Generous, yes — but it takes the expense off the books entirely. A dozen of these a year and nobody can say what the team actually spent.",
          },
          {
            text: "Have them donate the cost to Public Worship, then let Public Worship pay for the dinner on the Public Worship card",
            correct: true,
            feedback:
              "Same generosity, routed correctly: a real, trackable gift instead of an invisible personal favor — and it may be deductible depending on applicable tax rules and the nature of the contribution.",
          },
          {
            text: "Tell them personal generosity toward the team isn't allowed",
            feedback:
              "The generosity is welcome — it just needs to go through a donation, not a silent personal cover.",
          },
          {
            text: "Have them submit a reimbursement made out to a charity instead",
            feedback:
              "That's not how it works — the clean path is a straightforward donation to Public Worship, which then pays the actual expense.",
          },
        ],
      },
    ],
    quiz: [
      {
        prompt: "You paid for event supplies with your own card. What do you do?",
        options: [
          "Submit a reimbursement request — every line with its own receipt, date, and coding (purpose, plus route or attendees where they apply)",
          "Nothing — it evens out eventually",
          "Ask your Treasurer to send you cash directly",
          "Put it on your Public Worship card retroactively",
        ],
        answerIndex: 0,
        explanation:
          "A reimbursement request is the front door for out-of-pocket mission spending — and every line carries its own receipt, date, and substantiation, because one request routinely mixes a fare, a hotel night and a meal. The app blocks submission until each line is complete. That's how \"Public Worship owes you\" gets tracked to paid.",
      },
      {
        prompt: "A personal charge accidentally hit your Public Worship card. What's true?",
        options: [
          "It's fine, the card is shared",
          "Nothing happens automatically",
          "Only a manager can notice this, never you",
          "Flag it — that opens an amount YOU owe Public Worship, tracked until repaid",
        ],
        answerIndex: 3,
        explanation:
          "Flagging is available on your OWN transactions, not just to managers — catching your own mistake early is the fastest way to clear it. The flag is separate from the charge's status too: it can be fully Reconciled AND an unpaid personal expense at the same time — flagging doesn't touch its category, budget, or receipt.",
      },
      {
        prompt: "Your chapter's Treasurer submits a reimbursement request for their own out-of-pocket purchase. Who can approve it?",
        options: [
          "The Treasurer — they hold the seat that normally approves these",
          "The Chapter Director — chapter finance items are theirs to sign off on",
          "The central Financial Manager — SoD blocks the Treasurer from approving their own request, and the FM's central-scope grant reaches every chapter",
          "The Executive Director, automatically, since they outrank the Treasurer",
        ],
        answerIndex: 2,
        explanation:
          "Approver ≠ requester is identity-based — even a Treasurer can't approve their own request. A Chapter Director's finance access doesn't reach reimbursement approval, so the Financial Manager — whose grant covers every chapter — is the real failsafe.",
      },
      {
        prompt: "You spot a charge on the Public Worship card you genuinely don't recognize. What's the right move?",
        options: [
          "Flag it as a personal charge so it's tracked as an owed balance",
          "Freeze the card yourself right away, then tell your Treasurer or the Financial Manager immediately",
          "Wait to see if it happens again before doing anything",
          "Ignore it — the 7-day receipt rule will catch it automatically",
        ],
        answerIndex: 1,
        explanation:
          "Flagging \"personal\" says you made the charge — wrong move for a genuine mystery. Freezing your own card is instant and self-serve, and looping in your Treasurer or the Financial Manager gets it actually investigated.",
      },
      {
        prompt:
          "A reviewer sends your request back with the note \"the hotel line needs where you travelled from and to.\" What's true?",
        options: [
          "It's rejected — you'll have to start a brand-new request",
          "It's in Changes requested: fix the substantiation on that line and resubmit, and it returns to review with your original submission date",
          "It's approved as long as you reply to the email explaining the trip",
          "You can fix the route and correct the line's amount while you're in there",
        ],
        answerIndex: 1,
        explanation:
          "Sent back is not rejected — rejected is terminal, this is a revision loop, and resubmitting keeps your original submission date so a question never costs you your place in the queue. But a revision may change the SUBSTANTIATION only: a wrong amount is a reject and a fresh request, never a quiet edit under a reviewer who already saw the number. While it sits with you it isn't payable, though you can still cancel it.",
      },
    ],
  },

  // ── 34 · Treasurer: the Book ───────────────────────────────────────────────
  {
    slug: "finance-reconcile-grid",
    title: "Running Reconcile",
    subtitle: "Your home screen: code every charge, explicitly",
    minutes: 4,
    blocks: [
      {
        kind: "p",
        text: "The Book (the Reconcile tab's name since the finance tabs were flattened) is the Treasurer's spreadsheet-style home: every chapter charge as a row, Category and Budget editable inline, receipts uploaded inline, and a \"What it was for\" column carrying the spender's own sentence so you can read a month without opening a single row. Nothing here is guessed — a charge only counts against a budget when YOU explicitly link it. There is no automatic matching that quietly assigns spend to the nearest budget.",
      },
      {
        kind: "p",
        text: "Two things about how the page opens. It opens on EVERYTHING, newest first — it used to pre-select \"Needs budget\" and hand you 14 rows out of 346, which looked like a tidy book and was really a filter you didn't know was on. And the search box covers the whole book, not just whatever the filter left standing: type a merchant or a cardholder's name and the State filter steps aside for the duration (the page says so, out loud, when it does). \"Where's that Costco charge\" is a question about your book, not about the pile you happen to be standing in.",
      },
      {
        kind: "table",
        headers: ["Filter", "What it catches"],
        rows: [
          ["Spend", "Every dollar that counts as actual spend — the exact rows behind the dashboard's \"Spent\" figure, so tapping it always lands here"],
          ["Needs budget", "Open, categorized, and still not linked to a budget. A row somebody already closed isn't queue work, so it doesn't count here. Processor and bank fees are deliberately absent — a fee is charged, not chosen, so there is no decision for a budget to control. That covers every processor fee we book: Stripe and Givebutter each book one monthly row, and Cash App's fees are marked per payment from a one-off backfill rather than rolled up. None of them will ever ask you for a budget — or for a coding or a receipt: a fee has no testimony to give and no receipt exists, so the processor's own itemized ledger is its record and the public page prints the fee's standing explanation for it. The exemption is by ORIGIN, not by category — a Givebutter paid tier or any other subscription you chose to buy is a decision, so it stays budgeted (and coded) even though it lands in Bank & Fees alongside them"],
          ["Needs documentation", "Still open, still owing a receipt or an acknowledged reason there isn't one"],
          ["Owes a receipt or coding", "THE CHASE, and it is wider than the row above on purpose: everything anybody still owes you — a receipt, a coding, or an answer to a coding you sent back. A charge whose receipt is attached and whose coding isn't is somebody's homework and is invisible to \"Needs documentation\", so a chase built on that row alone would leave you emailing people about charges your screen never showed. It also keeps the marked internal transfers and processor payouts that owe a statement rather than a person — the Book hides those from the default queue, and picking this brings them back. Group by Person and this is the chase list: one band per cardholder, biggest first, with a Send reminder on each"],
          ["Closed without documentation", "Somebody marked it Reconciled with neither a receipt nor an approved exception behind it. Nobody left to nudge, and a published ledger still can't tell that row from a documented one"],
          ["Needs explaining", "Every row that will publish with a BLANK where its explanation should be — the whole backlog, including the 2024-25 history the coding policy grandfathers out. This is the one that ignores the policy date on purpose: \"Needs coding\" answers what policy demands of whom, this answers what a stranger will see a gap next to when the month publishes. Fees, refunded pairs and personal charges are already excluded — they explain themselves"],
          ["Needs coding", "Spend under the coding policy (posted Sept 1, 2026 or later) still waiting on its author — what it was for, and who was involved. It only appears once the policy starts; before then it could only ever return zero rows, and a filter that's always empty just teaches people to distrust the filters"],
          ["Coding review", "A submitted coding waiting on YOU to approve it or send it back with a note. Same policy-start rule as above"],
          ["To review", "Still sitting at Unreviewed — nobody has touched it yet. This is the number the dashboard's \"To review\" tile shows, and tapping that tile lands you right here"],
          ["Reconciled", "Already cleared and closed — the third chip in the header, and where every other row is trying to get to"],
          ["Personal (unpaid)", "Flagged personal, not yet repaid — the worklist for chasing down what people owe back"],
          ["Transfers", "Money you marked as moving between your own accounts"],
          ["Payouts", "Deposits you marked as a processor settling donations to you"],
        ],
      },
      {
        kind: "rule",
        title: "The header's three numbers — and the pile that was never a backlog",
        text: "The header used to show one number, \"127 to clear\", and it was two very different piles wearing one coat. It's now three chips, and each one is a filter you can tap.\n\n**Needs attention** — open, and something is genuinely outstanding: still unreviewed, or missing a budget, or missing documentation, or personal and unpaid. **Ready to close** — open, and none of those: categorised, budgeted, documented, and simply never closed. The only act left on those rows is pressing Mark reconciled. **Reconciled** — already cleared.\n\nThe first two are complements over the open rows, so they always add back up to what \"to clear\" used to say. That's what makes the split worth having: in a real chapter's book, 127 open rows were 51 that needed a decision and 76 that needed a keystroke. Sixty per cent of the frightening number was already done, and no filter could find it — the only way to those rows was scrolling 346 of them and eyeballing each one.\n\nSo start a session on Ready to close: tap the chip, select all, Mark reconciled. Then the headline that's left is work that's actually work.",
      },
      {
        kind: "rule",
        title: "Some rows you can correct; bank rows you never can",
        text: "A chunk of our early history was rebuilt from spreadsheets and Notion docs rather than watched as it happened, and some of it came out wrong. Those rows — hand-entered ones — carry a pencil in the Actions column: a Finance manager can fix the amount, date, merchant or description, with a required note saying why. Every field you change is logged, before and after, under your name.\n\nRows that came from Relay, Increase or Stripe have no pencil, and no role adds one. Those are the bank's own record of money that moved: if we edit them, our books stop matching the statement, and matching the statement is the reason anyone should believe the rest. Same for a reimbursement or transfer leg — it's paired to another record, so editing one side quietly breaks the pair. If one of those is wrong, add a note, exclude it with a reason, or rename it (below); don't reach for a correction that isn't there.",
      },
      {
        kind: "rule",
        title: "Renaming a merchant is not correcting a row",
        text: "Bank feeds hand us machine strings: \"IC* COSTCO BY IN CAR\", \"AMAZON MKTPL*56OXD2TB2\", \"Purchase from AMAZON.COM*569A3 | Address: SEATTLE, WA, US | **8728\". Type over the Merchant cell in Reconcile and call it what it actually was — \"Costco\", \"Amazon — sound cables\". A bookkeeper can do this on ANY row, bank rows included, which is why it's a different thing from the corrections above.\n\nIt's safe on a bank row because it changes nothing about the bank's record. The name you type is stored beside the original, never over it: the statement's own string is still on the row, still searchable (typing either name finds the charge), and one tap away behind the clock icon that appears on every renamed row. That icon opens the name history — what the bank called it, every name since, and who changed it when. Clear the rename and the bank's name simply shows through again; nothing had to be restored, because nothing was ever overwritten.\n\nSo rename freely for readability, and understand what you have NOT done: renaming doesn't correct an amount, a date, or a claim about what happened. If the row itself is wrong, that's the pencil — or a note and an exclusion.",
      },
      {
        kind: "rule",
        title: "\"What it was for\" is the sentence that publishes",
        text: "The column reads the charge's coding — what it bought and which of our work it served — straight on the row. A blank one says \"Not written\" when that charge owes an account of itself, so an unexplained month is visible at a glance instead of one row at a time. Tap the cell to open the full record: the receipt, who was there, the route, and Approve / Send back if it's yours to decide.\n\nWhat it shows is the PUBLISHED wording, not always the author's. When an approver has redacted a sentence — stripping a name out of \"Dinner with Michael Reid and the volunteers\" — the grid shows the redaction, with a small pencil beside it. The author's original is never overwritten and is still on the coding for an auditor; it simply doesn't render on the surface most likely to end up in a screenshot. So don't read this column as a quote of what somebody typed. Read it as what the public page will say.\n\nAnd it's read-only on purpose. An approved coding can't be edited — testimony a second person signed off on doesn't get quietly reworded — so the cell opens the record rather than pretending to be a text box that would work on some rows and refuse on others.",
      },
      {
        kind: "rule",
        title: "Personal is a flag, not a status",
        text: "Marking a charge personal doesn't change its Category/Budget/Receipt coding at all — a fully Reconciled charge can also be an unpaid personal expense at the same time. Mark or un-mark it right from a row's actions (confirm first — marking emails the person who owes it); un-marking only works before it's been repaid.",
      },
      {
        kind: "rule",
        title: "A charge with no cardholder can still be personal",
        text: "Most rows already know who spent the money — it's their card. A bank/ACH entry, an imported statement row nobody's card is linked to, or a hand-entered charge doesn't, so the flag asks you WHO OWES IT first and records that person as the payer. Only a manager can name someone: saying a teammate owes the chapter money isn't a coding decision, it's a bill.",
      },
      {
        kind: "rule",
        title: "Collecting it back — and what settling actually does",
        text: "The Reconcile pill is the worklist; the collecting happens on Cards → \"Personal to repay\" (the same total shows on Reimbursements), which opens the list of who owes what. The person pays from their own card or bank on their Cards tab, and a MANAGER confirms the money arrived with \"Mark repaid\" — deliberately not self-serve, so nobody can flag their own charge and then zero it out. Settling deletes nothing: the original charge keeps its receipt and coding, an offsetting credit posts against it, and the pair nets to zero in category and budget spend. The row reads \"Repaid\" from then on.",
      },
      {
        kind: "rule",
        title: "Unattributed is loud on purpose",
        text: "A charge with no explicit budget link doesn't get absorbed into whichever budget looks closest — it shows up as Unattributed on the dashboard, in plain sight, with a one-tap path back into this exact filtered view. Loud and wrong beats quiet and wrong.",
      },
      {
        kind: "rule",
        title: "Reconciled means coded, too",
        text: 'From September 1, 2026, spend needs one more thing before it can close: a CODING — the IRS-grade record of what the charge was for, written by a human, approved by a different human. "Travel to NY to film Eden event", never "bus to NY". Travel asks where from and where to; a meal asks who was there — every name and their relationship to the org up to 15 people, a headcount and an identifiable group ("volunteers writing and producing the album") above that. Names never publish: the public ledger shows "5 volunteers, 3 community members, 2 contractors", not who they were.\n\nYou\'ll find the panel on any charge\'s detail view, your OWN charges at /code, and the review queue under the Book\'s view menu (\"Waiting on me\"). Four seats may approve one: the Treasurer and the Chapter Director for THEIR OWN chapter, and the Financial Manager and Executive Director for any chapter and for central. Never your own, either way — approving and sending back are both decisions, and neither is one you get to make about your own testimony. (One stated exception: while the org runs a one-person finance team, the superuser may submit-and-approve in a single act — every such approval is permanently recorded as single-party, so it stays re-reviewable the day there are two people.) Approve a coding only when it would satisfy a stranger reading the public ledger; otherwise send it back with a note that says exactly what would make it approvable ("receipt must show exact amount"). Nothing is AI-suggested, ever — the record is a human\'s own testimony, which is exactly what makes it worth publishing. (On a reimbursement payout the form starts from what the claimant already wrote on their request — their words, carried over and labeled, still edited and owned by whoever codes it.) Charges from before the policy date don\'t owe one; that history is a separate, deliberate cleanup.\n\nOne thing you can count on when a coding reaches you: it arrives documented. Nothing submits without a receipt attached or a receipt exception filed, so "coded but undocumented" is no longer a state you have to chase. Read them together — the purpose against the document — and remember that a PENDING exception was enough to submit but is not enough to reconcile; that one still needs somebody\'s decision.',
      },
      {
        kind: "try_status",
        title: "One charge, coded",
        options: [
          { value: "unreviewed", label: "Unreviewed", color: "gray" },
          { value: "categorized", label: "Categorized", color: "amber" },
          { value: "reconciled", label: "Reconciled", color: "green" },
        ],
        terminal: "reconciled",
        caption:
          "Excluded is the fourth real status — for a row that should never count at all (a duplicate, a bank error). Marking one excluded REQUIRES a reason: the app won't let the row go through blank. Don't reach for it on a transfer or a payout — those have their own markings now, which keep the row honest instead of hiding it.",
      },
    ],
    quiz: [
      {
        prompt: "How does a charge get counted against a budget?",
        options: [
          "The system matches it automatically by category",
          "You explicitly link it to that budget in Reconcile — nothing is derived or guessed",
          "Any charge in the same month as the budget counts",
          "The Chapter Director assigns it",
        ],
        answerIndex: 1,
        explanation:
          "Explicit-only attribution is the whole point: budgets only ever count transactions someone deliberately linked, never inferred matches.",
      },
      {
        prompt: "What does \"Unattributed\" mean on the dashboard?",
        options: [
          "A bug",
          "Spend with no explicit budget link — shown loudly on purpose instead of being silently absorbed somewhere",
          "Money that left the account without a transaction record",
          "Funds waiting on a bank sync",
        ],
        answerIndex: 1,
        explanation:
          "Unattributed is a first-class, visible bucket with a one-tap path into the exact filtered Reconcile view — it's designed to be noticed, not hidden.",
      },
      {
        prompt: "The dashboard says \"To review 80\". You tap it. Where do you land, and what should you see?",
        options: [
          "The Needs budget filter — 80 charges missing a budget link",
          "The To review filter, showing exactly those 80 charges still sitting at Unreviewed",
          "The All filter, where you scroll to find them",
          "The Reconciled filter — they've already been cleared",
        ],
        answerIndex: 1,
        explanation:
          "Every number on the dashboard opens the exact rows behind it. \"To review\" counts charges still at the Unreviewed status, so it lands on the To review filter — same word, same rows, same count. If a figure you tap ever doesn't appear on the screen it opens, that's a bug worth reporting.",
      },
      {
        prompt:
          "Reconcile's header reads: Needs attention 51 · Ready to close 76 · Reconciled 219. What are those 76, and what do you do about them?",
        options: [
          "Rows still missing something — open each one and fix it",
          "Open rows with nothing outstanding — categorised, budgeted, documented, just never closed. Tap the chip, select them all, Mark reconciled",
          "Rows already cleared — nothing left to do with them",
          "Rows the app will close by itself once the month ends",
        ],
        answerIndex: 1,
        explanation:
          "Ready to close is the complement of Needs attention over the open rows, so the two always add back up to the single \"to clear\" number they replaced — and in a real book, 76 of those 127 were a keystroke, not a backlog. Multi-select is what turns them into a minute's work: the bulk bar also sets Category and Budget, and it's where \"Mark as transfer\" lives, since that one needs two rows selected — both legs of the movement.",
      },
      {
        prompt: "You mark a charge \"Excluded\" but leave the reason field blank. What happens?",
        options: [
          "It saves — the reason is just a nice-to-have",
          "The app blocks the save until you type a reason",
          "It saves, but flags the row for the Chapter Director to review",
          "It silently defaults to \"Duplicate\"",
        ],
        answerIndex: 1,
        explanation:
          "Excluding drops a charge out of every budget/category/actuals total — a blank reason is refused so the trail always explains why, not just that it happened.",
      },
    ],
  },

  // ── 35 · Treasurer: transfers & payouts ────────────────────────────────────
  // Its own section rather than more blocks on `finance-reconcile-grid`: this
  // is a money RULE with a trap in it (a payout is not a transfer), and the
  // founder hit the underlying bug in real bookkeeping. Reconcile's own
  // section keeps the how-to surface (the two new filter rows); this one
  // teaches why the two markings are different and must stay different.
  {
    slug: "finance-transfers-and-payouts",
    title: "Transfers and payouts",
    subtitle: "Money moving vs. money arriving — and why they're not the same",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Not every row in Reconcile is a purchase. Two kinds routinely aren't, and both used to quietly distort the books: money you moved between your own accounts, and money a donation processor paid out to you. Your bank reports both as ordinary transactions, and nothing can tell them apart from the amount alone — so you mark them, by hand, one at a time.",
      },
      {
        kind: "rule",
        title: "A transfer isn't spend — mark BOTH legs",
        text: "When you move money between your own accounts, the bank reports it twice: once leaving, once arriving. Left alone, the leaving side looks exactly like a purchase and sits in Needs budget forever. Select BOTH rows in Reconcile and \"Mark as transfer\" — the app REQUIRES the pair, because marking one side alone strands the other as income nobody can explain. Both then drop out of spend, so the same dollars are never counted twice.",
      },
      {
        kind: "rule",
        title: "A payout is NOT a transfer — it's your revenue arriving",
        text: "When Givebutter or Stripe pays out, that deposit is donation and ticket money you've ALREADY earned — the gifts live in the donor records, and that's where the org counts its revenue (the Accounts page's book value = everything earned — donations, ticket sales, in-person sales and course registrations — minus spend). So \"Mark as payout\" tells the books this bank credit is the arrival of already-counted revenue: it keeps the deposit honest and stops the same dollars being counted twice. Never mark a payout as a transfer — a transfer is money between two of OUR accounts, and this money came from outside.",
      },
      {
        kind: "rule",
        title: "Marked still means documented",
        text: "Marking a row is not a way to make it go away. A marked transfer and a marked payout both still appear under Needs documentation until you attach something — a bank statement for the transfer, a settlement report for the payout. Every marking is logged with who did it and what changed, so a reclassification is always traceable, and any marking can be undone.",
      },
      {
        kind: "rule",
        title: "Don't reach for Excluded",
        text: "Excluded is for a row that should never count at all — a duplicate, a bank error. Using it on a transfer hides the row instead of explaining it, only ever fixes one of the two legs, and drops it out of the receipt chase. Using it on a payout hides the settlement record your books need — and for a deposit nobody marked yet, it erases real income. Both now have a marking that keeps the row honest and visible.",
      },
      {
        kind: "tip",
        text: "STRIPE payouts mark themselves. Every morning the reconciliation engine detects new Stripe payouts, labels the bank deposit as a payout for you, and books each chapter's share as an automatic transfer — that's what routes the CASH to the right account (and, when the Financial Manager has Real cash movement on, actually moves it). You'll see each one on the Accounts page, badged \"Payout allocation\", where the Financial Manager can audit and flag them. Givebutter and other deposits still need the hand-marking this lesson teaches — and when you mark one, the modal also asks WHOSE money it is: pick the book it belongs to (some Givebutter payouts are central's, some are a chapter's) and the app books that transfer for you. Changing your mind later is an offsetting transfer, so pick deliberately.",
      },
      {
        kind: "scenario",
        prompt: "Two rows land the same week: a $2,400 deposit described \"GIVEBUTTER PAYOUT\", and a $5,000 withdrawal described \"PUBLIC WORSHIP | Transfer\" with a matching $5,000 deposit into your savings account. How do you code them?",
        options: [
          {
            text: "Mark all three as transfers — none of them are purchases",
            feedback:
              "The $5,000 pair, yes. But the Givebutter deposit is your revenue arriving from outside — a transfer is money between two of OUR accounts. Marking it a transfer would misstate where $2,400 of donation money came from and break its settlement record.",
          },
          {
            text: "Mark the $5,000 pair as a transfer; mark the $2,400 deposit as a payout",
            correct: true,
            feedback:
              "Right. The pair is money moving — both legs leave spend so the same dollars aren't counted twice. The payout is your already-earned revenue arriving — the label tells the books it's settled donation money, counted once at the donor records.",
          },
          {
            text: "Exclude all three so nothing double-counts",
            feedback:
              "Excluding hides rather than explains, and it drops all three out of the receipt chase. The payout deposit needs its marking — that's what tells the books it's settled, already-counted donation revenue.",
          },
          {
            text: "Mark only the $5,000 withdrawal — the deposit side is obvious",
            feedback:
              "The app won't let you: a transfer needs both legs. Marking only the withdrawal would strand the $5,000 deposit as income with no source.",
          },
        ],
      },
    ],
    quiz: [
      {
        prompt: "A $1,000 row reading \"PUBLIC WORSHIP | Transfer\" is sitting in Needs budget. What do you do?",
        options: [
          "Mark it Excluded with a reason",
          "Link it to whichever budget is closest",
          "Select it AND the matching $1,000 deposit, then Mark as transfer",
          "Leave it — transfers sort themselves out at year end",
        ],
        answerIndex: 2,
        explanation:
          "The bank reports a transfer twice, and nothing can tell a transfer from a purchase by the amount alone. Marking the PAIR takes both legs out of spend so the same dollars aren't counted twice. Excluding it would hide the row instead of explaining it — and would only ever fix one of the two sides.",
      },
      {
        prompt: "A Givebutter payout lands in your bank account. How should it be marked?",
        options: [
          "As a transfer — the donations were already recorded elsewhere",
          "As a payout — the label that says it's already-counted revenue arriving",
          "As Excluded, to avoid double-counting the gifts",
          "It doesn't need marking at all",
        ],
        answerIndex: 1,
        explanation:
          "The org counts its revenue where it was earned — donations, ticket sales, in-person sales and course registrations — and the payout deposit is that money physically arriving. \"Mark as payout\" tells the books exactly that, so the deposit stays honest and nothing is counted twice. Marking it a transfer would claim it moved between our own accounts; excluding it would hide the settlement record.",
      },
      {
        prompt: "Why does the app refuse to mark a transfer from just one row?",
        options: [
          "To slow you down so you double-check the amount",
          "Because the other leg would be left as unexplained money in your books",
          "It's a technical limitation of the bank feed",
          "It doesn't — one row is enough",
        ],
        answerIndex: 1,
        explanation:
          "A transfer is a pair by definition. Marking only the side that left would leave the arriving side sitting there as income with no source — swapping one wrong number for another.",
      },
      {
        prompt: "You mark a transfer. What happens to its receipt obligation?",
        options: [
          "It disappears — marked rows aren't chased",
          "It stays: both legs still show under Needs documentation until you attach a statement",
          "Only the outgoing leg still needs one",
          "It becomes optional after 30 days",
        ],
        answerIndex: 1,
        explanation:
          "Marking changes how a row COUNTS, never whether it must be explained. Both legs keep owing documentation until something is attached — that's the difference between marking and hiding.",
      },
    ],
  },

  // ── 36 · Treasurer: chasing receipts ───────────────────────────────────────
  {
    slug: "finance-chasing-receipts",
    title: "Chasing receipts",
    subtitle: "The reminder timeline, and why the lock is your friend",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Cardholders get automatic reminders — you don't have to personally nag every teammate about every charge. Your job is to watch the queue, not manufacture it: escalating cases surface on their own, and the Cards tab shows exactly which cards are approaching the day-7 auto-lock.",
      },
      {
        kind: "bullets",
        items: [
          "**Day 1–3:** a soft reminder goes to the cardholder.",
          "**Day 3+:** the reminder escalates — visible to you as a flagged charge.",
          "**Day 7:** the card locks automatically if the receipt still isn't there. Uploading a receipt at ANY point clears the whole chain, including an already-locked card.",
        ],
      },
      {
        kind: "rule",
        title: "You chase the exceptions, not everyone",
        text: "Most receipts show up before the reminders even matter. Chase Receipts is your actual worklist — a handful of stragglers each month, not the whole roster.\n\nIt is a VIEW OF THE BOOK, not a separate screen: pick it from the Book's own title dropdown (or the bell in the header) and the grid re-filters in place — same page, same header, same dropdown, now filtered to \"Owes a receipt or coding\" and grouped by Person, biggest first. Each band is one cardholder: their name, what they owe, and their Send reminder button. Nothing to navigate back from, and you can widen or narrow it like any other view.",
      },
      {
        kind: "p",
        text: "One thing that will look like a bug the first time you meet it: a receipt that arrives by email or text does NOT attach itself to a charge anymore. It lands in the Receipts library and waits to be offered to the cardholder as a match when they open that charge to code it — so a cardholder can have a dozen receipts in the library and a dozen charges still sitting in Needs documentation, with nothing broken. You can link one by hand from Receipts when it's obvious, and sometimes you should; but the tap you're really chasing is theirs, because they're the person who knows which charge it was. That's the whole reason we stopped letting the system guess: a receipt quietly attached to the wrong charge looks finished, which is worse than one that isn't attached at all.",
      },
      {
        kind: "p",
        text: "For that handful, you don't have to text them yourself anymore. Each cardholder's band carries a **Send reminder** button (and there's a **Remind all** in the header for the whole list) — one click re-sends the same reminder email the automated timeline sends, plus a text if they have a phone on file. It's capped at once per cardholder per day, so mashing the button can't spam anyone; a nudge already sent today just reads \"Nudged today\" instead of firing again.\n\nTwo things to expect. Only a finance MANAGER sees the buttons at all — a bookkeeper has full run of the Book and not this. And a reminder goes to one book's cardholders at a time, so if you're looking at all books merged, pick Central or a chapter first; the page says so where the buttons would be, rather than quietly reminding a narrower list than you're looking at.",
      },
      {
        kind: "p",
        text: "Two filters, and they don't overlap — a row is in one or the other, never both. **Needs documentation** is still open and still owing a receipt or an approved exception. **Closed without documentation** is the tail behind it: rows somebody marked Reconciled with neither one behind them. The chase stopped there; the gap didn't.\n\n(A third, **Owes a receipt or coding**, sits beside them and is the one you actually chase from. It is WIDER than \"Needs documentation\" — it adds the charges owing a coding rather than a document — so it is not disjoint from anything and is not part of the arithmetic below. Use it to work the chase; use these two to count the publishing backlog.)\n\nThey're split because they need different hands. The first pile you nudge. The second nobody is going to send you a receipt for — you go back and document it, or you honestly re-open it, and it's the half that gets forgotten precisely because it already looks finished. **The publishing backlog is both of them together.** They sit in the same filter group, so selecting both widens rather than narrows, and that union is the number that has to reach zero before a period goes public — a public ledger can't tell a quietly-closed row from a documented one. (Approving the exceptions themselves is its own lesson.)",
      },
      {
        kind: "reveal",
        prompt:
          "A cardholder's card auto-locked three days ago for a missing receipt. They just uploaded it. What do you, the Treasurer, need to do?",
        answer:
          "Nothing — the unlock is automatic the moment the receipt lands. Your job was already done: the reminder timeline and the auto-lock did the chasing for you.",
      },
    ],
    quiz: [
      {
        prompt: "What triggers a card's automatic lock?",
        options: [
          "The Treasurer manually locking it",
          "A charge whose receipt is still missing after 7 days",
          "Reaching a monthly spending cap",
          "Any charge over $500",
        ],
        answerIndex: 1,
        explanation:
          "The day-7 auto-lock is purely about a missing receipt, not spend amount or anyone's manual action.",
      },
      {
        prompt:
          "A cardholder emailed in nine receipts this month, and nine of their charges still sit in Needs documentation. Is something broken?",
        options: [
          "Yes — emailed receipts are supposed to attach themselves to the matching charge",
          "No — an emailed receipt lands in the library and attaches when a human confirms it against the charge, which the cardholder does while coding it",
          "Yes — the OCR pipeline has stalled and needs a retry",
          "No — emailed receipts always take a full month to post",
        ],
        answerIndex: 1,
        explanation:
          "Capturing a receipt and attaching it are two different steps. Emailing gets the document into the library — the half worth doing at the counter, often before the charge has posted; attaching it is a human confirming the match. You can link one by hand from Receipts, but the cardholder's tap is the cheaper path and it's exactly what your nudge is asking for.",
      },
      {
        prompt: "What's the Treasurer's actual daily worklist for receipts?",
        options: [
          "Personally message every cardholder every day",
          "Chase Receipts — the handful of stragglers each month, not the whole roster",
          "A shared spreadsheet outside the app",
          "There isn't one; it's fully automatic",
        ],
        answerIndex: 1,
        explanation:
          "The reminder timeline handles the routine cases; Chase Receipts is where you spend your actual attention.",
      },
      {
        prompt:
          "Reconcile shows Needs documentation: 7 and Closed without documentation: 3. How many rows stand between you and publishing the period, and how do you see them?",
        options: [
          "3 — the 7 are still open, so they aren't a publishing problem yet",
          "7 — the 3 were reconciled, so somebody already settled them",
          "10 — the two filters are disjoint, so the publishing backlog is both; pick both and they widen, because they're in the same group",
          "7 — the 3 are inside the 7, so the bigger number is the real one",
        ],
        answerIndex: 2,
        explanation:
          "Neither pile can be published. The 7 are open and owe a receipt or an approved exception — you nudge those. The 3 were closed with nothing behind them — nobody is going to send you a receipt for those; you document them or honestly re-open them. No row is in both piles, so the backlog is the sum, and multi-select within the State group is how you look at it in one view. (The last option is the old shape: the two used to overlap almost entirely — 42 rows in common, 3 that weren't — which is exactly why they were split into halves that mean different jobs.)",
      },
      {
        prompt:
          "A straggler hasn't uploaded a receipt and you don't want to wait for the next automated reminder. What do you do?",
        options: [
          "Text them yourself, outside the app",
          "Click Send reminder on their group in Chase Receipts",
          "Manually lock their card early",
          "Nothing can be done before the next scheduled reminder",
        ],
        answerIndex: 1,
        explanation:
          "Send reminder (and Remind all for the whole list) fires the same reminder email — plus a text if they have a phone on file — right from Chase Receipts, capped at once per cardholder per day.",
      },
    ],
  },

  // ── 36 · Treasurer: the monthly close ──────────────────────────────────────
  {
    slug: "finance-monthly-close",
    title: "The monthly close",
    subtitle: "Everything true in under 30 minutes",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "The whole Treasurer job compresses into one target: close the month in under 30 minutes. That's only possible because the work was done continuously — Reconcile kept current, receipts chased as they came due — not saved up for month-end.",
      },
      {
        kind: "rule",
        title: "Close is a check, not a marathon",
        text: "If close is taking hours, the real problem happened three weeks earlier: charges piled up uncategorized, receipts went unchased, budgets went unlinked. A clean close is proof the month was run well, not a task in itself.",
      },
      {
        kind: "bullets",
        items: [
          "**Reconcile at Ready:** every charge has a receipt, a category, and a budget link — the Ready filter's count climbs toward all of them.",
          "**Reimbursement queue triaged:** nothing sitting unreviewed that's actually yours to act on — the submission email is a nudge, not a substitute for actually clearing the queue.",
          "**Personal (unpaid) filter checked:** a personal flag doesn't block Ready (it's a separate flag, not a status), so it's easy to close a month while real debts sit uncollected — check the Personal (unpaid) pill directly and nudge anyone who still owes. When someone's paid you back, confirm it on Cards → \"Personal to repay\" with \"Mark repaid\", or the debt stays open on the books no matter what landed in the account.",
          "**Report up:** the central Financial Manager should be able to open your chapter's numbers and trust them without a conversation — that trust IS the north-star metric this whole system is built around.",
        ],
      },
      {
        kind: "try_ready",
        criteria: [
          "Every charge has a receipt or an explicit personal-charge flag",
          "Every charge is categorized and linked to a budget",
          "The reimbursement queue has nothing waiting on you",
          "Unattributed spend is at zero or explained",
          "The Personal (unpaid) filter is empty, or every row on it is being actively chased",
        ],
      },
    ],
    quiz: [
      {
        prompt: "What's the Treasurer's monthly-close target?",
        options: [
          "Under 30 minutes",
          "A full business day",
          "One week",
          "There's no target, just \"eventually\"",
        ],
        answerIndex: 0,
        explanation:
          "Under 30 minutes is the north-star target — and it's only reachable if the month was reconciled continuously, not all at once.",
      },
      {
        prompt: "Why would a close take hours instead of minutes?",
        options: [
          "The app is slow",
          "The real work — reconciling, chasing receipts — didn't happen continuously during the month",
          "There are too many backers",
          "Central hasn't approved the budget yet",
        ],
        answerIndex: 1,
        explanation:
          "A long close is a symptom, not the disease — it means Reconcile and receipt-chasing were deferred instead of done as the month went.",
      },
      {
        prompt: "Who should be able to trust your chapter's numbers without asking you anything?",
        options: [
          "Only you",
          "The central Financial Manager",
          "Every backer individually",
          "Nobody needs to — the numbers are internal",
        ],
        answerIndex: 1,
        explanation:
          "The FM trusting every chapter's numbers without asking is the system's stated north-star metric, right alongside the 30-minute close.",
      },
      {
        prompt:
          "A cardholder pays back a personal charge and you confirm it with \"Mark repaid\". What happens to the original charge?",
        options: [
          "It's deleted from the ledger — the debt is settled, so the row goes away",
          "It stays on the ledger with its receipt and coding, and an offsetting credit posts against it so the two net to zero",
          "It moves to the Excluded filter",
          "Nothing changes until next month's bank import",
        ],
        answerIndex: 1,
        explanation:
          "Nothing is ever deleted. Settling posts one offsetting credit against the charge — the pair nets to zero in category and budget spend, the row reads \"Repaid\", and the money's whole story stays on the books. Until you confirm it, the debt stays open no matter what landed in the account.",
      },
    ],
  },

  // ── 36b · Publishing the books ─────────────────────────────────────────────
  // Added 2026-08-11 with the public finances page. It sits immediately after
  // the monthly close because it IS the step after it: close the month, then
  // decide whether it is ready to be read by strangers. Taught in the
  // Treasurer course (they prepare it) and the ED course (they publish it),
  // which is the same two-party split the feature enforces.
  {
    slug: "finance-publishing-the-books",
    title: "Publishing the books",
    subtitle: "What we say in public, and how we correct it",
    minutes: 5,
    blocks: [
      {
        kind: "p",
        text: "Once a month is closed, it goes on publicworship.life — not a summary, every transaction. What we bought, who we bought it from, what it was for, and whether we can produce the receipt. A giver reading \"$3.9M staff cost\" feels like a drop in a bucket. A giver reading \"$47.83, Costco, water and cups for the setup team at a Worship With Strangers night\" can see their own $5 in it.",
      },
      {
        kind: "p",
        text: "You watch it happen from the Book. Group by Month — or pick **Publish a month** from the Book's title dropdown, which is that same grouping — and every band tells you where that month stands: Draft, In review, Published (with the revision that's live), or Amending. **Preview** on the band opens the actual public page for that month, exactly as a stranger would see it, without publishing anything.\n\nThe **Publish** button on the band hands you to the publish console, and that hand-off is deliberate rather than a missing feature. Publishing is not a way of looking at a month; it is an irreversible act with a second person in it. The console is where the disclosures are read, where a re-publish states its amendment reason, and where the system refuses a month whose snapshot came back incomplete. None of that is paperwork in front of the button — it IS the button.",
      },
      {
        kind: "rule",
        title: "Published means frozen",
        text: "The public page does **not** read the live books. When a month is published, it is FROZEN — a copy is stored and that copy is what the world sees, forever. Editing a transaction next week changes our books and changes nothing public. That is the whole design: a live page would let an edit silently rewrite what we already said, and nobody outside could tell.",
      },
      {
        kind: "bullets",
        items: [
          "**One person prepares, a different person publishes.** Preparing needs a finance manager seat; publishing needs the separate *Publish finances* power on the seat chart. The system refuses a self-approval and records which way every month went.",
          "**Everything publishes — but not everything counts.** Internal transfers and the bank deposits carrying gifts you already counted are shown, marked \"not counted.\" Hiding them would leave gaps; counting them would count the same dollar twice.",
          "**An intentionally excluded row does not publish.** Excluding a duplicate or a bank error is us saying it was never a transaction. Publishing it as one would be the opposite of clarifying.",
          "**No names, ever.** Not givers, not the people at a meal. A meal publishes as \"12 people — 5 team members, 7 community members.\" That answers who it was for without publishing a person, and some of the people we feed are minors.",
        ],
      },
      {
        kind: "rule",
        title: "We publish our gaps, not around them",
        text: "A month with three receiptless rows publishes with a note saying there are three receiptless rows. Rows rebuilt from old spreadsheets are marked **Rebuilt** rather than presented as though we watched them happen. Waiting for a perfect month would mean publishing nothing for a year; presenting an incomplete month as complete is the one thing the system refuses outright, because it is the only failure a reader cannot detect for themselves.",
      },
      {
        kind: "tip",
        text: "**Corrections are the feature, not the embarrassment.** A published month can never be taken down — only amended. You start a correction, say what changed and why, and it publishes as revision 2 with the earlier version still readable beside it. An organization that shows its corrections is more believable than one that has never appeared to make any.",
      },
      {
        kind: "p",
        text: "The page also rolls a whole YEAR up — pick a year and \"All months\" — and that rollup is nothing but the published months added together. It is never published on its own, it never fills in a month nobody closed, and it says on its face how many of the twelve it is built from. So the fastest way to make the year look complete is to close the months.",
      },
      {
        kind: "rule",
        title: "Budgets publish too",
        text: "Every budget money came out of appears with what it was allowed and what it actually used — including the ones that went over, which are the rows people read first. Two consequences worth planning around: spend with no budget attached publishes as **\"Not attached to a budget\"** rather than being hidden, and a budget's name is public the moment its first charge is. Name budgets like a stranger will read them, because one will.",
      },
      {
        kind: "reveal",
        prompt:
          "You publish August. In September you notice a Costco charge was entered as $47.83 when the receipt says $52.10. What do you do?",
        answer: "Fix the transaction in Reconcile, then start a correction on August: pick \"Amount corrected\" and write the sentence that explains it. Send it for review; the publisher approves it and August republishes as revision 2. The public page shows the corrected figure, a dated correction notice, and your explanation. What you must NOT do is assume fixing the ledger fixed the page — it doesn't, by design.",
      },
      {
        kind: "try_ready",
        criteria: [
          "The month is closed — Reconcile at Ready, receipts chased, queue clear",
          "You have read the preview's disclosure lines and can defend each one out loud",
          "The \"everyone here is a volunteer\" line is still true — if anyone is now paid, it changes before you publish",
          "Someone other than you is available to review and publish it",
          "Any correction you are making has a sentence a stranger could understand",
        ],
      },
    ],
    quiz: [
      {
        prompt:
          "You publish August, then next week you edit one of August's transactions in Reconcile. What does the public page show?",
        options: [
          "The edited version — the page reads the live books",
          "The version that was published. The month is frozen; the edit changes nothing public until a correction is published",
          "Nothing — the month is pulled until it's re-approved",
          "Both versions, side by side, automatically",
        ],
        answerIndex: 1,
        explanation:
          "Publishing freezes a copy, and that copy is what the world sees. It's the property that stops an after-the-fact edit from silently rewriting what we already said — which is exactly why fixing the ledger is only half of making a correction.",
      },
      {
        prompt: "A month has four charges with no receipt and no approved exception. What happens?",
        options: [
          "Publishing is blocked until all four are documented",
          "Those four rows are left out of the published ledger",
          "It publishes, with the four rows marked undocumented and a note saying how many there are",
          "It publishes and the rows look identical to receipted ones",
        ],
        answerIndex: 2,
        explanation:
          "We publish gaps rather than around them. Blocking would mean publishing nothing for a year; hiding the rows or letting them look documented would be a claim we can't back. The only thing refused outright is an incomplete ledger presented as complete.",
      },
      {
        prompt: "Who can publish a month you prepared?",
        options: [
          "You, as long as you hold a finance manager seat",
          "Anyone on the chapter roster",
          "Someone else holding the Publish finances power — the system refuses a self-approval and records which way each month went",
          "Only the Executive Director, never anyone else",
        ],
        answerIndex: 2,
        explanation:
          "Publishing is a separate seat power from reconciling, because its audience is outside the org and a published number can't be un-seen. The ED and Financial Manager carry it centrally; a Chapter Director carries it for their own chapter's book — notably not the Treasurer, who prepares it.",
      },
      {
        prompt:
          "The 2026 year view shows $1.4M raised. Four months of 2026 haven't been closed. What is the page showing?",
        options: [
          "An estimate for the whole year, projected from the eight closed months",
          "Only the eight published months, added together — and it says so on the page",
          "The whole year, because the year is published separately from the months",
          "Nothing — a year needs all twelve months before it appears",
        ],
        answerIndex: 1,
        explanation:
          "A year is never published on its own; it is the months added up. It never estimates or fills in a month nobody closed, and it states how many of the twelve it covers — so the way to make the year complete is to close the months.",
      },
      {
        prompt:
          "A team dinner for 12 is published. What does the public page say about who was there?",
        options: [
          "The twelve names",
          "Nothing about the people at all",
          "The headcount and the mix — \"12 people — 5 team members, 7 community members\"",
          "Only the person whose card was charged",
        ],
        answerIndex: 2,
        explanation:
          "Names are internal forever — members and guests never consented to a public financial record, and some are minors. The headcount and affiliation mix answer the accountability question without publishing a person.",
      },
    ],
  },

  // ── 37 · Chapter Director: raise vs. manage ────────────────────────────────
  {
    slug: "finance-raise-vs-manage",
    title: "Raise vs. manage",
    subtitle: "Three people, three jobs, on purpose",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "The playbook splits money into three separate jobs, held by three different humans: the Chapter Director **raises** it (backers), the Treasurer **records** it (Reconcile, receipts, budgets), and the central Financial Manager **oversees** it (audit, cross-chapter trust). As Chapter Director, your finance job is raising and approving — not bookkeeping.",
      },
      {
        kind: "table",
        headers: ["Job", "Who", "What it is NOT"],
        rows: [
          ["Raise", "Chapter Director", "Recording transactions — that's the Treasurer's job"],
          ["Record", "Treasurer", "Fundraising — a Treasurer never fundraises"],
          ["Oversee", "Central Financial Manager", "Day-to-day approval — the FM audits, doesn't run your chapter"],
        ],
      },
      {
        kind: "rule",
        title: "Separation of duties is identity-based, not a courtesy",
        text: "The system enforces approver ≠ requester by the actual person, not by job title — even if you personally hold two seats, you can't approve something you yourself submitted. It's the same protection everywhere in the app, not a special rule just for you.",
      },
      {
        kind: "reveal",
        prompt:
          "As Chapter Director, can you also do the Treasurer's Reconcile work if they're on vacation?",
        answer:
          "You could technically cover the gap, but the playbook's raise/record/oversee split exists precisely so no one person controls all three jobs long-term. Cover a gap; don't make dual-hatting your chapter's normal state — it's a transition condition, not a design.",
      },
    ],
    quiz: [
      {
        prompt: "In the raise/record/oversee split, what does the Chapter Director do?",
        options: [
          "Records every transaction",
          "Raises money (backers) and approves chapter budgets",
          "Audits every other chapter",
          "Issues cards",
        ],
        answerIndex: 1,
        explanation:
          "Raising and approving are the Director's two jobs — recording is the Treasurer's, and cross-chapter audit is the FM's.",
      },
      {
        prompt: "Why does a Treasurer never fundraise?",
        options: [
          "It's against the law",
          "The three jobs are deliberately separated so no one role controls raising, recording, AND approving money",
          "Treasurers dislike fundraising",
          "There's no reason, it's just convention",
        ],
        answerIndex: 1,
        explanation:
          "The three-party separation is the mandated structure the playbook uses to keep any single person from controlling the whole money loop.",
      },
      {
        prompt: "How does the system enforce \"approver ≠ requester\"?",
        options: [
          "By job title only",
          "By the actual person's identity — even a dual-hat holder can't approve their own submission",
          "It doesn't enforce it; it's just a guideline",
          "Only for reimbursements, not budgets",
        ],
        answerIndex: 1,
        explanation:
          "SoD is identity-based (personId + auth email), not role-based, and it applies everywhere approvals happen — reimbursements and budgets alike.",
      },
    ],
  },

  // ── 38 · Chapter Director: approving budgets ───────────────────────────────
  {
    slug: "finance-approving-budgets",
    title: "Approving budgets",
    subtitle: "The 85% principle — submit, approve, and why raising the cap isn't automatic",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Within your chapter's 85% (what's left after the skim to central), you approve freely — the playbook's rule is mission/vision confines, not central sign-off. Central's role is auditing your numbers after the fact, not gating your spending before it.",
      },
      {
        kind: "rule",
        title: "The 85% principle",
        text: "Inside your chapter's own operating money, the Chapter Director approves budgets that fit the chapter's mission and vision — full stop. Central never pre-approves a chapter budget; the Financial Manager's oversight is audit, not a gate.",
      },
      {
        kind: "bullets",
        items: [
          "**How it works:** whoever plans a budget taps **Submit for approval** right on its card. It then shows **Awaiting approval** to anyone who can act on it — AND emails them, so the approver doesn't have to be watching the app. Tap **Approve** or **Request changes** (with a reason) straight from that same card, and the submitter gets an email back either way, note included on a Request changes.",
          "**Who approves what:** a chapter budget is approved by you (the Chapter Director); your Treasurer can also approve one if you were the one who submitted it — separation of duties always picks whoever ISN'T the requester, even a dual-hat holder acting on their own submission.",
          "**Central budgets are the mirror image:** approved by the Executive Director, or the Financial Manager if the ED submitted it.",
          "**Codings are approved by the same four seats, with different reach.** You and your Treasurer approve codings for YOUR OWN chapter; the Financial Manager and the Executive Director approve any chapter's, and central's. The work sits on the **Coding** tab. Same separation of duties, and it binds both ways — you can't approve a coding you wrote, and you can't send your own back either.",
          "**Over the approved cap:** spending past what a budget allows raises a loud warning right on the card — it doesn't block the card yet.",
        ],
      },
      {
        kind: "tip",
        text: "**Increasing an approved budget kicks it back to Draft — but nobody's told.** Bump the amount on a budget that's already Approved, and it drops straight back to Draft the moment you save the higher number — NOT Awaiting approval, and NOT auto-submitted. The OLD approved amount keeps working as the spending cap the whole time, so nothing silently expands — but the increase itself sits invisible to every approver until YOU deliberately tap Submit for approval again. Skip that tap and the raise is never reviewed, and no approver is ever notified. Decreasing a budget, or reshuffling its line items, never triggers any of this.",
      },
      {
        kind: "reveal",
        prompt:
          "Your Treasurer submits a budget they wrote for their own project. Can they approve it themselves?",
        answer:
          "No — separation of duties applies to budgets exactly like reimbursements: whoever submits can never be the one who approves, even a Treasurer on their own project. It routes to you, the Chapter Director, instead.",
      },
    ],
    quiz: [
      {
        prompt:
          "You're the Treasurer for New York. A coding on a CENTRAL charge, and another on Chicago's charge, are both sitting in review. Which can you approve?",
        options: [
          "Both — a Treasurer is a finance manager, and managers approve codings",
          "Neither — a Treasurer approves codings for their own chapter only",
          "The central one, since central outranks a chapter",
          "Chicago's, since it's a chapter like yours",
        ],
        answerIndex: 1,
        explanation:
          "Reach is per seat. The Treasurer and the Chapter Director approve their OWN chapter's codings; the Financial Manager and the Executive Director approve any chapter's and central's. Neither of those rows is yours — and even inside your own chapter you could never approve a coding you wrote.",
      },
      {
        prompt: "Within a chapter's 85%, who approves how the money gets spent?",
        options: [
          "Central has to sign off on everything first",
          "The Chapter Director, freely, within mission/vision — central doesn't pre-approve chapter budgets",
          "Nobody — it's unrestricted",
          "The Treasurer alone",
        ],
        answerIndex: 1,
        explanation:
          "The 85% principle is explicit: chapters approve freely within their own money; central's control is audit, not a gate.",
      },
      {
        prompt: "What is central's role in a chapter's budget, per the 85% principle?",
        options: [
          "Approving every line item",
          "Auditing after the fact — oversight, not a gate",
          "Setting the chapter's spending limit line by line",
          "Central has no visibility at all",
        ],
        answerIndex: 1,
        explanation:
          "The Financial Manager's cross-chapter audit is oversight after the money moves, not pre-approval before it does.",
      },
      {
        prompt: "You bump an APPROVED budget's amount from $2,000 to $3,000. What happens?",
        options: [
          "Nothing — the higher amount is available immediately",
          "It drops back to Draft — NOT auto-submitted; the old $2,000 stays the spending cap, and the increase won't be reviewed until you send it for approval again",
          "The budget is deleted and a new one is created",
          "Only a Financial Manager can ever raise a budget's amount",
        ],
        answerIndex: 1,
        explanation:
          "An increase past the approved cap flips the budget back to Draft, not Awaiting approval — it's fully editable and invisible to approvers until you deliberately submit it again. The old approved amount keeps enforcing the cap the whole time it sits unsent. Decreases and line reshuffles never trigger any of this.",
      },
    ],
  },

  // ── 39 · Tiers, the covenant, and the skim ─────────────────────────────────
  // Moved OUT of the Chapter Director course into the shared
  // `chapter-money-model` course (Treasurer + Chapter Director both build on
  // it) — see `FINANCES_COURSES` below. The section itself, its slug, and its
  // curriculum position are unchanged; only its course membership moved.
  {
    slug: "finance-tiers-and-skim",
    title: "Tiers, the covenant, and the skim",
    subtitle: "What backer count buys you, and what goes back to central",
    minutes: 5,
    blocks: [
      {
        kind: "p",
        text: "A chapter's backer count — headcount, never dollars — sets its tier, and every tier unlocks more of the mission. This is the covenant: chapters commit to raising; central commits to what the tiers promise.",
      },
      {
        kind: "table",
        headers: ["Backers", "Tier unlocks"],
        rows: [
          ["20", "Worship With Strangers (WWS) — the baseline program"],
          ["30", "+ Eden"],
          ["50", "+ LTN"],
        ],
      },
      {
        kind: "p",
        text: "The other half of the covenant is what a chapter COSTS to run. That number isn't a guess or a target — it's the ordinary monthly cost of doing the work, added up line by line. Chapters commit to raising against it, so it's worth knowing where every dollar of it comes from.",
      },
      {
        kind: "table",
        headers: ["Every month, whatever the team size", "Cost"],
        rows: [
          ["Worship With Strangers — filming", "$200"],
          ["Worship With Strangers — event food", "$160"],
          ["Getting equipment to and from events", "$100"],
          ["Storing that equipment", "$60"],
          ["Software the chapter runs on", "$50"],
          ["**Fixed base**", "**$570**"],
        ],
      },
      {
        kind: "p",
        text: "Those five lines are the same whether the team is three people or ten — hence *fixed*. One line does scale: **$20 per teammate per month**, the meal at the monthly team meeting. So the floor is **$570 + $20 × team size**. A 5-person team: $570 + $100 = **$670/month**. Six people: $690. Seven: $710.",
      },
      {
        kind: "rule",
        title: "Adding someone to the team costs money",
        text: "It's a real $20/month, every month, for as long as they're on the team — plus their seat in the conference fund below. That is NOT a reason to keep a chapter small; a bigger team is how a chapter does more, and the model expects it. It's a reason to add people **on purpose**, knowing the chapter's floor just moved and the raising has to move with it. Nobody joins a team for free, and a Chapter Director who adds four people without adjusting the plan has quietly raised the floor $80/month and told no one.",
      },
      {
        kind: "p",
        text: "On top of the floor sits a **conference sinking fund** — a per-teammate amount set aside monthly so that when the whole network gets in one room, the chapter can send its people. Budget roughly a twelfth of the trip per seat per month: about **$275÷12** for a city close enough to drive, **$500÷12** for one that needs a flight.",
      },
      {
        kind: "tip",
        text: "**Why we save for this instead of billing people, and why it isn't on your calendar yet.** No conference is scheduled — this is the one forward-looking line in the model, and it's here on purpose rather than being added the month a date gets announced. Two reasons. The first is that saving twelve months ahead is the only version a chapter can actually afford; asked for in one month it becomes a bill nobody planned for. The second is who'd end up paying it: without a fund, going means each teammate covering their own travel, which quietly turns a gathering into something only the people who can afford it attend. Central doesn't blanket-fund it either — a 50-person team would make that arithmetic impossible, and the seats would get rationed. So each chapter saves for its own, per seat, from now.",
      },
      {
        kind: "rule",
        title: "The skim funds the next city",
        text: "Every month, a flat **15%** of chapter revenue is committed — as a real transfer, not a budget line — from the chapter's account to central's City Launch Fund. That fund is what pays a new city's ~$7,800–8,300 launch cost (equipment + the training trip) when it's ready to start.",
      },
      {
        kind: "tip",
        text: "**How the 15% actually moves today:** by hand, on purpose. With one chapter and a small backer base, automating the transfer would be complexity the network doesn't need yet — so central's bookkeeper records it as a manual transfer (same ledger shape either way: a real `flow:\"transfer\"` pair, excluded from spend), with a note saying which month's commitment it honors. The 15% itself isn't optional or improvised — it's the number this lesson teaches, and the number donors are told on the giving page — only the RECORDING is manual for now.",
      },
      {
        kind: "tip",
        text: "**Where the backer number itself comes from:** it's reported straight from the Giving page, and there is no way to type it in. Every ACTIVE pledge at or above the $50 floor recomputes the count automatically the moment a backer subscribes, misses a payment, is paused, or cancels (see the Development stream's backer-model course for the full lifecycle). The old hand-entry escape hatch was REMOVED — a hand-set number and a derived one quietly disagreed for three weeks on a public page, so the count now has exactly one author: the pledges themselves.",
      },
      {
        kind: "reveal",
        prompt:
          "Your chapter crosses 31 backers this month. What tier are you in, and does the extra backer above 30 change your skim rate?",
        answer:
          "You're at the 30-backer tier (+Eden unlocked) until you reach 50. The skim rate stays a flat 15% regardless of tier — more backers means more revenue, and 15% of more is more, but the percentage itself doesn't change.",
      },
    ],
    quiz: [
      {
        prompt: "What sets a chapter's tier?",
        options: [
          "Total dollars raised in a year",
          "Backer headcount — the 20/30/50 thresholds",
          "How many events the chapter runs",
          "How long the chapter has existed",
        ],
        answerIndex: 1,
        explanation:
          "Tiers are keyed on backer count, exactly like every other constant in the model — headcount, never dollars.",
      },
      {
        prompt: "What percentage of chapter revenue moves to central each month?",
        options: [
          "A flat 15%, as a real transfer to the City Launch Fund",
          "0% — chapters keep everything",
          "50%",
          "It varies by chapter size",
        ],
        answerIndex: 0,
        explanation:
          "The skim is flat 15% for every chapter, modeled as an actual transfer, not just a number on a report.",
      },
      {
        prompt: "Where does a chapter's backer count actually come from today?",
        options: [
          "The Treasurer types it in by hand every month",
          "It's recomputed automatically from active $50+ pledges on the Giving page — there is no hand-entry path at all",
          "Central emails it to the chapter once a quarter",
          "It's calculated once a year during budgeting season",
        ],
        answerIndex: 1,
        explanation:
          "The count is derived, live, from real pledge activity. Nobody can set it by hand — the old manual-entry seam was removed after a typed-in number contradicted the real one on a public page.",
      },
      {
        prompt: "Your chapter has 6 teammates. What's its monthly operating floor?",
        options: [
          "$570 — the fixed base is the floor",
          "$690 — the $570 fixed base plus $20 for each of the 6 teammates",
          "$120 — $20 per teammate",
          "It depends on the tier, not the team size",
        ],
        answerIndex: 1,
        explanation:
          "$570 + 6 × $20 = $690. The fixed base (film, event food, equipment transport, storage, software) doesn't move with team size; the $20 does — it's the monthly team meal, one per teammate.",
      },
      {
        prompt:
          "A Chapter Director adds four people to the team this month. What happened to the chapter's costs?",
        options: [
          "Nothing — people are free; only programs cost money",
          "The monthly floor rose $80, plus four more seats in the conference fund — real recurring cost the plan has to account for",
          "Costs fell, because more people share the work",
          "Only the conference fund changes; the monthly floor is fixed",
        ],
        answerIndex: 1,
        explanation:
          "Every teammate carries a real recurring cost. Growing the team is expected and good — the point is to do it deliberately, knowing the floor moved and the raising has to move with it, rather than discovering it at close.",
      },
    ],
  },

  // ── 40 · Financial Manager: cross-chapter audit ────────────────────────────
  {
    slug: "finance-cross-chapter-audit",
    title: "Auditing every chapter",
    subtitle: "The central rollup, drill-down, and the trust you're building",
    minutes: 5,
    blocks: [
      {
        kind: "p",
        text: "As Financial Manager, your dashboard opens to the central view: every chapter as a row in one rollup, each with its month's spend against its budget. Tap a chapter and you're inside its own dashboard — the same view its Treasurer sees — so you can verify, not just skim a summary number.",
      },
      {
        kind: "bullets",
        items: [
          "**By-chapter rollup:** every chapter, plus Central itself as its own row — spend, budget, and status side by side.",
          "**Drill-down:** open any chapter and see exactly what its Treasurer sees, real numbers, not a redacted export.",
          "**By-tag rollup:** an org-wide breakdown tappable into the contributing budgets across chapters.",
        ],
      },
      {
        kind: "rule",
        title: "Trust, not permission",
        text: "You're not a gate a chapter's spending waits behind — you're the person who can look at any chapter's numbers at any time and vouch for them. The north-star metric for this whole system is exactly that: you trust every chapter's numbers without having to ask anyone.",
      },
      {
        kind: "rule",
        title: "Whose card paid ≠ whose budget it counts against",
        text: "Every charge carries **two** facts, and they're different questions. **Paid from** is whose card or account the money actually left — that's what reconciles against a bank statement, and coding a charge never changes it. **Charged to** is whose budget it counts against — that's what a budget's spent-vs-left is measuring. Usually they match. When they don't, one book fronted money for another: a Public Worship card buying something for New York is *paid from Central, charged to New York*. Reconcile flags that row so you see it as you code it, the charge counts against New York's budget (not Central's), and the app works out what's owed — no spreadsheet, no accrual to remember. Settle it whenever you like from the central dashboard's **Inter-chapter balances**; the balance is recomputed live from the ledger, so a miscode you fix simply disappears from it.\n\nDon't reach for **Fix who paid** for this. That button rewrites which account the money left — it's for correcting a charge that landed in the wrong book, not for deciding whose budget carries the cost. Use it on the venue deposit and you'd be claiming New York's account paid, which its bank statement would flatly contradict, and the amount Central is owed would vanish with it.\n\nGive that row New York's **category** too, in the same pass. It's the only chance anyone gets: the charge lives in Central's book, so New York's Treasurer can't edit it — leave the category blank and that spend sits in an \"Uncategorized\" bar on their budget forever. (Fund stays Central's business either way. A fund records whose *restricted* money paid, and Central's card didn't draw on New York's.)",
      },
      {
        kind: "rule",
        title: "Separate books, one queue when you hold both hats",
        text: "Central and every chapter keep SEPARATE books. They're separate operating entities — same legal entity, same 501(c)(3), but their money is never pooled on paper. Reconcile's books selector is where you choose: **All books** (everything at once, each row labelled with the book it belongs to), **Central** (the org's own charges), or a named chapter. Today one person is both the central Financial Manager and New York's Treasurer, so All books is the default at the central desk — one pass instead of two. Editing follows the books, not the view: you can always work Central's rows and your own chapter's; another chapter's rows show up read-only, with a lock instead of a checkbox, because its Treasurer owns them.",
      },
      {
        kind: "reveal",
        prompt:
          "A chapter's dashboard shows a large Unattributed balance this month. What's your move as Financial Manager?",
        answer:
          "Drill into that chapter's Reconcile — the same one-tap path its Treasurer has — and see what's sitting unlinked. It's a conversation starter with the Treasurer, not a punishment: Unattributed being visible at all is the system working; ignoring it would be the failure.",
      },
    ],
    quiz: [
      {
        prompt: "What does the central rollup show?",
        options: [
          "Only central's own budgets",
          "Every chapter as a row — spend vs budget — plus Central's own row",
          "A single combined number with no chapter breakdown",
          "Nothing until a chapter submits a report",
        ],
        answerIndex: 1,
        explanation:
          "The rollup is per-chapter, side by side, with Central appearing as a row exactly like every chapter — nothing is pre-aggregated away.",
      },
      {
        prompt: "When you drill into a chapter from the central view, what do you see?",
        options: [
          "A summary PDF",
          "The exact same dashboard that chapter's own Treasurer sees",
          "Nothing — drill-down is view-only metadata",
          "Only that chapter's card list",
        ],
        answerIndex: 1,
        explanation:
          "Drill-down re-checks your central reach and then shows the chapter's real dashboard — the FM's audit tool IS the chapter's own view.",
      },
      {
        prompt:
          "In Reconcile's All books view you open a charge belonging to a chapter you're not the Treasurer of. What can you do with it?",
        options: [
          "Edit it like any other row — central reach means central can code anything",
          "Read it, but not edit it — the row shows a lock instead of a checkbox",
          "Nothing at all; other chapters' rows are hidden from you",
          "Delete it, but not re-code it",
        ],
        answerIndex: 1,
        explanation:
          "Books stay separate even in the merged view. You can SEE every book — that's the whole audit posture — but coding a chapter's charge belongs to that chapter's Treasurer. Central's own rows and your own chapter's rows stay fully editable.",
      },
      {
        prompt:
          "You pay for New York's venue deposit on a Public Worship card and code it to New York's event budget. What happens?",
        options: [
          "The charge moves into New York's account — its book now shows the money leaving",
          "It stays paid from Central, counts against New York's budget, and New York owes Central the amount",
          "It counts against Central's budget instead, since Central's card paid",
          "Nothing until someone records a transfer first",
        ],
        answerIndex: 1,
        explanation:
          "Paid-from never moves — Central's account really did pay, and its statement has to keep matching. Charged-to is what the budget measures, so the deposit lands on New York's plan. The gap between the two is a receivable the app computes for you, visible in Inter-chapter balances — and settled automatically by the morning reconciliation engine, which books the transfer overnight so every book reads true by morning (the Accounts page shows each one for audit, and when the Financial Manager has turned on Real cash movement, the actual money moves between the Increase accounts to match).",
      },
      {
        prompt: "What's the FM's actual relationship to a chapter's spending?",
        options: [
          "A gate every purchase must pass first",
          "An auditor who can verify any chapter's numbers at any time — oversight, not pre-approval",
          "No relationship — chapters are fully independent",
          "The FM personally approves every transaction",
        ],
        answerIndex: 1,
        explanation:
          "The FM audits and can escalate receipt-chasing, but chapter budgets are approved by the Chapter Director, not pre-cleared by the FM.",
      },
    ],
  },

  // ── 41 · Financial Manager: the receipt escalation queue ───────────────────
  {
    slug: "finance-receipt-escalation-queue",
    title: "The receipt escalation queue",
    subtitle: "Watching for cards nearing the day-7 lock, chapter-wide",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "The same receipt timeline every cardholder lives under — reminder, escalation, day-7 auto-lock — rolls up to you across every chapter. The Cards view's escalation queue is where you see which cards are closest to locking, before it happens.",
      },
      {
        kind: "table",
        headers: ["Stage", "What it means for you"],
        rows: [
          ["Flagged (day 1–3)", "Still routine — the cardholder likely hasn't noticed yet"],
          ["Escalated (day 3+)", "Worth a nudge if it's a repeat pattern for that person"],
          ["Locked (day 7)", "Automatic — no action needed from you; it lifts the moment a receipt is attached to the charge"],
        ],
      },
      {
        kind: "rule",
        title: "You watch patterns, not individual charges",
        text: "One missing receipt is normal life. The same cardholder hitting escalation every month is the thing worth a real conversation — the queue is there so you notice the pattern, not so you personally chase every stray charge.",
      },
      {
        kind: "rule",
        title: "A full receipts library is not a documented month",
        text: "Receipts that arrive by email or text are CAPTURED, not filed. They wait in the Receipts library until a human confirms which charge each one belongs to — which the cardholder does in one tap when the app offers the match while they code the charge. So the two numbers you'd expect to move together don't: receipts in, and charges documented. The second is the one that governs the lock, this queue, and the close.\n\nWe gave up the automatic match deliberately. Guessing was right most of the time, and the times it was wrong were invisible — a receipt quietly stuck to the wrong charge reads as finished, which is worse than one that isn't attached at all. A chapter where receipts pour in and the queue keeps growing isn't a broken pipeline; it's a habit that hasn't landed yet, and that's exactly the kind of pattern this view exists to show you.",
      },
      {
        kind: "try_status",
        title: "A charge moving through the timeline",
        options: [
          { value: "active", label: "Active, no issue", color: "gray" },
          { value: "flagged", label: "Flagged", color: "amber" },
          { value: "escalated", label: "Escalated", color: "amber" },
          { value: "cleared", label: "Receipt uploaded — cleared", color: "green" },
        ],
        terminal: "cleared",
        caption:
          "Notice the card never needs YOU to unlock it — a receipt attached to the charge at any stage clears the whole chain. Landing in the library isn't the same thing: that step is capture, and the attaching is still a tap someone takes.",
      },
    ],
    quiz: [
      {
        prompt: "What does the FM's escalation queue surface?",
        options: [
          "Every single charge in the system",
          "Cards approaching or past the day-7 receipt auto-lock, across all chapters",
          "Only locked cards",
          "Budget approval requests",
        ],
        answerIndex: 1,
        explanation:
          "The queue is scoped to the receipt timeline specifically — the FM's cross-chapter view of the exact same mechanic every member lives under.",
      },
      {
        prompt: "A cardholder hits \"escalated\" once this month. What's the right response?",
        options: [
          "Lock their card personally right away",
          "Nothing unusual — one instance is normal; a repeating pattern for the same person is what's worth a conversation",
          "Report them to the Executive Director",
          "Cancel their card",
        ],
        answerIndex: 1,
        explanation:
          "The queue exists to catch PATTERNS across months, not to turn a single late receipt into an incident.",
      },
      {
        prompt: "Who unlocks a card that hit the day-7 auto-lock?",
        options: [
          "The Financial Manager, manually, each time",
          "Nobody has to — uploading the missing receipt unlocks it automatically",
          "It requires an Increase support ticket",
          "It stays locked for 30 days regardless",
        ],
        answerIndex: 1,
        explanation:
          "The unlock mechanic is identical for every seat — receipt attached, lock lifts, no manual review anywhere in the chain.",
      },
      {
        prompt:
          "A chapter's Receipts library is filling up nicely, but its escalation queue keeps growing. What's the likely explanation?",
        options: [
          "The OCR pipeline is failing silently and needs a retry",
          "Receipts are being captured but never confirmed against their charges — that tap happens when the cardholder codes the charge",
          "The day-7 timer is misconfigured for that chapter",
          "Emailed receipts don't count as documentation at all",
        ],
        answerIndex: 1,
        explanation:
          "Emailed and texted receipts land in the library; nothing attaches them to a charge until a human confirms the match, which the cardholder does while coding it. Capture is the easy half and it's already happening — the pattern worth a conversation is the confirming half nobody's doing.",
      },
    ],
  },

  // ── 42 · Financial Manager: accounts, cards, and the City Launch Fund ──────
  {
    slug: "finance-accounts-and-cards-admin",
    title: "Accounts, cards, and the City Launch Fund",
    subtitle: "The ED/FM-only administration surface",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Every chapter — and central itself — has its own Increase account, provisioned automatically. Central's own account is where the City Launch Fund balance actually lives. The Accounts tab that shows all of this is visible ONLY to Executive Director and Financial Manager seats; chapters never see it, they just have a working card program.",
      },
      {
        kind: "bullets",
        items: [
          "**Accounts tab:** a quiet status/audit view — account health, not a place chapters configure anything.",
          "**Card lifecycle you administer today:** you (or the Treasurer) issue a card directly to a cardholder, and you lock or unlock any card in your scope whenever it needs to go dark or come back — the same `lockCard`/`unlockCard` mechanism the day-7 receipt auto-lock itself runs on.",
          "**A compromised card is a phone call, not a click:** a cardholder who suspects fraud contacts their Treasurer (chapter) or you (central) right away — there's no self-serve freeze yet, so a manager lock is what protects them, the moment they reach out.",
        ],
      },
      {
        kind: "rule",
        title: "Opaque by design",
        text: "The accounts layer became fully automatic and opaque on purpose — no one pastes in an Increase account ID anymore, no chapter picks a bank account from a dropdown. Your visibility into it is a deliberate exception for exactly two seats: ED and FM.",
      },
      {
        kind: "tip",
        text: "**Three new card-lifecycle features are now live (WP-C.1):** A cardholder can self-serve freeze their own card instantly (suspected foul play) — it's instant and reversible by them alone. An FM or Treasurer can permanently cancel/close a card (a member who had one canceled can request a replacement). And any member can request a card (one open request at a time); you approve it (which issues the card) or deny it. The old direct-issuance flow still works as a manager shortcut.",
      },
      {
        kind: "tip",
        text: "**Card prerequisite (org-wide, optional):** central finance can require a member to finish a specific finance Academy course before a card is issued — set it in the Accounts screen's *Receipt & card policy* section. It's OFF by default. When it's set, requesting a card still works; the gate is at ISSUANCE, so a member can request, finish the course, then be approved. In the cards admin an untrained cardholder reads **Needs training**, so you can see at a glance who's ready. (If the configured course doesn't exist, the gate stays off rather than blocking everyone.)",
      },
      {
        kind: "reveal",
        prompt:
          "A member emails asking you to freeze their card because their phone was stolen. What do you tell them?",
        answer:
          "The cardholder freezes it themselves instantly — they don't need to wait for a manager. It's self-serve and reversible by them alone. Tell them to freeze it now in their card settings, then loop in their Treasurer or you for next steps (for example, if they need to request a replacement card). The self-serve freeze is fastest protection; they can act before they even finish emailing you.",
      },
    ],
    quiz: [
      {
        prompt: "Who can see the Accounts tab?",
        options: [
          "Every finance seat",
          "Only Executive Director and Financial Manager seats",
          "Every chapter member",
          "Only the account's original creator",
        ],
        answerIndex: 1,
        explanation:
          "Accounts visibility is tighter than general finance-seat access — ED and FM only, chapters never see it.",
      },
      {
        prompt: "Where does the City Launch Fund's balance actually live?",
        options: [
          "A spreadsheet central maintains manually",
          "Central's own Increase account — central has an account just like every chapter",
          "Split evenly across all chapter accounts",
          "It's a virtual number with no real account",
        ],
        answerIndex: 1,
        explanation:
          "Central is provisioned its own real account (WP-1.2), and that account is the City Launch Fund's actual home.",
      },
      {
        prompt: "A cardholder suspects their card was compromised. What's the shipped response today?",
        options: [
          "They freeze it themselves instantly, self-serve",
          "They contact their Treasurer or Financial Manager immediately, who locks it with the manager lock/unlock mechanism",
          "They wait for the day-7 receipt auto-lock to catch it",
          "They open an Increase support ticket",
        ],
        answerIndex: 0,
        explanation:
          "The cardholder freezes it themselves instantly — it's self-serve and reversible by them alone. That's the fastest real protection. They should also tell their Treasurer or FM, but the freeze action doesn't need to wait for a manager to respond.",
      },
      {
        prompt: "Are self-serve freeze, card cancel/close, and a member request-a-card flow live today?",
        options: [
          "Yes, all three are live",
          "Not yet — they're near-term (WP-C.1) additions; the only shipped control today is a manager's lock/unlock",
          "Only cancel/close is live",
          "Only self-serve freeze is live",
        ],
        answerIndex: 0,
        explanation:
          "All three shipped together in WP-C.1: a cardholder can self-serve freeze/unfreeze their own card instantly (reversible), an FM or Treasurer can permanently cancel/close a card, and any member can submit a card request (with at most one open request at a time) for you to approve or deny.",
      },
      {
        prompt:
          "Central finance has set a required Academy course before a card can be issued. A member who hasn't finished it requests a card. What happens?",
        options: [
          "Their request is blocked — they can't even submit it until they finish",
          "The request goes through; you just can't issue/approve the card until they complete the course, and they show as 'Needs training' until then",
          "The card is issued anyway — the requirement only applies to direct issuance",
          "Their existing card is locked until they finish",
        ],
        answerIndex: 1,
        explanation:
          "The prerequisite gates ISSUANCE, not the request. A member can request now, finish the course, and then be approved — and the cards admin flags an untrained cardholder as 'Needs training' so you can see who's ready. The requirement is off by default and set on the Accounts screen.",
      },
    ],
  },

  // ── 43 · Executive Director: central budgets ───────────────────────────────
  {
    slug: "finance-central-budgets",
    title: "Central budgets",
    subtitle: "Central's own money, planned the same way a chapter's is",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Central isn't a bookkeeping abstraction — it has its own budgets, its own line, and its own row in every rollup, using the exact same budget machinery every chapter uses. A central budget's chapter field is literally the string \"central\", not a null or a special case bolted onto the side.",
      },
      {
        kind: "bullets",
        items: [
          "**New budget, central scope:** created the same way a chapter budget is, just scoped to central instead of a chapter.",
          "**Central's rollup row:** sits alongside every chapter in the by-chapter view, with the identical drill-down behavior.",
          "**What lives here:** central operating costs, the City Launch Fund balance, and the launch grants that seed new cities.",
        ],
      },
      {
        kind: "rule",
        title: "One system, one set of rules",
        text: "Central spending follows the same invariants as chapter spending: actuals come only from explicitly-linked transactions, an over-cap budget gets a loud warning, and approval follows the mirror-image of a chapter's SoD — you approve central budgets, and the Financial Manager approves if you were the one who submitted it.",
      },
      {
        kind: "reveal",
        prompt:
          "Why does central use the exact same budget tables and rules as a chapter, instead of its own separate system?",
        answer:
          "Because \"central\" is just another scope in the same model (a sentinel string, not a parallel structure) — every rule, report, and rollup that works for a chapter works for central automatically, with nothing built twice.",
      },
    ],
    quiz: [
      {
        prompt: "How is a central budget represented in the system?",
        options: [
          "A completely separate table from chapter budgets",
          "The same budget structure, scoped with the sentinel value \"central\" instead of a chapter",
          "A null chapterId",
          "A spreadsheet outside the app",
        ],
        answerIndex: 1,
        explanation:
          "Central is a string sentinel, never null — the deliberate pattern this codebase uses everywhere central needs to be its own scope.",
      },
      {
        prompt: "Where does central appear in the by-chapter rollup?",
        options: [
          "It doesn't — central is invisible there",
          "As its own row, with the same drill-down every chapter gets",
          "Only as a footnote at the bottom",
          "Central has a separate dashboard with no rollup at all",
        ],
        answerIndex: 1,
        explanation:
          "Central gets a real row in the rollup, not special-cased out of it — the whole point of treating it as a scope, not an exception.",
      },
      {
        prompt: "Who approves a central budget you didn't personally submit?",
        options: [
          "You, the Executive Director",
          "Only the Treasurer",
          "No one — central budgets don't need approval",
          "Every chapter director votes",
        ],
        answerIndex: 0,
        explanation:
          "Central budget approval mirrors a chapter's: the ED approves, and SoD only reroutes to the FM if the ED was the one who submitted it.",
      },
    ],
  },

  // ── 44 · Executive Director: governance and seats ──────────────────────────
  {
    slug: "finance-governance-and-seats",
    title: "Governance and seats",
    subtitle: "One seat, one holder — and the honest seat switcher",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Seats get assigned from the **Org Chart** tab: a superuser can assign a holder directly, and anyone else proposes a change for the seat's holder (or the seat above it) to confirm — a two-party handoff, not a unilateral edit. Executive Director and Financial Manager sit at central; Chapter Director and Treasurer sit per chapter. Each is one holder per seat — assigning a new Executive Director replaces the old one, it doesn't add a second. Editing the chart's STRUCTURE itself (adding, moving, or removing seats) is separate and narrower: only the Executive Director or a superuser can do that.",
      },
      {
        kind: "table",
        headers: ["Seat", "Scope", "In UI copy"],
        rows: [
          ["Executive Director", "Central only", "Executive Director"],
          ["Financial Manager", "Central or chapter", "Financial Manager (central) / Treasurer (chapter)"],
          ["Chapter Director", "Chapter only", "Chapter Director"],
        ],
      },
      {
        kind: "p",
        text: "Today, some people genuinely hold two real seats at once — you might be Executive Director AND a Chapter Director. That's not a bug or a special permission: if you hold seats at both central and a chapter, you get an honest **seat switcher** (\"which desk are you at?\") that lists exactly your real seats. Someone with one seat never sees a switcher at all.",
      },
      {
        kind: "rule",
        title: "Dual-hatting is a phase, not a design",
        text: "The playbook's end state has no one holding both a central and a chapter seat — dual-hatting exists only because a city is small early on. As chapters grow their own leadership, the seat switcher naturally has less and less to switch between.",
      },
      {
        kind: "reveal",
        prompt:
          "You're seated as both Executive Director and a Chapter Director. The finance dashboard opens — what decides which view you land on?",
        answer:
          "Your seat switcher lets you pick which desk you're at; the dashboard then shows exactly that seat's real view. There's no \"preview\" mode pretending to be a seat you don't hold — only your genuine seats, listed honestly.",
      },
    ],
    quiz: [
      {
        prompt: "How many holders can one seat (e.g. Executive Director) have at once?",
        options: [
          "Unlimited",
          "One — assigning a new holder replaces the old one",
          "Two, for redundancy",
          "It depends on chapter size",
        ],
        answerIndex: 1,
        explanation:
          "Seats are one-holder slots per (scope, title) — a new assignment replaces, it never stacks.",
      },
      {
        prompt: "Who sees a seat switcher in the finance dashboard?",
        options: [
          "Everyone, always",
          "Only someone who genuinely holds seats at both central and a chapter",
          "Only the Executive Director",
          "Nobody — switchers were removed entirely",
        ],
        answerIndex: 1,
        explanation:
          "Single-seat holders never see a switcher — it exists purely for the real, transition-period case of holding two real seats.",
      },
      {
        prompt: "What does the playbook say about dual-hatting long-term?",
        options: [
          "It's the permanent design",
          "It's a transition state that should empty out as chapters mature — no one holds both a central and chapter seat at steady state",
          "It should apply to every leader",
          "It only applies to Treasurers",
        ],
        answerIndex: 1,
        explanation:
          "The playbook explicitly calls for no dual-hatting across central and chapter once a city is established — today's overlap is a startup condition.",
      },
    ],
  },

  // ── 45 · Executive Director: launch grants + the skim transfer ─────────────
  // Retitled framing, unchanged title/slug (2026-07-26): this used to describe
  // automated Increase transfers as "coming with Phase 4" — that automation
  // was built, then DELETED at the founder's request ("we just have 1 chapter
  // and not a lot of backers, it feels unnecessarily complex... it could be
  // just a manual transfer"). Rewritten so it no longer promises an automated
  // pipe that isn't coming; both flows are honored as deliberate manual
  // transfers today, recorded through one generic mutation.
  {
    slug: "finance-launch-grants-and-transfers",
    title: "Launch grants and the skim transfer",
    subtitle: "Two money flows, both recorded by hand, by design",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Two money flows tie the whole network together: the 15% skim moving UP from every chapter into the City Launch Fund, and a one-time launch grant moving DOWN from central to seed a brand-new city. The fund itself is real today — it's central's own account. Both flows move as a deliberate, human-recorded transfer, not an automatic pipe — and that's a choice, not a gap.",
      },
      {
        kind: "table",
        headers: ["Flow", "Direction", "What it funds"],
        rows: [
          ["The skim", "Chapter → Central, monthly", "The City Launch Fund"],
          ["Launch grant", "Central → new chapter, one-time", "Equipment (~$4,300) + the training trip (~$3,500–4,000)"],
        ],
      },
      {
        kind: "rule",
        title: "The fund exists; a human moves the money into and out of it",
        text: "The City Launch Fund's balance is a real number in a real central account you can see today. Central's bookkeeper records every skim contribution and every launch grant as a manual transfer — same real ledger entry either way, just typed in rather than run by a cron job.",
      },
      {
        kind: "tip",
        text: "**Why manual, on purpose:** with one chapter and a small backer base, an automated monthly transfer (and the account wiring, approval flow, and failure handling it requires) is complexity the network doesn't need yet. Every transfer — a skim contribution, a launch grant, or anything else that moves money between a chapter and central — goes through ONE mutation today, with a note saying what it's for. If the network grows enough that this becomes a real burden, automating it is a well-understood, revisitable decision — not a broken promise.",
      },
      {
        kind: "reveal",
        prompt:
          "A brand-new city is ready to launch. Where does its ~$7,800–8,300 in equipment and training-trip funding come from, and who moves it?",
        answer:
          "The City Launch Fund — the pool every existing chapter has been feeding with its monthly 15% skim. The fund's balance is real and visible today; central's bookkeeper records the one-time transfer to the new chapter by hand, the same way every skim contribution gets recorded.",
      },
    ],
    quiz: [
      {
        prompt: "What does the City Launch Fund pay for?",
        options: [
          "Ongoing chapter operating costs",
          "A new city's one-time launch cost — equipment and training trip",
          "Reimbursements to individual members",
          "Central's own salaries",
        ],
        answerIndex: 1,
        explanation:
          "The fund's entire purpose is seeding the next city's launch — a one-time cost, not recurring operations.",
      },
      {
        prompt: "Is the monthly skim transfer automated today?",
        options: [
          "Yes, fully automatic",
          "No — central's bookkeeper records it as a deliberate manual transfer; that's a choice for the network's current size, not an unfinished feature",
          "It was automated then removed after a failure",
          "It only runs once a year",
        ],
        answerIndex: 1,
        explanation:
          "The fund's balance is real and live, and every contribution to it is a real transfer — recording it by hand is a deliberate simplification, not a missing Phase 4 feature waiting to ship.",
      },
      {
        prompt: "Why are skim and launch-grant transfers modeled as `flow:\"transfer\"` rows?",
        options: [
          "So they count double toward budgets",
          "So they're excluded from category/budget spend, like any money movement that isn't a mission purchase",
          "It's a legal requirement",
          "So central pays less tax",
        ],
        answerIndex: 1,
        explanation:
          "Transfers are excluded from category/budget spend everywhere in this system — the skim and launch grants are money MOVEMENTS, not purchases, and must never distort actuals.",
      },
    ],
  },

  // ── 46 · Chapter money model: the budget lifecycle ─────────────────────────
  // New (chapter-money-model course). Submitter's-eye view of draft → send for
  // review → approve/request-changes, generic across chapter and central scope
  // — the CD-specific "85% principle" framing stays in `finance-approving-
  // budgets`, owned by the Chapter Director course. Authored from the shipped
  // workflow: `apps/convex/finances.ts` (`submitBudgetForApproval`,
  // `approveBudget`, `requestBudgetChanges`, `BUDGET_APPROVAL_STATUSES` in
  // `@events-os/shared`'s `finance.ts`) + the on-card actions in
  // `BudgetApprovalActions.tsx` / `BudgetCreateModal.tsx` ("Send for review",
  // "Request changes"). The temporary superuser self-approval bypass
  // (WP-wave4 item 8, an owner-only solo-backfill exception) is deliberately
  // left out — it's not part of the rule this audience needs.
  {
    slug: "finance-budget-lifecycle",
    title: "The budget lifecycle",
    subtitle: "Draft, send for review, approve — never by the person who sent it",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "An event or project doesn't automatically get a budget — plenty are pure work-tracking, no dollars involved. A budget only exists once real money enters the picture: type a planned amount in when you create it and a Draft budget is created right then, or tap **Add budget** on the event or project's own page later, once there's actually something to plan. Either way, nothing is approved yet — a budget is a plan until someone deliberately moves it forward.",
      },
      {
        kind: "bullets",
        items: [
          "**Draft** — the amount and line items are yours to edit freely. Nobody outside your own head has weighed in yet, and nothing you type here spends anything.",
          "**Send for review** — a deliberate tap, never an autosave. The moment you send it, the budget is Awaiting approval, visible to whoever can act on it — and they get an email too, not just a badge in the app.",
          "**Approve or Request changes** — the approver either clears it (Approved) or kicks it back with a reason (Changes requested), which reopens it for editing and a fresh send. Either decision emails the submitter back, so a Changes requested reason doesn't just sit waiting to be noticed.",
          "**Who approves what** — a chapter budget's approver is its Treasurer or Chapter Director; a central budget's is the Executive Director or Financial Manager.",
        ],
      },
      {
        kind: "rule",
        title: "Approver ≠ submitter, no exceptions",
        text: "Separation of duties means whoever sends a budget for review can never be the one who approves it — the same identity-based rule that governs reimbursements, applied to budgets.",
      },
      {
        kind: "tip",
        text: "**Raising the cap sends it back to Draft — but nobody's told.** Bump an APPROVED budget's amount and it drops straight back to Draft the moment you save the higher number — NOT Awaiting approval, and NOT auto-submitted. The OLD approved figure keeps working as the real spending cap the whole time, so nothing silently expands — but the increase itself is invisible to every approver until YOU deliberately hit Send for review again. Skip that tap and the raise is never reviewed, and no approver is ever notified. Decreasing an amount, or reshuffling its line items, never triggers any of this.",
      },
      {
        kind: "reveal",
        prompt:
          "A charge lands against an event whose budget is still sitting in Draft. Can anyone attribute it there right now?",
        answer:
          "No — only an APPROVED budget can take a charge. The transaction waits in Needs Budget, patiently, until the budget's owner sends it for review and someone approves it. Attribution and approval move together on purpose — see the next lesson.",
      },
    ],
    quiz: [
      {
        prompt:
          "An event is created with no dollar amount entered. What's true about its budget right now?",
        options: [
          "It's sitting in Draft at $0, waiting for someone to send it for review",
          "It's Awaiting approval automatically",
          "There's no budget row at all yet — most events need none; one appears once a real amount is entered or someone taps Add budget",
          "It's Approved automatically at $0",
        ],
        answerIndex: 2,
        explanation:
          "A budget only exists once real money enters the picture. No amount at creation means no budget row yet, not a hidden Draft one — the moment a real amount is entered or Add budget is tapped, THAT budget is born a Draft.",
      },
      {
        prompt: "What moves a budget out of Draft and into review?",
        options: [
          "It happens automatically after 24 hours",
          "A deliberate \"Send for review\" tap — nothing routes to an approver until you choose to send it",
          "The first charge attributed to it",
          "The Financial Manager pulls it into review",
        ],
        answerIndex: 1,
        explanation:
          "Send for review is an explicit action, not a side effect — a budget can sit in Draft indefinitely with zero consequence.",
      },
      {
        prompt: "Who can approve a budget you just submitted?",
        options: [
          "Anyone with approval authority for that scope — except you",
          "You can, if you also hold the approver's seat",
          "Whoever is fastest to open the app",
          "Nobody — a submitter's own budget is stuck forever",
        ],
        answerIndex: 0,
        explanation:
          "Approver ≠ submitter is about identity, not title — the same person can never wear both hats on one decision.",
      },
      {
        prompt: "You raise an APPROVED budget's cap from $2,000 to $3,000. It drops back to Draft — not automatically resubmitted. What actually limits spending until someone sends it for review again and it's approved?",
        options: [
          "The new $3,000 — available immediately",
          "The old $2,000 — still the live spending cap until it's sent for review again and approved",
          "Spending is blocked entirely until the increase clears",
          "Whichever amount the last charge used",
        ],
        answerIndex: 1,
        explanation:
          "The increase flips the budget back to Draft, not Awaiting approval — it sits fully editable and invisible to approvers until someone deliberately sends it again. The OLD approved amount keeps enforcing the cap the whole time, so spending power never silently jumps — but skip that resend and the raise is never reviewed at all, and no approver is ever notified.",
      },
    ],
  },

  // ── 47 · Chapter money model: one home per dollar ──────────────────────────
  // New (chapter-money-model course). Explicit-only attribution, the "For"
  // picker, and the chapter/central split. Authored from the CURRENT shipped
  // rule (`apps/convex/finances.ts#isAttributableBudget`, WP-wave4 item 5,
  // owner decision 2026-07-17): only an APPROVED budget is attributable, and
  // the picker's old "summon a $0 budget on pick" behavior was retired
  // alongside it — a not-yet-approved or absent budget's spend now surfaces
  // in the "Needs Budget" bucket instead, resolved by sending that budget for
  // review (previous lesson), not by picking it into existence.
  //
  // The AI-suggestion caveat this lesson used to carry ("a suggestion is not a
  // link") was removed with the feature itself — a graded quiz answer that
  // describes a screen the learner will never see is worse than no caveat.
  {
    slug: "finance-one-home-per-dollar",
    title: "One home per dollar",
    subtitle: "Explicit links only — nothing rides in silently",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Attribution in this system is explicit-only, everywhere: a transaction counts toward a budget the moment a person deliberately links it there. Nothing is coded automatically; no charge quietly lands on the nearest-looking budget just because the dates or amounts happen to line up.",
      },
      {
        kind: "bullets",
        items: [
          "**Unattributed is the honest name for \"not yet claimed.\"** Every charge without an explicit link sits in the Needs Budget bucket, in plain sight on the dashboard — a number the whole chapter works to drive to zero, never one to quietly bury.",
          "**Only an approved budget can take a charge.** The \"For\" picker — grouped Events / Projects / Recurring — only ever offers budgets that have actually cleared review (the budget lifecycle, previous lesson). A Draft or Awaiting-approval budget can't receive a link yet, on purpose.",
          "**Nothing codes a charge but a person.** The \"For\" picker ranks the likely homes for a charge so the right one is usually first, but ranking is only ordering — a link exists because someone chose it.",
        ],
      },
      {
        kind: "rule",
        title: "Every dollar belongs to a chapter or to central — never both",
        text: "A budget's level is a real chapter, or the literal \"central\" scope — never null, never a mix of the two. A chapter's own dashboard never surfaces central's money alongside its own, and central's rollup never quietly absorbs a chapter's.",
      },
      {
        kind: "reveal",
        prompt:
          "You're logging a charge for a brand-new event that doesn't have an approved budget yet. What happens in the \"For\" picker?",
        answer:
          "Nothing — that event's budget won't appear in the picker at all until it clears review. The charge sits in Needs Budget in the meantime; open the event's own page, use Add budget (or its existing Draft), and send it for review. Once it's approved, the same charge attributes cleanly.",
      },
    ],
    quiz: [
      {
        prompt: "How does a transaction end up counted toward a budget?",
        options: [
          "The system infers the closest match automatically",
          "A person explicitly links it; nothing is inferred automatically",
          "Any charge in the same category counts by default",
          "The Treasurer assigns it at month-end",
        ],
        answerIndex: 1,
        explanation:
          "Explicit-only attribution means a link only exists because a human made it real. The picker can rank the likely homes; it never picks one.",
      },
      {
        prompt: "What does the Needs Budget bucket mean?",
        options: [
          "A bug in the sync",
          "Spend with no explicit, approved-budget link yet — shown loudly on purpose, not silently absorbed",
          "Money that left the account without a transaction record",
          "Charges waiting on a bank sync",
        ],
        answerIndex: 1,
        explanation:
          "Needs Budget is a first-class, visible bucket — designed to be noticed and driven to zero, not hidden.",
      },
      {
        prompt: "Why won't the \"For\" picker offer a budget that's still Draft or Awaiting approval?",
        options: [
          "It's a display bug",
          "Only an approved budget is attributable — attribution and approval move together on purpose",
          "Draft budgets are picker-only, approved budgets are hidden",
          "The picker shows every budget regardless of status",
        ],
        answerIndex: 1,
        explanation:
          "The picker and the write-side attribution check share one gate: a budget has to clear review before a charge can call it home.",
      },
      {
        prompt: "Can a chapter's dashboard show central's money mixed in with its own?",
        options: [
          "Yes, they roll up together automatically",
          "No — every dollar belongs to exactly one level, chapter or central, never both",
          "Only if the Financial Manager enables it",
          "Only for the skim transfer",
        ],
        answerIndex: 1,
        explanation:
          "Chapter and central are separate homes for every dollar — a chapter's view never quietly includes central's money, or vice versa.",
      },
    ],
  },
];

/** The Finances stream's theme entry. */
export const FINANCES_THEME: Theme = {
  key: "finances",
  title: "Finances",
  subtitle:
    "Where the money comes from, how it's tracked, and who signs off on it.",
};

/**
 * The Finances stream's courses, in catalog order. Six courses now: five
 * role courses (most-to-least everyone) plus the shared `chapter-money-model`
 * core course between Finances-for-Everyone and Treasurer — the org
 * principle: a role path is a playlist of shared courses, and Chapter
 * Director + Treasurer (later FM/ED — role-path wiring lands separately)
 * both start from the exact same foundation instead of re-teaching it.
 * Every role course ends with a hands-on capstone in other streams (founder
 * 2026-07-14) — finance capstones need a dedicated training-sandbox
 * mechanic that doesn't exist yet, so these are lesson-only for now; a
 * capstone module can be appended later (module slugs stay stable, so it's
 * a pure addition, not a reshape).
 */
export const FINANCES_COURSES: Course[] = [
  {
    slug: "finances-for-everyone",
    themeKey: "finances",
    title: "Finances for Everyone",
    level: "beginner",
    audience: "team",
    description:
      "What every member needs: where the money comes from, using your " +
      "card + the 7-day receipt rule, coding what you spent and why, and " +
      "both directions of reimbursement. Gains a 'getting your budget " +
      "approved' module once budget approval (Phase 3) ships.",
    icon: "dollar-sign",
    moduleSlugs: [
      "finance-stewardship",
      // The BEFORE-you-spend lesson sits between whose-money-it-is and the
      // card mechanics, because that's the real sequence a purchase follows.
      "finance-three-tracks",
      "finance-card-and-receipts",
      "finance-receipt-exceptions",
      "finance-coding-your-charges",
      "finance-reimbursements-and-flags",
    ],
  },
  {
    slug: "chapter-money-model",
    themeKey: "finances",
    title: "The chapter money model",
    level: "intermediate",
    audience: "team",
    description:
      "The shared foundation every finance leader builds on: what backer " +
      "tiers unlock and where the skim goes, how a budget moves from draft " +
      "to a real spending cap, why every dollar has exactly one home, and " +
      "what happens when a closed month goes public. Treasurer and Chapter " +
      "Director both start here.",
    icon: "layers",
    moduleSlugs: [
      "finance-tiers-and-skim",
      "finance-budget-lifecycle",
      "finance-one-home-per-dollar",
      // Publishing the books lands HERE rather than in the Treasurer or ED
      // course because it has two audiences and a module belongs to exactly
      // one course (the catalog's keystone invariant). The Treasurer prepares
      // a month and the ED / FM / Chapter Director publishes it — the
      // two-party split `finance.ledger.publish` enforces — and all four paths carry
      // this shared-foundation course, so one authoring of the rules reaches
      // both sides of that split.
      "finance-publishing-the-books",
    ],
  },
  {
    slug: "treasurer",
    themeKey: "finances",
    title: "Treasurer",
    level: "intermediate",
    audience: "role",
    description:
      "The chapter Treasurer's remit: running Reconcile, chasing receipts, " +
      "and closing the month in under 30 minutes.",
    icon: "check-square",
    moduleSlugs: [
      "finance-reconcile-grid",
      "finance-transfers-and-payouts",
      "finance-chasing-receipts",
      "finance-monthly-close",
    ],
  },
  {
    slug: "chapter-director",
    themeKey: "finances",
    title: "Chapter Director",
    level: "leader",
    audience: "role",
    description:
      "Raise-vs-manage separation and approving budgets under the 85% " +
      "principle. Builds on the chapter money model course's tiers, skim, " +
      "and budget-lifecycle foundation.",
    icon: "shield",
    moduleSlugs: [
      "finance-raise-vs-manage",
      "finance-approving-budgets",
    ],
  },
  {
    slug: "financial-manager",
    themeKey: "finances",
    title: "Financial Manager",
    level: "leader",
    audience: "role",
    description:
      "The central Financial Manager's remit: auditing every chapter, " +
      "watching the receipt escalation queue, and administering accounts + cards.",
    icon: "bar-chart-2",
    moduleSlugs: [
      "finance-cross-chapter-audit",
      "finance-receipt-escalation-queue",
      "finance-accounts-and-cards-admin",
    ],
  },
  {
    slug: "executive-director",
    themeKey: "finances",
    title: "Executive Director",
    level: "leader",
    audience: "role",
    description:
      "Central budgets, governance + seat assignment, and the launch " +
      "grants + skim transfer that grow the network to its next city.",
    icon: "award",
    moduleSlugs: [
      "finance-central-budgets",
      "finance-governance-and-seats",
      "finance-launch-grants-and-transfers",
    ],
  },
];
