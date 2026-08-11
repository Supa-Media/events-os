# The public ledger

**Status:** shipped (v1, 2026-08-11)
**Surfaces:** `publicworship.life/finances` (anonymous) · Finances → Publish (in-app)
**Code:** `apps/convex/publicLedger.ts`, `apps/convex/lib/publicLedger*.ts`,
`apps/convex/schema/publicLedger.ts`, `packages/shared/src/publicLedger.ts`,
`apps/mobile/app/(app)/finances/publish.tsx`

---

## What this is

Public Worship publishes its books. Not a summary — every transaction, month
by month: what we bought, who from, what it was for, and whether we can
produce the receipt.

The owner's framing, which every design decision here answers to:

> "I love the Church of the City thing, how it's distilled. But it can feel
> like I'm giving to a drop in the bucket. Versus when I'm looking at the line
> items and I'm seeing, oh wow, this person gave $5 — and it literally cost $5
> to pay for this little piece of equipment we had. So you can be like, okay,
> there's a correlation of what I'm giving to what it's being used for."

And the second-order effect, which matters as much:

> "The fact of knowing that the transactions are going to be public is going
> to really get the team on their toes — not to be lax with these funds. Even
> just keeping receipts and making sure you're coding it."

## What already existed

Almost all of the hard part. This feature added a publishing layer on top of
machinery that was built anticipating it:

| Piece | Where | What it gave us |
|---|---|---|
| §274(d) substantiation | `transactionCodings` | The human-authored "what was this, why, who was there" |
| Approver's public rewrite | `transactionCodings.publicPurpose` | Redaction without falsifying the author's own words |
| Attendee privacy rule | `schema/finances.ts` | Names internal forever; headcount + affiliation mix publish |
| Reconstructed-history marker | `transactions.historicalImportBatch` | "Rebuilt from a spreadsheet" is sayable |
| Documentation state | `documentationState()` | receipt / exception / undocumented, one definition |
| The close gate | `publishability.report` | How far a month is from publishable, per axis |
| Book-value model | `lib/bookBalance.ts` | What counts as income and spend, without double-counting |

What was missing was the **act** of publishing, and the promises that come
with it.

## The three decisions that matter

### 1. Published means frozen

The public page does **not** read the live books. A month is snapshotted at
publish time into `financePublicationEntries`, and that frozen copy is what
the world sees.

This is not a caching strategy. A live page means an edit made after approval
silently rewrites the public record, and nobody outside can tell. That is
precisely the property a transparency page exists to deny. A frozen page means
a correction has to be *published*.

Corollary, stated on the page itself: fixing a transaction in Reconcile does
**not** fix the public page. That surprises people once, which is why the
Academy lesson's `reveal` block is built around exactly that scenario.

### 2. Corrections are the feature

There is no unpublish. Retracting a published month would let the org withdraw
a statement it had already made — the power this page exists to give up.

A wrong month is corrected by publishing revision N+1 with a reason and a
sentence explaining what changed. Revision N stays readable beside it, and the
page carries a dated "Corrections" section. An org that shows its corrections
is more believable than one that has never appeared to make any.

`startAmendment` captures the reason and the note **up front**, before the
correction is prepared: the person who noticed the problem is the person who
can describe it.

### 3. Publish gaps, not around them

A month with four receiptless rows publishes with a note saying there are four
receiptless rows, and each row carries a chip. Same for rows with no approved
coding, and for rows rebuilt from spreadsheets.

Waiting for a perfect month means publishing nothing for a year. Hiding the
rows means publishing something untrue. The **one** thing refused outright is
an incomplete snapshot (`SNAPSHOT_TRUNCATED` / `SNAPSHOT_TOO_LARGE`), because
that is the only failure a reader cannot detect for themselves.

## The lifecycle

```
draft ──submit──▶ in_review ──publish──▶ published ──startAmendment──▶ amending
  ▲                   │                      ▲                            │
  └─requestChanges────┘                      └──────submit → publish──────┘
        (→ changes_requested)
```

`status` describes the **working** copy; `liveRevision` describes what the
public sees. They are independent: an `amending` month stays publicly visible
at its last approved revision, so there is never a window where a month reads
as blank or half-edited.

## Who can do what

Per CLAUDE.md's "gate it behind a power" rule, every gate lives in
`lib/publicLedgerAccess.ts` — nothing checks a seat or a finance role inline.

| Power | Resolver | Today |
|---|---|---|
| Prepare / submit | `requireLedgerPrepare` | Finance manager at the book; central reach for a foreign book |
| Publish / send back | `requireLedgerPublish` | The `finance.publish` **seat capability** |
| Read the console | `requireLedgerConsole` | Finance viewer+ at the book |

`finance.publish` is a leaf capability that nothing implies — deliberately not
a rung of the finance ladder. Every other finance power acts on the org's own
books; this one talks to the whole city. Default holders: Executive Director
and Financial Manager (central → any book), Chapter Director (their own
chapter's book). **Not** the Treasurer — they prepare it, and separation of
duties would refuse their own publish anyway.

Separation of duties is enforced in `publicLedger.ts`, not the access module:
"may this person ever publish?" and "may they publish *this* month, given who
prepared it?" are different questions. A superuser may self-publish (the
solo-operator relaxation `budgets.approvalParty` already documents), and every
revision records which way it went via `approvalParty`.

## What publishes

- **Every non-`excluded` transaction**, as a line. Rows that must not be summed
  — internal transfers, processor payout deposits — publish as
  `direction: "internal"` with `countsInTotals: false` rather than being
  dropped. `sum(counted outflows) === expenseCents`, verifiable from the CSV.
- **An `excluded` row does not publish.** An intentional exclusion is the org
  asserting this was never a transaction.
- **Gifts, as an anonymous roll**: amount, minute, method, designation. No
  donor field is *written*, not merely omitted from a projection — a table an
  anonymous route reads should not contain a field whose safety depends on
  every future query remembering to drop it.
- **Ticket orders, sales, registrations**: income totals only.
- **Never**: attendee or traveler names, in any column, ever.

Entries store **rendered text**, not ids. Renaming a category next year must
not retroactively rewrite a statement the org already published.

## Surfaces

| Route | What |
|---|---|
| `/finances` | 302 → newest published month (so a shared link names its month) |
| `/finances/<YYYY-MM>` | The statement: stats, income, spend by category and by project, every line, the giving roll, corrections, "how to read this" |
| `/finances/<YYYY-MM>.csv` | The complete ledger — never truncated |
| `/finances/<YYYY-MM>/giving.csv` | The anonymous giving roll |

The HTML caps rendered lines (`PUBLIC_PAGE_ENTRY_LIMIT`) so a shared link
paints fast; the CSV has no cap and the page says so. If the two ever
disagree, the CSV is the authority.

## Not in v1 — deliberately

- **Salaries.** Nobody is paid today. The owner's stated intent is to publish
  compensation **by position**, not by person, the way public offices do. When
  there is a salary, that is its own decision and its own PR.
- **A cross-month or annual view.** The annual-report shape (Church of the
  City's) is a good future addition, but the month is the unit the close
  already runs on, and inventing a second period concept before the first one
  has shipped a single month would be building on nothing.
- **Per-project drill-down pages.** The spend-by-project breakdown exists; a
  project's own public page does not. Worth doing once there are published
  months to link into it.
- **A scheduled auto-publish.** Publication is a human decision, on purpose.
