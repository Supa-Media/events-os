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

Two tables (`schema/givingNotifications.ts`). `givingNotificationRules` is the
standing instruction — *these people* hear about *these gifts* at *this
frequency*. `givingNotificationRuleAudit` is the immutable trail of who changed
one and to what; see "A rule outlives the person who aimed it" below.

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
| `lastSentAt?` | Digest watermark — "reported up to here". A fact about money |
| `lastRunDayKey?` | "Already looked at today" (`YYYY-MM-DD` ET). A fact about scheduling |
| `createdBy` / `createdAt` / `updatedAt` | Provenance |
| `updatedBy?` | Who last CHANGED it — **not** the author. Absent only on rules older than the field |

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

1. **`dueDigestRuleIds` (query)** — whose moment has arrived. Reads the rules
   table only; touches no gifts.
1b. **`claimDigest` (mutation, ONE PER RULE)** — reads that rule's window,
   decides whether it sends, moves its marks, and returns the finished payload.
2. The payload comes back from that same transaction — totals, largest gift,
   breakdown by book and by source, and the itemized gift list (capped at 100
   rows; totals still count every matched gift and the email says how many were
   omitted). Built in the claim rather than re-read afterwards, so what is
   mailed is exactly what was claimed.
3. **`sendGivingDigests` (action)** — render and mail, per-recipient best
   effort.

**Claim-before-send**, the posture `cards.ts#advanceCodingReviewReminders`
established: the marks move in the same transaction that reads the window, so a
crash between claiming and sending costs at most one digest rather than
repeating it every hour. Running the sweep twice inside the same local hour is
safe — the second pass finds today's mark and claims nothing.

### One transaction per rule, one `try` per rule

Both are load-bearing, and both were wrong in the first cut.

Claiming every due rule in **one** mutation put every rule's window read in one
transaction. The default send hour is 8, so that is *every* daily and weekly
rule at once, and Convex caps a transaction at 16,384 documents read — nine
rules against a full window and the mutation throws, taking down every digest
for an hour that won't come round again until tomorrow.

Isolating only the `sendEmailReporting` call was the same mistake one level
down: a throw in the claim or the render aborted the whole action, and rules
already claimed had moved their watermark and were never mailed — permanently,
because Convex does not retry a failed scheduled action. Each rule now gets its
own `try`, and a failure is logged **with the rule id**.

### The window is filtered before it is capped

`collectWindowGifts` streams the `by_created` range and applies
`ruleMatchesGift` as it goes, so the cap bounds *matched* gifts, not scanned
rows. Capping first was a money bug and a wedge at once: a 5,000-row import made
a digest mail a total 60% short, stamp the watermark, and lose the remainder
forever — and a chapter-scoped rule whose prefix was all other books' gifts
matched zero, skipped, declined to stamp, and re-read that same prefix every day
thereafter, silently, forever.

A cut window is now handled honestly rather than hidden:

- the watermark advances only to the **last gift actually read**, so the
  remainder is the next window rather than nobody's;
- truncation means "we stopped early", not "we hit the cap" — hitting the cap on
  the very last row of a range means the window was read in full, and calling
  that truncated mailed a false "cut short";
- a **scoped** rule reads its own book through `by_scope_and_created`. On the
  global index a quiet chapter's rule walked every other book's gifts and
  tripped its scan cap on them, crying wolf about a chapter that had two quiet
  gifts;
- the cut lands on a whole-millisecond boundary, so no gift sharing that instant
  is skipped or double-counted (imports write many gifts per millisecond);
- the digest **sends regardless of what it matched**, which is what breaks the
  wedge;
- the email says its total is a floor and that the next digest carries on from
  where this one stopped. An empty-but-cut digest does not claim "no giving".

### Two marks, because they answer two questions

`lastSentAt` means *the window has been reported up to here* — a fact about
money, so it only moves when gifts have actually been reported (or consumed up
to a known point). `lastRunDayKey` means *this rule has already been looked at
today* — a fact about scheduling.

One field could not do both once the hour test became `>=`. A skipped empty
daily stamps the second and not the first: the window carries forward so no gift
falls between two runs, and the rule still stops re-scanning on every remaining
hour of the day.

### At or after the hour, not exactly on it

