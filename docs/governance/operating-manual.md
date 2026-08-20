---
document: Operating Manual
entity: Global Echo Charitable Organization (d/b/a Public Worship)
status: DRAFT — NOT ADOPTED
version: 0.1.0-draft
last-reviewed: 2026-08-15
adopted: —
review-cadence: quarterly
owner: Executive Director
---

> **DRAFT.** Describes how Public Worship intends to run, written against the
> product as it exists on the `last-reviewed` date. Where practice and this
> document disagree, one of them is wrong — fix the one that should change. The
> Bylaws are the authority; this manual is practice under them.

# The Operating Manual

**Who this is for.** Anyone holding a seat with real responsibility — the
Executive Director, directors, chapter leadership, treasurers, anyone who spends
money or touches donor records. It is a reference, not a course. The Academy
(`packages/shared/src/academy/`) is the course; it teaches the same facts in
three-minute lessons, and the two must agree.

**How to read it.** §§1–3 are the shape of the organization. §§4–7 are money.
§§8–11 are the work — events, chapters, giving, communications. §12 is
compliance. §13 is how this document stays true.

---

## 1 · What the organization is

**Global Echo Charitable Organization** is a Maryland nonstock corporation,
EIN 80-0870719, recognized as tax-exempt under § 501(c)(3). It operates
publicly as **Public Worship**.

The mission, in the words the Academy teaches: *to create holy experiences
through music, ones that ignite a wave of faith in Jesus — moving seeds from
rocky ground into good soil, through genuine worship that reflects a bold
identity in Christ.* The vision is public worship in every corner of the world.

Two structural facts drive everything below.

**It runs on volunteers.** Nearly all chapter leadership is unpaid. That is not
a temporary state of underfunding — it is the operating model, and it is why the
software is built to survive a person leaving. A process that only works because
one person remembers it is a defect.

**Chapters are not organizations.** A chapter is a local expression of this one
corporation (Bylaws Art. IX). It has no separate legal existence, no bank
account of its own, no EIN, no insurance policy, no contracts in its own name.
Every dollar a chapter raises is the Corporation's money, held in the
Corporation's accounts, reported on the Corporation's return.

**Central** is the organization-wide layer: the Executive Director and the
directors who serve every chapter. Central and chapters are two seat charts, not
two organizations.

---

## 2 · The seat chart

Authority is held by **seats**, not people. A seat has a title, a place in the
chart, a holder limit, duties, and a set of named **powers**. Who sits in a seat
changes; the seat's authority does not move with the person when they leave it.

The tables below are the template every new organization and chapter is stamped
with, and they are generated from `packages/shared/src/seats.ts`. **They are
machine-checked against that file** — if you rename or add a seat and do not
update these tables, `governance.test.ts` fails.

### 2.1 Central chart

<!-- seat-chart:central -->

| Seat | Reports to | Holders | Powers granted |
|---|---|---|---|
| Executive Director | — (chart root) | 1 | `finance.accounts.view`, `finance.budgets.approve`, `finance.ledger.publish`, `org.chart.edit`, `giving.edit`, `email.campaigns.approve`, `data.export` |
| Financial Manager | Executive Director | 1 | `finance.edit`, `finance.ledger.publish`, `giving.view`, `email.campaigns.approve`, `data.export` |
| Development Director | Executive Director | 1 | `giving.edit`, `data.export` |
| Partnership Associate | Development Director | many | `giving.view`, `giving.partners.edit` |
| Fundraising Associate | Development Director | many | `giving.view`, `giving.partners.edit` |
| Music Director | Executive Director | 1 | — |
| A&R | Music Director | many | — |
| Artists | Music Director | many | — |
| Musicians | Music Director | many | — |
| Songwriters | Music Director | many | — |
| Marketing Director | Executive Director | 1 | `email.campaigns.approve`, `data.export` |
| Social Media Manager | Marketing Director | 1 | `email.assets.edit` |
| Graphic Designer | Marketing Director | 1 | `email.assets.edit` |
| Marketing Associate | Marketing Director | many | — |
| Expansion Director | Executive Director | 1 | `giving.view`, `data.export` |
| Chapter Directors | Expansion Director | many | — |
| Recruiting Associate | Expansion Director | many | — |
| Training Associate | Expansion Director | many | — |

<!-- /seat-chart -->

