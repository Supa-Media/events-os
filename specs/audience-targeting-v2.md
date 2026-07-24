# Audience Targeting v2 — conditions, groups, and explainable membership

Founder direction (2026-07-24): "I can't do simple things like target all donors
who have not been to an event. I want a robust way of targeting." This spec
replaces the flat AND-only filter object with a general targeting model, while
keeping every consent invariant and the live-resolution architecture intact.

## What the current model cannot say (post-#407/#417/#418/#423/#424)

1. **Negation as a first-class idea.** "Donors who have NOT attended event X"
   only works via the #424 exclude block; "donors who have never attended ANY
   event" is unrepresentable — there is no "attended anything (ever)"
   primitive, only `attendedEventId` and a rolling `attendedWithinDays`.
2. **OR.** "Attended X OR gave ≥ $100" — no union construct exists; the only
   union operator is hand-picking individuals.
3. **Explainability.** When a count looks wrong there is no way to ask "why
   is/isn't this person included?" — the #417 counters explain *classes* of
   exclusions, not individuals.

## The model

### Condition
A single testable statement about a person: `{ field, op, value? }`.

| Field | Ops | Value | Notes |
|---|---|---|---|
| giving_lifetime | gte, lte | cents | donorIdentities aggregates |
| gift_count | gte, lte | int | |
| last_gift | within_days, not_within_days | days | |
| donor_status | is, is_not | active/lapsed/... | existing donor pre-filters |
| backer | is, is_not | active/lapsed | givingPledges |
| attended_event | has, has_not | eventId (+ optional rsvpStatus) | rsvps.by_person |
| attended_any | has, has_not | optional withinDays; absent = ever | **new primitive** |
| rsvp_status | is | going/maybe/... | qualifies attendance conditions |
| chapter | is, is_not | chapterId | |
| seat | holds, not_holds | seatId | seatAssignments.by_person |
| kind | is | team / contact | people.isContactOnly |
| email_verified | is | true | include-side only; never exposed as a negated/exclude criterion (#424 finding C) |

Negation is an **operator on the condition** (`is_not`, `has_not`,
`not_within_days`), not a separate block — "donors who have not been to any
event" is one group: `[donor_status is active, attended_any has_not]`.

### Group
`conditions: Condition[]` — ALL must hold (AND). A group is the unit a human
reads as one sentence: "people who are active donors and have never attended
an event."

### Audience
```
targeting: {
  groups: Group[],          // a person matches if they match ANY group (OR)
  excludeGroups?: Group[],  // then removed if they match ANY of these
}
includePersonIds / excludePersonIds   // hand-picks, unchanged
```
Resolution: `(∪ groups) ∪ includePersonIds` → minus `(∪ excludeGroups)` →
minus `excludePersonIds` → minus person-level opt-out → minus address-level
suppression. Consent invariants are byte-for-byte the #424 semantics:
suppression and opt-out are absolute; property exclusion beats hand-pick
include; hand-pick include is not consent.

`excludeGroups` stays even though per-condition negation exists: "everyone
(any group) EXCEPT staff" reads better as one global exclude than as a
negated condition copy-pasted into every group, and it generalizes the #424
shape 1:1 for migration.

### Explainability (the trust feature)
- Preview shows a per-group count next to each group card, plus the overall
  deduped count (groups overlap; the sum exceeds the total — label this).
- Preview sample rows are tagged with which group(s) matched.
- A "Check a person" box on the preview card: search any person → per-condition
  pass/fail readout and the final verdict incl. suppression/opt-out/hand-pick
  status. This directly answers "it feels like it doesn't fully work" — the
  system can now show its work.

## Backend notes

- **Evaluation**: candidate pool unchanged (scoped people scan + hand-picks +
  central-donor fallback). Per candidate: cheap-first within each condition
  list (zero-read fields before per-person lookups — the #424 finding D
  pattern); short-circuit groups (first matching group wins for membership;
  all exclude groups checked the same way). Per-person lookup results
  (attendance rows, seats, donor aggregates) are fetched once per candidate
  per resolution and shared across groups — a candidate is never charged
  twice for the same index read.
- **Central-donor fallback** rows evaluate donor-derived conditions on the
  donor row; person-linked-only fields (`attended_*`, `seat`, `kind`) evaluate
  as not-matching (`has`) / matching (`has_not`) consistently with their
  linked-person semantics; documented per condition. (#424 finding A applied
  from day one.)
- **attended_any (ever)**: needs `rsvps.by_person` take-bounded existence
  check — same cost shape as attended_event.
- **Approval snapshot hash**: `targeting` enters `computeCampaignSnapshotHash`
  ONLY when present (absent legacy shapes hash exactly as before — the #424
  finding B rule). Editing targeting after approval = drift, as today.
- **Schema/migration**: `targeting` is a new optional field. Migration wraps
  legacy shapes losslessly: `filters` → `groups=[[...]]` with positive ops;
  `excludeFilters` → `excludeGroups=[[...]]`; unscoped legacy guests
  audiences (skipped by 0041) → `groups=[[attended_any has]]` — after which
  ZERO legacy-source rows remain and `resolveGuests`/`resolveDonors`/
  `resolvePeople` + the flat-filter resolver path are deleted (one release
  later, after prod verification). Migration follows the single-paginate +
  bounded-read rules (0037/0039/0041 precedents).

## UI

Sentence-row builder, one row per condition:
`[Giving total] [is at least] [$100]` / `[Attended] [has not] [any event]`.
Rows live in group cards ("Match ANY of these groups" header); "+ Add group"
creates an OR branch; the exclude section is its own labeled card stack
("Remove anyone who matches…"). Existing #418 furniture carries over: sticky
live count, debounced preview, WYSIWYG-save flush registry (every row's
inputs registered), inline errors, plain-language `describeAudience` ("Active
donors who have never attended an event; or anyone who gave $100+ —
excluding staff").

## Phasing (each = one PR, verified adversarially, squash-merge on green)

- **A (in flight now)**: #424 exclude block — lands immediate value; its
  shared `personMatchesCriteria` IS the v2 condition evaluator seed.
- **B — backend model**: `targeting` schema + resolver + hash rule +
  wrap-migration + `attended_any` primitive + tests. Old shapes keep
  resolving until migrated; preview/send share one resolver as always.
- **C — builder UI + explainability**: group cards, per-group counts, person
  debugger, Academy lesson update (the lesson teaches targeting; this changes
  the taught surface materially).
- **D — cleanup**: delete legacy sources/resolvers and the flat-filter path
  once prod shows zero unmigrated rows.

## Open questions for the founder

1. Group rows are AND-only inside a group (OR comes from adding groups). Is a
   per-group ANY/ALL toggle wanted, or is "add another group" enough? (v1
   recommendation: no toggle — fewer concepts, same expressive power.)
2. Tags/labels on people as a targeting field (e.g. "board", "vendor") —
   people rows have no tag model today; worth adding as part of C or defer?
3. Per-mailing-list subscription preferences (beyond the single marketing
   opt-out) — deferred from Phase 2; does v2 need it or later?
