# Contractor Payments — product spec

**Owner:** PM (events-os) · **Date:** 2026-08-14 · **Status:** proposal, not yet built
**Scope:** money OUT to a person who is **not** being repaid — a contractor performing
a service on agreed terms. Collect a W-9, an ACH destination, and a signed agreement;
approve it; pay it through Increase; publish it. No code written; every claim below is
checked against the repo at the file:line given.

---

## 0. The founder's ask, restated as decisions

| # | Founder said | Decision |
|---|---|---|
| 1 | "Create a sort of payments view" | `/finances/payments` (three screens), plus a `/payments` redirect so the literal URL works. **Not** an eighth finance chip. §1 |
| 2 | "Collect people's W9s" | Upload a **completed PDF**. We never collect a TIN as a field. §6 |
| 3 | "Pre-fill the amount… this is also a contractor agreement" | One record, `origin: "staff_prefilled"`, status `sent`, token minted at creation. §2 |
| 4 | "Copy the link and send it to the contractor" | `/contract/<chapterSlug>?token=…`, server-rendered HTML from Convex `http.ts`. Direct sibling of `/reimburse/`. §1.3 |
| 5 | "Get their bank account details… ACH through Increase" | `increaseExternalAccounts.createExternalAccount` verbatim. Raw routing/account numbers are **never persisted**. §4 |
| 6 | "Cascade to auto-fill all the coding stuff" | Staff supply the coding at pre-fill time; it materializes onto the outflow transaction at settle, exactly as a reimbursement's does. §4, §3.3 |
| 7 | "Make sure they know what's going to be public" | A disclosure panel above the service description, an explicit checkbox, and copy in §5. |
| 8 | "Comb through the implications of each field" | §4. This is the heart of the spec. |
| 9 | "After it's submitted, it sends an email" | Seven emails + two nudge sweeps. §7 |
| 10 | "A blank version… called /payments where they're asking to be approved" | Same table, `origin: "self_serve"`, enters at `submitted`. §2 |
| 11 | "Emailing treasurers on tasks… on what they need to do" | Submit-time email to every chapter treasurer + central FM, a day-3 nudge, a day-7 escalation to central. §7 |

**The one thing the founder did not ask about and must decide: a contractor's name
goes on the public ledger.** See §5.1. I am recommending yes. That is the only
decision in this spec I cannot make alone.

---

## 1. Where it lives

### 1.1 The internal desk — `/finances/payments`

The global sidebar (`apps/mobile/components/ui/AppShell.tsx:36-68`) has ten entries and
no room for an eleventh; Finances is one of them (`:48`). The finance sub-nav
(`apps/mobile/app/(app)/finances/_layout.tsx`) carries a standing founder directive at
`:36-60` — **"ONE ROW, NO NESTING"**, "a tab is a destination", "if a future workstream
wants a fifth thing under Cards, the answer is a menu on the Cards page, not a second
row here." That bar is currently at seven chips (`SEAT_TABS`, `:93-101`) and only just
got Reimbursements back (`:63-79`, founder 2026-08-14).

**Decision: no new chip in v1.** Contractor payments are the *same desk* as
reimbursements — money out, to a human, over ACH, approved under separation of duties,
landing as an `outflow` on the ledger. So:

| Route | File (new unless noted) | What it is |
|---|---|---|
| `/finances/payments` | `apps/mobile/app/(app)/finances/payments/index.tsx` | The queue. Sections: **Waiting on the contractor** · **Needs your decision** · **Approved, not yet paid** · **History** (collapsed). |
| `/finances/payments/new` | `.../payments/new.tsx` | The staff pre-fill composer → mints the link. |
| `/finances/payments/[id]` | `.../payments/[id].tsx` | One agreement: terms, contractor's submission, coding, decision buttons. |
| `/payments` | `apps/mobile/app/(app)/payments.tsx` | Ten-line redirect to `/finances/payments`. The founder typed this URL; it should resolve. |
| — | `apps/mobile/app/(app)/finances/reimbursements/index.tsx` (**edit**) | A two-item segmented control at the top of `ManagerReimbursementsScreen` (`:368-611`): **Reimbursements · Contractors**. Tapping Contractors routes to `/finances/payments`. |

Tradeoff, stated: discoverability now depends on the Reimbursements page carrying the
segment. That is worse than a chip and better than an eighth chip. **v2:** rename the
chip to "Payouts" and make the page genuinely two-segment — that is a founder
conversation plus an Academy edit (§9), not a v1 line item.

### 1.2 Do **not** build this into `/finances/reimbursements`

The record is close but not the same, and three of the differences are load-bearing:

1. **Tax.** A reimbursement is not income. A contractor payment is 1099-reportable.
   Sharing one table means every future tax query is a filter away from reporting a
   volunteer's gas money as contractor income, or missing a real payment. That is a
   filter nobody will remember in eighteen months.
2. **Receipts.** `reimbursements.ts:47-51` states the invariant plainly: receipts are
   "HARD-required per line with no exception path… a reimbursement is a VOLUNTARY
   submission." A contractor has no receipt — the *agreement* is the substantiation.
   Reusing the table means punching a hole in that invariant, and the Academy lesson
   at `packages/shared/src/academy/streams/finances.ts:1583` teaches it as absolute.
3. **The ledger label.** `lib/reimbursementTxnFields.ts:104-106` hard-writes
   `description = "Reimbursement to <payeeName>"`, and that string reaches the public
   ledger as `counterparty` (`apps/convex/schema/publicLedger.ts:384-386`). Publishing
   a contractor payment as "Reimbursement to Jane Doe" is a false public statement.

**What IS reused, verbatim, and must not be reimplemented:** the ACH rail
(`increaseExternalAccounts.createExternalAccount`), the `payouts` table and its state
machine (`lib/increasePayoutMachine.ts`), the Increase webhook mapping
(`payoutTargetFor`, `:180`), the external-account capture posture, the token/rate-limit
pattern, the email shell, and separation of duties.

### 1.3 The contractor-facing public page — `/contract/…`

Two public-surface precedents exist and they are not interchangeable:

- **Expo route outside the auth groups** — `apps/mobile/app/pay/[token].tsx`
  (`:11-13`: "Lives under `app/` OUTSIDE the `(app)`/`(auth)` route groups"). Read-only
  plus a redirect to Stripe. No file upload.
- **Server-rendered HTML from Convex `http.ts`** — `apps/convex/lib/reimbursePage.ts`
  + `lib/reimburseApiRoutes.ts`, mounted at `http.ts:1562-1607` on `pathPrefix:
  "/reimburse/"`. Self-contained inline CSS/JS, same-origin JSON API, file upload via
  `reimbursements.publicUploadUrl` (`:1827`), bank capture via `linkPublicBankAccount`
  (`:2109`), IP rate limiting (`reimburseApiRoutes.ts:62-80`).