**Chapter Directors** is a *derived* seat: it is never assigned directly. Every
chapter's Chapter Director rolls up into it automatically, so the central chart
shows the whole leadership of the movement without anyone maintaining a list.

### 2.2 Chapter chart

Every chapter is stamped with this chart.

<!-- seat-chart:chapter -->

| Seat | Reports to | Holders | Powers granted |
|---|---|---|---|
| Chapter Director | — (chart root) | 1 | `finance.view`, `finance.budgets.approve`, `finance.ledger.publish`, `giving.view`, `data.export`, `events.checkin` |
| Treasurer | Chapter Director | 1 | `finance.edit`, `giving.view` |
| Music Lead | Chapter Director | 1 | — |
| Vocal Lead | Music Lead | 1 | — |
| Band Lead | Music Lead | 1 | — |
| Event Lead | Chapter Director | 1 | `events.checkin` |
| Event Organizers | Event Lead | many | `events.checkin` |
| Production Coordinator | Event Lead | many | `events.checkin` |
| Marketing Lead | Chapter Director | 1 | — |

<!-- /seat-chart -->

The public five-person core team a launching chapter is told it needs — Chapter
Director, Music Lead, Event/Production Lead, Marketing Lead, Treasurer — is this
chart at its minimum. It grows to about ten (adding event organizers and music
seats) at Eden and Love Thy Neighbor scale.

### 2.3 Appointing and removing

- The **Board** appoints and removes the Executive Director (Bylaws § 8.1).
- The **Executive Director** maintains the chart and appoints every other seat;
  seats carrying spending approval, ledger publication, or donor export are
  filled only with the ED's express approval (Bylaws § 8.4).
- **Chapter Directors** are appointed by the Executive Director, and propose
  their own chapter's seat holders.
- Removing someone from a seat removes their powers immediately. Off-boarding is
  in §12.4.

---

## 3 · Powers: who may do what

A **power** is one named thing a person is allowed to do. The grammar is
`<domain>[.<area>].<action>`, action always last. The authority is
`packages/shared/src/powers.ts`; the guide is `docs/guides/powers.md`.

<!-- powers-table -->

| Power | What it permits |
|---|---|
| `finance.view` | Read the finance domain at the holder's scope — dashboards, budgets, the reconcile grid |
| `finance.edit` | Keep the books at that scope: record, categorize, reconcile, manage cards |
| `finance.accounts.view` | See the organization's bank accounts and balances |
| `finance.cards.view` | See issued cards and their activity |
| `finance.cards.edit` | Issue, lock, and cancel cards |
| `finance.budgets.approve` | Approve a budget |
| `finance.ledger.publish` | Publish a closed month to the public ledger |
| `giving.view` | Read the donor CRM at the holder's scope |
| `giving.edit` | Record, edit, import, and configure giving |
| `giving.partners.edit` | Compose a sponsor's partnership agreement and issue its portal link |
| `email.assets.edit` | Own the shared design system — themes, templates, image library |
| `email.campaigns.edit` | Compose a campaign and send it for approval |
| `email.campaigns.approve` | Approve a campaign for sending |
| `events.checkin` | Check attendees in at the door |
| `org.chart.edit` | Edit the org chart — seats, holders, and their powers |
| `data.export` | Export records the holder can already see, as a file |

<!-- /powers-table -->

**Three rules make the chart honest without hand-maintenance.**

1. **Wildcard.** `finance.edit` grants that action on every area of the domain —
   including areas added later.
2. **Ladder.** Deciding implies seeing: `edit`, `approve`, `publish`, and `send`
   each grant `view` at the same prefix.
3. **Explicit.** A few cross-area edges are declared by hand — composing an email
   implies owning the templates you compose from.

**`edit` never grants `approve`.** That is the whole point of an approval: it is
performed by someone other than the author.

**`data.export` never widens reach.** It exports what the holder can already see
and nothing more — a Marketing Director's people export comes back without
giving columns, rather than failing.

### 3.1 The standing engineering rule

Every capability that might one day need restricting goes behind a named power
from the start, resolved through a `has…`/`require…` pair in
`apps/convex/lib/<domain>Access.ts`. Never inline a seat check at a call site;
never hard-code "anyone can do this." When today's answer is "anyone in the
chapter," write the resolver anyway with a membership-check body. Adding the
real gate is then a one-file change instead of a fifty-call-site change. See
`CLAUDE.md`.