An exact-hour match meant one dropped cron tick cost a whole day — and a whole
*week* for a weekly rule — and a rule set to hour 2 was skipped entirely on the
DST spring-forward Sunday, when local 02:00 does not exist. `>=` plus
`lastRunDayKey` gives "at or after 8am, once today", which closes both.

### A window is only consumed by a digest that actually got out

Two ways the sweep used to eat a window and deliver nothing, both silent:

- **No Resend key.** `sendEmailReporting` returns `false` rather than throwing
  when no key resolves, so a deployment that had never configured one advanced
  every watermark daily and mailed nothing — and the day someone configured the
  key, every gift behind those watermarks was permanently un-digested. The
  sweep now resolves the mailer **before claiming anything** and returns
  (`skippedNoMailer: true`). Nothing has been consumed, so the backlog is simply
  still there when a key appears. No duplicate-email trade-off, because no
  window was ever claimed.
- **A Resend outage.** Every recipient throws, each is caught per-recipient, and
  the window was consumed anyway. A claim that reached **not one** recipient is
  now handed back via `releaseDigest` and counted in `failedRules`, so the next
  tick re-reads the same window. Partial delivery keeps the watermark — one bad
  address must not make a whole team's digest repeat.

`releaseDigest` only restores while `lastSentAt` is still exactly what the
claim set, so a later run or a human edit is never rolled backwards.

### A cut window drains hourly, not daily

A truncated run **clears** `lastRunDayKey` instead of stamping it, so the drain
continues on the next hourly tick. Otherwise a 5,000-gift import took a week of
cut-short digests to report, with every later gift queued behind it. The drain
stops on its own the moment a run completes its window, which stamps the mark
normally.

### The window closes a minute early

`gifts.createdAt` is the write transaction's **start** time, not its commit
time, so a gift whose mutation began before a digest ran but committed after it
would land behind the watermark. Convex's OCC makes that nearly unreachable, but
"nearly" is doing real work in a sentence about money. `DIGEST_LAG_MS` (60s)
closes the window a minute behind `now`: anything in flight for under a minute
is in the *next* window rather than lost between two. A daily digest cannot tell
the difference.

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

### "Send now" — a digest on demand

A digest rule could not be tested without waiting for its next slot, which is a
week for a weekly rule. The gap surfaced the day the owner moved his weekly
digest to Monday 12:00 ET and nothing arrived: the 09:00 run had already stamped
`lastRunDayKey`, so the noon tick correctly skipped, and there was no way to ask
for the email. `sendDigestNow({ ruleId })` is that ask.

It goes through the **existing** render / send path (`buildDigestPayload`,
shared with `claimDigest`), gated on the same `canManageRuleScope` that lets a
caller edit or pause the rule. The scope filter, the amount floor, the
`DIGEST_LAG_MS` window close, the cut/truncation machinery, the breakdowns and
the empty-daily asymmetry all still apply. A paused rule and an `immediate` rule
are both refused outright rather than mailing an empty digest.

Exactly **two** things differ from a scheduled run.

**1. The due check is bypassed.** That is the point of the button.

**2. The window is the trailing NOMINAL PERIOD** — a straight 7 days for
weekly, 24 hours for daily — ignoring `lastSentAt` and its provenance entirely
(`sendNowWindowStart`). The two windows answer two different questions. A
scheduled run asks *"what has arrived since the last one?"* and must resume
from the watermark exactly, or it skips a gift or reports one twice; that is
what `digestWindowStart`'s three cases are for, and the cron path is unchanged.
A manual send asks *"what does a weekly digest look like?"* Nobody presses the
button wanting a three-hour slice.

Which is exactly what the watermark window would have given the owner in the
case the button was built for: his rule ran at 09:00, leaving a
report-provenance watermark, and a press at noon would have returned a
confident, empty three-hour report. That is worse than having no button —
it looks like the feature is broken while it works as specified.

Reaching past a watermark would be a serious bug in any path that then *moved*
it — it is the dormant replay `digestWindowStart` case 1 is bounded to prevent.
It is safe here for exactly one reason, and the two decisions hold each other
up: **a preview neither reads the scheduling state nor writes it, so it cannot
desync it.** Change either one and check the other still stands. The accepted
cost is that a manual send re-reports gifts the last scheduled digest already
mailed — that is the point. It is a preview of the *period*, not a claim about
what is new.

