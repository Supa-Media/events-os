# Contractor Payments — the returning contractor

**Owner:** PM (events-os) · **Date:** 2026-08-15 · **Status:** proposal, not yet built
**Increment on:** PR #746 / `85a33ac` (contractor payments, shipped 2026-08-14).
**Scope:** a contractor we have paid before does not fill the whole form again. Staff say
"it's Jane again" and her identity, tax form and payout destination carry — under a
consent rule, a retention rule and a confirmation rule that this spec exists to write.

This is an increment, not a redesign. Nothing in `CONTRACTOR_PAYMENT_STATUSES`, the
state machine, separation of duties, the token model, the ledger label, or the
"we never store a TIN / we never store bank digits" invariants changes. Every claim
below is checked against the repo at the file:line given.

---

## 0. The founder's ask, restated as decisions

> "Need to go back and make sure that we can keep a record so that we don't have to ask
> recurring people to resubmit the W9s and all that, and that it'll be like an autofill,
> like 'hey, it's this person', you know."

| # | Founder said | Decision |
|---|---|---|
| 1 | "keep a record" | A `contractorProfiles` row, **1:1 with a `people` row**. One roster, not two. §1 |
| 2 | "don't have to resubmit the W9" | The tax document detaches from the payment and attaches to the profile. Reused, not re-collected. §2, §3 |
| 3 | "it'll be like an autofill" | Identity, tax-doc status and a *proposed* payout destination carry. **Amount and service description never carry.** §5 |
| 4 | "hey, it's this person" | An explicit staff picker over saved contractors. The machine never guesses which returning contractor this is. §7 |
| — | *not asked, must be answered* | **A W-8 expires; a W-9 does not.** §2 |
| — | *not asked, must be answered* | **Retention now runs from the LAST tax year the document substantiates**, not the first. Today's sweep would destroy live substantiation. §3 |
| — | *not asked, must be answered* | **The contractor re-attests and re-confirms; we do not carry forward silently.** §4 |
| — | *incidental win* | A stable per-contractor key finally makes a year-end 1099 view possible. §6 |

**Three things I need from the founder before build — §12.** The one that changes the
shape of the feature is Q1 (opt-in vs. automatic saving).

---

## 1. Where the record lives: `people`, with a finance satellite

### 1.1 The question

`apps/convex/schema/people.ts:63-72` already carries a vendor concept and a stated
philosophy:

> `usualRateUsd` — "Typical fee when engaged as a PAID vendor" …
> "the same person can be a vendor on one event and volunteer on another, so these
> signals coexist rather than partition the roster."

`packages/shared/src/index.ts:1932` (`personaFromSignals`) derives `vendor` from
`usualRateUsd != null`. `apps/convex/schema/people.ts:341` (`engagements`) makes the same
argument one level down: "volunteer-vs-paid is NOT a property of a person, it's a property
of THIS engagement."

A standalone `contractors` table keyed by its own name/email would be easier to build and
would be a **second roster**. Two consequences, both bad and both permanent: every
dedupe problem in §7 doubles (now you can have duplicate people *and* duplicate
contractors, and they cross-product), and the People tab stops being the honest answer to
"who is this human and what have they done with us."

### 1.2 The call

**Identity lives on `people`. The payment-rail and tax facts live in a new
`contractorProfiles` table, keyed 1:1 by `personId`.**

Concretely: every reusable contractor **has a `people` row**, and `contractorProfiles`
is a satellite hanging off it — not an identity of its own. It holds nothing you would
want in a roster list query:

| Field | Why it is here and not on `people` |
|---|---|
| `externalAccountId`, `bankAccountLast4`, `bankConfirmedAt` | A payout destination one careless `people.list` projection away from the whole app. `people` is read by the People tab, org-chart pickers, audience resolution, the assistant's tools, reminder sweeps. |
| `taxDocumentId`, `taxDocKind`, `taxDocCollectedAt`, `taxDocValidUntil` | Same structural argument `contractorTaxDocuments` already makes for itself (`schema/finances.ts:1191-1199`) — keep the sensitive pointer off the row everything reads. |
| `taxClassification` | §6.3. A W-9 answer, not a roster fact. |
| `lastPaidAt`, `paymentCount`, `lifetimeCents` | Denormalized finance counters. A roster row should not carry money. |

This is the same move the shipped feature already made once and for the same reason —
**I am extending the tax-doc table's reasoning, not undoing it.** `contractorPayments`
kept identity and put the SSN-bearing pointer in its own table; `people` keeps identity
and puts the payout destination and tax pointer in its own table.

### 1.3 What this forces, and how we handle it

**Every reusable contractor needs a `people` row**, and the original spec deliberately
deferred "auto-creating a `people` row of type vendor" because *"public forms creating
roster rows is a spam vector and a person-centric-audiences decision"*
(`specs/contractor-payments-pm-spec.md`, Deferred table).

That reasoning still holds, and the resolution is simple: **a public submission never
writes to `people`.** A profile is created only by a staffer with compose rights, in one
of two moments:

1. **At compose**, by picking an existing roster person in the agreement composer
   (`createAgreement` already takes `personId` — `contractorPayments.ts:488, 503-506`).
2. **After the fact**, by pressing **"Save this contractor"** on a payment that has
   reached `paid`, which either links an existing person or creates one.

Both are staff-initiated, deliberate acts by someone who has looked at the payment. The
spam vector never opens. (Whether step 2 should instead fire automatically on `paid` is
**Q1 to the founder — §12.**)

Contact-only rows: a person created this way is a real participant, not a
`isContactOnly` contact row (`schema/people.ts:74-87`). We paid them; they belong on the
roster.

### 1.4 One change to persona, and it is the honest one

Today a person we have paid $4,000 in contractor payments reads as `volunteer` or
`contact` unless somebody separately typed a `usualRateUsd`. That is wrong, and the
persona ladder is exactly where it should be fixed:

- `packages/shared/src/index.ts:1932` — `personaFromSignals` takes a new
  `hasPaidContractorSignal: boolean`, placed at the **`vendor`** rung alongside
  `usualRateUsd != null`.