---

## 4 · Money: the rules that do not bend

The finance model is `packages/shared/src/finance.ts`. Everything here is
enforced in software wherever the software can enforce it.

**Money is integer cents, always.** No floats anywhere in the system.

**One home per dollar.** Every transaction lands in exactly one place in the
books. The finance timezone is `America/New_York`; a month is closed against it.

**Every dollar is unrestricted.** Public Worship holds no designated or
restricted funds today. That is a decision, not a gap — everything received is
general operating money. The concept exists in the data model so that the day a
restricted grant arrives it is a data change, not a migration; until then no
screen asks anyone to choose a restriction.

**Nothing moves without a purpose.** A transaction's stated purpose must be at
least **20 characters** and must say what the money actually did — enough to
satisfy § 274(d) substantiation and to be readable by a stranger on the public
ledger.

**No personal accounts, ever.** Corporate money never sits in a personal
account, and personal money is never commingled with the Corporation's.

### 4.1 The numbers

Every figure here is single-sourced from `finance.ts` and machine-checked
against it.

<!-- money-constants -->

| Figure | Value | Constant |
|---|---|---|
| One backer's monthly pledge | $50 / month | `BACKER_UNIT_CENTS` |
| Chapter → central City Launch Fund share | 15% of monthly backer revenue | `CENTRAL_SKIM_PCT` |
| Monthly operating floor, fixed component | $570 / month | `OPERATING_FLOOR_FIXED_CENTS` |
| Monthly operating floor, per teammate | $20 / month | `OPERATING_FLOOR_PER_TEAMMATE_CENTS` |
| Tier — Worship With Strangers, monthly | 20 backers | `AFFORDABILITY_TIERS` |
| Tier — + Eden, the annual worship-and-picnic gathering | 30 backers | `AFFORDABILITY_TIERS` |
| Tier — + Love Thy Neighbor, the neighborhood block party | 50 backers | `AFFORDABILITY_TIERS` |
| Receipt grace period before a card locks | 7 days | `RECEIPT_GRACE_DAYS` |
| Minimum length of a stated purpose | 20 characters | `MIN_PURPOSE_LENGTH` |
| Finance timezone | America/New_York | `FINANCE_TIMEZONE` |

<!-- /money-constants -->

A five-person chapter's operating floor is therefore $570 + 5 × $20 = **$670 a
month**, which is what twenty backers at $50 sustain. The tiers are
**guarantees, not ceilings**: at 20 backers a chapter commits to Worship With
Strangers every month; at 30 it adds Eden; at 50 it adds Love Thy Neighbor.

The 15% share is how a funded chapter helps launch the next city. It is not a
tax on the chapter's own work — it is the mechanism by which the movement
compounds, and it is disclosed publicly.

### 4.2 Cards and receipts

Cards are issued to people, not to teams. The holder is accountable for every
charge on their card.

**Every charge needs a receipt, without exception.** A receipt more than **7
days** late locks the card automatically. This is not a punishment; it is what
keeps the books closable and the public ledger publishable. Unlock happens when
the receipt lands.

If you cannot get a receipt, say so immediately and in writing to your treasurer
— an explained missing receipt is a manageable exception, a silent one is an
audit finding.

**Do not personally cover things.** Paying out of pocket to be helpful moves the
organization's spending off its books. If something must be bought and you have
no card, ask; if you want to give, give — but give as a donation, not as an
invisible subsidy.

### 4.3 Reimbursements

Paying a person back for money they already spent. The receipt is the
substantiation, and the money is **not** income to them.

<!-- lifecycle:reimbursement -->

`pending_preapproval` → `preapproved` → `submitted` → `approved` → `paying` →
`paid`. A reviewer may send a request back as `changes_requested` — "the receipt
must show the exact amount", "say which event this served" — and the claimant
edits and resubmits. Terminal states are `paid`, `rejected`, and `canceled`;
`failed` is terminal for a payout attempt but not for the request, which returns
to `approved` for retry.

<!-- /lifecycle -->

`changes_requested` exists precisely so that review does not read as
punishment. Most real review outcomes are "almost — fix this one thing", and an
organization that only had `rejected` would teach its volunteers that submitting
a receipt risks losing their money.

**The approver is never the claimant.** A treasurer's own reimbursement is
approved by the Chapter Director or by central.

