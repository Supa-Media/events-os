/**
 * Snapshot of the Academy curriculum + course catalog, captured BEFORE the
 * academy.ts / academyCourses.ts monolith was split into per-stream files
 * (packages/shared/src/academy/**). Hardcoded literal values (not vitest
 * snapshots) so a silent behavior change during the split — a re-ordered
 * section, a moved course, a changed minutes/quiz count — fails loudly.
 *
 * This test passed UNCHANGED across the split itself. It was DELIBERATELY
 * updated since for: the Foundations stream prepended (7 sections, 2
 * courses); the `chapter-money-model` reshape (shared core course for
 * Treasurer + Chapter Director) — two sections appended
 * (finance-budget-lifecycle, finance-one-home-per-dollar), a new
 * `chapter-money-model` course inserted between finances-for-everyone and
 * treasurer, and `finance-tiers-and-skim` moved out of chapter-director's
 * moduleSlugs into it; the Music stream appended after Finances (9 sections,
 * 3 courses); the People & Leadership expansion of the Management stream's
 * section/course set; and the Marketing & Media stream appended after Music
 * (4 sections — `mktg-the-look`, `mktg-hit-record`, `mktg-shoot-to-timeline`,
 * `mktg-getting-access` — 2 courses; a caption-voice lesson and a
 * short-form-editing course were authored and then descoped before merge —
 * see `streams/marketing.ts`'s header comment); the July All-Team
 * Meeting fold into Foundations — two sections appended
 * (foundations-we-pray-before-we-plan onto Welcome to Public Worship,
 * foundations-owning-your-yes onto How we work), plus a rewritten
 * foundations-communication and an enriched foundations-showing-up (see
 * `streams/foundations.ts`'s header comment); the Finances-for-Everyone
 * owner review pass — no sections added/moved, but `finance-stewardship`,
 * `finance-card-and-receipts`, and `finance-reimbursements-and-flags` grew
 * (minutes + quizLength bumped) for the Public Worship card terminology
 * sweep, the donate-instead-of-personally-covering pattern, the absolute
 * receipt rule, and the code-verified reimbursement-approval/urgent-path
 * content (see `streams/finances.ts`'s header comment); and the "Leading a
 * project" course — five sections appended to the Works stream
 * (works-defining-a-project, works-planning-the-work,
 * works-the-project-budget, works-tracking-and-escalating,
 * works-finishing-well), with the new `leading-a-project` course inserted
 * between `projects` and `duties` in the Works course catalog; and the
 * Development stream (F-6, `docs/plans/giving-platform.md` §8) appended
 * after Marketing & Media — 12 sections (`dev-giving-vocabulary` through
 * `dev-prospect-cities-and-map`) across 5 new courses (`giving-fundamentals`,
 * `donor-stewardship`, `the-backer-model`, `sponsorships-and-partnerships`,
 * `the-city-launch-story`), plus a Finances-stream touch-up:
 * `finance-tiers-and-skim` gained one quiz question (now 5, was 4) teaching
 * that the backer count is derived from pledges, not manually entered (see
 * `streams/finances.ts`'s header comment). Total: 96 sections. Section slugs
 * and their order are otherwise untouched — any OTHER drift here is still a
 * real regression.
 *
 * The Gifts ledger PR then APPENDED one Development section,
 * `dev-gifts-ledger-and-audit` (4 min, 4-quiz), into the `donor-stewardship`
 * course after `dev-import-and-backfill` — teaching the chronological gifts
 * ledger, edit-with-audit-trail, cross-book moves, donor reassignment, and
 * manual merge (owner requests #1–#5). Total: 97 sections. That course now
 * carries three modules; nothing else moved.
 *
 * `dev-prospect-cities-and-map` had its COPY + quiz corrected once the public
 * `/give` map shipped (PR #275, giving-platform §5): the map/city pages are now
 * taught as live, and launch's non-automatic pledge re-scope is told honestly
 * (an open owner decision, PRD Appendix C#3). Its minutes and quiz-length were
 * unchanged then, so the snapshotted values stayed put.
 *
 * The Territories cutover (docs/plans/giving-territories.md) then RETITLED that
 * section — "Prospect cities…" → "Prospect territories: how a dot becomes a
 * chapter" (the ONLY title change below) — and rewrote its prose + quiz, plus
 * the `dev-giving-vocabulary` "prospect city" → "prospect territory" copy: a
 * territory now maps 1:1 with a real chapter ("shadow chapter"), backers scope
 * DIRECTLY to it, and launch is a flag-flip that moves no money (the old
 * central-held/owner-decision teaching is obsolete). Slug, minutes, quiz
 * lengths, and order are all unchanged, so only that one title moved here.
 *
 * Territories P6 (canonical import, docs/plans/giving-territories.md) then
 * RETITLED `dev-import-and-backfill` — "Backfilling history: CSV import and
 * manual entry" → "The canonical import: preview, classify, commit" — and
 * rewrote it end to end for the one preview-then-commit import that replaced
 * the Givebutter-only CSV/recurring importers: the four row types, the
 * gift-vs-ticket classification rule (a ticket buyer got a seat back, so
 * that row can never become a donor), the dedup/suspected-duplicate rules,
 * and the gift/ticket split that catches a misclassified export before
 * commit. Minutes 4→5, quiz length 3→4 (both bumped below); slug and course
 * placement are unchanged. `dev-giving-vocabulary`'s "Gift" bullet and its
 * quiz were also touched (added the ticket-buyer-isn't-a-donor distinction,
 * still 4 questions), `dev-donor-crm-basics` gained a tip about the People
 * tab's giver marks (P5, previously undocumented), and
 * `dev-givebutter-migration`'s import bullets now point at the canonical
 * import instead of the deleted CSV tool — none of those three change
 * title/minutes/quiz-length, so nothing else moved in the tables below.
 *
 * 2026-07-19 (owner decision, Seyi — giving desk as an assignable per-role
 * power): `dev-donor-crm-basics` gained a rule + one quiz question explaining
 * that Giving-desk access is a per-seat power (None/View/Manage) the ED assigns
 * from the org chart — quiz length 4→5 (bumped below); its minutes, title, and
 * placement are unchanged, so nothing else in the tables moved.
 *
 * Giving integrity tools (owner feedback, Seyi — delete-with-reason, gift
 * splits, paused backers): `dev-gifts-ledger-and-audit` gained a "Split" +
 * "Remove (with a required reason)" teaching and one quiz question on why a
 * removal asks why — quiz length 4→5 (bumped below). `dev-backer-lifecycle`
 * gained the manual PAUSED status (a paused pledge stays listed but doesn't
 * count, and is sticky against Stripe re-syncs) + a quiz question on pausing —
 * quiz length 4→5 (bumped below); its subtitle now names the manual pause but
 * its snapshotted title/minutes are unchanged. `dev-backer-floor-and-ladder`'s
 * reveal added paused as a second non-counting reason (prose only — no snapshot
 * change). No slugs, titles, minutes, or order moved beyond those two quiz bumps.
 *
 * Two-party campaign approval (founder requirement, 2026-07-24):
 * `dev-relationship-workflow` gained a rule ("A personal thank-you and a
 * campaign are different tools") + one quiz question, contrasting the
 * one-to-one donor relationship this lesson teaches with the one-to-many
 * Campaigns desk, and teaching that Compose/Approve is the same
 * per-role-power mechanism as Giving — even the ED needs a DIFFERENT chosen
 * reviewer's approval to send a campaign. Quiz length 3→4 (bumped below);
 * its minutes, title, and placement are unchanged. (`dev-donor-crm-basics`
 * was considered too — its Giving-power quiz is already at the 5-question
 * cap — so this landed one lesson over instead.)
 *
 * Supplies ⇄ Inventory unification (docs/plans/inventory-supplies-unification.md,
 * the linking UI shipping): `tab-supplies` was rewritten for the provenance
 * Source model, the auto-derived Status (packed → Have it; "Event X ·
 * Container" for cross-event holds; override + back-to-auto), and the
 * "Keep in inventory" promotion — two quiz questions swapped in (the rings
 * and battery questions retired; both are taught elsewhere), so quiz length
 * stays 5 and its title, minutes, and placement are unchanged. A NEW section
 * `keeping-inventory`
 * (4 min, 4-quiz) was inserted after it, teaching the chapter gear registry:
 * reservations as a byproduct of supply rows, computed availability,
 * consumables/low-stock, and what belongs in the registry. The
 * `logistics-lead` course gained the new module (its description finally
 * cashes the "gains a keeping-inventory module" promise). Total: 98 sections.
 *
 * Chase Receipts manual nudge (the in-app "Send reminder"/"Remind all"
 * buttons, `cards.sendReceiptNudge`): `finance-chasing-receipts` gained a
 * paragraph on the buttons (one click re-sends the same reminder email +
 * best-effort text, rate-limited to once per cardholder per day) and one quiz
 * question on when to use them instead of texting a cardholder off-app —
 * quiz length 3→4 (bumped below). Its title, minutes, and placement are
 * unchanged. No slugs, sections, or courses moved; total stays 98 sections.
 *
 * Person-centric audiences Phase 3 (specs/person-centric-audiences.md
 * "Phase 3" — the founder-facing filters + hand-picked audience picker):
 * `dev-relationship-workflow` gained a second rule ("An audience is filters,
 * hand-picked people, or both — and it's always live") teaching the new
 * criteria-chip builder, live re-resolution, and the non-negotiable
 * suppression/opt-out-beats-hand-pick invariant, plus one quiz question on
 * that invariant — quiz length 4→5 (bumped below). Its title, minutes, and
 * placement are unchanged. No slugs, sections, or courses moved; total stays
 * 98 sections.
 *
 * Skim-automation retirement (founder decision, 2026-07-26 — the skim/
 * launch-grant/settlement mutations collapsed into one generic manual
 * transfer, see `streams/finances.ts`'s header comment): `finance-tiers-and-
 * skim` gained a tip explaining the 15% is honored as a deliberate manual
 * transfer, not an automated mechanic, and swapped its "does a higher tier
 * change the skim %" quiz question (redundant with an earlier one in the
 * same quiz) for a question testing that same manual-transfer point — quiz
 * length stays 5, minutes 4→5 (bumped below). `finance-launch-grants-and-
 * transfers` was rewritten to stop promising an automated Increase pipe
 * "coming with Phase 4" (that automation was built, then deleted) — same
 * title, minutes, and quiz length (3/3), so nothing else moved. No slugs,
 * sections, or courses moved; total stays 98 sections.
 *
 * Finance audit trail (`financeAuditLog`, founder ask: more audit trails on
 * reconcile edits): `finance-reconcile-grid`'s `try_status` caption now says
 * excluding a charge requires a reason, and the section gained one quiz
 * question on that same rule — quiz length 4→5 (bumped below). Its title,
 * minutes, and placement are unchanged; `finance-monthly-close` teaches the
 * closing CHECKLIST, not the exclude action itself, so it needed no change.
 * No slugs, sections, or courses moved; total stays 98 sections.
 *
 * The /collaborate fold-in (the published `publicworship.life/collaborate`
 * walkthrough + `/music-policy`, taught to the people who actually make the
 * records) APPENDED five Music sections after `music-the-economics-of-a-song`:
 * `music-inviting-a-collaborator` (3 min, 4-quiz), which joins the existing
 * `producing-and-artistry` course as its fourth module, plus
 * `music-greenlight-and-the-demo` (4/4), `music-three-lanes` (4/4),
 * `music-the-four-paths` (4/5), and `music-what-your-role-receives` (4/4) in a
 * NEW `collaborating-on-a-release` course appended to the Music catalog. Total:
 * 103 sections. Nothing else moved.
 *
 * The personal-expense flag/repayment feature (reconcile-flow marking,
 * un-marking, and the new Stripe-card repayment rail) touched
 * `finance-reimbursements-and-flags` (content-only: bullets + an existing
 * quiz explanation reworked to teach that the personal flag is orthogonal to
 * `status`, not a status itself — quiz length UNCHANGED, still 5, to stay
 * under the 5-question-per-section cap `apps/convex/tests/academy.test.ts`
 * enforces) plus content-only edits to `finance-reconcile-grid` (a "Personal
 * (unpaid)" filter row + a rule block — quiz length unchanged) and
 * `finance-monthly-close` (a bullet + a `try_ready` criterion — no quiz
 * change). No section added/moved/removed. Total: still 103 sections.
 *
 * Marking internal transfers + processor payouts in Reconcile (founder ask,
 * after a "PUBLIC WORSHIP | Transfer" row landed in Needs budget as spend)
 * ADDS one section: `finance-transfers-and-payouts`, slotted into the
 * `treasurer` course between `finance-reconcile-grid` and
 * `finance-chasing-receipts`. It earns its own section rather than more blocks
 * on the Reconcile one because the rule carries a trap — a processor payout is
 * real income and must NOT be marked as a transfer — and Reconcile's quiz was
 * already at the 5-question cap `apps/convex/tests/academy.test.ts` enforces.
 * `finance-reconcile-grid` itself is content-only (two filter-table rows for
 * the new pills, and its `try_status` caption no longer teaches "Excluded" as
 * the answer for a transfer — quiz length UNCHANGED at 5). Total: 104 sections.
 *
 * The data-export feature (`packages/shared/src/dataExport.ts` — ONE WIDE
 * FLAT FILE PER DATASET, founder decision 2026-07-31, and its own
 * `data.export` seat capability) originally APPENDED one Development
 * section, `dev-data-export` (4 min, 5-quiz), into the `donor-stewardship`
 * course right after `dev-import-and-backfill`. Total: 105 sections.
 *
 * That placement was then corrected: `data.export` is granted to SIX seats
 * (executive_director, financial_manager, development_director,
 * expansion_director, marketing_director, chapter_director —
 * `packages/shared/src/seats.ts`), but `donor-stewardship` appears on only
 * ONE of those six role paths (`development_director`,
 * `packages/shared/src/academyPaths.ts`). The lesson MOVED — slug renamed
 * Receipt exceptions (docs/plans/receipt-exceptions.md) INSERTED one section,
 * `finance-receipt-exceptions` ("When there's genuinely no receipt", 4 min,
 * 5-quiz), into the `finances-for-everyone` course directly after
 * `finance-card-and-receipts`. Total: 106 sections; every section from it
 * onward shifts by one `order`, which is derived from array position and so
 * needs no hand-editing. It teaches the documented substitute for a receipt —
 * the reason axis, the attestation note, evidence-vs-receipt, and the
 * second-approver rule above $75 — and is required, not `optional`, so it
 * counts toward "fully trained" (owner decision, 2026-08-05: the rules should
 * be genuinely learned before people start filing exceptions, because a bad
 * one becomes a published artifact).
 *
 * That lesson also PULLED CONTENT BACK OUT of two existing sections, which had
 * briefly carried it: `finance-card-and-receipts` returns to a pointer plus its
 * original 5 questions (the "where do you see your own charges" navigation
 * question, dropped when the exception question was crammed in, is restored),
 * and `finance-chasing-receipts` keeps its Missing-receipt-vs-Undocumented
 * teaching at 5 questions but hands the approval decision to the new lesson.
 * Neither one's title/minutes/quizLength moved as a result, so only the
 * insertion shows up in the tables below.
 *
 * `dev-data-export` → `foundations-data-export`, content moved from
 * `streams/development.ts` into `streams/foundations.ts` — into the
 * `how-we-work` course, right after `foundations-where-things-live`, since
 * `how-we-work` is the one course all six of those role paths actually
 * share (alongside `welcome-to-public-worship` and
 * `finances-for-everyone`). Reframed for a whole-team audience rather than
 * the development desk: what the power is and that it's normal not to hold
 * it, that export never widens reach, why finished files expire in 7 days
 * while the job row stays forever as the audit trail, and to check
 * consent/suppression columns before mailing an exported list. `donor-
 * stewardship` drops back to three modules; `how-we-work` gains a sixth.
 * `dev-data-export`'s vacated slot leaves `donor-stewardship`'s remaining
 * three sections untouched and unmoved. Total: still 105 sections (moved,
 * not added or removed).
 *
 * Collecting personal charges (founder feedback: the "Personal charges
 * outstanding" tile named a number with no way to see the rows or settle
 * one, and Reconcile hid the flag entirely on charges that resolve no
 * payer). `finance-reconcile-grid` is content-only again — two rules, one on
 * a manager NAMING who owes an unattributed charge and one on where the
 * collecting happens and what settling does to the ledger — because its quiz
 * is still at the 5-question cap. The quiz question that pairs with it
 * ("Mark repaid" posts an offsetting credit; nothing is deleted) went to
 * `finance-monthly-close` instead, which had room and already carries the
 * "check the Personal (unpaid) pill" close step: quiz length 3→4 (bumped
 * below), minutes and placement unchanged. No slugs, sections, or courses
 * moved; total stays 105 sections.
 *
 * The central/chapter BOOKS pass (founder report: a dashboard "to review"
 * figure that pointed at a Reconcile view which never contained it) then
 * touched two Finances sections, adding none and moving none:
 *  - `finance-reconcile-grid` — the filter table's two mislabeled rows were
 *    corrected to what those pills actually match ("Uncategorized" → "To
 *    review", i.e. status-unreviewed; "Ready" → "Reconciled", i.e. already
 *    cleared), and the quiz question about them was replaced with one that
 *    teaches the tile→pill round trip. One question swapped for one, so its
 *    snapshotted minutes/quizLength are unchanged.
 *  - `finance-cross-chapter-audit` — gained a rule ("Separate books, one
 *    queue when you hold both hats") teaching Reconcile's books selector,
 *    that central and each chapter keep separate books as separate OPERATING
 *    entities, and that a foreign chapter's rows are readable but not
 *    editable — plus one quiz question on that write boundary. Minutes 3→4,
 *    quiz length 3→4 (both bumped below). Total: still 105 sections.
 *
 * Cross-book attribution (founder request, 2026-08-05 — "a transaction should
 * know its true book based on what budget it's in … then we can calculate in
 * the backend what transfers need to be made") then touched the SAME
 * `finance-cross-chapter-audit` section again: a rule ("Whose card paid ≠
 * whose budget it counts against") teaching the two facts every charge
 * carries — paid-from is custody and never moves when a charge is coded;
 * charged-to is what a budget measures — and that the gap between them is a
 * receivable the app computes and settles from Inter-chapter balances, plus
 * one quiz question on the Public-Worship-card-buys-for-New-York case.
 * Minutes 4→5, quiz length 4→5 (both bumped below). No other section moved;
 * total stays 105.
 *
 * Transaction coding phase 1 (`docs/plans/transaction-coding.md` — IRS-grade
 * substantiation, owner decisions 2026-08-08) is a content-only edit to
 * `finance-reconcile-grid`: two filter-table rows for the new Reconcile
 * facets ("Needs coding", "Coding review") and a rule ("Reconciled means
 * coded, too") teaching the Sept 1, 2026 policy date, the what/why/who
 * record, the 15-person meal-names threshold, the send-back loop, and that
 * names never publish (affiliation breakdowns do). Its snapshotted
 * title/minutes/quizLength are unchanged — the cardholder-facing lesson and
 * quiz land with phase 2 (self-serve coding). No slugs, sections, or courses
 * moved; total stays 105.
 *
 * Transaction coding phase 2 (self-serve coding — the cardholder writes the
 * substantiation themselves) cashes that promise and INSERTS one section:
 * `finance-coding-your-charges` ("Coding your charges", 5 min, 5-quiz), into
 * the `finances-for-everyone` course between `finance-receipt-exceptions` and
 * `finance-reimbursements-and-flags`. Total: 106 sections; every section from
 * it onward shifts by one `order`, which is derived from array position and
 * so needs no hand-editing. It teaches the spender's half of the record —
 * what it was, why it served the work, who was involved; the business purpose
 * written for the PUBLIC ledger; routes on travel; the 15-HEAD (never dollar)
 * meal threshold; that names never publish, only the affiliation breakdown;
 * the lodging itemized-receipt exception to the receipt-exception flow; why
 * nothing is pre-filled and no AI drafts a coding; and the clock, ending at
 * the 60-day auto-convert to a personal repayment and the plain-words reason
 * it exists (unsubstantiated spending is legally taxable income to the
 * spender under IRS accountable-plan rules). It sits AFTER
 * `finance-receipt-exceptions` rather than beside the card lesson because it
 * leans on the exception vocabulary instead of repeating it; both of those
 * neighbours are unchanged (their quizzes are at the 5-question cap
 * `apps/convex/tests/academy.test.ts` enforces), so only the insertion shows
 * up in the tables below. It is required, not `optional`, so it counts toward
 * "fully trained" — the same reasoning as `finance-receipt-exceptions`, and
 * it is the lesson `financeSettings.cardPrerequisiteCourseSlug` is meant to
 * put on the record before a card is issued (its course,
 * `finances-for-everyone`, is the prerequisite candidate).
 *
 * Transaction coding phase 3 (reimbursement parity) is a content-only edit to
 * `finance-reimbursements-and-flags`, one course over: two new rules — per-LINE
 * substantiation with the same elements and the same shared validator in the
 * app, the `/reimburse/<token>` page and the server (cross-referencing
 * `finance-coding-your-charges` rather than restating the meal/travel rules,
 * and noting reimbursements have NO receipt-exception path), and the new
 * `changes_requested` send-back loop (required note, resubmission keeps the
 * original submission date, substantiation-only revisions, not payable while
 * sent back). Its quiz stays at the 5-question cap by swapping the "where do
 * you see both directions" navigation question — still taught by the bullet
 * above it — for one on send-back-vs-rejected. Title, minutes (5), and
 * quizLength (5) are all unchanged, so nothing in the tables below moved; no
 * slugs, sections, or courses moved either, and the total stays 106.
 *
 * Inline merchant rename (finance-owner ask, 2026-08-08 — bank feeds hand us
 * `IC* COSTCO BY IN CAR`) is a content-only edit to `finance-reconcile-grid`:
 * one rule, "Renaming a merchant is not correcting a row", teaching that the
 * typed name is stored BESIDE the provider's string rather than over it (which
 * is why a bookkeeper may do it on bank rows, which the pencil above it must
 * never touch), that both names stay searchable, that the clock icon opens the
 * name history, and that clearing a rename restores nothing because nothing
 * was overwritten. The neighbouring "Some rows you can correct" rule's closing
 * line was amended so it no longer reads as "no edit of any kind exists on a
 * bank row". Its snapshotted title/minutes/quizLength are UNCHANGED — the
 * matching quiz question could not land, because this section's quiz is at the
 * 5-question cap `apps/convex/tests/academy.test.ts` enforces and no existing
 * question here is redundant enough to swap out. No slugs, sections, or
 * courses moved; total stays 106.
 *
 * Documentation fuses into coding (owner decision, 2026-08-08 — "they should
 * just upload the receipt when coding"; `docs/plans/transaction-coding.md`) is
 * a content-only edit to six Finances sections, adding and moving none. Two
 * shipped rules drove it: a coding no longer submits unless the charge has a
 * receipt or a FILED (pending counts) receipt exception, and emailed/texted
 * receipts are still captured but no longer auto-attach — they wait in the
 * receipts library and are OFFERED as a match when the cardholder codes the
 * charge, confirmed in a tap. `finance-card-and-receipts` gained a paragraph
 * pointing forward to coding as the other half of the same act and a rule,
 * "Sending it in is not attaching it"; its email tip was rewritten around
 * capture-at-the-counter, and its weakest question (the "where do you see your
 * own charges" navigation one, whose answer now rides in the new question's
 * explanation) was swapped for one on an emailed receipt that hasn't been
 * confirmed yet. `finance-receipt-exceptions` now says the gate bites at
 * SUBMISSION as well as at reconcile, that the exception is filed from the
 * coding sheet, and — in its try_status caption and one quiz explanation —
 * that a pending exception unblocks submitting the coding but nothing else.
 * `finance-coding-your-charges` replaced its "two separate obligations"
 * paragraph with the rule that replaced it, "One act, not two errands"
 * (deadlines unchanged: day-7 card lock on the receipt, day-60 conversion),
 * plus a paragraph on the offered-receipt tap; its pizza-vs-dinner question
 * (the same numbers as the `scenario` block directly above it) gave way to one
 * on submitting a coding with no receipt. On the reviewer's side,
 * `finance-reconcile-grid` records that every coding now arrives documented,
 * and `finance-chasing-receipts` / `finance-receipt-escalation-queue` both
 * teach that a full receipts library is not a documented month — the treasurer
 * lesson swapping its who-unlocks-the-card question (answered verbatim by the
 * `reveal` block above it) for the nine-receipts-nine-undocumented case, and
 * the FM lesson ADDING a fourth question, its only snapshot movement
 * (quizLength 3 → 4, bumped below). Minutes are unchanged everywhere: the
 * lessons that grew stayed inside the word budget their own neighbours run at.
 * No slugs, sections, or courses moved; the total is unchanged.
 *
 * Reconcile states + no default filter (2026-08-09) is a content-only edit to
 * three Finances sections, adding and moving none. The "Undocumented" filter
 * became "Closed without documentation" and narrowed to the CLOSED tail, so it
 * and "Needs documentation" are now disjoint halves of the publishing backlog
 * rather than a filter and its near-identical superset; the header's single
 * "N to clear" became three tappable chips (Needs attention / Ready to close /
 * Reconciled); the page stopped opening on a default filter and search stopped
 * being limited by the State filter. `finance-reconcile-grid` dropped the
 * retired "All" row from its filter table, gained the "Closed without
 * documentation" row plus a paragraph and a rule on the new header workflow,
 * and rewrote its bulk-select question around Ready to close (the bulk-bar
 * teaching moved into that question's explanation).
 * `finance-chasing-receipts` rewrote its two-filters paragraph and replaced the
 * "Needs documentation: 0 but Undocumented: 14" question, which tested the
 * retired superset relationship. `finance-receipt-exceptions`'s treasurer tip
 * now names both halves. Both rewritten quizzes were already at the
 * 5-question cap, so questions were SWAPPED, not added — titles, minutes and
 * quiz lengths are unchanged everywhere, nothing in the tables below moved,
 * and the total is unchanged.
 *
 * The 2026-08-12 founder call INSERTED one section, `finance-three-tracks`
 * ("Green, yellow, red", 4 min, 6-quiz), into `finances-for-everyone` between
 * `finance-stewardship` and `finance-card-and-receipts`. Total: 109 sections;
 * everything from it onward shifts one `order`, derived from array position.
 * It teaches the founders' spending policy — name the budget, check there's
 * room, then decide green (spend, tell the owner) / yellow (get a yes FIRST) /
 * red (don't; it becomes a personal charge) — and it is deliberately the one
 * finance lesson with no product mechanism behind it: the founders were
 * explicit that the tracks are taught and reinforced in meetings rather than
 * enforced in software.
 *
 * Two existing sections were also rewritten for truthfulness rather than
 * scope. Both were already at the 5-question cap `apps/convex/tests/
 * academy.test.ts` enforces, so questions were SWAPPED, not added, and
 * neither section's title/minutes/quizLength moved in the tables below.
 *
 * `finance-card-and-receipts` gained the caveat that a legacy Relay card
 * cannot be auto-locked — the lock runs through Increase's real-time
 * authorization decision, which only covers cards Increase issued — alongside
 * the code change that stops the sweep locking them. Every other consequence
 * still applies, and the new question tests exactly that. It replaced "why
 * does the app lock instead of sending reminders forever", which taught
 * motivation rather than a rule and is now the weaker half of the same point.
 *
 * `finance-tiers-and-skim` stopped asserting the chapter operating formula and
 * started deriving it: the $570 fixed base broken out line by line (film /
 * event food / transport / storage / software, matching
 * `finance.ts#OPERATING_FLOOR_FIXED_CENTS`'s own doc), the $20/teammate as the
 * monthly team meal, an explicit "adding a teammate costs money" rule, and the
 * conference sinking fund explained AND flagged as the model's one
 * forward-looking line, since no conference is scheduled. Two questions were
 * swapped in for it (the $690 arithmetic; what four new teammates cost),
 * displacing "is the skim automated today" (an implementation detail the
 * lesson's own tip still states, and one that changes the day it's automated)
 * and the past-due-pledge edge case (taught at length in the Development
 * stream's backer-model course, which is where the lifecycle lives).
 *
 * The Reconcile grid declutter (2026-08-13 founder call) is content-only
 * across three Finances sections and moves nothing here. The grid's view menu
 * and header chips were deleted — Group by, the State/Kind dropdowns and the
 * books selector already say everything they said — so
 * `finance-reconcile-grid` retitled and rewrote its header rule, gained a
 * "Group by is how you get everywhere else" rule carrying the retired
 * month/chase/publish views, and SWAPPED its chips question (it was at the
 * 5-cap) for one on what Publish acts on from a filtered month band.
 * `finance-chasing-receipts` rewrote its worklist rule and question around the
 * State + Group by pairing, and `finance-publishing-the-books` rewrote its
 * "watch it happen" paragraph for Group by → Month plus the band's two
 * figures. Titles, minutes, quiz lengths, slugs and order are all unchanged,
 * so nothing in the tables below moved.
 *
 * The finance-tab rework (2026-08-14 — the Budgets tab becoming a drill-down,
 * Reimbursements becoming its own tab again, and repayments becoming a
 * multi-select page that covers the card fee) is CONTENT-ONLY on two existing
 * sections; no section was added, moved, or removed, and no quiz length
 * changed:
 *
 *  · `finance-three-tracks` — "is there enough left in it?" said "open it and
 *    look; the app knows", which sent every volunteer to a screen that showed
 *    a number and nothing else. It now names the route (Finances → Budgets),
 *    says no finance role is needed, and teaches the drop-down: the charges
 *    behind the number and the link through to the event or project.
 *  · `finance-reimbursements-and-flags` — the pay-back bullet taught an
 *    all-at-once "card or bank (ACH)" choice. The ACH form is gone from the
 *    UI (its debit rail is feature-gated off, so it was collecting bank
 *    details that could do nothing), and paying back is now a selection: the
 *    bullet was rewritten around picking which charges to settle, and a NEW
 *    bullet was added for the fee the payer now covers — including the
 *    one-fee-per-payment rule, which is the only part of the arithmetic a
 *    payer can't work out from what's on screen. The "both directions live in
 *    one place" bullet now says Reimbursements is a top-level tab for
 *    everyone, approvers included, rather than filed under Cards.
 *
 * The repayment-settlement follow-up (2026-08-14, same day, founder decisions
 * on the shipped work) is content-only on `finance-reimbursements-and-flags`
 * again — three bullets rewritten and two added, no section or quiz change:
 * the payer now CHOOSES card or bank transfer and covers the corresponding
 * fee, a bank transfer visibly sits in "Clearing" for its four business days,
 * and — the rule with teeth — nobody can mark a charge repaid by hand any
 * more, including the Financial Manager. Cash handed over in person is no
 * longer recordable as a repayment; the honest alternatives (pay through the
 * app, or un-flag a charge that was never personal) are taught in its place.
 *
 * The collections follow-up (2026-08-14) adds ONE more bullet to that same
 * section — the reminder email a finance manager can now send, and the
 * restraint built into it (one message per person, a three-day cooldown, and
 * never chasing a bank transfer that is already clearing). Still content-only:
 * no section added, moved, or removed, and no quiz length changed.
 *
 * The no-login pay link (2026-08-14) adds one more bullet to that same
 * section: that a manager can hand out a URL which opens a checkout page with
 * no account behind it — built for the person most likely to owe money and
 * least likely to log in, someone who left the team — and that the page names
 * nobody. Content-only again; that section's quiz is untouched and still at 5.
 *
 * Budget titles from the event template (2026-08-14) touch one bullet on
 * `finance-three-tracks` — "a specific, named, approved budget" now says what
 * that name IS, since an event budget is titled after its template with a year
 * or month appended only when something needs telling apart. Content-only.
 *
 * 2026-08-14 — bulk explanation, and Approve as one undoable tap. Both land in
 * `finance-reconcile-grid`: an "Explained" filter row, a new rule block on
 * explaining a backlog without lying about it, and the undo/confirm folded
 * into the existing "Reconciled means coded, too". Its `minutes` moves 4 → 5
 * below — the ONLY movement in these tables. Its quiz was at the 5-question
 * cap, so two questions were SWAPPED, not added (in: the bulk apply's per-row
 * honesty, what Undo actually calls; out: the "To review 80" tap, whose
 * doctrine two other questions in the same quiz already carry, and the blank
 * exclusion reason, stated verbatim in the `try_status` caption above the
 * quiz). No slugs, sections, courses or totals moved.
 *
 * 2026-08-14 — "Reconciled" is called **Closed** everywhere a human reads it
 * (founder, on the deployed grid: "I don't even know what reconciled is"), so
 * the status finally pairs with the "Ready to close" roll-up that points at it.
 * A LABEL change only — the stored value is still `"reconciled"` — and so a
 * content-only Academy edit across four Finances sections and one Works
 * section. Two quizzes were rewritten IN PLACE (a wrong-fix option, a
 * distractor, two explanations); nothing was added or removed, so every
 * snapshotted title, minutes and quizLength below is unchanged, as is the
 * section and course order. See `streams/finances.ts`'s header comment for
 * which sentences moved and, more importantly, which kept the word "reconcile"
 * because they mean real bank reconciliation.
 *
 * 2026-08-14 — the grid's Columns control. `finance-reconcile-grid` is the only
 * section touched, and only its prose: the page's control count went four → five
 * and one paragraph now explains hiding columns (a rendering choice, not a
 * filter; the checkbox, Merchant and Actions always stay; the narrowed view is
 * in the link). No section, course, slug, minutes or quiz length moved, so every
 * table below is unchanged.
 *
 * 2026-08-14 — two CLOSE rules, both founder calls about what a row owes
 * before it can be closed, both content-only. `finance-reconcile-grid`'s
 * "Personal is a flag, not a status" now teaches that a personal charge
 * awaiting repayment cannot be closed, while a row closed BEFORE it was
 * flagged stays closed and stays both — the clause it replaces was true in
 * only one of those two directions. `finance-transfers-and-payouts`' "Marked
 * still means documented" splits its two markings: a marked transfer still
 * owes its bank statement, a marked payout owes nothing at all, and the block
 * says outright which processors we hold a settlement record for ourselves
 * (Stripe) and which we don't (Givebutter, hand-marked "other"). Neither
 * section had a quiz question the changes made false, so nothing was swapped
 * in either — both were checked question by question, and
 * `finance-reconcile-grid` is at the 5-cap, where a swap would have cost
 * coverage to restate what the rule blocks already say. No title, slug,
 * minutes, quizLength, section or course order moved: every table below is
 * unchanged.
 *
 * 2026-08-14 — the grid's last column, split by KIND (founder: "the last
 * column is very cluttered… it could be much cleaner and have things broken
 * down"). Reconcile's Actions cell had accumulated three different kinds of
 * thing — the way INTO a record, badges saying what the row IS, and buttons
 * that act on it — so the markings moved to a new hideable "Marked" column and
 * every row action moved behind one `⋯` menu. Two sections are touched, both
 * content-only, because both named an affordance by its old shape:
 * `finance-reconcile-grid`'s "Some rows you can correct" said hand-entered
 * rows "carry a pencil in the Actions column" (now: "Correct amount, date or
 * merchant" in the row's ⋯ menu), its "Renaming a merchant" rule pointed at
 * "the pencil" for the same act, and its "Personal is a flag, not a status"
 * now names the Marked column the flag reads out in; `finance-transfers-and-
 * payouts`' "Marked still means documented" says where a marking shows and
 * where its undo went. Neither quiz hung on the old shapes — both were checked
 * question by question, and `finance-reconcile-grid` is at the 5-cap — so
 * nothing was swapped. No title, slug, minutes, quizLength, section or course
 * order moved: every table below is unchanged.
 *
 * 2026-08-14 — approving a reimbursement now emails the claimant (founder:
 * "there's no email sent… we just need to make sure people know that their
 * money is coming once it's approved"). Content-only on
 * `finance-reimbursements-and-flags`: one bullet added on the notice itself
 * and on the state pair behind it — the email goes to the address on the
 * REQUEST, names the approved amount (and the submitted one when a partial
 * approval makes them differ), and never claims the money has moved, because
 * approved and paid are different states. Its quiz was at the 5-question cap,
 * so one question was SWAPPED, not added (in: what an approval email does and
 * does not mean about your money; out: the "charge you don't recognize"
 * question, whose answer is stated verbatim in a bullet above the quiz — its
 * doctrine moved into the flagging question's explanation). Minutes stay 5 and
 * quizLength stays 5, so every table below is unchanged; no slugs, sections or
 * courses moved. See `streams/finances.ts`'s header comment for the reasoning.
 *
 * 2026-08-14 — and a second notice when the money actually goes (same founder
 * ask, the other half: "let's also send emails when we actually pay people…
 * email when approved and email when paid"). Content-only on
 * `finance-reimbursements-and-flags` again: one bullet added on the PAID email
 * — what it names, that "paid" is our word for SENT rather than for landed,
 * that the figure is the money that moved (so a partial approval is a smaller
 * payment and never a first instalment), and that the single case producing
 * two paid emails is a bounced transfer that gets re-paid. NO question was
 * swapped this time: the quiz is at the 5-cap and nothing in it became wrong,
 * so the new fact went into the approval-email question's explanation instead
 * of costing this quiz its SoD, send-back or flagging coverage. Minutes stay 5
 * and quizLength stays 5, so every table below is unchanged; no slugs, sections
 * or courses moved. See `streams/finances.ts`'s header comment for the
 * reasoning.
 */