- `apps/convex/lib/peopleAggregate.ts` gains a trigger on `contractorPayments` so the
  `people.persona` cache (`schema/people.ts:204-227`) stays write-through-correct. The
  field's own comment is emphatic that it is a maintained cache and never a source of
  truth; this keeps that true.
- `personaOf` (`index.ts:1911`) is unchanged — it is deliberately the DB-free narrow
  form and cannot see another table.

**`usualRateUsd` is NOT auto-written from an agreed amount.** Its comment says "typical
fee", and one job's price is not a typical fee. It is *displayed* in the composer as a
hint (§5).

---

## 2. How long a tax form is good for

Researched, not guessed. Two different answers for two different forms, and the
difference is the whole section.

### 2.1 A W-9 does not expire

The IRS assigns no expiration date to a properly completed and signed Form W-9. It stays
valid as long as the information on it is accurate. There is no annual renewal rule.

A **new** W-9 is required when the payee's:

- **legal name** changes,
- **TIN** changes,
- **federal tax classification** changes (sole prop → S-corp, LLC election change, …),
- **exempt payee / exempt FATCA code** changes,
- **backup-withholding status** changes — they become subject to it, or stop being.

Separately, the requester-side re-solicitation rules: an IRS **CP2100/CP2100A ("B")
notice** for a missing or incorrect name/TIN starts a clock — a first B notice is
answered by a fresh signed W-9 (sent to the payee within 15 business days of the notice,
backup withholding at **24%** beginning no later than 30 business days after receipt if
unanswered); a **second** B notice within three calendar years is *not* answered by a new
W-9 at all — it requires SSA/IRS validation of the name/TIN pair.

**Product rule:** *we never expire a W-9 on a clock.* We re-ask on a **declared change**.
The contractor tells us; we cannot detect any of the five triggers ourselves because we
deliberately hold no TIN (`packages/shared/src/contractorPayments.ts:136-144`).

Two mechanisms, both in §4's returning-payee form:

1. **Every reuse carries a required attestation** — "my legal name, tax ID number, and
   tax classification are unchanged since the form you have on file," with a
   **"Something has changed"** escape that reveals the full upload block. One checkbox,
   one escape hatch, recorded with the same signature + IP + timestamp the acceptance
   already records (`contractorPayments.ts:1642-1645`).
2. **A calendar-year re-attestation floor.** On the first reuse in a *new calendar year*,
   the attestation is not pre-checked and the "Something has changed" option is given
   equal visual weight. Not IRS-required; it is the widely-followed practice and it costs
   one un-checked checkbox a year. It also refreshes the bank confirmation (§4) at a
   natural cadence.

**We do not build B-notice handling.** We have no TIN to match, no e-filed 1099 to be
notified about, and therefore no CP2100 will ever arrive at us in v1. When 1099 filing
ships (§6), B-notice handling ships with it. Note it in the schema comment so the next
person does not think we forgot.

### 2.2 A W-8BEN / W-8BEN-E genuinely expires

Form W-8BEN and W-8BEN-E are valid from the date signed **through the last day of the
third succeeding calendar year** — a form signed 30 Sep 2026 is valid through
**31 Dec 2029** — unless a change in circumstances makes any information on it incorrect,
in which case the payee must furnish a new form within **30 days**. (Narrow
indefinite-validity exceptions exist under §1.1441-1(e)(4)(ii); they turn on TIN-bearing
certificates and annual 1042-S reporting, neither of which we do. We ignore them and say
so.)

**Product rule and its consequence:**

- The upload form asks W-8 filers for the **date they signed the form**
  (`taxDocSignedOn`, one date input, defaulted to today, required for `w8ben`/`w8bene`
  only). We cannot read it off the PDF — nothing parses the form and nothing will
  (`schema/finances.ts:1201-1203`). Deriving expiry from the *upload* date would silently
  grant a longer window than the law does whenever someone signs in December and uploads
  in January. Ask.
- `taxDocValidUntil = Date.UTC(signYear + 4, 0, 1) - 1` for W-8 kinds; **undefined** for
  `w9`. New shared helper `taxDocValidUntil(kind, signedOn)` next to `taxDocPurgeAfter`
  in `packages/shared/src/contractorPayments.ts:179`.
- **An expired W-8 is not "on file."** The roster badge reads *"W-8BEN expired 31 Dec
  2029"* in the warning colour, the returning-payee form refuses the attestation path and
  shows the upload block only, and compose surfaces a banner. Approval is already
  hard-blocked for every W-8 (`isForeignTaxDoc`, `contractorPayments.ts` approve path),
  so the *money* consequence is nil — the reason to build it is that a badge saying
  "W-8BEN on file" when the form died two years ago is the product lying to a treasurer.

### 2.3 What the UI says, exactly

| Situation | Roster / composer badge | Returning-payee form |
|---|---|---|
| W-9 on file, attested this calendar year | `W-9 on file · confirmed 14 Aug 2026` | Attestation pre-checked; one tap. |
| W-9 on file, not yet attested this year | `W-9 on file · confirm for 2027` | Attestation **not** pre-checked, equal weight with "Something has changed". |
| W-9, contractor said something changed | `W-9 needed` | Full upload block, no attestation path. |
| W-8 on file, valid | `W-8BEN on file · expires 31 Dec 2029` | Attestation pre-checked. Existing W-8 approval block still applies. |
| W-8 expired | `W-8BEN expired 31 Dec 2029` (warning) | Upload block only. |
| No document | `No tax form on file` | Full form, exactly as today. |

---

## 3. Retention, corrected

### 3.1 The conflict, precisely

`attachTaxDocument` (`contractorPayments.ts:1495-1556`) stamps, at insert:

```
taxYear    = UTC year of THIS payment's serviceDate      (:1541)
purgeAfter = taxDocPurgeAfter(taxYear)                    (:1553)
```

