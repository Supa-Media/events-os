# Feature: Send a comms copy to Google Chat, from the card

## Feature Description

On the Comms Schedule calendar, a comms item's card today only lets you copy
its message text to the clipboard and paste it into Google Chat by hand. This
feature adds a real **Send** action next to that Copy button: tap it, pick
which Google Chat space to post to (a small popover, no new screen), and the
item's copy is posted to that space immediately — no context switch. The item
then reads as "Sent" the same way a manually-marked send does today.

Google Chat spaces are reached through their **incoming webhook URL** (a
space's own "Apps & integrations → Webhooks" setting) rather than a Google
Cloud OAuth app — there's no per-organization Chat API credential to request,
just a URL a chapter admin pastes in once per space, inline in the same
popover the first time they use it.

## User Story

As a comms lead scheduling a reminder or announcement
I want to send the exact copy on a comms card straight to the right Google
Chat space, without leaving the calendar
So that reminder sends (day-before call times, location changes, etc.) go out
in seconds instead of a copy/switch-app/paste/pick-channel dance

## Problem Statement

The comms calendar already models *where* a send goes (`channel` badges,
including a `google_chat` option) and *what* it says (the copy box), but
"send" has only ever meant "mark it done after you posted it somewhere else
by hand." For time-sensitive reminders this manual hop is exactly the kind of
friction that causes a reminder to go out late or not at all.

## Solution Statement

Add a lightweight, chapter-scoped list of named Google Chat channels (each
just a label + that space's incoming webhook URL — no OAuth, no Google Cloud
project), and a **Send** action on the comms card's copy box that posts the
card's copy to a chosen channel over that webhook, then flips the item to
`status: "sent"` — reusing the "Sent" pill the calendar already renders for
that status (visible in the screenshot the user attached).

This follows the two closest existing patterns in the codebase rather than
inventing new ones:
- **Outbound send + credential resolution**: `apps/convex/lib/twilio.ts`'s
  `sendSms` (a plain `fetch()` POST, no `"use node"`, secret never in the
  thrown error) and `apps/convex/campaigns.ts`'s `sendTest` (a synchronous
  `action` a client calls directly and awaits — no `blasts.ts`-style
  mutation-inserts-a-row-then-schedules-an-action split, because this is one
  request/response the user is watching, not a bulk fan-out).
- **Access gating**: `apps/convex/lib/campaignsAccess.ts#requireBlastSend` —
  a NAMED resolver whose body is, today, exactly the `requireEvent` ownership
  check the call site used to do inline, with a doc comment naming the
  capability (`"comms.send"`) it graduates to. Per CLAUDE.md's "Gate It
  Behind a Power" rule, the capability string is **not** added to
  `SEAT_CAPABILITIES` yet — that's a deliberate later decision, not this PR's.

Channel *storage* deliberately does NOT reuse `integrationSettings` (the
deployment-wide singleton backing Twilio/Resend/Givebutter/AI): those are one
shared vendor credential for the whole deployment, but different **chapters**
run in different Google Chat spaces, so this needs a list, scoped per
chapter — a new table (`googleChatChannels`), the same shape every other
per-record list in this codebase already takes (`blastRecipients`,
`templateItems`, …) rather than an array-in-a-singleton-document.

## Scope

**In scope:**
- A new `googleChatChannels` table: chapter-scoped `{label, webhookUrl}` rows.
- Backend: list/add/remove channels for an event's chapter, and a `sendCopy`
  action that posts a comms item's copy to a chosen channel and marks the
  item `sent`.
- A named access resolver (`requireCommsSend`) gating add/remove/send —
  today's behavior is unchanged (same as `requireEvent`'s ownership check).
- UI: a Send trigger next to the existing Copy button on a **comms** card's
  copy box (`ItemCard.tsx` → `CopyEditor`), opening a small popover listing
  configured channels plus an inline "+ Add a channel" mini-form (name +
  webhook URL) for when none exist yet or a new space is needed.
- On successful send: item `status` → `"sent"` (existing status value/badge,
  no schema/UI change needed for the badge itself).

