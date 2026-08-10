# Feature: Resizable site-map pins (+ site map stays open by default)

## Feature Description
On the event planning page's Supplies & Logistics module, the Site Map lets a
chapter sketch a venue with Pins, Boxes (rects), Circles, and Lines. Boxes,
Circles, and Lines are already resizable **on web** (drag their corner/endpoint
handles); Pins have no resize affordance anywhere. This feature adds resize to
Pins — on both web and native — and fixes the Site Map subsection so it renders
expanded by default instead of collapsed behind an extra click.

## User Story
As a chapter lead sketching a venue's site map
I want to resize a pin the same way I can already resize a box, circle, or line
So that I can size a pin to match what it represents (a small equipment drop vs.
a whole staging area) without deleting and re-adding it

## Problem Statement
1. **Pins can't be resized.** `siteMarkers` has no size field at all — every pin
   renders as a fixed 16px dot (`apps/mobile/lib/siteMapGeometry.ts#MARKER_HALF`).
   Boxes/circles (`w`/`h`) and lines (`x2`/`y2`) already carry size/extent in the
   schema and already have working resize UI on web
   (`WebShapeRnd`/`WebLine` in `SiteMapEditor.tsx`); pins have neither.
2. **The Site Map starts collapsed.** `SiteMapSubsection.tsx` defaults
   `expanded` to `false`, so every chapter lead has to click to reveal it on
   every visit to the event page.

## Solution Statement
**Pins:** add an optional `size` (px diameter) field to `siteMarkers`, thread it
through `addMarker`/`updateMarker`/`get`/`publicSiteMap`, and extend the two
existing per-platform pin renderers with a resize affordance that mirrors how
this file already resizes boxes/circles/lines:
- **Web** — `WebMarkerRnd` already wraps the pin in `react-rnd` for drag; this
  turns its `enableResizing` on (single corner handle, aspect-locked), exactly
  the pattern `WebShapeRnd` already uses for box/circle corner-resize.
- **Native** — `Pin` already drags itself via the RN responder system
  (`onStartShouldSetResponder`/`onResponderMove`/`onResponderRelease`). This adds
  a small resize grip, shown only while the pin is selected, using the SAME
  responder system (not `react-native-gesture-handler`, despite that being the
  pattern `components/grid/ResizeHandle.tsx` uses for grid columns/rows) —
  deliberately, because the grip lives inside the same interactive node that
  already claims the responder for drag; mixing gesture-handler's `GestureDetector`
  into that node risks fighting the existing drag responder for the same touch.
  Consistency with Pin's own established interaction model wins over reuse of
  an unrelated domain's resize widget.

A marker's rendered size is `marker.size ?? DEFAULT_MARKER_SIZE` everywhere, so
every existing site map with no `size` set renders identically to today
(`DEFAULT_MARKER_SIZE` is the current fixed diameter, 16px) — this is a
backward-compatible additive change, not a migration.

**Boxes/Circles/Lines:** already resizable on web (`WebShapeRnd` corner handles,
`WebLine` endpoint handles) — no code change needed there. Native boxes/circles/
lines have no move OR resize today (`EditorShape` is tap-to-select only); adding
that is a materially larger effort (building move AND resize where today there
is neither, for three shape types) and is called out below as explicitly out of
scope — see **Notes**.

**Site Map default-expanded:** flip `SiteMapSubsection`'s initial `expanded`
state from `false` to `true`. The toggle itself (click to collapse) is
untouched — only the initial state changes.

## Scope
**In scope:**
- `siteMarkers.size` schema field + `addMarker`/`updateMarker`/`get`/
  `publicSiteMap` support.
- Shared marker-size geometry constants/helpers (`DEFAULT_MARKER_SIZE`,
  `MIN_MARKER_SIZE`, `MAX_MARKER_SIZE`, `clampMarkerSize`, `markerHalf`).
- Every read-only pin renderer (`MarkerView`, and therefore `SiteMapPreview`,
  `SiteMapView`, the public `/share/<eventId>` page) rendering pins at their
  stored size.
- Web pin resize (`WebMarkerRnd` in `SiteMapEditor.tsx`).
- Native pin resize (`Pin` in `SiteMapEditor.tsx`).
- `SiteMapSubsection` expanded-by-default fix (applies to both the event page
  and the template editor, since both render through this one component).
