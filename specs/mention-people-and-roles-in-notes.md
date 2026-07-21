# Feature: @Mentions for people and roles in Duties notes

## Feature Description
Typing `@` inside the Notes field of a Duty (a `responsibilities` row, edited in
the Duties grid) opens a picker of people and org-chart roles ("seats"). Picking
one inserts a mention token into the note. When the note is displayed, that
token renders as a tappable link: a person mention jumps straight to that
person's card on the People page; a role mention (e.g. "Music Director")
resolves to WHOEVER CURRENTLY HOLDS that seat and jumps to their card — so the
link stays correct automatically as the seat changes hands, with no edit to
the note required.

## User Story
As a chapter lead writing a duty's notes
I want to type "@" and pick a person or a role like "Music Director"
So that the note becomes a live pointer to a person's contact info instead of
a name I have to remember and search for by hand

## Problem Statement
`responsibilities.notes` (and every other `notes` field in this codebase) is a
plain, unstructured string. When someone writes "check with the music
director about the setlist," that phrase is inert text — there's no way to
tap it and get the current music director's phone number, and if the seat
changes hands the note silently goes stale. There is also no existing
mention/tagging feature anywhere in the repo to extend (confirmed by
searching the codebase — see Notes).

## Solution Statement
Add a small, dependency-free mention system with three pieces, then wire it
into the one grid that best matches the feature's own example (a duty's notes
mentioning a role):

1. **Markup + parsing** (`packages/shared/src/mentions.ts`): mentions are
   encoded directly in the existing plain-text `notes` string using a
   markdown-link-shaped token — `@[Music Director](mention:seat:<seatDefId>)`
   or `@[Jordan](mention:person:<personId>)` — so **no schema change is
   needed**. This mirrors the `[text](url)` link shape already used by the
   docs markdown surface (`apps/mobile/components/markdown/linkClick.ts`),
   just prefixed with `@` and namespaced `mention:` so it can't collide with a
   real URL.
2. **Client-side resolution** (`mentionResolve.logic.ts`): a pure function
   that turns a mention token into "who to link to, right now." Role
   resolution is a live lookup against `chapterSeatHoldings` (already an
   existing indexed, non-historical "current holder" query —
   `apps/convex/responsibilities.ts:627`) — **no new Convex query is needed**,
   because the one screen we're wiring this into (`DutiesGrid.tsx`) already
   fetches both `api.people.list` and `api.responsibilities.chapterSeatHoldings`
   for its own grid. Resolution is just a lookup against data already on the
   client.
3. **UI** (`MentionText.tsx`, `MentionTextInput.tsx`): rendering follows no
   existing component (there is no prior mention/rich-text-for-plain-fields
   pattern to reuse), but the dropdown itself reuses the exact anchored-popover
   primitive already used for every other grid-cell dropdown in this file
   family — `Popover` + `useAnchor` (`apps/mobile/components/ui/Popover.tsx`,
   `useAnchor.ts`), as used by `SelectCell` in
   `apps/mobile/components/ui/EditableTable.tsx`. Suggestion filtering follows
   `PersonPicker.tsx`'s substring-match-on-name approach.

**Why this approach over alternatives considered:** An automatic scanner that
detects free-typed role names ("music director") anywhere in prose was
considered (closer to the literal feature description) and rejected: it's
ambiguous (which "director"? what if the phrase appears mid-sentence for
unrelated reasons?), fragile to rewording, and unlike every mention system
users already know (Slack, Notion, Linear). The `@`-trigger-and-pick pattern
delivers the same end result — "say music director, get a working link" — via
an explicit, disambiguated choice instead of pattern-matching prose. **This is
a design decision worth confirming with the user before implementation** (see
final report).

## Scope
**In scope:**
- Mention markup encode/parse utility (`packages/shared/src/mentions.ts`)
- Client-side resolution of a mention token to a person id + display name,
  using data the Duties grid already fetches
- `@`-trigger detection logic for a text input
- `MentionText` (read-mode renderer, tap-to-navigate) and `MentionTextInput`
  (edit-mode input with `@` picker) components
