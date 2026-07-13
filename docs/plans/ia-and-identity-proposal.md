# IA & identity design proposal (July 2026)

**Status: DECIDED (founder, 2026-07-13).**

- **D1 → Option C: Move Mine into Work.** The Phase-2 "no Home tab" decision
  *holds*. Events becomes purely the pipeline (+ Templates per D2); the
  personal digest (overdue / due this week / my events) moves to the top of
  Work; the Briefing remains the volunteer surface. (The implementer
  recommended a generalized Home tab; the founder chose C with the tradeoffs
  on the table — recorded here so the decision isn't relitigated by the next
  agent.)
- **D2 → Fold Templates into Events** (as recommended).
- **D3 → Legibility now, tenancy later** (as recommended). The Central
  tenancy model gets its own proposal with the Phase-4 build.
- **D4 → Catalog in code + stored badges** (as recommended): themes → courses
  (level + audience) → modules; `courseCompletions` table as the badge;
  progress re-keyed by migration.

Responds to `docs/plans/ux-review-and-next-phase.md` §B/§D-1. Four decisions
gate the next-phase screens; each is presented as problem → options →
recommendation. An appendix records the code-verified ground truth behind the
concrete bug fixes (which do *not* gate on these decisions, except where
noted).

Everything here was re-derived from the code at HEAD (`42a1f0b`), not assumed
from the review.

---

## D1. The home/landing question (reopens the Phase-2 "no Home tab" decision)

**Problem.** "Mine" works but feels out of place inside Events. Ground truth
makes the discomfort legible: the Events page today is *three products
stacked* — a mini-dashboard (two stat cards from `api.dashboard.summary`), a
personal digest (`MineSection`, fed by the reminder machinery via
`api.work.myOpenWork`), and the actual pipeline list. The page has no single
job. Meanwhile volunteers never see this page at all: `index.tsx:64` redirects
them to `/briefing`, which is — in everything but name — a Home tab that
already shipped and works.

**The Phase-2 rationale, stated fairly:** a Home aggregator is what apps build
when they don't trust their pillars; it dilutes the identity statement; the
derived default tab + "Mine" views achieve the same goal without a fifth
surface. That was a deliberate decision and it produced real code
(`AppShell.useNav`, the redirect, `MineSection`).

**Options.**

- **A — Keep no-Home; clean Events.** Remove the stat cards, restyle "Mine" as
  the pipeline's leading section. Cheapest; honors Phase 2. But it doesn't
  answer the founder's actual discomfort (my work ≠ the chapter's pipeline),
  and volunteers keep a separate one-tier home (Briefing) that no other tier
  benefits from.
- **B — Generalize the Briefing into a Home tab for everyone** *(recommended)*.
  One derived-content surface, first in the nav for all tiers:
  - volunteer → exactly today's briefing (next event, call time, duties,
    how-tos);
  - member/lead/admin → my due & overdue items, my events/roles, the
    chapter's next event;
  - header → **chapter name + your tier + "why do I see this"**
    (`tierReasons` already comes back from `api.org.nav`, currently unused).
  Events then becomes *purely the pipeline* (plus Templates, per D2), and the
  Briefing tab disappears as a separate concept. This is not "adding an
  aggregator out of distrust" — it's admitting that the derived-landing idea's
  logical endpoint is one surface whose *content* is derived, rather than a
  per-tier redirect to different surfaces. It also gives D3 (identity
  legibility) a natural anchor.
- **C — Move "Mine" into Work.** Keeps no-Home; Events becomes pure pipeline.
  Rejected: "my events" doesn't belong in Work, and volunteers stay special.

**Recommendation: B.** Costs to accept: reverses a deliberate Phase-2
decision; admin/lead nav grows to 6 items (Home, Events, People, Work, Songs,
Academy) after Templates folds into Events — one over the rebrand plan's ≤5
target on the mobile bottom bar. Volunteer nav shrinks to 3 (Home, Songs,
Academy); member stays at 5.

## D2. Templates belong inside Events

**Problem.** Templates is a top-level pillar (admin/lead-only) but templates
exist only to drive events.

**Options.**