and `taxDocPurgeAfter` (`packages/shared/src/contractorPayments.ts:179-181`) is
`Date.UTC(taxYear + 5, 0, 1)` — 1 Jan, four full years after the tax year ends.
`purgeExpiredTaxDocuments` (`contractorPayments.ts:2205-2231`) then deletes the file and
the row on a single indexed range scan of `by_purge_after`.

A document shared across payments breaks this two ways:

- **Purge on the FIRST payment's clock destroys later payments' substantiation.** A W-9
  collected for a Dec 2026 job purges 1 Jan 2031 — taking with it the only tax form
  behind a Nov 2030 payment that is still inside its own retention window.
- **Never purging defeats the promise.** `lib/contractPage.ts:429` tells the contractor
  their form "is destroyed four years after the tax year it covers", and the Academy
  teaches it as the rule that actually protects anybody
  (`academy/streams/finances.ts:1933` section, "That file has an SSN on it"). A W-9 that
  is never destroyed makes both statements false.

### 3.2 The corrected rule

**The retention clock runs from the LAST tax year the document substantiates, and it only
ever moves later.**

```
lastTaxYear = max(service year of every PAID payment citing this document)
purgeAfter  = taxDocPurgeAfter(lastTaxYear)
```

Recomputed on every attach/reuse. Monotonic by construction — `purgeAfter` never moves
earlier, so a document can never be scheduled to die inside a window it is still needed
for. New shared helper beside the existing one:

```
extendTaxDocRetention(current: { lastTaxYear }, newTaxYear) → { lastTaxYear, purgeAfter }
```

### 3.3 The document that was never actually used

A document whose payments all ended `canceled` / `rejected` / never left `sent` should
not sit in the bucket for four years on the strength of a payment that never happened.

```
if no PAID payment cites the document:
    purgeAfter = lastActivityAt + 180 days     (recomputed on each new activity)
```

Where `lastActivityAt` is the most recent submit/reuse. Short, sliding, and it keeps the
promise in the case where the promise is easiest to forget: **an SSN we collected for a
job that fell through is the one we have the least right to keep.**

### 3.4 What survives the purge

The purge must not erase the fact that a form *was* on file — that is itself part of a
payment's substantiation.

- `contractorPayments` gains denormalized, non-sensitive `taxDocKindOnFile`,
  `taxDocCollectedAt`, `taxDocPurgedAt`. No storage id, no TIN, nothing that can leak.
- `purgeExpiredTaxDocuments` (`:2205`) is extended: after deleting the file and the row,
  it stamps `taxDocPurgedAt` on every payment citing it (new index
  `contractorPayments.by_tax_document`) and clears the profile's `taxDocumentId` while
  leaving `taxDocKind` / `taxDocCollectedAt` for display.
- The detail screen then reads: *"A W-9 was on file, collected 14 Aug 2026, destroyed
  1 Jan 2032 under our retention policy."* True, useful, and holds no SSN.

**Do not change the storage-delete-then-row-delete order** (`:2200-2203`). Its comment
explains why, and the new stamping step goes *after* both.

### 3.5 Schema deltas on `contractorTaxDocuments`

`apps/convex/schema/finances.ts:1209-1233`, keeping the table and its doc comment's whole
argument intact:

| Field | Change |
|---|---|
| `contractorPaymentId` | **Meaning changes**, shape does not: now "the payment it was FIRST collected for". Update the comment; do not repurpose the field. |
| `contractorProfileId` | **New**, `v.id("contractorProfiles")`. The owner. New index `by_profile`. |
| `taxYear` | **Renamed in meaning** to `firstTaxYear`; keep the column, adjust the comment. |
| `lastTaxYear` | **New.** Drives `purgeAfter` per §3.2. |
| `signedOn` | **New**, optional. Required at write time for W-8 kinds (§2.2). |
| `validUntil` | **New**, optional. Derived, denormalized so a badge is a read not a computation. |
| `purgeAfter` | Unchanged shape; now recomputed, not write-once. `by_purge_after` unchanged. |
| `supersede-and-delete` (`contractorPayments.ts:1524-1536`) | **Scope changes** from "previous documents for this payment" to "previous documents for this PROFILE". The behaviour is right — a contractor uploading the correct form should replace the wrong one, file and all — the key it keys on is what moves. |

---

## 4. Consent: they act, we don't

### 4.1 The call

**Explicit re-confirmation by the contractor, every payment. Never silent
carry-forward.**

The contractor handed over a Social Security number and a bank account for **one job**,
having read a disclosure written about that job (`lib/contractPage.ts:344`,
`disclosureSection`). Reusing that material for a second job is a different act with a
different beneficiary and a different amount. Two independent reasons the answer is
"they act":

1. **It is their data and their disclosure.** The retention sentence they read said the
   form is destroyed four years after the tax year it covers. §3 changes what that
   sentence means. The person who agreed to the old sentence has to be told the new one.
2. **It is the only control that catches §4.2's failure.** No amount of server logic
   knows that Jane closed that checking account in March. The human who knows is Jane.

What we do **not** do is make them re-fill the form. The point of the feature survives:
this is a short page, not the long one.

### 4.2 What the returning-payee page shows

New `returningPayeeSection` in `apps/convex/lib/contractPage.ts`, rendered in place of
`taxDocFields()` (`:415`) and `bankFields()` (`:437`) when the payment carries a
`contractorProfileId` with usable material. Everything else on the page — the terms
block, the disclosure panel, the acceptance, the typed signature — is **unchanged**.

```
Welcome back, Jane.

We already have on file:
  ✓ W-9, collected 14 August 2026
  ✓ Bank account ending ••4412

[✓] My legal name, tax ID number, and tax classification are unchanged
    since that form.                                    ( Something has changed → )

( • ) Pay me at the account ending ••4412
(   ) Use a different account                           → reveals the bank block

We keep your W-9 so you don't have to send it again. It's stored securely,
visible only to the finance team, and destroyed four years after the last
tax year we pay you in. Nothing on it is ever published.
```