- Wiring both into the Notes column of `apps/mobile/components/work/DutiesGrid.tsx`
  (`responsibilities.notes`), both read and edit modes
- Graceful fallback when a mentioned person is gone or a mentioned seat is
  currently vacant (render the captured label, not a broken link)

**Out of scope:**
- Adding mention support to any other `notes` field (`people.notes`,
  `engagements.notes`, `responsibilities` feedback fields, `givingPlatform.notes`,
  etc.) — the shared pieces (`mentions.ts`, `MentionText`, `MentionTextInput`)
  are written generically so a follow-up PR can wire them into another screen
  cheaply, but that wiring is not part of this pass.
- Disambiguating multi-holder seats (a seat with `maxHolders > 1`) beyond
  linking to the first current holder found — no "and N others" UI.
- Push notifications or any "you were mentioned" alerting.
- A server-side Convex query for mention resolution — not needed while the
  only integration point already has the required data loaded client-side.
- Free-text auto-detection of role names without an explicit `@` trigger (see
  Solution Statement).
- Editing/removing a mention once inserted other than by editing the raw text
  (no dedicated "remove chip" affordance) — the note remains a plain string,
  so normal text editing (backspace) already works.

## Relevant Files
- `apps/mobile/components/work/DutiesGrid.tsx` — the Notes column's read cell
  (`row.notes || "—"`, ~line 644) and edit cell (`InlineText` bound to
  `update({ notes: ... })`, ~line 648-652) are what gets replaced with
  `MentionText` / `MentionTextInput`. This file already runs
  `useQuery(api.people.list, {})` (line 187) and
  `useQuery(api.responsibilities.chapterSeatHoldings)` (line 189) — the exact
  data the new components need, already in scope.
- `apps/mobile/components/ui/EditableTable.tsx` — **pattern to follow**:
  `InlineText` (line 25) is the existing inline-edit cell shape being
  replaced; `SelectCell` in the same file is the existing example of a grid
  cell that opens a `Popover` off a `useAnchor()` ref, which the new
  `MentionTextInput` dropdown follows.
- `apps/mobile/components/ui/Popover.tsx`, `apps/mobile/components/ui/useAnchor.ts`
  — the anchored-dropdown primitive `MentionTextInput` reuses as-is (read, not
  modified).
- `apps/mobile/components/ui/PersonPicker.tsx` — reference for the
  substring-filter-by-name logic used to rank people suggestions (read, not
  modified).
- `apps/convex/responsibilities.ts:627` (`chapterSeatHoldings`) — the existing
  "current holder per seat" query the grid already fetches; mention
  resolution treats its result as the source of truth for "who holds this
  role right now" (read, not modified).
- `apps/mobile/app/(app)/(tabs)/people.tsx:177-184` — the existing
  `?openId=<personId>` deep link that opens a person's detail sheet; mention
  taps navigate here (read, not modified; comment at line 177 already
  documents this exact deep-link contract).
- `apps/convex/schema/seats.ts` — `seatDefs`/`seatAssignments` shape (`slug`,
  `title`, `seatDefId`, `personId`) referenced for typing only, not modified.

### New Files
- `packages/shared/src/mentions.ts` — `MentionType`, `MentionToken`,
  `MentionSegment` types; `encodeMention()`; `splitMentionSegments()`.
- `packages/shared/src/mentions.test.ts` — tests for the above.
- `apps/mobile/components/mentions/mentionResolve.logic.ts` — pure
  `resolveMentionToken()`: token + `{people, seatHoldings}` → resolved person
  or `null`.
- `apps/mobile/components/mentions/mentionResolve.logic.test.ts` — tests.
- `apps/mobile/components/mentions/mentionTrigger.logic.ts` — pure
  `detectMentionTrigger()`: text + cursor index → the in-progress `@query` or
  `null`.
- `apps/mobile/components/mentions/mentionTrigger.logic.test.ts` — tests.
- `apps/mobile/components/mentions/MentionText.tsx` — read-mode renderer:
  splits text into segments, resolves each mention, renders plain `Text` for
  text segments and a `Pressable` link for resolved mentions (muted, non-
  pressable fallback text for unresolved ones).
