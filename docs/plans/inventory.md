# Inventory (M5.5) — chapter asset registry + per-event reservations

## Why this shape (and what it is NOT)

Every prior Phase-5 feature (Giving, Run of Show, Permits, Budget) was
**event-scoped** — a typed sub-entity keyed by `(eventId, chapterId)`. Inventory
is deliberately different, and the design docs are unanimous about it:

- rebrand §7a: *"Chapter inventory. Chapter-level assets that events **reserve**
  from, so two overlapping events can't both 'have' the 200W battery, and
  'charge the battery (VERY IMPORTANT)' becomes asset **state**, not a
  re-materialized task row."*
- chapter-playbook §1.8 / §3: the **Chapter Kit** (mixer, SM58s, 200W battery,
  signs, cabling) materializes into these asset records on provisioning,
  pre-flagged *"not yet acquired."*
- ux-review: *"Inventory has no home — chapter-level asset registry + per-event
  reservations."*

So Inventory is the **first chapter-level typed entity**. The green luggage
lives in Brooklyn, not in one event. Events borrow from it.

**Scoping call (flagged, consistent with prior features):** the *Chapter Kit
materialization* (playbook → asset records) belongs to the Central phase
(playbook §5.5, "depends on the typed inventory work") and is **out of scope
here**. This ships the durable core it will later fill: the asset registry +
reservations. Multi-chapter/central-owned loanable assets are also later —
every asset here is chapter-owned (`chapterId`), matching Songs.

## Data model

Two tables (`apps/convex/schema/inventory.ts`), both chapter-scoped:

### `assets` — the chapter's gear registry (the durable thing)

```
chapterId       v.id("chapters")
name            v.string()              // "SM58 mic", "200W battery", "A-frame sign"
category        union(INVENTORY_CATEGORIES)
quantity        v.number()              // total OWNED count; non-neg integer; 0 allowed
                                        //   (a Kit item you're targeting but don't own yet)
acquired        v.boolean()             // false = "on the list, not yet acquired" (Chapter Kit)
condition       optional union("ok" | "needs_attention" | "broken")
stateNote       optional v.string()     // freeform prep state: "charge the battery (VERY IMPORTANT)"
photoStorageId  optional v.id("_storage")
note            optional v.string()
order           v.number()
createdBy       v.id("users")
createdAt       v.number()
updatedAt       v.number()
index: by_chapter [chapterId]
```

`INVENTORY_CATEGORIES` (in `packages/shared/src/index.ts`, same pattern as
`BUDGET_CATEGORIES`): `["audio","power","lighting","staging","cabling","signage","transport","other"]`.

### `assetReservations` — an event's claim on N of an asset

```
assetId    v.id("assets")
eventId    v.id("events")
chapterId  v.id("chapters")             // copied from asset.chapterId, never client-supplied
quantity   v.number()                   // ≥1 integer — how many this event claims
note       optional v.string()
createdBy  v.id("users")
createdAt  v.number()
index: by_asset [assetId], by_event [eventId], by_asset_event [assetId, eventId]
```

### Overbooking / conflict semantics (the headline promise)

Not stored — **computed** in the registry query. For each asset:

```
reservedLive = Σ reservation.quantity  over reservations whose EVENT is "live"
               (event.status ∈ {planning, ready} — i.e. not completed/cancelled)
overbooked   = reservedLive > quantity        // "two events both want the one battery"
available    = max(0, quantity - reservedLive)
```

**Why "live events" and not time-range overlap:** events carry a single
`eventDate` timestamp, not a start/end range, so precise temporal overlap isn't
knowable. For shared *physical* gear the conservative signal is the right one —
if two upcoming events have both reserved the battery, that IS a conflict a
logistics lead needs to see now, regardless of exact dates. Completed/cancelled
events release their hold automatically (they drop out of the sum). This is the
same pragmatic-scope choice made on every prior feature; a future date-range
model can tighten it without a schema change (reservations already carry
`eventId`).

