# Permits v1

Status: implemented on `claude/permits`.

## What Permits is today

Permits is the `permits` grid module (`packages/shared/src/index.ts:157`,
`offsetMode: "days"`). It ships with a fixed default column set
(`DEFAULT_COLUMNS.permits`): a title, a **typed `status`** column backed by
`PERMIT_STATUS_OPTIONS`, an `offset` ("Deadline") + `due_date` pair (the offset
back-calculates the due date via `computeDueDate`), a `document` photo/upload
cell, an owner and notes. Like every grid it is snapshotted per copy: a template
seeds its columns from `DEFAULT_COLUMNS`, and an event clones the template's
columns at instantiation. Item values live in the `fields` bag
(`v.record(string, v.any())`), except the promoted `status` / `title` /
`offsetDays` / `dueDate` fields.

Readiness across the app keys off the status column's `isComplete` options
(`isCompleteStatus`) and each item's phase (`itemPhase`, by `offsetDays`). The
one existing event-level **blocker** signal is `events.pipeline`
(`apps/convex/events.ts`): it counts `planning_doc` items that are past-due and
not complete, via the shared `statusCountsFor` / `statusColumnFor` helpers in
`apps/convex/lib/readiness.ts`. No permit signal fed it before this change.

## Scope (v1 — focused)

Deliberately NO dedicated permits table. Everything rides the existing grid
module + the `fields` bag, mirroring the Run-of-Show `duration` precedent.

### A. Two new permit states

Add `denied` + `waived` to `PERMIT_STATUS_OPTIONS`. Final order:

| value | label | color | isComplete |
| --- | --- | --- | --- |
| `not_needed` | Not needed | gray | — |
| `to_apply` | To apply | red | false |
| `submitted` | Submitted | amber | — |
| `approved` | Approved | green | true |
| `denied` | Denied | red | false |
| `waived` | Waived | green | true |

- `denied` — the readiness guardrail keys on this value.
- `waived` — the requirement was waived, so it is genuinely done → `isComplete`.
- `PARTIAL_STATUS_VALUES` keeps `to_apply` + `submitted` only; `denied` /
  `waived` are terminal (denied = 0 credit, waived = full credit), so neither is
  a partial value.

### B. Two new columns (custom, in the `fields` bag)

Added to `DEFAULT_COLUMNS.permits`, mirroring Run-of-Show `duration`:

- `jurisdiction` — `{ key:"jurisdiction", type:"text", kind:"custom",
  label:"Jurisdiction" }` — which authority issues the permit.
- `fallback` — `{ key:"fallback", type:"longtext", kind:"custom",
  label:"If denied (fallback)" }` — the contingency plan when a permit is denied.

Both land at the tail so the canonical leading-column order test still passes.
Seed rows get a sensible `jurisdiction`; `fallback` is left empty by default
(it is the "if denied" plan, written only when needed).

### C. The readiness guardrail (load-bearing)

A permit item is a **blocker** when `status === "denied"` AND its `fallback`
field is empty/whitespace. A denied permit WITH a non-empty fallback is NOT a
blocker — the contingency exists (Eden's case). Shared helpers in
`packages/shared/src/index.ts`:

- `permitDeniedWithoutFallback(item)` — the per-item predicate.
- `countPermitBlockers(items)` — the rollup.

Wired into `events.pipeline`: one extra `statusCountsFor(ctx, eventId,
"permits")` read per event (same shape + cost as the existing `planning_doc`
read — one indexed `by_event_module` scan for items + one for the status
column), and the denied-without-fallback count is ADDED to `blockerCount`.

The denied-without-fallback permits are also surfaced so a screen can prompt for
a fallback: `events.dayOf` returns `permitsNeedingFallback` (title + id), and
the Day-of view renders a dismissible "⚠ Permit denied — write a fallback plan"
prompt listing them. The grid already lets the user edit the `fallback` cell.

### D. Migration `0020_permits_states_and_fallback` (idempotent)

1. Merge `denied` + `waived` into EVERY existing permit `status` column's
   `options` (`templateColumns` + `eventColumns`, `module === "permits"`,
   `key === "status"`): dedupe by `value`, append only if missing, preserving
   existing/author options + order. New option shapes are sourced from
   `PERMIT_STATUS_OPTIONS` so they can't drift.
2. Add `jurisdiction` + `fallback` columns to permit grids that lack them
   (mirror 0019: source from `DEFAULT_COLUMNS.permits`, tail order, skip if the
   key is present, cover template + event columns).

Registered in `migrations/index.ts` and `REGISTRY_NAMES` in
`tests/migrations.test.ts`. Re-running adds/merges nothing.

## Deferred (documented, not built)

- A dedicated `permits` table (structured jurisdiction/authority records,
  attachments, expiry dates). v1 stays on the grid + fields bag.
- PDF `DocumentPicker` upload for permit documents (today: the `document` photo
  cell).
- Richer lead-time UI (per-jurisdiction default deadlines, reminders keyed to
  the permit offset).
- A dedicated Permits screen. v1 surfaces the guardrail on Day-of + the grid.

## Reviewer notes

- **Pipeline read cost**: one added indexed read per operational upcoming event,
  identical in shape to the existing planning-doc read. No full scans.
- **Blocker semantics**: only `denied` + empty `fallback` blocks. `to_apply`
  overdue is NOT a permit blocker (unlike planning-doc, permits don't block on
  past-due-incomplete — a permit still in flight is normal). This is intentional
  and narrow: the block is "denied with no plan B".
- **Option merge preserves author customizations**: the migration appends the
  two options only when absent and never reorders or rewrites existing options.