### 4.4 Contractor payments

Paying someone for work — a film editor, a session musician, a photographer.
The opposite of a reimbursement on both counts: nothing has been spent yet, the
**agreement** is the substantiation rather than a receipt, and the money **is**
reportable income.

<!-- lifecycle:contractor -->

Two entry points, one machine. Staff pre-fills an agreement: `draft` → `sent` →
`submitted`. Or a contractor asks: born `submitted`. From `submitted` on the two
are indistinguishable — `changes_requested` where terms need work, then
`approved` → `paying` → `paid`. Terminal: `paid`, `rejected`, `canceled`;
`failed` is a retryable payout failure.

<!-- /lifecycle -->

Collect a **W-9 before the first payment**, not at year end. Payments of $600 or
more in a calendar year to an unincorporated payee require a **1099-NEC by
January 31**. Classify honestly: someone whose hours, methods, and tools the
organization controls is an employee, and calling them a contractor does not
change that.

### 4.5 Budgets and approval

A budget is an allocation, either **one-time** (attached to a specific event or
project) or **recurring** (monthly, quarterly, yearly), tagged so that spending
rolls up by team, template, or event.

- Chapter budgets are approved by the **Chapter Director** (`finance.budgets.approve`
  at chapter scope).
- The central budget and the annual operating budget are approved by the
  **Executive Director**, and the annual budget is adopted by the **Board**
  (Bylaws § 10.7).
- Contracts above the Board's threshold, borrowing, real property, and any
  related-party transaction need **Board** approval regardless of budget.

### 4.6 Closing the month, and publishing it

Monthly close: every transaction coded with a purpose, every receipt filed,
accounts reconciled, exceptions explained.

The chapter **Treasurer prepares** the month; the **Chapter Director publishes**
it. At central, the **Financial Manager** prepares and the **Executive
Director** or Financial Manager publishes. Preparer and publisher are two
different people by design — that is the two-party rule applied to the public
record.

**What is published is frozen.** The public page shows the copy that was
approved at publication, not a live view of the books. An edit made afterward
cannot silently rewrite the public record.

**Corrections are published, not made quietly.** A mistake is fixed by
publishing a further revision with a stated reason, with the prior revision
still readable beside it. An organization that shows its corrections is more
believable than one that has never appeared to make any.

---

## 5 · Separation of duties

The recurring rule, in one place. Wherever a decision matters, two people are
involved, and the software enforces it where it can.

| Action | Prepared / requested by | Approved by |
|---|---|---|
| Reimbursement | The claimant | Treasurer, or Chapter Director where the claimant is the Treasurer |
| Contractor payment | Staff or the contractor | Treasurer or Financial Manager — never the requester |
| Partnership agreement | The development desk composes it | **The partner signs it** — there is no staff-side way to mark an agreement signed |
| Chapter budget | Treasurer | Chapter Director |
| Central / annual budget | Financial Manager | Executive Director; annual budget adopted by the Board |
| Monthly ledger publication | Treasurer (chapter) / Financial Manager (central) | Chapter Director / Executive Director |
| Mass email campaign | Any `email.campaigns.edit` holder | A **different** `email.campaigns.approve` holder (enforced by practice, not by the tool — see below) |
| Executive Director compensation | — | Board, under Bylaws § 12.6 |
| Related-party transaction | — | Disinterested directors only, Bylaws § 12.4 |

The campaign rule is worth stating plainly: the Executive Director can compose a
campaign, but somebody else — the Marketing Director or the Financial Manager —
must approve the send. Nobody sends to the whole list alone.

**Where mass email is sent from, and what that costs (2026-08-19).** Bulk email
now goes out through **Mailchimp** rather than the in-app Emails desk, which is
parked (see `docs/plans/email-desk-parked.md`). The powers above are unchanged
and still name who may compose and who may approve — but Mailchimp cannot
enforce two-party approval, so on this one row the rule is now a **discipline
the org holds itself to** rather than a gate the software closes. That is a
real weakening and is recorded here deliberately rather than quietly dropped.
The `email.campaigns.approve` holders remain the people who must read a send
before it goes; what changed is that nothing stops someone who skips them.

Two things the software still does enforce, across both systems: a person who
has opted out of marketing, or whose address is on the suppression list, is
never pushed to Mailchimp at all; and an unsubscribe made in Mailchimp is
written back into that same suppression list, so it silences event blasts and
every other send too.

