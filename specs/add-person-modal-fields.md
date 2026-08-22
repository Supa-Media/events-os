# Feature: Add Person modal captures the full roster profile

## Feature Description
Replace the People tab's "Add person" instant-stub-create with a real "Add
person" modal. First name stays the only required field; every other
column on the `people` table (contact, role/org, services, status,
location/referral, volunteer/marketing flags, notes) becomes fillable at
creation time, organized so the common case (name + contact) stays a
four-field form and everything else lives behind a single "More details"
disclosure — never a wall of inputs.

## User Story
As a chapter admin adding someone to the roster
I want to fill in the fields I already know (role, services, status,
location, how they heard about us, …) in one guided form when I add them
So that I don't have to create a blank "New person" stub and then hunt
through narrow grid cells one at a time to fill it in

## Problem Statement
Today, clicking "+ Add person" (`apps/mobile/app/(app)/(tabs)/people.tsx`
`handleAddRow`) calls `people.create` with nothing but a hardcoded
`name: "New person"`, then opens the person-detail sheet
(`PersonDetail`/`PersonDetailBody`) on the freshly-created stub. That sheet
displays "Name" (First/Last), "Details" (Location, How they heard about us,
Marked as volunteer), "Marketing", history, and known-emails sections — but
it does **not** expose Email, Phone, Role/Title, Company, PW Email, Status,
Vetting, Gender, Services, Usual rate, Manager, POC, Involvements, Comms
preferences, Social link, or Notes. Those are editable only via the grid's
narrow inline cells, one row and one cell at a time, which is what the
founder is calling unintuitive. There is also no way to set any of this
*before* the stub row is created and briefly visible to everyone else
viewing the roster.

## Solution Statement
Build a dedicated `AddPersonModal` that gathers input **before** creating
the person (no more blank "New person" stub), following the same modal
chrome and disclosure conventions this codebase already uses
(`apps/mobile/components/team/AddResponsibilityModal.tsx` for the
Modal/header/footer shell, `apps/mobile/components/ui/Field.tsx`'s
`TextField`/`Select`, `Switch`, `ServiceOptionsPicker`, and `PersonPicker`
for the actual field controls — no new form primitives). First/Last/Email/
Phone stay always visible (the four fields almost every add needs); every
other column sits behind one "More details" disclosure, grouped exactly the
way `PersonDetailBody` already labels its sections (Role, Status & vetting,
Services & rate, Details, Marketing, Notes) so the add flow and the edit
sheet read as the same product.