**Out of scope:**
- The full Google Chat REST API / OAuth / a Google Cloud project / listing an
  org's spaces live from Google — deliberately using incoming webhooks
  instead (see Notes for why, and what the user needs to do manually).
- Adding `"comms.send"` to `SEAT_CAPABILITIES` / any seat template — the
  resolver is written so this is a one-file follow-up later, not now.
- A dedicated "manage Google Chat channels" settings screen — channel
  management lives inline in the send popover only.
- Editing/renaming an existing channel's webhook URL (add + remove only; to
  "change" one, remove and re-add).
- Any change to `planning_doc` cards, the table (`EditableGrid`) view's row
  actions, or template-side comms items (`templateItems`) — Send only
  appears on a live event's comms cards in the calendar view.
- Re-send tracking/history (which channel, when) beyond the existing `status`
  flip — no new "sent via X at Y" display.
- The Academy `tab-comms` lesson content itself — flagged as a required
  decision in Step 8, not pre-written here.

## Relevant Files

- `apps/convex/lib/campaignsAccess.ts:265-315` (`requireBlastSend` +
  `hasBlastSend`) — **the pattern to follow** for the new
  `apps/convex/lib/commsAccess.ts#requireCommsSend`: a named resolver whose
  body is today's ownership check, with a doc comment naming the capability
  it graduates to and explicitly NOT adding it to `SEAT_CAPABILITIES` yet.
- `apps/convex/campaigns.ts:1454` (`sendTest`) — **the pattern to follow**
  for `sendCopy`: a synchronous `action` the client calls and awaits
  directly, gated via an `internalQuery` access-assertion, no
  scheduled-action split.
- `apps/convex/lib/twilio.ts:130-155` (`sendSms`) — **the pattern to follow**
  for `apps/convex/lib/googleChat.ts#sendGoogleChatMessage`: a bare `fetch()`
  POST, throws on non-2xx, never interpolates the secret into the error.
- `apps/convex/integrationSettings.ts:313-320` (`readGivebutterApiKey`) —
  the write-only-secret discipline `googleChat.ts#readChannelWebhookUrl`
  mirrors (internal-only, never returned by the public list query).
- `apps/convex/items.ts:685-701` (`setStatus`) — confirms `"sent"` is
  already a valid, rendered status value; no change needed here.
- `apps/convex/lib/context.ts:112-117` (`requireEvent`) — what
  `requireCommsSend` delegates to.
- `apps/convex/schema.ts` — register the new `googleChatChannels` table
  (mirrors how `blastRecipients`/`integrationSettings` are registered).
- `apps/mobile/components/event/moduleCalendar/config.ts:30-68` — add a
  `sendable` flag to `ModuleCalendarConfig` (comms: `true`, planning_doc:
  `false`).
- `apps/mobile/components/event/moduleCalendar/index.tsx:105-125` —
  thread `sendable={config.sendable}` into `ItemCard`.
- `apps/mobile/components/event/moduleCalendar/ItemCard.tsx:37-152` — accept
  `sendable`, pass `eventId`/`itemId`/`sendable` down to `CopyEditor`.
- `apps/mobile/components/event/moduleCalendar/ItemCardText.tsx:76-135`
  (`CopyEditor`) — render the new `SendButton` beside the existing
  `CopyButton` in the header row, same `value.trim() ? … : null` guard.
- `apps/mobile/components/event/ticketing/BlastComposerCard.tsx` — reference
  for wiring an outbound `action`/`mutation` through `useActionRunner`
  (`apps/mobile/lib/useActionToast.ts`) for error surfacing.
- `apps/mobile/components/event/moduleCalendar/ItemCardStatus.tsx:110-161`
  (`BadgeEditor`) — the exact "`Popover` of option rows, commit on
  selection" shape `SendButton`'s channel picker copies.
- `apps/mobile/components/ui/Field.tsx` (`TextField`) — used by the inline
  "+ Add a channel" form.
