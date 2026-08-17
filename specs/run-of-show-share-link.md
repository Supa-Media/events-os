# Feature: Share link for the Run of Show

## Feature Description
A public, no-login preview link for an event's Run of Show, plus a "Share"
button (the OS-native share sheet on iOS/Android, clipboard on web) that
generates and shares it. The preview page reuses the existing mobile-first,
vertically-stacked Run of Show timeline component — no side-to-side
scrolling — instead of the wide, column-heavy editing grid staff use inside
the app.

## User Story
As an event owner or Production Lead
I want to share a clean, read-only link to the run of show
So that volunteers, guest speakers, or anyone without an account can pull it
up on their phone and read it top to bottom without fighting a wide table.

## Problem Statement
The run of show is edited inside the event workspace as `EditableGrid` — a
spreadsheet-style table with a time/offset column, a duration column, a
title column, a notes column, etc. On a phone that table is wider than the
screen, so reading it means scrolling left and right for every row — the
exact complaint in this request. There is also no dedicated way to hand
someone outside the app a link to just the run of show: the only existing
public link (`EventTools`'s "Share crew link", `/share/<eventId>`) bundles
the *entire* volunteer briefing — teams, who's on each team, and their
expectations — with the run of show as one section inside it, and it only
copies a URL to the clipboard; it never opens the OS share sheet.

## Solution Statement
Two things, both required for "a share button that gets the run of show onto
someone's phone, readable":

1. **A dedicated public run-of-show page.** `apps/mobile/app/share/[id]/run-of-show.tsx`
   — a new no-auth route (same `app/share/` public zone as the existing
   `/share/[id]` crew briefing) that renders `RunOfShowView`
   (`apps/mobile/components/crew/RunOfShowView.tsx`) — **the pattern to
   follow**. `RunOfShowView` already exists specifically to solve this: it
   is a single-column, vertically-stacked timeline (time stacked above each
   segment, not beside it in its own scrollable column) with a live
   "NOW"/"UP NEXT" highlight, and it is already reused today inside the
   bundled `/share/[id]` briefing (`BriefingView` → `RunOfShowView`). This
   plan gives it its own narrower, run-of-show-only route so a share link
   can point at just the run of show instead of the whole briefing.
   Backed by a new public query, `api.events.publicRunOfShow`, which reuses
   the exact sanitization/sort logic `buildCrewBriefing`'s run-of-show
   section already has (extracted into a shared helper so the two can never
   drift).
2. **A "Share" button that opens the real OS share sheet.** Added to the Run
   of Show module's header inside the event workspace
   (`apps/mobile/components/event/ModuleSection.tsx`), next to where
   Supplies already gets its own module-specific button ("Packing mode") —
   **the pattern to follow** for a per-module action button. On native it
   calls `Share.share(...)` (`react-native`'s built-in share sheet — Messages,
   Mail, WhatsApp, etc.); on web it copies the link and confirms with an
   alert. This exact web/native split, including the native deep-link
   fallback via `Linking.createURL`, already exists in
   `apps/mobile/app/(app)/finances/reimbursements/index.tsx`
   (`reimburseRequestUrl` / `shareRequestLink`) — **the pattern to follow**
   for the button's implementation, chosen over `EventTools`'s existing
   "Share crew link" (clipboard-only, and broken on native — it builds off
   `typeof window !== "undefined"`, which is always false there) and over
   `doc/[id].tsx`'s share function (clipboard + `Linking.openURL`, never
   opens the native share sheet). The reimbursements version is the only
   existing implementation that actually satisfies "the classic share
   button."

## Scope
**In scope:**
- A public, no-auth query returning the sanitized run-of-show timeline for
  one event (name, event date, segments — no owner/role/money fields).
- A public, no-auth mobile route rendering that timeline with
  `RunOfShowView` (already mobile-first, no horizontal scrolling).
- A "Share" button on the Run of Show module's header in the event
  workspace that opens the native OS share sheet (or copies the link on
  web) for that new page's URL.

**Out of scope:**
- Changing the existing `/share/[id]` crew briefing or its "Share crew link"
  menu item — they keep working exactly as they do today.
- Changing the in-app Run of Show editing grid (`EditableGrid`) — staff
  still edit the run of show as a table; this plan only affects the
  read-only public preview.
