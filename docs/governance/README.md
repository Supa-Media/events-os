---
document: Governance Library Index
entity: Global Echo Charitable Organization (d/b/a Public Worship)
status: DRAFT — NOT ADOPTED
version: 0.1.0-draft
last-reviewed: 2026-08-15
adopted: —
review-cadence: annual
owner: Executive Director
---

# The governance library

Three documents describing how Global Echo Charitable Organization — which
operates publicly as **Public Worship** — is governed, how it runs, and what it
expects of the people who work for it. They live in this repository, next to the
software that implements them, for the same reason the Academy does: **a rule
that lives in a filing cabinet goes stale the day the product changes, and
nobody finds out.**

| Document | What it answers | Who adopts it |
|---|---|---|
| [`bylaws.md`](./bylaws.md) | Who holds authority, how decisions are made, what the corporation may and may not do | The Board, by resolution |
| [`operating-manual.md`](./operating-manual.md) | How the organization actually runs — money, events, chapters, giving, decision rights | The Executive Director, under the Board's policies |
| [`employee-handbook.md`](./employee-handbook.md) | What the organization owes staff, volunteers and contractors, and what it expects back | The Board (policy), the ED (practice) |

## Status: everything here is a DRAFT

**Nothing in this directory has been adopted.** The 2021 bylaws remain the
operative governing document until the Board formally replaces them. Every file
carries a `status:` field in its header block; it reads `DRAFT — NOT ADOPTED`
until a Board resolution says otherwise.

These drafts have **not been reviewed by Maryland nonprofit counsel**, and they
must be before adoption. They were written to be a competent, complete starting
point that a lawyer edits — not a substitute for one. Each document ends with an
**Open decisions** section listing the calls only the founder and Board can make.

### Adopting a document

1. Founder/Board resolve the Open decisions listed at the end of the document.
2. Maryland nonprofit counsel reviews (bylaws and handbook especially — the
   handbook makes employment-law representations that vary by state and change
   with the legislature).
3. The Board adopts by resolution at a meeting or by unanimous written consent.
4. In the same PR: set `status: ADOPTED`, fill `adopted:` with the resolution
   date, bump `version` to `1.0.0`, and record the resolution in the minutes.
   The drift test requires an `adopted:` date whenever status is `ADOPTED`, so
   this cannot be half-done.
5. Publish where required (the handbook goes to every worker; the bylaws and the
   conflict-of-interest policy get referenced on Form 990 Part VI).

## These documents must track the product

Same standing rule as the Academy, for the same reason. **Every PR that changes
user-facing behavior, vocabulary, money rules, roles/seats, approval flows, or
org process must ask: does the governance library need updating?**

- Changed a seat, its title, or its powers (`packages/shared/src/seats.ts`,
  `powers.ts`)? → the Operating Manual's org chart and decision-rights tables
  are wrong until you fix them. The drift test will tell you.
- Changed a money constant — the skim, the backer unit, the operating floor,
  the receipt grace window (`packages/shared/src/finance.ts`)? → the Operating
  Manual quotes those figures and the drift test pins them.
- Changed who approves what, or added a separation-of-duties rule? → Operating
  Manual §6, and check whether the Bylaws' delegation article still covers it.
- Added a capability that could ever need restricting? → the power goes in
  `SEAT_CAPABILITIES` behind a resolver (see `CLAUDE.md`), *and* the Operating
  Manual's decision-rights table gets the row.
- Shipped a transparency-affecting change (what gets published, when, how
  corrections work)? → Bylaws Article XI is a *promise*; keep it truthful or
  amend it.
- Anything touching pay, hours, leave, conduct, or safety at events? → Employee
  Handbook, and flag it for counsel if it is a legal representation rather than
  a practice.

When unsure whether a change is governance-relevant, it probably is. The drift
test catches structural mismatches; it cannot catch a paragraph that now
describes a flow the product no longer has.

## How drift is caught

`packages/shared/src/governance.test.ts` reads these markdown files and asserts
them against the code:

- every document has a well-formed header block, and an `ADOPTED` status carries
  an adoption date;
- every seat title in `SEAT_DEFS` appears in the Operating Manual's org chart,
  and the manual names no seat that does not exist;
- every power string quoted in the docs exists in `POWERS`;
- the money figures the manual quotes match `finance.ts` (the 15% skim, the $50
  backer unit, the $670 five-person floor, the 20/30/50 tiers, the 7-day receipt
  window, the finance timezone);
- the reimbursement and contractor-payment lifecycles the manual describes match
  the real status tuples.

It fails loudly when someone changes a constant and not the prose. That is the
entire point: these documents are checked in *so that they can be tested*.

## Conventions

- **Markdown, not code.** These are read by humans and will one day be printed,
  signed, and handed to a lawyer and a bank. Keep them readable as prose.
- **The header block is machine-read.** Keep the `---` fenced block at the top
  of each file, with the same keys.
- **Bylaws are authority; the manual is practice.** If the two conflict, the
  bylaws win and the manual is the thing that gets fixed. Say things once — the
  manual points at the bylaws rather than restating them.
- **The Academy teaches; the manual references.** Academy lessons
  (`packages/shared/src/academy/`) are the training version of the same facts,
  written to be learned in three minutes. When you change one, check the other.
- **Never hardcode people.** Seats change hands. Name the seat, never the human.