- `packages/shared/src/academy/streams/events.ts:807-907` (`tab-comms`
  lesson) — must be checked (Step 8) once this ships; not edited by this
  plan.

### New Files
- `apps/convex/schema/googleChat.ts` — the `googleChatChannels` table.
- `apps/convex/lib/commsAccess.ts` — `requireCommsSend` (+ doc comment on
  the `"comms.send"` capability it will graduate to).
- `apps/convex/lib/googleChat.ts` — `isPlausibleWebhookUrl` +
  `sendGoogleChatMessage` (the raw webhook POST).
- `apps/convex/googleChat.ts` — `listChannels`, `addChannel`,
  `removeChannel`, `sendCopy` (action), and its internal helpers
  (`assertSendAccessAndLoadItem`, `readChannelWebhookUrl`, `markItemSent`).
- `apps/convex/tests/googleChat.test.ts` — backend tests for all of the
  above.
- `apps/mobile/components/event/moduleCalendar/ItemCardSend.tsx` —
  `SendButton`: the trigger + channel-picker `Popover` + inline
  add-a-channel mini-form.

## Implementation Plan

### Phase 1: Foundation
`schema/googleChat.ts` (table + index), registered in `schema.ts`; and the
access resolver `lib/commsAccess.ts`. Nothing observable yet — later phases
depend on both.

### Phase 2: Core Implementation
`apps/convex/googleChat.ts` + `lib/googleChat.ts`: channel CRUD (list/add/
remove) and the `sendCopy` action that resolves a channel's webhook, posts
the item's copy, and marks the item sent.

### Phase 3: Integration
Wire the Send trigger into the comms card: `config.ts`'s `sendable` flag →
`index.tsx` → `ItemCard.tsx` → `CopyEditor` → the new `ItemCardSend.tsx`.

## Step by Step Tasks
IMPORTANT: Execute every step in order, top to bottom.

### 1. Google Chat channels: schema + CRUD (list / add / remove)

**a. Write the failing test (RED).** Create
`apps/convex/tests/googleChat.test.ts`. Using `newT()` / `setupChapter()` /
`run()` from `./setup.helpers.ts` (see `apps/convex/tests/twilio.test.ts` for
the exact idiom), write tests against `api.googleChat.addChannel`,
`api.googleChat.listChannels`, `api.googleChat.removeChannel`:
- `addChannel` inserts a row and `listChannels` returns it as
  `{_id, label}` — **no `webhookUrl` in the response** (assert the key is
  absent, not just unused).
- `addChannel` rejects an empty/whitespace label (`ConvexError`, no row
  written — assert via `run(t, ctx => ctx.db.query("googleChatChannels").collect())`).
- `addChannel` rejects a `webhookUrl` that doesn't start with
  `"https://chat.googleapis.com/"` (`ConvexError`, no row written).
- `removeChannel` deletes a row; a subsequent `listChannels` no longer
  includes it.
- `removeChannel` on a channel belonging to a **different chapter**
  (`setupChapter(t, { email: "other@publicworship.life", chapterName: "LA" })`,
  create a second event there, add a channel under it) throws `NOT_FOUND`
  when called with the first chapter's `eventId` — the row is untouched.
- A caller who isn't in the event's chapter at all is rejected by
  `listChannels`/`addChannel`/`removeChannel` (mirrors any existing
  `requireEvent` cross-chapter test, e.g. `apps/convex/tests/items.test.ts`
  if present, else the shape of `twilio.test.ts`'s superuser-gate tests).

Run it: it fails because `apps/convex/googleChat.ts` and
`apps/convex/schema/googleChat.ts` don't exist yet (module/table not found —
genuine RED, not a broken-test error).