- QR codes, expiring/revocable links, or per-recipient tokens — the run of
  show link is public-by-knowledge-of-the-URL, matching every other
  `/share/<id>` link in this codebase (crew briefing, docs' `/d/<shareId>`).
- Fixing `EventTools.shareCrew`'s native-URL gap — noted as a pre-existing
  issue, not touched here (different button, different flow).

## Relevant Files
- `apps/convex/events.ts` — home of `buildCrewBriefing` and `publicCrew`
  (the existing public, no-auth query pattern to extend) and where the new
  `buildPublicRunOfShow` helper + `publicRunOfShow` query are added.
- `apps/mobile/app/share/[id].tsx` — the existing public crew-briefing
  route; **the routing pattern to follow** for a no-auth `app/share/*`
  screen (headerless `Stack.Screen`, `undefined`/`null`/loaded query states).
- `apps/mobile/components/crew/RunOfShowView.tsx` — **the pattern to
  follow** for mobile-friendly run-of-show rendering; reused as-is, no
  changes needed.
- `apps/mobile/components/event/ModuleSection.tsx` — renders the Run of
  Show module inside the event workspace (`EditableGrid`, unchanged); gets
  the new "Share" button in its `secondaryControls`, next to the existing
  Supplies-only "Packing mode" button (**the pattern to follow** for a
  per-module action button).
- `apps/mobile/app/(app)/finances/reimbursements/index.tsx` —
  `reimburseRequestUrl` / `shareRequestLink` (~line 129-162) — **the pattern
  to follow** for the share button's web/native implementation.
- `apps/mobile/lib/appUrl.ts` — `webAppUrl`, reused unchanged for the web
  branch of the new share URL.
- `apps/convex/tests/runOfShow.test.ts` — existing `describe("crew briefing
  run of show", ...)` block with the `publicCrew` test; extended with the
  new `publicRunOfShow` tests, following its exact fixture shape.

### New Files
- `apps/mobile/app/share/[id]/run-of-show.tsx` — the public run-of-show-only
  preview page (mirrors `event/[id]/day-of.tsx` coexisting with
  `event/[id].tsx`: a `[id].tsx` leaf file and a `[id]/` folder for a child
  route both live under `app/share/`).

## Implementation Plan

### Phase 1: Foundation
Extract the run-of-show sanitization/sort logic already inlined in
`buildCrewBriefing` into a standalone `buildPublicRunOfShow(ctx, eventId)`
helper in `apps/convex/events.ts`, and add a `publicRunOfShowValidator`
(`{ name, eventDate, runOfShow }`, reusing the existing
`crewRunOfShowValidator` for the row shape). `buildCrewBriefing` calls the
new helper instead of repeating the query/map/sort inline — same output,
zero behavior change.

### Phase 2: Core Implementation
- `apps/convex/events.ts`: add the public, no-auth `publicRunOfShow` query
  (mirrors `publicCrew`: `ctx.db.get(eventId)` → `null` if missing, else
  `{ name: event.name, eventDate: event.eventDate, runOfShow: await
  buildPublicRunOfShow(ctx, eventId) }`).
- `apps/mobile/app/share/[id]/run-of-show.tsx`: new no-auth route. Reads
  `id` via `useLocalSearchParams`, queries `api.events.publicRunOfShow`,
  handles the `undefined` (loading) / `null` (not found) / loaded states the
  same way `/share/[id].tsx` does, and renders `RunOfShowView` inside a
  `ScrollView` with the event name as a heading above it.

### Phase 3: Integration
- `apps/mobile/components/event/ModuleSection.tsx`: add a "Share" button to
  `secondaryControls` when `module.key === "run_of_show"` (alongside the
  existing Supplies-only "Packing mode" button), wired to a new
  `shareRunOfShow(eventId)` function that builds the
  `/share/<eventId>/run-of-show` URL (`webAppUrl` on web,
  `Linking.createURL` on native — mirroring `reimburseRequestUrl`) and opens
  `Share.share(...)` on native / copies + confirms on web (mirroring
  `shareRequestLink`).

## Step by Step Tasks
IMPORTANT: Execute every step in order, top to bottom.

### 1. Capture the baseline
Run `pnpm --filter @events-os/convex test` and `pnpm --filter @events-os/convex typecheck`
before making any change, and record the pass count. Any new failure later
must be checked against this baseline before being attributed to this change.

### 2. Write the failing backend tests (RED)
In `apps/convex/tests/runOfShow.test.ts`, add a new `describe("public run of
show share link", ...)` block (after the existing `describe("crew briefing
run of show", ...)` block) with two tests, reusing that block's exact setup
(create an event type + event via `api.events.createFromTemplate`, insert
two `run_of_show` `eventItems` directly via `run(t, ...)`, deliberately out
of order):

- `"publicRunOfShow returns the sanitized, offset-sorted timeline with no
  auth"` — call `t.query(api.events.publicRunOfShow, { eventId })` on the
  **unauthenticated** `t` (not `as` — this must work with zero auth, the
  entire point of a share link), and assert:
  - `result.name` equals the event's name and `result.eventDate` equals the
    event's `eventDate`.
  - `result.runOfShow` equals the same sanitized, offset-sorted array shape
    the existing `publicCrew` test expects (title/offsetMinutes/
    durationMinutes/notes only — no `role`/`owner` field, even though the
    seeded row includes `role: "Worship Lead"` in its `fields`).
- `"publicRunOfShow returns null once the event is gone"` — create an event,
  delete it via `run(t, (ctx) => ctx.db.delete(eventId))` (the same pattern
  `financeLinksToBudgets.test.ts`/`budgetMonthGate.test.ts` use for a
  "vanished" fixture), then assert
  `await t.query(api.events.publicRunOfShow, { eventId })` is `null`.

Run `pnpm --filter @events-os/convex exec vitest run tests/runOfShow.test.ts`.
**Expected RED:** both new tests fail because `api.events.publicRunOfShow`
does not exist yet (a TypeScript/module-resolution error on `api.events.publicRunOfShow`,
not a runtime assertion failure) — confirm it's exactly this missing-export
error before proceeding.

### 3. Extract `buildPublicRunOfShow` and add `publicRunOfShow` (GREEN)
In `apps/convex/events.ts`:
- Add `const publicRunOfShowValidator = v.object({ name: v.string(),
  eventDate: v.number(), runOfShow: v.array(crewRunOfShowValidator) });`
  next to `crewBriefingValidator`.
- Extract the inline run-of-show query/map/sort block currently inside
  `buildCrewBriefing` (the `runOfShowItems` query + `.map(...).sort(...)`,
  ~line 1126-1142) into:
  ```ts
  /** The sanitized, offset-sorted run-of-show timeline for one event — no
   *  owner, role, or money columns. Shared by `buildCrewBriefing` (as one
   *  section of the full volunteer briefing) and `publicRunOfShow` (the
   *  standalone share-link page), so the two can never drift. */
  async function buildPublicRunOfShow(
    ctx: QueryCtx,
    eventId: Id<"events">,
  ): Promise<Infer<typeof crewRunOfShowValidator>[]> {
    const runOfShowItems = await ctx.db
      .query("eventItems")
      .withIndex("by_event_module", (q) =>
        q.eq("eventId", eventId).eq("module", "run_of_show"),
      )
      .collect();
    return runOfShowItems
      .map((it) => ({
        title: it.title ?? "",
        offsetMinutes: it.offsetMinutes ?? 0,
        durationMinutes:
          typeof it.fields?.duration === "number" && it.fields.duration > 0
            ? it.fields.duration
            : null,
        notes: typeof it.fields?.notes === "string" ? it.fields.notes : null,
      }))
      .sort((a, b) => a.offsetMinutes - b.offsetMinutes);
  }
  ```
- Replace the extracted block inside `buildCrewBriefing` with
  `const runOfShow = await buildPublicRunOfShow(ctx, eventId);`.
- Add the query:
  ```ts
  /**
   * PUBLIC, no-auth run-of-show preview for an event — reachable by share
   * link (`/share/<eventId>/run-of-show`). Intentionally public-by-link,
   * same as `publicCrew`: no requireChapterId/requireUserId. Sanitized —
   * no owner, role, or money info.
   */
  export const publicRunOfShow = query({
    args: { eventId: v.id("events") },
    returns: v.union(publicRunOfShowValidator, v.null()),
    handler: async (ctx, { eventId }) => {
      const event = await ctx.db.get(eventId);
      if (!event) return null;
      return {
        name: event.name,
        eventDate: event.eventDate,
        runOfShow: await buildPublicRunOfShow(ctx, eventId),
      };
    },
  });
  ```
Run `pnpm --filter @events-os/convex exec vitest run tests/runOfShow.test.ts`
— both new tests pass, and the existing `"publicCrew carries a sanitized,
offset-sorted run of show"` test still passes unchanged (proves the
extraction didn't change `buildCrewBriefing`'s output).

### 4. Run the full backend suite before moving on
`pnpm --filter @events-os/convex test` — zero regressions against the step-1
baseline. `pnpm --filter @events-os/convex typecheck` — clean.

### 5. Add the public run-of-show route
Create `apps/mobile/app/share/[id]/run-of-show.tsx`, mirroring
`apps/mobile/app/share/[id].tsx`'s structure (headerless `Stack.Screen`,
same loading/not-found states) but querying `api.events.publicRunOfShow`
and rendering `RunOfShowView` instead of `BriefingView`:

