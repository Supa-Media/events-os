# Territories — addendum to the Giving Platform PRD (F-6)

**Status: shipped (Territories P2, this PR). Owner-approved.** This is an
addendum to `docs/plans/giving-platform.md` §5 (the public `/give` map). It
records the decisions that replace the `cityCampaigns` model with
**territories**, and supersedes PRD **B6** ("prospect cities are
`cityCampaigns`, not fake `chapters` rows") and resolves PRD **Appendix C#3**
(where prospect-city money is held).

## The model, in one line

A **territory** maps **1:1 with a real `chapters` row**. Creating a prospect
territory creates a real but inactive **"shadow chapter"** (`isActive: false`)
in the same mutation. Prospect pledges/donors/gifts scope **directly** to that
chapter. Launch is a flag-flip (`chapters.isActive: true`), not a data move.

## Decisions

### D1 — Territories 1:1 chapters (supersedes B6)

PRD B6 kept prospect cities OUT of `chapters` so "chapter" always meant
"operating chapter". That bought a clean noun at the cost of a whole parallel
scoping convention ("central + `cityCampaignId`") and a re-scope migration
deferred to launch. We reverse it:

- A territory **is** a chapter from creation. `isActive` — already on
  `chapters`, already the fleet-enumeration gate — is what distinguishes a
  shadow (prospect/raising) chapter from a live one. "Operating chapter" now
  means `isActive === true`.
- `territories.saveTerritory` is THE product chapter-creation flow the
  `seed.ts:ensureChapters` comment promised. It inserts the shadow chapter +
  the territory row atomically. Increase provisioning is **not** run at create
  — only at launch.
- There is no `backerCount` on a territory: the count is ALWAYS read from the
  linked `chapter.backerCount` (derived by
  `givingPledges.recomputeChapterBackerCount`). One number per place, no drift.
- Slug uniqueness is enforced against **both** `territories.by_slug` **and**
  `chapters.by_slug` (a shadow chapter carries the territory's slug).

### D2 — Direct-to-chapter scoping (resolves Appendix C#3)

Because a prospect territory's shadow chapter is a real `chapters` row, a
prospect backer's donor/pledge/gift scope **directly to that chapter** — the
"central-held + `cityCampaignId`" convention is retired. This resolves the
Appendix C#3 open question ("held designated for that city vs general central
revenue") by making it moot: the money was never central's; it belongs to the
(shadow) chapter from the first pledge.

- `preparePledge` takes a `chapterId` only. Guard: an **inactive** chapter is
  backable only through a `publiclyVisible` territory still in
  `prospect`/`raising` — otherwise NOT_FOUND (a bare inactive/demo chapter can
  never be pledged to).
- **Launch moves nothing.** `setTerritoryStage → launched` flips
  `chapters.isActive: true`, stamps `launchedAt`, schedules
  `internal.increase.provisionAccountForScope`, and seeds the chapter's default
  roles/templates (mirroring `ensureChapters`). Backers are already on the
  chapter. Launched is terminal in v1.

### D3 — The launch pot (rules set here; wiring next PR)

`territories.launchFundCents` (init 0) + `launchFundTargetCents` (default
`launchTemplateTotalCents()`) are on the schema now so the next PR needs no
second schema migration. The **rules**, recorded here:

- **100% accrual.** While a territory is `prospect`/`raising`, backer money
  accrues to its pot toward the launch grant.
- **Freeze at launch.** When the territory launches, the pot freezes — the
  chapter is live and funds itself from ongoing backer revenue (85/15 split).

The accrual/freeze **wiring is deferred to the next PR**; this PR ships the
fields only.

## Migration & rollout

- `migrations/0029_territories_cutover.ts` seeds the New York territory
  (launched, on the live `new-york` chapter), turns every legacy `cityCampaigns`
  row into a territory (creating shadow chapters for prospect/raising rows), and
  re-scopes campaign-linked pledges/donors/gifts directly onto chapters with
  paired `applyScopeDelta`s so central/chapter rollups net to zero. Idempotent.
- Public URLs are unchanged (`/give`, `/give/<slug>`), so already-shared links
  survive the cutover.
- **Deploy B**: `cityCampaigns` (schema + `cityCampaigns.ts`) and
  `pledges.cityCampaignId` / `by_cityCampaign` stay registered ONLY so 0029 can
  read the legacy rows. A follow-up PR removes them once 0029 has run in prod —
  see the `DEPLOY-B(territories):` markers.

## Academy

Training-worthy: yes. The development-stream lessons were updated in the same PR
— "prospect city" → "prospect territory", the shadow-chapter model, and
direct-to-chapter scoping (the old "backers stay central-held until launch"
teaching is obsolete).