## Backend (`apps/convex/inventory.ts`)

Access mirrors Budget/Songs exactly — `requireInChapter` / `requireOwned`,
`chapterId` always copied server-side, never trusted from the client.

- **Assets (chapter-gated via `requireChapterId` + `requireInChapter`):**
  - `addAsset` — insert; `assertNonNegInt(quantity)`; `order` = append.
  - `updateAsset` — patch name/category/quantity/acquired/condition/stateNote/note;
    re-validate quantity when present; `updatedAt` bumped.
  - `setAssetPhoto` — attach/clear `photoStorageId` (mirror Budget `setReceipt`).
  - `removeAsset` — `requireOwned("assets")`, then **cascade-delete its
    reservations** (`by_asset`) so no orphan claims survive; then delete the asset.
  - `listAssets` (query) — chapter registry with the computed
    `reservedLive` / `available` / `overbooked` per asset, plus resolved
    `photoUrl`. Reads all live events once into a Set to classify reservations
    without an N+1.
- **Reservations (gated through the EVENT via `requireEvent`, so cross-chapter
  events are rejected before any read — same guard order as `budgetSummary`):**
  - `reserveAsset` — args `{ eventId, assetId, quantity, note? }`. `requireEvent`
    on eventId; load the asset and assert `asset.chapterId === event.chapterId`
    (no cross-chapter reservation); `assertPosInt(quantity)`; **upsert** on
    `by_asset_event` (a second reserve of the same asset by the same event
    updates the quantity rather than making a duplicate row).
  - `updateReservation` / `removeReservation` — `requireOwned("assetReservations")`.
  - `listEventReservations` (query) — `requireEvent`; the event's reservations
    joined to their asset (name/category/available), each flagged
    `shortfall = quantity > asset.available + quantity ? …` → simpler:
    surface the asset's chapter-wide `overbooked` so the event view warns too.

No migration — both tables are new and empty (like Budget). No readiness
wiring (inventory isn't a launch blocker; a follow-up can add "unacquired Kit
items" to readiness once the Kit materializes).

## Mobile UI

Two surfaces — the registry is chapter-level (a nav pillar), reservations are
per-event (an event tool), mirroring how Songs (library) + setlists (per-event)
split.

### 1. Inventory nav pillar — `apps/mobile/app/(app)/inventory.tsx`

- Added to `AppShell` `NAV` after Songs: `{ label: "Inventory", icon:
  "package", path: "/inventory" }`, gated **admin or lead** in `useNav` (the
  logistics-lead domain; keeps volunteers'/members' nav lean — members see
  Events/Work/Songs/Academy, leads+admins also get People + Inventory).
- Screen: the asset registry. Each row shows name, category, a
  **`available / quantity`** chip (e.g. "3 / 5"), an **overbooked** warning pill
  when `reservedLive > quantity`, an **acquired** toggle ("Not yet acquired"
  badge when false), condition dot, and the `stateNote` prep line. Inline
  add/edit like the Budget/People grids; photo via a `CoverPhotoPicker`-style
  storage flow.

### 2. Event "Gear" tool — REMOVED

The event Gear tab has been removed. Asset reservations now occur through the event's
**Supplies grid** when a supply row's Source is set to `Chapter Storage`. This consolidates
asset reservations with the broader supplies/logistics workflow (see `inventory-supplies-unification.md` §3 & §5).

## Verification

Full matrix (`pnpm -C apps/convex typecheck && test`, `pnpm -C apps/mobile
typecheck && lint && test`) + an independent adversarial review before the PR,
focused on: reservation upsert idempotency, cascade-delete on `removeAsset`
(no orphan reservations), the live-events overbooking sum (completed events
must drop out), cross-chapter reservation rejection, quantity validation
(≥0 for assets, ≥1 for reservations, integers), the `api.d.ts` hand-edit, and
non-disruption of the existing `supplies` grid module (Inventory is additive;
the generic `supplies` module stays untouched).