**b. Implement the minimum to reach GREEN.**
- `apps/convex/schema/googleChat.ts`: `googleChatChannels` table —
  `chapterId: v.id("chapters")`, `label: v.string()`,
  `webhookUrl: v.string()`, `createdBy: v.id("users")`,
  `createdAt: v.number()`, indexed `.index("by_chapter", ["chapterId"])`.
  Doc comment: write-only secret discipline (mirrors
  `schema/integrationSettings.ts`'s doc), and why this is a table, not a
  singleton array field (per-chapter list, not one deployment credential).
- Register it in `apps/convex/schema.ts` (import + add to the schema
  object, next to `blastRecipients`/`integrationSettings`).
- `apps/convex/lib/commsAccess.ts`: `requireCommsSend(ctx, eventId)` —
  `return requireEvent(ctx, eventId)`, with the `requireBlastSend`-shaped
  doc comment (today's answer, the `"comms.send"` capability name it
  graduates to, explicit "do not add the capability string yet").
- `apps/convex/lib/googleChat.ts`: `isPlausibleWebhookUrl(url)` (starts with
  `"https://chat.googleapis.com/"`).
- `apps/convex/googleChat.ts`: `listChannels` (query, gated by plain
  `requireEvent` — read access, not the send power), `addChannel` /
  `removeChannel` (mutations, gated by `requireCommsSend`), per the
  signatures in Relevant Files.

**c. Run the full suite** (`pnpm --filter @events-os/convex test`) before
moving on — this table is brand new, so nothing else should be able to break,
but confirm anyway (schema-registration mistakes can fail unrelated tests
that enumerate tables).

### 2. `sendCopy`: post the copy, mark the item sent

**a. Write the failing test (RED).** In the same test file, mocking
`globalThis.fetch` per `apps/convex/tests/aiEngine.test.ts`'s `mockFetch`
helper (capture calls, return a canned `Response`-shaped object;
`afterEach` restores `globalThis.fetch`), test `api.googleChat.sendCopy`
against a seeded comms `eventItems` row (`fields: { notes: "Hey team…" }`,
`module: "comms"`) and a seeded channel:
- On a 2xx webhook response: the POST body is `{"text": "<the item's fields.notes>"}`
  to the channel's exact stored `webhookUrl`; afterward
  `ctx.db.get(itemId)).status === "sent"`.
- On a non-2xx webhook response (e.g. `mockFetch({ ok: false, status: 404, text: "..." })`):
  `sendCopy` rejects, and the item's `status` is **unchanged** (not silently
  marked sent).
- Rejects with `EMPTY_COPY` when `fields.notes` is empty/whitespace-only —
  no fetch call made (assert `calls.length === 0`).
- Rejects with `INVALID_MODULE` when the item's `module !== "comms"` (seed a
  `planning_doc` item, try to send it) — no fetch call made.
- Rejects with `NOT_FOUND` when `channelId` belongs to a different chapter
  than the item's event — no fetch call made.

Run it: fails because `googleChat.sendCopy` doesn't exist yet.

