# Transaction coding — IRS-grade substantiation, self-serve

**Status:** proposed (scope for review — not yet implemented)
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
**headcount** threshold, not a dollar threshold — a $40 pizza order for 15
volunteers gets a headcount, a $400 dinner for 4 gets four names. (The owner
ask framed it as a dollar amount; recommendation below is headcount with the
dollar amount as an *extra* trigger for reviewer scrutiny, see Open
questions.)

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

### Schema

`transactionCodings` (new, `schema/finances.ts`; enums in
`packages/shared/src/finance.ts` as readonly tuples, per house pattern):

- `transactionId`, `chapterId` — indexes `by_transaction`, `by_chapter`,
  `by_chapter_and_status`. Single-writer module `lib/transactionCoding.ts`
  (mirror `lib/receiptLinks.ts`).
- `expenseType`: `"general" | "travel" | "meal" | "lodging"` — exists **only**
  to drive which substantiation fields are required. It is not a category
  taxonomy; funds/categories/budgets already own that. Default suggested
  from `merchantCategory` (and the AI coder, below).
- `businessPurpose`: required, `MIN_PURPOSE_LENGTH` (proposed **20** chars),
  max `MAX_NOTE_LENGTH`. This is the string the public ledger prints.
- Travel: `travelFrom`, `travelTo` (required when `travel`; city-level is
  enough), `travelerPersonIds?` / `travelerNames?` (who went).
- Meal: `headcount` (required), and — when
  `headcount <= mealAttendeeNamesMaxHeadcount` — `attendees[]`:
  `{ personId?, name, affiliation }` where `affiliation` is
  `"team" | "volunteer" | "guest" | "vendor" | "other"` (the business
  relationship element). When over the threshold: `groupDescription`
  required ("volunteers writing and producing the album").
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
- `mealAttendeeNamesMaxHeadcount?` (default proposed **10**).
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
any amount) — enforced in `receiptExceptions.attest`, warned in the modal.

### Access

Per the house rule, gated from day one via `lib/transactionCodingAccess.ts`:

- `requireCodingSubmit` — the transaction's cardholder/owner, or
  bookkeeper+. (A bookkeeper can code on someone's behalf — reality demands
  it — but the audit log shows who actually typed it.)
- `requireCodingReview` — manager rank, graduating to a
  `finance.coding.review` capability string in `SEAT_CAPABILITIES` when
  seats need to carry it separately.
- **Separation of duties:** reviewer ≠ coder, enforced in the mutation like
  `receiptExceptions.approve`. When the financial manager codes their *own*
  charge, review falls to another manager-rank holder (ED/treasurer) — same
  second-approver shape as `exceptionNeedsSecondApprover`.

## Flows

### A. Charge lands → cardholder codes it

1. Ingest (`applyIncreaseCardTransaction` et al.) already schedules the AI
   coding suggestion; it now also stamps `codingState: "uncoded"` (when
   posted ≥ `codingRequiredSinceMs` and a cardholder is known).
2. **The reminder unit changes: we stop chasing receipts and start chasing
   codings** (owner call, 2026-08-08). A receipt is one *field* of a coding,
   not its own nag stream. `notifyReceiptDigest`, the escalation stages
   (`receiptReminderStage`), the FM nudge, and the receipt-chase page all
   rekey on `codingState` — "you have 3 charges to code" — and a charge with
   a receipt but no purpose is exactly as chased as one with neither.
   One email, one link: `appUrl("/finances/my-transactions?filter=uncoded")`.
   Cardholders are authed members, so **no new token infrastructure** in v1
   (the token page family stays reimbursement-only).