**It does not consume the window.** `lastSentAt`, `watermarkFromRun` and
`lastRunDayKey` are left exactly as found, so the scheduled run afterwards
reports precisely what it would have reported. Three reasons:

- The button exists to answer "does my Monday digest work?". If it consumed the
  window, the act of checking would guarantee Monday's real digest arrived
  empty — it would break the thing it is for.
- Consuming would make it a weapon shaped like a convenience: anyone with giving
  *view* of a book could silence that book's next scheduled digest with a
  button press, leaving only a moved watermark to explain it.
- The cost of not consuming is that the same gifts are reported twice — once
  now, once on schedule. That is visible, harmless, and was asked for by
  whoever pressed the button. A silently skipped period is none of those.

`lastDeliveredAt` **is** stamped, once somebody was actually reached. It is not
a window mark and nothing schedules off it; it means "an email from this rule
reached somebody at this instant", which just became true, and it is what the
desk shows as "last sent".

**Rate limit:** three presses per rule per rolling hour
(`givingDigestSendNowAttempts`, the same attempt-table mechanism as the public
reimbursement submit and the card-details reveal, swept daily by
`maintenance.sweepRateLimitAttempts`). Keyed on the **rule**, not the caller —
the cost falls on the recipients, and keying on the presser would let two people
with view of the same book take turns and double the rate the team experiences.

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

**The level is giving VIEW, not giving manage** — reads and writes alike, via
`givingNotifications.ts#canManageRuleScope`. It was `giving.manage` until
2026-08-10; see "Anybody with access to giving" below for why it moved and who
decided.

- `canManageRuleScope(access, scope)` = `canViewGivingScope(access,
  ruleGateScope(scope))`, and it is the single predicate behind the list filter,
  the per-row `canManage` flag, all three mutations, and (transitively) the
  screen's book picker. One predicate, so no two of them can disagree.
- `ruleGateScope` maps `"all"` → `"central"`: a rule that reaches every book
  needs the same central reach a central rule does, or a chapter holder could
  point an org-wide firehose at their own inbox.
- Editing a rule's **scope** requires rights on the scope it is *leaving* as
  well as the one it is joining, so a rule can't be walked between books a step
  at a time.
- `listRules` filters by that predicate and returns a `canManage` flag per row —
  necessarily `true` on every row it returns, since visibility and manageability
  now ask the same question. The flag stays so the affordance is a property of
  the row, and re-narrowing the gate one day is a change to one function. It
  reads **newest-first through `by_createdAt`**; an unindexed read returning the
  oldest rows meant a rule past the cap was invisible in the UI (and so
  un-deactivatable) while it carried on sending. `saveRule` also refuses to
  create past `MAX_RULES` (`TOO_MANY_RULES`), so the cap can't be reached in the
  first place.
- The screen's book picker (`ruleScopeChoices`) derives from
  `givingPlatform.givingScopeOptions`, whose `options` are built from the
  caller's *view* reach — so every book it lists is already a book a rule may
  watch, and `canSeeAllScopes` is exactly "may watch every book". It ignores
  that query's `canManage` field, which means "may record a **gift** here" and
  is a strictly narrower power belonging to the Gifts screen.

### A rule never opens with an empty digest about a period it wasn't watching

Three moments move a rule's marks, for the same reason:

- **Reactivation.** `setRuleActive` stamps `lastSentAt = now` on off → on.
  Otherwise a daily rule switched off for three months comes back and mails one
  digest covering three months of donor records. *Clearing* the field is the
  wrong fix — with no watermark the one-nominal-period fallback applies, which
  the day after a large import is exactly the replay this prevents.
- **Creation**, and **a cadence change**. `daily → immediate → daily` reached
  that same dormant replay by another door, so a cadence change resets the marks
  too. Scope and threshold changes deliberately do *not* — they narrow the same
  stream, and the window stays honest.

All three also set `lastRunDayKey` via **`firstRunDayKey`**, which asks "would
this be due right now?" (reusing `isDigestDue`, so the two can't drift). A rule
whose send moment has already passed today is due the instant it is written,
against a window that opens at that same instant — so it can only be empty, and
on a weekly rule that lands as a confident "No giving this week" about a week
nobody was watching. Deliberately conditional: a daily rule created at 6am for
an 8am send still fires at 8am, because that window is genuine.

