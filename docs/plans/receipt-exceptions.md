# Receipt exceptions — documenting the un-documentable

**Status:** implemented (this PR)
**Owner ask (2026-08-05):** "we want to start publishing every transaction we
have… we've done our best to get every receipt, some receipts are lost /
unattainable, what's the best way to handle this? In the future I want a policy
where if there is no receipt the cardholder is responsible to pay for it, but
looking back I'm thinking we just have the ability to mark receipts as missing
or unattainable."

## The problem publishing exposes

Today the only way to close out a receipt-less transaction is to mark it
`reconciled` or `excluded`. `needsDocumentation` (`finances.ts`) ends the chase
on `reconciled` — "a treasurer who closed a row document-less made a call." That
is a defensible internal shortcut and an indefensible public one: a published
ledger cannot distinguish a properly-documented transaction from one somebody
quietly closed, and neither can we.

Marking a row "missing receipt" and moving on has the same defect in a nicer
font. What a public ledger needs is not an absence, it's **a substitute
document**: a named person stating, on the record, what this was for and why no
receipt exists.

## The model

A **receipt exception** is a first-class row (`receiptExceptions`) — the
documentation of record when no receipt can be produced.

### One concept, a reason axis

"Missing" and "unattainable" are not two states. They are two values of one
field. `RECEIPT_EXCEPTION_REASONS` (`packages/shared/src/finance.ts`):

| reason | meaning |
| --- | --- |
| `no_receipt_issued` | There never was one — cash tip, street parking, donation box. |
| `lost` | We had it; it's gone. |
| `predates_policy` | Before the org ran cards and receipts this way. |
| `vendor_unreachable` | Asked the vendor; they can't reproduce it. |
| `bank_record_only` | The statement line is the only evidence that exists. |

### Attestation, not a checkbox

Every exception carries a **note** (what the spend was for — the substitute for
the document), **who attested**, and **who approved**.

It can also carry **evidence**: `evidenceStorageIds`, a list of up to
`MAX_EXCEPTION_EVIDENCE` (**5**) files. Owner framing
(2026-08-05): *"we bought flowers for an event, we didn't get the receipt but
have pictures of the flowers at the event."* That is the strongest artifact an
exception can hold, and it's routinely several photos — hence a list, not a
single file. Bank statement lines, order-confirmation emails and calendar
invites live here too.

Evidence is deliberately **not** a receipt: never written to
`transactions.receiptStorageId`, never inserted into the `receipts` library,
never auto-matched to another charge. A photo of flowers proves the flowers
existed; it doesn't prove what was paid. Keeping that distinction visible is
the honest thing for a published ledger to do — and collapsing evidence into
"receipt" would also corrupt the documentation denorm cache the pure
predicates read.

The practical effect is that an exception is rarely a bare assertion. You
usually can't get the receipt, but you can almost always get *something*.

### Not a transaction status

Documentation state is orthogonal to review state — a row can be `reconciled`
*and* receipt-less. This is the same call already made for personal expenses
(see `PERSONAL_EXPENSE_STATES`' doc comment on why a 5th `TRANSACTION_STATUS`
was rejected). An exception is therefore its own row, pointed at from the
transaction by `transactions.approvedReceiptExceptionId`.

That pointer is set **only while an exception is approved**, written by exactly
one module (`lib/receiptExceptions.ts`) — the same single-writer discipline
`transactions.repaymentId` uses, so the denormalized pointer and the row's
`status` can never disagree. An invariant test pins it.

### Separation of duties

The cardholder attests; **someone else approves**. Without that, the forward
policy below is decorative — every cardholder simply self-exempts. Enforced in
`receiptExceptions.approveReceiptException` (the `campaigns.ts` state-machine
precedent), with a below-threshold carve-out:

- Under `financeSettings.receiptExceptionApprovalThresholdCents` (default
  **$75**, the IRS accountable-plan substantiation line), a bookkeeper+ may
  approve their own attestation — small-dollar exceptions are the long tail and
  a two-name ceremony on a $4 parking meter buys nothing.