---

## 6 · Events

Events are the work. The product models them as **templates** that clone into
instances, with role-scoped tasks on T-offsets counted back from the event date,
so running an event is following a checklist the last person improved rather
than remembering what happened last time.

**The canon.** *Worship With Strangers* — public worship in a park or a square,
filmed. *Eden* — the annual worship-and-picnic gathering. *Love Thy Neighbor* —
the neighborhood block party. A chapter's tier says which of these it guarantees.

**Statuses.** `planning` → `ready` → `completed`, or `cancelled`.

**Ownership.** The Event Lead owns the run of show and the volunteers; the
Production Coordinator owns gear and setup; the Music Lead owns the set and the
musicians; the Marketing Lead owns turnout. Door check-in is `events.checkin`,
held by the Chapter Director, Event Lead, Event Organizers, and Production
Coordinator.

**Before the event, non-negotiably:** the permit or venue permission, the
insurance certificate if the venue requires one, the safety brief, and — if
minors will be present — the child-protection requirements in the Employee
Handbook § 9. After it: the retro, which is what turns this instance's fixes
into the next instance's template.

---

## 7 · Chapters

**Launching.** A launch is itself a template: find the core team, scout
neighborhoods, run the first Worship With Strangers, with the founding seats
filled as tasks come due. The chapter's first "event" in the app is its own
founding.

**Central provides** the playbook, the event templates, the song bank, the
Academy, the brand and assets, the software, the bank accounts and cards, the
insurance, the legal and tax filings, and the starter equipment package the City
Launch Fund buys.

**The chapter owns** its local relationships, its team, its calendar, its
turnout, its budget within the approved envelope, and its books' accuracy.

**Before soliciting in a new state**, central confirms charitable-solicitation
registration for that state (§12.2). A chapter never registers anything itself.

**Never, under any circumstances:** a bank account, a payment processor account,
an EIN, an insurance policy, a lease, a contract, a domain, or a social account
in the chapter's own name. All of it is the Corporation's, held centrally, used
locally (Bylaws §§ 9.1, 9.6).

**Closing or pausing a chapter** is the Executive Director's decision, reported
to the Board. Funds, equipment, records, and accounts stay with the Corporation.

---

## 8 · Giving

**Backers** sustain a chapter with recurring monthly support — the $50 unit that
the tier model is built on. Backer counts drive what a chapter can guarantee.

**Donors and gifts** are recorded in a chronological gifts ledger with an audit
trail: edits are recorded, not overwritten; gifts can be moved between books and
reassigned between donors, visibly.

**Access is deliberately narrow.** `giving.view` is read at the holder's scope;
`giving.edit` — record, import, configure — sits centrally with the Development
Director and the Executive Director. A chapter sees its own donors. Nobody sees
donor records because of seniority; they see them because a seat carries the
power.

**Acknowledgment is a legal obligation, not a courtesy.** Every gift is
acknowledged promptly in writing. Gifts of **$250 or more** require a
contemporaneous written acknowledgment stating whether any goods or services
were provided in return. Where a donor pays more than **$75** and receives
something in return, the quid pro quo disclosure is required. The organization
never states the value of donated property — the donor's appraisal is the
donor's responsibility. See Bylaws Appendix D.

### 8.1 Sponsorships and partnerships

A **sponsor package** is a price list — a tier the Development Director authors,
with what a partner at that tier receives and what the organization commits to
deliver. A **partnership agreement** is a negotiation: one organization (a
church, a business, or a foundation — never an individual) against one tier, at
a figure and on terms that may be that partner's alone. An agreement therefore
carries its **own proposal** — its own title, its own body, its own benefit and
commitment lines, its own terms — and falls back to the tier wherever it has
nothing of its own.

**An agreement covers the gatherings it names.** A partnership is routinely
more than one date — one agreement may stand behind a flagship event and a
second gathering in the same season — and every covered event is named, with its
date, on the partner's own page. A season or full-year agreement covers no
single date, which is a real state rather than a missing one. Changing which
events an agreement covers changes what the partner agreed to, and is treated as
a term accordingly (below).