### One email per person, not one per rule

The two patterns the owner described — "every gift, to the dev team" and "gifts
over $500, to Shay and AJ" — overlap on purpose, and anyone on both would have
received the same gift twice. The immediate send is keyed on the **recipient**;
the footer names every rule that reached them. "We're getting double emails" is
the complaint that gets a notification feature switched off.

### Anybody with access to giving (2026-08-10)

Writes were gated on `giving.manage` when this shipped — the same gate that
guards writing a gift or a donor, which reads well on paper. It was wrong in
practice: **no seat on the *chapter* chart carries `giving.manage`** (donor-CRM
write is central's, per the giving PRD), and `chapter_director` holds
`giving.view` only. So against the shipped seat chart the manage gate resolved
to "central and superusers, nobody else". A chapter director watched their own
book's rules sit in a read-only list — unable to change a threshold, unable even
to switch off a mailer that was reaching the wrong people.

The owner settled it: *"You should allow anybody with access to giving to do the
notifications. That's fine."* So the gate is `giving.view` of the rule's own
book. Don't quietly put it back.

What widened is **which capability opens a book**, never **which books a
capability opens**. Containment is untouched and tested in both directions: a
New York viewer can create, edit and pause New York's rules, and is refused
`"all"`, `"central"`, a sibling chapter, moving its own rule out to `"all"`, and
pulling a central rule into New York. The ceiling on what a rule can do is what
makes view the right level — it emails a summary of gifts you can already read,
to addresses you name. It moves no money, edits no gift, and discloses no book
you had no reach into.

The gate is still written against the capability rather than a seat list, so the
day a chapter seat is granted `giving.manage` nothing here needs to change. The
tests still mint such a seat to keep that branch pinned down.

**Who this actually enfranchised — it is not only chapter directors.**
`canViewGivingScope` short-circuits on central view, so a central `giving.view`
holder reaches every book, `"all"` included. Three central seats hold
`giving.view` without `giving.manage` (`packages/shared/src/seats.ts`):

| Seat | Holders |
| --- | --- |
| `partnership_associate` | multi-holder |
| `fundraising_associate` | multi-holder |
| `expansion_director` | single — and its `giving.view` is itself toggleable at runtime by the ED (`seats.ts#setSeatGivingPower`) |

Each can author a `scope: "all"`, `cadence: "immediate"` rule to any address,
including an external one. In-reach by design, and what the owner asked for — a
rule only forwards gift summaries its author could already read — but two of
those seats are multi-holder, so the population is not a fixed number of people.
Anyone reasoning about this gate from the `chapter_director` story alone is
underestimating it.

### A rule outlives the person who aimed it

The send paths bound each email by the RULE's scope and never re-check any
caller's access, correctly — a cron has no caller. So a rule quietly re-pointed
at a personal address keeps mailing donor names and gift amounts after that
person's seat is revoked. Two records answer for it, both written at write time:

- **`givingNotificationRules.updatedBy`** — who last CHANGED the rule, set by
  `saveRule` (create and edit) and by `setRuleActive` in both directions.
  `createdBy` on its own was a misattribution once anyone but the author could
  edit: a rule authored by the development director and re-pointed by someone
  else still named the director. `listRules` surfaces it as `updatedByName` and
  the desk renders "Edited by … · date" on each row. Optional only because rules
  predate the field; an absent value means exactly "written before this shipped".
- **`givingNotificationRuleAudit`** — the immutable trail (`giftAudit`'s shape),
  one row per human change: `created`, `edited`, `activated`, `deactivated`.
  `updatedBy` alone was not enough, because the next editor overwrites it and
  the next editor is precisely who you would want to catch. `changes` is a
  display-ready diff and **recipients are diffed in full** — "who did this start
  mailing" is the whole question, and a count would hide a swap. An `edited` row
  is stamped with the scope the rule was LEAVING, so a move reads "this was New
  York's, and here it is becoming central's". A no-op `setRuleActive` writes
  nothing (the switch fires on every render).

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
| Digest sweep + "Send now" | `apps/convex/givingNotificationDigests.ts` |
| Desk screen | `apps/mobile/app/(app)/giving/notifications.tsx` |
| Cron | `apps/convex/crons.ts` |
| Tests | `apps/convex/tests/givingNotifications.test.ts` |
