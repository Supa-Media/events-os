# Transaction coding — IRS-grade substantiation, self-serve

**Status:** ratified 2026-08-08 (decisions below); amended 2026-08-09
(decision 8 — the requirement and the consequence are two dates). Phases 1–3
are largely implemented; **the reviewer's route into a coding shipped
2026-08-09** (the Reconcile row's comment icon). Still missing: a Coding tab
that gathers a cardholder's charges-to-code and a manager's review queue in
one place, per-chapter scoping and roll-up for central oversight, and any
notification telling a reviewer that codings are waiting.
Decisions 6 and 7 (a coding carries its own documentation; receipts are
captured but no longer auto-matched) were ratified the same day, after phase 2
had been specced — the doc below is written to them, not amended around them.
**Owner ask (2026-08-08):** travel line items need a from/to; meals need the
names of everyone there (or a headcount for big groups); business purpose has
to be real ("travel to NY to film Eden event", not "bus to NY"). Cardholders
should code their own transactions from an email link — receipt, budget,
people, purpose — and it still goes to the financial manager / treasurer for
review, who can send it back with notes ("receipt must show exact amount").
Same for reimbursements. And all of it has to hold up when "we as Public
Worship are about to make all of our transactions fully public."

## What the IRS actually requires (the ground truth this encodes)

Public Worship reimburses and pays expenses under what the IRS calls an
**accountable plan** (Treas. Reg. §1.62-2). Staying inside it is what keeps
card charges and reimbursements from becoming **taxable income to the
person who spent the money**. Three conditions:

1. **Business connection** — the expense is for the org's work.
2. **Substantiation** — documented "within a reasonable period." The safe
   harbor is **60 days** after the expense.
3. **Return of excess** — amounts not substantiated are paid back (our
   personal-repayment flow) within 120 days.

For the expense types §274(d) singles out, substantiation is not "a receipt" —
it is specific **elements**, each of which must be recorded:

| element | travel | meals |
| --- | --- | --- |
| amount | ✓ | ✓ |
| date | ✓ | ✓ |
| place | **destination — where from, where to** | name/location of the restaurant |
| business purpose | ✓ — what org work the trip served | ✓ — what org work the meal served |
| business relationship | who traveled | **who attended and how they relate to the org** |

Receipts: the IRS documentary-evidence line is **$75** (already encoded as
`DEFAULT_EXCEPTION_APPROVAL_THRESHOLD_CENTS`), **except lodging, which
requires an itemized receipt at any amount**. Our own policy is stricter —
"no receipt, no coverage, every expense, any amount" — and stays that way;
the $75 line only governs who must approve a receipt *exception*.

On attendees, the IRS practice (and every auditor's expectation) is:
**names + business relationship when the group is enumerable; headcount +
an identifiable group description when it isn't** ("14 volunteers writing
and producing the album" is fine; "some people" is not). Note this is a
**headcount** threshold, not a dollar threshold — a $40 pizza order for 16
volunteers gets a headcount, a $400 dinner for 4 gets four names. **Decided
2026-08-08: headcount basis, threshold 15** — more than 15 people →
headcount + group description; 15 or fewer → names.

The teeth: an expense still unsubstantiated when the accountable-plan clock
runs out is, by law, **wages to the spender**. We already have the mechanism
(`noReceiptAutoConvertDays` → personal repayment); coding joins the same
clock.

## The problem publishing exposes

`transactions.note` is today the only "why" field: one freeform string, no
structure, no required elements, no review. A published ledger built on it
would say "bus to NY" and "meal 5/6" thousands of times — technically a
disclosure, practically an admission that nobody could say what the money
was for. And internally, the person who *knows* why the charge happened (the
cardholder) is not the person currently typing the note (the bookkeeper,
weeks later, guessing).

The fix is the same shape as receipt exceptions: make the substantiation a
**first-class reviewed record**, authored by the person who spent the money,
approved by someone who didn't.

## The model

A **transaction coding** is a first-class row (`transactionCodings`), one per
transaction — the structured answer to *what was this, why, and who was
involved*, with its own review state.

Coding state is **orthogonal** to `transactions.status`
(unreviewed/categorized/reconciled/excluded) and to documentation state
(receipt/exception/undocumented) — the same argument that kept receipt
exceptions out of `TRANSACTION_STATUSES`. A transaction is publishable when
all three axes are green. Do **not** add new values to
`TRANSACTION_STATUSES`.

**That orthogonality is about the ROW, and it is unchanged** — including by
decision 6 below, which fuses documentation and coding at the moment of
*submission*. The two must stay separately evaluated on the row because they
drift apart afterwards: a receipt can be superseded or deleted, an exception
can be withdrawn or rejected, and either can happen long after the coding was
written and approved. A publishing predicate that inferred "coded, therefore
documented" would be reading a fact that was true once. So the publishability
check still asks all three questions independently, every time. What decision 6
changes is only that you cannot *author* one half without the other — an
authoring gate, not a data model.

### Schema

`transactionCodings` (new, `schema/finances.ts`; enums in
`packages/shared/src/finance.ts` as readonly tuples, per house pattern):

- `transactionId`, `chapterId` — indexes `by_transaction`, `by_chapter`,
  `by_chapter_and_status`. Single-writer module `lib/transactionCoding.ts`
  (mirror `lib/receiptLinks.ts`).
- `expenseType`: `"general" | "travel" | "meal" | "lodging"` — exists **only**
  to drive which substantiation fields are required. It is not a category
  taxonomy; funds/categories/budgets already own that. Chosen by the human —
  the UI shows the merchant category as context, but nothing pre-selects
  (see the no-AI decision below).
- `businessPurpose`: required, `MIN_PURPOSE_LENGTH` (proposed **20** chars),
  max `MAX_NOTE_LENGTH`. This is the string the public ledger prints.
- Travel: `travelFrom`, `travelTo` (required when `travel`; city-level is
  enough), `travelerPersonIds?` / `travelerNames?` (who went).
- Meal: `headcount` (required), and — when
  `headcount <= mealAttendeeNamesMaxHeadcount` — `attendees[]`:
  `{ personId?, name, affiliation }` where `affiliation` is
  `"team" | "volunteer" | "community_member" | "contractor" | "guest" |
  "other"` (the business-relationship element; the taxonomy the owner wants
  the ledger to speak — "5 volunteers, 3 community members, 2 contractors").
  When over the threshold: `groupDescription` required ("volunteers writing
  and producing the album") plus an optional affiliation-count breakdown.
- Lodging: reuses travel from/to; its special rule is on the receipt side
  (below).
- Review: `status: "draft" | "submitted" | "changes_requested" | "approved"`,
  `codedByPersonId/UserId`, `submittedAt`, `decidedByPersonId/UserId`,
  `decidedAt`, `reviewNote?` (the latest send-back note — history lives in
  `financeAuditLog`). Copy the attest/decide field shape from
  `receiptExceptions` exactly.

`transactions` gains one single-writer denorm, `codingState?:
"uncoded" | "submitted" | "changes_requested" | "approved"` (sibling of
`approvedReceiptExceptionId`), so the reconcile grid filters server-side
without joins.

`financeSettings` gains:

- `codingRequiredSinceMs?` — **grandfathering**. Coding is required only for
  outflow spend posted after this date. Without it, years of history become
  an instant 100% backlog and the feature dies on arrival. Historical
  cleanup is a separate, deliberate effort (the `historicalImportBatch` /
  reconstructed-history story already covers how honest that has to be).
  **Decided 2026-09-01; amended 2026-08-09 to 2026-08-08 — see decision 8.**
- `codingConversionSinceMs?` — the CONSEQUENCE date, split out of the setting
  above on 2026-08-09 (decision 8). **Decided: 2026-09-01.** Auto-conversion
  to a personal repayment requires BOTH this and the requirement date.
- `mealAttendeeNamesMaxHeadcount?` (**decided: 15**).
- `codingOverdueDays?` — joins the receipt clock for the 60-day story.

New `FINANCE_AUDIT_ACTIONS`: `coding_submit`, `coding_edit`,
`coding_approve`, `coding_changes_requested`. New
`RECONCILE_FILTER_KEYS` in the `state` group: `uncoded`,
`coding_review` (submitted, awaiting reviewer). New email-safe deep links via
existing `appUrl(...)`.

### The gate

`setTransactionStatus` already refuses `reconciled` on an undocumented row
(`RECEIPT_REQUIRED`, finances.ts:9241). It gains the sibling:
`reconciled` on an outflow spend row posted after `codingRequiredSinceMs`
with `codingState !== "approved"` → `ConvexError({ code: "CODING_REQUIRED" })`.
Transfers, payouts, inflows and personal charges are exempt — coding is
about spend substantiation.

Lodging rule: for a coding with `expenseType: "lodging"`, receipt exceptions
of reason `bank_record_only` are blocked (IRS: itemized receipt required at
any amount) — enforced in `receiptExceptions.attest`, warned in the modal, and
mirrored in `submitCoding` (`LODGING_RECEIPT_REQUIRED`) so the rule doesn't
depend on which of the two the human filed first.

**The submission gate (decision 6).** `lib/transactionCoding.ts#submitCoding`
refuses a coding on a charge with neither a receipt nor a standing receipt
exception → `ConvexError({ code: "DOCUMENTATION_REQUIRED" })`. This is the
authoring half of the same idea the reconcile gate enforces at the end: what
the money was for and how it can be proved are one record, so one of them
cannot be filed without the other. It kills the failure this scope kept
re-creating — a charge finished halfway, sitting in two backlogs and two nag
streams, each of which reads as somebody else's problem.

**A PENDING exception counts here.** The gate's question is whether the AUTHOR
finished their half, and filing an attestation is their half; requiring an
approved one would block a submission on work the submitter cannot do and
strand the charge in their queue waiting on someone else's decision. Nothing is
weakened by this, because the `reconciled` gate is where documentation has to
be *resolved* — `isUndocumented` counts approved exceptions only — so no row
publishes on the strength of a claim nobody weighed.

### Access

Per the house rule, gated from day one via `lib/transactionCodingAccess.ts`:

- `requireCodingSubmit` — the transaction's cardholder/owner, or
  bookkeeper+. (A bookkeeper can code on someone's behalf — reality demands
  it — but the audit log shows who actually typed it.)
- `requireCodingReview` — **the four approval seats** (amended 2026-08-09;
  see below), graduating to a `finance.coding.review` capability string in
  `SEAT_CAPABILITIES` when seats need to carry it separately.
- `requireViewCoding` — READ the record: whoever may author it, or whoever
  may decide it. The second half exists because review reaches across books
  and authoring doesn't; without it a central reviewer could approve a
  chapter's coding from the queue and be refused sight of the row.
- **Separation of duties:** reviewer ≠ coder, enforced in the mutation like
  `receiptExceptions.approve`, on **both** decisions — approve and send-back
  alike (amended 2026-08-09; see below). When the financial manager codes
  their *own* charge, review falls to another approval-seat holder (ED,
  treasurer, chapter director) — same second-approver shape as
  `exceptionNeedsSecondApprover`.

#### Who may approve a coding (owner, 2026-08-09)

Four seats, never their own coding:

| seat | chapter codings | central codings |
| --- | --- | --- |
| `executive_director` | ANY chapter | yes |
| `financial_manager` | ANY chapter | yes |
| `chapter_director` | THEIR OWN only | no |
| `treasurer` | THEIR OWN only | no |

Three of the four could approve **nothing** as shipped, for two unrelated
reasons — and both had to be fixed:

1. **No graded role.** `executive_director` and `chapter_director` carry
   `finance.approve` but deliberately not `finance.manager`, so the seat
   derives no rank and a `financeRoleAtLeast(role, "manager")` test could
   never pass for them. Closed the way #209 and WP-wave4 closed the identical
   gap for BUDGET approval — read the capability directly at the gate
   (`holdsApprovalSeatAt`), additively, rather than folding an approve-side
   power into the manager/bookkeeper/viewer ladder.
2. **No cross-book reach.** The gate derived its scope from the caller's
   ACTIVE chapter and refused every other book outright, so "any chapter" was
   not sayable for the Financial Manager even though their seat carries
   `finance.central`. (A `financial_manager` seat derives its manager rank at
   the `"central"` scope key, not at the holder's home chapter — so the arm
   reads the central chart directly instead of trusting a bridged stored
   grant to exist.)

**The containment is now deliberate, and that is the load-bearing part.** The
blanket `txn.chapterId !== homeChapterId → NOT_FOUND` was the only thing
keeping a Treasurer inside their own chapter; it contained the Treasurer by
accident while containing the FM by mistake. Removing it to free the FM
without stating the Treasurer's limit would have silently handed every
Treasurer the whole org. The chapter-local arm now says `target ===
homeChapterId` itself, and is unreachable for a central target.
`tests/codingApprovalRoles.test.ts` pins every cell, refusals included.

**Send-back is a decision too.** `requestChanges` now asserts separation of
duties, which it did not before. `canReview` had always reported `false` to
an author, so the client already hid both buttons — the server was the laxer
of the two, which is the direction that matters. It also left a real hole:
`requestChanges` reopens an APPROVED coding, so an author who was also a
manager could single-handedly undo someone else's decision about their own
testimony. Deciding on your own coding is deciding on your own coding
whichever way the decision goes. (Authors lose nothing: resubmitting is
`submit`, not a decision.)

## Flows

### A. Charge lands → cardholder codes it

1. Ingest (`applyIncreaseCardTransaction` et al.) now stamps
   `codingState: "uncoded"` (when posted ≥ `codingRequiredSinceMs` and a
   cardholder is known).
2. **The reminder unit changes: we stop chasing receipts and start chasing
   codings** (owner call, 2026-08-08). A receipt is one *field* of a coding,
   not its own nag stream. `notifyReceiptDigest`, the escalation stages
   (`receiptReminderStage`), the FM nudge, and the receipt-chase page all
   rekey on `codingState` — "you have 3 charges to code" — and a charge with
   a receipt but no purpose is exactly as chased as one with neither. Decision
   6 makes that literal rather than rhetorical: the receipt is now a field the
   coding cannot be submitted without.
   One email, one link: `appUrl("/finances/coding?filter=uncoded")` (the Coding
   tab; `/finances/my-transactions` redirects there for links already sent).
   Cardholders are authed members, so **no new token infrastructure** in v1
   (the token page family stays reimbursement-only).
3. **My Transactions** grows the coding editor — an extension of the
   existing Concur-style `submitOwnCharge` sheet: expense type (human-picked,
   merchant category shown as context), business purpose with per-type
   prompts ("What was it, for which event/project, and why?"), from/to for
   travel, attendee picker (people-table typeahead + free-text guests +
   affiliation) or headcount+group for meals, the budget/"For" picker
   (reusing `forPicker`), and the **documentation block — receipt upload,
   already-captured receipt suggestions, and the exception flow — in the same
   sheet**, because the submit button depends on it (the gate above).
4. **No receipt?** The same sheet surfaces the existing exception flow
   verbatim: the five `RECEIPT_EXCEPTION_REASONS` with their hints, up to 5
   evidence photos, bank-statement option, required explanation. Nothing new
   to build — the ask ("proof you purchased the thing, up to 5 pictures,
   bank statements, why there is no receipt") *is* `receiptExceptions`; this
   scope just puts it in the cardholder's path instead of the treasurer's,
   and decision 6 makes it the *required* other branch rather than an
   optional one: every submitted coding leaves either a document or a named
   person's account of why there isn't one.
5. Submit → `codingState: "submitted"`, audit `coding_submit`.

Purpose quality can't be regexed. Two layers, both human: per-type prompt
templates in the UI that show what a complete purpose looks like ("what was
it, for which event or project, and why" — with a good and a bad example
inline), and the reviewer as the real gate. **No AI anywhere in coding**
(owner decision, 2026-08-08): substantiation is human-authored end to end —
no pre-filled purposes, no AI drafts, no AI-picked expense types. A
pre-filled field gets rubber-stamped; a blank field with a good prompt gets
answered, and the answer is the cardholder's own testimony, which is what
an accountable plan (and a public ledger) actually needs. The one AI surface
that used to sit next to this — the reviewer-side `aiSuggestion` budget/category
hints in the Reconcile grid — was a separate feature that never wrote into a
`transactionCodings` row, and has since been removed outright (the owner's read
was that the column was noise).

### Receipts: captured automatically, attached deliberately (decision 7)

The inbound receipt pipeline (`receiptInbox.ts` for email, `smsReceipts.ts`
for MMS) used to do two jobs: **capture** a receipt someone forwarded or
texted, and then **match** it to a transaction and attach it unattended. The
first job is worth more than ever and is unchanged. The second one goes away.

Capture has to stay because of when receipts exist. A card charge posts around
a day after the swipe, so the paper slip in someone's hand at the counter, or
the Amazon/Uber confirmation that hits their inbox at checkout, both arrive
*before there is a coding sheet to put them on*. Telling people to wait for the
charge to appear is telling them to lose the receipt. So the pipeline keeps
doing exactly what it does: OCR the document, class the sender, dedupe on
`fileSha256`, and file it in the sender's receipt library.

Automatic matching goes away because of who is looking. The matcher was right
most of the time, and its wrong answers were the expensive kind: a receipt
silently attached to the wrong charge reads as a finished row, so nobody
revisits it, and the error surfaces — if ever — as a reviewer or an auditor
asking why the amounts disagree. Under this scope there is now a moment when a
human has the charge and the receipt in front of them at the same time and is
already being asked to explain the charge. Confirming the match there costs one
tap and is the cheapest possible verification; guessing it a day earlier saves
that tap and buys an unverifiable claim.

So: `matchReceiptCandidates` survives as a **suggestion source**, not a writer.
Opening the coding sheet on a charge shows the cardholder's unattached receipts
that plausibly match it — "is this the one?" — ranked by the same amount/date/
merchant signals the matcher already computes, with a tap to attach and the
existing OCR pre-checks (amount mismatch, date drift, duplicate `fileSha256`)
rendered right there on the candidate. Manual linking from the Receipts library
stays for bookkeepers doing cleanup. What no longer exists is a write nobody
authorised: `auto_email` and `auto_sms` stop being produced (they stay in
`RECEIPT_LINK_SOURCES` — historic links keep their provenance, and rewriting
history to hide how a link was made is the opposite of the point).

Two consequences worth stating plainly, because they are the cost side of this
trade. A receipt that was emailed in but never confirmed does **not** stop the
day-7 card lock — capture is not documentation, and the lock keys on the
charge. And the "receipts in" number and the "charges documented" number stop
moving together, which will read as a bug to anyone who doesn't know the rule;
that is why it is taught in three Academy lessons rather than one.

### Mistake-proofing the editor (owner call: intuitive, prevents mistakes)

The send-back loop is the safety net, not the plan — the editor's job is to
make a rejectable submission hard to produce:

- **One question at a time, driven by `expenseType`.** Pick "meal" and the
  sheet shows exactly the meal questions; travel shows from/to. No blank
  20-field form, no fields that don't apply. Nothing is pre-filled — the
  cardholder composes every answer (owner decision: no AI in coding) — but
  the form makes composing easy: merchant, amount, and date are displayed
  as context, and each field carries an inline example of a complete
  answer.
- **Submit is disabled until the required elements exist**, with the missing
  ones listed in place ("Add who was there — 4 people means 4 names"). No
  server-side rejection for omissions the client could see. Documentation is
  one of those elements now (decision 6), and its missing-element line names
  both ways out: "Attach the receipt, or say why there isn't one."
- **The receipt is usually already in the building.** The sheet opens with the
  cardholder's plausible unattached receipts offered against this charge (see
  decision 7) — one tap attaches, and the pre-checks below run on the
  candidate before it is attached rather than after.
- **Amount-mismatch pre-check.** Receipts already carry OCR'd amounts
  (`receipts.ocrAmountCents`). If the attached receipt's amount doesn't
  match the transaction, warn *at attach time* — "this receipt shows $42.17
  but the charge is $58.30; is this the right receipt, or a partial?" That
  automates away the single most likely send-back ("receipt must show exact
  amount") before a reviewer ever sees it. Same for `ocrDate` far from
  `postedAt`, and the existing `fileSha256` duplicate detection surfaces as
  "you've already used this receipt on another charge."
- **Attendee picker, not a text box**: people-table typeahead with
  affiliation chips; free-text only for genuine guests. Headcount and the
  names list cross-check (headcount auto-derives when names are listed).
- **Plain-words education inline**, not in a help doc: one line under each
  requirement saying why ("the IRS requires who attended and their
  relationship to the org"), teaching the rule at the moment it applies —
  the Academy lesson's job is depth, the form's job is the reminder.

### B. Review

Reconcile grid gains the `coding_review` facet. Reviewer opens the row, sees
coding + receipt/exception side by side — **shipped 2026-08-09** as the row's
comment icon (`TransactionDocumentationModal`): the freeform note and the
coding in one panel, with Approve / Send back inline. The facet had shipped
without it, so for a while `coding_review` was a filter that led nowhere and a
coding could only be read from the dashboard drill-down. The icon also says
whether anything is behind it, which it previously did not:

- **Approve** → `codingState: "approved"`, audit `coding_approve`. The row
  can now be reconciled (documentation permitting — a coding submitted on a
  *pending* exception still waits on that exception's own approval, which is
  the one case where "coded" and "documented" visibly come apart).
- **Send back with note** → `status: "changes_requested"`, required
  `reviewNote` ("receipt must show exact amount"), email to the coder with
  the note and a deep link. Coder edits and resubmits; loop until approved.
  Audit `coding_changes_requested` each round.

Reviewers (and bookkeepers doing historical cleanup) can also author codings
directly from the grid — the same editor, launched from Reconcile. Approval
still requires a second person when the author is the reviewer.

### C. Reimbursements get the same fields

`reimbursementLineItems` gains the same structured block: `expenseType`,
`businessPurpose` (line-level; `purpose` on the request stays as the overall
summary), `travelFrom/To`, `attendees`/`headcount`/`groupDescription` —
**required at submission**, both in-app and on the public
`/reimburse/<token>` page (extend `reimburseApiRoutes` + the renderer). The
receipt-alternatives copy appears here too, but note: for reimbursements the
bar stays "receipt required per line" (server-enforced today); exceptions to
that are a policy decision, not a default (Open questions).

Reimbursement review gains **`changes_requested`** between `submitted` and
`approved`: reviewer note → email to payee (token link for accountless
payees) → payee edits lines → resubmits. Today's only send-back is
`rejected`, which reads as final; a revision loop is what actually matches
"the treasurer may send it back with notes."

### D. The 60-day clock

Reminder cadence reuses `RECEIPT_GRACE_DAYS` / escalation stages, rekeyed on
the coding being open — a missing receipt keeps the coding open by
construction now (decision 6: it cannot be submitted without one), so nothing
at all is lost by dropping the receipt-specific stream. The day-7 card lock
still keys on the *receipt*, not the coding, and that is deliberate: it is the
one consequence that bites inside the week, and it must keep biting a charge
whose receipt was emailed in but never confirmed onto it (decision 7). At
`codingOverdueDays` (recommend 60, the safe harbor), escalate to the FM
queue; the existing auto-convert-to-personal-repayment mechanism extends to
chronically uncoded charges — with the email saying why in plain words:
*"under IRS accountable-plan rules, unsubstantiated spending becomes taxable
income to you; pay it back or code it."* That sentence is the whole
enforcement story, and it belongs in the Academy too.

## The public-ledger lens

Everything above is designed backwards from publication. Rules the ledger
imposes on this feature:

1. **Two audiences, one record.** `businessPurpose` is written *for the
   public* — the UI says so at the field ("This description will appear on
   Public Worship's public ledger"). Attendee **names are internal-only**,
   forever (decided 2026-08-08): members, volunteers, and guests did not
   consent to appearing in a public financial record, and some are minors.
   The ledger prints the **headcount and affiliation breakdown** — "meal —
   5 volunteers, 3 community members, 2 contractors" — never names. Full
   names are visible internally behind `requireCodingNamesView` in the
   access resolver (finance viewer+ today; graduates to a
   `finance.coding.viewNames` capability string the day a seat needs it
   carried or stripped separately — the standard gate-it-now pattern).
   Travel from/to publishes at city level.
2. **Publishable = three green axes**: documentation state
   (receipt/exception — the existing `documentationState`), coding state
   (approved), review state (reconciled). `isUndocumented` remains the
   publishing backlog for documents; a sibling `isUncoded` predicate becomes
   the backlog for substance. A **publishability report** per month (counts
   by axis, per chapter) is the close-gate artifact — it tells the ED
   exactly what stands between a period and publication. **Decision 6 does not
   collapse these into two.** The axes are evaluated on the row at publish
   time, and a coding that was documented when it was written can stop being
   documented afterwards — a receipt deleted, an exception withdrawn or
   rejected. Inferring documentation from an approved coding would publish a
   fact with a timestamp on it. Three questions, asked every time.
3. **Sensitive categories.** Benevolence/pastoral care to individuals, and
   reimbursement payee names, publish **aggregated or anonymized** — policy
   to confirm, but the schema must not force the choice (publish rules live
   in the ledger renderer, not in the coding record).
4. **Honesty about history.** Pre-`codingRequiredSinceMs` transactions
   publish flagged as reconstructed/legacy, exactly as
   `historicalImportBatch` already anticipates. A ledger claiming perfect
   substantiation back to day one reads as less credible, not more — the
   receipt-exceptions doc already makes this argument and it holds here.

The public ledger itself (a `/ledger` page in the `givePage` family) is a
**separate scope**; this document only guarantees the data will be worthy of
it.

## Beyond the ask — adjacent gaps this surfaces

- **Mileage.** If we ever reimburse personal-vehicle miles, §274(d) wants
  date, miles, from/to, purpose at the standard rate — the travel fields
  cover from/to/purpose; a `miles` field on reimbursement lines is a small
  add when needed. Not in v1 unless it's happening today.
- **Per diem** — explicitly out of scope; we substantiate actuals.
- **1099-NEC tracking** — service payments ≥ $600/yr to individuals (people
  with `persona: "vendor"`) need year-end totals and W-9 collection.
  Separate scope; noting it because "fully public transactions" will make
  un-1099'd vendor payments visible to anyone who looks.
- **Alcohol policy** — decide whether meal codings need an "includes
  alcohol" flag (many churches bar it from org funds; the public will ask).
  One boolean if yes — cheap now, awkward retrofit later.
- **Substantiation-lag metric** — report `submittedAt - postedAt` per
  cardholder; the number an auditor asks for first, and the receipt-chase
  page already has the right shape to host it.
- **Policy acknowledgment before the card** — the accountable plan should
  exist as a written policy each cardholder has acknowledged. We already
  have the mechanism: `cardPrerequisiteCourseSlug`. Add the new coding
  lesson to the card-prerequisite course, and passing it *is* the
  acknowledgment, on the record, before the card is issued.
- **Record retention** — receipts, codings, exceptions, and audit rows are
  never hard-deleted (IRS lookback is 3 years minimum, 4 for
  employment-tax questions — which is exactly what a failed accountable
  plan becomes). Archiving stays; deletion doesn't exist in this domain.

## Phasing

1. **Backbone** — schema, enums, settings, gate, filters, audit actions,
   access resolver; coding editor in Reconcile (FM/bookkeeper-authored).
   Ships value immediately: the treasurer can start coding to the new
   standard.
2. **Self-serve** — My Transactions editor on `submitOwnCharge`'s bones,
   unified digest email, review/send-back loop, and the documentation block
   the submission gate depends on: receipt upload, suggested matches from the
   cardholder's captured receipts, and the exception flow (decisions 6–7).
3. **Reimbursement parity** — line-item fields in-app + token page,
   `changes_requested` loop.
4. **Publish prep** — publishability report, monthly-close gate, redaction
   policy doc. (Ledger page: separate plan.)

Decisions 6 and 7 land inside phase 2 rather than as a phase of their own:
the submission gate is one guard in `submitCoding`, and retiring the auto-match
is a deletion plus a query — but both change what the *cardholder* is asked to
do, which is exactly what phase 2 introduces. Shipping them a phase later would
mean teaching the receipt-and-coding split first and un-teaching it a month
after, to the same people, during the on-ramp.

Each phase updates the Academy in the same PR: `finance-card-and-receipts`
(the coding duty joins the 7-day rule; then decision 7's "sending it in is not
attaching it"), `finance-reconcile-grid` (new facets + review loop),
`finance-receipt-exceptions` (lodging rule; then the gate that now bites at
submission and the pending-exception nuance), `finance-reimbursements-and-flags`
(new required fields), the treasurer/FM chase lessons
(`finance-chasing-receipts`, `finance-receipt-escalation-queue` — a full
receipts library is not a documented month), and phase 2's new lesson
*"Coding your charges"* — plus quiz updates and a check of `academyPaths.ts`
and the capstone templates.

## Decisions (owner, 2026-08-08)

1. **Meal names threshold: 15, headcount-based.** More than 15 people →
   headcount + group description (+ affiliation counts); 15 or fewer →
   names with affiliations. No additional dollar trigger.
2. **Policy start date: September 1, 2026** (`codingRequiredSinceMs`).
   Build and launch the tooling now; the gate and auto-convert apply to
   charges posted on/after the policy date. August = voluntary on-ramp and
   the window to train (Academy lesson ships with phase 1).
   **SUPERSEDED by decision 8** — this is what was built, and it turned out
   to conflate two things the owner had always meant to separate. Kept here
   rather than rewritten, because the amendment only makes sense against it.
3. **Auto-convert to personal repayment: yes** for post-policy-date charges
   still unsubstantiated at the deadline, with the plain-words
   taxable-income explanation in the escalation emails.
4. **Publication redaction: names never publish.** The public ledger shows
   the affiliation breakdown ("5 volunteers, 3 community members,
   2 contractors"); full names stay internal behind
   `requireCodingNamesView`.
5. **No AI in coding.** Substantiation is human-authored end to end: no
   pre-fills, no drafts, no AI-picked types, no AI quality gate. The form's
   prompts and the human reviewer are the quality mechanism. (The separate
   reviewer-side `aiSuggestion` budget/category hints never touched a coding,
   and have since been removed from the product entirely.)
6. **A coding carries its own documentation.** `submitCoding` refuses a
   coding on a charge with neither a receipt nor a filed receipt exception
   (`DOCUMENTATION_REQUIRED`). Documentation and coding stop being two
   errands with two nag streams and two half-finished backlogs; they are one
   act, done in one sheet, in one sitting. A **pending** exception satisfies
   the gate — it asks whether the author finished their half, and blocking on
   an approver would strand the charge in a queue its owner cannot clear —
   while `reconciled` still requires an **approved** one, so nothing publishes
   on an unweighed claim. This is an authoring rule only: the three
   publishability axes stay independently evaluated on the row (see The model
   and the public-ledger lens).
7. **Receipts are captured automatically and attached deliberately.** The
   emailed/texted receipt pipeline keeps capturing — a charge posts about a
   day after the swipe, so the receipt exists before the coding sheet does,
   and telling people to wait is telling them to lose it. What retires is the
   unattended MATCH: the matcher becomes a suggestion source, offering the
   cardholder's plausible receipts against the charge they're coding ("is
   this the one?") for a one-tap confirm. The owner's read, in his words:
   *"we don't even need the receipt matching pipeline as much if people are
   going to code things themselves."* The verification is cheaper and better
   at the moment a human is looking at the charge and the receipt together;
   a guess made a day earlier saves that tap and buys a claim nobody checked.
   Cost, accepted: an emailed-but-unconfirmed receipt does not stop the day-7
   card lock.
8. **The requirement and the consequence are two dates** (owner, 2026-08-09,
   amending decision 2): *"I told the agent that implemented it to make it
   live now, but only implement the non-coded results in personal payments
   after Sept 1st."*

   Decision 2 shipped as ONE constant gating both halves, so neither could
   be turned on alone — and because the single date sat in the future, the
   net effect in production was that **nothing was required and nothing
   converted**, while the org believed coding was live. Six codings were
   written voluntarily in that window; the policy never asked for one.

   | setting | default | gates |
   | --- | --- | --- |
   | `codingRequiredSinceMs` | 2026-08-08 (ratification day) | a charge OWES a coding: `uncoded`/`coding_review` facets, the cardholder digest, the `CODING_REQUIRED` reconcile gate |
   | `codingConversionSinceMs` | 2026-09-01 (decision 2's date, preserved) | a charge that owes one may be BILLED BACK: `cards.autoConvertOverdueReceipts` |

   `autoConvertOverdueReceipts` tests both, independently. A charge can owe a
   coding for months — chased, counted, blocked from `reconciled` — and never
   convert. Asking someone to account for money they spent is fair
   immediately; billing them for spending that predates the ask is not.

   Grandfathering is unchanged, and is why the requirement arms at the
   ratification date rather than at zero: pre-2026-08-08 spend never lights
   up. "Live now" means from now on, not retroactively.

   Under the defaults the earliest any cardholder can be auto-billed on the
   coding clock is **2026-10-31** (2026-09-01 + the 60-day
   `codingOverdueDays` safe harbor).

## Known hole: a name can publish through the purpose sentence

Raised 2026-08-09, **owner's decision, not fixed in code.**

Decision 4 protects attendee NAMES absolutely — the ledger prints the
affiliation breakdown, never a name, because some attendees are minors and
none consented to appearing in a public financial record. That rule governs
the structured `attendees` array, and the projection honours it
(`hasCodingNamesView`).

It does not govern free text. `businessPurpose` is labelled *"This sentence
publishes"* and is printed word for word — and the first real codings written
in production name people in it ("Travel with Michael Reid from all team
meeting in Manhattan…"). So the same name is redacted two fields below and
published here.

Nothing is redacted or blocked automatically: silently rewriting somebody's
own testimony is worse than the hole, and a regex that guesses at names would
be both wrong and a form of the AI-in-coding this scope already refused
(decision 5). The options are a human review step before publication, an
explicit instruction at the field, or accepting it. **It has to be settled
before the ledger ships.**

## Still open (defaults apply unless overridden — neither blocks phase 1)

1. **Alcohol flag** — default: include `includesAlcohol?` on meal codings
   (one boolean now vs. an awkward retrofit; the public will ask).
2. **Reimbursement receipt exceptions** — default: keep the hard per-line
   receipt requirement (reimbursements are voluntary submissions, unlike
   card charges that already happened).