3. **My Transactions** grows the coding editor — an extension of the
   existing Concur-style `submitOwnCharge` sheet: expense type (AI-suggested,
   confirmable), business purpose with per-type prompts ("What was it, for
   which event/project, and why?"), from/to for travel, attendee picker
   (people-table typeahead + free-text guests + affiliation) or
   headcount+group for meals, receipt upload **in the same sheet**, and the
   budget/"For" picker (reusing `forPicker` + AI suggestion).
4. **No receipt?** The same sheet surfaces the existing exception flow
   verbatim: the five `RECEIPT_EXCEPTION_REASONS` with their hints, up to 5
   evidence photos, bank-statement option, required explanation. Nothing new
   to build — the ask ("proof you purchased the thing, up to 5 pictures,
   bank statements, why there is no receipt") *is* `receiptExceptions`; this
   scope just puts it in the cardholder's path instead of the treasurer's.
5. Submit → `codingState: "submitted"`, audit `coding_submit`.

Purpose quality can't be regexed. Three layers: per-type prompt templates in
the UI; the existing AI coding engine (`aiCoding.ts` /
`lib/codingEvidence.ts`) extended to flag vague purposes before submit
("'bus to NY' doesn't say why — add the event or project"); and the human
reviewer as the real gate.

### Mistake-proofing the editor (owner call: intuitive, prevents mistakes)

The send-back loop is the safety net, not the plan — the editor's job is to
make a rejectable submission hard to produce:

- **One question at a time, driven by `expenseType`.** Pick "meal" and the
  sheet shows exactly the meal questions; travel shows from/to. No blank
  20-field form, no fields that don't apply. AI pre-fills type, budget, and
  a draft purpose from `merchantCategory` + history — the cardholder
  confirms rather than composes.
- **Submit is disabled until the required elements exist**, with the missing
  ones listed in place ("Add who was there — 4 people means 4 names"). No
  server-side rejection for omissions the client could see.
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
coding + receipt/exception side by side:

- **Approve** → `codingState: "approved"`, audit `coding_approve`. The row
  can now be reconciled (documentation permitting).
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
the coding being open (a missing receipt keeps the coding open, so nothing
is lost by dropping the receipt-specific stream). At
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
   forever: members, volunteers, and guests did not consent to appearing in
   a public financial record, and some are minors. The ledger prints
   **headcount and affiliation mix** ("meal — 4 team members"), never names.
   Travel from/to publishes at city level.
2. **Publishable = three green axes**: documentation state
   (receipt/exception — the existing `documentationState`), coding state
   (approved), review state (reconciled). `isUndocumented` remains the
   publishing backlog for documents; a sibling `isUncoded` predicate becomes
   the backlog for substance. A **publishability report** per month (counts
   by axis, per chapter) is the close-gate artifact — it tells the ED
   exactly what stands between a period and publication.
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

## Phasing

1. **Backbone** — schema, enums, settings, gate, filters, audit actions,
   access resolver; coding editor in Reconcile (FM/bookkeeper-authored).
   Ships value immediately: the treasurer can start coding to the new
   standard.
2. **Self-serve** — My Transactions editor on `submitOwnCharge`'s bones,
   unified digest email, review/send-back loop, AI purpose-vagueness check.
3. **Reimbursement parity** — line-item fields in-app + token page,
   `changes_requested` loop.
4. **Publish prep** — publishability report, monthly-close gate, redaction
   policy doc. (Ledger page: separate plan.)

Each phase updates the Academy in the same PR: `finance-card-and-receipts`
(the coding duty joins the 7-day rule), `finance-reconcile-grid` (new
facets + review loop), `finance-receipt-exceptions` (lodging rule),
`finance-reimbursements-and-flags` (new required fields), and phase 2 likely
warrants a new lesson — *"Coding your charges: what the IRS and the public
ledger both need"* — plus quiz updates and a check of `academyPaths.ts` and
the capstone templates.

## Open questions (blocking phase 1 settings, not phase 1 build)

1. **Meal threshold basis** — recommend headcount (names ≤ 10, else
   headcount + group description). Optionally *also* require names on any
   meal over a dollar line (e.g. $75+) regardless of size? Owner call.
2. **`codingRequiredSinceMs`** — policy start date. Recommend the feature's
   ship date; historical cleanup scheduled separately.
3. **Reimbursement receipt exceptions** — keep the hard per-line receipt
   requirement for reimbursements (recommended: yes — reimbursements are
   voluntary submissions, unlike card charges that already happened)?
4. **Auto-convert uncoded to personal** after 60+N days — same teeth as
   receipts (recommended: yes, with the taxable-income explanation)?
5. **Alcohol flag** — yes/no.
6. **Public redaction policy** — confirm names-never, city-level travel,
   aggregated benevolence.