Both affirmations are **required to submit**. Neither is representable in any staff-side
mutation — copy the pattern `completeAgreement` already uses for terms
(`contractorPayments.ts:1563-1567`: "not accepted-and-ignored, but **unrepresentable**").
A staffer who "knows" Jane's account cannot tick this for her, ever.

Recorded on the payment and rolled up to the profile: `taxReaffirmedAt`,
`bankConfirmedAt`, alongside the existing `acceptedSignature` / `acceptedIp` /
`acceptedTermsVersion`.

### 4.3 Copy that becomes false and must change in the same PR

- `lib/contractPage.ts:429` — *"destroyed four years after the tax year it covers"* →
  *"destroyed four years after the last tax year we pay you in"* plus the reuse sentence.
- `lib/contractPage.ts:935` (the confirmation screen) — same sentence, same fix.
- `lib/contractPage.ts:393` — *"how the payment is reported at year end"* stays true and
  gets better (§6).
- The Academy rule at `academy/streams/finances.ts:1933`'s "That file has an SSN on it"
  block — §10.

### 4.4 Forget me

A durable record needs an off switch, and it is one mutation, so it ships now.

`contractorProfiles.forget` — gated on `requireContractorProfileForget` (§8), writes
`financeAuditLog`, and:

- deletes the tax document (file first, then row — same order as the sweep),
- clears `externalAccountId` / `bankAccountLast4` / `bankConfirmedAt`,
- leaves the `people` row and every payment's non-sensitive history intact,
- **refuses** while any non-terminal payment cites the document, with a message naming
  the payment. Destroying substantiation for money that has not moved yet is not a
  request we can honour.

One line on the public page tells the contractor the option exists and who to ask.

---

## 5. What autofills, and what must never

The founder's instinct — identity and tax-doc status carry, the amount and the service
description do not — is **correct and I am confirming it**, with two additions and one
sharpening.

| Field | Carries? | Why |
|---|---|---|
| `payeeName`, `payeeEmail`, `payeePhone`, `payeeBusinessName` | **Yes**, editable by the contractor on their page | This is the "hey, it's this person" the ask is about. |
| `personId` | **Yes** | It is the point. |
| Tax document (kind, collected date, validity) | **Yes**, as *status* subject to §2's attestation | The form itself is never re-shown to anyone; only that it exists. |
| `externalAccountId`, `bankAccountLast4` | **As a proposal only** | Written onto the payment at *submit*, after the contractor confirms (§4). Never at compose. |
| `categoryId`, `fundId` | **Yes** | "Media → Contractors" is a durable fact about the kind of work this person does. Visible in the composer, and re-coding voids nothing (`updateTerms`). |
| `agreedAmountCents` | **NO** | This job's terms. See §5.1. |
| `serviceDescription` | **NO — the hardest no in the spec** | §5.2. |
| `serviceDate` | **NO** | This job's date. |
| `eventId` / `projectId` / `budgetId` | **NO** | The attribution *is* which job this was. They are mutually exclusive by design (`assertSingleAttribution`, `contractorPayments.ts:244`); carrying one forward attributes new spend to an old event. |
| `agreementNotes` | **NO** | Internal, but job-specific. |
| `acceptedAt` / `acceptedSignature` / `acceptedTermsVersion` | **NEVER** | §11 risk 1. There is no standing agreement in this system. |
| `token` | **NEVER** | Every payment mints its own (`mintToken`, `:270`). An old link must never open a new job. |
| `approvedCents`, `reviewedByPersonId`, `reviewNote` | **NEVER** | Review is per-payment, obviously. |

### 5.1 The amount, and what `usualRateUsd` is allowed to do

`usualRateUsd`'s own comment says it "prefills a paid engagement"
(`schema/people.ts:63-64`). That is the **engagements** surface, not this one, and I am
drawing the line explicitly rather than letting the two blur:

- The composer **displays** `Usual rate: $400` next to the amount field, as a hint.
- The amount field starts **empty**. A staffer types a number every time.
- Tapping the hint fills it — one deliberate act, not a default.

An amount that arrives pre-filled is an amount nobody decided.

### 5.2 The description starts empty. Always.

`serviceDescription` publishes **verbatim and permanently** on the public ledger
(`schema/finances.ts:1105-1107`; `CONTRACTOR_LEDGER_COUNTERPARTY`,
`packages/shared/src/contractorPayments.ts:204`), and a published month can only ever be
amended in public. `publicTextProblems` (`:225`) is explicitly "deliberately crude" and
catches the accidental paste, not the thoughtful mistake. The last line of defence is a
human reading the sentence as a stranger would.

**A carried-forward description is a description nobody read.** So:

- The field starts empty and the form will not submit with it empty.
- The composer shows the contractor's **last description as read-only reference text**
  with an explicit **"Use this again"** button. Staff will otherwise copy-paste it from
  the previous payment anyway; making that one honest, visible click is better than
  pretending they won't.
- The server path is unchanged — `assertPublicDescription` (`contractorPayments.ts:190`)
  runs on every write regardless of where the text came from. Reuse gets no shortcut.

---

## 6. The 1099 gap this incidentally fixes

### 6.1 What was accepted at merge

`packages/shared/src/contractorPayments.ts:140-144` states it plainly: no TIN is stored,
so "1099 aggregation at year-end keys on the PERSON, not on a TIN, so two rows for the
same human under different names will not self-combine."

A durable `contractorProfiles` row **is** that stable key. It does not give us a TIN and
it does not make the total *correct* — it makes it **addressable**, and it turns the
failure from "invisible" into "visible and fixable" (§7).

### 6.2 In scope now: the view, not the form

**Ships:** a year-end aggregation screen, `/finances/payments/1099`, gated on
`requireContractorProfilesView`:

- **Input:** chapter + calendar year.
- **Rows:** grouped by `contractorProfileId`, over `contractorPayments` with
  `status: "paid"` and `paidAt` inside the year. Per row: payee name, business name, the
  tax form on file and its collected date, total cents, payment count, and a **`≥ $600`**
  flag.