**The partnership team composes the agreement.** Drafting an agreement — its
terms, proposal, covered events, in-kind credits, and documents — and issuing
the portal link is the `giving.partners.edit` power, carried by the Partnership
and Fundraising Associates and, through the whole-domain grant, by the
Development Director. It is deliberately narrower than managing the donor CRM:
the partnership team runs an agreement end to end from the Sponsors tab without
the power to record a gift, edit a donor, or import — those stay `giving.edit`.
Recording a partner's payment against the agreement remains a `giving.edit`
action.

**The partner reads and signs their own agreement.** Each agreement can issue a
secret link to a page the partner opens with no account: the proposal, the
terms, a typed-name signature, and a way to pay. The link opens exactly that one
agreement and authorizes exactly two acts — signing it and paying it. Nothing
internal reaches it: the organization's due-diligence notes about a partner, the
pipeline stage, and the internal owner are not on that page and cannot be put
there.

<!-- lifecycle:partnership-portal -->

`unissued` → `awaiting_signature` → `awaiting_payment` → `settled`, with
`payment_clearing` while an authorized bank transfer has not yet landed. Every
one of those is **derived** from four facts — is there a live link, is the
signature against the current terms, is anything owed, is anything in flight —
and none is stored, so a page can never claim a signature it does not hold.

<!-- /lifecycle -->

**Only the partner signs.** There is no staff-side way to mark an agreement
signed, deliberately: a signature a staffer could type is not a signature. The
organization records the typed name, the role, the email, the moment, the
originating IP address, and **which version of the terms was on the page**.

**Editing a signed term un-signs the agreement.** Changing the amount, the
terms, the benefits, the commitments, the summary, the covered events, or the
title moves the
agreement to a new version and clears the signature; the partner is asked to
sign again, and what they originally signed stays visible to the desk. Editing
the contact block, the payment rails, or an in-kind credit does not — reducing
what a partner owes must never force them to re-sign.

**Documents attach to an agreement, and default to internal.** Any file behind
the deal — the agreed production proposal when a partner carries production in
kind, a signed side letter — is stored with the agreement. Each document is
visible to the development desk only until it is explicitly marked shared, at
which point it appears on the partner's own portal page and is downloadable
through their link. The default is internal by design: the failure to prevent is
a draft or an internal note reaching a partner, so the safe state is never the
one a staffer has to remember. A shared document is served through the same
secret token that opens the portal — revoking the link ends document access with
it — and an internal document is unreachable to the partner even by its id.

**In-kind credit reduces what is owed; it is not revenue.** Where a partner
carries part of an agreement in donated work — production, equipment, a venue —
the organization values it **at its own budget lines, never at the partner's
rate card**, lists each line on the partner's page, and counts it against the
agreement like cash. Recording that same donation as an in-kind gift in the
ledger is a separate, deliberate act; doing both would count one donation twice.
The organization still never states the value of donated property to the donor
for their tax purposes — that remains the donor's appraisal and the donor's
responsibility (§8 above, Bylaws Appendix D).

**A large partnership settles by bank transfer, and that is a money rule.** The
processor's bank-debit fee is 0.8% **capped at $5.00**; a card is roughly 2.9% +
30¢ with **no cap** — $101.80 of a $3,500 partnership against $5.00. Every new
agreement therefore offers bank transfer alone. A manager may additionally allow
card on a **small** agreement where clearing time costs more than the fee, and
**above $1,000 the software refuses card outright**, whatever the setting says.

**Money arrives as an ordinary gift.** A partnership payment is booked in the
gifts ledger against the partner's donor record, tagged to the agreement, on the
same rails and the same audit trail as every other gift. An agreement holds no
money ledger of its own.

**Donor data never leaves except through `data.export`,** and never goes to a
personal spreadsheet, a personal email account, or a departing volunteer's
laptop. Donor lists are never sold, rented, or traded.

---

## 9 · Communications

One brand, centrally owned, locally used. Chapters promote locally within the
brand; central owns the design system, the templates, and the image library
(`email.assets.edit`).

**Every mass send is two-party** (§5). **No political campaign intervention,
ever, on any channel** — this is an absolute condition of tax exemption
(Bylaws § 2.5), and it binds every chapter account and every official channel.

Speak about people the way you would if they were reading — because on a public
ledger and a public page, they are.

---

## 10 · Data, privacy, and access

- **Access follows the seat.** Grant it when someone takes a seat; revoke it the
  day they leave it.
