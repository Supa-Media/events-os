# Feature: Door check-in by scanning a ticket's QR code

## Feature Description
A door check-in flow for events on Event OS: a staff member who has been
granted door access (a seat capability) or is scheduled on the event's team
(a role assignment on that specific event) can open the event's Tickets tab,
tap "Scan QR code," point the camera at a guest's ticket, and have the guest
checked in automatically — reusing the exact same `checkInTicket` mutation
and ticket `code` the existing manual-entry check-in already uses. Anyone
without door access sees a locked state instead of the scanner or the manual
field.

## User Story
As an event-team member with door access
I want to scan a guest's ticket QR code to check them in
So that admitting guests at the door is fast and doesn't require typing an
8-character code per guest

## Problem Statement
`ticketing.ts#checkInTicket` and its UI (`CheckInCard`) already support
checking a guest in by **typing** the ticket code printed under the QR on
their ticket (`apps/mobile/components/event/ticketing/CheckInCard.tsx`). Two
things are missing:

1. **No camera scanning.** The QR on the ticket page (`/t/<code>`, rendered
   by `apps/convex/lib/landingPage.ts#renderTicketPage`) already encodes the
   plain ticket `code` — nothing generates it from inside the app, and there
   is no way to point a camera at it.
2. **No door-specific access gate.** `checkInTicket` today only requires
   `requireEvent` (any signed-in member of the event's chapter) — the same
   bare gate as every other admin ticketing action. There's no way to grant
   "can check guests in at this event" narrowly, separate from full Tickets-
   tab admin access, to a person "we've given access to" or to the specific
   team scheduled on an event.

## Solution Statement
**Scanning:** add a native QR scanner (`expo-camera`'s `CameraView`) that
decodes a ticket's QR to the same `code` string the manual field already
accepts, then calls the same `checkInTicket` mutation. No change to how
tickets/QRs are generated — scanning is purely an alternate, faster INPUT
path for a flow that already exists end-to-end. `expo-camera` is a new
native dependency; it's classified `"gated"` in `native-deps.json` (per
`@supa-media/testing`'s native-import guardrail — a native module added
without a matching native rebuild will crash an OTA-updated app running an
older binary) and loaded dynamically with a manual-entry fallback when it
isn't available.

**Access:** follow CLAUDE.md's "gate it behind a power, even when it's open
today" pattern, using `apps/convex/lib/campaignsAccess.ts`'s
`requireBlastSend`/`hasBlastSend` pair as the template (a named, event-scoped
resolver that returns the event doc, with a soft non-throwing twin). New
resolver `apps/convex/lib/ticketingAccess.ts` exposes
`requireCheckInAccess`/`hasCheckInAccess`, checked ONLY by `checkInTicket`
(every other ticketing admin query/mutation is unchanged — this narrows just
the door action, not the whole Tickets tab). Access is granted two ways,
either sufficient:

1. **Granted** — the caller holds a new `events.checkin` seat capability at
   the event's chapter (mirrors `lib/seats.ts#holdsApprovalSeatAt`'s
   "additive, narrowly-scoped reader" pattern). This is "we've given this
   signed-in person access" — expressed through the existing seat-assignment
   UI, no new grant mechanism needed. Granted by default to
   `chapter_director`, `event_lead`, `event_organizers` (a multi-holder
   seat — the natural home for door volunteers), and
   `production_coordinator`.
2. **Assigned** — the caller holds a `roleAssignments` row for THIS
   SPECIFIC event (any role) — "the assigned public worship team on the
   event page" (`schema/events.ts#roleAssignments`, already how a
   chapter staffs an event).

Superuser bypasses both, per the bootstrap path mirrored across the repo.
An existing seat capability (`events.checkin`) added to already-seeded
orgs' live `seatDefs` rows needs a migration, mirroring
`migrations/0036_add_campaign_power_defaults.ts` exactly (additive-only,
idempotent by "already has the capability").

**Why not just `requireEvent` (today's behavior for every other ticketing
admin action)?** The user's request explicitly names two access paths
(granted + assigned) — narrower than "any chapter admin" — so this is a
real, asked-for restriction, not a hypothetical one CLAUDE.md's "gate it
behind a power" section says to defer. `CheckInCard` (the manual-entry
field, `apps/mobile/components/event/ticketing/CheckInCard.tsx`) is
therefore ALSO gated behind the same check — a person who can't scan a
ticket shouldn't be able to type its code either.

## Scope
**In scope:**
- `events.checkin` seat capability (shared constant + 4 seat defs + backfill
  migration for already-seeded orgs).
