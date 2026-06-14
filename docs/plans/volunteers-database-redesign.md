# Plan: redesign the event Volunteers section as an editable database table

**Goal.** On the event detail page, the **Volunteers** section currently renders as
a team-grouped card list (avatar + name + contact + a "Service / role" field +
team chip + status chip + "Make paid" + delete, grouped under team headers with
"Add to {team}"). The user wants it to look and feel like the app's other
**inline-editable database tables** (spreadsheet chrome: a header row of columns,
bordered rows, inline-edit cells, an add-row, optional group-by-team) — exactly
like the People directory and the planning/supplies module grids. This plan is
self-contained so it can be executed in a fresh session.

---

## 1. Project context (events-os)

- Repo: `/Users/lilseyi/Code/events-os` — pnpm monorepo. `apps/mobile` (Expo
  React Native, **web is the test target**), `apps/convex` (Convex backend),
  `packages/shared` = `@events-os/shared`.
- **Run:** Convex from repo root (`npx convex dev` — manages a LOCAL backend on
  port 3210, data in `.convex/local/...`), Expo from `apps/mobile`
  (`npx expo start --web -c`). Web app at http://localhost:8081.
- **Gotcha — blank page:** if the web app renders blank with
  `ws://127.0.0.1:3210 ... CONNECTION_REFUSED` in console, the local Convex
  backend has died. Restart `npx convex dev` from the events-os root (same
  sqlite, no data loss).
- **Gotcha — editing `packages/shared`:** Convex's `convex dev` watcher does NOT
  watch sibling workspace packages. After editing shared, `touch` a file under
  `apps/convex/` (or restart `convex dev`) to force a re-push + codegen.
- **Dev login / test data:** OTP bypass code `000000`. Superuser emails in
  `apps/convex/lib/superuser.ts`. Demo seed: `npx convex run functions/...` —
  the WWS event id used in testing is `k977nfn39x6ae93nqkthbb260n88jd5g`
  (lightweight, no volunteer_expectations); the **Eden** event
  `k978cne5h1sx77gs05r5yn8nfs88k7kz` HAS the volunteer_expectations module +
  team options (use THIS event to test volunteers — WWS has no team list).
