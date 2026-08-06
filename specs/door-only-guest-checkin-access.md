# Feature: Per-event door access for outside volunteers (door-only guests)

## Feature Description
Lets an event organizer grant door check-in access to a volunteer **by email,
from the event page itself** — no seat, no chapter membership, no general
guest grant. The volunteer signs in with the existing guest login and lands
in a dedicated **door mode**: a minimal surface listing only the events
they've been granted at, each opening the existing ticket scanner / manual
check-in — and nothing else. Because they never gain a `userChapters`
membership, every member-level query in the backend already refuses them
(`requireChapterId` throws `NO_CHAPTER`); this feature adds the one narrow
path IN, not fences around each surface.

## User Story
As an event organizer
I want to grant a door volunteer check-in access for one event by typing
their email on that event's page
So that outside volunteers can scan tickets at the door without becoming
chapter members or seeing any other part of Chapter OS

## Problem Statement
PR #509/#510 gated `checkInTicket` behind `requireCheckInAccess` with two
grant paths (the `events.checkin` seat capability, or a `roleAssignments`
row on the event). Both paths presuppose a **chapter member with a `people`
row** — and its spec explicitly deferred "any new ad-hoc grant mechanism for
a non-seat-holding volunteer." Today the only way to let an outsider in is a
superuser general guest grant (`accessAllowlist`) followed by onboarding,
which makes them a **full chapter member** — they'd see events, the people
directory, the Tickets tab guest list, and every other member surface. There
is no "check-in only" tier, and the grant lives on a global superuser
screen, not on the event where the decision is actually made.

## Solution Statement
Follow the two patterns that already exist rather than inventing a tier
system:

1. **Access = allowlist; visibility = membership.** `lib/access.ts#requireAccess`
   (domain OR `accessAllowlist`) governs "may this email sign in at all";
   `requireChapterId` governs "may they see member surfaces." A door
   volunteer gets the first and deliberately never the second. The door-only
   experience is what a signed-in, allowed, chapterless user sees — a state
   the `(app)` layout already branches on (`me.onboarded`); we add one
   branch before it.
2. **An event-scoped grant table checked by the existing resolver.** A new
   `doorGrants` table (event + normalized email) becomes the third grant
   path inside `requireCheckInAccess` — checked membership-free, before the
   member paths — mirroring how the resolver already unions its two paths.
   `hasCheckInAccess`, `myCheckInAccess`, `checkInTicket`, `TicketScanner`,
   and `ManualCheckInEntry` are all reused untouched (`checkInTicket`'s only
   other requirement is `requireUserId`, which a door guest satisfies).

Granting from the event page follows the `guest-access.tsx` +
`accessAllowlist.grantAndNotify` pattern (upsert, soft revoke, notify email
on fresh grant), relocated to an event-scoped screen reached from the
`EventTools` ⋯ menu (the same menu that hosts RSVP page / Money / Songs).

Grant management itself is gated per CLAUDE.md's "gate it behind a power,
even when it's open today": a named resolver `requireDoorGrantManage` whose
body today is just `requireEvent` (any chapter member — the same baseline as
`roleAssignments.assign`), with a comment naming the capability it would
graduate to (`events.door.manage`).

**Why not a stored membership tier** (e.g. `userChapters.role: "door"`)?
Membership is precisely what exposes every member surface; a door tier would
require auditing/gating each of the ~336 function modules that assume
"member = full member." Chapterlessness is the existing, already-enforced
boundary — zero call-site churn.

**Escalation guard:** an allowlisted guest can normally self-onboard into
any chapter (`profiles.completeOnboarding`), which would silently turn a
door volunteer into a full member. Allowlist rows created by a door grant
are stamped `grantedVia: "door"`, and `completeOnboarding` refuses those
accounts. Guests granted general access by a superuser (no stamp) onboard
exactly as before.