- `apps/convex/lib/ticketingAccess.ts` (`requireCheckInAccess`/
  `hasCheckInAccess`) + `apps/convex/lib/seats.ts#holdsCheckInSeatAt`.
- Gate `ticketing.ts#checkInTicket` behind `requireCheckInAccess`; add a
  non-throwing `myCheckInAccess` query for the client to drive UI state.
- Native QR scanner (`expo-camera`), reachable from `CheckInCard` via a new
  "Scan QR code" button → a new route
  `apps/mobile/app/(app)/event/[id]/scan-tickets.tsx`.
- `CheckInCard` gated on `myCheckInAccess`: locked state when denied,
  existing manual field + new scan button when granted.
- Graceful degradation: manual entry when camera scanning isn't available
  (old native build, denied permission, or unsupported platform).

**Out of scope:**
- Changing how the ticket QR/`code` is generated or what it encodes (still
  the plain `PW-XXXX-XXXX` code — no URL, no deep link payload).
- A public, unauthenticated web check-in page. Staff scan from inside the
  signed-in app; a signed-out visitor already hits the app's existing
  sign-in gate at the root layout before reaching any event screen.
- Any new ad-hoc/one-off grant mechanism for a non-seat-holding volunteer —
  "give someone door access" is granting them a seat (`event_organizers`),
  reusing the existing seat-assignment UI.
- Retrofitting Academy coverage for ticketing/RSVP generally — no lesson
  covers that surface today (verified: no "ticket"/"rsvp" hits in
  `packages/shared/src/academy/streams/events.ts`), so this PR doesn't own
  closing that pre-existing gap. Not training-worthy as its own lesson for
  this PR; flagged in the PR description per CLAUDE.md's explicit-decision
  rule, not silently skipped.
- Haptic feedback on scan (no new native dependency beyond `expo-camera`).
- Torch/flashlight toggle, multi-code batch scanning, or an on-screen
  scan-history log — first-version scope is one scan → one check-in →
  explicit "scan next."

## Relevant Files
- `apps/convex/lib/campaignsAccess.ts` — **the pattern to follow** for a
  named, event/chapter-scoped access resolver with a throwing + soft pair
  (`requireBlastSend`/`hasBlastSend` at the bottom of the file is the
  closest analogue: event-scoped, not central-scoped).
- `apps/convex/lib/seats.ts` — add `holdsCheckInSeatAt`, mirroring
  `holdsApprovalSeatAt`'s exact shape (the file's own doc calls this "the
  pattern to follow" for an additive, narrowly-scoped reader).
- `apps/convex/ticketing.ts` — `checkInTicket` (gate it) + new
  `myCheckInAccess` query, next to the other ADMIN check-in code.
- `apps/convex/schema/events.ts` — `roleAssignments` (read-only; no schema
  change, just confirms the shape used by the new resolver).
- `packages/shared/src/seats.ts` — `SEAT_CAPABILITIES`, `SEAT_DEFS` for
  `chapter_director`/`event_lead`/`event_organizers`/
  `production_coordinator`.
- `packages/shared/src/seats.test.ts` — the pinned `EXPECTED_CAPABILITIES_BY_SEAT`
  snapshot; must be updated in lockstep with the `SEAT_DEFS` change or its
  existing "every seat's capabilities array matches the pinned spec exactly"
  test fails.
- `apps/convex/migrations/0036_add_campaign_power_defaults.ts` — the
  backfill-migration pattern to copy exactly (additive-only, idempotent by
  "already has the capability", `by_slug` lookup).
- `apps/convex/migrations/index.ts` — register the new migration.
- `apps/convex/tests/ticketing.test.ts` — existing `checkInTicket` test
  (line ~270) breaks once the gate is real; its caller (`setupChapter`'s
  `s.as`) has no `people`/seat/role-assignment row, so it must be updated to
  seed one.
- `apps/mobile/components/event/ticketing/CheckInCard.tsx` — gate on
  `myCheckInAccess`; add the "Scan QR code" entry point; extract the
  four-branch result rendering into a shared component.
- `apps/mobile/components/event/ticketing/TicketingTab.tsx` — no code
  change expected (still renders `CheckInCard` unconditionally in the "Run"
  phase; the card itself now handles its own locked state).
- `apps/mobile/native-deps.json` — classify `expo-camera` as `"gated"`.
- `apps/mobile/app.config.js` — add the `expo-camera` plugin (camera
  permission strings), mirroring the existing `expo-image-picker` plugin
  entry.
- `apps/mobile/components/markdown/MarkdownEditor.native.tsx` — an existing
  "Expo Go-safe (`core`)" comment convention to mirror for the new gated
  dependency's doc comment.