- `apps/mobile/components/mentions/MentionTextInput.tsx` — edit-mode
  `TextInput` wrapper: tracks selection, runs `detectMentionTrigger`, opens a
  `Popover` (via `useAnchor`) listing filtered people + seat suggestions,
  inserts `encodeMention(...)` on selection.

## Implementation Plan

### Phase 1: Foundation
`packages/shared/src/mentions.ts` — the markup format and pure parse/encode
functions everything else depends on. No I/O, no React, no Convex.

### Phase 2: Core Implementation
The two pure logic modules (`mentionResolve.logic.ts`,
`mentionTrigger.logic.ts`) and the two components that consume them
(`MentionText.tsx`, `MentionTextInput.tsx`).

### Phase 3: Integration
Wire `MentionText` (read) and `MentionTextInput` (edit) into
`DutiesGrid.tsx`'s Notes column, passing through the `people` and
`seatHoldings` data the grid already fetches.

## Step by Step Tasks
IMPORTANT: Execute every step in order, top to bottom.

### 1. Mention markup encode/parse (`packages/shared/src/mentions.ts`)

**a. Write the failing test.** Create
`packages/shared/src/mentions.test.ts` with the assertions from row 1 of the
Testing Strategy table below — importing `encodeMention` and
`splitMentionSegments` from `./mentions`, a module that does not exist yet.
Run `cd packages/shared && pnpm vitest run mentions.test.ts` and confirm it
fails on the missing module (genuine RED, not a broken-test error).

**b. Implement the minimum to reach GREEN.** Add `mentions.ts` with:
```ts
export type MentionType = "person" | "seat";
export type MentionToken = { type: MentionType; id: string; label: string };
export type MentionSegment =
  | { kind: "text"; text: string }
  | { kind: "mention"; token: MentionToken };

const MENTION_RE = /@\[([^\]]+)\]\(mention:(person|seat):([^)]+)\)/g;

export function encodeMention(type: MentionType, id: string, label: string): string {
  return `@[${label}](mention:${type}:${id})`;
}

export function splitMentionSegments(text: string): MentionSegment[] {
  const segments: MentionSegment[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(MENTION_RE)) {
    const start = match.index!;
    if (start > lastIndex) {
      segments.push({ kind: "text", text: text.slice(lastIndex, start) });
    }
    segments.push({
      kind: "mention",
      token: { type: match[2] as MentionType, id: match[3], label: match[1] },
    });
    lastIndex = start + match[0].length;
  }
  if (lastIndex < text.length) {
    segments.push({ kind: "text", text: text.slice(lastIndex) });
  }
  return segments;
}
```

**c. Run the full suite before moving on.** `cd packages/shared && pnpm test`.

### 2. Mention resolution against already-loaded data (`mentionResolve.logic.ts`)

