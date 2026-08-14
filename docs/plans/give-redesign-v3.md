# /give redesign v3 — "Back a city"

Founder brief, 2026-08-14. This file is the spec of record; every workstream
builds against the contracts below. Do not change a contract without changing
this file first.

## The thesis

The page leads with a one-time gift card (`renderGiveMapPage`'s `oneTimeCard`
is the first interactive element) and never renders the backer ask at all —
`monthlyGiveFormHtml` is territory-only. The primary conversion is therefore
unreachable from the primary page. v3 flips that: **back a city** is the hero,
giving once stays one tap away, and the two assets the org actually has —
published books and public gifts — get promoted from a footnote to the page's
proof.

## Locked decisions

| # | Decision |
|---|---|
| D1 | Hero is "Back a city". Public copy says **city**; "territory" stays internal. |
| D2 | **No backer-count number in the hero.** The tier ladder (20/30/50) guarantees different things at different counts, so pinning the headline to twenty undersells every rung above it. The ladder does the counting. |
| D3 | **No "nobody draws a salary" claim anywhere.** Not a flex, and it becomes false the day it changes. |
| D4 | Giving once must remain one tap from the hero, and must let the giver pick **central operations** or **a specific city** explicitly. |
| D5 | The money model moves off `/give` to its own page. The books stay at `/finances`. |
| D6 | The gift wall shows **every settled gift**, anonymous by default. Consent gates *attribution* (name + message), never *existence*. |
| D7 | **Central gifts appear on the wall**, tagged `central`. |
| D8 | The wall's total raised is **LIVE** — a giver must be able to give and immediately see the number move. Books language ("published month by month") applies only to `/finances`. |
| D9 | Past fundraisers stay on the city page and **stay giveable**, including ones that already met their goal. Same pot. |
| D10 | City pages drop `noindex`. See "Privacy posture" — this is conditional on D6 landing first. |

## Privacy posture (read before touching the wall)

Today `/give/<slug>` sets `noindex` because the wall pairs self-provided donor
display names with amounts, and the code reasons — correctly — that agreeing to
be *shown* is not agreeing to be *findable by name beside what you gave,
forever*.

D6 changes the default row to anonymous, which removes that objection for the
overwhelming majority of rows. But it does **not** retroactively license
indexing the rows whose owners consented under the old regime.

**Therefore:**

- Every settled gift gets a wall row. Default rendering is anonymous
  (`"A gift to New York — $50"`).
- `displayName` / `message` render **only** when `consent === true`.
- New consent copy must state plainly that the page is public **and can be
  found by search**. Consent captured under that copy is marked
  `consentIndexable: true`.
- On an indexed page, attribution renders only for `consentIndexable === true`
  rows. Pre-existing consents keep their old promise: they still appear, still
  count, but anonymously.
- `noindex` comes off the city page only once the above holds.