- `apps/mobile/components/event/ticketing/helpers.test.ts` /
  `launchPhases.test.ts` — the pattern for this app's mobile tests: pure
  logic only, no component-rendering tests exist in this codebase.

### New Files
- `apps/convex/lib/ticketingAccess.ts` — `requireCheckInAccess`/
  `hasCheckInAccess`.
- `apps/convex/migrations/0060_add_events_checkin_defaults.ts` — backfill
  migration.
- `apps/convex/tests/ticketingAccess.test.ts` — resolver + migration tests.
- `apps/mobile/lib/cameraScanning.ts` — dynamic loader for the gated
  `expo-camera` module + an availability check, with no static top-level
  import of `expo-camera` anywhere else in the app.
- `apps/mobile/components/event/ticketing/ticketScan.ts` — pure scan-lock/
  normalize logic (testable; the actual `CameraView` wiring stays untested
  per this app's convention).
- `apps/mobile/components/event/ticketing/ticketScan.test.ts` — tests for
  the above.
- `apps/mobile/components/event/ticketing/CheckInResultBanner.tsx` — the
  four-branch outcome UI, extracted from `CheckInCard` so the scanner reuses
  it verbatim.
- `apps/mobile/components/event/ticketing/TicketScanner.tsx` — the camera
  screen: permission request → live `CameraView` → result banner → "Scan
  next," with the manual-entry fallback when scanning isn't available.
- `apps/mobile/app/(app)/event/[id]/scan-tickets.tsx` — the route: gates on
  `myCheckInAccess`, then renders `TicketScanner`.

## Implementation Plan

### Phase 1: Foundation
`events.checkin` seat capability (shared constant, seat defs, backfill
migration) and the backend access resolver (`ticketingAccess.ts` +
`seats.ts#holdsCheckInSeatAt`) — everything Phase 2's mutation gate and
Phase 3's UI depend on.

### Phase 2: Core Implementation
Wire the resolver into `checkInTicket`, add `myCheckInAccess`. On mobile,
build the gated-dependency loader, the pure scan-lock logic, the shared
result banner, and the `TicketScanner` camera component.

### Phase 3: Integration
Gate `CheckInCard` on `myCheckInAccess` and add its "Scan QR code" entry
point; add the `scan-tickets` route; add the `expo-camera` plugin + native-
deps classification; fix the now-failing `checkInTicket` test fixture.

## Step by Step Tasks
IMPORTANT: Execute every step in order, top to bottom.

### 1. `events.checkin` seat capability (shared package)
**a. RED.** In `packages/shared/src/seats.test.ts`, add `"events.checkin"`
to the `EXPECTED_CAPABILITIES_BY_SEAT` entries for `chapter_director`,
`event_lead`, `event_organizers`, and `production_coordinator` (with a
dated comment matching the file's existing convention, e.g. "2026-08-06:
added events.checkin — door check-in access for the QR scanner"). Run
`pnpm --filter @events-os/shared test` and confirm
`seats.test.ts`'s "every seat's capabilities array matches the pinned spec
exactly" test now FAILS (the real `SEAT_DEFS` doesn't have the capability
yet).
**b. GREEN.** In `packages/shared/src/seats.ts`: add `"events.checkin"` to
the `SEAT_CAPABILITIES` array (with a doc comment: door check-in / QR
scanner access, narrowly scoped — mirrors the `data.export` entry's doc
style immediately above it) and append it to the `capabilities` array of
`chapter_director`, `event_lead`, `event_organizers`, and
`production_coordinator` in `SEAT_DEFS`.
**c. Full suite.** `pnpm --filter @events-os/shared test`.

### 2. Backfill migration for already-seeded orgs
**a. RED.** In the new `apps/convex/tests/ticketingAccess.test.ts`, import
`runSeedSeatDefs` from `../migrations/0022_seed_seat_defs` and the
not-yet-existing `runAddEventsCheckinDefaults` from
`../migrations/0060_add_events_checkin_defaults` (mirroring
`campaignPower.test.ts`'s imports). Write a test that: seeds seat defs,
directly `ctx.db.patch`es the `event_lead` seatDef row's `capabilities` back
to `[]` (simulating a pre-migration production row seeded before this PR),
runs `runAddEventsCheckinDefaults`, and asserts the row's `capabilities` now
includes `"events.checkin"`; then runs it a SECOND time and asserts the
returned `{ patched, skipped }` shows the row counted as `skipped`, not
re-patched (idempotence). This fails today — the module doesn't exist, so
the test file fails to import.
**b. GREEN.** Create `apps/convex/migrations/0060_add_events_checkin_defaults.ts`,
copying `0036_add_campaign_power_defaults.ts`'s shape exactly: `TARGET_SLUGS
= ["chapter_director", "event_lead", "event_organizers",
"production_coordinator"]`, additive-only (append `"events.checkin"` only
if missing), doc comment explaining why (mirrors 0036's doc: the template
already has it; this patches already-seeded orgs' live rows). Register
`addEventsCheckinDefaults` in `apps/convex/migrations/index.ts`'s import
list and array, with a one-line comment matching the existing entries'
style.
**c. Full suite.** `pnpm --filter @events-os/convex test -- ticketingAccess`
and `pnpm --filter @events-os/convex test -- migrationHygiene` (new
migration number must not collide, no looped `.paginate()` — it has none).

### 3. Backend access resolver
**a. RED.** In `apps/convex/tests/ticketingAccess.test.ts`, add three tests
against the not-yet-existing `apps/convex/lib/ticketingAccess.ts`:
  - a caller with NO seat and NO role assignment on the event → `hasCheckInAccess`
    returns `false`, and `requireCheckInAccess` throws `ConvexError` with
    `code: "FORBIDDEN"`.
  - a caller whose `people` row holds an `event_organizers` seat assignment
    at the event's chapter (seeded via the `directlyAssign`-style helper
    from `campaignPower.test.ts`, after `runSeedSeatDefs` +
    `runAddEventsCheckinDefaults`) → both resolve to granted.
  - a caller with NO seat but a `roleAssignments` row for THIS event's id
    (insert directly: `eventId`, `chapterId`, a seeded `eventRoles` row's
    id, and the caller's `people._id`) → both resolve to granted.
  These fail today (the module doesn't exist).
**b. GREEN.**
  - In `apps/convex/lib/seats.ts`, add `holdsCheckInSeatAt(ctx, personId,
    scope)`, copying `holdsApprovalSeatAt`'s body exactly except checking
    `def?.capabilities.includes("events.checkin")`.
  - Create `apps/convex/lib/ticketingAccess.ts` with a module doc mirroring
    `campaignsAccess.ts`'s doc style (the ladder/two-paths explanation from
    the Solution Statement above), exporting:
    - `requireCheckInAccess(ctx, eventId): Promise<Doc<"events">>` — calls
      `requireEvent` first (existence + chapter scoping, so a bad/foreign
      id still throws its own `NOT_FOUND`), then superuser bypass, then
      walks the caller's own non-placeholder `people` rows (mirror
      `campaignsAccess.ts`'s local `ownPeopleRows` helper) checking
      `holdsCheckInSeatAt` at the event's `chapterId`, then checks
      `roleAssignments.by_event` for the eventId filtered to those
      `people` ids (bounded `take(200)`, mirroring
      `PERSON_SEAT_ASSIGNMENT_LIMIT`-style caps elsewhere in this file's
      siblings); throws `ConvexError({ code: "FORBIDDEN", message: "..." })`
      if none match.
    - `hasCheckInAccess(ctx, eventId): Promise<boolean>` — try/catch around
      `requireCheckInAccess`, mirroring `hasBlastSend`'s exact shape.
**c. Full suite.** `pnpm --filter @events-os/convex test -- ticketingAccess`.

### 4. Gate `checkInTicket`; add `myCheckInAccess`
**a. RED.** In `apps/convex/tests/ticketing.test.ts`, update the existing
check-in test (~line 260-285): before calling `checkInTicket`, do NOT yet
grant the caller access. Run `pnpm --filter @events-os/convex exec vitest
run tests/ticketing.test.ts` and confirm it now FAILS with a `FORBIDDEN`
error (the mutation still uses the old bare `requireEvent`+`requireUserId`
gate today, so this step's assertion — expecting a thrown `ConvexError`
where the test previously expected `{ result: "ok" }` — is the RED state;
write the assertion as `await expect(...).rejects.toThrow()` for now).
**b. GREEN.** In `apps/convex/ticketing.ts`: import
`requireCheckInAccess`/`hasCheckInAccess` from `./lib/ticketingAccess`;
replace `checkInTicket`'s `await requireEvent(ctx, eventId)` with `await
requireCheckInAccess(ctx, eventId)` (drop the now-redundant local
`requireEvent` call; keep `requireUserId` for the `checkedInBy` stamp). Add
a new query next to it:
```ts
export const myCheckInAccess = query({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => ({
    allowed: await hasCheckInAccess(ctx, eventId),
  }),
});
```
Then fix the test from step (a): grant the caller access the way step 3's
"assigned" test does (seed a `people` row + a `roleAssignments` row for the
event, OR grant the `event_organizers` seat) BEFORE the check-in calls, and
restore the original `{ result: "ok" }` / `"already"` / `"not_found"`
assertions.
**c. Full suite.** `pnpm --filter @events-os/convex typecheck` and
`pnpm --filter @events-os/convex test`.

### 5. Mobile: gated `expo-camera` loader + native-deps classification
**a. RED.** Run `pnpm --filter @events-os/mobile test` — the Jest
`supa-framework.test.js` guard ("native deps classified + no ungated native
imports") passes today because `expo-camera` isn't a dependency yet. Add
`expo-camera` to `apps/mobile/package.json` dependencies (use `npx expo
install expo-camera` from `apps/mobile` to pick the SDK-54-compatible
version) WITHOUT yet touching `native-deps.json`, and confirm
`supa-framework.test.js` now FAILS on "Unclassified native dependencies
found in package.json: expo-camera".
**b. GREEN.** Add `"expo-camera"` to the `"gated"` array (not `"core"`) in
`apps/mobile/native-deps.json`, with a comment explaining why (a brand-new
native module; an OTA JS update referencing it would crash an
already-installed binary that predates the native rebuild — see the file's
own `$schema`/doc and `check-native-imports`'s guidance). Create
`apps/mobile/lib/cameraScanning.ts`: a small module with a doc comment
mirroring `MarkdownEditor.native.tsx`'s "gated, dynamically loaded" comment
style, exporting a function that dynamically `require`s `expo-camera` inside
a try/catch and returns its `CameraView`/`useCameraPermissions` exports (or
`null` on failure) — never a static top-level `import ... from
"expo-camera"` anywhere in the app. Add `"lib/cameraScanning.ts"` to the
check's `allowlist` if the guard's config exposes one (check
`supa-framework.test.js`'s `createSupaTests` call/options first — if no
allowlist param exists, confirm the dynamic-require pattern alone satisfies
the "no STATIC imports of gated deps" scan, since it matches on `import`/
`export ... from` syntax, not `require(...)`).
**c. Full suite.** `pnpm --filter @events-os/mobile test`.

### 6. Mobile: pure scan-lock/normalize logic
**a. RED.** Create `apps/mobile/components/event/ticketing/ticketScan.test.ts`
importing (not-yet-existing) `normalizeScannedCode` and `shouldProcessScan`
from `./ticketScan`. Write tests: `normalizeScannedCode(" pw-8fk2-qw9t ")`
→ `"PW-8FK2-QW9T"`; `shouldProcessScan(null, "PW-AAAA-BBBB", 1000)` → `true`
(nothing locked yet); `shouldProcessScan({ code: "PW-AAAA-BBBB", at: 1000
}, "PW-AAAA-BBBB", 1500)` → `false` (same code, inside the cooldown);
`shouldProcessScan({ code: "PW-AAAA-BBBB", at: 1000 }, "PW-CCCC-DDDD",
1500)` → `true` (a different code is never blocked by another code's lock);
`shouldProcessScan({ code: "PW-AAAA-BBBB", at: 1000 }, "PW-AAAA-BBBB", 3500)`
→ `true` (same code, cooldown elapsed — an intentional re-scan of the same
ticket, e.g. after "Scan next," isn't wrongly blocked forever). Run `pnpm
--filter @events-os/mobile test` and confirm it fails (module doesn't
exist).
**b. GREEN.** Create `apps/mobile/components/event/ticketing/ticketScan.ts`
exporting `normalizeScannedCode(raw: string): string` (trim + uppercase) and
`type ScanLock = { code: string; at: number } | null` +
`shouldProcessScan(lock: ScanLock, code: string, now: number, cooldownMs =
2000): boolean` per the RED-step semantics.
**c. Full suite.** `pnpm --filter @events-os/mobile test`.

### 7. Mobile: shared check-in result banner
**a. RED.** N/A for this milestone — it's a pure extraction (no new
behavior), so per the plan-format's own guidance this step has no new
failing test; instead, verify by inspection that
`apps/mobile/components/event/ticketing/CheckInResultBanner.tsx` doesn't
exist yet.
**b. GREEN.** Extract `CheckInCard.tsx`'s `ResultLine` function (and its
`CheckInResult` type) verbatim into
`apps/mobile/components/event/ticketing/CheckInResultBanner.tsx`, exported
as `CheckInResultBanner` + `type CheckInOutcome`. Update `CheckInCard.tsx`
to import and render it in place of the old inline `ResultLine`, with
identical output.
**c. Full suite.** `pnpm --filter @events-os/mobile test` and `pnpm
--filter @events-os/mobile typecheck` (confirms no behavior change and no
orphaned type).

### 8. Mobile: `TicketScanner` camera component
**a. RED.** No new pure-logic test beyond step 6's (this component wires
`CameraView`, which this codebase's convention doesn't unit-test — see
`helpers.test.ts`'s doc comment on why RN components aren't rendered in
tests here). Verify by inspection that
`apps/mobile/components/event/ticketing/TicketScanner.tsx` doesn't exist.
**b. GREEN.** Create `TicketScanner.tsx`:
  - Props: `{ eventId: Id<"events">; run: ActionRunner["run"] }` (same
    `run` contract `CheckInCard` already uses).
  - Loads `expo-camera` via `cameraScanning.ts`'s loader; if unavailable,
    renders the SAME manual-entry UI `CheckInCard` uses today (import and
    reuse its `TextField` + `Button` block, or extract that block too if it
    keeps both components under the Clean Code file-size guidance — prefer
    extraction if `CheckInCard.tsx` would otherwise duplicate the manual
    entry JSX).
  - When available: requests camera permission via the loaded module's
    `useCameraPermissions` hook; not-yet-granted → a permission-request
    `Card` ("Allow camera access to scan tickets" + a button that calls the
    request function); denied → the manual-entry fallback with a note
    ("Camera access denied — enter the code instead.").
  - Granted: renders `CameraView` with `barcodeScannerSettings: {
    barcodeTypes: ["qr"] }` and an `onBarcodeScanned` handler that: reads
    `event.data`, calls `normalizeScannedCode`, checks `shouldProcessScan`
    against a `useRef<ScanLock>` state, and if it should process, locks
    (`{ code, at: Date.now() }`), calls `run(() =>
    checkInTicket({eventId, code}), { errorTitle: "Couldn't check in" })`,
    and on resolution renders `CheckInResultBanner` with an explicit "Scan
    next ticket" button that clears the on-screen result (the lock's
    cooldown, not the button, governs re-scan timing per step 6).
**c. Full suite.** `pnpm --filter @events-os/mobile test` and `typecheck`.

### 9. Mobile: gate `CheckInCard`, wire the scan entry point
**a. RED.** No new pure-logic test (this is UI wiring on top of an existing,
already-tested query/mutation pair). Verify by inspection: `CheckInCard.tsx`
today calls `checkInTicket` with no access check at all.
**b. GREEN.** In `CheckInCard.tsx`: add `const access =
useQuery(api.ticketing.myCheckInAccess, { eventId })`. While `access ===
undefined`, render a loading state (mirror `TicketingTab`'s "Loading event
page…" `Text`). When `access.allowed === false`, render a locked message
("Door access needed — ask an event lead to add you to this event's team,
or grant your seat check-in access.") in place of the manual field AND the
scan button (no code entry reachable at all when denied — matches the
resolver's actual enforcement). When granted, render the existing manual
field plus a new `Button` ("Scan QR code", icon similar to `"camera"` if
the icon set has one, else reuse an existing icon already used elsewhere in
this file's `Button`s) that calls `router.push(`/event/${eventId}/scan-tickets`)`.
**c. Full suite.** `pnpm --filter @events-os/mobile test` and `typecheck`.

### 10. Mobile: the scan-tickets route
**a. RED.** N/A (routing wiring). Verify by inspection:
`apps/mobile/app/(app)/event/[id]/scan-tickets.tsx` doesn't exist, and the
`no Expo Router URL conflicts` Jest guard has nothing to conflict with yet.
**b. GREEN.** Create the route, mirroring `songs.tsx`'s header/layout
shape: reads `id` via `useLocalSearchParams`, sets `<Stack.Screen options={{
title: "Scan tickets" }} />`, queries `api.ticketing.myCheckInAccess`,
renders the same locked/loading states as `CheckInCard` (or extract that
locked-state rendering into a tiny shared piece if it would otherwise be
copy-pasted verbatim — prefer extraction), and otherwise renders
`<TicketScanner eventId={eventId} run={run} />` using
`useActionRunner()`.
**c. Full suite.** `pnpm --filter @events-os/mobile test` (routing-conflict
guard + native-import guard both cover this file) and `typecheck`.

### 11. `app.config.js`: `expo-camera` plugin
**a. RED.** N/A (config, not testable via this repo's suite).
**b. GREEN.** In `apps/mobile/app.config.js`, add `"expo-camera"` to the
`plugins` array with a `cameraPermission` string, mirroring the existing
`expo-image-picker` entry's shape (e.g. `["expo-camera", { cameraPermission:
"Allow Chapter OS to access your camera to scan ticket QR codes." }]` —
confirm the exact option key against the installed `expo-camera` version's
plugin docs at implementation time).
**c. Full suite.** `pnpm --filter @events-os/mobile typecheck` (config
changes don't run through Jest/tsc directly, but this confirms nothing else
broke).

### 12. Final validation
Run every command in Validation Commands below and confirm all exit clean.

## Testing Strategy

### Tests by Milestone
| # | Milestone | Test file | The test asserts | Why it fails today |
|---|---|---|---|---|
| 1 | `events.checkin` capability | `packages/shared/src/seats.test.ts` | The 4 target seats' `capabilities` arrays include `"events.checkin"` | `SEAT_DEFS` doesn't carry the capability yet |
| 2 | Backfill migration | `apps/convex/tests/ticketingAccess.test.ts` | A pre-migration `seatDefs` row gets patched once, then reports `skipped` on re-run | `0060_add_events_checkin_defaults.ts` doesn't exist |
| 3 | Access resolver | `apps/convex/tests/ticketingAccess.test.ts` | No-access → `false`/throws `FORBIDDEN`; seat-granted → `true`; event-assigned → `true` | `lib/ticketingAccess.ts` doesn't exist |
| 4 | Gate `checkInTicket` | `apps/convex/tests/ticketing.test.ts` | An ungranted caller's `checkInTicket` call rejects; a granted caller's still returns `"ok"`/`"already"`/`"not_found"` | The mutation still uses the bare `requireEvent` gate |
| 5 | Gated `expo-camera` dependency | `apps/mobile/__tests__/supa-framework.test.js` (existing, via `pnpm --filter @events-os/mobile test`) | `expo-camera` is classified in `native-deps.json` and never statically imported outside the loader | Newly added to `package.json`, unclassified |
| 6 | Scan-lock/normalize logic | `apps/mobile/components/event/ticketing/ticketScan.test.ts` | `normalizeScannedCode`/`shouldProcessScan` behave per the cooldown/dedup spec | `ticketScan.ts` doesn't exist |
| 7–11 | UI extraction/wiring | Covered by existing `apps/mobile/__tests__/supa-framework.test.js` (routing conflicts, web-bundle safety) + `typecheck` | No routing conflicts, no orphaned exports/types, package compiles | New files/routes not yet present |

**Pattern followed:** `apps/convex/tests/campaignPower.test.ts` for the
backend access-resolver + migration test shape (seat-def seeding helpers,
`directlyAssign`, migration-runner import); `apps/mobile/components/event/ticketing/helpers.test.ts`
for the mobile pure-logic test shape (no RN component rendering in this
app's test suite).

### Integration Tests
`apps/convex/tests/ticketing.test.ts`'s check-in test (step 4) is the one
integration seam that matters end-to-end: a real caller, through the real
`checkInTicket` mutation, with a real seat/role-assignment grant, still gets
`{ result: "ok" }` — proving the gate composes with the existing idempotent
check-in logic rather than just being unit-tested in isolation.

### Edge Cases
- **Caller has a seat capability at a DIFFERENT chapter than the event's** —
  covered by step 3's resolver tests implicitly via the `scope` param match
  (`holdsCheckInSeatAt` only matches the event's own `chapterId`); add an
  explicit negative case in step 3 if not already covered by the "no
  access" test's setup.
- **Event doesn't exist / belongs to another chapter** —
  `requireCheckInAccess`'s `requireEvent` call throws its own `NOT_FOUND`
  before the check-in logic runs; covered by `requireEvent`'s existing
  behavior, no new test needed (step 3's resolver calls `requireEvent`
  first specifically so this isn't reinvented).
- **Ticket code scanned in lowercase / with whitespace** — covered by step
  6's `normalizeScannedCode` test and the existing server-side
  `code.trim().toUpperCase()` in `checkInTicket` (already covered by
  `ticketing.test.ts`'s existing lowercase-code assertion at line ~272).
- **Same QR scanned twice in a row (camera fires repeatedly while the code
  is in frame)** — covered by step 6's `shouldProcessScan` cooldown tests.
- **`expo-camera` unavailable (old native build / web / permission denied)**
  — covered by step 8's manual-entry fallback path (no automated test per
  this app's RN-component-testing convention; verify manually per the `/run`
  skill if available during implementation).
- **A denied caller who already has the Tickets tab open when their door
  access is revoked mid-session** — the reactive `useQuery` for
  `myCheckInAccess` re-renders the locked state live; no special handling
  needed (Convex's reactivity handles this for free, same as every other
  gated query in this app).

## Acceptance Criteria
- [ ] `SEAT_CAPABILITIES` includes `"events.checkin"`; `chapter_director`,
      `event_lead`, `event_organizers`, and `production_coordinator` carry
      it in `SEAT_DEFS`, and `seats.test.ts`'s pinned snapshot matches.
- [ ] `apps/convex/migrations/0060_add_events_checkin_defaults.ts` exists,
      is registered in `migrations/index.ts`, is additive-only, and is
      idempotent (a second run reports the row as skipped, not re-patched).
- [ ] `apps/convex/lib/ticketingAccess.ts` exports `requireCheckInAccess`
      and `hasCheckInAccess`; access is granted iff the caller is
      superuser, holds `events.checkin` at the event's chapter, or holds a
      `roleAssignments` row for that specific event.
- [ ] `ticketing.ts#checkInTicket` calls `requireCheckInAccess`; a caller
      without access gets a thrown `ConvexError` with `code: "FORBIDDEN"`,
      never a silent no-op or a wrong-shaped result.
- [ ] `ticketing.ts` exports `myCheckInAccess`, a non-throwing query
      returning `{ allowed: boolean }`.
- [ ] `expo-camera` is a dependency of `@events-os/mobile`, classified
      `"gated"` in `native-deps.json`, and is never statically imported
      outside `lib/cameraScanning.ts`.
- [ ] `CheckInCard` shows a locked state (no manual field, no scan button)
      when `myCheckInAccess` reports `allowed: false`.
- [ ] `CheckInCard` shows a "Scan QR code" button when `allowed: true`,
      navigating to `/event/[id]/scan-tickets`.
- [ ] The scan-tickets route independently re-checks `myCheckInAccess` (not
      just trusting `CheckInCard`'s gate) before rendering the camera.
- [ ] Scanning a ticket's QR (or, when the camera is unavailable, typing its
      code) and submitting calls the exact same `checkInTicket` mutation an
      admin's manual entry already used, with the same idempotent
      `ok`/`already`/`void`/`not_found` outcomes rendered by the shared
      `CheckInResultBanner`.
- [ ] A ticket already checked in shows "already checked in" on a second
      scan, never a duplicate check-in.
- [ ] All Validation Commands below pass.

## Validation Commands
Execute every command. Every one must exit clean.

- `pnpm install --frozen-lockfile` — install deps (including the new
  `expo-camera`)
- `pnpm --filter @events-os/shared test` — seat-capability snapshot +
  everything else in shared
- `pnpm --filter @events-os/shared typecheck`
- `pnpm --filter @events-os/convex test` — full backend suite, including
  `ticketingAccess.test.ts` and the updated `ticketing.test.ts`
- `pnpm --filter @events-os/convex typecheck`
- `pnpm --filter @events-os/convex exec vitest run tests/migrationHygiene.test.ts`
  — new migration number doesn't collide, no looped `.paginate()`
- `pnpm --filter @events-os/mobile test` — includes the Jest
  `supa-framework.test.js` native-import/web-bundle/routing guards plus the
  new `ticketScan.test.ts`
- `pnpm --filter @events-os/mobile typecheck`
- `pnpm --filter @events-os/mobile lint`
- `pnpm turbo run test` — full fan-out, zero regressions
- `pnpm turbo run build`

## Notes
- **New dependency:** `expo-camera` (native module — install via `npx expo
  install expo-camera` from `apps/mobile` so the SDK-54-compatible version
  is picked automatically). Justified: it's the only maintained,
  Expo-first QR-scanning module and this app is already all-in on Expo's
  managed workflow.
- **Shipping this to real devices** requires a NEW native build (EAS
  build/submit), not just an OTA JS update — adding a native module to an
  app using `runtimeVersion: { policy: "appVersion" }` only takes effect
  for users once they're on a binary built after this change. The
  `"gated"` classification + dynamic loader means users who haven't
  updated yet simply keep seeing the manual-entry fallback instead of
  crashing. This is a deploy-process note, not something the automated
  validation commands can verify.
- **Design decision to confirm with the user before/soon after
  implementation:** the exact default seat list granted `events.checkin`
  (`chapter_director`, `event_lead`, `event_organizers`,
  `production_coordinator`) is this plan's best read of "signed-in
  [people] we've given access to" — confirm it matches intent, since it's
  a real, opinionated org-chart change (any chapter member who is NOT one
  of these seats or on the specific event's team will be unable to check
  guests in, even though they could before this PR shipped).
- **Not training-worthy as a new Academy lesson for this PR** — ticketing/
  RSVP has no existing Academy coverage to extend (verified by search); a
  dedicated door-check-in lesson can follow once the broader ticketing
  surface gets one. State this explicitly in the PR description per
  CLAUDE.md.
- **Pre-existing gaps not introduced by this plan:** no test file exists
  yet for `apps/convex/lib/campaignsAccess.ts` in isolation (its coverage
  lives in `campaignPower.test.ts`, exercised through the public API) —
  `ticketingAccess.test.ts` follows the same "test through the public
  API" shape rather than testing the lib file directly.
