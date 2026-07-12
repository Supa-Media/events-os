# Chapter OS — rebrand, scoped lobbies, the Central tier, and schema clarity (DISCUSSION DRAFT)

**Goal.** Resolve the identity drift ("events tool" → "operating system for how
Public Worship runs a chapter") deliberately instead of by accretion: one
product name that fits the real scope, one canonical word per concept, a
landing experience where every person sees only the things they have to worry
about, a Central tier that explains where HQ does its work, and a schema where
the playbook's hard-won wisdom is typed and enforced rather than living in
seed rows and markdown.

Sources: a five-track product/design/QA audit of this repo (domain-model fit,
cold-user walkthrough, brokenness audit, naming audit, UX heuristic review —
July 2026), the real plans (`docs/notion-reference/eden.md`, `wws.md`), the
shipped schema (`apps/convex/schema/*`, `packages/shared/src/index.ts`), the
mobile IA (`apps/mobile/components/ui/AppShell.tsx`,
`apps/mobile/app/(app)/**`), and the prior plan docs in `docs/plans/`.

---

## 1. Where we are today (the audit in one section)

The July 2026 audit scored the product on five dimensions:

| Dimension | Score | Headline finding |
|---|---|---|
| Functionality / not broken | 8/10 | Typecheck clean in all 3 packages, 335/335 backend tests pass, zero dead tables or broken routes — but `turbo run lint` and 2/4 mobile guardrail tests fail on fresh checkout |
| Domain-model fit for Public Worship | 5.5/10 | The template→event→T-offset spine is a faithful digitization of the playbook; the highest-stakes worship concepts (run of show, permits, budget, inventory) are untyped grid rows or absent |
| Clarity of purpose (UX) | 4/10 | One sentence (the Pipeline subtitle) carries the entire explanation of what the product is; the best copy lives in seeded data a fresh chapter won't have |
| Terminology clarity | 4/10 | Four simultaneous names for the core planning concept (module / area / workstream / stream); "Duties" and "Projects" each point at two different tables |
| New team member can jump in | 4/10 | Coherent once trained (7–8/10); hostile in the first mile — CLI-only chapters, a first-run CTA that throws a permission error, guides hidden behind an unlabeled pill |

The core diagnosis: **the product's knowledge lives in seed data and markdown,
not in the product.** A trained member and a cold newcomer experience two
different apps, and closing that gap *is* the mission ("any chapter lead, in
any city, without one person's memory").

The history explains the shape: the app began as a Notion replacement for the
events team, then grew people management, projects, and duties because the org
needed an OS, not an events tracker. The scope is legitimate; the name,
navigation, and vocabulary still describe the original mission.

---

## 2. Product identity: Chapter OS

**Rename the product to Chapter OS** (or a PW-branded equivalent). The app
operates a chapter — the one term in the entire naming audit with zero
confusion across schema, UI, and docs, and already the tenancy unit
(`schema/chapters.ts`). Under the chapter frame, the surfaces stop fighting
the name:

- A chapter has **Events** (time-boxed, template-driven — the wedge and the
  most mature surface),
- **People** (roster, engagements, org),
- **Projects** (finite non-event work),
- **Duties** (recurring work),
- **Songs**, **Academy**, and an **inventory**.

"Duties and Projects don't belong in an events tool" was a fair critique of
Events OS. Under Chapter OS they're pillars.

---

## 3. Canonical vocabulary (the term sheet)

One word per concept, everywhere — schema, UI, docs, guides. The test for
done: a new lead never has to be told which of two same-named things you mean.

| Concept | Canonical name | Replaces / notes |
|---|---|---|
| Chapter founding & operating doc | **Chapter Playbook** | New, Central-published (§5): how to start and run a chapter. "Playbook" is *reserved* for this level — it contains the event Templates, song bank, guides, and Academy courses. Never use "playbook" for an event blueprint. |
| Reusable event blueprint | **Template** | Keeps the existing UI word (zero retraining). The backend split-brain heals the cheap way: `eventTypes` table → `templates`, unifying with the `template*` file family in the purge migration (§7c). The wisdom-carrying artifact lives one level up as the Chapter Playbook, so "template" no longer has to imply an empty form. |
| Dated event instance | **Event** | Retire "Pipeline" as a synonym for the events list in docs; the screen keeps "Pipeline" only as the list's title, never as the entity name. |
| Planning surface inside an event | **Area** | Ban "workstream" and "stream" from all UI text and doc prose (fix the "No workstreams active" leak in `apps/mobile/app/(app)/template/[id].tsx`; retitle/redirect the `so-you-own-a-workstream` guide slug). `module` may survive as a code-only term. |
| Recurring org work | **Duty** | Retitle the "Responsibilities" screen header to Duties; rename the event-crew `volunteer_expectations` grid label from "Crew Duties" to **Crew expectations** so the word isn't doubled on one screen. |
| Finite non-event work | **Project** | Relabel the People-grid `people.projects` column to **Involvements** (it's participation history, not links to the `projects` table). |
| Event staffing role | **Role** | `people.role` becomes **Title**; `userChapters.role` becomes **Access level**. "Role" then has exactly one meaning. |
| Org-chart surface | **Org** (a view inside People, not a tab) | Frees "Team" for its crew-sub-team meaning only (`engagements.teams`). |
| Public-facing side of an event | **Event page** | Replaces "Tickets/Ticketing" as the surface name — the tab holds the public landing page plus everything that flows from it (RSVPs, tickets, giving, check-in, blasts). See §7d. **Discipline:** the internal event detail screen is never called a "page" — you open *the event*, you share *the event page*. |
| Auth allowlist | `accessAllowlist` | Rename the `guests` table — it contains an OTP allowlist, not guests. |

Module key → label drift (`planning_doc` → "Tasks", `retro` → "Debrief", …)
stays as-is — keys are storage, labels are product — but the canonical labels
above become the *only* labels.

---

## 4. Scoped lobbies: everyone lands on exactly their job

The events team's overwhelm isn't caused by Duties existing in the product —
it's caused by Duties existing *in their lobby*. The fix is progressive
disclosure derived from a legible rule:

> **You see a surface because you hold something in it. You land on the work
> you hold.**

Four tiers, derived — not configured:

1. **Volunteer** (holds an engagement on ≥1 event): lands on "your next
   event" — call time, their duties, run of show, how-to videos. Essentially
   the `/share/` briefing as their authenticated home. No Pipeline, no
   People, no Work.
2. **Events team member** (holds roles on events): lands on "your events and
   what's due" — the What's-next list across their events. Events tab
   visible; People/Work/Org absent.
3. **Team lead** (owns duties and/or has reports): Work and People appear.
4. **Chapter admin**: the whole chapter.

Two guardrails so per-person nav stays legible instead of mysterious (the
audit's complaint about today's permission-dependent tabs):

- A **"why do I see this?"** line in the profile ("You see Work because you
  own 2 duties").
- Tabs never *reorder* per tier; they only appear/disappear.

**Keystone dependency:** every lobby derives from the person↔user link. Today
that connection is an afterthought ("ask a chapter admin to connect your
account on the People tab" — `apps/mobile/app/(app)/(tabs)/team.tsx`). It must
become automatic at first login (match on auth email ↔ `people.pwEmail`, with
an admin fallback for ambiguity), or the scoping model has nothing to hang
off.

### No Home tab — the default tab is derived, and "mine" is a view

A "Home" aggregator tab is what apps build when they don't trust their
pillars, and it dilutes the identity statement (this product is about
events). Instead:

- **The default tab is derived, not added.** A volunteer's app *opens on*
  their event briefing; everyone else's opens on Events. No new tab — a
  per-tier starting point.
- **"My work" is a pinned view inside each pillar, not a place.** Events
  leads with a "Mine" section (my events, my due items); Work leads with my
  duties and projects. The seam between the three work systems is a
  consistent *pattern* ("every pillar leads with your slice") rather than a
  fifth surface competing for identity.

### Navigation (all tiers, before scoping removes items)

1. **Events** — the pipeline, unchanged as the wedge; opens on "Mine."
2. **People** — roster + Org merged (Org becomes a view).
3. **Work** — Projects and Duties together (siblings: finite vs. recurring).
4. **Songs**
5. **Academy** — the central learning hub (see §5a); keeps its tab.

This cuts the 7-item mobile tab bar to ≤5 for every tier.

---

## 5. The Central tier: publish upstream, run downstream

Chapter OS needs an answer for where HQ works. The schema already believes in
Central without admitting it: `isPlatform`/`platformKey` flags on templates,
docs, and people; platform-seeded guides; `deriveFromEventTypeId` ("WwS is a
scaled-down Eden"). Promote that from a boolean to a tenant:

> **Central is a workspace one level above chapters. Central publishes;
> chapters run.**

- **The Chapter Playbook.** Central's flagship artifact: the versioned
  founding-and-operating document for a chapter. It is the container for
  everything below — the event Templates, the song bank, the guides, and
  the Academy courses. "Provision a chapter" (§5b) means "instantiate the
  Chapter Playbook."
- **Templates.** Central authors and versions the canonical event
  templates (Eden, WWS, LTN). Chapters *subscribe*: they always see the
  current canonical version, may fork locally, and — using the existing
  retro→template promotion machinery (`sourceTemplateItemId`,
  `templateSync.ts`) — a chapter's retro learning either promotes to their
  fork or is **proposed upstream** to Central. Central accepts it into the
  canonical template and every chapter inherits it. Institutional memory at
  network scale, built from machinery that already exists.
- **Songs.** Central owns the canonical song bank (the "Songwriting &
  Selection Philosophy" made executable); chapters see central + local
  additions. Publish/local-overlay, same as templates.
- **Docs & brand.** Guides, brand assets, comms templates:
  Central-published, chapter-readable, local additions clearly marked local.
- **People.** A person belongs to the network; chapters hold engagements
  with them (the existing engagement model with tenancy lifted one level).
  Central sees the cross-chapter roster — who has led events where, who
  could seed a new city.
- **Inventory.** Chapter-owned by default (the green luggage lives in
  Brooklyn); Central can own loanable assets and see the aggregate.
- **Central's home.** Cross-chapter pipeline: every upcoming event across
  the network, readiness, template version drift ("Austin runs WWS v3,
  canonical is v5"), and the queue of upstream proposals.

### 5a. Academy: the central learning hub, with scoped courses

Academy stays a first-class pillar with its own tab — it is *the* learning
hub, published by Central like everything else in the Chapter Playbook. The
catalog is scoped by what a course teaches:

- **Role courses** — how to play a role in an event: Production Lead,
  Comms Lead, worship-team roles.
- **Ownership course** — owning an event end-to-end. The existing
  capstone-with-training-event mechanic is exactly right here.
- **Team courses** — per-team tracks (e.g. music team), plus management
  tracks for leads: people management, project management.

Distribution comes free from the lobby model (§4): **courses surface
contextually based on what you hold.** First time assigned
`production_lead` → "Take the Production Lead course" appears on that
event. About to own your first event → the ownership course is suggested
at creation. Academy stays the hub; the pillars become its funnels.

### 5b. Provisioning replaces chapter cloning (V3)

**Chapter cloning stops being a feature and becomes a consequence.**
Spinning up a chapter = provisioning an empty chapter with the Chapter
Playbook — its templates, song bank, guides, and courses. Day one, a new
lead lands in a lobby containing exactly one thing: "Create your first
event from the WWS Template." That retires the CLI-only
`seed:ensureChapters` path and the "Seed demo data" first-run CTA (which
currently throws a permission error for non-superusers).

---

## 6. First-run, rebuilt on the above

With Central provisioning and scoped lobbies in place, first-run becomes:

1. OTP login → person auto-linked (§4 keystone).
2. Lobby sized to what you hold; a brand-new chapter admin's lobby says
   "Create your first event from the WWS Template."
3. Academy courses surface contextually (§5a): first-role and
   first-ownership prompts, plus a starter course for anyone with zero
   completed tracks.
4. Guides are Central-published product content — they exist for every
   chapter from day zero instead of vanishing when seeds weren't run.

---

## 7. Schema clarity — graduating the domain out of `v.any()`

Rule of thumb: **if the playbook has wisdom about it, it deserves a type** —
because typed schema is the only place the app can *enforce* the wisdom
instead of merely displaying it. The generic grid engine stays as the
long-tail escape hatch; the load-bearing concepts graduate.

### 7a. Typed domain graduation (feature-by-feature)

- **Run of show.** Segments with wall-clock times and ranges, a call-times
  block (Team Arrival / Huddle / Setup / Start), segment kinds, and a typed
  link from the worship-set segment to the setlist (`setlistEntries`). Fixes
  the midnight-anchor trap (events created without a start time anchor
  Day-of "now/next" to 12:00 AM) and lets minute-offset rows generate
  reminders.
- **Permits.** Applied/approved/denied/waived states, jurisdiction,
  lead-time floors, document attachment, and a required "if denied" fallback
  field — Eden's park permit was denied and the event survived because the
  plan had a written fallback; that should be a guardrail, not a war story.
- **Budget & giving.** Line items with planned vs. actual, receipts, and a
  first-class **donation/giving** record. Ticketing exists for fundraisers
  and RSVP capture; giving is the missing half of that story (Eden's actual
  money flow was a donations QR + merch table, which the schema cannot
  record while tracking ticket refunds to the cent).
- **Chapter inventory.** Chapter-level assets that events *reserve* from, so
  two overlapping events can't both "have" the 200W battery, and "charge the
  battery (VERY IMPORTANT)" becomes asset state, not a re-materialized task
  row.

### 7b. Grid-engine validation

- `columnFields.type` becomes `v.union(v.literal(...))` over the actual type
  set instead of `v.string()`; each type gets a validated `config` shape
  instead of `v.any()` (`schema/shared.ts`).
- Item `fields` stay flexible, but writes validate against the column's
  declared type at the mutation boundary.

### 7c. One deliberate legacy purge (single migration release)

Every admitted-legacy field gets a migration and dies together — pre-launch
with one chapter is the cheapest this will ever be:

- `people.skills` → `services`; `people.team` → `teams` (drop the back-compat
  pair); `people.isActive` (derive from `status`).
- `responsibilities.howTo` (doc-only via `howToDocId`).
- `projects.statusNote` / `nextSteps` (superseded by `projectComments`).
- `docs.seedHash` (self-declared "DEPRECATED — never read").
- `siteMarkers.category` (legacy, no longer written).
- Table renames ride the same wave: `eventTypes` → `templates` (unifying
  with the `template*` file/function family), `guests` → `accessAllowlist`.

### 7d. The Event page surface (ticketing, reframed)

Keep the machinery — it exists so fundraiser and RSVP data never has to
leave the app — but reframe it as **the Event page**: the public-facing
side of an event and everything that flows from it:

- The **landing page** itself, **RSVPs** (free events), **Tickets**
  (fundraisers), **Giving** (donations, new — §7a), **Check-in**, and
  **Blasts**.
- Blast audiences must include **crew/volunteers** (engagements) — the
  Eden retro's literal ask ("text-blast app for volunteers") and the one
  send channel the comms guide says matters most. Today volunteers are not
  a blast audience at all.

---

## 8. Riders: bugs and toolchain debt to fix alongside

Not part of the rebrand, but found by the audit and cheap to carry on the
same milestones:

1. **Superuser allowlist** (`apps/convex/lib/superuser.ts`) contains
   third-party-domain emails (`seyi@events.com`, `test@events.com`,
   `seyi@events.test`). Remove immediately — whoever controls those inboxes
   can OTP in and manage guest access / AI settings.
2. **Lint is dead on fresh checkout** — `apps/mobile/eslint.config.js`
   spreads the `@supa-media/linter` plugin object as if it were a flat-config
   array (`TypeError: supaConfig is not iterable`).
3. **Mobile guardrail tests fail deterministically** — `.npmrc`
   `node-linker=hoisted` contradicts the single-React-instance check, and
   `react-native-css-interop` is missing from `native-deps.json`.
4. **Site-map referential integrity** — the `TODO(integrity)` in
   `schema/siteMap.ts`: deleting a supply item / engagement / template person
   must cascade to `siteMapPlacements`.
5. **`places.ts`** is an unauthenticated action proxying the Google Places
   key — add `requireAccess`.
6. **Silent `catch {}`** in the AI/Academy panels — surface failures.

---

## 9. Phasing

1. **Words** (days, zero migration risk): term sheet applied to all UI
   labels, doc prose, and guide slugs; "workstream" leak fixed; Duties /
   Projects / Title / Access level relabels. Riders #1–3.
2. **Lobbies** (the Home screen + derived nav + auto person↔user link):
   the single biggest lever on "only see what you worry about." Riders #4–6.
3. **Purge** (one migration release): §7c legacy fields + table renames
   (`templates`, `accessAllowlist`); grid-engine validation (§7b).
4. **Central** (tenancy lift): platform flags → Central workspace;
   template subscribe/fork/propose-upstream; provisioning replaces chapter
   cloning; Central home.
5. **Typed domain** (feature-by-feature, §7a): **Giving first** (unlocks the
   fundraising story), then Run of show, Permits, Budget line items,
   Inventory.

Product rename ("Chapter OS") lands with phase 2 or 4 — whenever the lobby
experience makes the name true, not before.

---

## 10. Decided / open

**Decided (July 2026 discussion):** product name direction is Chapter OS;
"Playbook" is reserved for the chapter level (Chapter Playbook); event
blueprints stay **Templates**; planning surfaces are **Areas**; recurring
work is **Duties**; the public surface is the **Event page**; no Home tab
(derived default tab + "Mine" views instead); Academy keeps its tab as the
central learning hub with role/ownership/team-scoped courses.

**Still open:**

- Whether Central's workspace shares the Chapter OS brand or gets its own
  (e.g. "PW Central").
- The Chapter Playbook's form: a structured entity (versioned bundle of
  templates/songs/guides/courses) vs. a curated doc collection that
  references them.
- Upstream proposal review: does Central accept/reject per-item, or pull a
  chapter fork wholesale (PR-style)?
- Person↔user auto-link policy for people with multiple emails / no
  `pwEmail` on file.
- Whether `module` survives as a code-only term or the code renames to
  `area` during the purge (cost: churn in `packages/shared` + mobile
  components; benefit: grep-ability for new devs).