import { describe, expect, test } from "vitest";
import { ACADEMY_COURSES, ACADEMY_SECTIONS } from "./academy";

// Ordered section slugs (curriculum/unlock order).
const EXPECTED_SECTION_SLUGS: string[] = [
  "foundations-seeds-and-soil",
  "foundations-chapters-and-central",
  "foundations-the-work",
  "foundations-we-pray-before-we-plan",
  "foundations-communication",
  "foundations-showing-up",
  "foundations-where-things-live",
  "foundations-data-export",
  "foundations-spending",
  "foundations-owning-your-yes",
  "what-is-events-os",
  "organizers-and-crew",
  "anatomy-of-an-event",
  "being-an-owner",
  "timing-and-offsets",
  "phase-rings",
  "tab-tasks",
  "tab-comms",
  "tab-run-of-show",
  "tab-crew-duties",
  "tab-supplies",
  "keeping-inventory",
  "tab-permits",
  "tab-debrief",
  "using-the-assistant",
  "capstone-join-an-event",
  "capstone-birthday-party",
  "capstone-worship-event",
  "capstone-comms-lead",
  "capstone-event-lead",
  "capstone-logistics-lead",
  "works-projects",
  "works-driving-a-project",
  "works-duties",
  "works-owning-a-duty",
  "works-defining-a-project",
  "works-planning-the-work",
  "works-the-project-budget",
  "works-tracking-and-escalating",
  "works-finishing-well",
  "mgmt-one-on-one",
  "mgmt-reviewing-the-work",
  "mgmt-caring-for-people",
  "mgmt-holding-the-line",
  "mgmt-the-org-tree",
  "mgmt-director-philosophy",
  "mgmt-ownership-not-babysitting",
  "mgmt-the-slas",
  "mgmt-the-repair-ritual",
  "mgmt-building-for-your-absence",
  "mgmt-empower-first",
  "mgmt-the-interview",
  "mgmt-the-trial",
  "mgmt-the-call",
  "mgmt-the-four-gates",
  "mgmt-frontline-no-final-yes",
  "finance-stewardship",
  "finance-three-tracks",
  "finance-card-and-receipts",
  "finance-receipt-exceptions",
  "finance-coding-your-charges",
  "finance-reimbursements-and-flags",
  "finance-reconcile-grid",
  "finance-transfers-and-payouts",
  "finance-chasing-receipts",
  "finance-monthly-close",
  // 2026-08-11: the public finances page. Publishing is the step after the
  // close, so the lesson sits immediately after it in the curriculum.
  "finance-publishing-the-books",
  "finance-raise-vs-manage",
  "finance-approving-budgets",
  "finance-tiers-and-skim",
  "finance-cross-chapter-audit",
  "finance-receipt-escalation-queue",
  "finance-accounts-and-cards-admin",
  "finance-central-budgets",
  "finance-governance-and-seats",
  "finance-launch-grants-and-transfers",
  "finance-budget-lifecycle",
  "finance-one-home-per-dollar",
  "music-worship-is-a-sacrifice",
  "music-the-test",
  "music-four-shapes-of-praise",
  "music-the-five-drifts",
  "music-running-the-room",
  "music-submitting-a-song",
  "music-what-a-producer-does",
  "music-artist-is-a-brand",
  "music-the-economics-of-a-song",
  "music-inviting-a-collaborator",
  "music-greenlight-and-the-demo",
  "music-three-lanes",
  "music-the-four-paths",
  "music-what-your-role-receives",
  "mktg-the-look",
  "mktg-hit-record",
  "mktg-shoot-to-timeline",
  "mktg-getting-access",
  "dev-giving-vocabulary",
  "dev-donor-crm-basics",
  "dev-relationship-workflow",
  "dev-import-and-backfill",
  "dev-gifts-ledger-and-audit",
  "dev-backer-floor-and-ladder",
  "dev-backer-lifecycle",
  "dev-givebutter-migration",
  "dev-sponsor-packages",
  "dev-sponsorship-pipeline",
  "dev-church-partnerships",
  "dev-city-launch-economics",
  "dev-prospect-cities-and-map",
];

