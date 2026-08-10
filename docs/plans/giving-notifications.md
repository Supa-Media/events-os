# Giving notifications — "tell me when money comes in"

**Status: backend shipped.** The mobile UI (`/giving/notifications`, a new tab
in `apps/mobile/app/(app)/giving/_layout.tsx`) lands in a follow-up PR and
builds against the API surface below.

## The ask

> "Whenever a donation comes in, I want an email to be sent about it. In the
> giving tab, allow me to set rules to put in emails and thresholds. For
> example, send every single donation to development-team@publicworship.life on
> any giving transaction, including when someone adds a gift to a ticket sale.
> And details about where the giving came from — if they gave towards a certain
> chapter, or they just gave to central. For myself I might only want to know on
> gifts above $500, sent to shay@ and aj@. We could even set a frequency:
> immediate, daily, weekly. The email should have a lot of data — I should see
> the donor, and if it's aggregated I should see multiple and be able to click
> into an individual donor, go straight into the OS and see their information,
> in case someone gave a big gift and I want to thank them."

## The model

One table, `givingNotificationRules` (`schema/givingNotifications.ts`). A row is
a standing instruction: *these people* hear about *these gifts* at *this
frequency*.

| Field | Meaning |
| --- | --- |
| `name` | Human label ("Every gift", "Big gifts — Shay + AJ") |
| `recipients: string[]` | Lowercased, de-duplicated addresses. At least one, at most 20 |
| `cadence` | `"immediate" \| "daily" \| "weekly"` |
| `minAmountCents?` | **Inclusive** floor. Absent = every gift |
| `scope` | `"all" \| "central" \| Id<"chapters">` |
| `isActive` | Soft on/off. There is no delete |
| `sendHourLocal?` | 0–23 in `America/New_York`. Daily/weekly, default 8 |
| `sendWeekday?` | 0 = Sunday … 6 = Saturday. Weekly, default 1 (Monday) |
| `lastSentAt?` | Digest watermark **and** idempotency key |
| `createdBy` / `createdAt` / `updatedAt` | Provenance |

### Why `scope` is a three-way string union

The neighbouring giving tables (`donors.scope`, `gifts.scope`) use
`Id<"chapters"> | "central"`. A rule needs a third state — *every book* — and
that state is an explicit `"all"` sentinel, not an absent `chapterId`. A
nullable field would make "central" and "everywhere" indistinguishable at the
validator, and every reader would have to re-derive the difference from context.

### Why no delete

The whole giving desk soft-deactivates (`sponsorPackages.active`,
`pledges.status`). A rule that mailed a team for six months is a record of who
was told what. `setRuleActive` turns it off and back on; nothing removes it.

## Eligibility is total

Every row `lib/givingDonors.ts#recordGiftForDonor` writes is a candidate. That
is deliberately *not* filtered by kind, so it includes:

- a gift **bundled into a ticket purchase** (`ticketOrders.donationCents` →
  `donations` → dual-written gift) — the owner asked for this by name;