**b. Implement the minimum to reach GREEN.**
- `apps/convex/lib/googleChat.ts`: add `sendGoogleChatMessage(webhookUrl, text)`
  — `fetch(webhookUrl, { method: "POST", headers: {"Content-Type": "application/json; charset=UTF-8"}, body: JSON.stringify({ text }) })`;
  throw a plain `Error` with the response status + body text on `!response.ok`
  (never interpolate `webhookUrl` into the thrown message — it's the secret).
- `apps/convex/googleChat.ts`: add the internal helpers
  `assertSendAccessAndLoadItem` (internalQuery: `requireCommsSend`, load +
  validate the item, return `{ copy }`), `readChannelWebhookUrl`
  (internalQuery: `requireCommsSend`, load + chapter-check the channel,
  return the bare url), `markItemSent` (internalMutation: patch
  `status: "sent"`); and the public `sendCopy` action that chains all three
  plus `sendGoogleChatMessage`, per the signatures in Relevant Files.

**c. Run the full suite** (`pnpm --filter @events-os/convex test` and
`pnpm --filter @events-os/convex typecheck`) before moving on.

### 3. Frontend: the Send trigger on a comms card

**a. No RN component-render test exists for this layer in this repo**
(`ItemCardStatus.tsx`, `ItemCardTiming.tsx`, `ItemCardText.tsx` — the three
sibling files this step edits/extends — have no `.test.tsx` counterparts;
`apps/mobile`'s Jest suite is exclusively pure-logic `.test.ts` files, see
`apps/mobile/components/event/newEventValidation.test.ts` for the shape of
what IS tested here). This step's "RED" is instead: **before this step,
`pnpm --filter @events-os/mobile typecheck` has no `sendable` prop, no
`ItemCardSend.tsx`, and no way to trigger a Google Chat send from the UI at
all** — confirm that by grepping (`grep -rn "sendable\|ItemCardSend" apps/mobile`
returns nothing) before writing code.

**b. Implement.**
- `config.ts`: add `sendable: boolean` to `ModuleCalendarConfig`; `comms:
  { ..., sendable: true }`, `planning_doc: { ..., sendable: false }`.
- `index.tsx`: pass `sendable={config.sendable}` into `ItemCard` in
  `renderItemCard`.
- `ItemCard.tsx`: accept `sendable: boolean` in props; pass
  `sendable`, `eventId={item.eventId}`, `itemId={item._id}` through to
  `<CopyEditor>`.
- `ItemCardText.tsx` (`CopyEditor`): accept the same three new props;
  when `sendable && value.trim()`, render `<SendButton eventId={eventId}
  itemId={itemId} />` next to the existing `<CopyButton text={value} label />`
  in the header row (same conditional the CopyButton already uses, so Send
  never appears with nothing to send).
- `ItemCardSend.tsx` (new): `SendButton({ eventId, itemId })` —
  - A small `Pressable` trigger (Feather `"send"` icon, mirrors
    `CopyButton`'s pill styling) that opens a `Popover` (via `useAnchor`,
    per `ItemCardTiming.tsx`'s idiom).
  - Inside: `useQuery(api.googleChat.listChannels, { eventId })` renders one
    `StatusRow`-styled pressable per channel (reuse `StatusRow` from
    `ItemCardStatus.tsx` — label only, no color/icon needed, or a bare
    `Pressable`+`Text` row if `StatusRow`'s color chip reads oddly for a
    plain channel name); pressing one calls
    `useAction(api.googleChat.sendCopy)({ eventId, itemId, channelId })`
    through `useActionRunner().run(...)` (local to this component — no
    prop-drilled runner), closing the popover on success and rendering
    `<ToastView>` inline in the popover on failure (mirrors
    `BlastComposerCard`'s use of the hook, scoped locally here instead of a
    parent-owned runner since this is a self-contained popover).
  - Below the list (or in place of it, when empty): a "+ Add a channel"
    row that toggles two `TextField`s (name, webhook URL) + Save, calling
    `useMutation(api.googleChat.addChannel)`; on success the new channel
    appears in the list above via the live `listChannels` query
    (no manual refetch needed).
- Keep `ItemCardSend.tsx` scoped to this one concern (trigger + popover +
  inline add-form) — if it creeps past ~150 lines, split the add-channel
  mini-form into its own function in the same file (not a new file) per
  Clean Code's function-size guidance, the way `ItemCardStatus.tsx` keeps
  `StatusRow`/`BadgeEditor` as separate top-level functions in one file.

**c. Run** `pnpm --filter @events-os/mobile typecheck` and
`pnpm --filter @events-os/mobile lint`. Then use the `/run` skill to launch
the app, open an event's Comms Schedule, select a comms item with copy
written, and manually verify: the Send trigger appears only on comms cards
with non-empty copy; the popover lists channels (empty state shows the add
form); adding a channel with a `https://chat.googleapis.com/...` URL then
appears in the list immediately; selecting a channel with a **fake/unreachable**
URL surfaces an inline error and does NOT flip the item to "Sent"; the button
is verifiably wired even though sending to a real Google Chat space needs the
user's own webhook URL (see Notes).

### 4. Full validation pass
Run every command in Validation Commands below.

### 5. Academy check (CLAUDE.md's "Academy Must Track the Product")
Read `packages/shared/src/academy/streams/events.ts`'s `tab-comms` lesson
(around line 807-907) and its capstone (`capstone-comms-lead`, ~line 1720).
Decide explicitly — and say so in the PR description — whether the lesson's
"the copy lives on the row, so anyone can send it" framing (currently
implying a manual/external send) should be updated to mention the in-app
Send button, or whether it's accurate enough as written (it already doesn't
specify *how* the send happens). Per CLAUDE.md: "when unsure, it probably is
[training-worthy] — err on the side of updating." If updated, run the
academy tests (`pnpm --filter @events-os/shared test` covers
`packages/shared/src/academy/`).

## Testing Strategy

### Tests by Milestone

| # | Milestone | Test file | The test asserts | Why it fails today |
|---|---|---|---|---|
| 1 | Google Chat channels: schema + CRUD | `apps/convex/tests/googleChat.test.ts` | `addChannel`/`listChannels`/`removeChannel` behavior incl. chapter isolation, empty-label rejection, malformed-URL rejection, and that `webhookUrl` never appears in `listChannels`' response | `apps/convex/googleChat.ts` and `schema/googleChat.ts` don't exist |
| 2 | `sendCopy`: post + mark sent | `apps/convex/tests/googleChat.test.ts` | POST body/target on success + status flip to `"sent"`; failure paths (bad response, empty copy, wrong module, cross-chapter channel) leave status untouched and never fetch | `googleChat.sendCopy` doesn't exist |
| 3 | Frontend: Send trigger on a comms card | N/A — no RN render-test convention in this repo (see task 3a) | — | — |

**Pattern followed:** `apps/convex/tests/twilio.test.ts` (chapter-setup +
gating + mocked external send) and `apps/convex/tests/aiEngine.test.ts`
(`mockFetch` helper for asserting exact outbound POST bodies/targets).

### Integration Tests
N/A beyond milestone 2's tests — `sendCopy` IS the integration seam (item →
access check → channel lookup → outbound POST → status patch), exercised
end-to-end (through the real `action`, not a unit of one piece) by every test
in that milestone.