**Decision: server-rendered, the `/reimburse/` shape exactly.** It is the only one of
the two that already does file upload and bank capture without an account, and a
contractor on a phone should never have to load an Expo bundle to get paid.

| Path | Handler | State |
|---|---|---|
| `/contract/<chapterSlug>` | new `lib/contractorPage.ts#renderBlankRequest` | The **blank, self-serve** form. Not pre-approved. |
| `/contract/<chapterSlug>?token=<token>` | `#renderAgreement` | The **pre-filled agreement**, terms locked, or — after submission — the status timeline. |
| `/api/contract/*` | new `lib/contractorApiRoutes.ts` | `submit`, `uploadUrl`, `attachTaxDoc`, `linkBank`, `accept`, `resubmit`, `cancel`. |

Path collision check against `http.ts`: existing prefixes are `/rsvp/`, `/r/`,
`/event/`, `/e/`, `/t/`, `/give/`, `/p/`, `/reimburse/`, `/unsubscribe/`, `/poll/`,
`/finances/` (the ledger, `:469`), plus the webhook paths. **`/contract/` is free.**

---

## 2. The two entry modes are one record

They are the same table, the same token, the same state machine, and the same review
queue. The only differences are **where they enter the machine** and **who supplied
which fields**.

```
origin: "staff_prefilled"                  origin: "self_serve"
─────────────────────────                  ────────────────────
staff fills terms + coding                 (nobody has filled anything)
        ↓                                          ↓
     [sent]  ── link copied/emailed          contractor opens /contract/<slug>
        ↓                                    fills terms AND identity AND bank
contractor fills identity/W9/bank                  ↓
contractor ACCEPTS the terms                       ↓
        ↓                                          ↓
              ────────────►  [submitted]  ◄────────
                                  ↓
                      treasurer reviews (and, for a
                      self-serve row, must CODE it —
                      nobody else has)
                                  ↓
                    approved → paying → paid
```

**Why one record and not two systems:** the contractor's half of the form is byte-for-byte
identical in both modes (name, email, address, tax classification, W-9, bank, acceptance).
The staff half is identical too (service, date, amount, coding, public purpose) — it is
only a question of *who typed it and when*. Two tables would mean two public pages, two
review queues, two email sets, and two chances for the ACH path to drift. The
`reimbursementRequests` table already proves the shape: it serves an accountless public
submission, an in-app member submission, and a manager queue from one row
(`reimbursements.ts:6-20`).

**Two consequences that must be enforced, not assumed:**

1. A `self_serve` row arrives with **no coding**. `approve` refuses until
   `categoryId`, `expenseType`, `businessPurpose`, and exactly one of
   `eventId`/`projectId`/`budgetId` are set. This mirrors the `CODING_REQUIRED` gate in
   `finances.setTransactionStatus` and stops an uncoded payment from reaching the ledger
   as "Uncategorized · None."
