# PRD — Inventory ⇄ Supplies unification

**Status:** Shipped · **Owner:** Logistics/Platform · **Supersedes/extends:**
[`inventory.md`](./inventory.md)

> This PRD defines the relationship between the chapter **Inventory** (the `assets`
> registry) and an event's **Supplies & Logistics** (the `supplies` module rows). It
> answers four questions the team keeps hitting: does creating a supply create an
> inventory item, how do **Source** and **Status** stay in sync across events, how are
> exhaustible/consumable supplies modeled, and how does a packer see — in real time —
> that a shared item is already committed to another event.
>
> Scope here is the **product spec**. The implementation spec (grid parity, tags filter,
> assistant, and the code changes that encode these rules) lives in the approved plan
> `inventory-should-look-identical-*.md`; this doc is the source of truth for *behavior*.

---

## 1. Problem & current state

The app has **two parallel, disconnected systems for physical things**:

- **Inventory** — the `assets` table (chapter-scoped, durable gear) plus `assetReservations`
  (an event's claim on N of an asset). Schema: `apps/convex/schema/inventory.ts`. Rendered
  today as a simple Card/list on `apps/mobile/app/(app)/inventory.tsx`. Events reserve
  against it from the event **Gear** tab (`apps/mobile/components/event/gear/`).
  `listAssets` already computes, per asset: `reservedLive` (Σ reservations by
  `planning`/`ready` events), `available = max(0, quantity − reservedLive)`, and
  `overbooked`.

- **Supplies & Logistics** — the `supplies` module: `eventItems` rows (event-scoped) with a
  promoted `status` plus a `fields` bag holding `source`, `container` (labeled "Packed in"),
  `qty`, `cost`, `photo`, `link`, `notes`. Rendered through the reusable `EditableGrid`
  database view. Current option sets (`packages/shared/src/index.ts`):
  - `SUPPLY_STATUS_OPTIONS`: `pull_from_storage`, `need_to_order`, `need_to_buy`, `ordered`,
    `have_it` (complete).
  - `SUPPLY_SOURCE_OPTIONS`: `storage`, `order_online`, `buy_in_store`, `misc`.
  - `CONTAINER_OPTIONS`: `black_luggage`, `green_luggage`, `cooler`, `car`, `on_its_own`,
    `tbd`.

**The pain:** an event lists physical things in **two places** (Gear reservations *and* the
Supplies grid) with no link between them; Inventory looks nothing like Supplies; and
Status/Source/Packed-in are three independent free columns that a human has to keep
consistent by hand. A speaker that's obviously "in Green Luggage" still has to be manually
set to "Have it", and nobody in Event 2 can tell that Event 1 already took it.

**Goal:** make Status, Source, and Packed-in **one intelligent, interdependent system**
where the obvious thing happens automatically, and make Inventory the same database view
so the two worlds converge on one model.

---

## 2. Source is the spine (provenance model)

**Source answers: where did this come from, and where does it return?** That single answer
determines whether the row is inventory-backed and drives Status. Rework
`SUPPLY_SOURCE_OPTIONS` to a **provenance** set:

| Source (`value`) | Label | Inventory-backed? | Returns to | Notes |
|---|---|---|---|---|
| `chapter_storage` | Chapter Storage | **Yes** — links to an `asset` | Storage | The opt-in link. Reserve + return. |
| `borrowed` | Borrowed | **No** (external) | The lender (a person) | Favor; carries lender + return-by; cost usually $0. |
| `rented` | Rented | **No** (external) | The vendor (a company) | Paid; carries lender + return-by + fee. |
| `buy_in_store` | Buy in-store | No by default | — | Acquired; consumable unless promoted to an asset. |
| `order_online` | Order online | No by default | — | Acquired; consumable unless promoted to an asset. |

Notes:
- `misc` is dropped (folded into the acquire/borrow options); legacy rows with `misc`
  migrate to `buy_in_store` or keep their raw value harmlessly (event option sets are
  copied per-event, so old events are unaffected).
- **Chapter Storage is the only source that touches Inventory.** Everything else stays out
  of the registry — see §3.

### Loan tracking (Borrowed / Rented rows)

Borrowed/rented gear is never an asset, so the return obligation lives on the supply row.
Add to the `fields` bag:

- `lentBy` — who it's from (person or company). This is also the Source's return-to target.
- `returnBy` — date it must be given back (feeds reminders; shows as an event obligation).
- reuse existing `cost` — the rental fee (rolls into the event's planned budget). A
  borrowed favor is `$0`.

These three fields are only meaningful when Source ∈ {`borrowed`, `rented`}; the grid shows
them conditionally.

---

## 3. Does creating a supply create an inventory item? → **No.**

**The opt-in link *is* `Source = Chapter Storage`.** Choosing Chapter Storage links the
supply row to a chapter `asset` — either an existing one (picked by name) or a
newly-created one. Every other Source keeps the row **out of** Inventory.

Rationale: most supply rows are consumables ("buy ice", "order 200 wristbands"), one-off
buys, or borrowed/rented gear. Auto-creating an asset for each would flood the registry
with junk that never comes back. Inventory should hold **durable chapter-owned gear**, and
nothing else, unless a human deliberately promotes an acquired item.

**Mechanics (Shipped):**
- Setting a row's Source to `chapter_storage` prompts to **link an existing asset or create
  one** (name prefilled from the row title). The link is stored as `fields.linkedAssetId`.
- A `buy_in_store` / `order_online` row can be **promoted** to an asset later ("Keep in
  inventory") once the durable item is in hand — an explicit action, never automatic.
- Clearing Source or switching away from `chapter_storage` unlinks the asset and releases
  its reservation.

---

## 4. Status is auto-derived (the core intelligence)

Status stops being a free pick. It's **computed** from Packed-in + Source + live
cross-event state, with a **manual override** escape hatch for when reality doesn't match
the rules. A pure helper (in `packages/shared`) resolves it so the grid, calendar, and
packing screen all agree.

**Derivation precedence** (first match wins):

1. **Manual override present** → use it (see below).
2. **Packed in any real container** (`container` ∉ {`tbd`, empty}) → **`Have it`**. If it's
   physically staged in luggage/cooler/car, you have it — full stop.
3. **Chapter-Storage asset committed to *another* live event** → **`Event X · {Container}`**
   (read-only in this event). This is the real-time cross-event signal: the shared item is
   spoken for and here's where it physically is.
4. Otherwise derive from **Source**:

| Source | Linked-asset / stock state | Derived Status |
|---|---|---|
| `chapter_storage` | asset available (`available ≥ qty`) | `Pull from storage` |
| `chapter_storage` | asset overbooked (`available < qty`) | `Need to order` *(and flag conflict)* |
| `chapter_storage` | consumable, out of stock (`onHand = 0`) | `Need to buy` |
| `borrowed` | — | `Need to pick up` |
| `rented` | — | `Need to rent` |
| `buy_in_store` | — | `Need to buy` |
| `order_online` | not yet ordered | `Need to order` |
| `order_online` | marked ordered | `Ordered` |

**Manual override.** A packer can hard-set Status when reality differs (e.g. "Have it" even
though it's not packed yet). Stored as `fields.statusOverride`; it wins until cleared. The
grid shows a subtle "overridden" affordance with a one-tap "back to auto".

**New `SUPPLY_STATUS_OPTIONS`** must cover: `have_it` (complete), `pull_from_storage`,
`need_to_order`, `ordered`, `need_to_buy`, **`need_to_pick_up`** (borrowed),
**`need_to_rent`** (rented). The dynamic **`Event X · {Container}`** value is a *rendered*
state, not a stored option.

---

## 5. Source ⇄ Inventory sync (direction of truth)

- **Inventory is the source of truth for on-hand / availability & real-time location.**
- **Supplies is the source of truth for per-event need** (how many, packed where, by when).

Sync rules for a `chapter_storage`-linked supply row:

1. **Need → reservation.** The row upserts an `assetReservation` on the linked asset with
   `quantity = row qty` (reuse `reserveAsset` / `by_asset_event` upsert). This *replaces*
   the separate Gear-tab reservation flow — reserving becomes a byproduct of listing the
   supply.
2. **Packed-in → live location.** The row's `container` is written back so the asset knows
   *where* its reserved copy physically is. `listAssets` / `listAssetsGrid` expose, per live
   reservation, `{ eventName, container }`.
3. **Availability & location → Status.** Another event that lists the same asset sees
   **`Event X · Green Luggage`** (precedence rule 3) instead of "Pull from storage" — no
   double-booking surprise on load-in day.
4. **Release.** When the event leaves the live window (`status` ∉ {`planning`, `ready`}) or
   the link is cleared, the reservation drops and availability returns automatically (the
   existing `listAssets` live-set logic already does this).

Non-storage sources never reserve and never appear in Inventory.

---

## 6. Consumables & exhaustion

Durable gear comes back; consumables get used up. Model this with a flag on the asset.

- Add `assets.consumable: boolean` (default `false`) and an optional
  `assets.lowStockThreshold: number`.
- **Durable** (`consumable = false`) → **reserved**: a temporary hold for live events.
  `available = onHand − reservedLive`, restored after the event. (Today's behavior.)
- **Consumable** (`consumable = true`) → **consumed**: quantity is *permanently* decremented
  when an event marks it used. No auto-restore.

**State machine (per asset):**

| Asset kind | Event action | Effect on stock | Asset state surfaced |
|---|---|---|---|
| Durable | Event goes live & reserves N | `available −= N` (hold) | `Reserved by {event}` |
| Durable | Event ends / unlinks | hold released | back to `available` |
| Durable | condition set `broken` | — | `Needs repair` badge |
| Consumable | Event consumes N | `onHand −= N` (permanent) | `onHand` drops |
| Consumable | `onHand ≤ lowStockThreshold` | — | **Low stock** badge |
| Consumable | `onHand = 0` | — | **Out of stock / restock** badge |

**Cross-links to Status (§4):** when a linked consumable hits `onHand = 0`, its supply rows
derive to `Need to buy`; a durable that's overbooked derives to `Need to order` and flags
the conflict. This is how "we're out of X" propagates to every event that needs X without
anyone checking manually.

---

## 7. Unified UX

- **Inventory becomes the same `EditableGrid` database view as Supplies** — identical
  toolbar (Group / Columns), cells, and feel — plus a **tags filter pill bar** and an
  on-page **AI assistant** (see the implementation plan for the how).
- The event **Gear tab has been removed.** Reserving chapter gear now happens via supply
  rows with `Source = Chapter Storage`, consolidating the two reservation flows.
- **Tags replace categories** on assets: the single `category` enum is dropped in favor of
  free-form multi-value `tags`; filter pills derive from tags in use. (Suggested vocabulary
  seeds from the old category list: audio, power, lighting, staging, cabling, signage,
  transport.)

---

## 8. Non-goals / open questions (v1)

- **Out of scope:** multi-location stock (more than one storage place), purchase orders &
  receiving, cost/depreciation rollups, barcode/QR scan-to-pack.
- **Open:** should a consumable auto-create a "restock" supply row on the *next* event when
  it hits zero, or just badge it? (Leaning badge-only for v1.)
- **Open:** conflict resolution when two live events both reserve more than `available` —
  v1 flags both (`overbooked`); a priority/first-come rule is future work.
- **Open:** do borrowed/rented rows need a "returned ✓" checkbox distinct from the packing
  load-out toggle? (Probably yes, but low priority.)

---

## Appendix — data-model deltas (summary)

- `assets`: **drop** `category`; **add** `tags: string[]`, `consumable: boolean`,
  `lowStockThreshold?: number`.
- `assetReservations`: gains an effective `container` readout via the linked supply row (no
  new column required if we join through `linkedAssetId`; a denormalized copy is an option).
- `eventItems.fields` (supplies): **add** `linkedAssetId`, `lentBy`, `returnBy`,
  `statusOverride`.
- `SUPPLY_SOURCE_OPTIONS`: → `chapter_storage`, `borrowed`, `rented`, `buy_in_store`,
  `order_online`.
- `SUPPLY_STATUS_OPTIONS`: → add `need_to_pick_up`, `need_to_rent` (keep the rest);
  `Event X · {Container}` is rendered, not stored.