- **UI conventions (critical):** NativeWind `className` everywhere. On
  react-native-web, a `Pressable`'s function-style `style` prop is IGNORED — put
  layout on inner `<View>`s with static className, use `active:`/`web:hover:`
  variants. Inline cell edits commit on **blur** (`onBlur`), NOT `onEndEditing`
  (which doesn't fire on RN-web). Theme tokens in `apps/mobile/lib/theme.ts`
  (`colors`). Reusable UI in `apps/mobile/components/ui/` (Avatar, OptionTag,
  Popover, TextField/Select, Icon, Badge, PersonPicker, Card, Button).

---

## 2. The data model (already built — DO NOT change the schema unless noted)

Volunteers/vendors are **engagements**: one person's involvement in one event.

- Table `engagements` (`apps/convex/schema.ts`): `chapterId, eventId, personId,
  type ("volunteer"|"paid"), team?, service?, status ("invited"|"confirmed"|
  "declined"), callTime?, responsibilities?, amountUsd?, paymentStatus?
  ("unpaid"|"invoiced"|"paid"), notes?, createdAt`. Indexes `by_event`,
  `by_event_type`, `by_person`, `by_chapter`.
- Backend `apps/convex/engagements.ts`:
  - `listForEvent({ eventId, type? })` → rows joined with person:
    `{_id, eventId, personId, type, team?, service?, status, callTime?,
    responsibilities?, amountUsd?, paymentStatus?, notes?,
    person: { _id, name, email, phone, skills } | null }`.
  - `add({ eventId, personId, type, team?, service?, amountUsd? })`
  - `update({ engagementId, type?, team?, service?, status?, callTime?,
    responsibilities?, amountUsd?, paymentStatus?, notes? })` (null clears a field;
    flipping `type` volunteer↔paid auto-seeds/clears payment fields)
  - `remove({ engagementId })`
  - `historyForPerson`, `paidTotalForEvent` (budget rollup — leave as-is).
- **Teams** for an event = the `options` of the `team` SELECT column on the
  `volunteer_expectations` module. Get them via
  `useQuery(api.items.listForEventModule, { eventId, module: "volunteer_expectations" })`
  → `.columns.find(c => c.key === "team")?.options` (array of `{value,label,color}`).
  An event with no volunteer_expectations module has no team list (treat as
  "Unassigned"-only).
- People roster for the add-picker: `api.people.list` (PersonPicker loads this
  itself). Owners/leads use `api.people.teamMembers`; volunteers can be ANY person.

---

## 3. Current implementation to replace

- `apps/mobile/components/event/CrewSections.tsx` — exports
  `CrewSections({ eventId })`, rendered near the bottom of
  `apps/mobile/app/(app)/event/[id].tsx`. It renders TWO sections:
  - **Volunteers** (`listForEvent type:"volunteer"`) grouped by team, each row a
    pill-card (Avatar, name, contact line, inline `service` TextField, a Team
    chip Popover, a status chip cycling invited→confirmed→declined, "Make paid →"
    [update type:"paid"], remove). "Add to {team}" per group + a top "Add
    volunteer" (PersonPicker → add).
  - **Vendors (paid)** (`listForEvent type:"paid"`) — similar but with an inline
    `$` amount field, a payment-status chip (unpaid→invoiced→paid), "Make
    volunteer →", and a "Committed: $X" subtotal.
  - The team options come from `api.items.listForEventModule(volunteer_expectations)`.
- Keep the **Vendors** section roughly as-is for now (the redesign is about
  Volunteers) — but consider making it a sibling table for consistency (see §6).

---

## 4. Reference implementations to mirror (the "database" look)

1. **People directory table** — `apps/mobile/app/(app)/(tabs)/people.tsx`. This
   is the closest pattern: a spreadsheet-style table NOT backed by the
   unified-items model. Study it directly:
   - `const COLS = {...}` fixed pixel widths; `TABLE_WIDTH` sum; horizontal
     `<ScrollView>` so columns keep fixed widths on web.
   - `HeaderCell({label,width})` (uppercase muted header), `Cell({width,children})`
     (bordered cell), `InlineText` (controlled input, commits on blur), select
     cells rendered as `OptionTag` opening a `Popover` (see `VettingCell`,
     `RateCell`, `SkillsCell`), an "Add person" add-row at the bottom, a delete
     gutter, and a detail modal on name click.
   - The Usual-rate cell shows a green "Volunteer" tag when 0 — example of a
     custom cell renderer.
2. **Module EditableGrid** — `apps/mobile/components/grid/EditableGrid.tsx` +
   `cells.tsx`. The canonical editable grid with **group-by** support (the
   `groupBy`/`groups` logic + group header rows), drag handles, add-row,
   column menu. Use its group-by treatment as the model for grouping volunteers
   by team (group header = the team OptionTag + count, rows beneath).

The new Volunteers table should reuse the **People-table chrome** (it's already a
hand-rolled table over a non-items query, which is exactly our situation) and the
**EditableGrid group-by** visual for the team grouping.

---

## 5. Redesign spec — Volunteers as a database table (FLAT, with a Team column)

Replace the team-grouped card list with a **flat, sortable table** (NOT grouped by
default — team is just a column you can sort by). Columns (left→right):

| Column | Cell | Edit → mutation |
|---|---|---|
| **Name** | Avatar (initials) + editable person name; click name → person detail modal (reuse People-tab detail / `engagements.historyForPerson`) | **editable** → `api.people.update({ personId, name })` (see PERSON-EDIT note) |
| **Email** | inline text | **editable** → `api.people.update({ personId, email })` |
| **Phone** | inline text | **editable** → `api.people.update({ personId, phone })` |
| **Team** | OptionTag of the engagement's team (color from the team option); tap → Popover of the event's team options + "No team" | `engagements.update({ engagementId, team })` |
| **Service / role** | inline text | `engagements.update({ service })` on blur |
| **Status** | OptionTag chip cycling invited→confirmed→declined (gray/green/red) | `engagements.update({ status })` |
| **Call time** | inline text | `engagements.update({ callTime })` |
| **Responsibilities** | inline longtext | `engagements.update({ responsibilities })` |
| **Type** | "Make paid →" affordance | `engagements.update({ type:"paid" })` → row moves to the Vendors table |
| (delete gutter) | trash | `engagements.remove({ engagementId })` |

**PERSON-EDIT note (IMPORTANT, user decision):** Name/Email/Phone are fields on
the shared `people` record, NOT on the engagement. Editing them here updates the
person **everywhere** — every event they're engaged in AND the People directory.
Surface this clearly: e.g. a one-line muted caption under the table header like
"Editing name, email or phone changes this person across the whole app," and/or a
small info icon on those columns. Because the same person can have multiple
engagement rows (one per team), editing the name in one row will reactively
update all their rows — that's expected.

Behavior:
- **Flat table, sortable.** Default sort by Team (so teammates cluster), but it's
  a normal column — allow sorting by Name/Team/Status (header click toggles
  sort). Do NOT render team group-header bands; the Team column conveys it. (The
  EditableGrid group-by is still a fine reference for the chrome, just don't use
  its grouped layout.)
- The same person can appear in multiple rows (one engagement per team) — keep that.
- **Add volunteer:** a top "Add volunteer" button + a bottom add-row, both open
  the PersonPicker → `engagements.add({ eventId, personId, type:"volunteer" })`
  (no team; set the Team cell after). Drop the per-team "Add to {team}" affordance.
- Inline edits commit on blur; selects via Popover — match the People-table cells.
- Horizontally scrollable on web (fixed `COLS` like People).
- Empty state: "No volunteers yet — use Add volunteer."

## 5b. Redesign spec — Vendors (paid) as a matching table (USER: yes, redesign it)

Render Vendors with the SAME table chrome, type `"paid"`. Columns: **Name**
(editable → people.update, same PERSON-EDIT note), **Email**, **Phone**,
**Service**, **Amount** (`$` numeric → `engagements.update({ amountUsd })`),
**Payment** (OptionTag chip cycling unpaid→invoiced→paid →
`engagements.update({ paymentStatus })`), **Status** (invited/confirmed/declined),
**Type** ("Make volunteer →" → `update({ type:"volunteer" })` moves row to the
Volunteers table), delete gutter. Footer row: **"Committed: $X"** = sum of
`amountUsd` (matches the existing subtotal). The budget rollup
(`events.get` via `paidTotalForEvent`) is unchanged — no backend edit.

Lay the two tables out as two stacked sections ("Volunteers" / "Vendors (paid)")
on the event page, each with its own header + add button, replacing the current
`CrewSections` card UI.

---

## 6. Approach & files

- **New component** `apps/mobile/components/event/CrewTable.tsx` (or rewrite
  `CrewSections.tsx`): build the table chrome by copying the People-table helpers
  (COLS/TABLE_WIDTH/HeaderCell/Cell/InlineText/OptionTag-Popover select cells/
  add-row/delete gutter) and the EditableGrid group-by visual. Back it with the
  existing `engagements` queries/mutations (NO backend change needed; everything
  required is already in `engagements.ts` and the team-options query).
- **Mount point unchanged:** `apps/mobile/app/(app)/event/[id].tsx` already
  renders `<CrewSections eventId=... />`; swap in the new component there.
- **No schema/backend changes expected.** If a "callTime"/"responsibilities"
  column is wanted and not already surfaced, they already exist on the engagement
  + `update` supports them — just add the columns.
- Keep the existing optimistic-update / reactive patterns; engagements list is a
  reactive `useQuery`, so edits reflect immediately.

---

## 7. Verification (web)

1. Open the **Eden** event (`/event/k978cne5h1sx77gs05r5yn8nfs88k7kz`) — it has
   team options. Scroll to the Volunteers table.
2. Confirm header row + columns, group-by-team headers with counts + "Add to
   {team}", inline-editable Service cell (type + blur persists), Team/Status
   Popover selects, delete, and "Add volunteer".
3. "Make paid" moves a row from Volunteers to the Vendors table.
4. `pnpm --filter @events-os/mobile exec tsc --noEmit` passes.

---

## 8. Decisions (resolved with the user)

- **Vendors:** redesign it too, as a matching table (see §5b).
- **Layout:** a FLAT, sortable table with a **Team column** (no team group-header
  bands).
- **Name/contact editable here:** yes — but they edit the shared `people` record,
  so the UI must warn that the change applies to this person **everywhere** (every
  event + the People directory). See the PERSON-EDIT note in §5.

### Remaining nits (decide while building)
- Which columns are visible by default vs optional (Call time / Responsibilities
  could be hidden by default to keep the table compact).
- Person detail modal: reuse the People-tab detail component if cleanly
  extractable, else a lightweight read-only modal.
