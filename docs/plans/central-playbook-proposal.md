# PW Central + Chapter Playbook — data-model proposal (decision-ready)

**Status: awaiting founder decisions before any schema is written.** This is the
one roadmap piece I flagged from the start as design-first — the biggest,
most cross-cutting schema in the app (multi-tenancy, provisioning, releases /
subscribe / drift / upstream proposals). Everything below turns the sketch in
`chapter-playbook.md` §4 and rebrand §5 into concrete tables + the specific
forks I need you to call before I build. Recommendations are marked ▶.

## What already exists (the proto-Central layer to build on)

- **Tiers** (`org.ts` `deriveTier`): admin | lead | member | volunteer — all
  **per-chapter**. There is NO Central/superuser tier yet.
- **Canonical content flags**: `templates` carry `isPlatform` + `platformKey`
  (the Academy already looks up canonical templates this way). `docs` (guides),
  `songs`, `academy` courses (catalog-in-code), and now `assets` (Inventory
  M5.5) are the other content types a release would pin.
- **Chapters** (`chapters` table) are minimal today: name, slug, image,
  isActive. No `isCentral`, no subscription state.
- Provisioning today = the CLI-only `seed:ensureChapters` + a "Seed demo data"
  CTA that throws for non-superusers (the thing Central provisioning retires).

## The six decisions

### D-C1 — How is "PW Central" modeled?
The foundational tenancy call; everything else hangs off it.
- **(a) ▶ Central = a distinguished chapter.** Add `isCentral: boolean` to
  `chapters`; canonical content is simply content owned by the Central chapter
  (subsuming today's `isPlatform` flag). Add a `superuser` tier above `admin` in
  `deriveTier` for the handful who operate Central. *Least new surface — reuses
  the entire chapter-scoped machinery; "am I Central or a chapter?" becomes
  "which chapter am I in + am I superuser."*
- (b) Central = a separate top-level entity (new `central` table + its own
  ownership column on every content type). *Cleaner conceptually, but forks the
  ownership model of every table and doubles the access logic.*

### D-C2 — The three release tables (confirm shape)
Straight from the sketch; I'd build them as:
- `playbookReleases` — `version`, `changelog`, `publishedAt`, `publishedBy`,
  `status` (draft | published); immutable once published.
- `playbookEntries` — `releaseId`, `kind` (template | doc | song | course |
  kit_item), `ref` (typed id into the source table), `pinnedVersion`,
  `mandatory` (can't fork). One row per pinned thing.
- `chapterPlaybookState` — `chapterId`, subscribed `releaseId`, and a per-entry
  state row: `tracking` (auto-updates each release) or `forked` (carries the
  local ref + the canonical version it diverged from). Powers the drift panel.
▶ Confirm these three tables as the shape.

### D-C3 — Release numbering + hotfixes (§6 open q)
- ▶ Sequential (`v6`) over date-based (`2026.07`) — matches the existing
  `templateVersion` integer model and the "your WWS fork is 2 versions behind"
  copy.
- ▶ No hotfixes between releases in v1: a correction is a new release. Simpler
  invariant (a published release is truly immutable).

### D-C4 — Subscription scope (§6 open q)
Can a chapter exclude entries it will never use (e.g. never runs LTN)?
- ▶ **No per-entry opt-out in v1.** A chapter subscribes to the whole release;
  `fork` is the only divergence, and unused entries simply sit unused. Matches
  "subscribed means auto-track" and avoids a per-entry subscription matrix.
  (Revisit once a real chapter needs it.)

### D-C5 — What graduates into the "v1" release (the migration)
The purge/Central phase converts existing `isPlatform`-flagged rows into
entries of an initial "Chapter Playbook v1" release, then retires the flags.
- ▶ v1 entries = the platform templates (already flagged) + platform docs/guides
  + the in-code Academy courses + a Chapter Kit doc. Songs bank and kit-item
  materialization can be **v1.1** so the first slice stays small.
- ▶ Chapter Kit → `assets` materialization: model kit items as entries **now**,
  but wire the actual "materialize into a chapter's `assets` at provisioning"
  step as a follow-up (it depends on provisioning, D-C6 slice 2).

### D-C6 — Size of the first slice
The full vision (composer UI, upstream review queue, adoption dashboard,
provisioning rewrite) is many PRs. I propose slicing:
- ▶ **Slice 1 (build first): tables + "v1" release assembled from existing
  platform content + a READ-ONLY chapter Playbook panel** (current version,
  what's new, per-entry drift). No composer, no provisioning change, no upstream
  queue. Low-risk, shippable, makes Central legible — and it's reversible.
- Slice 2: provisioning flow (replaces `seed:ensureChapters`) + Launch Track.
- Slice 3: PW Central composer + upstream review queue + adoption dashboard.
- Slice 4: Chapter Kit → `assets` materialization; song-bank publish/overlay.

## My recommendation in one line

Build **D-C1(a) + the three D-C2 tables + Slice 1 only**, with D-C3/4/5 as
proposed, then stop and show you the read-only Playbook panel before touching
provisioning or the composer. That gets Central *legible and real* without
committing the whole multi-tenant rewrite up front.

**I will not write any of this schema until you've called D-C1 and D-C6** (the
two that can't be cheaply reversed). The other four I'll take my ▶ defaults on
unless you say otherwise.
