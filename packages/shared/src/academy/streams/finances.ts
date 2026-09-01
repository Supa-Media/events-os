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
 *
 * ── THE GRID DECLUTTER (2026-08-13 founder call) ──────────────────────────
 * Content-only across three Finances sections; nothing added, moved or
 * renamed. The Reconcile grid lost its VIEW MENU (a dropdown of seven saved
 * views that was the page title) and its three HEADER CHIPS ("45 needs
 * attention · 90 ready to close · 222 reconciled"), on the founder's
 * reasoning that both restate what the grid's own controls already say:
 * "I don't even see the need for the dropdown into By month." "You already
 * have the State right here on the side... That's all you need, and you have
 * the books as well." "What are these pills underneath... I don't even know
 * what reconciled is." "This should just be, like, Transactions." Group by
 * covers month and person, the State/Kind dropdowns cover the states, the
 * books selector covers scope — so the menu was a third way to say it and the
 * chips a fourth. The page-level "Chase receipts (N)" button went too: group
 * by Person puts a Send reminder on each cardholder's own band.
 *
 * Two month-band changes came with it. Preview and Publish are no longer
 * withheld from a filtered grid (#707); instead the band names BOTH figures —
 * "12 of 318 charges · -$4,102 of -$88,201" — so Publish is plainly about the
 * month. And a person band's Send reminder is now visible: it was rendered
 * ~500px past the right edge of a laptop window, inside the grid's horizontal
 * scroller.
 *
 * So `finance-reconcile-grid` retitled its header rule ("The pile that was
 * never a backlog") and rewrote it around the page's four controls, keeping
 * the needs-attention/ready-to-close split as vocabulary rather than as a
 * pill, and keeping the bulk-bar teaching; gained one rule, "Group by is how
 * you get everywhere else", which is where the retired month/chase/publish
 * views now live; dropped the "third chip in the header" clause from its
 * Reconciled filter row and the "Book's view menu" pointer from its coding
 * rule; and SWAPPED its chips question (already at the 5-cap) for one on what
 * Publish acts on when a month band is filtered. `finance-chasing-receipts`
 * rewrote its worklist rule as the State + Group by pairing, folding in the
 * 24h nudge limit and the one-book rule for Remind all, and rewrote its
 * worklist question's answer and explanation to match. `finance-publishing-
 * the-books` rewrote its "watch it happen" paragraph for Group by → Month and
 * teaches the band's two figures. Titles, minutes and quiz lengths are
 * unchanged everywhere; no section, course or slug moved.
 *
 * BULK EXPLANATION + the undoable approve (2026-08-14). Two shipped changes,
 * both in the Book, both taught in `finance-reconcile-grid` and deliberately
 * NOWHERE ELSE:
 *
 *  - Multi-select → **Explain** writes one typed sentence onto every selected
 *    charge (`transactionCodings.submitBulk`). This one HAD to be taught,
 *    because the reader has just been told a coding is a person's own
 *    testimony and that nothing is machine-composed — both still true, and a
 *    bulk button discovered without that framing reads like the rule quietly
 *    lapsed. Its own rule block ("Explaining a backlog without lying about
 *    it") states the framing, the meal refusal (who was at a meal is a
 *    per-occasion fact and is not offered in bulk), and the per-row refusal
 *    reporting.
 *  - Approve gained a confirm beat, a ~10s **Undo**
 *    (`transactionCodings.undoApproval` — restores `submitted`, notifies
 *    nobody, audited as an undo), and the grid gained an **Explained** filter
 *    so a published sentence stays re-readable. Folded into the existing
 *    "Reconciled means coded, too" rule and the filter table rather than given
 *    new blocks: they change how one act behaves, not what the act means.
 *
 *    The undo teaching is DELIBERATELY explicit that undo is not send-back.
 *    The first cut of both the rule and its quiz question said the undo "sends
 *    the coding back to its author, exactly as Send back would" — true of the
 *    first implementation, and now precisely wrong. Undo returns the row to
 *    the REVIEWER's queue (`submitted`) and notifies nobody; send-back means
 *    the AUTHOR must act and emails them. A lesson that blurred the two would
 *    teach a treasurer to reach for the wrong one, which is the exact failure
 *    "the Academy must track the product" is about.
 *
 * `finance-coding-your-charges` is deliberately UNTOUCHED: it is the
 * cardholder's lesson, the bulk bar is the Book's (bookkeeper+), and its "no
 * machine ever composes an answer" rule is still exactly true — nothing there
 * became stale.
 *
 * Two quiz questions IN, two OUT, so the length stays 5 (the per-section cap
 * `apps/convex/tests/academy.test.ts` enforces). IN: the bulk apply's per-row
 * honesty, and what Undo actually does (returns the row to awaiting review,
 * telling nobody). OUT, both because this lesson already
 * teaches them elsewhere rather than because they stopped mattering:
 *  - "the dashboard says To review 80, where do you land" — its doctrine (a
 *    number you can see is a number you can tap through to) is carried twice
 *    more in the same quiz, by the Unattributed item and the Ready-to-close
 *    item;
 *  - "you mark a charge Excluded and leave the reason blank" — stated verbatim
 *    in the `try_status` caption immediately above the quiz.
 * Minutes 4 → 5 for the added rule block.
 *
 * "Reconciled" is now called **Closed** (2026-08-14). Founder, on the deployed
 * Transactions grid: "I don't even know what reconciled is." The word only ever
 * meant "this row is finished", and the page already funnels rows toward it
 * with a roll-up called Ready to close — so the STATUS is now labeled Closed
 * and the two finally pair. This is a LABEL change only: the stored value is
 * still the string `"reconciled"` in the schema, in `TRANSACTION_STATUSES`, in
 * the filter keys and in every URL param, so nothing here about what a state
 * MEANS has changed.
 *
 * Content-only, adding and moving nothing; no section title, slug, minutes or
 * quiz length moved. `finance-receipt-exceptions` (the "mark it Closed and move
 * on" wrong-fix, its tip, and one quiz option + explanation),
 * `finance-reimbursements-and-flags` (the flag-is-not-a-status bullet and its
 * quiz explanation), `finance-chasing-receipts` (the disjoint-filters paragraph
 * and one quiz distractor) and `finance-reconcile-grid` carry the new word;
 * that last one most, since it teaches the grid: the filter table's own row is
 * now ["Closed", …], the header rule says "pressing Mark closed", the
 * `try_status` option reads Closed (its `value` still `"reconciled"`), the rule
 * "Reconciled means coded, too" is retitled **"Closed means coded, too"**, and
 * one quiz distractor moves to "marked closed without a coding". Two quizzes
 * were edited IN PLACE — no question added or removed, both still at their
 * snapshotted length.
 *
 * What deliberately KEPT the word: everywhere it means real bank
 * reconciliation, which is a different act and still the honest name for it —
 * "Paid from … that's what reconciles against a bank statement"
 * (`finance-cross-chapter-audit`), the morning reconciliation engine, the
 * Treasurer's remit in `foundations-*` ("records and reconciles the chapter's
 * money"), the monthly-close lesson's "the month was reconciled continuously"
 * (its neighbour sentence already uses "close" for closing the MONTH, and
 * reusing it for the rows would collide), and `works-finishing-well`'s giving
 * duty. The Reconcile SCREEN keeps its name too — this renamed a status, not a
 * page.
 *
 * SUPERSEDED (2026-08-14, same day): this block used to end "the audit log
 * stores the label, so rows written before today still read 'Reconciled'; that
 * trail is append-only and is not being rewritten." Half of that is still true
 * and half of it isn't. The trail is still append-only and no word anyone saw
 * has been rewritten — but it now also stores the STATUS KEY beside those words
 * and renders today's label from it at read time (founder, asked to backdate
 * the strings and offered this instead: "Store the status key and render the
 * label. That'll be great."). So history reads "Closed" throughout without a
 * single row being falsified. NO ACADEMY CONTENT CHANGES: no lesson teaches
 * what the History section's before/after column shows — the one lesson that
 * describes a change history at all is `finance-merchant-rename`, and a
 * merchant name is free text with no key either way. See
 * `@events-os/shared`'s `financeAuditValue.ts`.
 *
 * COLUMN SHOW/HIDE on the grid (2026-08-14, founder: "a way to enable and
 * disable columns quickly… so I could just narrow in on that"). Content-only,
 * one section: `finance-reconcile-grid`'s "The pile that was never a backlog"
 * rule said the page "has exactly FOUR controls", which a fifth control makes
 * false the day it ships — precisely the kind of clause that rots quietly. It
 * now says five (Search, Kind, State, Group by, Columns) and carries one
 * paragraph on what Columns does: it hides columns rather than filtering rows,
 * the checkbox / Merchant / Actions always stay, nothing is deleted, and the
 * narrowed view travels in the link like every other bit of this page's state.
 * No new section, no quiz change, no minutes change — this is a clause in a
 * rule the reader is already reading, not a new thing to learn.
 *
 * TWO CLOSE RULES (founder, 2026-08-13/14). Both are about what a row OWES
 * before it can be closed, both are content-only here, and neither moved a
 * title, slug, minutes or quiz length.
 *
 *  - A PERSONAL CHARGE AWAITING REPAYMENT CANNOT BE CLOSED ("make sure to
 *    have business logic so that no rows that are personal expenses that need
 *    to be repaid can be closed"). `finance-reconcile-grid`'s "Personal is a
 *    flag, not a status" rule said the opposite in one clause — "a charge that
 *    is fully Closed can also be an unpaid personal expense at the same time"
 *    — and that clause was TRUE IN ONE DIRECTION ONLY, which is the whole
 *    subtlety. A row closed first and flagged personal afterwards really is
 *    both, stays both, and is never rewritten (the representation decision
 *    above `PERSONAL_EXPENSE_STATES` in `finance.ts` depends on it). What
 *    cannot happen is the TRANSITION: closing a row while the money is still
 *    owed. The rule now teaches both directions in those terms, plus the
 *    refusal's two ways out and the per-row reporting in a bulk close. Its
 *    quiz was checked question by question and none of the five hung on the
 *    old clause, so nothing was swapped — the quiz is at the 5-cap and
 *    swapping out a correct question to make room would have cost coverage.
 *  - PAYOUTS AND PROCESSOR ROWS DON'T OWE DOCUMENTATION ("it says nine rows
 *    not publishable yet, no documentation — but most of the rows are quite
 *    literally payouts… Payouts shouldn't need documentation"). This REVERSES
 *    the rule `finance-transfers-and-payouts` was written to carry, so its
 *    "Marked still means documented" block now splits the two markings: a
 *    marked TRANSFER still owes its bank statement (marking must never be a
 *    way to stop being chased — unchanged), a marked PAYOUT owes nothing.
 *    The block also states, plainly, what we actually hold in place of a
 *    receipt: for Stripe a real settlement record of our own; for Givebutter
 *    and hand-marked "other" payouts nothing but the processor's dashboard.
 *    A lesson that claimed the exemption without naming that asymmetry would
 *    be teaching the convenient half. The lesson's four quiz questions were
 *    checked: the documentation one is transfer-only and stays true as
 *    written, so again nothing was swapped. One scenario feedback line that
 *    said excluding "drops all three out of the receipt chase" was corrected
 *    — the payout is no longer in that chase to be dropped from. The
 *    Reconcile filter table's "Owes a receipt or coding" row lost its
 *    "…and processor payouts" clause for the same reason.
 *
 * THE GRID'S LAST COLUMN, SPLIT BY KIND (founder, 2026-08-14: "the last column
 * is very cluttered. It contains like a bunch of different rows and information
 * and things like that… it could be much cleaner and have things broken down").
 * Reconcile's Actions cell had collected three kinds of thing in one 112px
 * space: the way INTO a record, badges saying what the row IS, and buttons that
 * ACT on it. The markings moved to their own hideable "Marked" column (which
 * only renders when the page actually has one on it), every row action moved
 * behind a single `⋯` menu, and the speech-bubble stayed exactly where it was.
 * Content-only here, in the four places a lesson named an affordance by its old
 * shape:
 *
 * NOTE (2026-09-01, prose budget): the four bullets below describe blocks that
 * the `finance-reconcile-grid` rewrite REMOVED. They are kept as history of
 * why the affordances were renamed, but the rules themselves — corrections vs.
 * bank rows, merchant renaming, and the personal flag's mechanics — no longer
 * have a home in the curriculum. See `academyProse.test.ts`: compressing a
 * module this dense to 350 words means splitting it, not just tightening it.
 *
 *  - `finance-reconcile-grid` / "Some rows you can correct": hand-entered rows
 *    no longer "carry a pencil in the Actions column" — they offer **Correct
 *    amount, date or merchant** in the row's ⋯ menu. The rule's whole point is
 *    unchanged and is the reason it needed the edit: it teaches the reader to
 *    look for an affordance and conclude something real from its ABSENCE (a
 *    bank row can't be corrected), so a lesson pointing at a pencil that no
 *    longer exists would have them concluding it from the wrong thing.
 *  - `finance-reconcile-grid` / "Renaming a merchant is not correcting a row"
 *    ended by pointing at "the pencil" for the same act; it now points at the
 *    correction in the ⋯ menu.
 *  - `finance-reconcile-grid` / "Personal is a flag, not a status" now names
 *    the **Marked** column the flag actually reads out in ("Personal" while
 *    owed, "Repaid" once settled) — which is the rule's own argument made
 *    visible: the flag has its own column precisely because it is not one of
 *    the four statuses. Its "The pile that was never a backlog" rule also
 *    picks up one clause on Marked coming and going with the data, since a
 *    column that isn't always there is otherwise a support question.
 *  - `finance-transfers-and-payouts` / "Marked still means documented" already
 *    promised that "any marking can be undone"; it now says where the marking
 *    shows and where the undo went.
 *
 * No quiz changed. Every question in both sections was checked against the
 * moves and none hung on an icon's shape — and `finance-reconcile-grid` is at
 * the 5-question cap, where a swap would have cost real coverage to restate
 * what the rule blocks already say. No title, slug, minutes or quiz length
 * moved.
 *
 * APPROVAL NOW EMAILS THE CLAIMANT (2026-08-14; founder: "when their
 * reimbursement was approved and it's coming to them, there's no email sent…
 * we just need to make sure people know that their money is coming once it's
 * approved"). Approval really was the one decision in the reimbursement state
 * machine that reached the person waiting on it through no channel at all, and
 * `finance-reimbursements-and-flags` is the lesson that teaches the flow, so it
 * carries the change. Content-only — no section added, moved or removed, and
 * minutes stay 5.
 *
 *  · ONE BULLET ADDED, "You'll be told when it's approved — and approved is
 *    not paid": the notice goes to the address on the REQUEST rather than an
 *    account (most claimants are accountless), it names the approved amount
 *    and, on a partial approval, the submitted one too, and it deliberately
 *    stops short of saying the money has moved. The state pair matters more
 *    than the email: `approve` records a decision, and the payout is the step
 *    after it. The existing "Reimbursement — Public Worship owes you" bullet
 *    already taught the auto-ACH-on-approval mechanic and needed no change.
 *  · ONE QUIZ QUESTION SWAPPED, never grown — this quiz is at the 5-question
 *    cap `apps/convex/tests/academy.test.ts` enforces. IN: what an approval
 *    email does and does not mean about your money (approved ≠ paid, and
 *    partial approvals exist). OUT: "you spot a charge you don't recognize",
 *    whose answer is stated verbatim in the bullet a few lines above it and
 *    which was the only question here not about the two flows this lesson is
 *    named for. Its doctrine was NOT dropped — flagging says YOU made the
 *    charge, so a mystery charge is a freeze plus a phone call, not a flag —
 *    it moved into the explanation of the flagging question that was already
 *    in this quiz, which is its natural home.
 *  · The one-shot catch-up mailing to everyone approved before this shipped
 *    (`reimbursementApprovedNoticeBackfill`) is deliberately NOT taught: it is
 *    an operator action that runs once and then means nothing, not a durable
 *    rule anybody needs to learn.
 *
 * 2026-08-14, the same founder report's other half — TRANSFERS JOIN PAYOUTS,
 * and a payout stops being named after a person. Both land in
 * `finance-transfers-and-payouts`; no title, slug, minutes, quiz length or
 * order moved.
 *  - "All payouts and transfers should be bank record only. No need for
 *    documentation." So the split drawn earlier the same day — transfer owes,
 *    payout doesn't — is gone: "Marked still means documented" is now "Both
 *    markings are bank record only", and it teaches the Documentation column's
 *    actual words. (It keeps the Marked-column / ⋯-menu sentence the note
 *    above added; only the obligation half was rewritten.) This is the SECOND reversal of the
 *    same rule in one day and it costs something the first one didn't —
 *    marking a pair as a transfer is now the one move in Reconcile that
 *    removes a row from the chase, which is precisely the escape hatch
 *    "marking must never be a way to stop being chased" existed to shut. The
 *    lesson says that out loud rather than presenting the exemption as free:
 *    mark a row because it IS a transfer, never because it is awkward, and
 *    every marking is logged and reversible. `apps/convex/finances.ts`'s
 *    `owesDocumentation` carries the same warning for whoever reads the code.
 *    The quiz's fourth question taught the retired rule as its correct answer,
 *    so it was SWAPPED (still four): the old right answer is now a distractor
 *    and "Bank record only" is the answer. Two prose lines that said excluding
 *    drops a transfer out of the receipt chase were corrected — it isn't in
 *    one — and `finance-reconcile-grid`'s filter table lost its claim that the
 *    chase keeps marked transfers.
 *  - A MARKED PAYOUT ISN'T NAMED AFTER A PERSON ("Stripe payouts still have my
 *    name… I know I'm the one that initiated the payout, but come on, that
 *    can't mean I'm the merchant"). Bank feeds hand us the ACH ORIGINATOR as
 *    the counterparty, and on a Stripe payout that string can be a human
 *    being's name; a marked row now reads "Stripe payout" / "Givebutter
 *    payout" instead. Taught as a paragraph on the existing "A payout is NOT a
 *    transfer" rule rather than as a new block, because it is the same fact
 *    the rule already teaches — a payout has no merchant — finally showing up
 *    in the merchant cell. It says the bank's original string is kept (the
 *    rename editor and the name history still show it) and that a
 *    bookkeeper's own rename still wins, so nobody reads this as the app
 *    quietly editing the statement.
 *
 * AND A SECOND EMAIL WHEN THE MONEY ACTUALLY GOES (2026-08-14). The other
 * half of the APPROVAL-NOTICE ask two notes up — not of the transfers report
 * immediately above, which landed the same day and shares nothing but a date.
 * Founder: "let's also send emails when we actually pay people — this is
 * really important to them. Email when approved and email when paid." A
 * claimant now hears from us TWICE about one request, and the approval note
 * teaches only the first, which would leave the lesson quietly wrong about
 * what to expect. Same lesson carries it, content-only, minutes stay 5.
 *
 *  · ONE BULLET ADDED, "And a second email when the money actually goes": what
 *    the paid notice says, what "paid" does and doesn't guarantee (it is our
 *    word for SENT — an ACH credit still takes a business day or two to post,
 *    and a treasurer paying by hand sets their own timing), that the figure is
 *    the money that MOVED, and the one case that produces two paid emails — a
 *    bounced transfer, re-paid.
 *  · WHY THE AMOUNT BULLET MATTERS HERE: this is where a claimant is most
 *    likely to misread us. A partial approval means a smaller payment, NOT a
 *    first instalment; there is no such thing as paying half a reimbursement,
 *    so "the rest is coming" is never true and the bullet says so outright.
 *  · NO QUIZ QUESTION SWAPPED, and that is a decision, not an oversight. The
 *    quiz is at the 5-question cap `apps/convex/tests/academy.test.ts`
 *    enforces, so anything added costs something already there — and nothing
 *    here became WRONG: the approval-email question's right answer ("approved
 *    but not yet paid, sending the payout is the next step") is exactly as
 *    true now, and its distractors are exactly as false. The new fact — that a
 *    second email follows when the payout goes — is the natural completion of
 *    that question's own explanation, so it went there rather than costing
 *    this quiz a question on SoD, send-backs or personal-charge flags. If this
 *    lesson ever earns a sixth slot, "what does the PAID email guarantee about
 *    money being in your account" is the question to write.
 *  · The one-shot catch-up mailing (`reimbursementPaidNoticeBackfill`) is not
 *    taught, for the same reason its sibling isn't.
 *
 * 2026-08-14, PUBLISHING STOPS BEING SOMEWHERE ELSE (founder: "I can't see a
 * quick preview button anymore. I want to be able to preview and publish from
 * the same page — publish here takes me to a different page entirely"). The
 * publish console's month flow is now a component
 * (`components/finance/publish/PublishMonth.tsx`) that the console route and a
 * modal over a Transactions month band both render, so the act is unchanged
 * and unthinned — the same disclosures before the button, the same
 * two-approver handoff and its separation-of-duties refusal, the same
 * amendment reason on a re-publish, the same refusal of a snapshot that came
 * back incomplete. Two sections are touched, both content-only; no title,
 * slug, minutes, quiz length or order moved.
 *  - `finance-reconcile-grid`'s "Group by is how you get everywhere else" rule
 *    now says what Preview and Publish actually do from a band (open in a new
 *    tab; open the console's flow over the grid), and names the ONE exception:
 *    on **All books** a month band spans several chapters' books, so the
 *    status badge and Preview stand down and Publish travels to the console,
 *    where a book is named explicitly. Its filtered-band quiz explanation said
 *    "Publish itself still hands you to the publish console" — true when
 *    written, false now — and was corrected in place; the question, its
 *    options and its answer are untouched, and the quiz stays at 5.
 *  - `finance-publishing-the-books` taught the hand-off as deliberate rather
 *    than a missing feature, which was the right teaching for the old shape
 *    and is the wrong description of this one. It now teaches the panel and
 *    keeps the doctrine that mattered: none of what surrounds the button is
 *    paperwork in front of it, so nothing is skipped by publishing from the
 *    grid. It also names the two places that still open the console SCREEN —
 *    the Finances publishability card and an All-books band — and why (it
 *    lists every month of one book, and a book has to be named first).
 *  - NO QUIZ QUESTION SWAPPED, in either lesson. Both are at the 5-question
 *    cap `apps/convex/tests/academy.test.ts` enforces, and every question was
 *    re-read against the new shape: none asserted WHERE publishing happens as
 *    its correct answer. The "who can publish a month you prepared" question
 *    gained one clause in its EXPLANATION — the refusal is identical from the
 *    band, because it is the same flow — which is the one place a reader could
 *    have concluded the grid path was the lighter one.
 *
 * Reconciliation "flag" → "mark for review" (2026-08-14, founder: "what does
 * 'flag' do, it feels like a scary button"). Presentation-only rename on the
 * Accounts page's payout/transfer audit rows — the Convex mutation names and
 * `ReconciliationFlagKind` are unchanged, so nothing here about the DATA
 * model moved. `finance-transfers-and-payouts`'s STRIPE-payouts tip said the
 * Financial Manager can "audit and flag them"; it now says "audit it and mark
 * it for review" to match. NOTE this is a DIFFERENT flag from the personal-
 * expense one the "Personal is a flag, not a status" rule teaches — that one
 * is untouched here, and the entry above moved it to the Marked column.
 *
 * BALANCE SETTLEMENT ONLY BOOKS WHEN CASH REALLY MOVES (2026-08-14, founder:
 * "it creates actual things on the ledger which is just wrong and cluttered").
 * The morning engine used to book a `balance_settlement` transfer pair every
 * morning whether or not Real cash movement was on — and since that pair is
 * worth $0 to book value by construction, it never closed the gap it measured
 * and re-booked an identical row the next day, forever. Booking is now gated
 * on the same setting that decides execution. `finance-transfers-and-payouts`'s
 * STRIPE-payouts tip taught the old behaviour ("books each chapter's share as
 * an automatic transfer") and now teaches the real one: detection and deposit
 * labelling always happen, booking AND moving are both gated, and with the
 * toggle off the engine reports the gap instead of writing a row. The same tip
 * also lost a stale "badged 'Payout allocation'" claim, dead since #553.
 *
 * ONE CHASE, AND IT IS THE CODING ONE (2026-08-14; founder: "Instead of receipt
 * chase, I want a coding chase, because coding includes receipts… when I hit
 * chase, I want it to take into consideration the view that I'm on and which
 * rows are selected"). Two real changes to what the app does, both taught, no
 * section added, moved, retitled or re-timed.
 *
 *  - THE ASK CHANGED. "Send reminder" / "Remind all" became **Chase** /
 *    **Chase everyone**, and what they ask for is the CODING. That is not a
 *    rename with new words on it: `submitCoding` refuses to submit without a
 *    receipt or an approved exception, so asking somebody to code already asks
 *    them to document, and a coding chase strictly contains the receipt chase.
 *    `finance-chasing-receipts`'s worklist rule now says that out loud — it is
 *    the reason there is only one button and the reason the Chase Receipts page
 *    is gone rather than sitting beside this. The chase email's two stated
 *    reasons are taught with it, because both are true and the second is the
 *    one this org runs on: IRS substantiation, and the public ledger our donors
 *    read.
 *  - THE CHASE IS SCOPED. It acts on the view the manager is standing in —
 *    filters, search, and above all TICKED ROWS, which win over everything
 *    because they are the narrowest thing on the screen. This is the founder's
 *    actual reason for wanting it in the grid ("they'd know there's no way this
 *    person can code these two transactions, but they can code these three"),
 *    so it earns a full paragraph in the "for that handful" block rather than a
 *    clause. The same block gains the no-email-on-file case, which is reported
 *    by name rather than skipped silently, and keeps the manager-only and
 *    one-book rules.
 *
 * ONE QUIZ QUESTION SWAPPED in `finance-chasing-receipts`, never grown — it is
 * at the 5-question cap `apps/convex/tests/academy.test.ts` enforces. IN: Priya
 * has five charges, two are yours and three are hers, tick the three and chase
 * those (the selection-wins rule, plus why the 24h cap makes narrowing-before-
 * pressing matter). OUT: "a straggler hasn't uploaded a receipt, what do you
 * do", whose correct answer was "click Send reminder on their group in Chase
 * Receipts" — a button and a page that both stopped existing, and whose
 * doctrine (you can chase on demand, capped at once a day) is stated in the
 * rule block and carried in the new question's explanation. The worklist
 * question's explanation was corrected in place for the button's name.
 *
 * TITLE AND SUBJECT DELIBERATELY UNCHANGED. "Chasing receipts" still names
 * what this lesson is about: the chase absorbed coding when the policy landed
 * (the State filter has read "Owes a receipt or coding" since), so this is the
 * button and the scoping catching up with a subject the lesson already had —
 * not a new one. Retitling it would move a slug and a snapshot for a lesson
 * whose reader is doing the same job in the same place.
 *
 * `finance-reconcile-grid` carries the vocabulary in the two places it names
 * the button — its State-filter table row for "Owes a receipt or coding" and
 * its Group-by rule's Person paragraph, which also picks up the one clause a
 * reader of THAT lesson needs: the chase acts on the view you are standing in.
 * No quiz there changed; none of its questions hung on the button's name.
 *
 * CONTRACTOR PAYMENTS (2026-08-14, founder — "paying someone for work when
 * there's nothing to reimburse and no invoice portal";
 * `specs/contractor-payments-pm-spec.md` §9 asks for exactly this). A new money
 * flow with new vocabulary, a new approval path and a new public-ledger rule,
 * so it is training-worthy on three of CLAUDE.md's counts at once. It ADDS a
 * course and two sections, and corrects one sentence in two existing lessons:
 *
 *  - NEW COURSE `finance-paying-contractors` (Finances stream), placed after
 *    the shared `chapter-money-model` and before `treasurer`. `audience:
 *    "team"` for the same reason that course carries it: it is not one seat's
 *    remit — the Treasurer, the central Financial Manager and the ED all work
 *    the same queue, and the whole point of the separation-of-duties rule
 *    below is that two of them are involved in every payment. NOT given to
 *    `chapter_director`: that seat derives finance VIEWER, so it can read the
 *    queue but can neither compose an agreement nor approve one
 *    (`lib/contractorPaymentsAccess.ts`).
 *  - NEW SECTION `finance-paying-a-contractor` (5 min, 5-quiz), inserted
 *    directly after `finance-reimbursements-and-flags` because the single most
 *    likely error in this whole feature is confusing the two, and the fix is
 *    to teach them back to back. It carries the distinction (money already
 *    spent + receipt + not income vs. work bought + AGREEMENT + reportable
 *    income), the two entry points into one queue, the uncoded self-serve
 *    refusal, the three-signal SoD check that runs twice, and the rule that
 *    editing agreed terms voids the contractor's acceptance.
 *  - NEW SECTION `finance-contractor-tax-and-privacy` (4 min, 5-quiz), the
 *    second module of that course: the W-9/W-8 file (never a typed TIN), the
 *    logged-every-view access rule, the four-year destruction window, the W-8
 *    approval block, what the public ledger does and does not say
 *    (`CONTRACTOR_LEDGER_COUNTERPARTY` — the description, amount, date and
 *    category publish; the NAME never does), that the description publishes
 *    verbatim and permanently, and that raw bank digits are never stored.
 *  - `finance-reimbursements-and-flags` OPENED with "Two situations, two
 *    flows." There are three now, so that sentence was false the day this
 *    shipped: it now names the third and points at the new course. Nothing
 *    else in that lesson changed — its quiz is at the 5-question cap and no
 *    question became wrong, since none of them ever claimed reimbursement was
 *    the only way money leaves for a person.
 *  - `finance-publishing-the-books`'s "No names, ever" bullet gained the
 *    contractor case, which is the one place a reader could have concluded the
 *    rule was only about givers and meal attendees. Content-only; that quiz is
 *    at the cap too and none of its answers moved.
 *
 * NOT taught, deliberately: the `manual` payout fallback (an unwired Increase
 * account degrades to a payout the treasurer completes by hand) and the
 * idempotency/replay guards. Both are the same machinery the reimbursement
 * rail already runs, neither changes what a person should DO, and the lesson
 * budget went to the distinction and the tax form instead.
 *
 * PAYMENT RECEIPT ON PAYING A PERSONAL CHARGE BACK (2026-08-14, founder: "when
 * people pay what they owe, we need to make sure we send them an email
 * saying, like, hey, thanks for paying this off. This is your receipt …
 * just in case they need a receipt for showing that they did the payment").
 * `finance-reimbursements-and-flags` already enumerated every email the "you
 * owe Public Worship" side sends — the flag notice, the reminder — and was
 * silently missing the one that closes the loop: settling the debt now mails
 * a receipt naming the total, the settle date, and one line per charge, with
 * Stripe's own hosted receipt linked in when the payment ran through Stripe
 * (a bank debit through the org's own Increase account has no Stripe charge
 * behind it, and the email is still a complete, standalone receipt either
 * way). ONE bullet added, content-only, minutes unchanged.
 *
 * ONE QUIZ QUESTION SWAPPED, at the 5-question cap
 * `apps/convex/tests/academy.test.ts` enforces. OUT: "your chapter's
 * Treasurer submits their own reimbursement — who approves it", whose
 * doctrine (approver ≠ requester is identity-based, not role-based) is
 * taught and quizzed in full in `finance-raise-vs-manage`'s "Separation of
 * duties is identity-based, not a courtesy" section — losing it here loses
 * no coverage. IN: paying back several flagged charges in one
 * bundled payment gets ONE receipt itemizing all of them, never one per
 * charge, with the Stripe-link/no-Stripe-link distinction spelled out in the
 * explanation.
 *
 * MANUAL "SEND RECEIPT", AND ITS ONE LIMIT (2026-08-14, founder: "add an email
 * button for already paid repayments … say they forgot it, or they just need
 * it resent, or it's in the past"). The lesson bullet added above gained the
 * manager-side half: a settled row on the personal-charges desk can be mailed
 * its receipt on demand, however old, and says on the row whether one was ever
 * delivered. The bullet and its quiz explanation originally claimed the button
 * "never expires or locks after one use" — a 60-second cooldown and an
 * in-flight lock landed later in the same branch to stop a runaway loop and a
 * double-send race, so both were corrected to say it still works on demand
 * across any gap but refuses a back-to-back double-press.
 *
 * ── 2026-08-14 · ONE CATEGORY LIST FOR THE WHOLE ORG ───────────────────────
 * Owner: "the category should be the same across all chapters — unwire the
 * category scope to a specific chapter." `budgetCategories` stopped being
 * chapter-scoped; `funds` did not, and the difference is the lesson: a fund is
 * a chapter-owned pot of restricted money, a category is a word for what kind
 * of spend something was.
 *
 * ONE SECTION MOVED, `finance-cross-chapter-audit`, because it is the only
 * place the old scoping was taught as a RULE rather than assumed. Its "Whose
 * card paid ≠ whose budget it counts against" block instructed an FM to give a
 * cross-book row the receiving chapter's category "in the same pass — it's the
 * only chance anyone gets", because the charge lives in Central's book and that
 * chapter's Treasurer can't edit it. That was true, and it described a HOLE:
 * with no central category list, cross-book spend that missed its one chance
 * sat in an "Uncategorized" bar that neither person could ever close. The
 * paragraph now teaches one org list and the surviving asymmetry, and still
 * says to code it on the spot — not because it's the last chance, but because
 * you are the person who knows what it was for.
 *
 * ONE QUIZ QUESTION SWAPPED, never grown (the 5-question cap
 * `apps/convex/tests/academy.test.ts` enforces). IN: whose categories a charge
 * on a Central card picks from — the one fact a reader could get wrong from
 * memory of the old rule, with funds named as the deliberate opposite. OUT:
 * "what's the FM's actual relationship to a chapter's spending", whose answer
 * the "Trust, not permission" rule two blocks above states verbatim; its
 * content is carried in the new question's explanation, so nothing is lost.
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
    minutes: 2,
    blocks: [
      {
        kind: "p",
        text: "Three questions, in order. Which budget does this come out of? Is there room in it? Then, and only then, which track are you on? The first two are facts you can look up in the app. The third is the judgment those facts feed.",
      },
      {
        kind: "table",
        headers: ["Track", "What it means"],
        rows: [
          ["Green", "An approved budget, with room in it. Spend — then tell the budget's owner."],
          ["Yellow", "No budget, or no room left. Get a yes BEFORE you spend."],
          ["Red", "Spending the org shouldn't be making at all. No budget makes it green."],
        ],
      },
      {
        kind: "rule",
        title: "Yellow means before, not after",
        text: "Asking afterwards isn't asking. It hands someone a decision that has already been made. That forces them either to rubber-stamp it or to make you pay for it.",
      },
      {
        kind: "rule",
        title: "Red is a kind of spending, not a size",
        text: "A large purchase with an approved budget is green. An unbudgeted one is yellow and needs a yes. Red is spending the org shouldn't make at all — which is why no budget and no approval turns it green.",
      },
      {
        kind: "rule",
        title: "Green still needs a heads-up",
        text: "Green doesn't need permission; that is what an approved budget means. It does need a word to the budget's owner. They are the only person tracking everything else still to come out of that budget, and a purchase that arrives silently is one they can't plan around.",
      },
      {
        kind: "reveal",
        prompt:
          "You put a red purchase on the card anyway, and you kept the receipt. What happens to it?",
        answer:
          "It comes back to you as a personal charge, recorded under your name and repaid out of your own pocket. The receipt doesn't help. Proving you made the purchase was never the question.",
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
        text: "The wrong fix is to quietly mark the charge Closed and move on. A published ledger can't tell that row from a properly documented one — and neither can we, six months later. So the app refuses it: **you can't close a charge that has neither a receipt nor an approved exception.** It refuses earlier than that, too — you can't even submit the charge's coding without one or the other. Why there's no receipt is part of the record, not a follow-up to it.\n\nThe right fix is to say, on the record, what the money was for and why no receipt exists. That's a **receipt exception**. It isn't an absence — it's a substitute document with a name attached to it.",
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
        text: "**Treasurers:** your side of this is the decision. Read the note before approving — an exception you wave through becomes the org's public answer for that money. Rejecting is fine and often right; say what would make it approvable, and the charge goes back to owing a receipt. In Reconcile, the honest backlog is two filters, not one: **Needs documentation** (still open, still owing a receipt or an approved exception — somebody to nudge) and **Closed without documentation** (marked Closed with neither one behind it — nobody to nudge, and the pile that gets forgotten because it already looks finished). They're disjoint, they're in the same filter group, so picking both shows you the union — and that union is what has to reach zero before a period can be published.",
      },
    ],
    quiz: [
      {
        prompt:
          "You tipped a sound engineer $40 in cash. No receipt exists and never will. What's the right move?",
        options: [
          "Mark the charge Closed and move on",
          "File a receipt exception — pick the reason, say what it was for, and let a manager approve it",
          "Nothing; small cash amounts are exempt",
          "Ask the venue to write you a receipt for it later",
        ],
        answerIndex: 1,
        explanation:
          "An exception is the documented substitute for a receipt, not a shrug. Marking it Closed with nothing attached is exactly what the app refuses — a published ledger can't tell that row from a documented one.",
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
  // `finance-reconcile-grid` ("Closed means coded, too"); this is the
  // spender's half. See `docs/plans/transaction-coding.md`.
  {
    slug: "finance-coding-your-charges",
    title: "Coding your charges",
    subtitle: "What it was, why it served the work, and who was there",
    minutes: 2,
    blocks: [
      {
        kind: "p",
        text: "A coding is the reason for a charge, written by the person who made it. \"Bus to NY\" is what the bank already told us. \"Travel to NY to film the Eden event\" is a reason. Travel adds a route — city level is enough — because where the money went is part of what the record has to say.",
      },
      {
        kind: "rule",
        title: "Purpose and proof are one record",
        text: "What the money was for and how it can be proved travel together, so a coding won't submit on a charge with neither a receipt nor an exception. The exception lives in the same sheet, and FILING one is enough to submit. Approving it is somebody else's work, and waiting on them would strand the charge in your queue. It does still have to be approved before the charge can close.",
      },
      {
        kind: "rule",
        title: "Names never publish",
        text: "A meal asks who was there — every name, up to 15 people; above that a headcount and an identifiable group. None of those names reach the public ledger. Volunteers, community members and guests never consented to a public financial record, and some are minors. So the ledger prints the shape of the room: \"5 volunteers, 3 community members, 2 contractors\".",
      },
      {
        kind: "rule",
        title: "Sixty days, then it is wages",
        text: "The 60-day safe harbor is the accountable plan's substantiation window. Past it, unsubstantiated spending is legally wages to the spender. Converting it into a repayment you can settle is the kinder of those two endings — and coding it in week one avoids both.",
      },
      {
        kind: "reveal",
        prompt:
          "You code a Transportation charge and the sheet asks where you travelled from and to. Did the category answer anything for you?",
        answer:
          "No. A category picks the QUESTION SET — that is why Transportation lands on travel's route questions without a second decision — but it never answers one. The purpose, the route, who was there all stay blank until you type them, and you can correct the branch if the category guessed wrong.",
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
    minutes: 2,
    blocks: [
      {
        kind: "p",
        text: "Two situations. You paid out of pocket for mission work — submit a **reimbursement request**. A personal charge hit your card — **flag it**, which starts you owing money back. Paying someone for WORK is neither: that is a contractor payment, with its own lesson.",
      },
      {
        kind: "bullets",
        items: [
          "**Submitting.** Every line carries its own receipt, date and coding. None of it is optional — the app blocks submission until each line is complete. Bank details are captured up front, so approval fires the payout automatically.",
          "**Approved is not paid.** The email names the decision and the amount, never that the money moved. A reviewer can approve some lines and not others; where the figures differ it names both — and the smaller one is the whole payment, not a first instalment.",
          "**A second email goes when the money actually leaves**, naming the date. That is the one to wait for. If nothing lands within a week, ask your Treasurer.",
        ],
      },
      {
        kind: "rule",
        title: "Sent back is a revision, not a rejection",
        text: "Rejected is terminal. **Sent back** is a loop: fix the line and resubmit, keeping your original submission date, so a question never costs your place in the queue. A revision may change the SUBSTANTIATION only — a wrong amount is a reject and a fresh request.",
      },
      {
        kind: "rule",
        title: "Flagging says YOU made the charge",
        text: "You can flag your own transactions, not just managers — catching your own mistake early is the fastest way to clear it. The flag is separate from the charge's status: a row can be Closed AND an unpaid personal expense at once. So a charge you genuinely don't recognize is not a flag. Freeze the card yourself, then tell your Treasurer.",
      },
      {
        kind: "reveal",
        prompt:
          "Someone repaid a personal charge months ago, before the receipt button existed, and now needs proof they paid. What can a manager do?",
        answer:
          "Send the receipt again. A settled row's button never expires after one use. It is the same receipt email, not a new record — which is what makes it work for a debt settled long before the button existed. Pressing it twice is refused rather than mailing the payer twice.",
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
          "Flagging is available on your OWN transactions, not just to managers — catching your own mistake early is the fastest way to clear it. The flag is separate from the charge's status too: it can be fully Closed AND an unpaid personal expense at the same time — flagging doesn't touch its category, budget, or receipt. And the mirror rule: flagging says YOU made the charge, so a charge you genuinely don't recognize is not a flag — freeze the card yourself (instant, self-serve, reversible), then tell your Treasurer or the Financial Manager right away so it gets investigated.",
      },
      {
        prompt:
          "Someone repaid a personal charge months ago, before this org even had the receipt button, and now needs proof they paid. What can a manager do?",
        options: [
          "Nothing — the receipt only ever goes out at the moment of payment",
          "Mark the charge repaid again to trigger a fresh email",
          "Open it on the Personal charges screen and press Send receipt — every settled row keeps that button, no matter how old",
          "Ask the payer to screenshot their bank statement instead, since the app can't help",
        ],
        answerIndex: 2,
        explanation:
          "A settled row's receipt button never expires after one use — a manager can send it again whenever it's genuinely needed, days or months later, which is exactly what makes it useful for a debt settled long before the button existed. It's a manual door to the SAME receipt email the automatic send uses, not a new record; there is still no way to \"mark repaid\" a charge that hasn't actually been paid through the app. The one limit is a brief one: pressing it twice back-to-back is refused with a clear \"try again in a moment\" rather than mailing the payer twice.",
      },
      {
        prompt:
          "An email lands saying your $240 reimbursement was approved. What does that actually mean about your money?",
        options: [
          "It's been sent — approved and paid are the same event, so it's already left the account",
          "It's approved but not yet paid: sending the payout is the next step, and the request moves to Paid when the money settles",
          "Nothing yet — approval emails go out before anyone has really reviewed it",
          "It means the full amount you submitted was approved, since partial approvals aren't possible",
        ],
        answerIndex: 1,
        explanation:
          "Approved and paid are separate states, and the email is careful never to claim otherwise — it tells you the decision, not that the money has moved. Read the figure too: a reviewer can approve some of your lines and not others, and when the approved amount differs from what you submitted the email names both — and that smaller figure is the whole payment, not a first instalment. You get a SECOND email when the payout actually goes, naming the date it left; that one is your cue to look for the money. If it still doesn't arrive, contact your Treasurer.",
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

  // ── 36 · Paying contractors: the agreement ─────────────────────────────────
  // Sits directly after the reimbursement lesson on purpose: the error this
  // whole course exists to prevent is filing one as the other, and the two are
  // taught back to back so the distinction is impossible to miss.
  {
    slug: "finance-paying-a-contractor",
    title: "Paying a contractor",
    subtitle: "Buying work is not giving money back",
    minutes: 2,
    blocks: [
      {
        kind: "p",
        text: "A reimbursement gives back money someone ALREADY SPENT: the receipt substantiates it, and it is not income. A contractor payment buys WORK. Nothing was spent, so the AGREEMENT substantiates it, and the money IS reportable income — which is why a tax form is collected first. \"They have no receipt for their time\" is not a receipt problem. It means you are in the wrong flow.",
      },
      {
        kind: "rule",
        title: "A self-serve request arrives uncoded",
        text: "Both entry points share one queue and one route from Needs review on. The difference is that a request the contractor raised carries no coding. What the requester says the money is for starts that conversation; it is not evidence for it. The server refuses to release money until somebody with the books in front of them says which budget pays.",
      },
      {
        kind: "rule",
        title: "You cannot approve your own agreement",
        text: "Rank isn't the control here; separation of duties is. Three signals get checked: are you the payee on the roster, is your sign-in email the payee's, and did you write this agreement. The third stops whoever set the amount from also releasing the money. The check runs again when the payout goes, because approving and paying can be two different acts.",
      },
      {
        kind: "rule",
        title: "Changing an agreed term voids the acceptance",
        text: "Amount, description and service date are the terms the contractor said yes to. Change one and the acceptance is voided: the payment reverts to **Awaiting contractor** and he is asked to accept again. Nothing is payable in between. Coding is different — he never agreed to which budget line pays him, so re-coding voids nothing.",
      },
      {
        kind: "reveal",
        prompt:
          "A $4,000 agreement pays $2,000 on signing and $2,000 on delivery. The deposit goes out. What state is the agreement in?",
        answer:
          "Approved, not Paid. Paid is an ENDING: nothing more happens to an agreement that reaches it. So a deposit must not stamp it, or the balance would be stranded and the contractor owed money the app no longer thinks it owes. It closes only once the whole schedule is settled.",
      },
    ],
    quiz: [
      {
        prompt:
          "A volunteer spent $80 of her own money on cups. A photographer spent six hours shooting the same event for an agreed $600. Which is which?",
        options: [
          "Both are reimbursements — money leaving for a person is a reimbursement either way",
          "The cups are a reimbursement (money already spent, substantiated by the receipt, not income); the photographer is a contractor payment (work bought, substantiated by the agreement, and reportable income)",
          "Both are contractor payments, since both people did something for the event",
          "The photographer is a reimbursement for her time; the cups need a contractor agreement because a purchase is a service",
        ],
        answerIndex: 1,
        explanation:
          "This is the distinction everything else hangs on. A reimbursement gives back money someone ALREADY SPENT — the receipt substantiates it and it is not income. A contractor payment buys WORK — nothing was spent, so the AGREEMENT substantiates it, and the money IS reportable income, which is why a tax form is collected first. \"They have no receipt for their time\" is not a receipt problem; it means you're in the wrong flow.",
      },
      {
        prompt:
          "A blank request lands in the queue: $450, \"sound engineering for the March night.\" The terms look right and the person is real. Why can't you approve it yet?",
        options: [
          "It arrived uncoded — nobody has said which budget, event or project pays for it, and approval is refused until a human does",
          "Blank requests always need a second approver before the first one",
          "You can approve it; blank requests are approved exactly like pre-filled ones",
          "It has to be re-entered as a pre-filled agreement before it can be approved",
        ],
        answerIndex: 0,
        explanation:
          "Both entry points share one queue and one route from Needs review on — the difference is that a self-serve request arrives UNCODED. What the requester says the money is for is the start of that conversation, not evidence for it, so the server refuses to release money until somebody with the books in front of them says which budget it belongs to.",
      },
      {
        prompt:
          "You're the chapter Treasurer. You pre-filled an agreement for a designer, sent the link, and she's accepted. Who approves it?",
        options: [
          "You do — you hold the seat that approves chapter payments",
          "Anyone with a finance manager seat, including you, since you're not the payee",
          "Someone other than you — the person who wrote the agreement can't approve it, so in practice the central Financial Manager does",
          "The Chapter Director, because chapter money is theirs to sign off on",
        ],
        answerIndex: 2,
        explanation:
          "Rank isn't the control here; separation of duties is. Three signals are checked — are you the payee on the roster, is your sign-in email the payee's, and did you write this agreement — and the third is what stops the person who set the amount from also releasing the money. The check runs again at the moment the payout goes, because approving and paying can be two different acts.",
      },
      {
        prompt:
          "A contractor accepted a $900 agreement. Which of these edits sends it back to him for a fresh signature?",
        options: [
          "Moving it from the Events budget to the Media budget",
          "Fixing a typo in your internal note about who introduced him",
          "Changing the amount to $950, or rewording the description of the work, or moving the service date",
          "None — once accepted, nothing on the record can be changed by anyone",
        ],
        answerIndex: 2,
        explanation:
          "Amount, description and service date are the AGREED terms — the things he actually said yes to. Change one and his acceptance is voided, the payment reverts to Awaiting contractor, and he's asked to accept again; nothing is payable in between. Coding is a different matter: he never agreed to which budget line pays him, so re-coding voids nothing.",
      },
      {
        prompt:
          "A $4,000 agreement is set up to pay $2,000 on signing and $2,000 on delivery. The deposit goes out. What is the state of the agreement?",
        options: [
          "Paid — money has gone out under it, so the agreement is complete",
          "Still approved and still owing $2,000; it only reaches Paid when every scheduled payment has been sent or cancelled",
          "Awaiting contractor, because the second payment needs a fresh signature",
          "Split into two agreements at the moment the first one paid",
        ],
        answerIndex: 1,
        explanation:
          "Paid is an ENDING — nothing more happens to an agreement that reaches it. So a deposit landing must not stamp it, or the balance would be stranded with nothing able to pay it and the contractor would be owed $2,000 that the app no longer thinks it owes. The agreement drops back to Approved between payments, which is exactly the state the next one is released from, and closes only when the whole schedule has been settled one way or the other.",
      },
    ],
  },

  // ── 37 · Paying contractors: the W-9 and the public row ────────────────────
  {
    slug: "finance-contractor-tax-and-privacy",
    title: "The W-9, and what publishes",
    subtitle: "The most sensitive file we hold, and the one line the world reads",
    minutes: 2,
    blocks: [
      {
        kind: "p",
        text: "A contractor payment is income to the person receiving it, so we collect a tax form before we pay. A **W-9** from a US person or business. A **W-8BEN** from a foreign individual, a **W-8BEN-E** from a foreign entity.",
      },
      {
        kind: "rule",
        title: "The work publishes; the person does not",
        text: "A reader can audit what the money bought. The counterparty is the fixed words \"Contractor payment\" — the name, email, tax form and bank details are never published in any form. This runs opposite to a reimbursement, which publishes as \"Reimbursement to <name>\": that is a member being made whole, this is someone's income.",
      },
      {
        kind: "rule",
        title: "The description publishes verbatim, and forever",
        text: "It is the one field that publishes word for word. A published month is frozen and can only be amended in public. The checker refuses emails, phone numbers, street addresses and long digit runs wherever the text is typed. It is deliberately crude: it stops the accidental paste, not a determined one.",
      },
      {
        kind: "rule",
        title: "Every look at a W-9 is logged",
        text: "The gate is a role, not a named individual, so the log is what makes the access answerable: who looked, at whose form, when. The form is destroyed four years after the LAST payment it covers. No tax ID is ever typed into a field — the form is a file, and nothing parses it.",
      },
      {
        kind: "rule",
        title: "We don't hold the bank digits",
        text: "Raw account numbers are never persisted. They are validated, handed to the bank once, and what comes back is a reference and the last four. So \"we can't tell you, we don't have it\" is the true answer, and it is the point rather than a limitation.",
      },
      {
        kind: "reveal",
        prompt:
          "A foreign contractor fills in a W-9 by mistake. Why does the flow refuse to pay rather than just proceed?",
        answer:
          "Withholding isn't something a form field can decide. A W-9 is for US persons and entities; a foreign payee needs a W-8BEN or a W-8BEN-E. Paying at zero withholding and finding out at tax time is the worse ending, so the app declines to guess.",
      },
    ],
    quiz: [
      {
        prompt:
          "A $1,800 contractor payment to Jane Doe Media settles and the month is published. What does a stranger reading publicworship.life see?",
        options: [
          "\"Jane Doe Media — $1,800\", with the work described beside it",
          "Nothing — contractor payments are held back from the public ledger",
          "The description of the work, the amount, the date and the category — with the counterparty shown as \"Contractor payment\", never her name",
          "A single line saying the chapter spent $1,800 on contractors that month",
        ],
        answerIndex: 2,
        explanation:
          "The work publishes so a reader can audit what the money bought; the person doesn't. The counterparty is the fixed words \"Contractor payment\", and her name, email, tax form and bank details are never published in any form. Note this runs the opposite way from a reimbursement, which publishes as \"Reimbursement to <name>\" — that's a member being made whole, this is someone's income.",
      },
      {
        prompt:
          "You're writing the service description on an agreement and you type: \"Photography for the June night — reach Ade at 555-0142.\" What happens?",
        options: [
          "It's accepted; the phone number is only visible internally",
          "It's refused — the same check runs on the contractor's page, the staff form and the server, and a phone number is one of the shapes it recognizes",
          "It's accepted, and a treasurer strips the number automatically before publishing",
          "It's accepted but the whole description is withheld from the public ledger",
        ],
        answerIndex: 1,
        explanation:
          "The description is the one field that publishes VERBATIM and permanently — a published month is frozen and can only be amended in public. The checker refuses emails, phone numbers, street addresses and long digit runs wherever the text is typed. It's deliberately crude: it stops the accidental paste, not a determined one, so reading the sentence as a stranger would is still yours to do.",
      },
      {
        prompt: "Who can open a contractor's actual W-9 file, and what happens when they do?",
        options: [
          "Anyone on the chapter roster; opening it is an ordinary read",
          "Finance managers and treasurers — and every single view is written to the audit trail before the file opens",
          "Only the Executive Director, and views aren't logged because the seat is trusted",
          "Nobody — the form is write-only once uploaded",
        ],
        answerIndex: 1,
        explanation:
          "The gate is a role, not a named individual, so the log is what makes the access answerable after the fact: who looked, at whose form, when. The form itself is destroyed four years after the LAST payment it covers — an SSN we no longer hold is an SSN that can't leak — and no tax ID is ever typed into a field in the first place; the form is a file and nothing parses it.",
      },
      {
        prompt:
          "A contractor calls: \"Can you read me back the account number you have for me? I think I fat-fingered it.\" What can you tell her?",
        options: [
          "The full account number, from the payment record",
          "Only the last four digits — the full routing and account numbers went straight to the bank and were never stored here",
          "Nothing at all; bank details can't be discussed",
          "The number, but only after a finance manager approves the request",
        ],
        answerIndex: 1,
        explanation:
          "Raw bank digits are never persisted. They're validated, handed to the bank once, and what comes back is a reference and the last four — so \"we can't tell you, we don't have it\" is the true answer, and it's the point rather than a limitation. If the account is wrong, she re-enters it; nobody here is reading it back to her.",
      },
      {
        prompt:
          "A contractor uploads a W-8BEN rather than a W-9. What does that change about approving the payment?",
        options: [
          "Nothing — it's just a different form for the same thing",
          "It blocks approval: a W-8 means the payee isn't a US person, and foreign payments can carry withholding this system doesn't compute, so a human handles it off-platform",
          "It speeds it up, since foreign payments have no tax reporting",
          "It means no tax form is needed at all and the upload can be skipped",
        ],
        answerIndex: 1,
        explanation:
          "A W-9 is for US persons and entities; a W-8BEN (individual) or W-8BEN-E (entity) says the payee is foreign. Withholding isn't something a form field can decide, so the flow refuses rather than paying at zero withholding and discovering the problem at tax time. The payment isn't wrong and neither is the contractor — it's a case the app declines to guess at.",
      },
    ],
  },

  // ── 34 · Treasurer: the Book ───────────────────────────────────────────────
  {
    slug: "finance-reconcile-grid",
    title: "Running Reconcile",
    subtitle: "Your home screen: code every charge, explicitly",
    minutes: 2,
    blocks: [
      {
        kind: "p",
        text: "The Book is the Treasurer's home: every chapter charge as a row, with Category, Budget, receipts and a \"What it was for\" sentence editable inline. Nothing here is guessed. A charge counts against a budget only when you link it — there is no automatic matching.",
      },
      {
        kind: "table",
        headers: ["Filter", "What it catches"],
        rows: [
          ["Needs budget", "Open and categorized, still not linked to a budget. Fees are absent on purpose: a fee is charged, not chosen."],
          ["Owes a receipt or coding", "The chase. Everything anyone still owes you — a receipt, a coding, or an answer to one you sent back."],
          ["Needs explaining", "Every row that will publish with a blank where its explanation should be."],
          ["Coding review", "A submitted coding waiting on you to approve it or send it back."],
          ["Personal (unpaid)", "Flagged personal, not yet repaid. These cannot be closed until the money is back."],
          ["Closed", "Already cleared — where every other row is trying to get to."],
        ],
      },
      {
        kind: "rule",
        title: "Unattributed is loud on purpose",
        text: "A charge with no budget link is never absorbed into whichever budget looks closest. It shows on the dashboard as **Unattributed**, in plain sight, with one tap back into this exact filtered view. Loud and wrong beats quiet and wrong.",
      },
      {
        kind: "rule",
        title: "Group by is how you get everywhere else",
        text: "**Group by: Month or Person** bands the rows. It filters nothing. A month band carries Preview and Publish. A person band carries Chase — put **State → Owes a receipt or coding** on top of it and that is your chase list, one cardholder per band.",
      },
      {
        kind: "rule",
        title: "Publish means the month, never your filter",
        text: "With a filter on, a month band names both figures: \"12 of 318 charges · -$4,102 of -$88,201\". The first is what your filter left. The second is the month. **Publish always acts on the second.**",
      },
      {
        kind: "rule",
        title: "Explain writes one true sentence many times",
        text: "Select rows, press **Explain**, type one sentence. Each charge gets its OWN coding, under your name, with its own audit entry — nothing is written in aggregate. Rows that can't take it are refused one at a time and listed back by name, still selected. Meals are never offered in bulk: a meal's proof is who was there, and that differs every time.",
      },
      {
        kind: "rule",
        title: "Undo is not Send back",
        text: "Approving publishes, so you get about ten seconds to take it back. **Undo** returns the coding to awaiting review — your queue, nobody told. **Send back** means the author has something to fix: it moves the row to their queue and emails your note. You can undo only your own approval, and only for a couple of minutes.",
      },
      {
        kind: "try_status",
        title: "One charge, coded",
        options: [
          { value: "unreviewed", label: "Unreviewed", color: "gray" },
          { value: "categorized", label: "Categorized", color: "amber" },
          { value: "reconciled", label: "Closed", color: "green" },
        ],
        terminal: "reconciled",
        caption:
          "Excluded is the fourth status, for a row that should never count at all — a duplicate, a bank error. It requires a reason. Don't reach for it on a transfer or a payout; those have their own markings.",
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
        prompt:
          "You approve a coding, then immediately realise the sentence names someone it shouldn't. The Undo is still on screen. What does pressing it do?",
        options: [
          "Hides the approval locally — the record stays approved",
          "Puts the coding back to awaiting review, in your queue, and tells nobody",
          "Sends it back to its author with a note, exactly as Send back would",
          "Nothing — an approved coding is permanent",
        ],
        answerIndex: 1,
        explanation:
          "Undo says the APPROVER mis-tapped, so it returns the coding to exactly where it was \u2014 awaiting review \u2014 and notifies nobody, because the author never saw the approval. That is why it is not Send back: Send back means the AUTHOR has something to fix, moves the row into their queue, and emails them your note. Undo is also limited server-side to your OWN approval and to a couple of minutes; past that, Send back is the honest path, since an approval that has stood a while may already have been acted on.",
      },
      {
        prompt:
          "You're grouped by Month with a State filter on, and March's band reads \"12 of 318 charges · -$4,102 of -$88,201\". You press Publish on that band. What goes public?",
        options: [
          "The 12 charges the filter left, totalling -$4,102",
          "All 318 charges in March, totalling -$88,201 — publishing is about the month, never about your filter",
          "Nothing — you can't publish while a filter is on",
          "Whichever rows are currently loaded on the page",
        ],
        answerIndex: 1,
        explanation:
          "That is exactly why the band names both figures. Publishing acts on the whole month, so a band that could only say \"12 charges\" next to a Publish button was quietly describing something other than what the button did. The second number in each pair is the month; the first is just what you happen to be looking at. (Publish opens the publish console's own flow right there over the grid, and nothing about it is shortened by being opened from a band — a second approver, an amendment reason on a re-publish, and a refusal if the month's snapshot came back incomplete.)",
      },
      {
        prompt:
          "You select 40 subway fares that all ran the same route and press Explain, typing one sentence. What happens?",
        options: [
          "The app drafts a purpose for each charge based on the merchant",
          "Each charge gets its own coding carrying your sentence, under your name — and any that can't take it (no receipt yet, already approved) are refused one by one and listed back to you",
          "One shared explanation is attached to all 40 rows at once",
          "The 40 are marked closed without a coding",
        ],
        answerIndex: 1,
        explanation:
          "Writing a true sentence once instead of forty times is still your testimony — nothing is composed for you, and nothing is waived in aggregate. It's per-row underneath: one coding, one author, one audit entry each. And it never claims more than it did: rows that can't take the explanation come back named, still selected, so what you still owe is in front of you. Meals aren't offered in bulk at all — a meal's proof is who was at it, and that's different every time.",
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
        text: "When Givebutter or Stripe pays out, that deposit is donation and ticket money you've ALREADY earned — the gifts live in the donor records, and that's where the org counts its revenue (the Accounts page's book value = everything earned — donations, ticket sales, in-person sales and course registrations — minus spend). So \"Mark as payout\" tells the books this bank credit is the arrival of already-counted revenue: it keeps the deposit honest and stops the same dollars being counted twice. Never mark a payout as a transfer — a transfer is money between two of OUR accounts, and this money came from outside.\n\nA marked payout also stops pretending to have a merchant. Bank feeds hand us whoever ORIGINATED the deposit, and for a Stripe payout that string can be the name of the person whose account sent it — which is a true record of the statement and a nonsense answer to \"who did we buy this from\" (\"I know I'm the one that initiated the payout, but come on, that can't mean I'm the merchant\"). Once marked, the row reads **Stripe payout** or **Givebutter payout**. The bank's original string isn't lost — it's what the rename editor shows you and what the name history keeps — it just stops being the headline. And if you rename a payout row yourself, your name still wins; this only replaces the one nobody chose.",
      },
      {
        kind: "rule",
        title: "Both markings are bank record only",
        text: "Neither a marked transfer nor a marked payout is chased for a receipt. Nobody bought anything on either one, so there is no receipt that could ever exist, and asking for one only parks the row in a backlog that can never clear — which is exactly what it was doing (\"nine rows not publishable, no documentation — and most of them are quite literally payouts\"). Both now read **Bank record only** in the Documentation column, which is what they are: the bank statement line is the evidence.\n\n**A transfer** is our own money moving between our own accounts, and both legs are already in the ledger. **A payout** is donation and ticket money you already counted at the donor and order records, arriving in one batch — and what substantiates it beyond the bank line is the processor's settlement report. For STRIPE we hold that ourselves: the payout id, the amount, the arrival date and each book's share, linked both ways to the bank row. For Givebutter and hand-marked \"other\" payouts we don't — there the record lives in the processor's own dashboard, so if you ever need to prove one out, that's where you go.\n\nThis is why marking is a decision, not a shortcut. It is the ONE thing in Reconcile that takes a row out of the documentation chase, so mark a row a transfer because it IS one — never because it's awkward. Every marking is logged with who did it and what changed, and any marking can be undone. You'll see what a row has been marked as in the **Marked** column on Transactions — \"Transfer\", or the processor's name — and the undo lives in that row's **⋯** menu (\"Un-mark internal transfer\" takes BOTH legs; a payout has no leg to pair with, so it un-marks alone).",
      },
      {
        kind: "rule",
        title: "Don't reach for Excluded",
        text: "Excluded is for a row that should never count at all — a duplicate, a bank error. Using it on a transfer hides the row instead of explaining it, and only ever fixes one of the two legs. Using it on a payout hides the settlement record your books need — and for a deposit nobody marked yet, it erases real income. Both now have a marking that keeps the row honest and visible, and neither marking costs you a receipt.",
      },
      {
        kind: "tip",
        text: "STRIPE payouts mark themselves. Every morning the reconciliation engine detects new Stripe payouts and labels the bank deposit as a payout for you — that part always happens, whether or not the org moves real cash. Separately, that SAME morning run measures the gap between each chapter's book value and what's actually in its bank account: with Real cash movement ON, it books and moves a transfer to close that gap; with it OFF, it only reports the gap on the Accounts page and books nothing — no ledger entry, no cash movement, until a Financial Manager turns it on. You'll see each payout on the Accounts page, badged with its own status (e.g. \"Deposit found & labelled\"), where the Financial Manager can audit it and mark it for review. Givebutter and other deposits still need the hand-marking this lesson teaches — and when you mark one, the modal also asks WHOSE money it is: pick the book it belongs to (some Givebutter payouts are central's, some are a chapter's) and the app books that transfer for you. Changing your mind later is an offsetting transfer, so pick deliberately.",
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
              "Excluding hides rather than explains — and on a transfer it only ever fixes one of the two legs, leaving the other stranded. Neither of these is chased for a receipt once marked, but both still need their marking: it's what tells the books the $5,000 moved rather than left, and that the $2,400 is settled, already-counted donation revenue rather than new income.",
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
        prompt: "You mark a pair of rows as an internal transfer. What does the Documentation column say about them afterwards?",
        options: [
          "Needs documentation, until you attach a bank statement to each leg",
          "Bank record only — a marked transfer owes nothing, and neither does a marked payout",
          "Only the outgoing leg still owes something",
          "Nothing at all — marked rows leave the grid",
        ],
        answerIndex: 1,
        explanation:
          "Nobody bought anything on either leg, so there is no receipt that could exist — the bank statement line IS the record, and the column says exactly that instead of nagging for an upload. It also means marking is the one move in Reconcile that takes a row out of the documentation chase, so mark a pair because it really is money between our own accounts, never because the row is awkward. Every marking is logged with who did it, and any of them can be undone.",
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
        text: "Most receipts show up before the reminders even matter. The chase is your actual worklist — a handful of stragglers each month, not the whole roster.\n\nIt is not a screen at all — it is two controls on Transactions. Set **State → Owes a receipt or coding** and **Group by → Person**, and there it is: one band per cardholder, biggest first, each showing their face, what they owe, and a **Chase** button in the band itself. Nothing to navigate back from, and you widen or narrow it exactly like anything else on that page.\n\nWhat you are asking for is the CODING, not the receipt. That is deliberate and it is why there is only one button: a coding cannot be submitted without a receipt or an approved exception behind it, so asking someone to code a charge already asks them to document it. Chasing the coding is strictly more than chasing the receipt, which is why the old Chase Receipts page is gone rather than sitting beside this.\n\nThe chase is rate-limited to one per cardholder per 24 hours, so a band you already chased today reads \"Chased today\" and is disabled rather than quietly doing nothing. **Chase everyone** in the page header does the whole list at once, and it only appears when you are looking at ONE book — a chase goes to one book's cardholders at a time, so pick Central or a chapter first.",
      },
      {
        kind: "p",
        text: "One thing that will look like a bug the first time you meet it: a receipt that arrives by email or text does NOT attach itself to a charge anymore. It lands in the Receipts library and waits to be offered to the cardholder as a match when they open that charge to code it — so a cardholder can have a dozen receipts in the library and a dozen charges still sitting in Needs documentation, with nothing broken. You can link one by hand from Receipts when it's obvious, and sometimes you should; but the tap you're really chasing is theirs, because they're the person who knows which charge it was. That's the whole reason we stopped letting the system guess: a receipt quietly attached to the wrong charge looks finished, which is worse than one that isn't attached at all.",
      },
      {
        kind: "p",
        text: "For that handful, you don't have to text them yourself anymore. Each cardholder's band carries a **Chase** button (and there's a **Chase everyone** in the header for the whole list) — one click emails them the list of what's outstanding with a link straight to their own charges, plus a text if they have a phone on file. The email says why we ask, in two sentences that are both true: spending we can't substantiate in time becomes taxable income to the person who spent it, and every dollar goes on our public ledger for donors to read. It's capped at once per cardholder per day, so mashing the button can't spam anyone; someone already chased today just reads \"Chased today\" instead of firing again.\n\n**THE CHASE ACTS ON THE VIEW YOU ARE STANDING IN.** Filter, search, or tick individual rows, and that is what gets asked for — ticked rows win over everything, because they are the narrowest thing on the screen. This is the whole point of doing it from the grid: when you know perfectly well that two of someone's five charges are yours to sort out and three are theirs, tick the three and chase those. Nothing narrowed means everything they owe, which is the sensible default.\n\nThree things to expect. Only a finance MANAGER sees the buttons at all — a bookkeeper has full run of the Book and not this. A chase goes to one book's cardholders at a time, so if you're looking at all books merged, pick Central or a chapter first; the page says so where the buttons would be, rather than quietly chasing a narrower list than you're looking at. And someone with no email address on file is reported back to you by name rather than skipped in silence — nothing was sent, and it is now your job to go find an address.",
      },
      {
        kind: "p",
        text: "Two filters, and they don't overlap — a row is in one or the other, never both. **Needs documentation** is still open and still owing a receipt or an approved exception. **Closed without documentation** is the tail behind it: rows somebody marked Closed with neither one behind them. The chase stopped there; the gap didn't.\n\n(A third, **Owes a receipt or coding**, sits beside them and is the one you actually chase from. It is WIDER than \"Needs documentation\" — it adds the charges owing a coding rather than a document — so it is not disjoint from anything and is not part of the arithmetic below. Use it to work the chase; use these two to count the publishing backlog.)\n\nThey're split because they need different hands. The first pile you nudge. The second nobody is going to send you a receipt for — you go back and document it, or you honestly re-open it, and it's the half that gets forgotten precisely because it already looks finished. **The publishing backlog is both of them together.** They sit in the same filter group, so selecting both widens rather than narrows, and that union is the number that has to reach zero before a period goes public — a public ledger can't tell a quietly-closed row from a documented one. (Approving the exceptions themselves is its own lesson.)",
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
          "Transactions, set to State \u2192 Owes a receipt or coding and grouped by Person \u2014 the handful of stragglers each month, not the whole roster",
          "A shared spreadsheet outside the app",
          "There isn't one; it's fully automatic",
        ],
        answerIndex: 1,
        explanation:
          "The reminder timeline handles the routine cases; that one State + Group by pairing is where you spend your actual attention. It isn't a separate screen \u2014 there is no Chase Receipts page and no menu entry for it, just those two controls, with each cardholder's Chase button sitting in their own band.",
      },
      {
        prompt:
          "Reconcile shows Needs documentation: 7 and Closed without documentation: 3. How many rows stand between you and publishing the period, and how do you see them?",
        options: [
          "3 — the 7 are still open, so they aren't a publishing problem yet",
          "7 — the 3 were closed, so somebody already settled them",
          "10 — the two filters are disjoint, so the publishing backlog is both; pick both and they widen, because they're in the same group",
          "7 — the 3 are inside the 7, so the bigger number is the real one",
        ],
        answerIndex: 2,
        explanation:
          "Neither pile can be published. The 7 are open and owe a receipt or an approved exception — you nudge those. The 3 were closed with nothing behind them — nobody is going to send you a receipt for those; you document them or honestly re-open them. No row is in both piles, so the backlog is the sum, and multi-select within the State group is how you look at it in one view. (The last option is the old shape: the two used to overlap almost entirely — 42 rows in common, 3 that weren't — which is exactly why they were split into halves that mean different jobs.)",
      },
      {
        prompt:
          "Priya has five open charges. Two are waiting on a decision from you, three are hers to code. You want to ask her for the three and only the three. What do you do?",
        options: [
          "Chase her — she'll work out which ones you meant",
          "Tick those three rows in the grid, then press Chase on her band — a selection wins over everything else, so those three are what gets asked for",
          "Wait until you've cleared your own two, then chase her",
          "Email her outside the app; the chase can only ever ask for everything",
        ],
        answerIndex: 1,
        explanation:
          "The chase acts on the view you are standing in — your filters, your search, and above all any rows you have ticked, which are the narrowest thing on the screen and therefore win. Chasing her for all five would ask for two she cannot do anything about, which is how a reminder teaches people it isn't worth reading carefully. Note the cap that makes this matter: one chase per cardholder per 24 hours, so the ask you send is the ask you get for the day — narrow it before you press, not after.",
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
          "**Everything closed:** every charge has a receipt, a category and a budget link, and has been marked Closed. The closed count in the Transactions header climbs toward the whole month.",
          "**Reimbursement queue triaged:** nothing sitting unreviewed that's actually yours to act on — the submission email is a nudge, not a substitute for actually clearing the queue.",
          "**Personal (unpaid) filter checked:** a personal flag doesn't block Ready — it's a flag, not a status. So it's easy to close a month while real debts sit uncollected. Check the pill directly and nudge anyone who still owes. When someone pays you back, confirm it on Cards → \"Personal to repay\" with \"Mark repaid\". Otherwise the debt stays open on the books, whatever landed in the account.",
          "**Report up:** the central Financial Manager should be able to open your chapter's numbers and trust them without a conversation. That trust is this system's north-star metric.",
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
    minutes: 2,
    blocks: [
      {
        kind: "p",
        text: "Publishing takes a month's books and freezes a copy. That copy is what the world sees. It is the property that stops an after-the-fact edit from silently rewriting what we already said — which is why fixing the ledger is only half of making a correction.",
      },
      {
        kind: "rule",
        title: "We publish gaps rather than around them",
        text: "A month with unexplained rows still publishes, with the blanks showing. Blocking would mean publishing nothing for a year. Hiding those rows, or letting them look documented, would be a claim we cannot back. The only thing refused outright is an incomplete ledger presented as complete.",
      },
      {
        kind: "rule",
        title: "Publishing is its own seat power",
        text: "It is separate from reconciling, because its audience is outside the org and a published number cannot be un-seen. The Executive Director and Financial Manager carry it centrally; a Chapter Director carries it for their own book. Notably not the Treasurer, who prepares it. It refuses a self-approval wherever you publish from.",
      },
      {
        kind: "rule",
        title: "A year is the months added up",
        text: "A year is never published on its own. It never estimates, and never fills in a month nobody closed. It states how many of the twelve it covers — so the way to make the year complete is to close the months.",
      },
      {
        kind: "rule",
        title: "Names are internal forever",
        text: "Members and guests never consented to a public financial record, and some are minors. The ledger publishes the headcount and the affiliation mix, which answer the accountability question without publishing a person.",
      },
      {
        kind: "reveal",
        prompt:
          "You spot a wrong figure in a month you published last week. You fix the transaction, and the ledger is now right. Are you done?",
        answer:
          "No. The published copy is frozen, so the world is still reading the old number. Correcting it means amending in public, with a reason. The fix and the disclosure are two halves of one act.",
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
          "Publishing is a separate seat power from reconciling, because its audience is outside the org and a published number can't be un-seen. The ED and Financial Manager carry it centrally; a Chapter Director carries it for their own chapter's book — notably not the Treasurer, who prepares it. This holds wherever you publish from: the flow that opens over a month band on Transactions is the console's own flow, so it refuses a self-approval in exactly the same words.",
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
        text: "The playbook splits money into three jobs, held by three different humans. The Chapter Director **raises** it from backers. The Treasurer **records** it in Reconcile — receipts, budgets. The central Financial Manager **oversees** it: audit, cross-chapter trust. As Chapter Director, your finance job is raising and approving — not bookkeeping.",
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
        text: "**How the 15% actually moves today:** by hand, on purpose. With one chapter and a small backer base, automating the transfer would be complexity the network doesn't need yet — so central's bookkeeper records it as a manual transfer (same ledger shape either way: a real `flow:\"transfer\"` pair, excluded from spend), with a note saying which month's commitment it honors. The 15% itself isn't optional or improvised — it's the number this lesson teaches, and the number donors are told publicly at **`/give/how-it-works`**, the page that carries the whole money model — only the RECORDING is manual for now.",
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
        text: "Every charge carries **two** facts, and they're different questions. **Paid from** is whose card or account the money actually left — that's what reconciles against a bank statement, and coding a charge never changes it. **Charged to** is whose budget it counts against — that's what a budget's spent-vs-left is measuring. Usually they match. When they don't, one book fronted money for another: a Public Worship card buying something for New York is *paid from Central, charged to New York*. Reconcile flags that row so you see it as you code it, the charge counts against New York's budget (not Central's), and the app works out what's owed — no spreadsheet, no accrual to remember. Settle it whenever you like from the central dashboard's **Inter-chapter balances**; the balance is recomputed live from the ledger, so a miscode you fix simply disappears from it.\n\nDon't reach for **Fix who paid** for this. That button rewrites which account the money left — it's for correcting a charge that landed in the wrong book, not for deciding whose budget carries the cost. Use it on the venue deposit and you'd be claiming New York's account paid, which its bank statement would flatly contradict, and the amount Central is owed would vanish with it.\n\nGive that row a **category** too, in the same pass. There is ONE category list for the whole org — Supplies is Supplies whether Central or New York paid — so every charge in every book takes one, and the picker offers you the same labels wherever you are standing. It used to be different, and the difference was a hole: categories belonged to a chapter, a Central charge had none to pick from, and cross-book spend sat in an \"Uncategorized\" bar on the receiving chapter's budget that literally nobody could close. That's gone. Still do it while you're on the row, though — you're the person who knows what it was for. (Fund is the one thing that stays Central's business. A fund records whose *restricted* money paid, and Central's card didn't draw on New York's — funds are chapter-owned money, categories are just words.)",
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
        prompt:
          "Whose categories does a charge on a Central card get to pick from?",
        options: [
          "None — a Central charge carries no category",
          "The same list every chapter uses — there's one category list for the whole org",
          "Only the categories of the chapter whose budget it's charged to",
          "Central has its own separate list, kept apart from the chapters'",
        ],
        answerIndex: 1,
        explanation:
          "Categories are org-wide: Supplies means Supplies in every book, so every charge anywhere takes one from the same list and the picker offers you the same labels wherever you're standing. Funds are the opposite, deliberately — a fund is a chapter's own restricted money, so it stays chapter-owned. And on your actual relationship to a chapter's spending: you're an auditor who can verify any chapter's numbers at any time, not a gate purchases wait behind. Chapter budgets are approved by the Chapter Director, never pre-cleared by you.",
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
        text: "One missing receipt is normal life. The same cardholder hitting escalation every month is worth a real conversation. The queue exists so you notice the pattern, not so you chase every stray charge.",
      },
      {
        kind: "rule",
        title: "A full receipts library is not a documented month",
        text: "Receipts that arrive by email or text are CAPTURED, not filed. They wait in the Receipts library until a human confirms which charge each belongs to. The cardholder does that in one tap, when the app offers the match while they code the charge. So the two numbers you'd expect to move together don't: receipts in, and charges documented. The second is the one that governs the lock, this queue, and the close.\n\nWe gave up the automatic match deliberately. Guessing was right most of the time, and wrong invisibly. A receipt stuck to the wrong charge reads as finished, which is worse than one that isn't attached at all. A chapter where the queue keeps growing doesn't have a broken pipeline. It has a habit that hasn't landed yet, which is the pattern this view exists to show you.",
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
        text: "Central spending follows the same invariants as chapter spending. Actuals come only from explicitly-linked transactions, and an over-cap budget gets a loud warning. Approval mirrors a chapter's separation of duties: you approve central budgets, and the Financial Manager approves the ones you submitted.",
      },
      {
        kind: "reveal",
        prompt:
          "Why does central use the exact same budget tables and rules as a chapter, instead of its own separate system?",
        answer:
          "Because \"central\" is just another scope in the same model — a sentinel string, not a parallel structure. Every rule, report and rollup that works for a chapter works for central automatically, with nothing built twice.",
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
        text: "Seats get assigned from the **Org Chart** tab. A superuser can assign a holder directly. Anyone else proposes a change for the seat's holder, or the seat above it, to confirm — a two-party handoff, not a unilateral edit. Executive Director and Financial Manager sit at central; Chapter Director and Treasurer sit per chapter. Each is one holder per seat — assigning a new Executive Director replaces the old one, it doesn't add a second. Editing the chart's STRUCTURE itself (adding, moving, or removing seats) is separate and narrower: only the Executive Director or a superuser can do that.",
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
        text: "Today, some people genuinely hold two real seats at once — you might be Executive Director AND a Chapter Director. That is not a bug or a special permission. Hold seats at both central and a chapter and you get an honest **seat switcher** — \"which desk are you at?\" — listing exactly your real seats. Someone with one seat never sees a switcher at all.",
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
        text: "Two money flows tie the network together. The 15% skim moves UP from every chapter into the City Launch Fund. A one-time launch grant moves DOWN from central to seed a new city. The fund itself is real today — it's central's own account. Both flows move as a deliberate, human-recorded transfer, not an automatic pipe — and that's a choice, not a gap.",
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
        text: "The City Launch Fund's balance is a real number in a real central account you can see today. Central's bookkeeper records every skim contribution and every launch grant as a manual transfer. Same ledger entry either way, just typed in rather than run by a cron job.",
      },
      {
        kind: "tip",
        text: "**Why manual, on purpose:** with one chapter and a small backer base, an automated monthly transfer is complexity the network doesn't need yet. So is the wiring, approval flow and failure handling it would require. Every transfer between a chapter and central goes through ONE mutation today, with a note saying what it's for. If the network grows enough that this becomes a real burden, automating it is a well-understood, revisitable decision — not a broken promise.",
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
        text: "An event or project doesn't automatically get a budget — plenty are pure work-tracking, no dollars involved. A budget only exists once real money enters the picture. Type a planned amount when you create the event and a Draft budget is created right then. Or tap **Add budget** on its page later, once there's something to plan. Either way, nothing is approved yet — a budget is a plan until someone deliberately moves it forward.",
      },
      {
        kind: "bullets",
        items: [
          "**Draft** — the amount and line items are yours to edit freely. Nobody outside your own head has weighed in yet, and nothing you type here spends anything.",
          "**Send for review** — a deliberate tap, never an autosave. The moment you send it, the budget is Awaiting approval and visible to whoever can act on it. They get an email too, not just a badge in the app.",
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
        text: "**Raising the cap sends it back to Draft — but nobody's told.** Bump an APPROVED budget's amount and it drops back to Draft the moment you save. Not Awaiting approval, and not auto-submitted. The OLD approved figure stays the real spending cap, so nothing silently expands. But the increase is invisible to every approver until YOU hit Send for review again. Skip that tap and the raise is never reviewed, and no approver is ever notified. Decreasing an amount, or reshuffling its line items, never triggers any of this.",
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
        text: "Attribution is explicit-only. A transaction counts toward a budget the moment a person deliberately links it there. Nothing is coded automatically. No charge lands on the nearest-looking budget because the dates happen to line up.",
      },
      {
        kind: "bullets",
        items: [
          "**Unattributed is the honest name for \"not yet claimed.\"** Every charge without an explicit link sits in the Needs Budget bucket, in plain sight on the dashboard. It is a number the chapter drives to zero, never one to bury.",
          "**Only an approved budget can take a charge.** The \"For\" picker is grouped Events / Projects / Recurring. It offers only budgets that have cleared review. A Draft or Awaiting-approval budget can't receive a link yet, on purpose.",
          "**Nothing codes a charge but a person.** The picker ranks the likely homes so the right one is usually first. Ranking is only ordering — a link exists because someone chose it.",
        ],
      },
      {
        kind: "rule",
        title: "Every dollar belongs to a chapter or to central — never both",
        text: "A budget's level is a real chapter, or the literal \"central\" scope. Never null, never a mix. A chapter's dashboard never surfaces central's money alongside its own, and central's rollup never absorbs a chapter's.",
      },
      {
        kind: "reveal",
        prompt:
          "You're logging a charge for a brand-new event that doesn't have an approved budget yet. What happens in the \"For\" picker?",
        answer:
          "Nothing — that event's budget won't appear until it clears review. The charge waits in Needs Budget. Open the event's page, use Add budget, and send it for review. Once approved, the same charge attributes cleanly.",
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
 * The Finances stream's courses, in catalog order. Seven courses now: five
 * role courses (most-to-least everyone) plus two SHARED courses that several
 * finance paths carry — `chapter-money-model` and `finance-paying-contractors`,
 * both sitting between Finances-for-Everyone and Treasurer — the org
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
      "What every member needs: where the money comes from, reading the " +
      "org's books on the Ledger tab, using your card + the 7-day receipt " +
      "rule, coding what you spent and why, and both directions of " +
      "reimbursement. Gains a 'getting your budget " +
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
    // The contractor desk. `audience: "team"` for the same reason
    // `chapter-money-model` carries it rather than `"role"`: this is not one
    // seat's remit — the Treasurer, the central Financial Manager and the ED
    // all work the same queue, and the separation-of-duties rule it teaches
    // means two of them are involved in every single payment. Deliberately NOT
    // on the `chapter_director` path: that seat derives finance VIEWER, so it
    // can read the queue but can neither compose an agreement nor approve one
    // (`apps/convex/lib/contractorPaymentsAccess.ts`).
    slug: "finance-paying-contractors",
    themeKey: "finances",
    title: "Paying contractors",
    level: "intermediate",
    audience: "team",
    description:
      "The third money flow: paying someone for work, where there's nothing " +
      "to reimburse and no receipt to file. Why a contractor payment is not a " +
      "reimbursement, the two ways one arrives in a single queue, who may " +
      "approve it and who may not, the W-9 and how it's guarded, and exactly " +
      "what a contractor payment says on the public ledger.",
    icon: "file-text",
    moduleSlugs: [
      "finance-paying-a-contractor",
      "finance-contractor-tax-and-privacy",
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