### Edge Cases
- Empty/whitespace copy → `EMPTY_COPY`, covered in milestone 2. The frontend
  additionally never renders the trigger for empty copy (milestone 3), so
  this is defense-in-depth against a stale client / direct API call, not the
  primary guard.
- Sending a `planning_doc` item (wrong module) → `INVALID_MODULE`, covered
  in milestone 2; the frontend never renders `sendable` for that module, so
  this is also defense-in-depth.
- A channel deleted between the popover opening and the send (or removed by
  someone else concurrently) → `readChannelWebhookUrl` throws `NOT_FOUND`
  (chapter-check fails because the row is gone) — surfaced as an inline
  error in the popover via `useActionRunner`. Not separately covered by a
  named test beyond the existing cross-chapter `NOT_FOUND` case, since the
  code path is identical (row doesn't match → not found).
- Duplicate channel labels within a chapter: accepted, not deduplicated —
  an intentional non-guardrail (out of scope; a chapter admin naming two
  channels "Leaders" is their own confusion to sort out, not a data
  integrity issue).
- Re-sending an already-`"sent"` item: allowed, no special-cased "already
  sent" block — useful for a reminder resent to a second channel or resent
  after a typo fix. Not separately tested; it's the same code path as a
  first send (milestone 2's success test already proves a send always
  flips `status` to `"sent"` regardless of the item's prior status).

## Acceptance Criteria
- [ ] `apps/convex/schema/googleChat.ts` defines `googleChatChannels`,
      registered in `apps/convex/schema.ts`.
- [ ] `api.googleChat.listChannels` never returns `webhookUrl` for any
      channel, in any test or manual check.
- [ ] `api.googleChat.addChannel` rejects an empty label and a webhook URL
      not starting with `https://chat.googleapis.com/`.
- [ ] `api.googleChat.removeChannel` refuses to delete a channel outside the
      caller's chapter.
- [ ] `api.googleChat.sendCopy` posts `{"text": <item's fields.notes>}` to
      the selected channel's stored `webhookUrl` and flips the item's
      `status` to `"sent"` only on a 2xx response.
- [ ] A non-2xx webhook response leaves the item's `status` unchanged and
      the thrown error never contains the webhook URL.
- [ ] `apps/convex/lib/commsAccess.ts#requireCommsSend` exists, is used by
      `addChannel`/`removeChannel`/`sendCopy`'s access checks, and its doc
      comment names `"comms.send"` as the capability it graduates to
      without adding that string to `SEAT_CAPABILITIES`.
- [ ] The Send trigger renders on a **comms** card's copy box only when its
      copy is non-empty, and never renders on a `planning_doc` card.
- [ ] Selecting a configured channel in the popover sends immediately
      (no extra confirmation step) and the card shows "Sent" afterward
      (via the existing status pill — no new UI needed for this).
- [ ] The "+ Add a channel" mini-form in the popover creates a channel
      visible in the same popover without a page reload.
- [ ] All Validation Commands exit clean.

## Validation Commands
Execute every command. Every one must exit clean.

- `pnpm install --frozen-lockfile` — install deps
- `pnpm --filter @events-os/shared typecheck` — typecheck shared
- `pnpm --filter @events-os/convex typecheck` — typecheck backend
- `pnpm --filter @events-os/convex test` — backend tests (vitest, ~150 files
  + the new `googleChat.test.ts`)
- `pnpm --filter @events-os/mobile typecheck` — typecheck mobile (catches
  the new prop threading through `ItemCard.tsx`/`ItemCardText.tsx`)
- `pnpm --filter @events-os/mobile lint` — lint mobile
- `pnpm --filter @events-os/shared test` — shared tests (covers the Academy,
  if Step 5 touches it)
- `pnpm turbo run test` — full suite, zero regressions

## Notes

**Where the user is explicitly needed (call this out in the PR description
too):**
1. **Creating the actual Google Chat webhook(s).** This feature cannot list
   or create Google Chat spaces/webhooks on its own — Google Chat's incoming
   webhooks are created BY A HUMAN, per space, in the Google Chat UI: open
   the space → space name dropdown → **Apps & integrations** → **Webhooks**
   → **Add webhook** → name it → **Save** → copy the generated URL (looks
   like `https://chat.googleapis.com/v1/spaces/AAAA.../messages?key=...&token=...`).
   That URL is pasted into this feature's "+ Add a channel" form once per
   space — there is no way to automate this step from the backend. The user
   (or whoever administers the relevant chapter's Google Chat) needs to do
   this for each space they want reachable (e.g. "Leaders", "Musicians",
   "General").
2. **Design decision: incoming webhooks vs. the full Google Chat API.**
   This plan deliberately uses per-space incoming webhooks (no OAuth, no
   Google Cloud project, no domain-wide delegation) because it's the only
   integration shape every other credential in this codebase already uses
   (a URL or key pasted in once) and needs zero new infrastructure. The
   trade-off: the app can never auto-discover "which spaces exist" — every
   channel is manually named and pasted in by a human, and a webhook can
   only POST plain text/simple cards, not read messages or manage
   membership. If the user actually wants live space discovery, an org-wide
   Chat app identity, or bot-style two-way interaction later, that's a
   materially bigger integration (Google Cloud project + OAuth/service
   account + domain admin consent) and should be scoped as its own feature,
   not folded into this one. **Confirm this trade-off before implementation
   starts.**
3. **Confirm the `"comms.send"` capability deferral.** This plan leaves
   "who can send comms to Google Chat" exactly as broad as "who can edit
   this event" today (same as `requireBlastSend`'s precedent for blasts).
   If the user wants sending gated narrower than editing from day one (e.g.
   only the Comms Lead), say so now — it changes Step 1's resolver body and
   would need the `SEAT_CAPABILITIES` addition CLAUDE.md's rule otherwise
   defers.

No new dependencies — `fetch()` is available in the default Convex action
runtime (same as `lib/twilio.ts`), and the frontend reuses existing UI
primitives (`Popover`, `TextField`, `useAnchor`, `useActionRunner`).
