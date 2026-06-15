# Plan: configurable roles & modules + the "How-To" field type

**Goal.** Make the template editor fully configurable and add a rich "How-To"
field. Four changes, decided together:

1. **Roles aren't set in stone** — let people add, rename, **and remove** roles
   (add/rename already exist; removal is the gap).
2. **Rename "Components" → "Modules"** to match the language used when people
   fill modules out, and collapse the duplicate `COMPONENT_*` / `MODULE_*`
   constants into one set.
3. **Drop "core vs larger events"; use "core vs custom"** — let people create
   their own **custom modules**, which behave exactly like core modules (full
   inline-editable grid).
4. **Per-module owner is a stored role**, not a hardcoded map — each module
   (core or custom) carries an owner role editable in the template editor.
5. **New "How-To" field type** — a `how_to` column that links to a standalone
   **doc** that can be an external link, a YouTube/Dropbox video, a short note,
   or a full **markdown page** that is editable, AI-assistable, **opens natively
   as its own screen, and is shareable on its own URL**.
6. **Site map becomes a core (platform) module** — appears in the modules list,
   toggleable per template/event like other core modules (it's a non-grid
   "surface"), and each module in an event can be **marked "ready"** while
   editing.

**Decisions already locked** (so a fresh session doesn't re-litigate):
- **Scoping model (decided):** three layers on the codebase's existing
  clone-on-create pattern (template → event, like `templateColumns`→
  `eventColumns`):
  - **Platform** — **core modules** are platform-wide built-ins, available to
    every template/event. Toggleable per template, **never deletable**. New core
    modules auto-propagate everywhere.
  - **Template** — owns its **roles** and its **custom modules**, and records
    which core modules are toggled off + any per-core owner/label override. This
    is the default config events inherit.
  - **Event** — created from a template, **clones** that role + module config,
    then can independently **add or remove any module or role** (re-enable a core
    module the template disabled, add a brand-new custom module/role, etc.).
- **Module owner is stored as a role _key_ (string)**, resolved against the roles
  in the same scope — survives the template→event clone without dangling ids.
- How-To is a **field type only** (a column you add to any module's grid), not a
  whole-module type.
- Custom modules get the **full grid** (same `EditableGrid` + configurable
  columns as core modules).
- Markdown editor = **CodeMirror 6, Obsidian-style live preview** (body stays
  literal markdown). See Phase 4.
- **Roles (decided):** all roles are **template-owned and fully deletable** — the
  defaults (Event Lead, Comms Lead, …) are just starting seeds copied into each
  new template, with **no platform layer**. (Only *core modules* are
  platform-wide/undeletable; roles are not.)
- This document is the deliverable; **implementation has not started.**

This plan is self-contained so it can be executed in a fresh session.

---

## 1. Project context (events-os)

- Repo: `/Users/lilseyi/Code/events-os` — pnpm monorepo. `apps/mobile` (Expo
  React Native, **web is the test target**), `apps/convex` (Convex backend),
  `packages/shared` = `@events-os/shared`.
- **Run:** Convex from repo root (`npx convex dev` — LOCAL backend on port 3210),
  Expo from `apps/mobile` (`npx expo start --web -c`). App at
  http://localhost:8081.
- **Gotcha — editing `packages/shared`:** Convex's `convex dev` watcher does NOT
  watch sibling workspace packages. After editing shared, `touch` a file under
  `apps/convex/` (or restart `convex dev`) to force a re-push + codegen.
- **Dev login:** OTP bypass `000000`. Superuser emails in
  `apps/convex/lib/superuser.ts`.
- **UI conventions:** NativeWind `className` everywhere. On react-native-web a
  `Pressable`'s function-style `style` prop is IGNORED — put layout on inner
  `<View>`s with static className + `active:`/`web:hover:` variants. Inline cell
  edits commit on **blur** (`onBlur`), not `onEndEditing`. Theme tokens in
  `apps/mobile/lib/theme.ts`. Reusable UI in `apps/mobile/components/ui/`.

---

## 2. Current state (what exists today)

The domain model is almost entirely **hardcoded constants** in
`packages/shared/src/index.ts`; the Convex backend stores everything as loose
strings/arrays and validates none of it. Enforcement + the core/larger split +
ownership all live on the mobile frontend.

**Roles — already DB-backed and editable.**
- Table `roles` (`apps/convex/schema.ts:115`): `{ chapterId, key, label,
  description?, order, isArchived? }`.
- CRUD `apps/convex/roles.ts`: `list` (filters `isArchived !== true`), `create`,
  `update` (rename), `reorder`, `archive` (soft delete).
- Default seed list `DEFAULT_ROLES` (`packages/shared/src/index.ts:33`):
  `event_lead, comms_lead, logistics_lead, production_lead`.
- Template references a subset via `eventTypes.activeRoleIds`
  (`schema.ts:142`). There is **no isActive flag** on roles; active = membership
  in that array.
- UI `RolesCard` in `apps/mobile/app/(app)/template/[id].tsx` (~L204-312): toggle,
  inline rename (`api.roles.update`), Add role (`api.roles.create`). **No delete
  button** — `archive` is unused by the UI. That is the only roles gap.

**Modules / Components — hardcoded, with a core/larger split.**
- `MODULE_KEYS` and `COMPONENT_KEYS` (`index.ts:82`, `:132`) are **two names for
  the same 7 keys**: `planning_doc, supplies, comms, run_of_show, permits, retro,
  volunteer_expectations`. Labels in `MODULE_LABELS` / `COMPONENT_LABELS`.
- The split is hardcoded: `CORE_COMPONENTS` (6) + `LARGER_EVENT_COMPONENTS`
  (`["volunteer_expectations"]`) at `index.ts:143` / `:152`.
- Template stores selected modules as `eventTypes.activeComponents:
  v.array(v.string())` (`schema.ts:142`). Backend treats them as opaque strings.
- UI `ComponentsCard` / `ComponentGroup` in `template/[id].tsx` (~L316-370)
  renders "Components" with "Core" / "Larger events" groups.

**Module ownership — hardcoded map, frontend-only.**
- `MODULE_OWNER_ROLE_KEY: Record<ModuleKey, string>` (`index.ts:113`) maps each
  module to a default role key. Resolved only in
  `apps/mobile/app/(app)/event/[id].tsx:161` against `roleAssignments`. Zero
  backend consumers. (Rows also carry a per-row `roleId` + event-side
  `ownerPersonId` override.)

**Field types — enumerated, stored as a `column.type` string.**
- `COLUMN_TYPES` (`index.ts:170`): `text, longtext, select, multiselect, status,
  number, currency, date, url, photo, person, role, offset_days, offset_minutes,
  due_date`.
- Columns are rows in `templateColumns` / `eventColumns` (`schema.ts:155`/`:206`)
  shaped by `columnFields` (`schema.ts:38`): `{ module, key, label,
  kind: "system"|"custom", type: v.string(), options?, config?, isVisible, order,
  width? }`. Item field values live in `itemFields.fields:
  v.record(v.string(), v.any())` (`schema.ts:52`).
- Per-module default columns: `DEFAULT_COLUMNS: Record<ModuleKey, ColumnDef[]>`
  (`index.ts:330`), materialized by `seedModuleColumns`
  (`apps/convex/lib/templates.ts:45`). Column CRUD in `apps/convex/columns.ts`
  (`addColumn`/`updateColumn`/`removeColumn`).
- **Render dispatcher:** `GridCell` `switch(column.type)` in
  `apps/mobile/components/grid/cells.tsx` (~L472). Grid host
  `apps/mobile/components/grid/EditableGrid.tsx` (has `ADDABLE_TYPES`), data
  adapter `useGridData.ts`.

**AI spine — present (OpenRouter, free models).**
- `apps/convex/ai.ts` (run lifecycle, threads, revertible writes),
  `apps/convex/aiActions.ts` (`"use node"`, `openRouterCall` at L183 reading
  `OPENROUTER_API_KEY`, `runAssistant` agent loop, `autofillItem`). Models +
  budgets in `packages/shared/src/ai.ts` (all `:free` slugs,
  `DEFAULT_AI_MODEL = "openai/gpt-oss-120b:free"`).
- UI `apps/mobile/components/ai/AiAssistantPanel.tsx` (Notion-style floating
  panel), mounted only on `event/[id].tsx:550`.

**Sharing / public pages — one pattern exists.**
- `apps/mobile/app/share/[id].tsx` (`ShareCrewScreen`) lives **outside** the
  `(app)`/`(auth)` route groups → not behind the auth guard. Renders read-only
  from a no-auth Convex query (`api.events.publicCrew`).
- Scheme `eventsos` (`app.config.js:7`, Android intent filter L35-42). Web share
  URL built as `window.location.origin + "/share/<id>"`.
- **No markdown renderer/editor anywhere** — net-new dependency.

---

## 3. Target data model

**Shape of the change.** Roles and (custom) modules stop being chapter-wide
constants/rows and become **template-scoped rows that clone into the event** on
event creation — exactly how `templateColumns`/`templateItems` already clone into
`eventColumns`/`eventItems`. Core modules stay **platform-wide constants** so new
ones auto-propagate; templates and events store only *deltas* against them
(toggled-off + owner/label overrides).

### 3.1 Core modules stay platform-wide constants

Keep the core module definitions in `packages/shared` (not in any table), so a new
core module instantly becomes available to every template/event. Reshape the
existing constants into one registry:

```ts
// packages/shared/src/index.ts  (built from today's MODULE_*/DEFAULT_COLUMNS/
// MODULE_OWNER_ROLE_KEY/offset lists)
export const CORE_MODULES: CoreModuleDef[] = [ /* planning_doc, run_of_show,
  comms, permits, supplies, retro, volunteer_expectations, site_map */ ];
// CoreModuleDef = {
//   key, label, defaultOwnerRoleKey,
//   surface: "grid" | "site_map",          // how the module renders
//   offsetMode: "none"|"days"|"minutes",   // grid modules only
//   defaultColumns: ColumnDef[],           // grid modules only
// }
```

- The old `CORE_COMPONENTS` / `LARGER_EVENT_COMPONENTS` split is deleted;
  `volunteer_expectations` simply becomes a core module like the rest.
- **`surface` discriminator (new).** Existing modules are `surface:"grid"` (render
  via `EditableGrid`). **`site_map` is a core module with `surface:"site_map"`** —
  it has no columns/grid; it renders the existing venue-map editor. This is what
  lets the site map appear in the modules list and be toggled per template/event
  like any other core module, while keeping its bespoke editor. Custom modules are
  always `surface:"grid"`.
- **Site map data is unchanged.** It already lives event-scoped in `siteMarkers` /
  `siteShapes` / `siteMapPlacements` + `events.siteMapImage`. Becoming a core
  module only adds it to the registry + the toggle/active-list logic + render
  routing; no site-map schema change. Default owner role: `logistics_lead`.

### 3.2 Roles → template-scoped, cloned to events

Replace the chapter-scoped `roles` table with the template/event pair:

```ts
// apps/convex/schema.ts
templateRoles: defineTable({
  eventTypeId: v.id("eventTypes"),
  key: v.string(),                 // stable handle (toKey(label))
  label: v.string(),
  description: v.optional(v.string()),
  order: v.number(),
  isArchived: v.optional(v.boolean()),
}).index("by_template", ["eventTypeId"])
  .index("by_template_key", ["eventTypeId", "key"]),

eventRoles: defineTable({
  eventId: v.id("events"),
  key: v.string(),
  label: v.string(),
  description: v.optional(v.string()),
  order: v.number(),
}).index("by_event", ["eventId"])
  .index("by_event_key", ["eventId", "key"]),
```

- `templateRoles` seeded from `DEFAULT_ROLES` on template creation; fully
  add/rename/delete/reorder per template.
- `eventRoles` cloned from `templateRoles` on event creation; independently
  editable (this is how an event adds/removes roles the template didn't have).
- `roleAssignments.roleId` (`schema.ts:234`) repoints to **`eventRoles`**
  (migration).
- `eventTypes.activeRoleIds` is **removed** — a template's roles *are* its
  `templateRoles` rows (no separate active subset). Same for the event.

### 3.3 Custom modules → template/event rows; core state → deltas

Custom modules mirror the roles pair; core module state is stored as deltas on the
template and event.

```ts
// apps/convex/schema.ts
templateModules: defineTable({       // CUSTOM modules only
  eventTypeId: v.id("eventTypes"),
  key: v.string(),
  label: v.string(),
  ownerRoleKey: v.optional(v.string()),     // resolves against templateRoles
  offsetMode: v.optional(v.union(
    v.literal("none"), v.literal("days"), v.literal("minutes"))),
  order: v.number(),
  isActive: v.optional(v.boolean()),        // toggle within the template
}).index("by_template", ["eventTypeId"])
  .index("by_template_key", ["eventTypeId", "key"]),

eventModules: defineTable({          // CUSTOM modules only, cloned + editable
  eventId: v.id("events"),
  key: v.string(), label: v.string(),
  ownerRoleKey: v.optional(v.string()),     // resolves against eventRoles
  offsetMode: v.optional(v.union(
    v.literal("none"), v.literal("days"), v.literal("minutes"))),
  order: v.number(),
}).index("by_event", ["eventId"]),
```

Core-module deltas live on the parent rows (remove old `activeComponents`):

```ts
// added to eventTypes AND events:
disabledCoreModules: v.optional(v.array(v.string())),     // core keys toggled off
coreModuleOverrides: v.optional(v.array(v.object({        // per-core tweaks
  key: v.string(),
  label: v.optional(v.string()),
  ownerRoleKey: v.optional(v.string()),
}))),
```

**Resolving the active module list** (one helper in shared, used by both editor
and event screen):
```
activeModules(scope) =
  CORE_MODULES.filter(m => !scope.disabledCoreModules.includes(m.key))
              .map(m => applyOverride(m, scope.coreModuleOverrides))   // platform core
  ++ customModules(scope).filter(isActive)                            // template/event rows
```
- Custom module **columns** continue to live in `templateColumns`/`eventColumns`
  keyed by the module string `key` (no FK change). Core columns come from
  `CORE_MODULES[*].defaultColumns`, materialized into columns on first use (reuse
  `seedModuleColumns`).
- Custom modules get a generic starter column set (`DEFAULT_CUSTOM_COLUMNS`:
  Title/Status/Owner/Notes) on create.
- Event clone: copy `templateModules`→`eventModules` and
  `disabledCoreModules`/`coreModuleOverrides` onto the event; thereafter the event
  edits its own copies (re-enable a disabled core, add a custom module, etc.).

**Module readiness (event-only — "mark as ready").** Each module in a *running
event* can be marked ready by whoever's editing it. Templates are blueprints, so
readiness is event-scoped only — stored as a delta on `events`:

```ts
// added to events (NOT eventTypes):
moduleReadiness: v.optional(v.array(v.object({
  key: v.string(),                       // module key (core or custom)
  ready: v.boolean(),
  markedBy: v.optional(v.id("people")),
  markedAt: v.optional(v.number()),
}))),
```

- This is a **per-module** flag, distinct from the existing whole-event
  `events.status` (`planning|ready|completed|cancelled`) — don't conflate them.
  (Optional follow-up: derive event "ready" from all modules being ready.)
- The mechanism is generic (works for any module key), but the **first/primary
  consumer is the site map** — the user asked to mark it ready while editing. The
  "Mark ready" toggle lives on each module's section header in the event, so it
  trivially extends to grid modules later.

### 3.4 New `docs` table (backs the How-To field)

Every How-To cell points at a doc row, so each how-to has its own identity and
share URL — even a bare link.

```ts
// apps/convex/schema.ts
docs: defineTable({
  chapterId: v.id("chapters"),
  kind: v.union(                          // how the doc renders
    v.literal("link"),                    // external page
    v.literal("video"),                   // youtube/dropbox/etc.
    v.literal("note"),                    // short inline text
    v.literal("markdown")),               // full editable page
  title: v.string(),
  url: v.optional(v.string()),            // link/video
  body: v.optional(v.string()),           // note/markdown source
  shareId: v.string(),                    // short public slug (unauth route)
  // provenance for the markdown editor / AI:
  createdBy: v.id("people"),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index("by_chapter", ["chapterId"])
  .index("by_share", ["shareId"]),
```

- The `how_to` cell value (in `itemFields.fields[colKey]`) stores the
  `Id<"docs">`. Resolution = one extra query keyed by id.
- Video kind: detect youtube/dropbox in the UI for the right embed/thumbnail
  (Dropbox uses `?raw=1`, per the togather video-handling notes).

### 3.5 New `how_to` column type

Add `"how_to"` to `COLUMN_TYPES` (`index.ts:170`), add to `ADDABLE_TYPES`
(`EditableGrid.tsx`), and add a `case "how_to"` to the `GridCell` switch
(`cells.tsx`) rendering a `HowToCell`.

---

## 4. Phased build order

Each phase is shippable on its own and has its own PR. Phases 2 and 3 carry the
migrations; do each migration in the same PR as its schema change.

### Phase 1 — Modules rename + `CORE_MODULES` registry (no schema, no migration)
Low-risk groundwork — pure shared + label cleanup.
- `packages/shared/src/index.ts`: collapse `COMPONENT_*` into `MODULE_*` (delete
  the duplicate aliases). Build the `CORE_MODULES` registry (§3.1) from today's
  `MODULE_LABELS` / `DEFAULT_COLUMNS` / `MODULE_OWNER_ROLE_KEY` / offset lists.
  Delete `CORE_COMPONENTS` + `LARGER_EVENT_COMPONENTS`; fold
  `volunteer_expectations` into `CORE_MODULES`. Add an `activeModules(scope)`
  helper (works off the soon-to-exist delta fields; until then it can read the
  legacy `activeComponents`).
- `template/[id].tsx` + `templates.tsx`: section header "Components"→"Modules";
  group headings "Core" / "Larger events" → **"Core" / "Custom"** (Custom group
  empty until Phase 3).

### Phase 2 — Roles: template- & event-scoped, full CRUD (migration)
- Add `templateRoles` + `eventRoles` (§3.2); new `apps/convex/roles.ts` CRUD
  scoped by `eventTypeId` / `eventId` (`list`, `create`, `update`, `delete`,
  `reorder`).
- Seed `templateRoles` from `DEFAULT_ROLES` on template create; clone
  `templateRoles`→`eventRoles` on event create.
- **Migration:** for each `eventType`, create `templateRoles` from the chapter
  roles in its old `activeRoleIds`; for each `event`, create `eventRoles` (from
  its template's roles ∪ roles referenced by its `roleAssignments`) and repoint
  `roleAssignments.roleId` → the new `eventRoles` id. Then drop the chapter
  `roles` table and `eventTypes.activeRoleIds`.
- Template editor `RolesCard`: add/rename/**delete**/reorder on `templateRoles`
  (no more active-vs-pool distinction — the list *is* the template's roles).
- **Event editor (new):** the same roles UI on `eventRoles` so an event can
  add/remove roles independently.

### Phase 3 — Modules: custom rows + core deltas + stored owner + site map + readiness (migration)
- Add `templateModules` + `eventModules` + `disabledCoreModules` /
  `coreModuleOverrides` on `eventTypes` and `events`, plus `moduleReadiness` on
  `events` (§3.3). New `apps/convex/modules.ts` CRUD for custom modules +
  `toggleCoreModule` / `setModuleOwner` / `setModuleReady` (write deltas).
  `DEFAULT_CUSTOM_COLUMNS` + reuse `seedModuleColumns` for new custom modules.
- **Register the site map as a core module.** Add `site_map`
  (`surface:"site_map"`, owner `logistics_lead`) to `CORE_MODULES`. **Render
  routing** in the event screen (and template editor): switch on
  `module.surface` — `"grid"` → `EditableGrid` (today's behavior), `"site_map"` →
  the existing venue-map editor (lift the body of `event/[id]/site-map.tsx` into a
  reusable component rendered inline as the module's section; the standalone route
  can stay as a deep-link target). In the template editor, `site_map` is just a
  toggle chip (no grid/columns to configure).
- **Module readiness.** Each module's section header in the *event* gets a "Mark
  ready" / "Ready ✓" toggle calling `setModuleReady({ eventId, key, ready })`.
  Wire it on the site map first (the explicit ask); it works for grid modules too
  since it keys off the module, not the surface.
- **Migration:** convert each `eventTypes.activeComponents` → set
  `disabledCoreModules = PRIOR_CORE_KEYS − activeComponents`, where
  `PRIOR_CORE_KEYS` is the *old* 7-key set (NOT including `site_map`). This is the
  general rule for introducing any new core module: it's absent from existing
  `disabledCoreModules`, so it **defaults to enabled** everywhere (site map turns
  on for all existing templates/events; empty until used, and disable-able).
  Clone the same deltas onto existing events; drop `activeComponents`.
- Replace the frontend `MODULE_OWNER_ROLE_KEY` lookup (`event/[id].tsx:161`) with
  the resolved owner: core default (or override) / custom `ownerRoleKey`,
  resolved against the scope's roles.
- Template editor: **Core** modules (toggle off, rename, owner-role picker via
  override) + **Custom** modules ("+ Add module", rename, delete, owner picker,
  full grid). Event editor: same, plus re-enabling a template-disabled core and
  adding event-only custom modules. The event fill-out already iterates active
  modules + `EditableGrid`, so custom modules render for free once active.

### Phase 4 — How-To field type (the big one)
- **Shared:** add `"how_to"` to `COLUMN_TYPES`; add to `ADDABLE_TYPES`.
- **Backend:** `apps/convex/docs.ts` — `create`, `update`, `get`, and a no-auth
  `getPublic({ shareId })`; `shareId` generated server-side (short nanoid-style;
  remember `Math.random` is fine in Convex functions, not in scripts).
- **Cell:** `HowToCell` in `cells.tsx` — empty state = "+ Add How-To" opening a
  kind picker (Link / Video / Note / Markdown). Link/Video = inline URL field +
  open-out icon. Note = short text. Markdown = title + "Open" → navigates to the
  doc screen.
- **Markdown editor — Obsidian-style live preview (CodeMirror 6).** Decided: a
  source-first editor where `docs.body` is *always literal markdown* and CM6
  view-only decorations format-as-you-type — styling text and **hiding** the
  syntax marks (`##`, `**`) on lines the cursor isn't on, **revealing** them when
  the cursor enters the line (the Obsidian feel). Reference implementation:
  `kenforthewin/atomic-editor` (`AtomicCodeMirrorEditor`, a React CM6 component).
  - **CM6 is DOM-based**, so split by platform (events-os is web-first):
    - `MarkdownEditor.web.tsx` — mount the CM6 React component directly (RN-web is
      React DOM, so a plain React DOM component renders inside the Expo web tree).
    - `MarkdownEditor.native.tsx` — host the **same CM6 bundle inside a
      `react-native-webview`**, message-bridged (text in / change events out).
      This is the one net-new native dep; CM6 itself is pure web JS in the
      WebView, so no `runtimeVersion`/native-module concern.
  - Deps: `codemirror` + `@codemirror/{state,view,commands,lang-markdown,...}`
    (web), `react-native-webview` (native). Language grammars for fenced code are
    optional peers — add only if we want code highlighting.
- **Native doc screen:** `apps/mobile/app/(app)/doc/[id].tsx` (authed, editable)
  — title + the `MarkdownEditor`, an **AI "Generate / Improve"** action, and a
  **Share** button (copies `/doc/<shareId>`).
- **Public share screen:** `apps/mobile/app/doc/[shareId].tsx` **outside** the
  `(app)`/`(auth)` groups (mirror `share/[id].tsx`): `headerShown:false`, reads
  `api.docs.getPublic`, **read-only render** of the markdown (separate from the
  editor — a lightweight markdown→view renderer is fine here, or the same CM6 in
  read-only/no-edit mode for visual consistency), or redirect for link & video.
  `eventsos://doc/<shareId>` deep link works via the existing scheme.
- **AI:** add `generateDoc({ docId, prompt })` / `improveDoc` to
  `aiActions.ts`, reusing `openRouterCall` + the free-model registry. A single
  one-shot generate/improve is enough — no need for the full `runAssistant`
  tool loop for a single markdown body. Stream into `docs.body` via an internal
  mutation; reuse `aiRuns`/`aiUsage` budget tracking.

---

## 5. Risks & notes

- **Two migrations, both risky (Phases 2 & 3).** Roles re-scope (chapter
  `roles` → `templateRoles` + `eventRoles`, repoint `roleAssignments.roleId`) and
  modules (`activeComponents` → `disabledCoreModules` deltas + clone onto events).
  Each runs in the same PR as its schema change; verify every template/event
  still resolves the same roles + active modules before dropping old fields. The
  roles migration is the trickiest because `roleAssignments` already references
  the old ids in production.
- **Key stability:** keep module/role `key` stable across rename so
  `templateColumns.module` / `eventColumns.module` (string), `itemFields.fields`,
  and `ownerRoleKey` references keep resolving. Only `label` changes on rename.
- **Owner-by-key, not by-id:** modules store `ownerRoleKey` (string), resolved
  against roles in the *same scope* (template owner → `templateRoles`, event owner
  → `eventRoles`). This is what lets a module's owner survive the template→event
  clone without a dangling id.
- **Sharing scope:** `docs.getPublic` is unauthenticated by `shareId` — treat
  `shareId` as a capability (unguessable), same trust model as the existing
  `share/[id]` crew page. Don't leak chapter data beyond the doc.
- **No backend validation of `type` today** — adding `how_to` to the shared
  union is enough; optionally tighten `columns.ts` to validate against
  `COLUMN_TYPES`.
- **AI budgets** already exist (`AI_BUDGETS`, `overBudgetScope`) — doc generation
  must go through the same `startRun`/`logUsage`/budget gate.
- **CM6 editor is the heaviest new piece.** Web is trivial (direct React
  component); the native `react-native-webview` host (RN↔CM6 message bridge,
  iOS momentum-scroll quirks the reference repo already addresses) is the real
  work. Mitigation: build + verify the web editor first (web is the test
  target), land the native WebView host as a follow-up within Phase 4 — the
  markdown body is identical on both, so the public share page and AI generation
  don't block on it.

---

## 6. Out of scope (explicitly not doing)

- How-To as a whole-module type (decided: field type only).
- Doc-only / author-choose custom module shapes (decided: full grid only).
- Real-time collaborative editing of markdown docs.
- Versioning/history of docs beyond `updatedAt`.