// Per-section fields that must not drift: title, minutes, quiz length,
// optional flag, capstone kind (null when not a capstone).
const EXPECTED_SECTIONS: {
  slug: string;
  title: string;
  minutes: number;
  quizLength: number;
  optional: boolean;
  capstoneKind: string | null;
}[] = [
  {
    slug: "foundations-seeds-and-soil",
    title: "Seeds & soil",
    minutes: 3,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "foundations-chapters-and-central",
    title: "Chapters and central",
    minutes: 4,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "foundations-the-work",
    title: "The work",
    minutes: 4,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "foundations-we-pray-before-we-plan",
    title: "We pray before we plan",
    minutes: 3,
    quizLength: 3,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "foundations-communication",
    title: "Communication",
    minutes: 4,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "foundations-showing-up",
    title: "Showing up",
    minutes: 5,
    quizLength: 5,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "foundations-where-things-live",
    title: "Where things live",
    minutes: 3,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "foundations-data-export",
    title: "Taking data out of the app",
    minutes: 4,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "foundations-spending",
    title: "Spending like it's not yours",
    minutes: 3,
    quizLength: 3,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "foundations-owning-your-yes",
    title: "Owning your yes",
    minutes: 3,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "what-is-events-os",
    title: "What Chapter OS is",
    minutes: 3,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "organizers-and-crew",
    title: "Organizers and crew",
    minutes: 3,
    quizLength: 3,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "anatomy-of-an-event",
    title: "Anatomy of an event",
    minutes: 4,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "being-an-owner",
    title: "Being an owner",
    minutes: 4,
    quizLength: 5,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "timing-and-offsets",
    title: "Timing that moves with the date",
    minutes: 3,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "phase-rings",
    title: "The four rings",
    minutes: 3,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "tab-tasks",
    title: "Tasks",
    minutes: 4,
    quizLength: 5,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "tab-comms",
    title: "Comms Schedule",
    minutes: 3,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "tab-run-of-show",
    title: "Run of Show",
    minutes: 3,
    quizLength: 3,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "tab-crew-duties",
    title: "Crew Duties",
    minutes: 5,
    quizLength: 5,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "tab-supplies",
    title: "Supplies & Logistics",
    minutes: 4,
    quizLength: 5,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "keeping-inventory",
    title: "Keeping inventory",
    minutes: 4,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "tab-permits",
    title: "Permits",
    minutes: 3,
    quizLength: 3,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "tab-debrief",
    title: "Debrief",
    minutes: 3,
    quizLength: 3,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "using-the-assistant",
    title: "Working with the assistant",
    minutes: 3,
    quizLength: 3,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "capstone-join-an-event",
    title: "Capstone: join an event",
    minutes: 8,
    quizLength: 0,
    optional: false,
    capstoneKind: "join_event",
  },
  {
    slug: "capstone-birthday-party",
    title: "Capstone: plan a party from scratch",
    minutes: 10,
    quizLength: 0,
    optional: false,
    capstoneKind: "birthday_party",
  },
  {
    slug: "capstone-worship-event",
    title: "Bonus: plan a worship event",
    minutes: 12,
    quizLength: 0,
    optional: true,
    capstoneKind: "worship_event",
  },
  {
    slug: "capstone-comms-lead",
    title: "Capstone: run the comms",
    minutes: 12,
    quizLength: 0,
    optional: false,
    capstoneKind: "comms_lead",
  },
  {
    slug: "capstone-event-lead",
    title: "Capstone: run the plan",
    minutes: 12,
    quizLength: 0,
    optional: false,
    capstoneKind: "event_lead",
  },
  {
    slug: "capstone-logistics-lead",
    title: "Capstone: run the supplies",
    minutes: 10,
    quizLength: 0,
    optional: false,
    capstoneKind: "logistics_lead",
  },
  {
    slug: "works-projects",
    title: "Projects",
    minutes: 3,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "works-driving-a-project",
    title: "Driving a project to done",
    minutes: 3,
    quizLength: 3,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "works-duties",
    title: "Duties",
    minutes: 3,
    quizLength: 3,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "works-owning-a-duty",
    title: "Owning a duty",
    minutes: 3,
    quizLength: 3,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "works-defining-a-project",
    title: "Defining the project",
    minutes: 3,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "works-planning-the-work",
    title: "Planning the work",
    minutes: 4,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "works-the-project-budget",
    title: "Building the budget",
    minutes: 4,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "works-tracking-and-escalating",
    title: "Tracking execution, escalating risks",
    minutes: 4,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "works-finishing-well",
    title: "Completing and reviewing",
    minutes: 3,
    quizLength: 3,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "mgmt-one-on-one",
    title: "The 1:1: person first, then work",
    minutes: 4,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "mgmt-reviewing-the-work",
    title: "Reviewing the work",
    minutes: 3,
    quizLength: 3,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "mgmt-caring-for-people",
    title: "People are a renewable resource",
    minutes: 3,
    quizLength: 3,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "mgmt-holding-the-line",
    title: "Holding the line",
    minutes: 4,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "mgmt-the-org-tree",
    title: "The manager tree",
    minutes: 3,
    quizLength: 3,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "mgmt-director-philosophy",
    title: "Directing",
    minutes: 4,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "mgmt-ownership-not-babysitting",
    title: "Ownership, not babysitting",
    minutes: 4,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "mgmt-the-slas",
    title: "The SLAs",
    minutes: 4,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "mgmt-the-repair-ritual",
    title: "The repair ritual",
    minutes: 3,
    quizLength: 3,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "mgmt-building-for-your-absence",
    title: "Building for your absence",
    minutes: 4,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "mgmt-empower-first",
    title: "Empower first, appoint second",
    minutes: 4,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "mgmt-the-interview",
    title: "The interview",
    minutes: 4,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "mgmt-the-trial",
    title: "The trial",
    minutes: 3,
    quizLength: 3,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "mgmt-the-call",
    title: "The call",
    minutes: 3,
    quizLength: 3,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "mgmt-the-four-gates",
    title: "The four gates",
    minutes: 3,
    quizLength: 3,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "mgmt-frontline-no-final-yes",
    title: "Frontline no, final yes",
    minutes: 3,
    quizLength: 3,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "finance-stewardship",
    title: "Where the money comes from",
    minutes: 4,
    quizLength: 5,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "finance-three-tracks",
    title: "Green, yellow, red",
    minutes: 4,
    quizLength: 5,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "finance-card-and-receipts",
    title: "Your card and the 7-day rule",
    minutes: 4,
    quizLength: 5,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "finance-receipt-exceptions",
    title: "When there's genuinely no receipt",
    minutes: 4,
    quizLength: 5,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "finance-coding-your-charges",
    title: "Coding your charges",
    minutes: 5,
    quizLength: 5,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "finance-reimbursements-and-flags",
    title: "Reimbursement, and flagging a charge",
    minutes: 5,
    quizLength: 5,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "finance-reconcile-grid",
    title: "Running Reconcile",
    minutes: 5,
    quizLength: 5,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "finance-transfers-and-payouts",
    title: "Transfers and payouts",
    minutes: 3,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "finance-chasing-receipts",
    title: "Chasing receipts",
    minutes: 3,
    // 4 → 5: the Missing-receipt vs Undocumented question, the treasurer's
    // half of receipt exceptions (`docs/plans/receipt-exceptions.md`).
    quizLength: 5,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "finance-monthly-close",
    title: "The monthly close",
    minutes: 3,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "finance-publishing-the-books",
    title: "Publishing the books",
    minutes: 5,
    quizLength: 5,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "finance-raise-vs-manage",
    title: "Raise vs. manage",
    minutes: 3,
    quizLength: 3,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "finance-approving-budgets",
    title: "Approving budgets",
    minutes: 3,
    // 4 since 2026-08-09: the four approval seats now approve CODINGS too,
    // with different reach per seat, and that's the part people get wrong.
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "finance-tiers-and-skim",
    title: "Tiers, the covenant, and the skim",
    minutes: 5,
    quizLength: 5,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "finance-cross-chapter-audit",
    title: "Auditing every chapter",
    minutes: 5,
    quizLength: 5,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "finance-receipt-escalation-queue",
    title: "The receipt escalation queue",
    minutes: 3,
    // 3 → 4: the receipts-are-captured-not-filed question, added when emailed
    // and texted receipts stopped auto-attaching (docs/plans/transaction-coding.md,
    // owner decision 2026-08-08).
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "finance-accounts-and-cards-admin",
    title: "Accounts, cards, and the City Launch Fund",
    minutes: 3,
    quizLength: 5,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "finance-central-budgets",
    title: "Central budgets",
    minutes: 3,
    quizLength: 3,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "finance-governance-and-seats",
    title: "Governance and seats",
    minutes: 3,
    quizLength: 3,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "finance-launch-grants-and-transfers",
    title: "Launch grants and the skim transfer",
    minutes: 3,
    quizLength: 3,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "finance-budget-lifecycle",
    title: "The budget lifecycle",
    minutes: 3,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "finance-one-home-per-dollar",
    title: "One home per dollar",
    minutes: 3,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "music-worship-is-a-sacrifice",
    title: "Worship is a sacrifice",
    minutes: 4,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "music-the-test",
    title: "The test",
    minutes: 3,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "music-four-shapes-of-praise",
    title: "Four shapes of praise",
    minutes: 4,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "music-the-five-drifts",
    title: "The five drifts",
    minutes: 4,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "music-running-the-room",
    title: "Running the room",
    minutes: 3,
    quizLength: 3,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "music-submitting-a-song",
    title: "Submitting a song",
    minutes: 3,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "music-what-a-producer-does",
    title: "What a producer does",
    minutes: 4,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "music-artist-is-a-brand",
    title: "Artist = brand",
    minutes: 3,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "music-the-economics-of-a-song",
    title: "The economics of a song",
    minutes: 3,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "music-inviting-a-collaborator",
    title: "Inviting a collaborator",
    minutes: 3,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "music-greenlight-and-the-demo",
    title: "Greenlight, demos, and getting a song back",
    minutes: 4,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "music-three-lanes",
    title: "Three lanes: song, publishing, master",
    minutes: 4,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "music-the-four-paths",
    title: "The four paths",
    minutes: 4,
    quizLength: 5,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "music-what-your-role-receives",
    title: "What your role receives",
    minutes: 4,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "mktg-the-look",
    title: "The look",
    minutes: 3,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "mktg-hit-record",
    title: "HIT RECORD",
    minutes: 3,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "mktg-shoot-to-timeline",
    title: "From shoot to timeline",
    minutes: 4,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "mktg-getting-access",
    title: "Getting access",
    minutes: 3,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "dev-giving-vocabulary",
    title: "Donors, backers, sponsors: the words we use",
    minutes: 4,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "dev-donor-crm-basics",
    title: "The donor CRM: your desk",
    minutes: 4,
    quizLength: 5,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "dev-relationship-workflow",
    title: "Owners, notes, and the top-donor list",
    minutes: 4,
    quizLength: 5,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "dev-import-and-backfill",
    title: "The canonical import: preview, classify, commit",
    minutes: 5,
    quizLength: 5,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "dev-gifts-ledger-and-audit",
    title: "The gifts ledger: see it, fix it, trace it",
    minutes: 4,
    quizLength: 5,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "dev-backer-floor-and-ladder",
    title: "The $50 floor, and the milestone ladder",
    minutes: 4,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "dev-backer-lifecycle",
    title: "A backer's lifecycle: subscribe, pay, sometimes falter",
    minutes: 4,
    quizLength: 5,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "dev-givebutter-migration",
    title: "The Givebutter migration: history in, recurring gifts re-signed",
    minutes: 4,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "dev-sponsor-packages",
    title: "Sponsor packages: benefits we give, commitments we keep",
    minutes: 4,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "dev-sponsorship-pipeline",
    title: "The pipeline: prospect to active partner",
    minutes: 4,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "dev-church-partnerships",
    title: "Church partnerships: two-sided, not transactional",
    minutes: 4,
    quizLength: 3,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "dev-city-launch-economics",
    title: "The 85/15 split and the City Launch Fund",
    minutes: 3,
    quizLength: 3,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "dev-prospect-cities-and-map",
    title: "Prospect territories: how a dot becomes a chapter",
    minutes: 3,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
];

// Course catalog: slug + themeKey + ordered moduleSlugs.
const EXPECTED_COURSES: {
  slug: string;
  themeKey: string;
  moduleSlugs: string[];
}[] = [
  {
    slug: "welcome-to-public-worship",
    themeKey: "foundations",
    moduleSlugs: ["foundations-seeds-and-soil", "foundations-chapters-and-central", "foundations-the-work", "foundations-we-pray-before-we-plan"],
  },
  {
    slug: "how-we-work",
    themeKey: "foundations",
    moduleSlugs: ["foundations-communication", "foundations-showing-up", "foundations-where-things-live", "foundations-data-export", "foundations-spending", "foundations-owning-your-yes"],
  },
  {
    slug: "chapter-os-fundamentals",
    themeKey: "events",
    moduleSlugs: ["what-is-events-os", "organizers-and-crew", "anatomy-of-an-event", "timing-and-offsets", "phase-rings", "tab-debrief", "using-the-assistant"],
  },
  {
    slug: "comms-lead",
    themeKey: "events",
    moduleSlugs: ["tab-crew-duties", "tab-comms", "capstone-comms-lead"],
  },
  {
    slug: "event-lead",
    themeKey: "events",
    moduleSlugs: ["tab-tasks", "tab-run-of-show", "tab-permits", "capstone-event-lead"],
  },
  {
    slug: "logistics-lead",
    themeKey: "events",
    moduleSlugs: ["tab-supplies", "keeping-inventory", "capstone-logistics-lead"],
  },
  {
    slug: "owning-an-event",
    themeKey: "events",
    moduleSlugs: ["being-an-owner", "capstone-join-an-event", "capstone-birthday-party", "capstone-worship-event"],
  },
  {
    slug: "projects",
    themeKey: "works",
    moduleSlugs: ["works-projects", "works-driving-a-project"],
  },
  {
    slug: "leading-a-project",
    themeKey: "works",
    moduleSlugs: [
      "works-defining-a-project",
      "works-planning-the-work",
      "works-the-project-budget",
      "works-tracking-and-escalating",
      "works-finishing-well",
    ],
  },
  {
    slug: "duties",
    themeKey: "works",
    moduleSlugs: ["works-duties", "works-owning-a-duty"],
  },
  {
    slug: "the-one-on-one",
    themeKey: "management",
    moduleSlugs: ["mgmt-one-on-one", "mgmt-reviewing-the-work"],
  },
  {
    slug: "care-and-accountability",
    themeKey: "management",
    moduleSlugs: ["mgmt-caring-for-people", "mgmt-holding-the-line"],
  },
  {
    slug: "directing",
    themeKey: "management",
    moduleSlugs: ["mgmt-the-org-tree", "mgmt-director-philosophy"],
  },
  {
    slug: "the-director-standard",
    themeKey: "management",
    moduleSlugs: [
      "mgmt-ownership-not-babysitting",
      "mgmt-the-slas",
      "mgmt-the-repair-ritual",
      "mgmt-building-for-your-absence",
    ],
  },
  {
    slug: "growing-the-team",
    themeKey: "management",
    moduleSlugs: [
      "mgmt-empower-first",
      "mgmt-the-interview",
      "mgmt-the-trial",
      "mgmt-the-call",
    ],
  },
  {
    slug: "partnerships",
    themeKey: "management",
    moduleSlugs: ["mgmt-the-four-gates", "mgmt-frontline-no-final-yes"],
  },
  {
    slug: "finances-for-everyone",
    themeKey: "finances",
    moduleSlugs: [
      "finance-stewardship",
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
    // `finance-publishing-the-books` (2026-08-11) lands in the SHARED
    // foundation course rather than Treasurer or ED: a module belongs to
    // exactly one course, and this lesson has both audiences — the Treasurer
    // prepares a month, the ED / FM / Chapter Director publishes it. All four
    // finance paths carry this course.
    moduleSlugs: [
      "finance-tiers-and-skim",
      "finance-budget-lifecycle",
      "finance-one-home-per-dollar",
      "finance-publishing-the-books",
    ],
  },
  {
    slug: "treasurer",
    themeKey: "finances",
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
    moduleSlugs: ["finance-raise-vs-manage", "finance-approving-budgets"],
  },
  {
    slug: "financial-manager",
    themeKey: "finances",
    moduleSlugs: ["finance-cross-chapter-audit", "finance-receipt-escalation-queue", "finance-accounts-and-cards-admin"],
  },
  {
    slug: "executive-director",
    themeKey: "finances",
    moduleSlugs: ["finance-central-budgets", "finance-governance-and-seats", "finance-launch-grants-and-transfers"],
  },
  {
    slug: "doxology-what-we-sing",
    themeKey: "music",
    moduleSlugs: ["music-worship-is-a-sacrifice", "music-the-test", "music-four-shapes-of-praise", "music-the-five-drifts", "music-running-the-room"],
  },
  {
    slug: "leading-worship",
    themeKey: "music",
    moduleSlugs: ["music-submitting-a-song"],
  },
  {
    slug: "producing-and-artistry",
    themeKey: "music",
    moduleSlugs: [
      "music-what-a-producer-does",
      "music-artist-is-a-brand",
      "music-the-economics-of-a-song",
      "music-inviting-a-collaborator",
    ],
  },
  {
    slug: "collaborating-on-a-release",
    themeKey: "music",
    moduleSlugs: [
      "music-greenlight-and-the-demo",
      "music-three-lanes",
      "music-the-four-paths",
      "music-what-your-role-receives",
    ],
  },
  {
    slug: "brand-and-voice",
    themeKey: "marketing",
    moduleSlugs: ["mktg-the-look"],
  },
  {
    slug: "media-pipeline",
    themeKey: "marketing",
    moduleSlugs: ["mktg-hit-record", "mktg-shoot-to-timeline", "mktg-getting-access"],
  },
  {
    slug: "giving-fundamentals",
    themeKey: "development",
    moduleSlugs: ["dev-giving-vocabulary", "dev-donor-crm-basics"],
  },
  {
    slug: "donor-stewardship",
    themeKey: "development",
    moduleSlugs: [
      "dev-relationship-workflow",
      "dev-import-and-backfill",
      "dev-gifts-ledger-and-audit",
    ],
  },
  {
    slug: "the-backer-model",
    themeKey: "development",
    moduleSlugs: [
      "dev-backer-floor-and-ladder",
      "dev-backer-lifecycle",
      "dev-givebutter-migration",
    ],
  },
  {
    slug: "sponsorships-and-partnerships",
    themeKey: "development",
    moduleSlugs: [
      "dev-sponsor-packages",
      "dev-sponsorship-pipeline",
      "dev-church-partnerships",
    ],
  },
  {
    slug: "the-city-launch-story",
    themeKey: "development",
    moduleSlugs: ["dev-city-launch-economics", "dev-prospect-cities-and-map"],
  },
];

describe("Academy curriculum snapshot (pre/post per-stream split)", () => {
  test("section order is unchanged", () => {
    expect(ACADEMY_SECTIONS.map((s) => s.slug)).toEqual(EXPECTED_SECTION_SLUGS);
  });

  test("per-section title/minutes/quiz length/optional/capstone kind are unchanged", () => {
    const actual = ACADEMY_SECTIONS.map((s) => ({
      slug: s.slug,
      title: s.title,
      minutes: s.minutes,
      quizLength: s.quiz.length,
      optional: s.optional === true,
      capstoneKind: s.capstone?.kind ?? null,
    }));
    expect(actual).toEqual(EXPECTED_SECTIONS);
  });

  test("course catalog slugs/themeKeys/moduleSlugs are unchanged", () => {
    const actual = ACADEMY_COURSES.map((c) => ({
      slug: c.slug,
      themeKey: c.themeKey,
      moduleSlugs: c.moduleSlugs,
    }));
    expect(actual).toEqual(EXPECTED_COURSES);
  });
});
