# Finances → Budgets (`/finances/budgets`) — redesign spec

**Author:** PM agent · **Date:** 2026-08-14 · **Status:** ready to implement
**Trigger:** founder review of the live page, 2026-08-14 (rebuilt same day in #721 / `1e83a84`, drop-down + totals + over-budget callout landed just before).

> "For past events and projects and stuff like that — I feel like the budget should be organized by year. Like we should see all this year's budgets and then under that previous years, still load everything. But I only wanna see like this year's budgets in the view, and then maybe collapse it to see last year's budgets — rather than seeing 'oh, this one budget from two years ago went over.' That doesn't make sense."
>
> "When something is a blank event, it's a blank template, starting from scratch — so let's use the event name we have on record."

Everything below is verified against the code at `HEAD` = `b94f826`.

---

## 0. The one-sentence diagnosis

The page was built when the query returned **one year** of budgets. Earlier today
`budgetsGlance` was widened to return **every year the chapter has ever had**
(`apps/convex/finances.ts:5669-5683`) and the screen was never re-designed for
that. Every complaint the founder has is a symptom of a single-year layout being
fed an all-time dataset: no year structure, an urgency callout that shouts about
2025 on a 2026 page, a totals strip that sums all of history, an empty state that
still says "this year", and a flat list that grows forever.

---

## 1. What's wrong now, ranked

### Genuine design failures

**F1 — There is no year structure at all, so the list is unbounded and undated
in the reader's head.** `budgets.tsx:205-217` renders `oneTime` as one flat
section headed `EVENTS & PROJECTS (19)`, in the server's newest-first order
(`finances.ts:5766-5769`). 19 rows today spanning 2026 and 2025; in two years it
is 60 rows spanning four. The reader has to read a date on every row to know
which era they're in, and the date they're reading is a raw ISO string (F6).
This is the founder's headline complaint.

**F2 — Over-budget rows are rendered twice, verbatim.** `budgets.tsx:194-203`
renders every row where `remainingCents < 0` in an `OVER BUDGET` section, and
then `budgets.tsx:205-217` renders the **same rows again** inside
`EVENTS & PROJECTS`, because `oneTime` is never filtered against `overRows`. The
in-code comment even defends this ("Rows still appear in their own section too,
so nothing is moved OUT of the place a reader learned to look for it") — that
reasoning is wrong for a list this long: the count in the section header
(`19`) double-counts, the totals strip and the section header disagree, and a
reader scrolling finds "Love Thy Neighbor 2025" twice and reasonably concludes
there are two budgets. Note this also applies to recurring rows: `overRows` is
computed from `all` (`budgets.tsx:139,142`), so an over-spent monthly bucket
appears in both `OVER BUDGET` and `RECURRING`.

**F3 — The urgency callout is year-blind.** All three rows in the live
`OVER BUDGET (3)` block are **2025** budgets. A 2025 event that closed $1,579
over is history — it is a fact for the annual report, not an alarm at the top of
a page someone opened in August 2026 to check room on Field Day. Because the
callout has no year scope and one-time budgets never age out
(`finances.ts:5717-5721` — deliberately, and correctly), this block only ever
grows and will permanently be dominated by the oldest data.

**F4 — The totals strip describes a set nobody asked about.** `totalsOf`
(`budgets.tsx:76-86`, rendered at `:171`) sums **every one-time budget in
chapter history plus this year's recurring buckets**. "Budgeted $X / Spent $Y /
Left $Z" over 2024+2025+2026 combined is not a number any human wants; it isn't
a year's budget, it isn't a plan, and it isn't reconcilable to anything. It
also silently mixes two incompatible windows: one-time = lifetime, recurring =
current cadence window (`finances.ts:5727-5732`).

**F5 — Search only matches the *derived* title, so the name people actually
typed no longer finds the budget.** `matches()` (`budgets.tsx:62-65`) tests
`row.name`, and since #721 `row.name` is the **event template** name
(`finances.ts:5747`, `lib/budgetTitleResolve.ts`). Typing "genesis night 3" —
the event's real name, the one on the event page and in the chat thread — now
returns nothing. The rename was right; dropping the old name from the search
index was not.

**F6 — "Blank event" is being used as a budget title.** Three of the visible
rows read `Blank event Dec 2025`. `Blank event` is a **real `eventTypes` row**
(`apps/convex/lib/templates.ts:403-464`: slug `blank-event`, `isBlank: true`,
lazily get-or-created per chapter, zero roles/items/columns) whose entire
purpose is to be an empty starting point. `budgetTitleResolve.ts:41-43` fetches
it like any other template and hands its name to `resolveBudgetTitles`, which
happily makes it a title. Worse: two blank events in the same month collide
*exactly* — the title rule's finest grain is month+year
(`budgetTitles.ts:147-150`), so two December 2025 blank events both render
`Blank event Dec 2025` and are genuinely indistinguishable in the list. Detail
and rule in §4.

**F7 — Empty-state copy is stale and now false.** `budgets.tsx:167`: "Approved
budgets **for this year** show up here." Since `1e83a84` the query returns every
year's one-time budgets. The copy is a leftover from the single-year era and
now actively misdescribes the page.

**F8 — `requireBudgetGlance` exists and nothing calls it.** `budgetsGlance`
reads `readChapterId(ctx)` inline at `finances.ts:5662`, while
`lib/budgetGlanceAccess.ts:60-64` defines exactly the named resolver CLAUDE.md
requires ("every call site uses the `require` form") — and grep finds **zero**
call sites. The sibling drill-down does it correctly
(`budgetGlance.ts:138` → `requireBudgetExpenses`). This is a one-line fix and
should ride along with any PR that touches the query.

### Cosmetic / smaller

**C1 — Dates render as raw ISO.** `BudgetGlanceCard.tsx:86-90` prints
`row.dateLabel` (`easternDateStr` → `"2026-09-26"`, `finances.ts:2884-2888`) in
uppercase letter-spaced micro-caps, a treatment meant for labels, not dates.
`Sep 26` (this year) / `Sep 26, 2025` (other years) is the right rendering and
also carries the year signal the page currently lacks.

**C2 — A project with a start date but no deadline sorts by date and displays
none.** `resolveBudgetRef` (`finances.ts:2328-2338`) sets
`refDate = deadline ?? startDate` but `dateLabel = deadline ? … : null`. So
"Create sponsorship packages" sits in the middle of the dated 2026 rows with no
visible date. Once we group by year (§2) this becomes load-bearing, not
cosmetic: the row must be *placed* somewhere and the reader must be able to see
why.

**C3 — The header blurb is three sentences of preamble** (`budgets.tsx:156-161`)
above the first useful pixel, on a screen whose whole job is "how much room is
left". One sentence.

**C4 — Recurring is scoped to the current year and never says so.** The query
drops recurring buckets from other years (`finances.ts:5726`, with a good
reason: a past monthly bucket has no live window). The card only says "this
month" inline (`BudgetGlanceCard.tsx:60-70,98-101`). Once the page grows year
headers, a section with no year label sitting between them needs an explicit
one.

**C5 — The `refDate` the client needs is computed and then thrown away.**
`finances.ts:5775` strips `refDate` from every returned row. `dateLabel` (a
string, `null` for projects without deadlines and for every dead ref) is the
only date the client gets, so **the client literally cannot compute which year a
row belongs to today.** This is why F1 can't be fixed client-side alone. See §5.

### What is *right* and should not be touched

- The drop-down (`BudgetGlanceCard.tsx:124-202` + `budgetGlance.ts`) is good and
  answers the founder's earlier ask precisely: category mini-bars, real charge
  lines, "Open event"/"Money"/"Full detail" chips gated server-side on a live
  ref and on `canOpenDetail`. Keep it whole.
- One-time budgets never aging off the tab (`finances.ts:5717-5721`) is correct
  — "the Genesis budget" is a thing people ask about years later. The fix is
  **structure**, not filtering.
- Member-visibility without a finance seat, and quiet degradation instead of a
  permission wall, are correct and non-negotiable.
- The title rule itself (`packages/shared/src/budgetTitles.ts`) is good. It has
  one bad input (F6), not a bad rule.

---

## 2. Information architecture

### 2.1 Whose question does the default view answer?

**The cardholder's, explicitly.** "I am about to swipe for a thing that is
happening soon — how much room is left?" That is the ask this screen was built
for (`finances.ts`'s own doc comment: "cardholders shouldn't have to ask her"),
it is the only reason the query is not seat-gated, and it is ~16 people vs one
treasurer. The treasurer's "are we healthy" question is answered by the **year
header totals** and the **filter chips** (§2.4), both one tap away, and in full
on the finance dashboard, which is her actual home.

Concretely, that decides three things: the default scope is **the current year**;
the default order inside it is **by nearness to today, upcoming first** (§3);
and past years are **present but folded**.

### 2.2 Page skeleton (top to bottom)

```
Budgets                                                    ← h1
How much has been spent on each budget, and how much is left.   ← one line (C3)

┌ 2026 ─────────────────────────────────────────────────────┐
│ Budgeted $48,200 · Spent $31,404 · $16,796 left · 2 over  │   ← year summary strip
└───────────────────────────────────────────────────────────┘

[ All (14) ] [ Over budget (2) ] [ Nearly out (3) ]            ← filter chips
[ Search by name… ]                                            ← one field

2026 · EVENTS & PROJECTS                                14  ▾  ← expanded by default
  <row> <row> <row> …

RECURRING · this month                                   4  ▾  ← only if non-empty
  <row> <row> …

2025                    12 budgets · $38,400 spent · 3 over  ▸  ← collapsed
2024                     6 budgets · $12,100 spent           ▸  ← collapsed
```

### 2.3 Years: exact rules

- **A row's year is `periodYear`, computed server-side** (§5): the Eastern year
  of the linked event/project's `refDate` when the ref is live, else the
  budget's own `budgets.year` (schema `apps/convex/schema/finances.ts:161`).
  Rationale: the event date is what a human means by "the 2025 budgets", and
  `budgets.year` is a fiscal period stamp that is *known* to disagree — the
  #721 commit message calls out "a budget stamped to last November for a
  January event". `budgets.year` is the honest fallback for a budget with no
  live ref, and it is never null.
- **Section order:** current year → `RECURRING` → previous years, descending.
  Recurring sits after the current year and above the archive because (a) it is
  by construction current-year-only (`finances.ts:5726`), so it is not part of
  the archive, and (b) it is a short stable list that must never push the year
  people came for below the fold.
- **The current year is expanded. Every previous year is collapsed.** State is
  per-session component state (`useState<Set<number>>`), not persisted — a
  reader who expands 2024 to answer one question should not find it expanded
  next week.
- **A year with no rows does not render.** Gaps are not filled: if a chapter has
  2026 and 2024 budgets and nothing in 2025, the page shows two year sections.
  There is no "no budgets in 2025" placeholder — it says nothing.
- **A collapsed year header shows:** the year, `N budgets`, `$X spent`, and —
  only when non-zero — `N over` in **muted** type, never the danger red. Not
  budgeted, not "left": a closed year's remaining-room is not a number anyone
  acts on, and four figures on one collapsed line is unreadable. Pressing
  anywhere on the header expands it.
- **An expanded year header shows** the year, the row count, and a chevron; its
  numbers move into the year summary strip that renders directly under it
  (identical shape to the current-year strip at the top, so an expanded 2025
  gets the same treatment 2026 gets).
- **January (and any thin current year):** expand years from the newest
  downward until at least **3 rows** are visible or years run out — capped at
  **2 years auto-expanded**. So on Jan 4, 2027 with one 2027 budget, the page
  shows `2027` (1 row, expanded) and `2026` (expanded, its own header + strip),
  with 2025 and older still folded. This is the only case where a non-current
  year starts expanded, and it is invisible when it doesn't apply.
- **The current year always renders its header and strip, even at zero rows**,
  with an inline "Nothing budgeted in 2026 yet — last year's budgets are below."
  Suppressing it would leave a page whose top section is 2025, which is exactly
  the disorientation the founder is complaining about.

### 2.4 The OVER BUDGET callout: replaced by a chip + a header count

**Decision: delete the section. Make "over budget" a filter chip, scoped to the
same rows that are currently rendered, and a count on each year header.**

Why not the alternatives:
- *Scope the section to the current year only* — still duplicates rows (F2), and
  still costs a full screen of vertical space to say something the row's own red
  `$197.82 over` already says.
- *Sort over-budget rows to the top within a year* — breaks the date ordering
  the whole page is scanned by, and buries the upcoming event a cardholder
  opened the page for beneath three closed ones.
- *Inline marker only* — that already exists (`BudgetGlanceCard.tsx:102-110`,
  red text + `Meter` going danger at `pct >= 100`) and is not discoverable when
  the offender is 30 rows down in a collapsed year.

The chip row is `All (n)` / `Over budget (n)` / `Nearly out (n)`, where
"nearly out" is `pct >= 80 && remainingCents >= 0` — reusing the existing
`status === "warn"` threshold (`finances.ts:2903-2909`) so the page can't invent
a second definition of "getting tight". Chips are hidden when their count is 0.
Chips filter **within the rendered scope** (current year + expanded years +
recurring), never across the archive; expanding 2025 while `Over budget` is
active shows 2025's over rows too, which is the honest reading of "filter the
list I'm looking at". Selecting a chip does **not** auto-expand years.

A collapsed year header's `N over` is pressable: it expands that year **and**
selects the `Over budget` chip. That is the founder's "let me go look at what
went wrong in 2025" path, on purpose, and it is the only way a past-year overage
gets loud — never unprompted.

### 2.5 Recurring

Stays its own section, keeps the word "Recurring" (renaming it is a vocabulary
change and would drag the Academy in for no user benefit — CLAUDE.md's Academy
rule). Two changes: it gets an explicit window label in the header —
`RECURRING · this month` when every bucket is monthly, `RECURRING · current
period` when cadences are mixed — and it is collapsible with an **expanded**
default. It stays current-year-only; the server rule at `finances.ts:5726` is
right and its comment already explains why (a past monthly bucket would read
`$0 of $500` forever). Recurring rows are **excluded from every year section**
and from year totals; the year strips describe one-time budgets only, which is
the only way "Budgeted / Spent / Left" is a coherent sentence.

### 2.6 The row, at rest

```
Worship With Strangers Aug 2026            📅  Aug 22        ▾
$1,240.00 of $2,000.00 spent                      $760.00 left
▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░
```

- **Title** — `row.name` (the resolved title), one line, truncated.
- **Kind glyph** — `calendar` for an event ref, `folder` for a project, nothing
  for an unlinked budget. This is how projects and events stay legible while
  interleaved (§3) and it costs 16px.
- **Date** — `Aug 22` inside the current year, `Aug 22, 2025` elsewhere, muted,
  sentence case, not micro-caps (C1). A row with no date at all shows `No date`
  in faint type rather than nothing, so its position at the tail of its year is
  explained.
- **Money line** — unchanged: `$X of $Y spent` / `$Z left` or `$Z over` in
  success/danger.
- **Meter** — unchanged (`Meter`, `pct`).
- No "OVER" badge: the red `$197.82 over` plus the red bar already carry it, and
  a third signal on the same row is noise.

**Drop-down: unchanged.** Links row (`Open event` / `Money` / `Full detail`),
`Where it went` category mini-bars, the charge list with date · person ·
category · receipt clip · status badge, `N of M · window`. It is the best part
of this screen. The only additions worth considering later (P2): sort charges
by amount as an option, and show the budget's approval state when a raise is
mid-review (today the card silently shows the old cap per
`effectiveCapCents`).

### 2.7 What search and the totals strip scope to

This is the trap the current build fell into, so state it flatly:

- **The year summary strip describes exactly one year — the year whose header it
  sits under.** The top strip is the current year's. An expanded 2025 gets its
  own. No strip ever mixes years, and no strip includes recurring buckets. Its
  label is the year, so it can never be mistaken for a chapter total.
- **Search matches across every year that was loaded, and says so.** When the
  field is non-empty the page collapses to a single flat result list headed
  `MATCHING "genesis" · ALL YEARS` (count), with every row carrying its full
  date including the year, ordered newest-first. Year sections, chips, and the
  year strips are hidden while searching; in their place a single result strip
  labelled `Matching "genesis"` sums the matched rows. Rationale: search is a
  find-one-thing act, not a browse act — a searcher who typed "genesis" wants
  the 2024 Genesis budget to be findable without first knowing to expand 2024,
  and a totals strip labelled "2026" sitting above cross-year results would be
  the exact failure mode being avoided.
- **Search matches on the resolved title OR the underlying event/project name**
  (`refName`, §5), fixing F5. It stays a case-insensitive substring match.

---

## 3. Sorting and grouping rules (implementable as written)

**Grouping**

1. Split rows by `row.type`: `recurring` → the Recurring section, `one_time` →
   year sections.
2. Bucket one-time rows by `row.periodYear`.
3. Render year buckets in descending year order. Suppress empty buckets. Always
   render the current year's bucket even if empty (§2.3).

**Within a year — the current year:**

Order by nearness to today, upcoming first.

```
key(row):
  if row.refDate == null        → bucket 2, tiebreak name asc
  else if row.refDate >= today0 → bucket 0, sort refDate ASC   (soonest first)
  else                          → bucket 1, sort refDate DESC  (most recent first)
```

where `today0` is the start of today in Eastern. So on Aug 14, 2026 the top of
the list is the next thing being spent on (`Worship With Strangers Aug 2026`),
then Sep, then Oct/Dec, then July, June, back through the year, then dateless.
This is an agenda ordering and it is the whole point of §2.1: the row a
cardholder is about to swipe against is row one, not row nine.

**Within a year — any past year:** plain `refDate` **descending** (Dec → Jan),
dateless last alphabetically. There is no "upcoming" in a closed year, and
descending keeps it consistent with how the archive reads elsewhere.

**Dateless rows** (`refDate == null` — an unlinked budget, or one whose event
was deleted; `resolveBudgetRef`'s fallback branch, `finances.ts:2340-2346`) go
to the **tail of the year given by `budgets.year`**, sorted by name. They render
`No date` (§2.6). They are never hoisted and never hidden.

**Projects vs events:** interleaved strictly by date, not segregated. The
founder's own vocabulary is one section — "past events and projects and stuff
like that" — and a treasurer thinking "what did we spend in spring 2026" does
not think in two lists. The kind glyph carries the distinction. A project with a
`startDate` and no `deadline` sorts on `startDate` and now **displays** it (fix
C2 by returning `refDate` and letting the client format, rather than depending
on `dateLabel`).

**Recurring section:** unchanged — alphabetical (`finances.ts:5770`).

---

## 4. The "Blank event" fix

### The general rule

> **A template's name may be used as a budget's title only when that template is
> one a human authored and would say out loud. A system-synthesized or
> platform-owned template has no identity to lend, and a budget linked to one
> must fall back to the event's own name.**

The repo already knows how to say this. `apps/convex/templates.ts:66-70` filters
the Templates tab and the New Event picker with exactly this predicate:

```ts
t.isArchived !== true && t.isPlatform !== true && t.isBlank !== true
```

For titling, `isArchived` must **not** disqualify — an archived "Genesis"
template still named the events that came from it, and stripping the title
retroactively when someone archives a template would rewrite the past. So the
titling predicate is the other two flags:

- `isBlank === true` — the chapter's synthesized ad-hoc template
  (`lib/templates.ts:403-464`). Nobody chose this name; it is the *absence* of a
  choice. → fall back to the event's own name. **This is the founder's ask,
  verbatim: "let's use the event name we have on record."**
- `isPlatform === true` — Academy training templates (`schema/templates.ts`
  `isPlatform` comment). Their names are curriculum artifacts, and a real budget
  should never inherit one.
- Plus the guard that already exists: an empty/whitespace name
  (`budgetTitles.ts:94-98` already treats that as no template).

Generalizing beyond flags — "there may be other useless template names" — the
rule is deliberately **flag-based, not name-based**. Do not build a denylist of
strings (`"Blank event"`, `"Untitled"`, `"Test"`); a chapter is free to name a
real template anything, and a string denylist would silently eat a legitimate
one. If a future template class is similarly identity-free, it gets a flag on
`eventTypes` and one line in the predicate.

### Exactly where to implement

**`apps/convex/lib/templates.ts`** — add, next to `BLANK_TEMPLATE_NAME`:

```ts
/** The name a template may lend to things created from it (budget titles) —
 *  null for a template with no human-chosen identity: the synthesized
 *  ad-hoc "Blank event" row and platform/Academy templates. Deliberately
 *  NOT gated on isArchived: an archived template still named its events. */
export function titlingTemplateName(t: Doc<"eventTypes"> | null): string | null
```

**`apps/convex/lib/budgetTitleResolve.ts:41-46`** — the single call site. Change

```ts
const template = ref.eventTypeId ? await getEventType(ref.eventTypeId) : null;
… templateName: template?.name ?? null,
```

to feed `titlingTemplateName(template)` instead. Because every surface
(`budgetsGlance`, `budgetDetail`, `budgetGlance.expenses`) resolves titles
through this one file, that is the whole fix — one line, three surfaces, no
drift.

### The collision this exposes (P1, same rule family)

Two blank events in December 2025 currently both title `Blank event Dec 2025`.
After the fix they title as their own event names — but nothing stops two events
genuinely both named "Christmas Party". `resolveBudgetTitles` disambiguates only
*template-derived* titles; fallback names are emitted raw
(`budgetTitles.ts:96-97, 138, 155`). Add a **final pass** in
`packages/shared/src/budgetTitles.ts`: after the map is built, group by the
resolved title; for any title held by more than one row, append year (or
month+year on an intra-year collision) using the same date logic, leaving
dateless duplicates alone. This makes the module's promise — "no two rows in one
list read identically if we can help it" — true for every path, not just the
templated one. Pure, testable, no database.

**Academy check (CLAUDE.md):** `packages/shared/src/academy/streams/finances.ts:620`
teaches the naming rule ("Event budgets are named after the event template they
came from…"). The blank-event carve-out needs one clause added there — an
ad-hoc event keeps its own name. Nothing else in the Academy describes this
tab's layout, so the year grouping needs no lesson change; say so explicitly in
the PR description.

---

## 5. Query changes

**Reshape `finances.budgetsGlance`. No new query.** Args stay `{}`.

Three fields added to `glanceBudgetRow` (`finances.ts:5593-5619`); nothing
removed, so `budgetGlance.expenses`, `budgetDetail`, and the dashboard are
untouched.

| Field | Type | Meaning |
|---|---|---|
| `periodYear` | `v.number()` | The year this budget belongs to for grouping: Eastern year of `refDate` when the ref is live, else `b.year`. Never null. Recurring rows carry `b.year` (== current year by construction). |
| `refDate` | `v.union(v.number(), v.null())` | The linked event date / project deadline-or-start. **Already computed** by `resolveBudgetRef` and currently discarded at `finances.ts:5775` — stop discarding it. Lets the client sort, format per-year (C1), and place a deadline-less project (C2). |
| `refName` | `v.union(v.string(), v.null())` | The live event/project's own name — what a human typed. `null` when there's no live ref or when it equals `name`. Search matches title OR this (F5). |

Server-side changes inside the handler:

- Compute `periodYear` with `easternParts(refDate).year` when `refDate != null`,
  else `b.year`. `easternParts` is already imported.
- Keep the existing `oneTime.sort` (`finances.ts:5766-5769`) as a stable
  baseline; the year/agenda ordering (§3) is client-side, since it depends on
  "today" and on which year bucket a row landed in.
- Swap `readChapterId(ctx)` at `finances.ts:5662` for
  `requireBudgetGlance(ctx)` from `lib/budgetGlanceAccess.ts` (F8). Identical
  behavior today (that resolver *is* `getChapterIdOrNull`), and it retires the
  dead code CLAUDE.md's gating rule asked for.

**Deliberately NOT added:** a `years[]` summary array. The query already returns
every row with no pagination, so per-year counts and totals are a `reduce` on
the client and a server-side copy would be a second definition of the same
number waiting to drift.

**P2 — when the payload stops being free.** `budgetsGlance` takes up to
`ROLLUP_SCAN_LIMIT` (5000) budgets and returns all of them. That is fine at 19
rows and not fine at 400. The shape to grow into, when it matters:

```ts
budgetsGlance({ includeYears?: number[] })
  → { year, month,
      years: { year, count, capCents, spentCents, remainingCents, overCount }[],
      oneTime: Row[],   // current year + any includeYears
      recurring: Row[] }
```

Collapsed year headers then render from `years[]` without their rows, and
expanding a year re-queries with `includeYears: [...prev, 2024]`. The IA in §2
was chosen to make this a drop-in: nothing above a year header ever depends on a
collapsed year's rows.

---

## 6. Roadmap

### P0 — one PR, shippable, size **M**

Everything the founder named, and nothing else.

1. Year sections: current expanded, previous collapsed, ordering per §3, empty
   years suppressed, January auto-expand rule.
2. Delete the duplicate `OVER BUDGET` section; ship the `All / Over budget /
   Nearly out` chips and the per-year `N over` count (§2.4).
3. Year summary strip replaces the all-history totals strip; search scoping per
   §2.7, including matching on `refName`.
4. Blank-event title fix (§4) + the `titlingTemplateName` predicate.
5. Copy: empty state (F7), header line (C3), human dates (C1).
6. Query: `periodYear` / `refDate` / `refName`, `requireBudgetGlance`.

Files: `apps/convex/finances.ts` (`glanceBudgetRow` + `budgetsGlance`),
`apps/convex/lib/templates.ts`, `apps/convex/lib/budgetTitleResolve.ts`,
`apps/mobile/app/(app)/finances/budgets.tsx` (the bulk — a `YearSection`
component and a `groupByYear` helper),
`apps/mobile/components/finance/budgets/BudgetGlanceCard.tsx` (date + glyph),
`apps/convex/tests/budgetsGlance.test.ts` (new: `periodYear` from ref date vs
`b.year`; blank template falls back to event name; platform template likewise),
`packages/shared/src/academy/streams/finances.ts:620` (one clause).

### P1

- **S** — Fallback-title collision pass in `packages/shared/src/budgetTitles.ts`
  + tests (§4). Files: `budgetTitles.ts`, `budgetTitles.test.ts`.
- **S** — Sticky year header while scrolling an expanded year; the current-year
  strip is the page's answer to "where am I".
- **S** — Recurring section: window label + collapsible (C4).
- **M** — Treasurer affordances: a per-year "closed" read — total budgeted vs
  spent vs the year's actual outflow — and an export of one year's rows. This is
  the point at which the strip could gain a fourth stat.

### P2

- **M** — Payload capping / lazy year loading (§5, P2 shape). Trigger: >150
  one-time budgets in a chapter.
- **S** — Drop-down: sort charges by amount; surface a mid-review cap increase
  so the card explains why its cap looks stale.
- **S** — Remember expanded years within a session across navigation (route
  param, not storage).

---

## 7. Risks and open questions for the founder

1. **Which date defines "the year"?** I chose the **event/project date**, with
   the budget's own `budgets.year` as fallback. A budget approved in Nov 2025 for
   a Jan 2026 event will therefore file under **2026**. If Finance thinks in
   fiscal-period terms — "that was last year's money" — this flips and both
   answers can't be shown at once. *Assumption made; needs a yes/no.*
2. **Calendar year, or a fiscal year?** Everything here assumes the Eastern
   calendar year, consistent with `easternParts` throughout finance. If Public
   Worship books a July–June year, the section boundaries are wrong and the fix
   is a constant, not a redesign.
3. **Ordering inside the current year.** I chose upcoming-first-then-recent
   (agenda order) because the primary reader is a cardholder. It is a visible
   change from today's strict newest-first, and a treasurer scanning
   chronologically may find the seam odd. Cheap to swap to plain descending if
   the founder prefers.
4. **Should past-year overages be visible to everyone at all?** They currently
   are, to every member. My design keeps them visible but silent. An alternative
   is folding closed years behind a single `Previous years ▸` disclosure so the
   list of years itself is one line. Worth asking whether "still load
   everything" means "all years listed" or "reachable in one tap".
5. **What is "over budget" for a past event, operationally?** If a closed event
   that ran over is *supposed* to be reconciled or its cap amended, then a past
   overage isn't noise — it's a task nobody has a queue for. That queue belongs
   on the finance dashboard, not here, but somebody should own the question.
6. **Blank-event budgets after the fix inherit whatever the event is called.**
   That is exactly what was asked, and it means the quality of these titles is
   now the quality of event naming. If ad-hoc events are commonly named "Event"
   or left as a date, the P1 collision pass becomes P0.
7. **Recurring buckets remain current-year-only.** A treasurer asking "what did
   Coffee cost us in 2025" gets no answer on this tab, in any design here.
   That's a real gap with a real cause (no historical window is stored); it
   should be a dashboard/report feature, and I'd rather name it than fake it.