```tsx
import { View, Text, ScrollView } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { Icon } from "../../../components/ui";
import { RunOfShowView } from "../../../components/crew/RunOfShowView";
import { colors } from "../../../lib/theme";
import type { Id } from "@events-os/convex/_generated/dataModel";

/**
 * PUBLIC, read-only run-of-show preview — reachable at
 * `/share/<eventId>/run-of-show`. Outside the `(app)`/`(auth)` route
 * groups (not behind the auth guard), same public zone as `/share/[id]`
 * (the full crew briefing) — this is the narrower, run-of-show-only sibling
 * for a share link that should point at just the schedule. Renders via the
 * SAME `RunOfShowView` the bundled briefing uses: a single-column, vertical
 * timeline (no side-to-side scrolling, unlike the in-app editing grid).
 */
export default function ShareRunOfShowScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const eventId = id as Id<"events">;
  const data = useQuery(api.events.publicRunOfShow, { eventId });

  if (data === undefined) {
    return (
      <>
        <Stack.Screen options={{ headerShown: false }} />
        <View className="flex-1 items-center justify-center" style={{ backgroundColor: colors.surface }}>
          <Text className="text-base text-muted">Loading…</Text>
        </View>
      </>
    );
  }

  if (data === null) {
    return (
      <>
        <Stack.Screen options={{ headerShown: false }} />
        <View className="flex-1 items-center justify-center px-6" style={{ backgroundColor: colors.surface }}>
          <Icon name="calendar" size={28} color={colors.faint} />
          <Text className="mt-3 text-center text-base text-muted">
            This event link isn't available.
          </Text>
        </View>
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <ScrollView
        style={{ flex: 1, backgroundColor: colors.surface }}
        contentContainerStyle={{ flexGrow: 1, paddingVertical: 32, paddingHorizontal: 20 }}
      >
        <View className="w-full max-w-[560px] self-center gap-6">
          <Text className="font-display text-2xl text-ink">{data.name}</Text>
          <RunOfShowView eventDate={data.eventDate} runOfShow={data.runOfShow} />
        </View>
      </ScrollView>
    </>
  );
}
```