- a gift **split out of an in-person sale** (`salesDonations.ts`);
- an **in-kind** gift (a purchase made on the org's behalf);
- a recurring backer cycle, a sponsorship payment, a confirmed bank credit, a
  CSV import, a manual desk entry, and a gift on the public `/give` page.

A rule narrows by **book** and by **amount** and by nothing else. What the email
does instead of filtering is *label*: `giftProvenance` reads the gift's own
fields and prints one sentence saying how the money arrived, so an in-kind gift
can never be mistaken for cash in the bank.

### The one honest hard case: "did this ride in on a ticket order?"

A ticket add-on settles through `giving.ts#createPaidDonationForOrder`, which
writes a `donations` row and dual-writes the gift — so the gift looks exactly
like a standalone event-page donation. The only truthful way to tell them apart
is to walk back through the donation's `rsvpId` to the ticket order
(`ticketOrders.by_rsvp`, one indexed read) and check that an add-on of that
amount was actually bought there. That's what
`lib/givingNotificationContext.ts#giftProvenance` does.

## Immediate sends

`recordGiftForDonor` — the single write path for gifts — ends with:

```ts
await ctx.scheduler.runAfter(0, internal.givingNotifications.notifyGiftRecorded, { giftId });
```

**An email must never be able to cost a gift.** Scheduling is a database write
inside the gift's own transaction; the *action* runs afterwards, in its own
context, once the gift has committed. A Resend outage, a rate limit, a malformed
address, or an unhandled throw over there fails a notification and nothing else.
The converse holds too: if the gift transaction rolls back, the job rolls back
with it, so nobody is told about a gift that doesn't exist.

Hooking the chokepoint (rather than each of the thirteen callers) means every
channel gets the same treatment with no per-channel opt-in to forget.

The schedule is **pre-filtered** with the same pure `ruleMatchesGift` the action
uses: a gift no immediate rule cares about schedules nothing at all, so a
deployment with no immediate rules pays no `_scheduled_functions` write per gift.
The action still re-reads and re-matches — it has to, since it runs after the
commit — so the two can never disagree.

### Bulk writes are demoted to the digest, never silenced

`recordGiftForDonor` takes `notify?: boolean`. **Absent or `true` is the
default, and the default is the safe one**: a single-gift path added next year
notifies without its author knowing the flag exists. Opting out has to be typed.

`notify: false` says *this operation can write many gifts, or is re-writing
money the ledger already knew about*. Five call sites pass it:

| Call site | Why |
| --- | --- |
| `givingImport.ts` (canonical CSV import) | Thousands of rows in one commit — the Import tab is live, so this is not hypothetical |
| `historicalBackfill.ts` | A one-time load of curated historical exports |
| `givebutterSync.ts` | Unbounded loop; attaching a campaign backfills its whole donation history |
| `givingReversals.ts` (restore) | Putting back money already announced once, at its original date |
| `givingPlatform.ts#splitGift` | A reclassification of one gift into parts — the money arrived once |

Everything else keeps the default, including every live rail: the `/give` page,
event-page donations, ticket add-ons, Stripe recurring cycles, sponsorship
payments, confirmed bank credits, in-person sale splits, and ordinary desk entry.

**It demotes; it does not silence.** A gift written with `notify: false` is in
the ledger and in the daily/weekly digest — the digest window counts on
`createdAt`, so an import lands there as one correctly-totalled lump instead of
a thousand separate emails. Nothing is ever hidden from the people who asked to
be told. (If a window ever holds more gifts than one digest run reads, the email
says the total is a floor rather than quietly under-reporting money.)

### A backdated gift notifies, but doesn't claim the money just moved

`receivedAt` is backdatable, so "a gift just came in" can be a false statement
about a gift recorded today for a date last year. Past `FRESH_ARRIVAL_WINDOW_MS`
(7 days) the immediate email leads with **"A backdated gift was recorded"**, the
subject is prefixed `Backdated gift recorded:`, and the date line says
"recorded later, not today".

**It changes the wording and nothing else.** Suppressing an old gift's
notification was the other option and it is worse: a treasurer entering a cheque
that arrived three weeks ago would get silence, and "someone gave a big gift and
I want to thank them" is exactly as true three weeks later. A notification whose
absence nobody can see is the failure mode that makes people stop trusting the
system. The *volume* problem is a different axis, solved deterministically by
`notify` rather than by guessing from a date.

**The one bypass.** `genesisRevenueSync.ts` inserts a single hard-coded
historical in-kind gift directly, deliberately skipping `recordGiftForDonor`
(and every rollup with it). It is a dated one-time ops module for a 2026-08-06
backfill, so it is **not** hooked — notifying a fundraising team about a
back-dated reconciliation row would be noise, not signal.

## Digests

`crons.ts` runs `sendGivingDigests` **hourly, on the hour**
(`crons.cron("0 * * * *")`, not `crons.interval({ hours: 1 })` — an interval is
measured from deploy time and would drift off the hour boundary the local-hour
match depends on). Every other cron in this repo names one UTC hour because it
serves one audience; this one can't, because a rule names the local hour *its*
recipients want.

Each tick:

1. **`claimDueDigests` (mutation)** — for each daily/weekly rule, is its local
   hour now, and has it not already gone out today? If so, compute the window,
   count what's in it, decide whether to send, **stamp `lastSentAt`**, and
   return the claim.
2. **`digestPayload` (query)** — totals, largest gift, breakdown by book and by
   source, and the itemized gift list (capped at 100 rows; totals still count
   every gift and the email says how many were omitted).
3. **`sendGivingDigests` (action)** — render and mail, per-recipient best
   effort.

**Claim-before-send**, the posture `cards.ts#advanceCodingReviewReminders`
established: the stamp lands in the same transaction as the selection, so a
crash between claiming and sending costs at most one digest rather than
repeating it every hour. Running the sweep twice inside the same local hour is
safe — the second pass finds today's watermark and claims nothing.

### The window is on `createdAt`, not `receivedAt`

`gifts.receivedAt` is when the money changed hands and is freely backdatable (a
CSV import of 2019 giving, a desk entry for a cheque that arrived last week). A
window on it would silently drop any gift entered after its own period closed.
`createdAt` — when the ledger *learned* of the gift — only moves forward, so
`(lastSentAt, now]` is a genuine partition: nothing is reported twice and
nothing is missed. The email still shows `receivedAt` as the gift's date,
because that is the true answer to "when was this given". This needed one new
index, `gifts.by_created`.

### The deliberate asymmetry: empty daily vs empty weekly

**An empty DAILY digest is not sent. An empty WEEKLY digest is.**

They look inconsistent and they are, on purpose. Most days no gift arrives, so a
daily "nothing came in" is mail the recipient learns to delete unread — and a
recipient who deletes the daily unread will delete the one that matters too. A
*week* with no giving is a different thing entirely: for the people this is
built for it is the single most actionable sentence the system can say, and its
absence would be indistinguishable from the job being broken. The weekly email
is therefore also the heartbeat that proves the pipeline is alive.

The watermark follows the same logic. A skipped empty daily does **not** stamp
`lastSentAt`, so the window carries forward — the next digest covers everything
since the last mail that actually went out, and no gift can fall between two
runs.

## What the emails carry

**Immediate:** the amount, prominently; donor name (hyperlinked into the OS) and
email; source/method; book (chapter name or "Central"); the event, when the gift
is attributed to one; how it arrived; covered fees shown *beside* the gift and
never folded into it (`gifts.feeCoverageCents`' invariant); the note; the gift
date; and donor context — first gift, or lifetime total and gift count.

**Digest:** the period, the total, the count, the largest gift called out by
name, a breakdown by book and a breakdown by source, and every gift listed with
its own link to its donor.

Both are built with `lib/emailShell.ts`'s fragment builders — the same shell
every other transactional mail in this backend uses (receipts, reminders, card
alerts, approval notices), reading its colours off the one brand theme.
Deliberately **not** `@react-email/components`: that dependency exists in this
repo for exactly one thing, the vendored Tiptap→HTML *campaign* renderer, and
`apps/convex`'s tsconfig excludes `.tsx` on purpose.

## Deep links

`appUrl("/giving/donor/<donorId>")` → in production
`https://publicworship.life/os/giving/donor/<id>`. The `/os` prefix is the
Cloudflare-routed base path the Expo web build is served under
(`apps/mobile/app.config.js`'s `experiments.baseUrl`); a link that drops it
404s. `appUrl` returns `null` when `APP_URL` is unset, and the templates degrade
to plain text rather than emitting a dead link — the house rule.

## Permissions

Reads and writes both go through `lib/givingAccess.ts`, the giving desk's own
scope-aware gate, rather than the finance ladder (`requireFinanceRole` can't
even take the `"central"` sentinel).

- `requireGivingManage(ctx, gateScope)` on every write.
- `gateScope` maps `"all"` → `"central"`: a rule that reaches every book needs
  the same central reach a central rule does, or a chapter holder could point an
  org-wide firehose at their own inbox.
- Editing a rule's **scope** requires manage rights on the scope it is *leaving*
  as well as the one it is joining.
- `listRules` filters by `canViewGivingScope` — the same predicate the gate
  uses, exported so a list and a gate can never disagree — and returns a
  `canManage` flag per row.

**Worth knowing:** no seat on the *chapter* chart carries `giving.manage` today
(donor-CRM write is central's, per the giving PRD). `chapter_director` holds
`giving.view` only. So in practice today, only central/superuser reach can write
a rule at any scope — and a chapter seat sees its own book's rules read-only.
The gate is written against the capability, not a seat list, so the day a
chapter seat is granted `giving.manage` the chapter branch works with no code
change. The tests mint such a seat to pin that branch down rather than leave it
untested.

## Two axes, kept apart on purpose

"Should this gift produce an immediate email?" has two independent answers, and
collapsing them into one heuristic is how this goes wrong:

- **Volume** — is this operation writing many gifts at once? Answered
  *deterministically* by the caller via `notify`, because the caller knows and a
  date can only guess.
- **Truthfulness** — is this money that just moved? Answered by `receivedAt`,
  and used only to change *what the email says*, never whether it is sent.

A date-based volume guard would silently drop a treasurer's three-week-old
cheque; a volume-based truthfulness guard would let an import claim a 2019 gift
just arrived. Each axis gets the mechanism that actually fits it.

## Files

| Concern | Path |
| --- | --- |
| Table | `apps/convex/schema/givingNotifications.ts` |
| Matching, validation, the digest clock (pure) | `apps/convex/lib/givingNotificationRules.ts` |
| Gift → email facts (read-only) | `apps/convex/lib/givingNotificationContext.ts` |
| Templates (pure) | `apps/convex/lib/givingNotificationEmails.ts` |
| Gift-source labels | `apps/convex/lib/giftLabels.ts` |
| Desk CRUD + immediate send | `apps/convex/givingNotifications.ts` |
| Digest sweep | `apps/convex/givingNotificationDigests.ts` |
| Cron | `apps/convex/crons.ts` |
| Tests | `apps/convex/tests/givingNotifications.test.ts` |