- **Personal data minimum.** Collect what the work needs. Attendee, donor, and
  volunteer data is the Corporation's, held in its systems.
- **Minors.** Never photograph, list, or publish an identifiable minor without a
  guardian's written consent.
- **The public ledger omits people.** Donor identities, individual compensation
  beyond what law requires, and anything that would endanger someone are never
  published (Bylaws § 11.4).
- **Devices and accounts.** Organization work happens in organization accounts.
  A personal account is not a system of record.

---

## 11 · Decision rights at a glance

| Decision | Who decides |
|---|---|
| Mission, strategy, annual budget, ED hiring and compensation | Board |
| Bylaws, policies, dissolution, related-party transactions | Board |
| Contracts over the Board's threshold, borrowing, real property | Board |
| Org-wide priorities, seat chart, launching or closing a chapter | Executive Director |
| Central spending within budget, staff and contractor hiring | Executive Director |
| Publishing central's books | Executive Director / Financial Manager |
| Chapter budget approval, chapter leadership proposals | Chapter Director |
| Publishing a chapter's month | Chapter Director |
| Recording and reconciling chapter money, preparing the close | Treasurer |
| Donor records, gift entry, giving configuration | Development Director |
| Brand, campaign approval | Marketing Director |
| Event plan, run of show, volunteers | Event Lead |
| Set list, musicians | Music Lead |

---

## 12 · The compliance calendar

Central's obligations. A chapter never files anything itself.

| When | What |
|---|---|
| Ongoing | Charitable-solicitation registration in every state where the organization solicits — **before** a chapter launches or fundraises there |
| Ongoing | Resident agent and registered office maintained in Maryland |
| January 31 | 1099-NEC to contractors paid $600+ in the prior year, and to the IRS |
| January 31 | W-2s to employees, if any |
| April 15 | Maryland annual report / personal property return (SDAT) |
| 15th day of the 5th month after fiscal year end (May 15 for a calendar year) | IRS Form 990-series return; a 6-month extension is available on Form 8868 |
| Annually | Maryland charitable-organization annual registration renewal, with the required financial statement |
| Annually | Conflict-of-interest disclosures collected and filed (Bylaws § 12.3) |
| Annually | Board reviews the Form 990 before filing (Bylaws § 10.11) |
| Quarterly | Board meets (Bylaws § 5.2) |
| Monthly | Books closed and the month published |
| Per payroll | Federal and Maryland withholding and payroll filings, if there are employees |

**Filing thresholds and due dates change.** Confirm current requirements with
counsel or the accountant rather than relying on this table alone; it is here so
that nothing is forgotten, not so that nothing is checked.

### 12.1 Off-boarding

When anyone leaves a seat, on the same day: remove them from the seat (which
removes their powers), cancel or reassign their card, retrieve equipment,
transfer any account they held into the Corporation's control, and confirm no
organization data remains in a personal account.

---

## 13 · Keeping this manual true

This manual is checked in next to the code it describes so that it can be
tested. `packages/shared/src/governance.test.ts` asserts that the seat tables
match `seats.ts`, the powers table matches `powers.ts`, the money figures match
`finance.ts`, and the lifecycle descriptions match the real status tuples.

**If you change the product, change this document in the same PR.** The test
tells you when a number or a seat has drifted. It cannot tell you when a
paragraph now describes a flow that no longer exists — that judgment is yours,
and it is the reason this section exists.

Quarterly, the Executive Director reviews the whole manual and updates
`last-reviewed`. Material changes to authority, money rules, or chapter
obligations go to the Board, because those are the Board's to set.

## Open decisions

1. **Board ratification of the 15% share** (§4.1). The manual states it; the
   Board should adopt it by resolution so the manual rests on delegated
   authority rather than on custom.
2. **Approval thresholds** (§4.5). The Bylaws leave the contract and dual-
   authorization thresholds to Board resolution; until they are set, this manual
   cannot state them.
3. **Operating reserve target** (Bylaws § 10.8).
4. **Level of financial examination** — compilation, review, or audit — and the
   Maryland registration threshold that drives it.
5. **Whether chapter leadership ever becomes compensated**, and if so, how the
   volunteer/employee line is drawn (Handbook § 4).
6. **Insurance schedule**: general liability, D&O, abuse and molestation,
   equipment, volunteer accident — what is in force today, and what each event
   type requires.