**a. Write the failing test.** Create
`apps/mobile/components/mentions/mentionResolve.logic.test.ts` with the
assertions from row 2 of the Testing Strategy table. Run it and confirm it
fails (module doesn't exist).

**b. Implement the minimum to reach GREEN.** Add
`mentionResolve.logic.ts`:
```ts
import type { MentionToken } from "@events-os/shared";

export type ResolvedMention = { personId: string; displayName: string };

export function resolveMentionToken(
  token: MentionToken,
  data: {
    people: { _id: string; name: string }[];
    seatHoldings: { personId: string; seatDefId: string }[];
  },
): ResolvedMention | null {
  const personId =
    token.type === "person"
      ? token.id
      : data.seatHoldings.find((h) => h.seatDefId === token.id)?.personId;
  if (!personId) return null;
  const person = data.people.find((p) => p._id === personId);
  return person ? { personId, displayName: person.name } : null;
}
```

**c. Run the full suite before moving on.** `cd apps/mobile && pnpm test`.

### 3. `@` trigger detection (`mentionTrigger.logic.ts`)

**a. Write the failing test.** Create
`apps/mobile/components/mentions/mentionTrigger.logic.test.ts` with the
assertions from row 3 of the Testing Strategy table (including the
`user@example.com` non-trigger case). Confirm it fails (module doesn't exist).

**b. Implement the minimum to reach GREEN.** Add `mentionTrigger.logic.ts`:
```ts
export type MentionTrigger = { query: string; start: number } | null;

export function detectMentionTrigger(
  text: string,
  cursorIndex: number,
): MentionTrigger {
  for (let i = cursorIndex - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === "@") {
      const precedingChar = i === 0 ? null : text[i - 1];
      if (precedingChar !== null && !/\s/.test(precedingChar)) return null;
      return { query: text.slice(i + 1, cursorIndex), start: i };
    }
    if (/\s/.test(ch)) return null;
  }
  return null;
}
```

**c. Run the full suite before moving on.** `cd apps/mobile && pnpm test`.

### 4. `MentionText` read-mode renderer

**a. Baseline.** No unit test for this step (see Testing Strategy note — this
repo has no mobile component render tests by convention; `MentionText` is a
thin composition of the already-tested `splitMentionSegments` +
`resolveMentionToken`). Confirm `pnpm typecheck` is currently clean before
starting, so any new failure is attributable to this step.

**b. Implement.** Add `MentionText.tsx`: accepts `text: string`,
`people: {_id, name}[]`, `seatHoldings: {personId, seatDefId}[]`. Calls
`splitMentionSegments(text)`, renders text segments as plain `<Text>`, and for
each mention segment calls `resolveMentionToken`; a resolved mention renders
as a `<Text onPress={...}>` styled as a link (accent color, no underline
needed — match existing link styling used elsewhere, e.g. `MarkdownView`'s
link color) that calls `router.push(`/people?openId=${personId}`)`; an
unresolved mention renders `token.label` in muted/italic text with no press
handler.

**c. Run the full suite.** `cd apps/mobile && pnpm typecheck && pnpm lint`.

### 5. `MentionTextInput` edit-mode input with `@` picker

**a. Baseline.** No unit test for this step, same reasoning as Step 4 — the
logic it depends on (`detectMentionTrigger`) is already covered. Confirm
`pnpm typecheck` is clean before starting.

**b. Implement.** Add `MentionTextInput.tsx`: same props/commit contract as
`InlineText` (`value: string`, `onCommit: (v: string) => void`) plus
`people` and `seatHoldings`/seat-title suggestions (`seatOptions:
{seatDefId, title}[]`), so it's a drop-in replacement in the grid cell. Wraps
a `TextInput` in a `View` holding a `useAnchor()` ref. On `onChangeText` +
`onSelectionChange`, runs `detectMentionTrigger`; when it returns non-null,
filters `people` by `name.toLowerCase().includes(query)` (mirroring
`PersonPicker.tsx`'s filter) and `seatOptions` by
`title.toLowerCase().includes(query)`, opens the `Popover` via `anchor.open()`
with the combined, capped (e.g. top 8) suggestion list; closes it when the
trigger returns `null` or on blur/selection. Selecting a suggestion splices
`encodeMention(type, id, label) + " "` into the text at `trigger.start`
through the cursor, calls `onChangeText`, and closes the popover. Commits on
blur exactly like `InlineText` (`onCommit(text)`).

**c. Run the full suite.** `cd apps/mobile && pnpm typecheck && pnpm lint`.

### 6. Wire into `DutiesGrid.tsx`

**a. Baseline.** No unit test (integration/wiring into a screen with no
render-test convention — see Testing Strategy). Confirm `pnpm typecheck` and
`pnpm test` are clean before starting.

**b. Implement.** In `apps/mobile/components/work/DutiesGrid.tsx`:
- Read mode (~line 644): replace the plain `{row.notes || "—"}` `<Text>` with
  `row.notes ? <MentionText text={row.notes} people={people ?? []} seatHoldings={seatHoldings ?? []} /> : <Text className="px-2 text-sm text-ink" numberOfLines={1}>—</Text>`.
- Edit mode (~line 648-652): replace the `InlineText` bound to `notes` with
  `MentionTextInput`, passing `people`, `seatHoldings`, and
  `seatOptions={seatOptions ?? []}` (already fetched at lines 186-189), same
  `value`/`onCommit` wiring as before.
- Leave the `description` column's `InlineText` untouched (out of scope).

**c. Run the full suite.** `pnpm typecheck && pnpm lint && pnpm test` (root).
This is also the final validation step for the whole plan.

## Testing Strategy

### Tests by Milestone

| # | Milestone | Test file | The test asserts | Why it fails today |
|---|---|---|---|---|
| 1 | Mention markup encode/parse | `packages/shared/src/mentions.test.ts` | `encodeMention("person", "p1", "Jordan")` → `"@[Jordan](mention:person:p1)"`; `splitMentionSegments("Hi @[Jordan](mention:person:p1) bye")` → `[{kind:"text",text:"Hi "},{kind:"mention",token:{type:"person",id:"p1",label:"Jordan"}},{kind:"text",text:" bye"}]`; a string with two adjacent mentions and no space between them yields two `mention` segments with no empty `text` segment in between; a plain string with no markup yields exactly `[{kind:"text", text: <original>}]`; a malformed token (`@[Jordan](mention:person:p1` — no closing paren) yields a single unmodified `text` segment, not a `mention` | `mentions.ts` does not exist |
| 2 | Mention resolution | `apps/mobile/components/mentions/mentionResolve.logic.test.ts` | `resolveMentionToken({type:"person", id:"p1", label:"Jordan"}, {people:[{_id:"p1",name:"Jordan Kupo"}], seatHoldings:[]})` → `{personId:"p1", displayName:"Jordan Kupo"}`; a person token whose id isn't in `people` → `null`; `resolveMentionToken({type:"seat", id:"s1", label:"Music Director"}, {people:[{_id:"p2",name:"Alex"}], seatHoldings:[{personId:"p2",seatDefId:"s1"}]})` → `{personId:"p2", displayName:"Alex"}`; a seat token with no matching row in `seatHoldings` (vacant seat) → `null`; a seat token whose holding's `personId` isn't in `people` (data-integrity edge case) → `null`, not a throw | `mentionResolve.logic.ts` does not exist |
| 3 | `@` trigger detection | `apps/mobile/components/mentions/mentionTrigger.logic.test.ts` | `detectMentionTrigger("Hi @jo", 6)` → `{query:"jo", start:3}`; `detectMentionTrigger("@", 1)` → `{query:"", start:0}`; `detectMentionTrigger("user@example.com", 17)` → `null` (the `@` is not preceded by whitespace/start-of-string); `detectMentionTrigger("@foo bar", 8)` → `null` (a space after the `@`-word ends the trigger before reaching the cursor); `detectMentionTrigger("no at sign here", 5)` → `null` | `mentionTrigger.logic.ts` does not exist |

**Pattern followed:** `packages/shared` co-located tests
(e.g. any existing `*.test.ts` beside its module) for row 1;
`apps/mobile/components/orgchart/treeUtils.test.ts` for rows 2–3 — pure,
dependency-free logic extracted from a component and unit-tested in
isolation, the established mobile convention for testable logic.

**Steps 4–6 (components + grid wiring) have no dedicated test file.** Per
this repo's documented Testing Conventions (`.claude/PROJECT.md`): "Only
dependency-free logic is unit-tested; there are no component render tests" for
`apps/mobile`. `MentionText` and `MentionTextInput` are thin React
compositions over the already-unit-tested logic in rows 1–3; their
correctness is verified by `pnpm typecheck` + `pnpm lint` passing and by
manual QA in the Expo web app (see Acceptance Criteria), matching how every
other grid cell in `DutiesGrid.tsx`/`EditableTable.tsx` is verified in this
codebase today.

### Integration Tests
N/A — the only integration seam (`DutiesGrid.tsx` reading `people` and
`seatHoldings` it already fetches) is plain prop-passing with no new data
fetching or Convex function, so there is no new seam to integration-test
beyond the manual QA pass in Step 6.

### Edge Cases
- Empty/whitespace-only notes → `splitMentionSegments` returns a single text
  segment; `MentionText` renders it same as today. Covered by milestone 1's
  "no markup" case.
- Mentioned person later deleted, or mentioned seat later removed from the
  org chart → `resolveMentionToken` returns `null`; `MentionText` falls back
  to the captured `label` text, non-interactive. Covered by milestone 2's
  "no matching row" and "dangling personId" cases.
- Seat currently vacant (no `seatAssignments` row) → same `null`/fallback
  path. Covered by milestone 2.
- An email address or any other bare `@` not preceded by whitespace must
  never trigger the picker while someone is typing regular text into Notes.
  Covered by milestone 3's `user@example.com` case.
- Two mentions typed back-to-back with no space → parser must not swallow or
  merge them. Covered by milestone 1's adjacent-mentions case.
- Multi-holder seat (`maxHolders > 1`) — `resolveMentionToken` returns
  whichever holding row `Array.find` reaches first; this is a deliberate,
  documented simplification (see Scope/Notes), not a bug to fix here.

## Acceptance Criteria
- [ ] `packages/shared/src/mentions.ts` exports `encodeMention` and
      `splitMentionSegments`; all cases in Testing Strategy row 1 pass.
- [ ] `mentionResolve.logic.ts` resolves person and seat tokens against
      `{people, seatHoldings}` and returns `null` gracefully for every
      dangling-reference case in row 2.
- [ ] `mentionTrigger.logic.ts` correctly detects/rejects an in-progress `@`
      query per every case in row 3.
- [ ] In the Duties grid's Notes column, typing `@` opens a dropdown of
      matching people and seat titles; selecting one inserts a mention token
      into the note text.
- [ ] A note containing a resolved person mention renders that mention as
      tappable text that navigates to `/people?openId=<personId>` and opens
      that person's detail sheet.
- [ ] A note containing a resolved seat mention (e.g. "Music Director")
      renders as tappable text that navigates to whoever
      `chapterSeatHoldings` currently reports for that seat — verified by
      reassigning the seat in the org chart and confirming the same note now
      links to the new holder without editing the note.
- [ ] A note mentioning a currently-vacant seat, or a person who no longer
      resolves, renders the original label as plain, non-interactive text
      instead of a broken link or a crash.
- [ ] `pnpm typecheck`, `pnpm lint`, and `pnpm test` are all clean.

## Validation Commands
Execute every command. Every one must exit clean.

- `cd packages/shared && pnpm vitest run mentions.test.ts` — new shared unit tests
- `cd apps/mobile && pnpm test` — new logic unit tests + full mobile suite, zero regressions
- `pnpm typecheck` — all three packages
- `pnpm lint` — all three packages
- `pnpm test` — full repo suite, zero regressions
- `pnpm build` — web bundle export still succeeds

## Notes
- No new dependencies. No schema or Convex function changes — mentions live
  entirely inside the existing `notes: v.string()` column as text markup, and
  resolution reuses data (`api.people.list`, `api.responsibilities.chapterSeatHoldings`)
  the target screen already fetches.
- **The Academy:** this feature doesn't rename a concept/role/tab, change a
  money rule, or alter a documented flow the Academy teaches — it's a new
  authoring affordance inside an existing field. Per `CLAUDE.md`'s "when
  unsure, it probably is [training-worthy]" guidance, this was weighed and
  judged **not** training-worthy for this pass (no lesson currently covers
  writing duty notes at this level of detail); state this explicitly in the
  PR description rather than silently skipping it.
- Explicitly deferred, called out above: mention support in other `notes`
  fields; multi-holder-seat disambiguation; mention notifications; free-text
  auto-detection of role names without an explicit `@`.
- If Step 6 finds a different current shape at `DutiesGrid.tsx`'s Notes cell
  (line numbers drift as the file changes), locate it by its `COLS.notes` /
  `update({ notes: ... })` call rather than trusting the line numbers above
  verbatim.
