# The Chapter Playbook — PW Central's flagship artifact (DISCUSSION DRAFT)

**Goal.** Define the Chapter Playbook: the versioned, structured bundle PW
Central publishes and every chapter runs on. It has two faces — readable
cover-to-cover like a founder's manual, and executable as a provisioning
manifest. The artifact a prospective chapter lead reads on their phone is the
same thing PW Central "installs" when the chapter goes live: the chapter's
operating-system image, with a version number and a changelog.

Companion to `docs/plans/chapter-os-rebrand-and-schema-clarity.md` (§5), which
established the PW Central tier and reserved the word "playbook" for this
level. Builds on machinery that already ships: template versioning + clone-on-
create (`apps/convex/schema/templates.ts`, `events.ts`), retro→template
promotion (`sourceTemplateItemId`, `templateSync.ts`), platform-published
content (`isPlatform`/`platformKey` flags), Academy tracks, the songs library,
and T-offset scheduling (`schema/shared.ts`).

---

## 1. Table of contents (what a release contains)

1. **Identity & mission.** What a Public Worship chapter is, the
   non-negotiables, brand guidelines and assets (logo, flyer templates, tone
   of voice). Readable prose + downloadable assets.
2. **The Launch Track.** Founding a chapter is *itself a template*. The
   system already knows how to run "a sequence of role-scoped tasks with
   T-offsets back-calculated from a date" — so the launch is a template whose
   anchor date is launch day: T-90 find your core team, T-60 scout
   neighborhoods, T-30 first WWS, with roles like Founding Lead and Comms
   Lead. A new chapter's first "event" in the app is its own founding. Zero
   new machinery — and the new lead learns the product's core mental model
   (templates, offsets, roles, areas) by being run through it.
3. **Event Templates.** The canonical Eden / WWS / LTN, version-pinned per
   release.
4. **Roles & Duties catalog.** Standard role definitions with their
   expectations, and the standard recurring duties a chapter runs (monthly
   team meeting, storage upkeep, comms rhythm).
5. **Song bank.** The canonical songs, with the Songwriting & Selection
   Philosophy as the bank's front page.
6. **Guides library.** "So you own an event / an area" and friends —
   published product content, not per-chapter seeds.
7. **Academy catalog.** The role / ownership / team courses. The Launch
   Track points founding members at the right courses at the right steps.
8. **The Chapter Kit.** The standard inventory manifest (the green-luggage
   list: mixer, SM58s, 200W battery, signs, cabling). Provisioning creates
   the chapter's inventory records from it, pre-flagged "not yet acquired" —
   the playbook's packing list *becomes* the chapter-level inventory on day
   one.

---

## 2. How it behaves

### PW Central composes releases

The editor in PW Central is a curation surface: pin template versions, songs,
guides, courses, and kit items into "Chapter Playbook v6," write the
changelog ("WWS now includes the rain-plan task; added the battery-charging
duty"), publish. A release is immutable once published; corrections are a new
release.

### Chapters subscribe, not copy

A chapter runs "v6 + local forks." The chapter admin sees a quiet **Playbook
panel**: current version, what's new, and which of their items have drifted
from canonical ("your WWS fork is 2 versions behind — see what changed").
Adopting an update is a **choice, not a forced sync** — chapters have local
reality (their venue, their people, their weather). Per-entry adoption
states: `canonical` (tracking latest), `behind` (tracking, updates
available), `forked` (local divergence), `declined` (saw the update, chose to
stay).

### Upstream proposals feed the next release

A chapter's retro learning gets proposed upstream (the existing
retro→template promotion, extended one level). PW Central's review queue is
the editorial desk for the next playbook version. The changelog credits the
source ("from Brooklyn's June retro") — good provenance and good culture:
chapters see their experience becoming everyone's playbook.

### In Chapter OS, the playbook is mostly invisible

It manifests *as* the chapter's templates, songs, guides, courses, and
inventory. The only dedicated surface is the admin Playbook panel. Members
never learn a new concept; leads only meet the word "playbook" when there's
news from PW Central.

---

## 3. Provisioning (chapter cloning, delivered)

Creating a chapter in PW Central = instantiating the latest release:

1. Chapter record created, subscribed to the current release.
2. Templates, songs, guides, and courses materialize as subscribed entries
   (not copies — see §2).
3. The Chapter Kit materializes as inventory records, "not yet acquired."
4. The Launch Track is instantiated as the chapter's first event, anchored
   to the target launch date; the founding lead lands in a lobby containing
   exactly that.

This retires the CLI-only `seed:ensureChapters` path and the "Seed demo
data" first-run CTA for good.

---

## 4. Schema sketch (three tables; everything else reused)

- **`playbookReleases`** — `version`, `changelog`, `publishedAt`,
  `publishedBy`. Immutable after publish.
- **`playbookEntries`** — `releaseId` → typed refs to
  templates / docs / songs / courses / kit items, each with a pinned
  version. Entry kinds mirror the table of contents (§1); prose sections
  (identity, brand) are doc refs.
- **`chapterPlaybookState`** — `chapterId` → subscribed `releaseId`, plus
  per-entry adoption status (`canonical` / `behind` / `forked` /
  `declined`, with the local fork's ref when forked). Powers the chapter's
  drift panel and PW Central's adoption dashboard.

Upstream proposals reuse the promotion machinery: a proposal row references
the chapter item + its provenance (`sourceTemplateItemId` chain) and lands in
a PW Central review queue; acceptance edits the canonical entity and the
change ships in the next release's changelog.

Migration note: today's `isPlatform`/`platformKey` flags on templates, docs,
and people are the proto-Central layer. The purge/Central phases
(rebrand plan §9, phases 3–4) convert flagged rows into entries of an initial
"Chapter Playbook v1" release, and the flags retire.

---

## 5. Sequencing

Rides the rebrand plan's phase 4 (Central):

1. Tables + "v1" release assembled from existing platform-flagged content.
2. Provisioning flow (replaces `seed:ensureChapters`); Launch Track authored
   as a template.
3. Chapter Playbook panel (version, what's new, drift) in Chapter OS.
4. PW Central composer + upstream review queue + adoption dashboard.
5. Chapter Kit → inventory materialization (depends on the typed inventory
   work, rebrand plan §7a).

---

## 6. Open questions

- Release cadence and numbering: date-based ("2026.07") vs. sequential
  ("v6"); whether entries can be hotfixed between releases.
- Can a chapter subscribe to *some* entries and not others at provisioning
  time (e.g. a chapter that will never run LTN), or is trimming done by
  declining after the fact?
- Where brand *assets* live (storage + licensing) vs. brand *guidelines*
  (docs).
- Whether the Launch Track's completion gates anything (e.g. a chapter is
  "launched" when its founding event completes) or is purely advisory.