- Undo/redo for a pin resize (falls out of the existing generic
  `opPatchMarker` before/after mechanism — no new code required, verified as
  part of Milestone 5/6's manual QA).

**Out of scope:**
- Native drag/resize for boxes, circles, or lines — today these have **zero**
  interactivity beyond tap-to-select on native (no drag either); bringing them
  to parity with web is a separate, larger effort. Flagged for the user to
  confirm as a follow-up (see **Notes**).
- Any change to box/circle/line resize behavior on web (already works,
  untouched by this plan).
- A numeric/slider size input in the contextual bar — resize is drag-only, same
  as the existing box/circle/line UX.
- Backend clamping of `size` beyond "don't corrupt rendering" — mirrors the
  existing precedent that `w`/`h` on shapes are stored unclamped (only x/y/x2/y2
  get `clamp01`'d); UI-side bounds (`MIN_MARKER_SIZE`/`MAX_MARKER_SIZE`) are
  enforced where the user drags, not in the mutation.

## Relevant Files

- `apps/convex/schema/siteMap.ts` — add `size` to the `siteMarkers` table.
- `apps/convex/siteMap.ts` — `addMarker`, `updateMarker`, `get`,
  `publicSiteMap` all need to accept/return `size`. **Pattern to follow:**
  `updateShape`'s existing `w`/`h` handling (unclamped optional-patch fields) —
  `apps/convex/siteMap.ts:247-276`.
- `apps/mobile/lib/siteMapGeometry.ts` — add marker-size constants + the
  `clampMarkerSize`/`markerHalf` pure helpers; extend `MarkerGeometry` with
  `size?: number | null`. **Pattern to follow:** the existing `clamp01`/
  `lineGeometry` pure-function style in this same file.
- `apps/mobile/components/event/siteMapShapes.tsx` — `MarkerView` sizes its dot
  from `markerHalf(marker)` instead of the fixed `MARKER_HALF`/`h-4 w-4`.
- `apps/mobile/components/event/SiteMapEditor.tsx` — `WebMarkerRnd` (web resize)
  and `Pin` (native resize) both change; the call sites that render them
  (~line 2460 and ~line 2568) pass a new `onResizeStop`/`onResize` callback into
  `opPatchMarker`. **Pattern to follow:** `WebShapeRnd`'s corner-resize wiring
  (`apps/mobile/components/event/SiteMapEditor.tsx:471-551`, esp. the
  `enableResizing`/`onResizeStop` shape) for the web side; `Pin`'s own existing
  drag responder (`apps/mobile/components/event/SiteMapEditor.tsx:365-466`) for
  the native side.
- `apps/mobile/components/event/SiteMapSubsection.tsx` — flip the initial
  `expanded` state (line 17) from `false` to `true`; update the doc comment.

### New Files
- `apps/convex/tests/siteMap.test.ts` — first dedicated backend test file for
  the site-map domain (today's coverage is incidental, inside
  `itemConvert.test.ts`/`itemToVendorConvert.test.ts`). Covers `addMarker`/
  `updateMarker`/`get`/`publicSiteMap` size handling.
- `apps/mobile/lib/siteMapGeometry.test.ts` — pure-function tests for
  `clampMarkerSize`/`markerHalf`, following the existing
  `apps/mobile/components/orgchart/canvasMath.test.ts` pattern (clamp-style
  pure geometry helpers, `@jest/globals`).

## Implementation Plan

### Phase 1: Foundation
`siteMarkers.size` schema field, mutation/query plumbing, and the shared
`clampMarkerSize`/`markerHalf`/`DEFAULT_MARKER_SIZE` geometry helpers everything
downstream depends on.

### Phase 2: Core Implementation
Wire the new size into every render surface (`MarkerView` → preview/public/
template views for free) and into the two interactive editors (web `react-rnd`,
native responder-based grip).

### Phase 3: Integration
`SiteMapSubsection`'s expanded-by-default fix — independent of Phases 1-2,
included here as the smallest, standalone milestone.

## Step by Step Tasks
IMPORTANT: Execute every step in order, top to bottom.

### Milestone 1 — Site Map starts expanded
**a. RED:** There is no existing automated test for `SiteMapSubsection`'s
initial state (no `.test.tsx` harness exists anywhere in `apps/mobile` — 0
component-render tests in this repo today). Confirm the current behavior
manually instead: run the app (`/run` or `pnpm --filter @events-os/mobile
typecheck` won't catch this — it's a visual state), open an event's Supplies &
Logistics module, and confirm the Site Map row is collapsed until clicked. This
is the RED state this milestone fixes.

**b. Implement:** In `apps/mobile/components/event/SiteMapSubsection.tsx`,
change line 17 from `useState(false)` to `useState(true)`. Update the doc
comment (lines 7-15) — it currently says "Collapsed by default: the editor is a
heavy canvas with its own queries, so it only mounts once expanded." Replace
with something like: "Expanded by default so the venue layout is visible
without an extra click; the editor still only mounts its canvas + queries once
this subsection is on screen (there's no separate route change), so this only
costs the query cost this section's own render already implies."

**c. Verify:** `pnpm --filter @events-os/mobile typecheck`, then confirm
manually (event page AND `apps/mobile/app/(app)/template/[id].tsx`'s template
editor, since both render through this one component) that the Site Map is
visible on first render.

### Milestone 2 — Backend: `siteMarkers.size`
**a. Write the failing test (RED).** Create `apps/convex/tests/siteMap.test.ts`
following the `newT()`/`setupChapter()`/`run()` pattern from
`apps/convex/tests/setup.helpers.ts` and the `seedEvent()` helper style from
`apps/convex/tests/itemConvert.test.ts:20-48`. Write:
```ts
test("addMarker persists an optional size; get and publicSiteMap return it", async () => {
  const t = newT();
  const s = await setupChapter(t);
  const eventId = await seedEvent(s);
  const scope = { kind: "event" as const, eventId };

  const noSizeId = await s.as.mutation(api.siteMap.addMarker, {
    scope, x: 0.2, y: 0.2, label: "Water station",
  });
  const sizedId = await s.as.mutation(api.siteMap.addMarker, {
    scope, x: 0.4, y: 0.4, label: "Stage", size: 40,
  });

  const got = await s.as.query(api.siteMap.get, { scope });
  expect(got.markers.find((m) => m._id === noSizeId)?.size).toBeNull();
  expect(got.markers.find((m) => m._id === sizedId)?.size).toBe(40);

  const pub = await s.as.query(api.siteMap.publicSiteMap, { eventId });
  expect(pub.markers.find((m) => m.label === "Stage")?.size).toBe(40);
});

test("updateMarker patches size", async () => {
  const t = newT();
  const s = await setupChapter(t);
  const eventId = await seedEvent(s);
  const scope = { kind: "event" as const, eventId };
  const markerId = await s.as.mutation(api.siteMap.addMarker, {
    scope, x: 0.5, y: 0.5,
  });

  await s.as.mutation(api.siteMap.updateMarker, { markerId, size: 30 });

  const got = await s.as.query(api.siteMap.get, { scope });
  expect(got.markers.find((m) => m._id === markerId)?.size).toBe(30);
});
```
Run `pnpm --filter @events-os/convex exec vitest run tests/siteMap.test.ts` and
confirm it fails with an argument-validation error (`size` isn't a declared arg
on `addMarker`/`updateMarker` today) — genuine RED, not a broken test.

**b. Implement the minimum to reach GREEN.**
- `apps/convex/schema/siteMap.ts`: add `size: v.optional(v.number())` to the
  `siteMarkers` table (update the table's doc comment to mention it).
- `apps/convex/siteMap.ts`:
  - `addMarker` args: add `size: v.optional(v.number())`; pass `size: args.size`
    into the `ctx.db.insert("siteMarkers", { ... })` call (unclamped, same as
    `addShape` passes `w`/`h` straight through).
  - `updateMarker` args: add `size: v.optional(v.number())`; in the patch loop,
    add `if (patch.size !== undefined) fields.size = patch.size;`.
  - `get`'s marker mapping: add `size: m.size ?? null,`.
  - `publicSiteMap`'s marker mapping + its `empty.markers` type annotation: add
    `size` (`number | null`, optional).

**c. Run the full suite** (`pnpm --filter @events-os/convex test`) before
moving on — confirm no sibling test regressed.

### Milestone 3 — Shared geometry: marker size helpers
**a. Write the failing test (RED).** Create
`apps/mobile/lib/siteMapGeometry.test.ts`, following
`apps/mobile/components/orgchart/canvasMath.test.ts`'s `@jest/globals` clamp-
testing style:
```ts
import { describe, expect, test } from "@jest/globals";
import {
  DEFAULT_MARKER_SIZE,
  MAX_MARKER_SIZE,
  MIN_MARKER_SIZE,
  clampMarkerSize,
  markerHalf,
} from "./siteMapGeometry";

describe("clampMarkerSize", () => {
  test("passes values inside the range through unchanged", () => {
    expect(clampMarkerSize(24)).toBe(24);
  });
  test("clamps below MIN_MARKER_SIZE and above MAX_MARKER_SIZE", () => {
    expect(clampMarkerSize(2)).toBe(MIN_MARKER_SIZE);
    expect(clampMarkerSize(999)).toBe(MAX_MARKER_SIZE);
  });
  test("falls back to the default for non-finite input", () => {
    expect(clampMarkerSize(NaN)).toBe(DEFAULT_MARKER_SIZE);
  });
});

describe("markerHalf", () => {
  test("halves a marker's own size", () => {
    expect(markerHalf({ size: 40 })).toBe(20);
  });
  test("falls back to half the default size when size is unset", () => {
    expect(markerHalf({ size: undefined })).toBe(DEFAULT_MARKER_SIZE / 2);
    expect(markerHalf({ size: null })).toBe(DEFAULT_MARKER_SIZE / 2);
  });
});
```
Run `pnpm --filter @events-os/mobile test -- siteMapGeometry` and confirm it
fails on import (none of these exports exist yet) — genuine RED.

**b. Implement the minimum to reach GREEN.** In
`apps/mobile/lib/siteMapGeometry.ts`, add:
```ts
/** Default marker PIN diameter (px) — unset markers render at this size. */
export const DEFAULT_MARKER_SIZE = 16;
/** Marker resize bounds (px), enforced only where the user drags — mirrors
 *  shapes' w/h, which the backend also stores unclamped. */
export const MIN_MARKER_SIZE = 10;
export const MAX_MARKER_SIZE = 64;

/** Clamp a marker diameter into range; non-finite falls back to the default. */
export function clampMarkerSize(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_MARKER_SIZE;
  return Math.max(MIN_MARKER_SIZE, Math.min(MAX_MARKER_SIZE, n));
}

/** Half a marker's rendered diameter — for centering it on its point. */
export function markerHalf(marker: Pick<MarkerGeometry, "size">): number {
  return clampMarkerSize(marker.size ?? DEFAULT_MARKER_SIZE) / 2;
}
```
Add `size?: number | null;` to the `MarkerGeometry` type. Keep the existing
`MARKER_HALF` constant only if something still needs a static fallback value —
otherwise remove it once Milestone 4/5/6 replace its call sites (see those
milestones; don't remove it here if it would break the not-yet-updated
callers).

**c. Run the full suite** (`pnpm --filter @events-os/mobile test`) before
moving on.

### Milestone 4 — Read-only rendering: pins render at their stored size
**a. RED (manual — no component-render harness exists in this repo, 0
`.test.tsx` files under `apps/mobile`):** With Milestones 2-3 done but this one
not, seed a marker with `size: 40` via the mutation (e.g. through the running
app or a one-off script) and confirm it STILL renders as a fixed 16px dot in
`SiteMapPreview`/`SiteMapView`/the public share page — the read surfaces ignore
`marker.size` until this milestone.

**b. Implement.** In `apps/mobile/components/event/siteMapShapes.tsx`:
- Import `markerHalf` (drop the now-unused `MARKER_HALF` import if nothing else
  in this file uses it — check first).
- In `MarkerView`, replace the fixed `MARKER_HALF`-based transform and the
  `h-4 w-4` dot with a computed size:
  ```tsx
  const half = markerHalf(marker);
  const size = half * 2;
  // transform: [{ translateX: -half }, { translateY: -half }]
  // dot: style={{ width: size, height: size, ... }} (drop the h-4 w-4 classes)
  ```
Because `SiteMapPreview.tsx` and `SiteMapView.tsx` both already render pins
through this shared `MarkerView`, they (and the public `/share/<eventId>`
page, which reads through `SiteMapView`) pick up sized pins automatically — no
changes needed in those two files.

**c. Verify:** `pnpm --filter @events-os/mobile typecheck`, then manually
confirm a marker seeded with `size: 40` now renders larger in the preview and
public share surfaces, and a marker with no `size` still renders at the
original 16px.

### Milestone 5 — Web editor: pins are resizable
**a. RED (manual — same no-harness caveat as Milestone 4):** In the web editor
today, select a pin — there is no resize handle (`WebMarkerRnd` has
`enableResizing={false}`). Confirm this is still true before starting.

**b. Implement.** In `apps/mobile/components/event/SiteMapEditor.tsx`:
- `WebMarkerRnd`: compute `half = markerHalf(marker)` /
  `size = half * 2` instead of the fixed `MARKER_RND_OFFSET`. Restructure so the
  `Rnd` box wraps ONLY the dot (`size` × `size`), with
  `enableResizing={{ bottomRight: true, ... rest false }}`, `lockAspectRatio`,
  `minWidth`/`minHeight={MIN_MARKER_SIZE}`, `maxWidth`/`maxHeight={MAX_MARKER_SIZE}`.
  Render the label chip as a sibling `div` OUTSIDE the `Rnd` (positioned via the
  marker's committed `x`/`y`/`half`, not tracked live during an active resize —
  it snaps to the right position once `onResizeStop` commits, same latency
  model as every other committed-on-release edit in this file).
- Change the component's callback contract to `onDragStop(x, y)` /
  `onResizeStop(size, x, y)` returning the marker's true center in pixels (so
  the caller no longer needs `MARKER_RND_OFFSET` math) — see
  `WebShapeRnd`'s `onResizeStop` shape (`SiteMapEditor.tsx:510-512`) for the
  pattern.
- At the call site (~line 2460-2474), simplify `onDragStop` to
  `opPatchMarker(m._id, { x: clamp01(x / W), y: clamp01(y / H) })` and add:
  ```tsx
  onResizeStop={(size, x, y) =>
    opPatchMarker(m._id, {
      size: clampMarkerSize(size),
      x: clamp01(x / W),
      y: clamp01(y / H),
    })
  }
  ```
- Remove the now-dead `MARKER_RND_OFFSET` constant and the `MARKER_HALF` import
  if nothing else in the file references it.

**c. Verify:** `pnpm --filter @events-os/mobile typecheck`, then manually drag
a pin's resize handle on web, confirm the dot grows/shrinks, release, reload
the page, and confirm the size persisted. Confirm Cmd/Ctrl+Z undoes the resize
back to the prior size (falls out of `opPatchMarker`'s existing before/after
capture — no new undo code needed). Confirm box/circle/line resize still work
unchanged.

### Milestone 6 — Native editor: pins are resizable
**a. RED (manual — same no-harness caveat):** On native (or the non-web
responder branch), select a pin — there is no resize affordance at all today.
Confirm this before starting.

**b. Implement.** In `apps/mobile/components/event/SiteMapEditor.tsx`'s `Pin`
component:
- Accept two new props: `onResize: (size: number) => void` and
  `containerSize: { width: number; height: number } | null` (pass
  `containerRect` from the call site, same value already given to
  `EditorShape`).
- Size the dot from `markerHalf({ size: resizeSize ?? marker.size })` (a new
  local `resizeSize` state mirrring the existing `drag` local-state pattern
  used for position) instead of the fixed dot.
- Add a small grip `View`, rendered only when `selected && containerSize`, at
  the dot's bottom-right edge. It claims the RN responder on
  `onStartShouldSetResponder`/`onMoveShouldSetResponder` — the SAME system
  `Pin` already uses for drag, not `react-native-gesture-handler` (see
  **Solution Statement** for why). On move, convert the touch to a diameter:
  `dx = (toNorm(e).x - marker.x) * containerSize.width`,
  `dy = (toNorm(e).y - marker.y) * containerSize.height`,
  `resizeSize = clampMarkerSize(Math.hypot(dx, dy) * 2)`. On release, call
  `onResize(resizeSize)` and clear the local state.
- At the call site (~line 2568-2580), pass `containerSize={containerRect}` and
  `onResize={(size) => opPatchMarker(m._id, { size: clampMarkerSize(size) })}`.

**c. Run the full suite** (`pnpm --filter @events-os/mobile typecheck`,
`pnpm --filter @events-os/mobile test`), then manually verify on the native
responder path: select a pin, drag its grip, confirm the dot resizes, release,
confirm the size persists after a reload, and confirm drag-to-move still works
(the grip must not steal touches meant for the drag responder when not
selected — verify by moving a pin, THEN selecting it and resizing, THEN
deselecting and moving it again).

### Final step
Run every command in **Validation Commands** below and confirm all exit clean.

## Testing Strategy

### Tests by Milestone

| # | Milestone | Test file | The test asserts | Why it fails today |
|---|---|---|---|---|
| 1 | Site Map expanded by default | N/A — no `.test.tsx` harness exists in this repo (0 component-render tests under `apps/mobile`); verified manually + by `typecheck` | Site Map canvas is visible on first render of `SiteMapSubsection`, no click required | `useState(false)` collapses it until clicked |
| 2 | Backend `siteMarkers.size` | `apps/convex/tests/siteMap.test.ts` (new) | `addMarker`/`updateMarker` accept `size`; `get`/`publicSiteMap` return the stored value (`null` when unset) | `size` isn't a declared arg on either mutation and isn't in either query's output shape today — Convex rejects the extra arg |
| 3 | Marker size geometry helpers | `apps/mobile/lib/siteMapGeometry.test.ts` (new) | `clampMarkerSize` clamps to `[MIN_MARKER_SIZE, MAX_MARKER_SIZE]` and falls back to `DEFAULT_MARKER_SIZE` for non-finite input; `markerHalf` halves a marker's own size or the default | None of `clampMarkerSize`/`markerHalf`/`MIN_MARKER_SIZE`/`MAX_MARKER_SIZE`/`DEFAULT_MARKER_SIZE` exist yet — import fails |
| 4 | `MarkerView` renders stored size | N/A — same no-harness caveat; verified manually + by `typecheck` | A marker with `size: 40` renders a 40px dot in preview/public/template surfaces; a marker with no `size` still renders at 16px | `MarkerView` ignores `marker.size`, always renders the fixed `h-4 w-4` (16px) dot |
| 5 | Web pin resize | N/A — same no-harness caveat; verified manually + by `typecheck` | Dragging a pin's resize handle on web changes its diameter and persists `size` via `opPatchMarker`; undo restores the prior size | `WebMarkerRnd` has `enableResizing={false}` — no handle renders at all |
| 6 | Native pin resize | N/A — same no-harness caveat; verified manually + by `typecheck` | Dragging a pin's resize grip on the native responder path changes its diameter and persists `size`; move-to-drag still works afterward | `Pin` has no resize affordance of any kind today |

**Pattern followed:** `apps/convex/tests/itemConvert.test.ts` (`seedEvent`
helper + `setup.helpers.ts` fixtures) for Milestone 2;
`apps/mobile/components/orgchart/canvasMath.test.ts` (pure clamp-function
testing with `@jest/globals`) for Milestone 3. Milestones 1/4/5/6 have no
precedent to follow in this repo because no `.test.tsx`/component-render
pattern exists here — this plan does not invent one, consistent with the
codebase's existing convention of only unit-testing the pure geometry layer.

### Integration Tests
N/A beyond Milestone 2's `get`/`publicSiteMap` round-trip (those two queries
ARE the integration seam between the mutation and every render surface — a
passing Milestone 2 test is the integration test for "does a resized pin's
size reach every downstream reader").

### Edge Cases
- Legacy marker with no `size` stored → renders at `DEFAULT_MARKER_SIZE` (16px,
  identical to today) — covered by Milestone 2's `get` assertion and
  Milestone 3's `markerHalf` fallback test.
- Resize dragged past the bounds → clamped to `[MIN_MARKER_SIZE,
  MAX_MARKER_SIZE]` — covered by Milestone 3's `clampMarkerSize` test; the web
  `Rnd`'s own `minWidth`/`maxWidth` props additionally prevent the drag itself
  from exceeding the bounds (Milestone 5).
- Undo/redo of a resize — falls out of `opPatchMarker`'s existing generic
  before/after capture (same mechanism color/label edits already use); no new
  code, verified manually in Milestones 5/6.
- Non-finite/garbage `size` reaching `clampMarkerSize` (e.g. a corrupted or
  hand-crafted API call) → falls back to `DEFAULT_MARKER_SIZE` rather than
  rendering `NaN` width/height — covered by Milestone 3.
- Template-scope site maps (not just event-scope) — `get` is scope-agnostic
  already; Milestone 2's test only exercises event scope, but the mutation/
  query code path is identical for template scope (same `scopeFields`/
  `requireScopeParent` helpers), so no separate test is required.

## Acceptance Criteria
- [ ] `SiteMapSubsection` renders with the Site Map expanded on first mount, on
      both the event page (`ModuleSection.tsx`) and the template editor
      (`app/(app)/template/[id].tsx`), with no click required.
- [ ] `siteMarkers.size` exists in `apps/convex/schema/siteMap.ts`;
      `addMarker`/`updateMarker` accept it; `siteMap.get`/`siteMap.publicSiteMap`
      return it (`null` when unset).
- [ ] A marker with no stored `size` renders identically to today (16px dot) —
      no visual regression on existing site maps.
- [ ] On web, a pin's resize handle changes its diameter and the new size
      persists across a reload.
- [ ] On the native responder path, a pin's resize grip (shown only while
      selected) changes its diameter and the new size persists across a
      reload; dragging the pin to move it still works before and after a
      resize.
- [ ] Resizing a pin is undoable/redoable via the existing Cmd/Ctrl+Z stack.
- [ ] Box/circle/line resize on web is unchanged (still works).
- [ ] `apps/convex/tests/siteMap.test.ts` and
      `apps/mobile/lib/siteMapGeometry.test.ts` both pass.
- [ ] All commands in **Validation Commands** exit clean.

## Validation Commands
Execute every command. Every one must exit clean.

- `pnpm install --frozen-lockfile` — install deps
- `pnpm --filter @events-os/convex typecheck` — typecheck backend
- `pnpm --filter @events-os/convex test` — backend suite incl. new `siteMap.test.ts`
- `pnpm --filter @events-os/mobile typecheck` — typecheck the app
- `pnpm --filter @events-os/mobile test` — Jest suite incl. new `siteMapGeometry.test.ts`
- `pnpm --filter @events-os/shared test` — regression guard (unrelated to this change, but part of the standard gate)
- `pnpm turbo run test` — full suite, zero regressions

## Notes
- **No new dependencies.** `react-rnd` (web) and the RN responder system
  (native) are both already in use by this exact file for the box/circle/line
  and pin-drag interactions this feature extends.
- **Academy:** this is an interaction-affordance change (resize a pin), not a
  new concept, vocabulary, flow, or role — the Academy's existing site-map
  lesson (`packages/shared/src/academy/streams/events.ts`, ~lines 1166-1204)
  describes what the site map IS, not how pins resize. Per CLAUDE.md, state
  explicitly in the PR description that this was assessed and judged **not
  training-worthy**, rather than silently skipping the check.
- **Flagged design decision — confirm before/at implementation start:**
  extending native (non-web) box/circle/line to have drag+resize (they
  currently have neither, only tap-to-select) is explicitly OUT of scope here.
  It's a substantially larger effort — three shape types need both a new move
  interaction and a new resize interaction, none of which exist today, versus
  pins which already had a working move interaction to extend. If full native
  parity for boxes/circles/lines is wanted, it should be its own
  `/plan_feature` (or `/create_plan` if it turns out to need checkpoints).
- **Pre-existing, unrelated to this change:** `Pin`'s existing drag
  (`eventToNorm`) reads `containerRef.current.getBoundingClientRect()`, a DOM
  API. On a genuine (non-web) native runtime that method may not exist on a
  bare `View` ref, which would mean drag (and, after this plan, resize) is a
  no-op there today independent of this feature. This plan does not change or
  fix that — it extends the existing interaction contract, whatever platforms
  it actually reaches, without regressing it.