There is no automated test for this route: this repo's mobile Jest config
(`apps/mobile/jest.config.js`) is `testEnvironment: "node"` with
`testMatch: ["**/*.test.ts"]` only — there is no component-rendering test
harness, and no comparable existing screen (`/share/[id].tsx`, `/doc/[id].tsx`,
`day-of.tsx`) has one either. Validate with typecheck/lint (step 8) and a
manual walkthrough (step 9).

### 6. Add the "Share" button to the Run of Show module
In `apps/mobile/components/event/ModuleSection.tsx`:
- Add `Platform`, `Share` to the `"react-native"` import, and
  `import * as Linking from "expo-linking";` and
  `import { webAppUrl } from "../../lib/appUrl";`.
- Add two module-scope helpers, mirroring
  `finances/reimbursements/index.tsx`'s `reimburseRequestUrl`/`shareRequestLink`:
  ```ts
  /** The public `/share/<eventId>/run-of-show` page's URL. Web: current
   *  origin + the app's `/os` base path (`webAppUrl`, same as
   *  `EventHeader.tsx`'s `shareCrew`). Native has no "current origin"
   *  signal, so it falls back to this app's own URL scheme
   *  (`Linking.createURL` — openable only by someone who already has the
   *  app installed; there's no universal-link domain configured yet — see
   *  `reimburseRequestUrl`'s identical note in
   *  finances/reimbursements/index.tsx). */
  function runOfShowShareUrl(eventId: string): string {
    if (Platform.OS === "web" && typeof window !== "undefined") {
      return webAppUrl(`/share/${eventId}/run-of-show`);
    }
    return Linking.createURL(`/share/${eventId}/run-of-show`);
  }

  /** "Share" on the Run of Show module — opens the OS share sheet on
   *  native (Messages/Mail/WhatsApp/etc. via `Share.share`), copies to the
   *  clipboard on web (with a confirmation alert, since a silent copy gives
   *  no feedback there). */
  async function shareRunOfShow(eventId: string): Promise<void> {
    const url = runOfShowShareUrl(eventId);
    if (Platform.OS === "web") {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        if (typeof window !== "undefined") window.alert(`Link copied\n\n${url}`);
      } else if (typeof window !== "undefined") {
        window.prompt("Share this run-of-show link:", url);
      }
      return;
    }
    try {
      await Share.share({ message: url, url, title: "Run of show" });
    } catch {
      // User dismissed the share sheet — nothing to do.
    }
  }
  ```