On the backend, `people.create` (`apps/convex/people.ts`) already accepts
most of the table's columns (email, phone, serviceIds, vettingStatus,
status, role, gender, pocName, projects, commsPreferences, pwEmail, company,
usualRateUsd, isTeamMember, socialLink, managerId) — it's extended with the
handful `update` already supports but `create` doesn't: explicit
`firstName`/`lastName` halves (so the "First/Last" inputs don't rely on
`splitPersonName`'s two-token guess), `location`, `referralSource`,
`isVolunteer`, `marketingOptOut`, and `notes`.

Deliberately excluded from the form (system-derived or import-only columns
that no manual "add person" flow should set): `image` (no upload UI —
out of scope), `isContactOnly`/`isPlaceholder`/`isSamplePerson` (written
only by automated creation paths, never a human "add" action),
`consentedAt`/`consentSource` (an affirmative-consent timestamp; per
`schema/people.ts`'s own doc and `people.update`'s args comment, this is
written only by the contacts import, never a manual toggle), and `persona`
(a derived cache, never hand-set).

**Alternative considered:** keep instant-create-then-edit and just add the
missing fields to `PersonDetailBody`. Rejected — it doesn't fix the actual
complaint (a half-empty "New person" row exists and is visible to the rest
of the roster the instant you click "Add", before you've typed anything),
and it would make the *edit* sheet (used constantly) carry the weight of a
one-time creation flow.

## Scope
**In scope:**
- Extend `people.create`'s Convex args/handler with `firstName`, `lastName`,
  `location`, `referralSource`, `isVolunteer`, `marketingOptOut`, `notes`.
- New `AddPersonModal` + `AddPersonMoreFields` components replacing the
  instant-stub-create behind "+ Add person".
- New pure logic module `addPersonForm.logic.ts` that turns raw form state
  into `people.create` args (required-first-name validation, blank-field
  omission, comma-list parsing, numeric-rate parsing).
- Generalize `addPersonAndGetOpenId` (`addPerson.logic.ts`) to take the full
  built args object instead of a hardcoded `{name: "New person"}` default.
- Wire the modal into `people.tsx`: opening it replaces `handleAddRow`'s
  direct `create` call; on success it opens `PersonDetail` on the new person
  exactly as today.

**Out of scope:**
- Profile photo upload (`image`).
- Duplicate-detection/merge prompts on add (`DuplicatesSheet` already
  exists for a separate flow — not touched).
- Any change to `PersonDetailBody`/the grid's inline cells — they keep
  working exactly as they do today for post-creation edits.
- Manager assignment when the caller isn't a chapter admin — mirrors the
  grid's existing `canEditManager` gate; the field is hidden, not disabled,
  for a non-admin.
- Any change to `people.update`, `peopleImport.ts`, or the AI assistant's
  add-person tool (`identity.ts`/`aiActions.ts`) — they keep calling
  `people.create` exactly as before; the new args are additive and optional.

## Relevant Files
- `apps/convex/people.ts` — `create` mutation (lines ~699-772): add the six
  new optional args and the firstName/lastName-authoritative branch,
  mirroring `update`'s existing branch (lines ~847-870).
- `apps/convex/schema/people.ts` — reference only (not modified): confirms
  every field's type/optionality and the fields deliberately excluded above.
- `apps/convex/tests/personNameHalves.test.ts` — **pattern to follow** for
  the new create-side name-half tests (same `seedPerson`/`readPerson`
  helpers style, same assertion shape).
- `apps/mobile/app/(app)/(tabs)/people.tsx` — remove `handleAddRow`'s direct
  `create` call (~424-435) and the now-unused `create`/`addPersonAndGetOpenId`
  imports at the top; the "Add row" `Pressable` (~728-735) opens the new
  modal instead; the empty-state copy (~741-744) references the old flow;
  render `AddPersonModal` conditionally near the existing `<PersonDetail>`
  render (~749-753).
- `apps/mobile/components/people/addPerson.logic.ts` +
  `addPerson.logic.test.ts` — **pattern to follow** for the "hand back id or
  error" contract; `addPersonAndGetOpenId`'s signature changes to take the
  full args object (see Phase 1).
- `apps/mobile/components/team/AddResponsibilityModal.tsx` — **pattern to
  follow** for modal chrome: `Modal`/overlay `Pressable`/card `Pressable`
  (`w-full max-w-md overflow-hidden rounded-xl border border-border
  bg-raised shadow-pop`), header row with title + `X` close `Icon`, footer
  actions, conditional mount (`{open ? <Modal.../> : null}`).
- `apps/mobile/components/ui/Field.tsx` — `TextField`/`Select` reused
  verbatim for every text/select input in the new form.
- `apps/mobile/components/ui/Switch.tsx` — reused for the boolean toggles.
- `apps/mobile/components/ui/ServiceOptionsPicker.tsx` — reused for the
  Services picker (same component `SkillsCell` already opens via a trigger
  `Pressable`, `apps/mobile/app/(app)/(tabs)/people.tsx` ~1257-1295).
- `apps/mobile/components/ui/PersonPicker.tsx` — reused for the Manager
  picker (`source="team"`), same as the grid's manager cell
  (~1044-1065 of `people.tsx`).
- `apps/mobile/lib/format.ts` — `parseList` reused for the
  Involvements/Comms-preferences comma-list fields.
- `packages/shared/src/names.ts` — `composeName` reused to build the display
  name from First/Last.

### New Files
- `apps/convex/tests/peopleCreateFields.test.ts` — backend tests for the six
  new `people.create` args.
- `apps/mobile/components/people/addPersonForm.logic.ts` — pure
  `AddPersonFormState` → `CreatePersonArgs` builder (validation + shaping;
  no React, no network — same "logic file" shape as `addPerson.logic.ts`).
- `apps/mobile/components/people/addPersonForm.logic.test.ts` — unit tests
  for the builder above.
- `apps/mobile/components/people/AddPersonModal.tsx` — modal chrome, the
  always-visible Name/Contact fields, the "More details" disclosure toggle,
  and submit orchestration (calls `buildAddPersonArgs` then
  `addPersonAndGetOpenId`).
- `apps/mobile/components/people/AddPersonMoreFields.tsx` — the collapsible
  grouped optional fields (Role, Status & vetting, Services & rate, Manager,
  Details, Marketing, Notes), each group its own small function in the file.

## Implementation Plan

### Phase 1: Foundation
- `people.create`'s extended args + handler (backend source of truth every
  later phase depends on).
- `addPersonForm.logic.ts`'s `AddPersonFormState` type, `EMPTY_ADD_PERSON_FORM`
  default, `CreatePersonArgs` type (mirrors the extended mutation args by
  hand — same convention `addPerson.logic.ts` already uses for its `create`
  param type, not a generated-API import), and `buildAddPersonArgs`.
- `addPersonAndGetOpenId`'s generalized signature.

### Phase 2: Core Implementation
- `AddPersonModal.tsx`: header, Name (First\*/Last), Contact (Email/Phone),
  disclosure toggle, footer (Cancel / "Add person"), submit wiring.
- `AddPersonMoreFields.tsx`: the six grouped optional-field sections.

### Phase 3: Integration
- Wire the modal into `people.tsx`: state, the "Add row" button, the
  conditional render, removal of the old `handleAddRow`/instant-create path,
  empty-state copy update.

## Step by Step Tasks

### 1. Extend `people.create` with the six new fields (RED → GREEN)
**a. Write the failing test.** Create
`apps/convex/tests/peopleCreateFields.test.ts` following
`personNameHalves.test.ts`'s `newT()`/`setupChapter()`/`run()` conventions:
- `describe("people.create — explicit name halves")`:
  - `test("stores explicit firstName/lastName instead of re-deriving them from name")` —
    `s.as.mutation(api.people.create, { name: "Mary Jo Van Der Berg", firstName: "Mary Jo", lastName: "Van Der Berg" })`,
    then read the doc and assert `firstName === "Mary Jo"`,
    `lastName === "Van Der Berg"` (today `splitPersonName` on a 5-token name
    returns `null`, so both would be `undefined` — this must fail first).
  - `test("falls back to automatic name-splitting when firstName/lastName are omitted")` —
    `create({ name: "Ada Lovelace" })` → `firstName === "Ada"`,
    `lastName === "Lovelace"` (regression guard; passes today, keep it to
    prove the fallback path survives the refactor).
- `describe("people.create — the remaining form-widening fields")`:
  - `test("persists location, referralSource, isVolunteer, marketingOptOut, and notes")` —
    `create({ name: "Test Person", location: "Nyack NY", referralSource: "Instagram", isVolunteer: true, marketingOptOut: true, notes: "met at retreat" })`
    → read the doc, assert all five stored exactly. **Must fail today** —
    Convex rejects unknown mutation args, so this throws a validation error
    against the unmodified `create`.
  - `test("leaves the five new fields unset when omitted")` —
    `create({ name: "Plain Person" })` → assert `location`, `referralSource`,
    `isVolunteer`, `marketingOptOut`, `notes` are all `undefined`.

Run `pnpm --filter @events-os/convex exec vitest run tests/peopleCreateFields.test.ts`
and confirm every test fails (unknown-argument `ConvexError` for the new
fields; wrong `firstName`/`lastName` for the halves test).

**b. Implement.** In `apps/convex/people.ts`'s `create` mutation:
- Add to `args`: `firstName: v.optional(v.string())`,
  `lastName: v.optional(v.string())`, `location: v.optional(v.string())`,
  `referralSource: v.optional(v.string())`,
  `isVolunteer: v.optional(v.boolean())`,
  `marketingOptOut: v.optional(v.boolean())`, `notes: v.optional(v.string())`.
- In the handler, replace the unconditional
  `...(splitPersonName(args.name) ?? {})` spread with: when
  `args.firstName !== undefined || args.lastName !== undefined`, spread
  `{ firstName: args.firstName, lastName: args.lastName }` (the halves are
  authoritative when sent — same rule `update` already applies); otherwise
  keep the existing `splitPersonName(args.name) ?? {}` fallback.
- Add `location: args.location, referralSource: args.referralSource,
  isVolunteer: args.isVolunteer, marketingOptOut: args.marketingOptOut,
  notes: args.notes` to the `ctx.db.insert("people", {...})` call.

**c. Run the full backend suite** —
`pnpm --filter @events-os/convex test` — before moving on.

### 2. `addPersonForm.logic.ts` — build `people.create` args from form state (RED → GREEN)
**a. Write the failing test.** Create
`apps/mobile/components/people/addPersonForm.logic.test.ts`
(same `@jest/globals` import style as `addPerson.logic.test.ts`) importing
a not-yet-existing `buildAddPersonArgs`/`EMPTY_ADD_PERSON_FORM` from
`./addPersonForm.logic` — it fails on import/module-not-found first, then
write these cases against the intended contract:
- `"returns an error and no args when first name is blank"` — form with
  `firstName: "   "` → `{ error: expect.any(String) }`, no `args` key.
- `"trims and composes the display name from first + last, omitting lastName when blank"` —
  `firstName: " Ada ", lastName: " "` → `args.name === "Ada"`,
  `args.firstName === "Ada"`, `"lastName" in args === false`.
- `"omits every optional text field left blank instead of sending empty strings"` —
  all of email/phone/role/company/pwEmail/pocName/socialLink/location/referralSource
  `""` → none of those keys present on `args`.
- `"includes optional text fields that are set, trimmed"` —
  `email: " ada@example.com "` → `args.email === "ada@example.com"`.
- `"parses usualRateUsd into a number, omitting it when blank or non-numeric"` —
  `"450"` → `args.usualRateUsd === 450`; `""` → key absent; `"abc"` → key
  absent.
- `"splits projects/commsPreferences into deduped trimmed arrays, omitting when empty"` —
  `projects: "Eden, Eden, Love Thy Neighbor"` → `args.projects === ["Eden", "Love Thy Neighbor"]`;
  `commsPreferences: ""` → key absent.
- `"passes status/vettingStatus/gender/managerId through only when selected"` —
  all `null` in the form → none of those keys present; each set to a value
  → present with that exact value.
- `"always includes isTeamMember/isVolunteer/marketingOptOut as explicit booleans"` —
  default form (`false`/`false`/`false`) → all three keys present and `false`.
- `"passes serviceIds through as given"` — `serviceIds: ["svc1"]` →
  `args.serviceIds === ["svc1"]`.

Run `pnpm --filter @events-os/mobile test addPersonForm.logic.test.ts` and
confirm it fails (module doesn't exist yet).

**b. Implement** `apps/mobile/components/people/addPersonForm.logic.ts`:
- `export type CreatePersonArgs = { name: string; firstName?: string; lastName?: string; email?: string; phone?: string; serviceIds?: Id<"serviceOptions">[]; vettingStatus?: VettingStatus; status?: RosterStatus; role?: string; gender?: "male" | "female" | "na"; pocName?: string; projects?: string[]; commsPreferences?: string[]; pwEmail?: string; company?: string; usualRateUsd?: number; isTeamMember?: boolean; socialLink?: string; managerId?: Id<"people">; location?: string; referralSource?: string; isVolunteer?: boolean; marketingOptOut?: boolean; notes?: string; }`
  (import `Id` from `@events-os/convex/_generated/dataModel`, `VettingStatus`/
  `RosterStatus` from `@events-os/shared`, `composeName`/`parseList` per
  imports already established in `people.tsx`).
- `export type AddPersonFormState = { firstName: string; lastName: string; email: string; phone: string; role: string; company: string; pwEmail: string; status: RosterStatus | null; vettingStatus: VettingStatus | null; gender: "male" | "female" | "na" | null; isTeamMember: boolean; serviceIds: Id<"serviceOptions">[]; usualRateUsd: string; managerId: Id<"people"> | null; pocName: string; projects: string; commsPreferences: string; socialLink: string; location: string; referralSource: string; isVolunteer: boolean; marketingOptOut: boolean; notes: string; }`.
- `export const EMPTY_ADD_PERSON_FORM: AddPersonFormState = { ...every field its empty/false/null default... }`.
- A local helper `trimmedOrUndefined(s: string): string | undefined` used for
  every blank-omitted text field.
- `export function buildAddPersonArgs(form: AddPersonFormState): { args: CreatePersonArgs; error?: undefined } | { args?: undefined; error: string }`
  implementing every case above: required-first-name check first; compose
  `name` via `composeName`; spread optional text fields via
  `trimmedOrUndefined`; parse rate via `Number(trimmed)` +
  `Number.isFinite` guard; parse the two comma-list fields via `parseList`,
  omitting when the result is empty; pass `status`/`vettingStatus`/`gender`/
  `managerId` through only when non-null; always set `isTeamMember`,
  `isVolunteer`, `marketingOptOut` explicitly; pass `serviceIds` through
  as-is.

**c. Run** `pnpm --filter @events-os/mobile test` (whole package) before
moving on.

### 3. Generalize `addPersonAndGetOpenId` (RED → GREEN)
**a. Write the failing test.** Rewrite
`apps/mobile/components/people/addPerson.logic.test.ts`'s three cases for
the new signature:
- `"returns the new person's id on success"` — call
  `addPersonAndGetOpenId(create, { name: "Ada Lovelace" })`, expect
  `{ id: "person123" }`.
- `"catches a rejection and returns it as an error instead of throwing"` —
  same, with a throwing `create`.
- Replace `"calls create with the default 'New person' name"` with
  `"passes the given args through to create verbatim"` — call with
  `{ name: "Ada Lovelace", email: "ada@example.com" }` and assert
  `create` was called with that exact object (not wrapped/defaulted).

Run `pnpm --filter @events-os/mobile test addPerson.logic.test.ts` — the
third case fails against the unmodified implementation (it still wraps the
passed object as `{ name: <the object> }` since the old signature treats
the second positional as a bare `name` string with a default).

**b. Implement.** In `apps/mobile/components/people/addPerson.logic.ts`:
- Import `type CreatePersonArgs` from `./addPersonForm.logic`.
- Change the signature to
  `addPersonAndGetOpenId(create: (args: CreatePersonArgs) => Promise<string>, args: CreatePersonArgs)`
  (drop the `name = "New person"` default entirely), and the body to
  `try { const id = await create(args); return { id }; } catch (error) { return { error }; }`.
- Update the file's header comment: it now hands the caller's fully-built
  args through rather than defaulting a bare name.

**c. Run** `pnpm --filter @events-os/mobile test` before moving on.

### 4. `AddPersonModal` + `AddPersonMoreFields`, wired into the People tab
No new automated test for this step — this repo has zero `.tsx`
component-render tests anywhere (`find apps/mobile -iname "*.test.tsx"` is
empty; the established convention, per `addPerson.logic.ts`/
`addPerson.logic.test.ts`, is testing extracted pure logic only, which
Steps 1-3 already cover exhaustively for every field-shaping rule this UI
depends on). Verify this step with typecheck/lint (Validation Commands)
plus a manual smoke check via the `run` skill: open the People tab, click
"Add person", fill only First name, submit, confirm the person appears and
opens in `PersonDetail`; repeat filling every "More details" field once and
confirm each value round-trips onto the created person.

**a. Create `apps/mobile/components/people/AddPersonMoreFields.tsx`.**
Props: `{ form: AddPersonFormState; onChange: <K extends keyof AddPersonFormState>(key: K, value: AddPersonFormState[K]) => void; canSetManager: boolean }`.
One small function per group, each with a `text-2xs font-bold uppercase
tracking-wider text-muted` section label (matching `PersonDetailBody`'s
existing section headers) — top-level component just renders them in order:
- `RoleFields` — Title/Role (`TextField`), Company (`TextField`), PW Email
  (`TextField`).
- `StatusFields` — Status (`Select`, options built from a local
  `STATUS_SELECT_OPTIONS` array mirroring `people.tsx`'s `STATUS_LABEL`
  entries: active/inactive/transitioning_in/transitioning_out/unavailable),
  Vetting (`Select`, unvetted/pending/vetted), Gender (`Select`,
  male/female/na → "Male"/"Female"/"N/A"), Core team member (`Switch`).
- `ServicesAndRateFields` — Services trigger `Pressable` (shows chosen
  service chips or "—", opens `ServiceOptionsPicker` exactly like
  `SkillsCell` in `people.tsx`), Usual rate USD (`TextField`,
  `keyboardType="numeric"`).
- `ManagerField` (rendered only when `canSetManager`) — trigger `Pressable`
  showing the picked manager's name or "—", opens `PersonPicker`
  (`source="team"`, no `filter` needed — there's no self to exclude yet).
- `DetailsFields` — Location, How they heard about us, POC name,
  Involvements (comma `TextField`, placeholder `"Eden, Love Thy Neighbor…"`),
  Comms preferences (comma `TextField`, placeholder `"slack, call, text…"`),
  Social link — all plain `TextField`s, plus Marked as volunteer (`Switch`).
- `MarketingField` — Marketing emails `Switch` (inverted: `value={!form.marketingOptOut}`,
  `onValueChange={(on) => onChange("marketingOptOut", !on)}`, same inversion
  `PersonDetailBody`'s own marketing toggle already uses).
- `NotesField` — multiline `TextField` (`multiline`, `numberOfLines={3}`).

**b. Create `apps/mobile/components/people/AddPersonModal.tsx`.**
Props: `{ onClose: () => void; onCreated: (personId: string) => void; canSetManager: boolean }`.
- `const create = useMutation(api.people.create);`
- `const [form, setForm] = useState<AddPersonFormState>(EMPTY_ADD_PERSON_FORM);`
- `const [detailsOpen, setDetailsOpen] = useState(false);`
- `const [submitting, setSubmitting] = useState(false);`
- `function set<K extends keyof AddPersonFormState>(key: K, value: AddPersonFormState[K]) { setForm((f) => ({ ...f, [key]: value })); }`
- Modal chrome copied from `AddResponsibilityModal`'s shell (`Modal`
  `transparent animationType="fade"`, overlay `Pressable` calling `onClose`,
  card `Pressable` `w-full max-w-lg overflow-hidden rounded-xl border
  border-border bg-raised shadow-pop`), header "Add person" + `X` `Icon`
  close button.
- Body (`ScrollView`, `max-h-[80vh]` or similar): Name row (First — required,
  `autoFocus` — and Last, two `TextField`s side by side, mirroring
  `NameFieldsSection`'s `flex-row gap-2` layout), Contact row (Email, Phone,
  same two-column layout), a disclosure `Pressable` toggling `detailsOpen`
  with a chevron `Icon` ("More details" / "Hide details"), and
  `{detailsOpen ? <AddPersonMoreFields form={form} onChange={set} canSetManager={canSetManager} /> : null}`.
- Footer: `Button` "Cancel" (`variant="secondary"`, `onPress={onClose}`) and
  `Button` "Add person" (`onPress={submit}`, `loading={submitting}`,
  `disabled={!form.firstName.trim() || submitting}`).
- `async function submit()`: build via `buildAddPersonArgs(form)`; if
  `error`, `alertError(new Error(error))` and return; else
  `setSubmitting(true)`, call `addPersonAndGetOpenId(create, args)`, on
  `id !== undefined` call `onCreated(id)`, else `alertError(result.error)`;
  `setSubmitting(false)` in a `finally`.

**c. Wire into `apps/mobile/app/(app)/(tabs)/people.tsx`:**
- Remove `const create = useMutation(api.people.create);` (~line 198) — no
  longer used here.
- Remove the `addPersonAndGetOpenId` import (~line 55); add
  `import { AddPersonModal } from "../../../components/people/AddPersonModal";`.
- Add `const [addPersonOpen, setAddPersonOpen] = useState(false);` near the
  other local UI state (e.g. by `dupOpen`).
- Delete `handleAddRow` (~424-435) entirely.
- Change the "Add row" `Pressable`'s `onPress` (~730) from `handleAddRow` to
  `() => setAddPersonOpen(true)`.
- Update the empty-state `message` (~743) from `"Use the "Add person" row to
  start your roster, then edit each cell inline."` to `"Tap "Add person" to
  start your roster."`.
- Render, near the existing `<PersonDetail ... />` (~749-753):
  ```
  {addPersonOpen ? (
    <AddPersonModal
      canSetManager={org?.isAdmin === true}
      onClose={() => setAddPersonOpen(false)}
      onCreated={(id) => {
        setAddPersonOpen(false);
        setOpenId(id);
      }}
    />
  ) : null}
  ```

**d. Run the full validation suite** (final step of this milestone and of
the whole plan): every command in Validation Commands below, in order.

## Testing Strategy

### Tests by Milestone
| # | Milestone | Test file | The test asserts | Why it fails today |
|---|---|---|---|---|
| 1 | Extend `people.create` | `apps/convex/tests/peopleCreateFields.test.ts` (new) | Explicit `firstName`/`lastName` are stored as given (not re-derived); `location`/`referralSource`/`isVolunteer`/`marketingOptOut`/`notes` persist when sent and stay unset when omitted | Those six args don't exist on `create` yet — Convex rejects them as unknown, and `firstName`/`lastName` are always derived via `splitPersonName(name)`, which returns `null` (both halves unset) for a 5-token name |
| 2 | `buildAddPersonArgs` | `apps/mobile/components/people/addPersonForm.logic.test.ts` (new) | Required-first-name validation, blank-field omission, numeric-rate parsing, comma-list parsing, null-select omission, always-explicit booleans | The module doesn't exist yet |
| 3 | Generalize `addPersonAndGetOpenId` | `apps/mobile/components/people/addPerson.logic.test.ts` (modified) | The full args object is passed to `create` verbatim, not wrapped under a defaulted `name` | The current signature treats its second positional as a bare, defaulted `name` string, so passing an args object nests it as `{ name: <object> }` |
| 4 | `AddPersonModal`/`AddPersonMoreFields` + wiring | none (manual smoke check) | N/A — see Step 4's note on this repo's zero-`.tsx`-test convention | N/A |

**Pattern followed:** `apps/convex/tests/personNameHalves.test.ts` (backend
name-half tests) and `apps/mobile/components/people/addPerson.logic.test.ts`
(mobile pure-logic tests) — both already-established conventions in this
codebase; nothing new invented.

### Integration Tests
N/A — no existing seam-level (Convex-mutation-through-UI) test harness in
this repo to extend; Milestones 1-3's unit tests cover the mutation and the
two logic modules independently, and Step 4's manual smoke check covers the
actual seam (form → `buildAddPersonArgs` → `addPersonAndGetOpenId` →
`people.create` → `PersonDetail` opening on the result).

### Edge Cases
- Blank/whitespace-only first name → `buildAddPersonArgs` returns an error,
  the modal's submit button stays disabled (Milestone 2/4).
- A 5+-token name typed as First="Mary Jo" / Last="Van Der Berg" must not
  collapse through `splitPersonName`'s two-token-only guess (Milestone 1's
  first test).
- Every optional field left blank must be *omitted*, not sent as `""` — the
  test in Milestone 2 covers this explicitly, since sending `""` would
  overwrite the schema's "unset" default of several fields (e.g. `role`)
  with an empty string that then renders as a distinct-from-`—` blank in
  the grid.
- Non-numeric `usualRateUsd` input ("abc") must not block submission of an
  otherwise-valid form — it's silently omitted (Milestone 2).
- A non-admin caller never sees the Manager field at all (`canSetManager`
  gate in Step 4), mirroring the grid's existing `canEditManager` gate
  exactly — not merely disabled, since a design-only field a non-admin
  can't act on shouldn't be shown (same rationale already documented at
  `people.tsx`'s "Email selected" bridge).

## Acceptance Criteria
- [ ] `people.create` accepts and persists `firstName`, `lastName`,
      `location`, `referralSource`, `isVolunteer`, `marketingOptOut`, and
      `notes`; every pre-existing caller (AI assistant tool, imports,
      existing tests) still works unmodified.
- [ ] Clicking "+ Add person" opens `AddPersonModal` instead of instantly
      creating a "New person" stub row.
- [ ] The modal's First name field is the only required field; every other
      field (Last name, Email, Phone, Title/Role, Company, PW Email,
      Status, Vetting, Gender, Core team, Services, Usual rate, Manager
      (admins only), POC, Involvements, Comms preferences, Social link,
      Location, How they heard about us, Marked as volunteer, Marketing
      emails, Notes) is optional and reachable from the modal.
- [ ] First name, Last name, Email, and Phone are visible without any
      extra tap; every other field lives behind a single "More details"
      disclosure, collapsed by default.
- [ ] Submitting creates the person with every filled field set correctly,
      then opens `PersonDetail` on the new person — matching today's
      post-creation behavior.
- [ ] A blank optional field never lands on the created person as an empty
      string.
- [ ] `apps/mobile/components/people/addPerson.logic.test.ts` and the new
      `addPersonForm.logic.test.ts` both pass.
- [ ] `apps/convex/tests/peopleCreateFields.test.ts` passes, and the full
      `apps/convex` suite still passes (no regression to
      `orgProjects.test.ts`, `peopleAggregateConsistency.test.ts`, etc.,
      which all call `people.create` with the pre-existing arg shape).

## Validation Commands
Execute every command. Every one must exit clean.

- `pnpm --filter @events-os/convex typecheck`
- `pnpm --filter @events-os/convex exec vitest run tests/peopleCreateFields.test.ts tests/personNameHalves.test.ts` — fast targeted pass first
- `pnpm --filter @events-os/convex test` — full backend suite, zero regressions
- `pnpm --filter @events-os/mobile test` — Jest, covers `addPerson.logic.test.ts` + `addPersonForm.logic.test.ts`
- `pnpm --filter @events-os/mobile typecheck`
- `pnpm --filter @events-os/mobile lint`
- `pnpm turbo run test` — full monorepo fan-out, zero regressions

## Notes
- No new dependencies — every field control (`TextField`, `Select`,
  `Switch`, `ServiceOptionsPicker`, `PersonPicker`) already exists in
  `components/ui`.
- Deliberately no Academy/governance-doc updates: this is a form-layout and
  data-capture change to an existing, already-documented concept (adding a
  person to the roster) — no vocabulary, money rule, seat, or process
  changed. (Per CLAUDE.md's standing rule, flagging that this was
  considered and doesn't apply, not skipped silently.)
- Future work deliberately deferred (not part of this plan): profile-photo
  upload at add-time, duplicate-detection prompts during add, and any
  "save as draft" / multi-step wizard treatment of the form — the flat
  disclosure design here is judged sufficient for the stated ask.