- **Threshold:** `CONTRACTOR_1099_THRESHOLD_CENTS = 600_00`, a **shared constant**, not
  `financeSettings`. The original spec proposed a settings field; that was wrong — the
  threshold is federal law, not a chapter preference, and a settable field invites
  someone to "adjust" it.
- **Three sections, not one list**, because the honest report is the one that shows its
  own gaps:
  1. **Reportable** — W-9 on file, total ≥ threshold.
  2. **Under threshold** — W-9 on file, below. Shown, because a second payment in
     December moves the row.
  3. **Needs attention** — split into *Unattributed* (paid payments with no
     `contractorProfileId` — the exact thing §7 exists to shrink), *Foreign payees*
     (W-8 kinds; these are 1042-S territory, not 1099, and are segregated rather than
     silently included), and *No tax form on file* (should be empty; if it isn't, that
     is a finding).
- **No CSV export in v1.** §9.

### 6.3 One field to add while we are here: tax classification

The original spec specified `taxClassification` (§6.3 there — `individual_sole_prop`,
`c_corp`, `s_corp`, `partnership`, `trust_estate`, `llc_c`, `llc_s`, `llc_p`, `other`)
and the shipped code does not have it. It matters because **corporations are generally
exempt from 1099-NEC reporting and individuals / LLCs / partnerships are not**, so
without it the report cannot say who actually needs a form.