- In `ModuleSection`'s `secondaryControls`, widen the outer condition from
  `hasCalendar || module.key === "supplies"` to also include
  `module.key === "run_of_show"`, and add a button next to the existing
  Supplies-only one:
  ```tsx
  {module.key === "run_of_show" ? (
    <Button
      title="Share"
      icon="share"
      size="sm"
      variant="secondary"
      onPress={() => void shareRunOfShow(eventId)}
    />
  ) : null}
  ```

Same as step 5: no automated test exists for this class of function anywhere
in this codebase today (`reimburseRequestUrl`, `shareRequestLink`,
`EventTools.shareCrew`, and the doc share function are all untested) —
validate with typecheck/lint + the manual walkthrough below.

### 7. Run the full backend + shared suites
`pnpm --filter @events-os/convex test` and `pnpm --filter @events-os/shared test`
— zero regressions.

### 8. Typecheck and lint the mobile changes
`pnpm --filter @events-os/mobile typecheck` and `pnpm --filter @events-os/mobile lint`
— both clean.

### 9. Manual walkthrough (the mobile-viewability acceptance check)
Using the `/run` skill (or `pnpm dev` + a phone-width browser window /
simulator):
- Open an event with a populated run of show, go to the Run of Show tab,
  tap "Share" — confirm the OS share sheet opens (native) or the link is
  copied with a visible confirmation (web).
- Open the shared link at a phone width (≤ 390px). Confirm every segment
  reads top-to-bottom with **no horizontal scrolling** — the entire
  contrast with today's `EditableGrid` behavior this feature exists to fix.
- Open the link for a deleted/nonexistent event id — confirm the "This
  event link isn't available" state, not a crash.

### 10. Run the Validation Commands
Every command below must exit clean.

## Testing Strategy

### Tests by Milestone
| # | Milestone | Test file | The test asserts | Why it fails today |
|---|---|---|---|---|
| 1 | `publicRunOfShow` query + extracted helper | `apps/convex/tests/runOfShow.test.ts` (existing file, new `describe` block) | Unauthenticated caller gets `{name, eventDate, runOfShow}` sanitized + offset-sorted (no owner/role/money fields); a deleted event's id returns `null` | `api.events.publicRunOfShow` does not exist yet |
| 2 | Public run-of-show route | N/A — see below | — | — |
| 3 | "Share" button on the Run of Show module | N/A — see below | — | — |

**Pattern followed:** `apps/convex/tests/runOfShow.test.ts`'s existing
`describe("crew briefing run of show", ...)` block (`publicCrew` test) for
milestone 1's fixture/assertion shape — unauthenticated `t.query`, deliberately
out-of-order `run_of_show` `eventItems` with an internal-only `role` field
that must not leak.

Milestones 2 and 3 have no automated test because this repo has no
component-rendering test harness for Expo Router screens or UI event
handlers (`apps/mobile/jest.config.js` is `testEnvironment: "node"`,
`testMatch: ["**/*.test.ts"]` only — `.tsx` files are never collected). No
existing analogue — `/share/[id].tsx`, `/doc/[id].tsx`, `EventTools.shareCrew`,
`finances/reimbursements/index.tsx`'s `shareRequestLink` — has test
coverage either. Forcing a new test-per-milestone here would mean inventing
an untested pattern (e.g., mocking `Platform.OS`/`navigator`/`Linking` with
no existing precedent to follow) rather than following one, which Step 2 of
this planning process weighs against. These two milestones are instead
gated by typecheck, lint, and the manual walkthrough in step 9.