## Scope
**In scope:**
- `doorGrants` table (`apps/convex/schema/ticketing.ts`) + `grantedVia`
  stamp on `accessAllowlist`.
- Third, membership-free grant path in
  `lib/ticketingAccess.ts#requireCheckInAccess`; `requireDoorGrantManage`
  resolver in the same file.
- `apps/convex/doorAccess.ts`: `listForEvent`, `grant`, `revoke`,
  `myDoorEvents`, internal `sendDoorGrantEmail`.
- `profiles.me` gains `doorOnly: boolean`; `completeOnboarding` refuses
  door-stamped guests.
- Door mode UI: `(app)/_layout.tsx` branch + `DoorModeScreen` (event list →
  embedded `TicketScanner`, sign out, empty state).
- Event-page management UI: `event/[id]/door-access.tsx` route + "Door
  access" row in `EventTools`.

**Out of scope:**
- A real `events.door.manage` capability — `requireDoorGrantManage` ships
  with the membership-check body and graduates later (one-file change by
  design).
- Grant expiry / auto-revoke after the event ends (future work; revoke is
  manual).
- SMS invites; only email.
- Changing the two existing grant paths, `checkInTicket`, the scanner
  components, or what the ticket QR encodes.
- In-app UX for a **member** of another chapter using a cross-chapter door
  grant (the resolver honors it — email-based — but no nav entry points at
  it; they'd use a direct link. Not the asked-for use case).
- Academy content: ticketing/RSVP has no lesson coverage today (verified in
  #510's spec); this PR repeats that explicit deferral in its description
  rather than owning the pre-existing gap.

## Relevant Files
- `apps/convex/lib/ticketingAccess.ts` — **the pattern AND the seam**: the
  resolver gains the door-grant path and `requireDoorGrantManage`.
- `apps/convex/accessAllowlist.ts` — **pattern for grant/revoke/notify**
  (`grantGuest` upsert semantics, `grantAndNotify`'s newly-granted-only
  email, `revokeGuest` soft delete, `sendAccessGrantedEmail` copy).
- `apps/convex/schema/accessAllowlist.ts` — add `grantedVia`.
- `apps/convex/schema/ticketing.ts` — new `doorGrants` table (event-scoped
  ticketing data lives here).
- `apps/convex/lib/access.ts` — reuse `normalizeEmail`, `isAllowedEmail`,
  `getUserEmail`, `requireAccess`; no changes.
- `apps/convex/profiles.ts` — `me` (+`doorOnly`), `completeOnboarding`
  guard.
- `apps/convex/ticketing.ts` — no change (gate already routes through the
  resolver); listed to make that explicit.
- `apps/mobile/app/(app)/_layout.tsx` — the door-mode branch, before the
  `OnboardingScreen` branch.
- `apps/mobile/app/(app)/guest-access.tsx` — **UI pattern** for the grant
  form/list (email field, note, revoke, error handling).
- `apps/mobile/components/event/EventHeader.tsx` — `EventTools` gains an
  `onDoorAccess` row (label "Door access"), beside Songs/Share crew link.
- `apps/mobile/app/(app)/event/[id].tsx` — wire `onDoorAccess` →
  `router.push(\`/event/${eventId}/door-access\`)` at BOTH `EventTools`
  render sites (~lines 719 and 756).
- `apps/mobile/components/event/ticketing/TicketScanner.tsx` +
  `ManualCheckInEntry.tsx` + `CheckInResultBanner.tsx` — reused as-is by
  door mode.
- `apps/mobile/components/onboarding/OnboardingScreen.tsx` — **UI pattern**
  for a full-screen non-route surface rendered by the layout.
- `apps/convex/tests/ticketingAccess.test.ts` — **test pattern** (helpers:
  `setupChapter`, `seedEvent`; extends with a chapterless door-guest
  identity).
- `apps/convex/tests/setup.helpers.ts` — `newT`, `run`, `setupChapter`.

### New Files
- `apps/convex/doorAccess.ts` — the door-grant API surface (queries,
  mutations, notify action).
- `apps/convex/tests/doorAccess.test.ts` — all backend milestones below.
- `apps/mobile/components/door/DoorModeScreen.tsx` — the door-only shell:
  granted-events list → embedded scanner; sign out; empty state.
- `apps/mobile/app/(app)/event/[id]/door-access.tsx` — the event-scoped
  management screen.

## Implementation Plan

### Phase 1: Foundation
`doorGrants` table + `grantedVia` field; `activeDoorGrantFor` helper and the
door path inside `requireCheckInAccess`; `requireDoorGrantManage`.

### Phase 2: Core Implementation
`doorAccess.ts` (grant/revoke/list/myDoorEvents/notify) with allowlist
coupling; `profiles.me.doorOnly`; `completeOnboarding` guard.

### Phase 3: Integration
Door-mode branch in the `(app)` layout + `DoorModeScreen`; the
`door-access` route + `EventTools` menu row.

## Step by Step Tasks
IMPORTANT: Execute every step in order, top to bottom.

### 1. `doorGrants` table + `activeDoorGrantFor`
a. **RED** — in new `apps/convex/tests/doorAccess.test.ts` (imports mirror
`ticketingAccess.test.ts`; local `seedEvent` helper copied from there), a
test that inserts a `doorGrants` row via `run(t, …)` for
`(eventId, "vol@example.com")` and asserts
`activeDoorGrantFor(ctx, eventId, "vol@example.com")` returns it, a second
grant with `isActive: false` returns null, and a different event's grant
returns null. Fails: table and helper don't exist.
b. **GREEN** — `doorGrants` in `apps/convex/schema/ticketing.ts`:
`{ eventId: v.id("events"), chapterId: v.id("chapters"), email: v.string(),
note: v.optional(v.string()), isActive: v.optional(v.boolean()),
createdAt: v.number() }`, indexes `by_event ["eventId"]`,
`by_email ["email"]`, `by_event_email ["eventId","email"]` (email stored
pre-normalized via `normalizeEmail`; `isActive` optional with absent=active,
mirroring `accessAllowlist`). Register in `schema.ts` exactly as sibling
ticketing tables are. Add `activeDoorGrantFor(ctx, eventId, email)` to
`lib/ticketingAccess.ts` (query `by_event_email`, filter
`isActive !== false`).
c. Full suite.

### 2. Door path in `requireCheckInAccess`
a. **RED** — tests: a user with an `accessAllowlist` row and NO
`userChapters`/`people` rows (new local helper `setupDoorGuest(t, email)` —
inserts `users` + active `accessAllowlist` row, returns
`t.withIdentity({ subject: \`${userId}|session\`, issuer: "test" })`; note
the `|session` suffix `getAuthUserId` requires) with an active grant for the
event → `requireCheckInAccess` resolves and `checkInTicket` works end to
end; same user, grant `isActive: false` → FORBIDDEN; grant on a different
event → denied. Fails: resolver has no door path (today they die at
`requireEvent`'s `NO_CHAPTER`).
b. **GREEN** — restructure `requireCheckInAccess`: fetch the event via
`ctx.db.get` (throw the same `NOT_FOUND` shape `requireInChapter` uses when
missing), then superuser bypass, then
`await requireAccess(ctx)` + `getUserEmail` → `activeDoorGrantFor` → return
event on hit; otherwise the existing member path (`requireChapterId` +
`requireInChapter`, seats, roleAssignments) unchanged. All six existing
`ticketingAccess.test.ts` cases must stay green — they pin the member-path
behavior.
c. Full suite.

### 3. `requireDoorGrantManage`
a. **RED** — test: a chapter member may call it (returns the event); the
door guest from step 2 (chapterless) gets a ConvexError; a member of another
chapter gets NOT_FOUND. Fails: function doesn't exist.
b. **GREEN** — in `lib/ticketingAccess.ts`, body = `requireEvent(ctx,
eventId)` with the doc comment naming the graduation capability
(`events.door.manage`) per CLAUDE.md's resolver rule.
c. Full suite.

### 4. `doorAccess.grant` / `listForEvent` / `revoke` + allowlist coupling
a. **RED** — tests (as a chapter member via `s.as`):
   - `grant({eventId, email:" Vol@Example.COM "})` → one `doorGrants` row
     with normalized email, one active `accessAllowlist` row stamped
     `grantedVia: "door"`; a scheduled `sendDoorGrantEmail` (assert via
     `t.finishInProgressScheduledFunctions` not throwing, or by row effects
     only — follow how `accessAllowlist` tests assert `grantAndNotify`, if
     they do; otherwise assert rows only).
   - Granting a `@publicworship.life` email → grant row, NO allowlist row.
   - Re-granting the same email → reactivates (no duplicate rows).
   - Granting when the email already has an ACTIVE un-stamped allowlist row
     (superuser general guest) → that row is left untouched (no stamp
     added).
   - `revoke(grantId)` → grant `isActive: false`; when it was the email's
     LAST active grant and the allowlist row is door-stamped → allowlist row
     deactivated; when another event still has an active grant → allowlist
     row stays active; un-stamped allowlist row NEVER deactivated.
   - `listForEvent` returns the event's grants; the door guest cannot call
     `grant`/`revoke`/`listForEvent` (all behind `requireDoorGrantManage`).
   Fails: module doesn't exist.
b. **GREEN** — `apps/convex/doorAccess.ts`. `grant` args
`{ eventId: v.id("events"), email: v.string(), note: v.optional(v.string()) }`:
`requireDoorGrantManage` → `normalizeEmail` (reject empty/no-`@` with a
friendly ConvexError, mirroring `grantGuest`'s validation) → upsert
`doorGrants` by `by_event_email` → if `!isAllowedEmail(email)`, upsert
allowlist (fresh insert stamped `grantedVia: "door"`; reactivating an
inactive row stamps it too — least privilege, a door grant must never
silently restore full onboarding rights an old general-guest row carried;
ACTIVE rows are left completely untouched) → schedule
`internal.doorAccess.sendDoorGrantEmail`
`{ email, eventName: event.name }` only when the grant is newly
created/reactivated. `revoke` args `{ grantId: v.id("doorGrants") }`: load,
`requireDoorGrantManage(ctx, grant.eventId)`, patch inactive, then the
last-grant allowlist cleanup above. `listForEvent`:
`requireDoorGrantManage`, return grants by `by_event` (newest first).
`sendDoorGrantEmail`: internalAction mirroring `sendAccessGrantedEmail`'s
shell/copy — "You're on the door for <event name>", sign in as a guest with
this email, one-time code each sign-in.
c. Full suite.

### 5. `completeOnboarding` refuses door-stamped guests
a. **RED** — test: door guest from a `grant` call (so their allowlist row is
stamped) calling `completeOnboarding` with a valid chapter → ConvexError
with `code: "DOOR_ONLY"`; a guest with a superuser-style un-stamped
allowlist row still onboards successfully (pin `userChapters` row created).
Fails: no guard exists.
b. **GREEN** — in `profiles.ts#completeOnboarding`, after access passes: if
the caller's email is off-domain AND their allowlist row has
`grantedVia === "door"`, throw
`ConvexError({ code: "DOOR_ONLY", message: "This account has door access only — ask the organizer if you need full access." })`.
c. Full suite.

### 6. `profiles.me.doorOnly` + `doorAccess.myDoorEvents`
a. **RED** — tests: door guest's `me` has `doorOnly: true` and
`onboarded: false`; a chapter member's `me` has `doorOnly: false` even WITH
an active door grant (membership wins); `myDoorEvents` for the door guest
returns `[{ eventId, name, eventDate, chapterName }]` for active grants
only, sorted by `eventDate` ascending; revoked/other-email grants excluded.
Fails: field and query don't exist.
b. **GREEN** — `me`: `doorOnly` = `allowed && !hasChapter` && at least one
active `doorGrants` row `by_email` for the caller's normalized email (keep
the existing early-null and pre-chapter behavior intact — `me` must never
throw). `myDoorEvents` (in `doorAccess.ts`): `requireAccess` +
`getUserEmail` → active grants `by_email` → `ctx.db.get` event + chapter for
names → sort by `eventDate`. No membership required, no `people` row
touched.
c. Full suite.

### 7. Door mode UI
No new pure logic ⇒ no new mobile unit test (this repo tests pure helpers
only — `ticketScan.test.ts` precedent — and has zero component-rendering
tests; if any list-formatting helper grows during implementation, extract
and test it as `apps/mobile/components/door/helpers.test.ts`).
- `apps/mobile/components/door/DoorModeScreen.tsx`: full-screen surface
  (follow `OnboardingScreen.tsx`'s structure/styling): header ("Door
  check-in"), `useQuery(api.doorAccess.myDoorEvents)` list (name, date,
  chapter), tapping an event shows `TicketScanner` (via `useActionRunner`,
  exactly as `scan-tickets.tsx` wires it) with a back affordance; empty
  state ("No door assignments yet — ask the organizer to add your email");
  sign-out via the same mechanism `AppShell`/profile uses (find `signOut`
  usage; `useAuthActions` from `@convex-dev/auth/react` per the login
  screen).
- `(app)/_layout.tsx`: insert BEFORE the onboarding branch:
  `if (me && !me.onboarded && me.doorOnly) return <DoorModeScreen />;`
  (door guests must never see `OnboardingScreen`; the layout's
  `reconcileMyPerson` effect already only fires when `me.onboarded` — do not
  widen it).
- Run `pnpm typecheck` + full suite.

### 8. Event-page management UI
- `apps/mobile/app/(app)/event/[id]/door-access.tsx`: follow
  `guest-access.tsx`'s form/list/error patterns and `scan-tickets.tsx`'s
  route shape (`useLocalSearchParams`, `Screen`). Email + optional note
  field → `api.doorAccess.grant`; list of grants (email, active/revoked,
  date) with revoke; explanatory copy ("They'll sign in as a guest with this
  email and can only check tickets in for this event.").
- `EventHeader.tsx` `EventTools`: add `onDoorAccess: () => void` prop and a
  "Door access" `MenuItem` row after "Share crew link" (match the existing
  rows' icon/label/accessibility conventions exactly).
- `event/[id].tsx`: pass `onDoorAccess` at both `EventTools` sites.
- Run `pnpm typecheck` + full suite.

### 9. Validation
Run every Validation Command; all must exit clean.

## Testing Strategy

### Tests by Milestone

| # | Milestone | Test file | The test asserts | Why it fails today |
|---|---|---|---|---|
| 1 | `doorGrants` + `activeDoorGrantFor` | `apps/convex/tests/doorAccess.test.ts` (new) | Active grant found by (event,email); inactive and other-event grants are not | Table and helper don't exist |
| 2 | Door path in resolver | same | Chapterless allowlisted guest with active grant passes `requireCheckInAccess` and `checkInTicket`; inactive/other-event denied | Resolver requires chapter membership (`NO_CHAPTER`) |
| 3 | `requireDoorGrantManage` | same | Member passes; door guest and foreign-chapter member refused | Function doesn't exist |
| 4 | grant/revoke/list + allowlist coupling | same | Normalization, stamp on fresh rows only, domain emails skip allowlist, reactivation not duplication, last-grant cleanup only for stamped rows, door guest can't manage | Module doesn't exist |
| 5 | Onboarding guard | same | Door-stamped guest → `DOOR_ONLY`; un-stamped guest still onboards | No guard exists |
| 6 | `me.doorOnly` + `myDoorEvents` | same | Door guest true + events listed sorted; member false despite grant | Field and query don't exist |
| 7–8 | Door mode + management UI | none (see below) | — | — |

**Pattern followed:** `apps/convex/tests/ticketingAccess.test.ts` (helpers
`setupChapter`/`seedEvent`/raw inserts via `run`; identity via
`withIdentity` with the `|session` subject suffix). Mobile: no component
tests exist in this codebase — pure-logic extraction only, per
`ticketScan.test.ts`.

### Integration Tests
Milestone 2's end-to-end case (grant → `checkInTicket` returns
`{result:"ok"}` for a real ticket) covers the seam that matters: a
membership-free caller reaching the existing mutation through the new path.
Milestone 5 covers the escalation seam (door guest cannot become a member).

### Edge Cases
- Email normalization (case/whitespace) at grant AND at resolve — M1/M4.
- Re-grant after revoke (reactivate, not duplicate) — M4.
- Same email granted at two events; revoking one keeps allowlist active — M4.
- Door grant for an email that's already a full member: member experience
  unchanged (`doorOnly: false`), resolver still honors the grant — M6/M2.
- Allowlist row pre-existing from a superuser general grant: never stamped,
  never deactivated by door revoke — M4.
- `me` for a signed-out or pre-chapter user must not throw — M6 (pinned by
  existing `profiles` tests staying green).
- Revoke mid-session: `myDoorEvents` is reactive (list empties) and
  `checkInTicket` throws FORBIDDEN — M2 covers the server side.

## Acceptance Criteria
- [ ] A chapter member can open an event's ⋯ menu → "Door access", grant an
      outside email, see it listed, and revoke it.
- [ ] A fresh off-domain grant creates an active `accessAllowlist` row
      stamped `grantedVia: "door"` and sends (or dev-logs) the invite email.
- [ ] The granted volunteer signs in via guest login and sees ONLY the door
      mode: their granted events and the scanner/manual check-in — no tabs,
      no nav, no onboarding.
- [ ] The volunteer can check in a real ticket end to end (scan or typed
      code) for a granted event, and is refused for any other event.
- [ ] `completeOnboarding` throws `DOOR_ONLY` for door-stamped guests;
      general guests onboard unchanged.
- [ ] Revoking the volunteer's last grant deactivates their door-stamped
      allowlist row; superuser-granted rows are never touched.
- [ ] All six pre-existing `ticketingAccess.test.ts` cases still pass
      unmodified.
- [ ] Existing member/seat/role-assignment check-in behavior is unchanged.

## Validation Commands
Execute every command. Every one must exit clean.

- `pnpm test` — full suite (turbo → 3 packages), zero regressions
- `pnpm typecheck` — `tsc --noEmit` × 3 packages
- `pnpm lint` — 0 errors (97 pre-existing warnings in `apps/mobile` are
  known; do not add to them)
- `pnpm build` — web bundle export

## Notes
- **No new dependencies.** The scanner stack (incl. gated `expo-camera`)
  ships in #510; this feature only reuses it.
- **Stacked branch:** this builds on
  `feat-509-dce04a3c-check-in-flow-for-scanning-tickets` (PR #510, not yet
  merged). Base the PR on that branch; retarget to `main` when #510 merges.
- **No numbered migration needed:** `doorGrants` is a new table;
  `grantedVia` is optional-additive on `accessAllowlist`.
- **Academy:** explicitly not training-worthy yet — ticketing/RSVP has no
  lesson coverage (same deferral #510's spec records); say so in the PR
  description.
- **Deliberately deferred:** `events.door.manage` capability (resolver body
  swap later), grant expiry/auto-revoke after `eventDate`, SMS invites,
  in-app entry point for cross-chapter member helpers.
- Pre-existing: 97 mobile lint warnings; `pnpm dev` broken
  (`@supa-media/dev` unpublished) — run Convex + Expo directly.