It is not a TIN. It is one radio group. And the durable record is what makes it cheap:
asked **once per contractor**, not once per payment. `CONTRACTOR_TAX_CLASSIFICATIONS`
goes in `packages/shared/src/contractorPayments.ts`, the field goes on
`contractorProfiles`, the question goes on the W-9 branch of the public form only.
**Q2 to the founder — §12** (it is one more question on a stranger's form).

### 6.4 Explicitly out of scope

Generating or e-filing 1099-NEC; IRS TIN matching; B-notice handling (§2.1); correction
filings; state filings. All need a tax adviser and most need a TIN we deliberately do not
hold. What ships is the number a human takes to their accountant, plus an honest list of
what the number is missing.

Worth stating so nobody re-derives it: we pay by ACH from our own bank account through
Increase, not through a third-party settlement network, so these are 1099-NEC payments,
not 1099-K.

---

## 7. Identity matching and dedupe

### 7.1 What is there today, and why it is weak

`submitPublicRequest` (`contractorPayments.ts:1739-1746`):

```ts
const personMatch = await ctx.db
  .query("people")
  .withIndex("by_email", (q) => q.eq("email", email))
  .first();
```

Three problems, in increasing order of how much they will cost:

1. It matches `people.email` only — and **`personEmails` exists precisely for this**
   (`schema/people.ts:271-308`): a per-person ledger of every address known for them,
   with provenance, built so a repeat giver or guest "links to the SAME person instead of
   spawning a duplicate". Contractor matching is the same problem and ignores the
   solution already in the repo.
2. `.first()` on a non-unique index **silently picks one of N**. When two roster rows
   share an address, the match is arbitrary and nothing says so.
3. It is a convenience the comment is honest about ("never an identity claim") — which
   was fine when the link only decorated a review screen. Once the link decides whose
   W-9 gets reused and whose 1099 total a payment lands in, "best-effort" is no longer a
   sufficient standard.

### 7.2 The rules

1. **Match on `personEmails`, not `people.email`.** Normalized address, chapter-scoped,
   via the existing `by_email` index (`schema/people.ts:308`).
2. **Never match on name.** Not exact, not fuzzy, not "name + last four". Two Jane Does
   is a normal thing for a roster to contain.
3. **Ambiguity is surfaced, never resolved.** If the address resolves to **≥ 2 people**,
   attach **none**, set `identityReviewNeeded: true` on the payment, and show the
   reviewer: *"This email matches 2 people — Jane Doe (roster) and Jane Doe (contact).
   Pick one, or leave unlinked."* A treasurer picks. **`.first()` silently choosing is
   strictly worse than not choosing**, because a wrong link is invisible and no link is
   visible.
4. **Reuse is never inferred.** The composer's "it's Jane again" is an explicit picker
   over `contractorProfiles` scoped to the chapter. The system offers candidates; a human
   selects. No public path ever creates or selects a profile (§1.3).
5. **A profile is never auto-merged.** Merging is a deliberate, gated, audited act (§7.3).

### 7.3 Merge — and a live bug to fix on the way

`apps/convex/lib/people.ts#repointPersonReferences` (`:105-300`) repoints twelve tables:
`checkIns`, `docs`, `engagements`, `eventItems`, `events`, `people`, `projectComments`,
`projectEmailTokens`, `projects`, `responsibilities`, `roleAssignments`, `songs`.

**None of them are financial.** `contractorPayments.personId` and
`contractorTaxDocuments.personId` are not repointed, and neither is anything in
reimbursements. **This is a bug today, before this feature exists**: merging two people
right now orphans a contractor payment's roster link, silently, and `mergePersonInto`
(`:318`) then deletes the duplicate row the payment points at.

This PR fixes it, because after this PR a merge moves **tax documents**, which raises the
stakes from "a broken link" to "the wrong person's W-9 attached to the wrong human."

Merge semantics for the contractor material:

| Thing | Rule |
|---|---|
| `contractorPayments.personId` / `contractorProfileId` | Repointed to the survivor. |
| `contractorTaxDocuments.personId` / `contractorProfileId` | Repointed to the survivor. |
| Two `contractorProfiles` rows | Survivor keeps its own; the duplicate's row is folded in. |
| Two tax documents | Keep the one with the later `collectedAt`; the loser's **file is deleted** (never orphaned). `lastTaxYear` = max of both, so retention extends rather than shortens (§3.2). |
| `externalAccountId` | **Cleared, not merged.** Two bank accounts for one merged human is not a question we can answer, and guessing sends money somewhere. The next payment re-asks (§4). |
| `taxClassification` | Blank-fill only, matching `CARRY_SCALAR`'s existing posture (`lib/people.ts:~290-307`). |
| Counters (`paymentCount`, `lifetimeCents`) | Summed. |

**And a gate.** `dataHygiene.ts#mergePeople` (`:727-742`) is gated on `isChapterAdmin` —
which is **not** the finance ladder. A chapter admin who is not a finance manager can
today merge two people; after this PR that action moves a tax document. So: if either
person carries a `contractorProfiles` row, `mergePeopleCore` additionally requires
`requireContractorProfileManage` (§8). One extra check, at the one call site.

---

## 8. Access

Three new has/require pairs in `apps/convex/lib/contractorPaymentsAccess.ts`, following
that file's existing four rungs exactly (`:42`, `:67`, `:98`, `:139`) — bodies are
today's finance ladder, graduation names reserved in the doc comment so the eventual PR
does not invent them under pressure. Per CLAUDE.md, the resolver is written even though
today's answer is "the finance ladder".

| Resolver | May | Today's body | Graduates to |
|---|---|---|---|
| `hasContractorProfilesView` / `requireContractorProfilesView` | See the contractor roster, a contractor's payment history, the 1099 view | `requireFinanceRole(ctx, chapterId, "viewer")` — same floor as `requireContractorPaymentsView` | `finance.contractors.roster.view` |
| `hasContractorProfileManage` / `requireContractorProfileManage` | Create/link a profile, edit stored identity, merge two contractors, correct a bad match | `requireFinanceRole(ctx, chapterId, "manager")` — same rung as compose, because linking a profile decides whose bank details a future payment proposes | `finance.contractors.roster.manage` |
| `hasContractorProfileForget` / `requireContractorProfileForget` | §4.4 — destroy a stored tax document and clear the payout destination ahead of schedule | `requireFinanceRole(ctx, chapterId, "manager")` | `finance.contractors.forget` |

Capability strings go in `POWERS` (`packages/shared/src/powers.ts:184`, re-exported as
`SEAT_CAPABILITIES` from `packages/shared/src/seats.ts:66`) **only when they graduate** —
not now. Reserving the names in comments is the point of the pattern; adding unused
strings to the seat chart makes the chart lie about what seats can do.

### 8.1 The sentence that matters most in this section

**`requireContractorTaxDocView` is unchanged, and roster access does not imply it.**

The roster shows `W-9 on file · collected 14 Aug 2026` — metadata. Opening the file is
still the separately-gated, separately-logged, most-sensitive-read-in-the-application act
it is today (`contractorPaymentsAccess.ts:115-144`, `contractorPayments.ts:1123-1166`).
**Reuse must not become a side door to the file.** Any code path that hands a `storageId`
out of a roster query is the failure this whole design is arranged to prevent.

### 8.2 Two additions to the tax-doc read path

1. **A profile-scoped `viewTaxDocument`.** Same gate, same mutation-not-query reasoning
   (`:1115-1119`), same `financeAuditLog` write before the URL is issued. Requires adding
   `"contractor_profile"` to `approvals.subjectType`
   (`apps/convex/schema/finances.ts:1666-1689`) — one literal.
2. **A rate limit, which the roster newly makes necessary.** Today a tax-doc view costs
   you navigating to one payment you had a reason to open. With a roster it costs you a
   click, and N clicks scrapes N SSNs. Add `contractorTaxDocViewAttempts` — same shape
   and index as `cardDetailsRevealAttempts`
   (`apps/convex/schema/finances.ts:2670-2677`), keyed `"actor:<personId>"`, swept by the
   existing `maintenance.ts` TTL job. **This is the one genuinely new control the
   durable record forces**, and it is the cheapest thing in the PR.

---

## 9. Privacy blast radius

Said plainly, because this is the part a convenience feature hides:

**Before this PR**, a contractor's tax form is reachable only from one payment's detail
screen, by someone who already had a reason to open that payment. There is no list of
people we have paid; the closest thing is a queue ordered by recency.

**After this PR**, there is a searchable roster of every human the organisation has ever
paid, each row one tap from a PDF with a Social Security number on it, and each row
carrying a lifetime total. We are building the object that a single compromised
finance-manager session would most want. That is not a reason not to build it — it is the
reason the following are **required, in the shipping PR, not after**:

1. **The roster query never projects a `storageId`.** Structural, exactly as
   `contractorTaxDocuments`' own doc comment argues (`schema/finances.ts:1191-1199`).
   Enforced by a test that asserts the id appears in **no** query return shape — the
   shipped feature already has this test; extend it to the new queries rather than
   writing a second one.
2. **No bulk export of the roster or the 1099 view in v1.** A list you read one row at a
   time is a materially different risk from a file you can attach to an email. When an
   export ships it carries name + total + form-kind and nothing else, behind its own
   capability. (§6.2)
3. **Every profile-scoped tax-doc view is logged**, with the profile id, before the URL
   is issued (§8.2).
4. **Views are rate-limited** (§8.2). This is what turns "read one form" and "scrape
   forty" back into different acts.
5. **Retention still bites, and the profile is not the document.** The profile survives
   the purge; the SSN does not. From 2032, a contractor last paid in 2027 has a roster row
   reading *"W-9 destroyed 1 Jan 2032"*. **The list of people we have paid and the list of
   SSNs we hold are two different objects, and only the first one is durable** — that
   sentence is the whole privacy answer and it should be in the schema comment.
6. **Search is by name and email only.** Never by last four, never by any tax identifier
   — we have none, and this is one of the reasons to keep it that way.
7. **`forget` exists and is reachable** (§4.4), and the public page says so.
8. **Chapter scoping is absolute.** A profile belongs to one chapter, like everything
   else in this codebase. A contractor paid by two chapters has two profiles.
   (**Q3 to the founder — §12**; I am confident this is right, and it is worth confirming
   because it means two W-9 uploads for one human.)

---

## 10. Academy impact

Per CLAUDE.md this changes user-facing behaviour, a money rule, and a privacy promise.
**It is training-worthy, and one existing sentence becomes factually false.** No new
lesson — both changes belong in the two lessons that already exist.

### 10.1 `finance-contractor-tax-and-privacy` (`academy/streams/finances.ts:1933`) — REQUIRED

1. **The `rule` block "That file has an SSN on it. Treat it like it does."** currently
   says the form is *"destroyed four years after the tax year it covers"*. §3.2 makes
   that false. Rewrite to: destroyed four years after the **last** tax year we paid them
   in, plus one sentence explaining why (we keep it so they don't re-send it, and an
   active contractor's form is a live business record) and one making the limit real
   (a contractor we stop paying has their form destroyed on schedule, and the record says
   the date).
2. **The `tip` block "A W-8 stops the payment, on purpose."** gains the expiry: a W-8BEN
   or W-8BEN-E is only good through the end of the third year after it is signed, and an
   expired one is not "on file" (§2.2).
3. **The `bullets` item "We never store their bank details."** gains the two new rules:
   the contractor confirms the account on **every** payment, and a bounced payout
   **clears** the stored account so the next one has to be re-entered.
4. **Quiz.** Question 3 ("who can open a contractor's actual W-9 file") — its explanation
   repeats the four-years-after-the-tax-year-it-covers line; fix it there too. Question 4
   ("can you read me back the account number") stays correct **and must stay** — it is
   the answer staff will need more often once an account is on file. Add one question on
   what reuse does and does not carry.

### 10.2 `finance-paying-a-contractor` (`academy/streams/finances.ts:1781`) — REQUIRED

1. **New `bullets` item: "A returning contractor."** They get a short page, not the long
   one: we already have their tax form and their account, so they confirm both rather
   than re-uploading. The terms and the signature are **new every single time**.
2. **The `rule` block "Changing the terms unsigns the agreement"** gains a closing
   sentence: reuse never carries a signature forward. Every payment is its own agreement
   at `agreementTermsVersion: 1`, accepted fresh.
3. **New `scenario`:** *"You're paying Jane for the third time this year. What's already
   filled in, and what isn't?"* Correct: her name, email and tax-form status carry, and
   her account is proposed for her to confirm — the amount and the description are blank,
   because those are this job's terms and the description publishes verbatim.
4. **Quiz:** one question on the same distinction.

### 10.3 Checked and unchanged — stated so nobody re-checks

- **`finance-publishing-the-books`** — nothing new publishes. `CONTRACTOR_LEDGER_COUNTERPARTY`
  is untouched; the ledger row is byte-identical whether the contractor is new or
  returning. No edit.
- **`packages/shared/src/academyPaths.ts`** — no seat definitions change (§8 reserves
  capability names but adds no strings to `POWERS`), so no role path changes and
  `assertRolePathIntegrity()` has nothing new to cover.
- **`apps/convex/lib/seed/templates.ts`** — capstone quests reference real statuses and
  tabs. This PR adds no status and no tab; it adds one screen under an existing route.
  **Run the academy tests anyway** (`packages/shared/src/academy.snapshot.test.ts` — both
  lessons are enumerated at `:762-763` and `:1322-1330`; the snapshot will need
  regenerating for the copy edits, which is the mechanism working).

---

## 11. Risks, ranked

**1. Autofill makes it too easy to pay someone without anyone re-reading the terms.**
The founder named this and it is correctly first: the entire feature removes friction
from the one act in the finance domain that should keep some. Four defences, all
structural rather than advisory:

- **The amount and the description never carry** (§5). The two fields that decide how
  much leaves and what the public is told start empty every time.
- **The acceptance never carries.** Every payment is its own agreement, minted at
  `agreementTermsVersion: 1`, signed fresh, against a fresh token. **There is no such
  thing as a standing agreement in this system**, and if a future PR proposes one it is
  proposing to delete this defence — say so in the schema comment.
- **Separation of duties is untouched** — still two-layered, still checked at approve and
  again at pay, still counting the composer as a party (`assertContractorApprovalSoD`,
  `contractorPayments.ts:326`).
- **The contractor still has to act** (§4). A payment cannot complete on staff input
  alone, before or after this PR.

**2. Money to a closed or reassigned account.** A bounced ACH is recoverable; money into
a *reassigned* account number is not. Defences: confirm-every-payment (§4.2), no
pre-selection past 12 months, staff cannot confirm on the contractor's behalf, and — the
one that does the most work — **a `failed` payout clears the profile's stored account**,
so the next payment forces re-entry. Today nothing anywhere acts on a bounce as evidence.

**3. The searchable list of everyone we have ever paid.** §9, seven mitigations, all in
the shipping PR.

**4. Retention extends indefinitely for an active contractor — and that is correct, so
the copy has to say it.** A contractor paid every year never has their W-9 destroyed
while they keep being paid. That is the right answer (an active contractor's form is a
live business record) and it is a promise change. The failure mode is not the behaviour,
it is saying "four years" and meaning "for as long as we like": mitigated by §4.3's copy,
§10.1's lesson edit, and a **computed destruction date shown on the profile** so nobody
has to reason it out.

**5. Duplicate profiles silently split a 1099 total.** Two profiles for one human is a
wrong number on a tax document. §7's matching, the visible *Unattributed* bucket in §6.2,
and the merge path are the answer; the residual risk is real and is why §6 ships the
report that shows the gap rather than a form that hides it.

**6. A person-merge orphans financial links — live today.** §7.3. Fixed here, and the
fix is the prerequisite for everything else in §7.

**7. A staffer confirms the bank account on the contractor's behalf.** Prevented by
making the fields unrepresentable in staff mutations (§4.2), not by policy. Policy loses
to a helpful staffer with a contractor on the phone.

**8. An expired W-8 is presented as "on file".** §2.2. Money impact nil (W-8 approval is
already blocked), credibility impact real.

**9. A carried `categoryId` repeats a miscoding forever.** Accepted. Coding is visible in
the composer, changing it voids no acceptance, and the alternative — no coding carry —
throws away most of the "cascade the coding" value the original spec's item 6 promised.

**10. A "forget me" request lands mid-payment.** Refused with the payment named (§4.4).
Destroying substantiation for money that has not moved is not a request we can honour,
and saying which payment is blocking it is the difference between a refusal and a wall.

**11. `personEmails` matching surfaces a shared family address.** Two humans, one inbox
is a real roster shape. §7.2 rule 3 turns it into a reviewer question rather than a
silent wrong link — which is the entire point of that rule.

---

## 12. Scope cut line

### Ships in one PR

**Shared** (`packages/shared/src/contractorPayments.ts`): `taxDocValidUntil(kind,
signedOn)`, `extendTaxDocRetention(...)`, `CONTRACTOR_TAX_CLASSIFICATIONS`,
`CONTRACTOR_1099_THRESHOLD_CENTS`. **`packages/shared/src/index.ts`**:
`personaFromSignals` += `hasPaidContractorSignal` at the vendor rung.

**Schema** (`apps/convex/schema/finances.ts`): new `contractorProfiles`;
`contractorTaxDocuments` += `contractorProfileId` / `lastTaxYear` / `signedOn` /
`validUntil` (+ `by_profile`); `contractorPayments` += `contractorProfileId` /
`taxDocumentId` / `taxDocKindOnFile` / `taxDocCollectedAt` / `taxDocPurgedAt` /
`taxReaffirmedAt` / `bankConfirmedAt` / `identityReviewNeeded` (+ `by_tax_document`,
`by_contractor_profile`); `approvals.subjectType` += `"contractor_profile"`; new
`contractorTaxDocViewAttempts`.

**Convex:** profile create/link/edit/merge/forget + the three access resolvers; the
returning-payee submit path; `attachTaxDocument` re-keyed to the profile; retention
recompute + the rewritten `purgeExpiredTaxDocuments` with payment stamping; the
bounce-clears-account rule in `lib/increasePayoutMachine.ts`; `personEmails`-based
matching + ambiguity flagging in `submitPublicRequest`; contractor repointing in
`lib/people.ts#repointPersonReferences` and the extra gate in
`dataHygiene.ts#mergePeopleCore`; the roster query; the 1099 view query; the tax-doc view
rate limit.

**Public page** (`lib/contractPage.ts`): `returningPayeeSection`, the W-8 signed-on date
input, the W-9 classification radio, and the four copy fixes in §4.3.

**Mobile:** a Contractors section on `/finances/payments` (a filter on the existing
screen, **not** a new route or chip — §1.1 of the original spec is still binding);
`/finances/payments/contractors/[id]`; `/finances/payments/1099`; the composer's
"it's Jane again" picker, usual-rate hint and "use this description again" control.

**Academy:** both lessons per §10, plus a snapshot regeneration.

**Tests:** retention monotonicity (a reuse never moves `purgeAfter` earlier); the
unpaid-document short clock; purge stamps every citing payment; `storageId` in no new
query shape; the returning form refuses without both affirmations; staff mutations cannot
set `taxReaffirmedAt`/`bankConfirmedAt`; ambiguous email attaches no person; merge moves
contractor rows and clears the bank account; a `failed` payout clears the profile
account; an expired W-8 blocks the attestation path.

### Deliberately deferred

| Deferred | Why |
|---|---|
| 1099-NEC generation, e-filing, corrections, TIN matching, B-notice handling | Needs a tax adviser and a TIN we deliberately do not hold. §6.4. The view ships; the form does not. |
| Any bulk export (roster or 1099) | §9.2. A file you can email is a different risk from a list you can read. |
| Standing / retainer agreements ("pay Jane $500 monthly") | This is exactly risk 1 with the brakes removed. It needs its own controls and its own spec. |
| Cross-chapter contractor sharing | Chapter scoping is the codebase's spine. Two chapters, two profiles, two uploads. §9.8. |
| Auto-creating a profile from the public path | §1.3. The spam vector the original spec identified is still real. |
| A contractor login / portal | Unchanged from the original spec: do not build a login for someone we pay twice a year. The token is the product. |
| W-8 payment rail and withholding | Still blocked, still correct, still a v2 project with a tax adviser in the room. |
| Reading the TIN off the uploaded PDF to key aggregation | Would put an SSN in a Convex field. Not now, not ever, on this codebase's current posture (`schema/finances.ts:1201-1203`). |
| Notifying a contractor when their form is destroyed | Nice, and it is an email nobody asked for about a thing that already happened. Revisit if anyone asks. |

**If it must be split**, the seam is between §1–§5 (the record, retention, consent,
autofill — the founder's actual ask) and §6–§7 (the 1099 view and the matching
overhaul). Ship the first; the second is worth its own PR and its own review. Do **not**
split §3 out of the first PR — shipping reuse on today's purge rule destroys
substantiation on a four-year fuse, and nobody will notice until 2031.

---

## 13. What I need from the founder before build

1. **Opt-in or automatic?** I have specified **staff-initiated**: a contractor becomes
   reusable when someone picks them at compose or presses "Save this contractor" on a
   paid payment (§1.3). The alternative — every contractor we pay automatically becomes a
   durable record — is one line of code and a materially larger privacy surface (§9).
   I lean opt-in for the first release and revisiting in a month with real numbers. **This
   is the one answer that changes the shape of the feature.**
2. **Do we ask for tax classification?** §6.3. It is one radio group on the contractor's
   form, asked once ever rather than once per payment, and without it the 1099 view cannot
   say who is exempt. I recommend yes. It is one more question we are putting in front of
   a stranger, which is why I am asking.
3. **A contractor paid by two chapters fills the form twice.** §9.8. I am confident
   chapter scoping is right and I want it said out loud, because the first time it happens
   somebody will call it a bug.
4. **Sign off on the §4.2 copy**, particularly the attestation sentence and the retention
   sentence. That attestation is what we would point at if a contractor ever said "I never
   agreed to you keeping that."
5. **Confirm you want the bank account re-confirmed on every single payment** (§4). It is
   one radio button for the contractor and it is the only thing standing between a stale
   account and an ACH. I think it is obviously right; it is also the only friction this
   feature adds, so it should be a decision rather than a default.