### Integration Tests
N/A — the only new cross-seam behavior (the query → route → component wire)
is exercised by the manual walkthrough (step 9), for the reason above.

### Edge Cases
- **Empty run of show** (no rows) — `RunOfShowView` already returns `null`
  when `runOfShow.length === 0` (existing behavior, unchanged); the new
  route still renders the event name heading above the (empty) section.
  Covered implicitly — no new logic branches on this.
- **Event deleted after the link was shared** — milestone 1's second test
  (`publicRunOfShow` → `null`) plus the route's existing `data === null`
  branch (copied from `/share/[id].tsx`, already exercised there).
- **Native share sheet dismissed without picking an app** — `shareRunOfShow`'s
  `try/catch` around `Share.share` swallows this silently (matches
  `shareRequestLink`'s identical `catch` in reimbursements), so it never
  surfaces as an error toast.
- **Web without Clipboard API** (older browser / non-secure context) — falls
  back to `window.prompt`, matching `EventTools.shareCrew`'s existing
  fallback for the crew link.

## Acceptance Criteria
- [ ] `api.events.publicRunOfShow` returns the sanitized, offset-sorted
      timeline for a valid event id when called with no auth.
- [ ] `api.events.publicRunOfShow` returns `null` for a nonexistent/deleted
      event id.
- [ ] `buildCrewBriefing`'s `runOfShow` output is byte-for-byte unchanged
      after the extraction (the existing `publicCrew` test still passes).
- [ ] Visiting `/share/<eventId>/run-of-show` with no auth renders the run
      of show as a single vertical column with no horizontal scrolling at a
      phone viewport width.
- [ ] Visiting `/share/<eventId>/run-of-show` for a missing event shows the
      "This event link isn't available" state instead of crashing.
- [ ] The Run of Show module's header in the event workspace has a "Share"
      button.
- [ ] Tapping "Share" on native opens the OS share sheet pre-loaded with the
      `/share/<eventId>/run-of-show` link; on web it copies that link and
      confirms visibly.
- [ ] `pnpm --filter @events-os/convex typecheck`, `pnpm --filter @events-os/mobile typecheck`,
      and `pnpm --filter @events-os/mobile lint` all pass clean.

## Validation Commands
Execute every command. Every one must exit clean.

- `pnpm --filter @events-os/convex exec vitest run tests/runOfShow.test.ts` — the new/extended tests, fails before Phase 1-2, passes after
- `pnpm --filter @events-os/convex test` — full backend suite, zero regressions
- `pnpm --filter @events-os/convex typecheck` — backend typecheck
- `pnpm --filter @events-os/shared test` — zero regressions (unchanged package, but shares types)
- `pnpm --filter @events-os/mobile typecheck` — mobile typecheck
- `pnpm --filter @events-os/mobile lint` — mobile lint
- `pnpm turbo run test` — full suite, zero regressions
- `pnpm turbo run build` — nothing here changes a build-time contract, but run it per the harness default

## Notes
No new dependencies — `Share` and `Platform` are both already-used exports
of `react-native` (see `finances/reimbursements/index.tsx`), and
`expo-linking` is already a dependency (same file).

**Academy:** not training-worthy. The existing "Run of Show" Academy lesson
(`packages/shared/src/academy/streams/events.ts`, ~line 912-990) teaches
what the run of show is and why it's locked at T-3; it doesn't document any
share/export mechanism, and neither does the Academy anywhere mention the
existing "Share crew link" button this feature sits beside — consistent
with treating share/export affordances as operational, not curriculum. No
lesson or quiz update is needed.

**Pre-existing gap, left alone:** `EventTools.shareCrew`
(`apps/mobile/components/event/EventHeader.tsx`) builds its URL from
`typeof window !== "undefined" ? webAppUrl(...) : ""` — on native this
always evaluates to `""`, so "Share crew link" silently copies an empty
string there today. Out of scope for this plan (different button, different
flow — see Scope), but worth a follow-up ticket since it's the same class of
bug this plan's `runOfShowShareUrl` deliberately avoids by using
`Linking.createURL` on native instead of an empty string.