- **A — Fold Templates into Events as a mode** *(recommended)*: the Events
  screen gets a lightweight segment ("Pipeline | Templates"), visible per the
  same admin/lead gate; `/templates` route survives and redirects for deep
  links. Compatible with the Playbook future (templates become subscribed
  playbook entries — a section inside Events reads naturally as "the
  blueprints this chapter runs").
- **B — Keep the pillar.** Status quo; defensible only if Templates grows
  independent weight (it won't — the playbook moves authoring to Central).

**Recommendation: A.** Low risk, and it buys back nav budget spent by D1-B.

## D3. Central-vs-chapter legibility

**Problem.** A logged-in user can't tell what chapter they're in, what their
access level is, or whether "Central" is a thing. Ground truth: Central does
not exist in the model *at all* — no tenant tier, no flag on `chapters`; a
user's chapter is simply their first `userChapters` row
(`lib/context.ts:33-47`); the only UI is a static label literally reading
"Chapter" (`AppShell.tsx:191-238`). `isPlatform`/`platformKey` exist only on
`eventTypes` (the rebrand plan overstates this — docs use `slug`, people use
`isSamplePerson`).

**Options.**

- **A — Legibility now, tenancy later** *(recommended)*. Now: show the real
  chapter name in the sidebar footer / mobile top bar; the profile screen
  shows chapter, tier ("Access: lead") and the `tierReasons` line. Central
  tenancy modeling waits for the Phase-4 Central/Playbook design proposal —
  which must answer whether Central is a flagged chapter row or its own
  entity. (Lean: its own entity — its home surface is cross-chapter, and
  "Central is a weird chapter" is how the `isPlatform` boolean mess started.)
- **B — Model Central tenancy now.** Rejected: prod has one chapter; the
  playbook design will reshape whatever we build; and the founder's immediate
  pain is legibility, not tenancy.

**Recommendation: A.** The Phase-4 proposal (separate doc, next chunk) carries
the real model decision.

## D4. The Academy model

**Problem.** Today's Academy is one flat 17-section list defined in code
(`packages/shared/src/academy.ts`, `SECTIONS_IN_ORDER`), one progress table
keyed by string slug (`academyProgress`), and a computed "who's trained" panel
on the hub. The founder wants: **themes → courses → levels → curriculum
modules → completion badges** (course page shows completers; person profile
shows badges). Rebrand §5a wants courses *scoped by what they teach* (role /
ownership / team) and surfaced contextually. These reconcile cleanly: §5a's
scoping is course *metadata* (audience), the founder's themes/levels are the
catalog's *shape*.

Ground truth that constrains the design: there are no course/level/badge
entities anywhere — this is greenfield; the capstone→training-event mechanic
(quest rows on an `isTraining` event, terminal-status completion, persisted
`passedAt`) is robust and should become a *module type*, not be rebuilt.

**Options.**

- **A — Catalog in code, badges in the database** *(recommended)*.
  - Catalog stays authored in `packages/shared` (git is today's publishing
    pipeline; no authoring UI exists; the Central phase later lifts the
    catalog behind `playbookEntries` without touching completions), but
    restructured: `themes[] → courses[] → modules[]`, each course carrying
    `level` (beginner / intermediate / advanced / leader) and `audience`
    (role / ownership / team scoping per §5a).
  - Progress rows become (courseSlug, moduleSlug); a migration maps the 17
    existing `sectionSlug`s onto modules of the initial courses so nobody
    loses `passedAt`.
  - **New `courseCompletions` table = the badge** (personId, courseSlug,
    earnedAt): stored, not computed — it's an earned credential and should
    survive catalog restructuring. Course page lists completers from it;
    person profile renders badge chips from it.
  - Sketch of the initial mapping (founder adjusts freely): theme **Events** →
    "Chapter OS fundamentals" (beginner: intro sections), "Running an event"
    (intermediate: timing/phases/tab deep-dives), "Owning an event"
    (advanced/ownership: being-an-owner + the capstones). Management /
    Leadership themes start empty and fill as content is written.
- **B — Fully DB-backed courses now.** Rejected for now: forces building an
  authoring surface before any new content exists, and duplicates what the
  Playbook phase will do properly.
- **C — Minimal regrouping** (theme headers over the flat list). Rejected:
  delivers neither levels nor badges — the two things the founder actually
  asked for.

**Recommendation: A.** The one migration-sensitive piece is re-keying
`academyProgress`; it rides the existing `runPending` pipeline as a numbered
migration.

---

## Appendix: verified ground truth for the concrete fixes (no sign-off needed)

- **Work/Duties "overlay" bug** — at HEAD this is *not* a z-order overlap:
  the Projects and Duties bodies are mutually exclusive (`team.tsx:204`
  ternary; no absolute positioning anywhere in the chain). What reads as
  overlaid: the always-rendered "Work" header + segmented control is
  immediately followed by `DutiesGrid`'s *own* "Duties" title + search
  (`DutiesGrid.tsx:146-166`), while the screen's max-width simultaneously
  jumps from 1180 to full width (`team.tsx:181`). Fix: one header owned by
  the screen, `DutiesGrid` drops its duplicate chrome, width behavior made
  deliberate. (If the founder saw a true overlap, it was likely a pre-merge
  OTA build — worth one confirmation glance after the fix ships.)
- **Project detail page** — backend nearly complete (`projects.list`,
  `projects.comments`, `addComment`, `update` covers status). Missing: a
  `projects.get(projectId)` query and the `project/[id]` route (pattern:
  `doc/[id].tsx`). Reminder emails currently link to the token-authenticated
  `/p/<token>` web page and the comment email links nowhere — both should
  gain a link to the real route.
- **Per-person duty editing** — duty assignment is array membership on
  `responsibilities` (`assigneePersonIds` / `assigneeRoles`), mutated only by
  whole-array `responsibilities.update` (read-modify-write; racy). Fix: add
  targeted `addAssignee` / `removeAssignee` mutations, then per-row
  unassign/edit affordances on the person workload view and duties surfaced
  on the People detail.
- **Stray Events cards** — the "Upcoming" stat card provably duplicates the
  pipeline below it (same predicate as `events.pipeline`); the "People" card
  is a roster stat with no relationship to the surface. Both die under every
  D1 option → safe to remove now.
- **Events OS → Chapter OS rename** — ~25 user-facing strings inventoried
  (login/onboarding brand marks, AppShell, OTP + access + reminder + ticket
  emails, public pages, the AI system prompt, Academy lesson copy, Expo
  display name, iOS permission prompt). Explicitly NOT changing: bundle ids,
  the `eventsos://` URL scheme, EAS project id, `auth@events-os.com` sender
  domain, hosting domains, `@events-os/*` package scope, and the
  `what-is-events-os` academy slug (a stored progress key — the *title*
  changes, the slug survives until the D4 re-keying migration handles it).
