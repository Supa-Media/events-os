# Handoff: sync cards created directly in Increase

> **STATUS: implemented** (`increaseCardSync.ts`, migration 0078). Read the
> "Corrections" block below before trusting anything else on this page — three
> of the facts this plan was built on turned out to be wrong when checked
> against production, and one blocker it missed was the actual reason the
> charge could not be attributed.
>
> ## Corrections found during implementation
>
> 1. **`cardholder_name` is null on every production card.** The plan said it
>    was present. Only `description` carries the holder's name.
> 2. **There IS an email on the card object** — at `digital_wallet.email`, not
>    `cardholder` (which really is `{}`, as the plan said). Every one of the
>    five production cards has one.
> 3. **Matching that email against `people.email` finds nothing.** Roster rows
>    carry personal addresses (gmail); the Public Worship address lives on
>    `people.pwEmail`, and the only NORMALIZED copy is `personEmails`
>    (`people.pwEmail` is stored raw — one row reads `Kaylamarieb@…`). So the
>    identity key is `digital_wallet.email → personEmails.by_email`, which is a
>    hard link; name matching is the fallback, not the primary.
> 4. **Four of the five cards were already synced.** Only Kansi's was missing,
>    and the orphan-charge count was exactly the 1 the plan predicted.
> 5. **The blocker the plan missed:** her card is on the **central** Increase
>    account, and `cards.chapterId` was `v.id("chapters")` — it could not hold
>    the `"central"` sentinel `increaseAccounts.chapterId` already uses. Even
>    with a card row, `increaseLedger`'s same-scope check would have refused the
>    attribution. Widening that field cost 2 type errors, both in the
>    real-time-decision path.
> 6. **Ambiguity is real, not hypothetical.** Production holds six addresses
>    mapped to two `people` rows each, two of them `@publicworship.life`. The
>    "refuse rather than guess" rule fires on live data.
>
> ## Deviations from the plan below
>
> - **An unattributable card is NOT written as a holderless row.**
>   `cards.cardholderPersonId` is required, and the table's whole contract is
>   "owned by ONE person" — a holderless row would flow into receipt chasing,
>   auto-lock and repayment as an owner-shaped hole. It is skipped with a loud
>   `[increase][cardSync][ALERT]` log instead, and `resyncIncreaseCards` is the
>   repair path once the roster ambiguity is fixed.
> - **`resyncIncreaseCards` is permanent, not deleted after running.** It is the
>   recovery tool the alert points at, not a one-time data fix. Only the
>   transaction back-link (migration 0078) is one-off.

---

## The original plan, as written (facts above supersede it)


## The problem, as it reached us

Kansi created a card in the **Increase dashboard** rather than through the OS.
Her charge then "didn't come up" for her (iMessage, 2026-08-18).

It did ingest — it is in production right now as an **unattributed** row:

```
08-18 | $14.27 | AMAZON RETA* 5A0C91NA2 | source: increase_card
       cardId: null   personId: null   cardLast4: null
```

She saw nothing because the row is linked to no card and no person, so it never
appears as *hers*. It is the only such row in production today.

**Owner's directive:** all cards made on Increase must be synced — not just ones
provisioned through the OS. "Make cards through the OS" is a workaround, not the
fix.

## Why it happens

`increaseLedger.ts` keys ingestion on the **account**, not the card. An unknown
`increaseCardId` leaves the transaction unattributed rather than dropping it
(good). But nothing in the codebase ever *lists or receives* Increase's cards —
`cards` rows are only written by `cards.ts` (OS provisioning), `legacyCards.ts`
and `stripeFinance.ts`. A card born in the Increase dashboard has no counterpart
here, forever.

Note the account guard: a charge on an account absent from `increaseAccounts`
IS dropped (`if (!account) return skipped`). Not the case here, but worth
knowing.

## What already exists (don't rebuild it)

- `cards.increaseCardId` field **and** a `by_increase_card` index — schema is
  ready.
- `increaseLedger.ts` already resolves `cardPaymentId → card_id` against
  Increase, which is how an orphan transaction can be back-linked.
- A verified Increase webhook endpoint at **`apps/convex/http.ts:1226`**
  (`/increase/webhook`). Signature verification is done. It currently dispatches
  exactly ONE category: `real_time_decision.card_authorization_requested`.
  Events carry `{ category, associated_object_id }` with **no inline object** —
  you fetch details by id.

## The two facts that make this tractable

1. **There is a `card.created` webhook event.** Confirmed in the Increase
   dashboard event log: `card_glov69v9jshltwbywyw8`, Aug 17 12:20:09 PM. So this
   can be a live hook, not a polling job.

2. **Only `@publicworship.life` emails can access Increase and create cards.**
   The candidate set for "who made this card" is therefore small, known, and
   entirely inside the roster — which is what makes identity matching safe here
   rather than a guess.

## What the Increase card object gives you

Fetched live from `GET /v1/cards/card_glov69v9jshltwbywyw8`:

```
description      : "Kansi Udochukwu"
cardholder_name  : (present on the object)
last4            : "6005"
account_id       : "account_pcqy1jkrut1nuglqbebf"
status           : "active"
entity_id, bin, expiration_month/year, billing_address, digital_wallet …
```

**There is no email on the card object** — `cardholder: {}` is empty. So identity
resolution is by NAME (`cardholder_name` / `description`) against the `people`
roster, made safe by fact #2 above.

## The work

1. **Handle `card.created` (and `card.updated`) in the Increase webhook.**
   Fetch the card by `associated_object_id`, upsert a `cards` row keyed on
   `increaseCardId` via `by_increase_card`, filling `last4`, `chapterId` (from
   `account_id` → `increaseAccounts`), and `cardholderPersonId` from the name
   match. Idempotent — the same event redelivered must not create a second row.

2. **Resolve the cardholder by name, and refuse rather than guess.** Match
   `cardholder_name` against `people`. On an ambiguous or absent match, still
   create the card row (so future charges attach to a card) but leave
   `cardholderPersonId` unset and surface it for a human to claim — a wrong
   name on a money row is worse than a blank one. Do not fuzzy-match loosely.

3. **One-time backfill.** Page `GET /v1/cards`, upsert every existing Increase
   card, then back-link orphan `increase_card` transactions
   (`cardId == null`) via `cardPaymentId → card_id`, setting `cardId`,
   `personId` and `cardLast4`. Dry-run first; assert the expected count before
   writing. Today that is exactly **1 transaction** ($14.27) and at least
   Kansi's card — verify against production before executing, since more cards
   may have been made since.

4. **Delete the backfill module once run** (repo convention, see #596).

## Cautions

- This is a money path. Follow the discipline the repo has already paid for:
  dry-run first, assert expected totals, refuse rather than half-apply. See the
  header of `lib/seed/historical/genesisDedupe2026.ts` for why amount+date
  matching alone is not evidence.
- The card-created hook writes a row that later attributes SPEND to a person.
  Getting the person wrong misattributes money, so the ambiguous case must fail
  open (unattributed) rather than closed (wrong person).
- Run `/code-review <PR-url> high --comment` before merging; the last several
  finance PRs each had real findings, including two that would have moved money
  incorrectly.

## Verify before you start

The `$14.27` row and the card list may have changed. Re-derive:

```bash
npx convex data --prod transactions --limit 20000 --format jsonLines \
  | python3 -c "import sys,json;rows=[json.loads(l) for l in sys.stdin];
u=[r for r in rows if r['source']=='increase_card' and not r.get('cardId')];
print(len(u));[print(r['amountCents'], r.get('merchantName')) for r in u]"
```
