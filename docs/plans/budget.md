# Budget (M5.4) — a typed line-item budget for an event

**Status: building (autonomous, 2026-07-14).** Follows the Giving precedent
(typed table + bespoke tab, integer cents throughout). **Non-disruptive**: the
existing coarse header budget is left completely untouched — v1 coexists beside
it as a separate, richer surface.

## Problem

Today an event carries a single whole-USD `events.budget` number, shown in the
header with a computed `budgetSpent` / `budgetPct` (rolled up from item `cost`
fields + paid vendors). That's a headline gauge, not a plan: there's no way to
break a budget into named lines, track planned-vs-actual per line, attach a
receipt, or reconcile spend against the money that actually came IN (ticket
revenue + donations). Budget v1 adds a first-class, per-line budget.

## What v1 deliberately does NOT touch (ground truth — leave alone)

- `events.budget` (whole-USD total, `schema/events.ts`), and the computed
  `budgetSpent` / `budgetPct` (`events.ts:186-199, 229-230`), editable via
  `events.updateDetails({budget})` and shown in `EventHeader.tsx`. These stay
  exactly as-is; the new tab is additive and never writes them.
- Money-IN rollups: `eventPages.revenueCents` (tickets) +
  `eventPages.donationsCents` (giving), both integer **cents**, one `eventPages`
  row per event (index `by_event`). Budget only READS these for reconciliation.

## Design

Money is always a **non-negative integer number of cents** (mirrors
`giving.ts`). No currency field in v1 — everything is `"usd"` implicitly, same
as the header budget. The design mirrors the `donations` typed-table precedent:
a child table with a foreign key back to the event, a dedicated Convex module
(`budget.ts`), one bespoke mobile tab (`BudgetTab`), registered like Giving.

### Schema (`schema/budget.ts`, registered in `schema.ts`)

**`budgetLineItems`** — one row per budget line:
- `eventId` (`id events`), `chapterId` (`id chapters`) — tenancy + scoping.
- `label` (string) — the line name ("PA rental", "Flyers").
- `category` — `v.union` of literals: `venue` · `production` · `food` ·
  `marketing` · `permits` · `transport` · `other`.
- `plannedCents` (number) — budgeted amount (non-negative int; 0 allowed).
- `actualCents` (optional number) — what it actually cost, once known.
- `receiptStorageId` (optional `id "_storage"`) — an attached receipt image/PDF.
- `note` (optional string).
- `order` (number) — append-order for stable listing.
- `createdBy` (`id users`), `createdAt` (number).
- Index **`by_event`** (`["eventId"]`).

### Backend (`apps/convex/budget.ts` — queries + mutations, NOT `"use node"`)

All cents pass through `assertNonNegativeCents` (mirrors giving's
`assertPositiveCents`, but allows 0): rejects negatives and non-integers with a
`ConvexError({code:"INVALID_AMOUNT"})`.

- **`addLineItem`** `{eventId, label, category, plannedCents, note?}` —
  `requireEvent` (chapter-scoped); validate `plannedCents`; `order` = current
  count (append); insert with `createdBy` + `chapterId` from the event.
- **`updateLineItem`** `{lineItemId, label?, category?, plannedCents?,
  actualCents?, note?}` — `requireOwned("budgetLineItems")`; validate any cents
  present. `actualCents` and `note` accept a **null clear sentinel**
  (`v.union(v.number(), v.null())` / `v.union(v.string(), v.null())`) to unset.
- **`setReceipt`** `{lineItemId, receiptStorageId | null}` — `requireOwned`;
  patch (null clears the attachment).
- **`removeLineItem`** `{lineItemId}` — `requireOwned`; delete.
- **`budgetSummary`** `{eventId}` query — `requireEvent`; ONE `budgetLineItems`
  `by_event` read + ONE `eventPages` `by_event` read. Returns:
  - `lineItems`: rows in `order`, each with `receiptUrl` resolved via
    `ctx.storage.getUrl` (null when unset).
  - `plannedCents` = Σ `plannedCents`.
  - `actualCents` = Σ (`actualCents ?? 0`).
  - `incomeCents` = `(page?.revenueCents ?? 0) + (page?.donationsCents ?? 0)` —
    the money-IN read; **0 when there's no `eventPages` row at all.**
  - `netCents` = `incomeCents - actualCents` (money in minus money actually
    spent; positive = surplus, negative = over).

Because `budget.ts` is a NEW Convex module and codegen can't run offline, its
two lines are **hand-added** to `_generated/api.d.ts` (`import type * as budget`
+ `budget: typeof budget` in `fullApi`, alphabetically after `blasts`).

### Mobile — bespoke Budget tab

- `"budget"` is added to `RESERVED_TAB_KEYS` (`packages/shared/src/index.ts`) so
  a custom workstream can't mint it and hijack the `?tab=budget` route.
- `event/[id].tsx` routes `tab === "budget"` to `<BudgetTab eventId=… />`
  (mirrors the `tickets` branch, with a "Back to planning" affordance). It's
  surfaced from the header tools `⋯` menu (a "Budget" row next to "Event page"),
  matching how Tickets is surfaced — an operational tool, not an area tab.
- `components/event/budget/BudgetTab.tsx` (+ subcomponents):
  - A money-summary `StatCard` row: **Income / Planned / Actual / Net** via
    `formatMoney`.
  - The line-item list — each row shows label · category · planned · an inline
    dollar-edit for **actual** (`parseDollars` → cents; invalid input rejected
    via a toast) · a receipt thumbnail/attach (reuses the
    CoverPhotoPicker/PhotoCell generate-url → POST → store-storageId flow) ·
    remove (`confirmAction`).
  - An "Add line item" form: label + a category picker (`Select`) + planned
    amount. Uses `useActionRunner`/`run` with `errorTitle` toasts, matching
    `TicketingTab`.

### Access / tenancy

Every mutation + query gates through `requireEvent` / `requireOwned`
(`lib/context.ts`) → chapter-scoped to the caller's `@publicworship.life`
membership. A non-member, an unauthenticated caller, and a cross-chapter admin
are all rejected before any read/write. `chapterId` is copied from the event on
insert, so a line item can never be created under the wrong tenant.

## Deferred (documented, NOT built in v1)

- **Unifying the header budget.** The coarse `events.budget` gauge stays a
  separate headline; a later milestone can make it derive from `Σ plannedCents`
  (or offer a "use line-item total" toggle) once the line-item budget has proven
  itself. Kept apart in v1 to stay non-disruptive.
- **Recurring / templated lines** (clone a standard budget from the event
  template, like columns/items do).
- **Multi-currency** (a `currency` per line + FX). v1 is `"usd"`-only.
- **Chapter-level rollup** (budget across every event in a chapter).
- Per-line actual-vs-planned variance flags, approvals, and vendor links.