Coarse timestamps only (`relativeTimeLabel`'s existing buckets). No method, no
email, no `refKey`, no precise ordering. These are unchanged rules, restated
because the row population is about to get much larger.

## Contracts

### C1 — `api.givingActivity.getPublicWall`

```ts
args: {
  slug: v.optional(v.string()),   // absent → org-wide feed
  limit: v.optional(v.number()),  // default 12, max 30
}
returns: v.object({
  totals: v.object({
    raisedCents: v.number(),   // LIVE, all scopes (or one) — D8
    giftCount: v.number(),
    giverCount: v.number(),
    backerCount: v.number(),
    cityCount: v.number(),     // territories currently taking backers
  }),
  rows: v.array(v.object({
    kind: v.union(
      v.literal("backer"),      // new recurring pledge
      v.literal("gift"),        // one-time, to a city
      v.literal("fundraiser"),  // one-time, against an event with a goal
      v.literal("central"),     // one-time, central operations — D7
    ),
    amountCents: v.number(),
    at: v.number(),                               // coarse-bucketed on render
    scopeLabel: v.union(v.string(), v.null()),    // "New York" | "Central operations"
    scopeSlug: v.union(v.string(), v.null()),
    displayName: v.union(v.string(), v.null()),   // consent-gated
    message: v.union(v.string(), v.null()),       // consent-gated
    goal: v.union(v.null(), v.object({            // fundraiser rows only
      label: v.string(),
      raisedCents: v.number(),
      targetCents: v.number(),
    })),
  })),
})
```

Rules: no auth. Suppress `scopeLabel` for a territory with fewer than 3
lifetime gifts (a single gift in a small prospect city is identifying).
`raisedCents` sums `givingScopeRollups.lifetimeCents` (O(1) per scope, one row
per chapter + central) — do **not** scan `gifts`.

### C2 — `givingActivity` schema widening

- `scope` becomes `givingScope` (`v.union(v.id("chapters"), v.literal("central"))`),
  matching `gifts.scope`. Required for D7.
- Add `consentIndexable: v.optional(v.boolean())` — see Privacy posture.
- Add `kind` values `"fundraiser"` and `"central"` to `ACTIVITY_KINDS`.
- Add index `by_status_and_settledAt` for the org-wide feed.
- `recordPendingActivity` inserts for **every** gift/pledge, not only opt-ins
  (D6). `consent` still gates attribution. The "no name and no message → no
  row" short-circuit is removed.
- Migration backfills wall rows for historical settled `gifts` so the feed is
  populated on day one. Backfilled rows are anonymous (no consent record).

### C3 — `territories.getPublicTerritory` fundraiser extension

Rename `upcomingFundraisers` → `fundraisers`, returning both directions:

```ts
fundraisers: v.array(v.object({
  name: v.string(),
  slug: v.string(),
  goalCents: v.number(),
  raisedCents: v.number(),
  startDate: v.number(),
  state: v.union(v.literal("open"), v.literal("finished")),
  goalMet: v.boolean(),
}))
```

Cap 8 — open first (soonest), then finished (most recent). All remain
giveable, `goalMet` included (D9). PII-free, unchanged otherwise.

### C4 — Routes

| Path | Change |
|---|---|
| `/give` | Recomposed — see "Page composition" |
| `/give/<slug>` | Recomposed; `noindex` removed (D10) |
| `/give/how-it-works` | **NEW** — the money model |
| `/finances` | Unchanged; now linked from both give pages |

`http.ts` routes `/give/<segment>` as a territory slug, so `how-it-works`
**must** be added to a reserved-slug list enforced in `territories.saveTerritory`
alongside the existing uniqueness check, or the new page 404s as an unknown
territory.

## Page composition

### `/give`

1. Topbar — wordmark + "Read our books →" (`/finances`)
2. Hero — "Back a city." + the D2-safe subhead + two CTAs (back / give once)
3. Proof strip — backers · givers · cities taking backers · 100% public → `/finances`
4. **Back a city** — city cards, live `backerCount / targetBackers`, next-milestone line, CTA each; prospect card last ("Ask for a chapter here")
5. **Every gift, in public** — the wall (C1), live total
6. **Or give once** — destination picker (central / a city) + amount + name + email
7. Where the money goes — 3 facts + links to `/finances` and `/give/how-it-works`
8. Map — demoted, prospect dots, "where we're going"
9. Want this in your city? — multi-select + progressive-reveal founding-team block
10. Footer

### `/give/<slug>`

1. Topbar, back link
2. Thank-you state (`?donated=1` / `?pledge=`) — carries the one-time → backer upgrade ask and the books promise
3. City head + progress card + next-milestone callout
4. Give box — **monthly default**, one-time as the second tab
5. Milestone ladder — **merged with the program cards** (same three things: 20 → Worship With Strangers, 30 → Eden, 50 → Love Thy Neighbor); each rung carries its blurb + Instagram link
6. This city's book — one card linking to `/finances`
7. The wall, scoped to this city
8. **Fundraisers** — open and finished, all giveable (C3, D9)
9. Story
10. Footer

Removed from both pages: `moneyTransparencyHtml` (→ `/give/how-it-works`),
`teamPhilosophyHtml` (→ same), `programCardsHtml` (merged into the ladder),
`cityLaunchPlanHtml` (folded into the hero), `activeRaisesHtml` (city cards
supersede it).

### `/give/how-it-works`

The whole money model, single-sourced from `packages/shared/src/finance.ts` as
today: $670/mo operating lines, the 20/30/50 tier ladder, the $8,000 launch
budget, the 85/15 split, the five core roles. **No salary claim** (D3).

## Bugs to fix in this PR

All three are the same cause — `givePage.ts` loads `BASE_CSS + GIVE_CSS`, and
these rules live only in `LANDING_CSS`:

1. `.wordmark` is undefined in `GIVE_CSS` — the logotype renders as plain 16px
   black body text.
2. `.explainer .fact` selectors are dead — no `class="explainer"` element
   exists anywhere, so `moneyTransparencyHtml`'s 85/15 figures render unstyled.
   (Moot once the block moves, but the rules must move with it.)
3. `footer .hearts` is undefined — the footer heart is ink-coloured.

Also: `.amtgrid` is `repeat(4,1fr)`; with
`LAUNCH_FUND_ONE_TIME_PRESETS_CENTS`'s `$1,000` at 15px/700 the cell overflows
on a 360px viewport. Use `repeat(auto-fit,minmax(72px,1fr))`.

## Academy

Vocabulary and user-facing behavior both change, so the Academy must track it
(CLAUDE.md). At minimum: any lesson naming the giving page's structure, the
"where your giving goes" section, or the wall's opt-in behavior. Grep for
`give`, `backer`, `wall`, `transparency` in `packages/shared/src/academy/`.

## Out of scope

- Analytics instrumentation (none exists on any public page today; it is a
  real gap but a separate PR).
- `/give/join` as a standalone recruitment page — the interest form keeps its
  progressive reveal in place on `/give` for now.
- Church/major-donor tier.