2. A `staff_prefilled` row's terms are **locked to the contractor**. The public page
   renders `amountCents` / `serviceDescription` / `serviceDate` as text, not inputs, and
   the server ignores any of those keys in a token-scoped submit — the same discipline as
   `repaymentLinks.ts:29-33` ("the client supplies which charges to settle; it never
   supplies an amount").

---

## 3. The state machine

### 3.1 Statuses

New tuple `CONTRACTOR_PAYMENT_STATUSES` in `packages/shared/src/finance.ts`, sitting
directly beside `REIMBURSEMENT_STATUSES` (`:1495-1514`) with a matching
`_STATUS_LABELS` record and `_TERMINAL_STATUSES` set.

| Status | Meaning | Terminal |
|---|---|---|
| `sent` | Link is live. Waiting on the contractor. (`staff_prefilled` only) | |
| `submitted` | Contractor completed and accepted; or a self-serve request landed. Awaiting a treasurer. | |
| `changes_requested` | Sent back to the contractor with a required note. | |
| `approved` | Payable. Coding is complete. | |
| `paying` | ACH in flight. | |
| `paid` | Money out, `outflow` transaction posted. | ✓ |
| `rejected` | Declined with a reason. | ✓ |
| `failed` | ACH bounced or returned. **Non-terminal**, deliberately — same as reimbursements (`helpers.ts` treats `failed` as live). | |
| `canceled` | Killed by staff or by the contractor. | ✓ |
| `expired` | Link went stale, nobody filled it. | ✓ |

**No `draft`.** Creating an agreement mints its token immediately, the way
`repaymentLinks.mintLink` does (`repaymentLinks.ts:71-84`). Staff editing before the
contractor submits is an edit to a `sent` row, not a separate state. One fewer state,
and "I made a typo in the amount" is handled by §3.4 rather than by a status.

### 3.2 Legal transitions

| From → To | Who | Gate | What fires |
|---|---|---|---|
| — → `sent` | Staff | `requireContractorPaymentsCompose` | Token minted. Optional "email it to them." `approvals` row `action:"edit"`. |
| — → `submitted` | Anyone with the chapter slug | none (IP rate-limited) | `origin:"self_serve"`. Treasurer email + contractor confirmation. |
| `sent` → `submitted` | Contractor (token) | token + acceptance + W-9 + bank all present | `agreementAcceptedAt` stamped. Treasurer email + contractor confirmation. |
| `sent` → `expired` | System (cron) | `expiresAt` passed | Nothing. Staff can re-open (mints a fresh token). |
| `sent` → `canceled` | Staff | compose | Token revoked. |
| `submitted` → `changes_requested` | Treasurer | `requireContractorPaymentsApprove` + SoD | **Required** note. Contractor email. `approvals` `action:"edit"`. |
| `submitted` → `approved` | Treasurer | approve + SoD + **coding complete** + **not a `w8ben*` payee** | `approvedAt`, `approvedByPersonId`. Contractor email. `approvals` `action:"approve"`. Auto-pay if `approvalPolicy.autoPayOnApproval` (`schema/finances.ts:1403`). |
| `submitted` → `rejected` | Treasurer | approve + SoD | **Required** reason. Contractor email. `approvals` `action:"reject"`. |
| `changes_requested` → `submitted` | Contractor (token) | token; **substantiation only** — never the amount | Treasurer email. Original `submittedAt` preserved (queue position is not a penalty — the rule `finances.ts` academy copy already teaches at `streams/finances.ts:1585`). |
| `approved` → `paying` | Treasurer or auto-pay | `requireContractorPaymentsApprove` + `assertDisbursementSoD` (`lib/increaseShapes.ts`) | `payouts` row; Increase `POST /ach_transfers` with `Idempotency-Key = contractorPaymentId`. |
| `paying` → `paid` | Increase webhook, or `markPaidManually` | — | `postContractorSpend` writes the `outflow` txn + materializes the coding. Contractor "you were paid" email. |
| `paying` → `failed` | Increase webhook | — | Treasurer email. Row stays live so it can be retried. |
| `paid` → `approved` | Increase `returned` webhook | — | The existing `reverseSettledPayout` walk-back. `paidNoticeSentAt` **cleared** (schema/finances.ts:906-915 explains why). Contractor + treasurer email. |
| `approved` → `canceled` | Treasurer | approve | Only while no live payout exists. |

**Refused everywhere:** any transition out of `paid`/`rejected`/`canceled`/`expired`
except the webhook-driven `paid → approved` reversal. Implemented as
`assertTransition(status, allowedFrom, verb)`, the identical helper
`reimbursements.ts` uses (`:2466`, `:2495`, `:2574`).

### 3.3 Separation of duties

Copy `reimbursements.ts#assertApprovalSoD` (`:2424-2438`) **verbatim**, including both
signals and its documented residual limitation (`:2416-2422`):

- roster link: `assertSeparationOfDuties(callerPersonId, payment.personId)` (`lib/finance.ts:609`)
- email match: the approver's own auth email vs `contractorEmail`, case-insensitive

Plus one contractor-payments-specific rule the reimbursement path does not need:

> **The person who pre-filled the agreement may not approve it.**
> `assertSeparationOfDuties(callerPersonId, payment.createdByPersonId)`.

This is the whole point of the pre-fill mode. A treasurer who can both set the amount
and approve the payment is a single point of failure with a bank account attached.
Practical consequence, and it is the right one: a chapter treasurer pre-fills, the
**central Financial Manager** approves — the same failsafe the Academy already teaches
for reimbursements (`streams/finances.ts:1589`).

### 3.4 Changing the terms after acceptance

**The single most important rule in this spec.**

Any edit to `amountCents`, `serviceDescription`, `serviceDate`/`servicePeriod`, or
`publicPayeeName` on a row where `agreementAcceptedAt` is set:

1. increments `agreementTermsVersion`,
2. clears `agreementAcceptedAt` / `agreementAcceptedName` / `agreementAcceptedIp`,
3. moves the row back to `sent`,
4. emails the contractor: *"The terms of your agreement with Public Worship changed.
   Please review and accept again — nothing will be paid until you do."*

Bank details, W-9, and address survive the reset (they are identity, not terms). This
is enforced in one place, a `resetAcceptanceIfTermsChanged` helper, so no future edit
surface can skip it.

---

## 4. Field-by-field

### 4.1 Legend

- **By** — S = staff (pre-fill), C = contractor, ⚙ = system
- **Public** — appears on the published public ledger
  (`financePublicationEntries`, `apps/convex/schema/publicLedger.ts:343`)
- **Audit** — written to the `approvals` trail (`schema/finances.ts:1409-1433`,
  `subjectType` widened with `"contractor_payment"`)

### 4.2 The agreement — `contractorPayments` (new table)

| Field | By | Req | Validation | PII | Public | Audit | Cascades into |
|---|---|---|---|---|---|---|---|
| `chapterId` | ⚙ | ✓ | scoping | — | as `bookLabel` | — | every read gate |
| `token` | ⚙ | ✓ | `crypto.randomUUID()` | — | **never** | — | the public page's entire authority |
| `status` | ⚙ | ✓ | the tuple, guarded transitions | — | — | ✓ | queue sections, payability |
| `origin` | ⚙ | ✓ | `staff_prefilled` \| `self_serve` | — | — | ✓ | entry status; whether coding is required at approve |
| `createdByPersonId` | ⚙ | opt | roster row | ✓ internal | — | ✓ | **SoD** (§3.3) |
| `publicPayeeName` | C (default = `legalName`) | ✓ | 1–120 chars, `MAX_MERCHANT_NAME_LENGTH` (`finance.ts:1589`) | ✓ | **✓ VERBATIM** as `counterparty` | ✓ | `transactions.merchantName`; ACH `individual_name` (22-char truncation, `increasePayouts.ts:369`) |
| `legalName` | C | ✓ | must match the uploaded W-9 | ✓ | ✗ | ✓ | 1099 aggregation; External Account `account_holder` description |
| `contractorEmail` | S then C | ✓ | `normalizeEmail` (`lib/access.ts`) | ✓ | ✗ | ✓ | every contractor email; **SoD second signal** |
| `contractorPhone` | C | opt | E.164-ish | ✓ | ✗ | — | nothing (contact only) |
| `mailingAddress` | C | ✓ if `taxDocKind === "w9"` | free text, ≤300 | ✓ | ✗ | — | 1099-NEC recipient block (v2) |
| `serviceDescription` | S (or C, self-serve) | ✓ | 10–`MAX_PURPOSE_LENGTH` (`finance.ts`) | risk — see §5.2 | **✓ VERBATIM** as `purpose` | ✓ | `transactions.description`; ledger `purpose` |
| `publicPurpose` | S/treasurer | opt | ≤`MAX_PURPOSE_LENGTH` | — | **✓** (overrides above) | ✓ (`coding_redact` shape) | the redaction escape hatch — §5.2 |
| `businessPurpose` | S | ✓ before approve | `codingFieldProblems` (`@events-os/shared`) | — | only if no `publicPurpose` | ✓ | materialized coding (`transactionCodings`) |
| `serviceDate` | S/C | ✓ | ms ts, ≤48h future, ≥3y past (the `reimbursementLineItems.transactionDate` rule, `schema/finances.ts:942-946`) | — | **✓** as `occurredAt` context | ✓ | ledger row; agreement PDF |
| `servicePeriodStart/End` | S | opt | start ≤ end | — | ✓ if set | ✓ | agreement text |
| `amountCents` | S (or C, self-serve) | ✓ | **non-negative integer**, > 0, ≤ a chapter ceiling | — | **✓** | ✓ | ACH `amount`; `payouts.amountCents`; budget spend |
| `expenseType` | S | ✓ before approve | `EXPENSE_TYPES` (`finance.ts:827`) — `general` for nearly all contractor work | — | ✓ | ✓ | coding branch |
| `categoryId` | S | ✓ before approve | active `budgetCategories` in chapter | — | **✓** as `categoryLabel` | ✓ | budget/category rollups |
| `fundId` | S | ✓ (`defaultFundId`) | `lib/finance.ts:79` | — | ✓ as `fundLabel` | — | fund rollups |
| `eventId` \| `projectId` \| `budgetId` | S | exactly one before approve | **mutually exclusive** — copy `createReimbursement`'s enforcement (`schema/finances.ts:846-852`) | — | ✓ as `eventLabel`/`budgetLabel` | ✓ | attribution, `forPickerCandidates` |
| `personId` | S | opt | roster row, same chapter | ✓ | ✗ | ✓ | SoD; 1099 aggregation key |
| `notes` | S | opt | ≤1000 | possibly | ✗ | — | nothing. Internal only, and the form says so. |
| `taxDocKind` | C | ✓ | `w9` \| `w8ben` \| `w8ben_e` | — | ✗ | ✓ | **blocks approve** when `w8ben*` (§6.2) |
| `taxClassification` | C | ✓ if `w9` | the 1099 taxonomy (§6.3) | — | ✗ | ✓ | 1099 vs corporate exemption |
| `taxDocumentId` | ⚙ | ✓ before approve | id into `contractorTaxDocuments` | — | ✗ | ✓ | the gated viewer |
| `bankAccountLast4` | ⚙ | ✓ before approve | 4 digits, recomputed at link time | ✓ (weak) | ✗ | — | display only |
| `externalAccountId` | ⚙ | ✓ before ACH | Increase object id | — | ✗ | — | ACH `external_account_id`; **its presence is what makes the payout real** rather than manual (`schema/finances.ts:874-878`) |
| routing / account number | C | ✓ | `assertRoutingNumber` / `assertAccountNumber` (`increase.ts`) | ✓✓ | ✗ | ✗ | **NEVER PERSISTED** — passed once to Increase, discarded (`increaseExternalAccounts.ts:44-47`) |
| `accountHolderName` | C | opt | ≤200 | ✓ | ✗ | — | External Account `description` |
| `funding` | C | ✓ | `EXTERNAL_ACCOUNT_FUNDINGS` | — | ✗ | — | ACH `funding` |
| `agreementAcceptedAt` | ⚙ | ✓ before approve | ms ts | — | ✗ | ✓ | payability |
| `agreementAcceptedName` | C | ✓ | typed name, must equal `legalName` case-insensitively | ✓ | ✗ | ✓ | the signature (ESIGN) |
| `agreementAcceptedIp` | ⚙ | ✓ | `clientIpFromRequest` (`reimburseApiRoutes.ts:62-80`) | ✓ | ✗ | ✓ | evidence of assent |
| `agreementTermsVersion` | ⚙ | ✓ | integer, bumped by §3.4 | — | ✗ | ✓ | acceptance invalidation |
| `publicDisclosureAckAt` | C | ✓ | checkbox timestamp | — | ✗ | ✓ | proves they were told (§5) |
| `reviewNote` | Treasurer | ✓ to send back | non-blank | — | ✗ | ✓ | the send-back email body |
| `rejectedReason` | Treasurer | ✓ to reject | non-blank | — | ✗ | ✓ | the rejection email body |
| `approvedByPersonId` | ⚙ | ✓ at approve | ≠ submitter, ≠ creator | ✓ | ✗ | ✓ | SoD trail |
| `payoutId` | ⚙ | at pay | `payouts` id | — | ✗ | — | the ACH rail |
| `sentAt` `submittedAt` `approvedAt` `paidAt` `expiresAt` | ⚙ | — | ms ts | — | `paidAt` → ledger `occurredAt` | ✓ | timeline, nudges, expiry sweep |
| `approvedNoticeSentAt` `paidNoticeSentAt` | ⚙ | — | exactly-once claim | — | ✗ | — | double-email prevention — copy the mechanism and its doc from `schema/finances.ts:882-915` |

Indexes: `by_chapter`, `by_token`, `by_chapter_and_status`, `by_person`,
`by_chapter_and_paidAt` (the 1099 year scan).

### 4.3 The tax document — `contractorTaxDocuments` (new table, deliberately separate)

```
chapterId, contractorPaymentId, storageId, kind, filename,
uploadedAt, uploadedIp, sha256, deleteAfterMs
```

**Why its own table.** `apps/convex/schema/publicLedger.ts:436-460` sets the precedent
exactly: `financePublicationGiverKeys` is separated from `financePublicationEntries`
because that data "must never be one forgotten projection away from going out." A W-9
carries an SSN. `contractorPayments` is read by a queue, a detail screen, a public
token page, an email payload builder and a CSV export — five projections, each one a
place someone could add `taxDocStorageId` to a return shape without thinking.

**No query returns `storageId`.** Not the queue, not the detail screen, not the public
page. The only way to see the file is `contractorPayments.taxDocumentUrl`, a query
gated by `requireContractorTaxDocView` (§8) that resolves the URL server-side and
writes an `approvals` row on every call.

**Why that matters concretely:** `apps/convex/storage.ts:24-33` — `storage.getUrl` is a
public query gated only by `requireUserId`. Any authenticated member who learns a
`_storage` id can resolve it to a servable file. That is fine for a person's avatar and
completely unacceptable for a W-9, and the mitigation is structural: the id never
leaves the server.

---

## 5. The public-ledger disclosure

### 5.1 What actually publishes — and the one open decision

A paid contractor payment becomes a `flow:"outflow"` transaction, exactly as a
reimbursement payout does (`lib/increasePayoutMachine.ts:47-127`,
`postReimbursementSpend`). When the month is published, `buildSnapshot` freezes it into
a `financePublicationEntries` row (`schema/publicLedger.ts:343`), which carries
`counterparty`, `purpose`, `categoryLabel`, `fundLabel`, `budgetLabel`, `eventLabel`,
`amountCents`, `occurredAt`, `expenseType`.

So the world will read, forever:

> **Aug 12, 2026 — $1,800.00 — Jane Doe Media — "Videography for the August 12 worship
> night: multi-cam capture, same-week edit, and delivery of a 3-minute recap"** —
> Production · Chapter Events

**The decision: publish the contractor's name.** I recommend yes, and here is the line
that makes it consistent rather than arbitrary:

> **Public Worship publishes who it PAYS. It never publishes who GIVES, and it never
> publishes who was in the room.**

That line is already the codebase's rule, not a new one. Commit `8d0840a` ("A gift on
the public ledger is a gift, and names nobody") stripped a wire's bank descriptor
because it named a *giver*. `schema/publicLedger.ts:335-341` refuses attendee and
traveler names because "members and guests did not consent to a public financial
record, and some are minors." Neither of those is a vendor. A vendor **is** consenting —
that is what §5.3's checkbox is for — and a nonprofit that publishes every transaction
but hides who it paid has published nothing that matters.

The mitigation for the individual-contractor case is `publicPayeeName`, which defaults
to `legalName` but is **the contractor's to change** to a business name, with the
disclosure telling them exactly what it is for.

*If the founder overrules this*, the change is one line in `postContractorSpend` —
write `merchantName = "Contractor payment"` and drop the name. Say so before build,
not after publication; §5's whole point is that publication is irreversible
(`packages/shared/src/publicLedger.ts:14-27`).

### 5.2 The field that will leak, and the two guards

`serviceDescription` publishes **verbatim**. A contractor writing their own description
on the self-serve form will eventually write "Counseling sessions for the Rodriguez
family, weeks of Jul 6 and Jul 13." That is a third party's private information on a
permanent public record.

Two guards, both required in v1:

1. **A server-side pattern check at submit.** Refuse (do not silently strip) a
   `serviceDescription` containing an email address, a phone-shaped number, or an
   SSN-shaped number, with the message: *"This goes on our public ledger — please
   describe the work without contact details or anyone's personal information."*
2. **`publicPurpose` as the redaction hatch.** The exact mechanism
   `transactionCodings.setPublicPurpose` already provides, audited as `coding_redact`
   (`packages/shared/src/finance.ts:359-365`): the treasurer rewrites the public
   sentence, the contractor's original is retained internally, and the trail records
   who rewrote it. The detail screen surfaces this as **"What the public will read"**,
   editable, with the contractor's original shown beneath it.

Third guard, free: publication is still a separate human act behind
`requireLedgerPublish` (`lib/publicLedgerAccess.ts:24-35`). Nothing here reaches the
world without someone pressing publish on the month.

### 5.3 The copy

**Panel, shown above the service description on both the pre-filled and blank forms —
before any field is touched:**

> ### Some of this will be public. Here is exactly which parts.
>
> Public Worship publishes every dollar it spends, every month, at
> publicworship.org/finances. It is a promise we make to the people who fund us.
>
> **What the public will see about this payment:**
> - the name below, as you enter it — a business name is fine
> - what the work was, in the description below
> - the amount and the date
> - which fund, budget, and event it came out of
>
> **What the public will never see:**
> - your email, phone number, or mailing address
> - your bank details
> - your W-9, your Social Security Number, or your EIN
> - anything you write in a note to us
>
> **Please do not put anyone's personal information in the description** — no names of
> people you worked with, no addresses, no contact details. Describe the work, not the
> people. If you are not sure, write less; our treasurer can add detail on our side.

**Inline, directly under the `publicPayeeName` field:**

> This is the name that will appear on our public ledger. Your legal name goes on the
> W-9 and stays private — if you work under a business name, use it here.

**Inline, directly under `serviceDescription` (pre-filled mode shows it read-only with
the same helper text):**

> This sentence is published word for word. "Sound engineering for the August 12
> worship night" — good. "Sound for Maria's event, call her at…" — please don't.

**The checkbox above Submit — required, stamps `publicDisclosureAckAt`:**

> ☐ I understand that my name, the description of the work, the amount, and the date
> will be published on Public Worship's public financial ledger, and that my contact
> details, bank information, and tax documents will not.

**On the confirmation screen and in the confirmation email:**

> **What happens now:** a treasurer reviews this, usually within a few days. You will
> get an email when it is approved and a second email when the money is actually sent —
> those are two different things, and the second one is the one to wait for. Payment
> arrives by ACH to the account ending •••• {last4}; most banks post it in one to two
> business days.
>
> **A month or so from now**, this payment will appear on our public ledger as:
> *"{publicPayeeName} — {amount} — {serviceDescription}"*. If any of that looks wrong,
> reply to this email before then.

That last block is the disclosure that actually works: showing them the rendered row.

---

## 6. W-9 handling

### 6.1 Upload a completed PDF. Do not collect a TIN as a field.

**Decision: file upload only.** The alternative — collecting name, address,
classification, and TIN as fields and rendering our own W-9 — is a better contractor
experience and an unacceptable engineering posture for this codebase today:

- An SSN as a Convex field lives in the document store, in backups, in every query
  result that forgets to omit it, and in the blast radius of any future `list` query.
- There is no field-level encryption anywhere in this repo. The one comparable secret —
  a card PAN — is never stored at all; it is fetched live from Increase behind a
  rate-limited, holder-only action (`cardDetailsRevealAttempts`,
  `schema/finances.ts:2407-2415`). That is the house standard for this class of data,
  and "store it in a plain field" is nowhere near it.
- The classification field we *do* need (§6.3) is not a TIN, and it is the only piece
  of the W-9 that drives a decision on our side.

The SSN is still inside the uploaded PDF. That is why the file lives in its own table,
its `storageId` is never projected, and viewing it is a logged, separately-gated act
(§4.3, §8).

Upload mechanics reuse the reimbursement path exactly: `contractorPayments.publicUploadUrl`
(token-scoped, mirroring `reimbursements.publicUploadUrl`, `:1827`) → client POSTs to
Convex storage → `attachTaxDoc` (mirroring `attachPublicReceipt`, `:1851`) with
ownership proven by the token, never a client-supplied id. Accept PDF/JPEG/PNG, ≤10 MB.

### 6.2 W-9 is right for US persons. It is wrong for everyone else.

- **US person** (citizen, resident alien, or US entity) → **Form W-9**. Payments are
  reportable on 1099-NEC.
- **Non-US individual** → **Form W-8BEN**.
- **Non-US entity** → **Form W-8BEN-E**.

Getting this wrong is not a paperwork error — a payment to a foreign person is
generally subject to withholding at source and reports on 1042-S, not 1099, and
Increase's ACH rail is domestic-only.

**v1 decision: collect the form, then stop.** The contractor picks their form type; if
they pick `w8ben` or `w8ben_e`:

1. The bank-details section is replaced with: *"We are not able to pay international
   contractors automatically yet. Upload your W-8BEN and submit — our finance team will
   contact you directly to arrange payment."*
2. `approve` **refuses** with `code: "FOREIGN_PAYEE_REVIEW"` and a message naming
   withholding as the reason.
3. The treasurer email is subject-flagged: *"[Needs manual handling] International
   contractor — {name}"*, and the queue row carries a "Foreign payee" badge.
4. The row can still be paid via `markPaidManually` (`increasePayouts.ts:442`) once a
   human has arranged it, so the ledger and the public record stay complete.

Refusing to guess is the correct behavior. Withholding math is a v2 project with a tax
adviser in the room, not a field on a form.

### 6.3 Classification

`taxClassification`, collected only for `w9`, matching the W-9's own checkbox list:
`individual_sole_prop`, `c_corp`, `s_corp`, `partnership`, `trust_estate`,
`llc_c`, `llc_s`, `llc_p`, `other`.

It exists for one reason: **corporations are generally exempt from 1099-NEC reporting,
and individuals/LLCs/partnerships are not.** Storing it at collection time means the
January 1099 run is a query, not a scavenger hunt through 40 PDFs.

### 6.4 Who can open the file, and for how long

- **Viewing:** `requireContractorTaxDocView` → `isCentralEdOrFm` (`lib/finance.ts:640`)
  in v1. **Deliberately not the approving treasurer.** An approver needs to know *"a
  W-9 is on file, legal name is Jane A. Doe, classification is individual/sole
  prop"* — which is metadata, rendered on the detail screen. They do not need the SSN
  to approve a payment. The person who files 1099s does.
- **Every view writes an `approvals` row** (`action: "view_tax_doc"`). A read that is
  never logged is a read nobody can investigate.
- **Retention:** the IRS expects a W-9 to be retained for four years after the tax year
  in which the payment was made. `deleteAfterMs` is stamped at upload as
  `end-of-tax-year(paidAt) + 4 years`; a sweep in `maintenance.ts` — which already runs
  TTL sweeps for the attempt tables (`crons.ts:150-158`) — deletes the stored file and
  nulls `storageId`, leaving the metadata row as proof it existed. Deleting an unpaid
  agreement's W-9 happens at `expired`/`canceled` + 90 days.

---

## 7. Notifications

All of these use the existing rails and nothing new: `sendEmail` + `emailShell` from
`ticketingEmails.ts`, block builders from `lib/emailShell.ts` (`emailHeading`,
`emailParagraph`, `emailPanel`, `emailButtonRow`), links via `appUrl`/`siteUrl`
(`lib/siteUrl.ts`). Every one is `ctx.scheduler.runAfter(0, …)` from the mutation,
`internalAction`, wrapped in try/catch, no-op without `RESEND_API_KEY` — the contract
`reimbursements.ts:2981-2988` spells out. New file `apps/convex/lib/contractorEmails.ts`,
kept out of `contractorPayments.ts` for the same reason `budgetDecisionEmails.ts` and
`campaignApprovalEmails.ts` are separate files (`budgetDecisionEmails.ts:14-21`).

| # | Trigger | To | Purpose / subject |
|---|---|---|---|
| 1 | Staff presses "Email this to them" on a `sent` row | Contractor | *"Public Worship would like to pay you $1,800.00"* — the terms, and the link. Optional; the copy-link button is the primary path. |
| 2 | `→ submitted` | **Every chapter treasurer + central FM**, minus the submitter | *"Approve a contractor payment — $1,800.00 to Jane Doe Media"*. Recipient resolution: `listChapterFinanceManagerPersonIds` (`lib/finance.ts:284`) with the de-dup and self-exclusion logic copied from `getReimbursementSubmittedEmailPayload` (`reimbursements.ts:2935-2957`). **This is the founder's "email treasurers on what they need to do."** Body states the one action: approve, send back, or reject. |
| 3 | `→ submitted` | Contractor | *"We have your details — here's what happens next"* + the §5.3 rendered-row preview. |
| 4 | `→ changes_requested` | Contractor | *"One thing to fix"* + the required `reviewNote` verbatim + the link back. Mirrors `sendReimbursementChangesRequestedEmail` (`:3089`). |
| 5 | `→ approved` | Contractor | *"Approved — $1,800.00 on its way."* Says plainly that approved ≠ paid. Guarded exactly-once by `approvedNoticeSentAt`. Modeled on `lib/reimbursementApprovedEmail.ts`. |
| 6 | `→ paid` | Contractor | *"$1,800.00 sent"* — date, method, last-4. Guarded by `paidNoticeSentAt`, **cleared on a `returned` reversal** so a genuine retry sends a genuine second notice. Modeled on `lib/reimbursementPaidEmail.ts:1-40`. |
| 7 | `→ rejected` | Contractor | *"We're not able to process this"* + the required reason. |
| 8 | `→ failed` / `paid → approved` reversal | Treasurers + contractor | *"The bank returned this payment"* + a link to re-enter bank details. |
| 9 | **Cron:** `sent` for 7 days, unsubmitted | Contractor | One nudge, once. *"Your agreement with Public Worship is still waiting."* |
| 10 | **Cron:** `submitted` for 3 days, undecided | Chapter treasurers | *"A contractor has been waiting 3 days to be paid."* |
| 11 | **Cron:** `submitted` for 7 days, undecided | **Central Financial Manager** | Escalation. *"{Chapter} has an undecided contractor payment from {date}."* Named recipients, so "nobody looked at it" has an owner. |

Sweeps 9–11 live in one `internalAction` (`sendContractorReminders`) registered in
`crons.ts` beside the existing `"reimbursement reminders"` entry (`crons.ts:50-53`),
running at the same 13:00 UTC / 9am EDT slot. Each nudge is stamped so it fires once —
the `purchaseFollowUpSentAt` mechanism (`schema/finances.ts:836-841`).

**Not in v1:** a task/todo row. `work.ts#myOpenWork` is project/task shaped
(`work.ts:23-40`) and a contractor payment is neither. The escalation email is the
mechanism; a real finance work-queue is its own project.

---

## 8. Access control

New file: **`apps/convex/lib/contractorPaymentsAccess.ts`**, following
`lib/repaymentsAccess.ts` and `lib/formsAccess.ts` in shape and in doc-comment style.
Every call site in `contractorPayments.ts` uses the `require*` form. **Nothing checks a
seat or a finance role inline.**

| Resolver | Today's body | Graduates to |
|---|---|---|
| `hasContractorPaymentsView` / `requireContractorPaymentsView` | `requireFinanceRole(ctx, chapterId, "viewer")` — same floor as every manager-facing finance read | `finance.contractors.view` |
| `hasContractorPaymentsCompose` / `requireContractorPaymentsCompose` | `requireFinanceManager(ctx, chapterId)` — creating an agreement is committing the org to an amount | `finance.contractors.compose` |
| `hasContractorPaymentsApprove` / `requireContractorPaymentsApprove` | `requireFinanceManager` + central reach | `finance.contractors.approve` |
| `hasContractorTaxDocView` / `requireContractorTaxDocView` | `isCentralEdOrFm(ctx)` (`lib/finance.ts:640`) — tighter than the rest of the file, on purpose | `finance.contractors.tax.view` |

Two of those deserve a note in the module doc:

- **compose ≠ approve** is a real split even though both are "finance manager" today,
  because §3.3 forbids the same *person* from doing both. The day these need different
  seats, the seam is already cut.
- **`finance.contractors.approve` should graduate as a seat capability, not a ladder
  rung** — the same asymmetry `lib/publicLedgerAccess.ts:24-35` argues for
  `finance.ledger.publish` and `campaigns.approve`: a power that commits money out of
  the building should be grantable and revocable per seat at runtime.

**Do not add the capability strings to `POWERS` in v1.** `lib/formsAccess.ts:29-31`
states the house rule explicitly: *"Do NOT add either capability string until that
decision is actually made — this file's job right now is only to name the seam."*
Naming a power on a seat chart is a roles change and pulls in §9's Academy obligation;
naming it in a resolver's doc does not.

### The contractor's own access

The `token` is the entire authority, and it authorizes exactly six things:

1. read this one agreement's public-safe projection,
2. get an upload URL and attach a tax document,
3. link a bank account (raw numbers → Increase, never persisted),
4. accept the terms,
5. resubmit after `changes_requested` — **substantiation only**, never the amount,
6. cancel.

It cannot read the chapter, list anything, resolve any other record, see the coding, or
see any other person. Every id the client submits is re-derived server-side from the
token, never trusted — `repaymentLinks.ts:26-33` is the precedent and its reasoning
applies here unchanged. The token is looked up by `by_token` and **never returned by any
in-app list query** (`schema/finances.ts:812-814`).

Revocation: cancelling or expiring a row revokes its token; re-opening mints a fresh
one (`repaymentLinks.ts:117`). A pre-filled link is idempotent per record — pressing
"Copy link" twice returns the same URL, because minting a new one would silently break
the one already texted (`repaymentLinks.ts:73-79`).

**Rate limiting:** reuse `reimbursementSubmitAttempts` (`schema/finances.ts:2388-2395`)
with a new key namespace — `contract:<ip>` for submits, `contractbank:<ip>` for bank
links. The table is already key-namespaced and already swept by `maintenance.ts`
(`crons.ts:150-158`), so this costs zero new tables and zero new crons.

---

## 9. Academy impact

Per CLAUDE.md, this is a user-facing feature with new vocabulary, new money rules, and
a new approval path. **It is training-worthy.** Three edits:

1. **New course: `finance-paying-contractors`**, in
   `packages/shared/src/academy/streams/finances.ts`, slotted immediately after
   `finance-reimbursements-and-flags` (`:1547`). ~5 minutes. Required blocks:
   - a `rule` block: *"Reimbursement is not the same as paying someone"* — a
     reimbursement returns money someone already spent; a contractor payment buys a
     service and is reportable income. Different form, different rules.
   - a `rule` block: *"The person who sets the amount never approves it"* (§3.3).
   - a `rule` block: *"What the contractor sees about the public ledger"* — so staff
     can answer the question before it is asked.
   - a `try_status` block on the lifecycle: `sent` → `submitted` → `approved` → `paid`,
     terminal `paid`, with a caption covering `changes_requested` and `expired`.
   - a `scenario`: *"The contractor emails after signing and asks for $200 more."*
     Correct answer: edit the agreement, which resets their acceptance and re-sends it.
     Wrong answer: pay them the extra separately.
   - a `scenario`: *"The contractor is based in Lagos."* Correct answer: W-8BEN, and it
     stops for a human.
2. **Edit `finance-reimbursements-and-flags`** (`:1552-1556`). It opens with *"Two
   situations, two flows"*. There are now three. One sentence, plus a pointer to the
   new course.
3. **`packages/shared/src/academyPaths.ts`** — add `finance-paying-contractors` to the
   `treasurer`, `financial_manager`, and `executive_director` role paths.
   `assertRolePathIntegrity()` runs at module load, so a mistake fails the typecheck
   rather than shipping.

**Also check, do not assume:** `finance-publishing-the-books` (`:2225`) enumerates what
publishes — add the contractor name/service line. And run the academy tests: capstone
templates in `apps/convex/lib/seed/templates.ts` reference real statuses and tabs, and
this PR adds a route.

**No seat definitions change**, because §8 deliberately adds no capability strings — so
there is no seat-coverage gap to close in `academyPaths.ts`.

---

## 10. Risks, edge cases, open questions — ranked

**1. Duplicate or ghost payment.** The worst outcome, and the most defended.
Mitigations, all existing: at most one live `payouts` row per record (the idempotency
key, `increasePayouts.ts:14-15`); Increase `Idempotency-Key = contractorPaymentId`, kept
stable so a network-timeout retry replays the same transfer rather than originating a
second (`:379-386`); the dead-replay guard in `applyAchTransfer` (`:215`). **New risk
this feature introduces:** `payouts.reimbursementId` is currently non-optional
(`schema/finances.ts:1178`). v1 makes it optional and adds `contractorPaymentId` +
`by_contractor_payment`, with a server assert that **exactly one** is set. I chose this
over the fully polymorphic `subjectType`/`subjectId` shape that `approvals` and
`financeAuditLog` use (`schema/finances.ts:1411-1418`, `:1550-1553`), because that is a
migration of a live money table and this is not the PR for it. Note the divergence in
the schema comment.

**2. The amount changes after the contractor signed.** §3.4 is the answer and it must
be built in v1, not deferred. Without it, a staff member edits `amountCents` on an
accepted agreement and we have a signature attached to terms nobody agreed to. The rule
is: touching terms invalidates acceptance, full stop.

**3. PII on the permanent public record.** §5.2. Two guards plus the publish gate. The
residual risk is a description that is personal without containing a pattern we can
detect ("counseling for the family on Elm Street") — which is why the treasurer's
`publicPurpose` rewrite exists and why the review screen leads with **"What the public
will read."** Publication is irreversible; an amendment is visible but the original
stays readable (`packages/shared/src/publicLedger.ts:14-27`).

**4. W-9 exposure.** §4.3, §6.4. The structural mitigation is that the `storageId` never
leaves the server, because `storage.getUrl` (`apps/convex/storage.ts:24-33`) is gated
only by `requireUserId` and would otherwise be a one-hop path from "member" to
"someone's SSN."

**5. Bank details entered wrong.** Increase does not validate that an account number
exists; a transposed digit produces a `returned` ACH days later, or — worse and rarer —
a successful credit to a stranger. Mitigations: double-entry confirmation of the account
number on the form; last-4 echoed in the confirmation email and on the "you were paid"
email so the contractor can catch it; the `returned` path already reverses cleanly
(`payoutTargetFor`, `lib/increasePayoutMachine.ts:177-200`) and re-opens the record. A
misrouted-but-successful credit is **not recoverable in-app** — it is a bank dispute, and
the spec should not pretend otherwise.

**6. The treasurer never responds.** Emails alone are not a system. §7's items 10 and 11
are the answer: nudge at day 3, escalate to a *named* central Financial Manager at day 7.
Open question: should day 14 auto-cancel and tell the contractor? **My call: no.**
Silently killing someone's payment is worse than leaving it open. It stays open and keeps
nagging.

**7. 1099 reporting.** The reporting threshold is a moving tax-policy input — the
long-standing $600 floor for 1099-NEC was raised for payments made after 2025, and it is
indexed going forward. **Do not hard-code it.** v1 adds
`financeSettings.contractor1099ThresholdCents` (`schema/finances.ts:2487`) and a CSV
export in `dataExports.ts`: payee, legal name, classification, tax-doc-on-file, total
paid in the calendar year, count of payments. That is what an accountant actually needs
in January. Generating and e-filing 1099-NECs is v2 and needs a tax adviser.
**Aggregation key, and its accepted weakness:** `personId` when present, else normalized
`legalName` + normalized `contractorEmail`. We do not store a TIN, so we cannot key on
the only truly stable identifier. Two payments to the same person under two email
addresses will not aggregate. The export flags near-duplicate names for a human. Open
question for the founder: is that acceptable, or does the January run need a manual
merge tool?

**8. International contractors.** §6.2 — collect the W-8, block the automatic rail,
flag for a human, allow `markPaidManually`. Do not guess at withholding.

**9. The contractor abandons the form.** `expiresAt` defaults to 30 days from `sentAt`;
one nudge at day 7; a sweep moves it to `expired`. Staff can re-open, which mints a fresh
token. Half-completed rows (W-9 uploaded, no bank) are the common case — the page
resumes exactly where they left off, because every sub-step commits independently, the
way `attachPublicReceipt` does.

**10. The contractor is also a team member.** Entirely legitimate — `engagements`
already models "the same person can volunteer at one event and be a paid vendor at the
next" (`schema/people.ts:319-323`). SoD (§3.3) handles the approval side. What it does
not handle: a person who is simultaneously the chapter treasurer and the contractor.
There, the roster-link check, the email check, **and** the creator check must all pass,
which in practice forces the central FM to approve. That is correct.

**11. Sandbox/production drift.** `createExternalAccount` uses the *current*
`financeSettings.sandboxMode` toggle (`increaseExternalAccounts.ts:33-42`), while
`payReimbursement` self-selects its environment from the chapter account's id prefix
(`increasePayouts.ts:317`). A destination captured while the toggle was flipped will not
match its payout's environment. This bug already exists for reimbursements; contractor
payments inherit it. **Not fixed in v1** — flagged here so it is a known issue and not a
surprise, and worth its own small PR.

**12. The public self-serve endpoint is a write surface for anyone.** IP rate limiting
(§8), no path from submission to payment without a human approval, and no coding supplied
by the submitter. The realistic abuse is junk rows in the treasurer's queue, not money
leaving. Acceptable.

**13. Open question — should a paid `engagement` become a contractor payment in one
click?** `engagements` already carries `service`, `amountUsd`, and
`paymentStatus: "unpaid" | "invoiced" | "paid"` (`schema/people.ts:332-370`), and that
`paymentStatus` is set by hand today and by nothing else (`engagements.ts:143`,
`:187`). That is the same fact recorded twice in two places, and it will drift. The
right end state is: pre-fill a contractor payment *from* an engagement, and flip the
engagement to `paid` when the payout settles. **Deferred to v2** — it is a genuinely
separate, genuinely valuable PR, and building it inside v1 doubles the surface area.

---

## 11. Scope cut line

### v1 — one PR

**Shared** (`packages/shared/src/finance.ts`): `CONTRACTOR_PAYMENT_STATUSES` +
`_STATUS_LABELS` + `_TERMINAL_STATUSES`, `TAX_DOC_KINDS`, `TAX_CLASSIFICATIONS`.

**Schema** (`apps/convex/schema/finances.ts`): `contractorPayments`,
`contractorTaxDocuments`; `payouts.reimbursementId` → optional +
`contractorPaymentId` + `by_contractor_payment`; `approvals.subjectType` += 
`"contractor_payment"`; `approvals.action` += `"view_tax_doc"`;
`financeSettings.contractor1099ThresholdCents`.

**Convex:** `contractorPayments.ts` (the state machine, both submit paths, the token
reads); `lib/contractorPaymentsAccess.ts`; `lib/contractorPage.ts`;
`lib/contractorApiRoutes.ts`; `lib/contractorEmails.ts`;
`lib/increasePayoutMachine.ts#postContractorSpend` + `settleContractorPaid`;
`http.ts` route registration; one `crons.ts` entry.

**Mobile:** `/finances/payments` (index, `new`, `[id]`); the `/payments` redirect; the
Contractors segment on the reimbursements manager screen.

**Academy:** the new course, the two-flows edit, the three role paths.

**Tests:** the state machine (every legal and illegal transition), SoD including the
creator check, §3.4's acceptance reset, the token authorizing exactly six things and
nothing else, the tax-doc `storageId` appearing in **no** query return shape, the
public-ledger projection carrying name/service/amount and carrying **no** email, phone,
address, or last-4.

### Deliberately deferred

| Deferred | Why |
|---|---|
| Multiple line items per payment | A contractor payment is one service for one amount. Reimbursements need lines because one request mixes a fare, a hotel, and a dinner. This does not. |
| Recurring / retainer contractors | Real need, real design work. Not v1. |
| 1099-NEC generation and e-filing | v1 ships the CSV. Filing needs a tax adviser. |
| W-8BEN payment rail and withholding | §6.2 blocks and flags instead. Correct is better than automatic. |
| `engagements` ↔ contractor payment linkage | Risk 13. High value, separate PR. |
| Auto-creating a `people` row of type `vendor` | Public forms creating roster rows is a spam vector and a person-centric-audiences decision. |
| Countersignature / real e-sign | v1's typed name + timestamp + IP + terms version is sufficient assent for an agreement of this size. |
| Second-approver-over-amount enforcement | `approvalPolicy.requireSecondApproverOverCents` exists (`schema/finances.ts:1399`) and is not enforced for reimbursements either. Fixing it should fix both at once. |
| Contractor accounts / an in-app portal | The token is the whole product. Do not build a login for someone we pay twice a year. |
| Renaming the finance chip to "Payouts" | §1.1. Founder conversation + Academy edit. |
| A finance work-queue / task surface | §7. The escalation email is the v1 mechanism. |

**If v1 must be split**, the seam is between the modes, not inside them: PR 1 ships
`staff_prefilled` end to end (composer → link → public agreement page → review → ACH →
ledger); PR 2 adds `origin: "self_serve"`, which is one enum value, one blank-form
render path, and the coding-required-at-approve gate. The public page is ~80% of the
work either way, so this saves less than it looks like — I would ship both.

---

## 12. What I need from the founder before build

1. **Does a contractor's name go on the public ledger?** §5.1. I recommend yes; it is
   one line either way, and it cannot be undone after a month is published.
2. **Sign off on the §5.3 disclosure copy**, particularly the checkbox wording — that
   sentence is what we would point at if a contractor ever objected.
3. **Is the 1099 aggregation weakness acceptable?** Risk 7. We cannot key on a TIN
   because we deliberately do not store one.
4. **Confirm `/finances/payments` over a new finance chip.** §1.1. If the answer is "no,
   it needs its own chip," that is fine — it is a rename plus an Academy edit, and I
   would rather do it deliberately than by accretion.
