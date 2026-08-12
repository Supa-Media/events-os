# Powers

A **power** is one named thing a person is allowed to do. Seats grant powers;
resolvers read them; nothing checks a seat id inline. This is the guide to the
vocabulary — the code is `packages/shared/src/powers.ts`, and it is the
authority if the two ever disagree.

## Why this exists

Powers used to accumulate one at a time, each named by whoever added it. By
mid-2026 there were sixteen, in four incompatible shapes:

| Shape | Examples | Problem |
|---|---|---|
| Role nouns | `finance.manager`, `finance.viewer` | Not an action. Can't tell what it lets you *do*. |
| Bare resources | `finance.accounts` | A noun with no verb — view? edit? both? |
| Verb-first camelCase | `org.editChart` | Sorts wrong, reads wrong, matches nothing else. |
| UI flags as a domain | `nav.finances`, `nav.giving` | Not a permission at all. |

Two of the sixteen weren't powers in any sense: `finance.central` was a
**scope** ("sees every chapter's money"), and `finance.record` was granted to
two seats and read by nothing.

There was no grammar, so every new power was a fresh guess. There was no
implication rule, so a seat that should hold a whole ladder had to list every
rung explicitly, and a missed rung was invisible until someone hit a wall.

## The grammar

```
<domain>[.<area>].<action>
```

Lowercase, dot-separated, two or three segments, **action always last**.

- `finance.view` — read all of finance
- `finance.budgets.approve` — approve budgets specifically
- `org.chart.edit` — edit the org chart

## The implication rules

Holding one power can grant others. `expandPowers` applies three rules to
fixpoint, and **every gate reads the expanded set** — never the raw stored
array.

**1. Wildcard.** A two-segment `<domain>.<action>` grants that action on every
declared area of the domain. `finance.edit` grants `finance.cards.edit`. This
is the point of the grammar: "I have `finance.edit`" means all of finance, and
a new area is automatically covered for whoever already had the whole domain.

**2. Ladder.** `edit` grants `view` at the same prefix. So do `approve`,
`publish` and `send` — you cannot decide on what you cannot see.

`edit` deliberately does **not** grant `approve`. The whole point of an
approval is that someone other than the author performs it.

**3. Explicit.** A power can declare extra `implies` edges for chains the
grammar can't express — e.g. composing an email implies owning the templates
you compose from, which is a *cross-area* edge.

## Scope: the second axis

A power is never held in the abstract. Every grant is a **(power, scope) pair**,
the scope coming from the `seatAssignments` row that granted it — either
`"central"` or one chapter's id.

1. A power held at a **chapter** reaches that chapter only.
2. A power held at **central** reaches central *and every chapter*.
3. Resources are scoped too, so a central-only resource is simply not present
   at a chapter scope.

Rule 3 is what makes the wildcard rule safe, and it's worth understanding
because it replaced a carve-out that was nearly bolted on instead.

A chapter Treasurer holds `finance.edit`, which wildcard-expands to
`finance.accounts.view` — but *at their own chapter*, and there are no
chapter-level bank accounts. The org's accounts live at central, which the
Treasurer's chapter-scoped grant never reaches. The Treasurer is stopped by
**scope, not by a special case**, so `finance.edit` gets to mean exactly what it
says without an exception list.

Rule 2 is why `finance.central` no longer exists. Giving and campaigns always
derived org-wide reach from being held at central; finance alone demanded an
extra string for the same thing.

## Navigation is derived, never granted

There is no `nav.*` power. A desk's tab is visible iff the viewer holds **any**
power in that desk's domain.

The old `nav.finances` / `nav.giving` were carried by exactly the seats that
already held a real power in the domain, so removing them changed nothing — it
just removed a second thing to remember to grant, and with it the failure mode
where a seat has a power but no screen to use it from.

## Areas are earned, not reserved

**Do not add an area speculatively.** An area exists only when someone should
hold *part* of a domain without the whole.

Finance has four that earn it:

- `accounts` — the org's bank accounts and the banking console
- `cards` — cards and their spending, the one finance power meant to be handed
  out broadly
- `budgets` — because approval is separate from editing
- `ledger` — the **public** ledger, which is a different audience entirely

And several that don't: reconciling, coding, receipts and sales have no
separate holder anywhere in the org, so they are simply `finance.view` /
`finance.edit`. A speculative area is not free — it's another string every
seat's grant list has to be re-decided against, and another thing to get wrong.

## Seats store the minimal set

A seat def lists only what it is **granted**, never what those grants imply.
The ED carries `email.campaigns.approve`, not also the compose and design rungs
beneath it.

This inverts the old convention, which materialized every implied rung onto the
row so the chart would read honestly in the absence of an implication rule.
There is one now, and the seat panel renders the *expanded* set — so the chart
is still the honest answer to "who can do this?", it just isn't hand-maintained
any more, and a missed rung is no longer possible.

## Adding a power

1. Does someone need to hold this **without** the rest of its domain? If not,
   it belongs inside an existing string.
2. Is it a real **action**, not a scope or a UI flag?
3. Add it to `POWERS` and `POWER_DEFS` in `packages/shared/src/powers.ts`, with
   a `label` and `description` — both are required, which is why a raw id can
   no longer leak onto the org chart.
4. Grant it on the seats that should carry it in
   `packages/shared/src/seats.ts`.
5. Write a migration if existing orgs need it — `seatDefs` rows are runtime
   data, so a template change alone only reaches brand-new orgs.
6. Add the resolver in `apps/convex/lib/<domain>Access.ts` as a
   `has<Thing>` / `require<Thing>` pair. Every call site uses `require`.

## The current vocabulary

| Power | What it allows |
|---|---|
| `finance.view` | Read this scope's money: dashboard, transactions, reconcile, budgets |
| `finance.edit` | Record and reconcile, code transactions, chase receipts, edit budgets |
| `finance.accounts.view` | See the org's bank accounts, balances, transfers |
| `finance.cards.view` | See cards and their spending |
| `finance.cards.edit` | Issue, freeze, and set limits on cards |
| `finance.budgets.approve` | Decide on a submitted budget — never your own |
| `finance.ledger.publish` | Publish a month's statement to the public finances page |
| `giving.view` | Read the donor CRM |
| `giving.edit` | Add/edit donors, record gifts, import CSVs |
| `email.assets.edit` | Own themes, saved templates, the image library |
| `email.campaigns.edit` | Draft, submit, and send an approved campaign |
| `email.campaigns.approve` | Review and decide on others' emails — never your own |
| `events.checkin` | Admit a guest at an event door |
| `org.chart.edit` | Add, move, rename, and re-power seats |
| `data.export` | Bulk-export a dataset you can already see |

`finance.cards.*` is granted to nobody yet — the area exists so card access can
be handed out broadly without inventing a power at the moment it's needed.