- At or above it, the approver must be a different person, finance manager rank.

Both numbers are settings, not constants.

## Powers

Per the gate-it-behind-a-power rule, `lib/receiptExceptionAccess.ts` owns two
resolvers, and no call site checks seats inline:

- `requireAttestReceiptException` — file/withdraw an attestation. Today: the
  cardholder on their own charge, or bookkeeper+ on any row in scope. Graduates
  to the `finance.receiptException.attest` capability.
- `requireApproveReceiptException` — decide on one. Gated on the existing
  `finance.approve` capability / finance manager rank.

## Documentation state — the published truth

`documentationState(txn)` (`packages/shared/src/finance.ts`) is the single
predicate the public ledger renders, and it deliberately ignores `status`:

| state | meaning |
| --- | --- |
| `receipt` | A receipt document is attached. |
| `exception` | An approved, attested exception stands in for one. |
| `undocumented` | Neither. |

Publishing three states rather than two is the whole point. An exception is a
signed statement by a named person, not a hole — that reads as rigor. A ledger
claiming zero exceptions across three years of history would read as *less*
credible, not more.

`needsDocumentation` stays what it always was — the **chase worklist** — and
now treats an approved exception as closing the chase, exactly like a receipt.
The new `undocumented` reconcile pill is the separate, honest backlog: rows with
neither receipt nor exception, *including* ones already marked `reconciled`.
That pill is the historical cleanup queue, and it is the number that has to
reach zero before a period is publishable.

## Closing the back door

`setTransactionStatus` now refuses to move a row to `reconciled` when it owes
documentation and has neither a receipt nor an approved exception
(`RECEIPT_REQUIRED`). Going forward, `reconciled` means documented — which is
what makes the state publishable at all.

Existing rows are untouched: the guard is on the write, not the read, so the
legacy backlog stays visible in the `undocumented` pill instead of being
retroactively invalidated. Bulk paths skip such rows and report a count rather
than failing the whole batch.

## The forward policy was already built

`financeSettings.noReceiptAutoConvertDays` + `cards.autoConvertOverdueReceipts`
already convert an un-receipted card charge into a personal repayment after N
days, behind the day-3 escalation and day-7 auto-lock ladder. It ships `null` —
off. The owner's "cardholder is responsible" policy is a settings value, not a
build.

The coupling that matters: **an approved exception stops the auto-convert
clock** (`isMissingReceiptCharge` now excludes rows carrying one). Without it
the first cash tip at a venue becomes somebody's personal debt, and the policy
is punishing people for vendors' behavior rather than their own. With
separation of duties on the approval, the escape valve can't be self-served.

Order of operations for turning the policy on: clear the `undocumented`
backlog → set the threshold → set `noReceiptAutoConvertDays`.

## Reimbursements are a different bar

For a card charge the money is already gone, so an exception is bookkeeping.
For an out-of-pocket reimbursement the receipt *is* the evidence for paying
someone. "No receipt, no reimbursement" stays the default there; this feature
deliberately does not touch the reimbursement line-item requirement.

## Backfill

Nobody is clicking 400 rows. `attestBulk` applies one reason + one note across
an explicit list of transaction ids, still writing a **per-row** exception so no
row is anonymously waived. Most history is honestly `predates_policy` or
`bank_record_only`, and saying so plainly is the credible move.

## What is published

This PR ships the state and the vocabulary, not the public site. When the
public ledger lands, the recommendation is: publish merchant, amount, date,
budget category, and documentation state; publish the **exception's reason and
attestation**, since that is the point. Receipt *images* are a separate
decision — they routinely carry a card last-4, a personal address, or a
third party's name, so they want redaction review before they go out, not a
blanket publish.

## Academy

`finance-card-and-receipts` gains the exception path, and
`finance-chasing-receipts` gains the treasurer's side of it. The lesson's rule
("no receipt, no coverage") is unchanged and deliberately restated — the
exception is for spend where a receipt never existed or is genuinely
unattainable, decided by someone other than the spender. It is not a way out of
losing your receipt.
