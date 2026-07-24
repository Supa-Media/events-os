# Person-Centric Audiences

Founder direction (2026-07-24): kill the Guests/Donors/People source dropdown on
audience creation. **The source is always the people table** — every giver has a
connected person, and same for guests. Audiences are built from robust filters
and/or hand-picked members, store people's email preferences on the person, keep
a list of known email addresses per person, and stay live: someone added to the
people table later is included in any audience whose criteria they match.

This spec captures the full design and its phasing. Each phase is one PR,
shipped in order — later phases depend on earlier ones' data.

## Why phased (recon findings, 2026-07-24)

- Donors → people linkage **already exists and is backfilled**
  (`lib/givingDonors.ts#linkDonorToPerson`, migration `0032`) for chapter-scope
  donors. Central-scope donors are permanently unlinked because
  `people.chapterId` is required — there is no central roster.
- RSVPs/guests have **zero** person linkage (`rsvps` has no `personId`; six
  independent insert sites; N events = N unlinked rows for the same human).
- `people` today is the org roster. Donor-created contact rows already leak
  into roster surfaces as "Volunteers"; several consumers scan the whole table
  (People tab `people.list`, `chapterRoster`, reminders digests). Guests cannot
  be added at volume without a contact/roster discriminator.
- Audiences already resolve **live** at preview and at send
  (`lib/audienceResolve.ts` via `previewAudience` / `resolveAudienceForSend`) —
  the real-time requirement is architecturally satisfied; nothing stores
  membership snapshots except the per-send `campaignRecipients` freeze.
- Suppression (`emailSuppressions`) is keyed by email address. A person with
  multiple known addresses breaks the one-row-one-email model — needs a
  designed precedence + person-level preference layer (Phase 2).

## Phase 1 — Identity backbone

1. **Contact/roster discriminator**: `people.isContactOnly: v.optional(v.boolean())`.
   Contact rows are excluded from roster-facing surfaces (People tab default
   personas, org-chart person pickers, manager derivation, reminder/digest
   scans) but REMAIN visible to identity matching (`chapterRoster` callers that
   exist to dedupe must still see them — audit each call site individually).
   Existing donor-created rows (`isTeamMember: false`, notes "Added from
   Giving"/"Added from import") are backfilled to `isContactOnly: true`.
2. **Guest linkage**: `rsvps.personId: v.optional(v.id("people"))` + a shared
   `linkRsvpToPerson` helper mirroring `linkDonorToPerson` (normalized email →
   phone → exact name against the chapter's people incl. contacts; insert gated
   on `hasPersonIdentifier`; inserts get `isContactOnly: true`). Wire it into
   all six rsvp insert sites: `submitRsvp`, `prepareOrder` (ticketing.ts),
   `givebutterSync.ts` (×2), `giving.ts` event-donation guest capture,
   `eventAttendanceImport.ts`.
3. **Backfill migration** (next number): dry-run by default
   (`execute:false`, `donorIdentityBackfill.ts` pattern), paginated,
   idempotent. MUST dedupe across rsvp rows sharing a normalized email
   (cross-event repeat attendees) BEFORE matching into people, so one human →
   one person row.
4. **Known risks to encode in matcher + tests**: shared family emails (one
   email, multiple attendee names on ticket orders — never merge distinct
   names into one person on email alone when `attendeeNames` diverge; prefer
   leaving extra attendees unlinked), unverified/imported emails as match keys
   (match but never overwrite existing person fields), cross-chapter guest
   duplicates (people has no cross-chapter identity — accept per-chapter
   person rows for now; `donorIdentities` is the model if this needs fixing
   later).
5. **Central scope**: unchanged this phase. Central donors stay unlinked; the
   Phase 3 resolver includes them via donor-row fallback. Making
   `people.chapterId` optional (true central contacts) is a separate,
   founder-approved-only structural change.

## Phase 2 — Email identity + preferences on the person

1. **`personEmails` table**: `{personId, email (normalized), source:
   "roster"|"pw"|"donor"|"rsvp"|"manual", verified: boolean, isPrimary,
   addedAt}`, indexes `by_person`, `by_email`. Backfilled from `people.email`,
   `people.pwEmail`, linked donors' emails, linked rsvps' emails (verified flag
   from `rsvp.emailVerified`).
2. **Send-address precedence**: explicit `isPrimary` > `pwEmail` > `email` >
   most-recently-verified. One person = at most one recipient row per send.
3. **Person-level preferences**: marketing opt-out on the person (campaign
   sends skip the person entirely) layered OVER the address-level
   `emailSuppressions` ledger, which remains authoritative and untouched
   (compliance: an unsubscribe permanently suppresses that address). A person
   is excluded if their chosen send address is suppressed OR their person-level
   pref opts out. Groundwork for per-list subscriptions later.

## Phase 3 — Filters + hand-picked audiences (the robust picker)

1. **Audience model**: keep the `audiences` table; add
   `source: "person_filters"` alongside legacy sources. New shape:
   `filters` (AND-combined criteria) plus `includePersonIds` /
   `excludePersonIds` arrays. An audience may be filters-only, hand-picked-only,
   or both (filters ∪ includes, minus excludes).
2. **Filter set** (founder-named first):
   - giving amount: lifetime cents ≥/≤, gift count ≥, last gift within N days
     (via `donorIdentities` aggregates / `gifts.by_scope_and_received`)
   - backer status: active/lapsed recurring pledge (givingPledges)
   - attended event: specific `eventId`, or attended-anything-within N days,
     optional rsvp status (via `rsvps.personId` from Phase 1)
   - donor status (existing donor pre-filters)
   - chapter, role/seat (`seatAssignments.by_person`), team-vs-contact
     (`isContactOnly`), has-verified-email
3. **Invariants**: suppression and person-level opt-out override hand-picks —
   a manual include is not consent. Live resolution preserved (filters +
   picks re-resolve at preview and send; hand-picked ids resolve through
   Phase 2 address precedence). Exclusion counts remain visible in preview.
4. **Central-scope donor fallback**: at `scope === "central"`, donor-derived
   filters additionally union unlinked central donor rows (email/name from the
   donor row) so no giver is lost; flagged in preview as "N central donors
   (unlinked)". Removed if/when central contacts become real people rows.
5. **Migration of existing audiences**: donors/people-sourced rows map to
   equivalent `person_filters`; guests-sourced rows map to attended-event
   filters (faithful ONLY after Phase 1 linkage + backfill — hard dependency).
   Legacy resolvers stay until all rows migrate, then delete.
6. **UI**: replace the source dropdown with criteria chips + a people search
   for hand-picking (add/remove individual members with a picked-list view),
   keep the live count/exclusions/sample preview card and the
   create/save/archive flow unchanged. Approval-gate review cards
   (PR #399) automatically show the richer audience description.

## Product invariants (standing, from the founders)

- Consent is non-negotiable: suppression beats curation, transactional email
  is never gated by marketing preferences (see PR #323/#399 precedents).
- Two pages must not disagree: preview counts and send-time materialization
  use the same resolver.
- The Academy must track this: Phase 3's picker replaces a taught surface —
  update campaign/audience training in the same PR.
